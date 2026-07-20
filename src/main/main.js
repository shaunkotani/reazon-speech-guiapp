const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { fork, spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Notification } = require('electron');

const { autoUpdater } = require('electron-updater');
const modelManager = require('./modelManager');
const exporters = require('../shared/export');
const {
  assignByReferences, l2normalize, cosineDistance, centroid, UNKNOWN_THRESHOLD,
} = require('../shared/cluster');
const overlapTools = require('../shared/overlap');
const separationTools = require('../shared/separation');
const transcriptionProgress = require('../shared/transcriptionProgress');
const rangeTools = require('../shared/transcriptionRange');
const unsavedState = require('../shared/unsavedState');
const autoTune = require('../shared/autoTune');
const SerialJobQueue = require('./serialJobQueue');
const { registerMediaProtocol, MEDIA_MIME } = require('./mediaProtocol');

// <audio> から元音声/除去後音声を再生するためのローカルメディア配信スキーム
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

// userData は表示名（productName）に依存させず 'reazonspeech' 固定にする。
// これによりアプリ名を「モコシ」に変えてもモデル/辞書/設定の保存先が変わらない。
app.setPath('userData', path.join(app.getPath('appData'), 'reazonspeech'));

// アプリアイコン（存在すれば）。パッケージ後は build/icon.* が bundle に焼き込まれるが、
// dev 起動（electron .）の Dock 表示用にここでも読み込む。
const appIconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');

let mainWindow = null;
let latestUnsavedState = unsavedState.normalizeState({});
let allowCloseOnce = false;
let closeDialogOpen = false;
let quitRequested = false;
const previewDir = path.join(os.tmpdir(), 'reazonspeech-preview');
const cancelled = new Set(); // 中止された jobId
const skipOverlapRequested = new Set(); // 重なり解析を中断し、通常解析へ切り替える jobId
const activeTranscriptionPhases = new Map(); // 実行中ジョブの工程（スキップ可否の判定用）
const jobEmbeddings = new Map(); // jobId -> number[][]（区間順、手本ベース再識別用）
const separatedEmbeddings = new Map(); // jobId -> Map<separationEmbeddingId, number[]>
const overlapAnalysisCache = new Map(); // 同じ原音・範囲・話者数の再解析を省略するLRU
const OVERLAP_CACHE_LIMIT = 12;
const OVERLAP_CACHE_VERSION = 2;

function cacheEmbeddings(jobId, embs) {
  jobEmbeddings.set(jobId, embs);
  // 古いものを間引く（最大 10 ジョブ）
  if (jobEmbeddings.size > 10) {
    const oldest = jobEmbeddings.keys().next().value;
    jobEmbeddings.delete(oldest);
  }
}

// ---- モデルの所在 ----
function repoModelsDir() {
  // dev 実行時: <repo>/models（パッケージ後は存在しない）
  const p = path.join(__dirname, '..', '..', 'models');
  return fs.existsSync(p) ? p : null;
}
function userDataModelsDir() {
  return path.join(app.getPath('userData'), 'models');
}

// ---- 用語辞書（ホットワード）の永続化 ----
// 辞書は全ジョブ共通の設定。1行1語のプレーンテキストで保存し、認識器生成時に
// modified_beam_search + hotwordsFile として渡す（core.createRecognizer 側で切替）。
function hotwordsPath() {
  return path.join(app.getPath('userData'), 'hotwords.txt');
}
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch (_) { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

function cacheSeparatedEmbeddings(jobId, values) {
  separatedEmbeddings.set(jobId, values);
  if (separatedEmbeddings.size > 10) {
    separatedEmbeddings.delete(separatedEmbeddings.keys().next().value);
  }
}

function appPreferences() {
  return unsavedState.normalizePreferences(readSettings());
}

function saveAppPreferences(value) {
  const prefs = unsavedState.normalizePreferences(value);
  const settings = readSettings();
  settings.confirmOnCloseWithUnsaved = prefs.confirmOnCloseWithUnsaved;
  writeSettings(settings);
  return prefs;
}

async function confirmAppCloseIfNeeded() {
  const prefs = appPreferences();
  if (!unsavedState.shouldConfirm(latestUnsavedState, prefs)) return true;
  if (closeDialogOpen || !mainWindow || mainWindow.isDestroyed()) return false;
  closeDialogOpen = true;
  try {
    const result = await dialog.showMessageBox(mainWindow, unsavedState.buildDialogOptions(latestUnsavedState));
    if (result.response !== 0) return false;
    if (result.checkboxChecked && !unsavedState.hasActiveWork(latestUnsavedState)) {
      saveAppPreferences({ confirmOnCloseWithUnsaved: false });
    }
    return true;
  } finally {
    closeDialogOpen = false;
  }
}

// ---- ユーザー定義 VAD プリセットの永続化 ----
const MAX_CUSTOM_VAD_PRESETS = 20;
const clampNumber = (value, min, max, fallback) =>
  (typeof value === 'number' && isFinite(value)) ? Math.min(max, Math.max(min, value)) : fallback;

function normalizeCustomVadPreset(value, fallbackId = '') {
  const p = value && typeof value === 'object' ? value : {};
  const name = String(p.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return null;
  const candidateId = String(p.id || fallbackId || '');
  const id = /^[a-zA-Z0-9_-]{1,80}$/.test(candidateId) ? candidateId : randomUUID();
  return {
    id,
    name,
    maxSpeechDuration: clampNumber(p.maxSpeechDuration, 3, 20, 6),
    minSilenceDuration: clampNumber(p.minSilenceDuration, 0.05, 1, 0.2),
    minSpeechDuration: clampNumber(p.minSpeechDuration, 0.05, 0.5, 0.15),
    threshold: clampNumber(p.threshold, 0.1, 0.9, 0.5),
    overlapAware: p.overlapAware === true,
    overlapSpeakers: Math.round(clampNumber(p.overlapSpeakers, 2, 4, 2)),
    overlapSeparation: p.overlapSeparation === true,
  };
}

function customVadPresets() {
  const values = readSettings().vadPresets;
  if (!Array.isArray(values)) return [];
  return values.slice(0, MAX_CUSTOM_VAD_PRESETS)
    .map((p, i) => normalizeCustomVadPreset(p, `legacy-${i + 1}`))
    .filter(Boolean);
}
const DEFAULT_HOTWORDS_SCORE = 2.0;
// 現在の認識設定（辞書＋高精度モード）。辞書に有効な語が無ければ file:null。
function currentRecognizerSettings() {
  const s = readSettings();
  const enabled = s.hotwordsEnabled !== false; // 既定 ON
  const score = typeof s.hotwordsScore === 'number' ? s.hotwordsScore : DEFAULT_HOTWORDS_SCORE;
  const highAccuracy = s.highAccuracy === true; // 既定 OFF（beam search は辞書使用時のみ自動 ON）
  let text = '';
  try { text = fs.readFileSync(hotwordsPath(), 'utf8'); } catch (_) { /* 無ければ空 */ }
  const hasWords = text.split('\n').some((l) => l.trim());
  return { file: enabled && hasWords ? hotwordsPath() : null, score, text, enabled, highAccuracy };
}

function resolveModels() {
  return modelManager.resolveBaseDir({
    repoModels: repoModelsDir(),
    userDataModels: userDataModelsDir(),
  });
}

function resolveSeparationModel() {
  const repo = repoModelsDir();
  if (repo && modelManager.isSeparationComplete(repo)) {
    return { baseDir: repo, ready: true, source: 'repo' };
  }
  const baseDir = userDataModelsDir();
  return {
    baseDir,
    ready: modelManager.isSeparationComplete(baseDir),
    source: 'userData',
  };
}

// ==== ワーカープール（CPU コア数に応じて並列） ====
const POOL_SIZE = Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));
let pool = null;        // [{ proc, rpcs:Map }]
let poolReady = null;   // 全 init 完了の Promise
let ridSeq = 0;
let separatorWorker = null;
let separatorReady = null;
let separatorRidSeq = 0;

function spawnWorker(initArgs, forkOptions = {}) {
  const proc = fork(path.join(__dirname, 'asrWorker.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    // 既定は JSON シリアライズ（埋め込みはプレーン配列で渡すため十分）。
    // リアルタイムの PCM チャンク（Float32Array）を送るワーカーだけ
    // forkOptions で advanced（構造化クローン）を指定する。
    ...forkOptions,
  });
  const w = { proc, rpcs: new Map(), readyResolve: null, readyReject: null, readySettled: false };
  w.ready = new Promise((res, rej) => { w.readyResolve = res; w.readyReject = rej; });
  proc.on('message', (msg) => {
    if (msg.type === 'ready') { w.readySettled = true; w.readyResolve(); return; }
    if (msg.type === 'initError') { w.readySettled = true; w.readyReject(new Error(msg.message)); return; }
    const r = w.rpcs.get(msg.rid);
    if (!r) return;
    if (msg.type === 'event') { if (r.onEvent) r.onEvent(msg.payload); return; }
    if (msg.type === 'response') {
      w.rpcs.delete(msg.rid);
      if (msg.error) r.reject(new Error(msg.error)); else r.resolve(msg.result);
    }
  });
  proc.on('exit', () => {
    if (!w.readySettled) {
      w.readySettled = true;
      w.readyReject(new Error('認識エンジンの準備中にワーカーが終了しました'));
    }
    for (const [, r] of w.rpcs) r.reject(new Error('ワーカーが終了しました'));
    w.rpcs.clear();
  });
  proc.send({ type: 'init', ...initArgs });
  return w;
}

function ensurePool() {
  if (poolReady) return poolReady;
  const { baseDir, ready } = resolveModels();
  if (!ready) return Promise.reject(new Error('モデルが未取得です。先にダウンロードしてください。'));
  const { modelDir, vadPath, denoiserPath, embPath, segmentationPath } = modelManager.pathsFor(baseDir);
  const rs = currentRecognizerSettings();
  pool = Array.from({ length: POOL_SIZE }, () =>
    spawnWorker({ modelDir, vadPath, denoiserPath, embPath, segmentationPath,
      hotwordsFile: rs.file, hotwordsScore: rs.score, beamSearch: rs.highAccuracy }));
  poolReady = Promise.all(pool.map((w) => w.ready)).catch((e) => { destroyPool(); throw e; });
  return poolReady;
}

function destroyPool() {
  if (pool) for (const w of pool) { try { w.proc.kill(); } catch (_) { /* ignore */ } }
  pool = null; poolReady = null;
}

function ensureSeparatorWorker() {
  if (separatorReady) return separatorReady;
  const resolved = resolveSeparationModel();
  if (!resolved.ready) return Promise.reject(new Error('話者別音声分離モデルが未取得です'));
  const { modelPath } = modelManager.separationPathsFor(resolved.baseDir);
  const proc = fork(path.join(__dirname, 'separatorWorker.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const worker = { proc, rpcs: new Map(), readySettled: false };
  worker.ready = new Promise((resolve, reject) => {
    worker.readyResolve = resolve;
    worker.readyReject = reject;
  });
  proc.on('message', (message) => {
    if (message.type === 'ready') {
      worker.readySettled = true;
      worker.readyResolve();
      return;
    }
    if (message.type === 'initError') {
      worker.readySettled = true;
      worker.readyReject(new Error(message.message));
      return;
    }
    const request = worker.rpcs.get(message.rid);
    if (!request) return;
    if (message.type === 'event') {
      if (request.onEvent) request.onEvent(message.payload);
      return;
    }
    if (message.type === 'response') {
      worker.rpcs.delete(message.rid);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    }
  });
  proc.on('exit', () => {
    if (!worker.readySettled) worker.readyReject(new Error('音声分離ワーカーの起動に失敗しました'));
    for (const request of worker.rpcs.values()) request.reject(new Error('音声分離ワーカーが終了しました'));
    worker.rpcs.clear();
    if (separatorWorker === worker) {
      separatorWorker = null;
      separatorReady = null;
    }
  });
  separatorWorker = worker;
  separatorReady = worker.ready.catch((error) => {
    destroySeparatorWorker();
    throw error;
  });
  proc.send({ type: 'init', modelPath });
  return separatorReady;
}

function separatorRpc(op, args, onEvent) {
  if (!separatorWorker) return Promise.reject(new Error('音声分離ワーカーが準備されていません'));
  const rid = ++separatorRidSeq;
  return new Promise((resolve, reject) => {
    separatorWorker.rpcs.set(rid, { resolve, reject, onEvent });
    separatorWorker.proc.send({ type: 'request', rid, op, args });
  });
}

function destroySeparatorWorker() {
  const worker = separatorWorker;
  separatorWorker = null;
  separatorReady = null;
  if (worker) {
    try { worker.proc.kill(); } catch (_) { /* ignore */ }
  }
}

function rpc(w, op, args, onEvent) {
  const rid = ++ridSeq;
  return new Promise((resolve, reject) => {
    w.rpcs.set(rid, { resolve, reject, onEvent });
    w.proc.send({ type: 'request', rid, op, args });
  });
}

// ==== リアルタイム文字起こし（マイク入力） ====
// バッチのプールとは独立した軽量ワーカーを 1 個使う（認識器と VAD のみ。
// ノイズ除去・話者系モデルは載せない）。録音開始を待たせないため、renderer が
// リアルタイムモードへ入った時点で rt:prepare により事前起動し、セッションを
// 跨いで保持する。モード離脱（rt:release）と、辞書・高精度など認識設定が
// 変わる操作（destroyRtWorker 併記箇所）で破棄して陳腐化を防ぐ。
let rtWorker = null;          // spawnWorker の戻り値（事前準備済みを使い回す）
let rtSessionActive = false;  // 録音セッション実行中か（バッチとの排他はこれで判定）
let rtSessionPromise = null;  // rtSession RPC（セッション終了まで pending）
let rtRecording = null;       // { pcmPath, wavPath }
let activeBatchJobs = 0;      // 実行中＋待機中のファイル文字起こし数（リアルタイムと排他）
const activeNotifications = new Set();

function setWindowProgress(progress, options) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setProgressBar(progress, options); }
  catch (_) { /* OS側の進捗表示に失敗しても文字起こしは継続する */ }
}

function overlapCacheKey(filePath, range, numSpeakers) {
  const source = fs.statSync(filePath);
  const { baseDir } = resolveModels();
  const modelPaths = modelManager.pathsFor(baseDir);
  const modelStats = [modelPaths.segmentationPath, modelPaths.embPath].map((p) => {
    try {
      const stat = fs.statSync(p);
      return [p, stat.size, Math.trunc(stat.mtimeMs)];
    } catch (_) {
      return [p, 0, 0];
    }
  });
  return JSON.stringify({
    version: OVERLAP_CACHE_VERSION,
    filePath: path.resolve(filePath),
    size: source.size,
    mtimeMs: Math.trunc(source.mtimeMs),
    range: range || null,
    numSpeakers,
    modelStats,
  });
}

function readOverlapCache(key) {
  const value = overlapAnalysisCache.get(key);
  if (!value) return null;
  overlapAnalysisCache.delete(key);
  overlapAnalysisCache.set(key, value);
  return value.map((segment) => ({ ...segment }));
}

function writeOverlapCache(key, segments) {
  overlapAnalysisCache.delete(key);
  overlapAnalysisCache.set(key, segments.map((segment) => ({ ...segment })));
  while (overlapAnalysisCache.size > OVERLAP_CACHE_LIMIT) {
    overlapAnalysisCache.delete(overlapAnalysisCache.keys().next().value);
  }
}

async function analyzeOverlapInParallel({
  pcmPath, duration, numSpeakers, sendStatus,
}) {
  const chunks = overlapTools.buildDiarizationChunks(duration);
  if (!chunks.length) return [];
  const workers = Math.min(pool.length, chunks.length);
  const numThreads = overlapTools.diarizationThreads(os.cpus().length || 1, workers);
  const batches = Array.from({ length: workers }, () => []);
  chunks.forEach((chunk, index) => batches[index % workers].push(chunk));
  let completed = 0;
  let completedWorkSec = 0;
  sendStatus({
    phase: 'overlap', completed: 0, total: chunks.length,
    completedWorkSec: 0, totalWorkSec: duration,
    totalAudioSec: duration, ratio: 0,
  });
  const results = await Promise.all(batches.map((items, workerIndex) => rpc(
    pool[workerIndex],
    'diarizeBatch',
    { pcmPath, items, numSpeakers, numThreads },
    (event) => {
      if (event.kind !== 'overlapChunk') return;
      completed += event.n || 1;
      completedWorkSec += Math.max(0, Number(event.workSec) || 0);
      sendStatus({
        phase: 'overlap', completed, total: chunks.length,
        completedWorkSec, totalWorkSec: duration,
        totalAudioSec: duration,
        ratio: duration > 0 ? Math.min(1, completedWorkSec / duration) : completed / chunks.length,
      });
    },
  )));
  return results.flat().sort((a, b) => a.start - b.start || a.end - b.end);
}

function updateTaskbarProgress(status) {
  if (!status || status.state === 'queued') return;
  if (status.state === 'cancelling') {
    setWindowProgress(1, { mode: 'paused' });
  } else if (status.state === 'error') {
    setWindowProgress(1, { mode: 'error' });
  } else if (status.state === 'running' && status.phase === 'recognizing' && isFinite(Number(status.ratio))) {
    setWindowProgress(Math.max(0, Math.min(1, Number(status.ratio))), { mode: 'normal' });
  } else if (status.state === 'running') {
    setWindowProgress(2, { mode: 'indeterminate' });
  }
}

function showTranscriptionNotification(filePath, result) {
  let notification = null;
  try {
    if (!Notification.isSupported()) return;
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;
    const count = Array.isArray(result.segments) ? result.segments.length : 0;
    notification = new Notification({
      title: '文字起こしが完了しました',
      body: `${path.basename(filePath)}（${count}区間）`,
      icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    });
    activeNotifications.add(notification);
    let releaseTimer = null;
    const release = () => {
      activeNotifications.delete(notification);
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
    };
    releaseTimer = setTimeout(release, 60000);
    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      release();
    });
    notification.on('close', release);
    notification.on('failed', release);
    notification.show();
  } catch (_) {
    // 通知は補助機能。OS側で拒否されても完了結果は通常どおり返す。
    if (notification) activeNotifications.delete(notification);
  }
}

// 試し文字起こしも同じ CPU ワーカープールを使うため同一キューで直列化する。
// 種別はタスクバー表示だけを分けるために保持する（試行はカード内進捗のみ）。
const batchRunKinds = new Map();
const batchQueue = new SerialJobQueue({
  onChange: ({ activeId, size }) => {
    activeBatchJobs = size;
    if (size === 0 || (activeId != null && batchRunKinds.get(activeId) !== 'full')) {
      setWindowProgress(-1);
    } else if (activeId == null) {
      setWindowProgress(2, { mode: 'indeterminate' });
    }
    // 全体文字起こしの実行中は、工程イベントが設定した進捗率を維持する。
  },
});

function destroyRtWorker() {
  if (rtWorker) { try { rtWorker.proc.kill(); } catch (_) { /* ignore */ } }
  rtWorker = null;
  rtSessionActive = false;
  rtSessionPromise = null;
  if (rtRecording) {
    fs.rm(rtRecording.pcmPath, { force: true }, () => {});
    rtRecording = null;
  }
}

// リアルタイム用ワーカーを起動して init 完了まで待つ。準備済みなら使い回す。
async function ensureRtWorker() {
  if (rtWorker) {
    await rtWorker.ready;
    return rtWorker;
  }
  const { baseDir, ready } = resolveModels();
  if (!ready) throw new Error('モデルが未取得です。先にダウンロードしてください。');
  const { modelDir, vadPath } = modelManager.pathsFor(baseDir);
  const rs = currentRecognizerSettings();
  const w = spawnWorker(
    { modelDir, vadPath, hotwordsFile: rs.file, hotwordsScore: rs.score, beamSearch: rs.highAccuracy },
    { serialization: 'advanced' },
  );
  rtWorker = w;
  // 待機中（RPC なし）の異常終了でも参照を残さない
  w.proc.on('exit', () => { if (rtWorker === w) destroyRtWorker(); });
  try {
    await w.ready;
  } catch (e) {
    if (rtWorker === w) destroyRtWorker();
    throw e;
  }
  return w;
}

// モード進入時の事前準備（録音開始を即時にする）
ipcMain.handle('rt:prepare', async () => {
  await ensureRtWorker();
  return { ok: true };
});

// モード離脱時にメモリを解放する。録音セッション中は何もしない。
ipcMain.handle('rt:release', () => {
  if (!rtSessionActive) destroyRtWorker();
  return { ok: true };
});

// Electron IPC 経由のチャンクを Float32Array に揃える（構造化クローンの型ゆらぎ対策）
function toFloat32(chunk) {
  if (chunk instanceof Float32Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Float32Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 4));
  }
  if (chunk instanceof ArrayBuffer) return new Float32Array(chunk);
  return null;
}

ipcMain.handle('rt:start', async (event, opts = {}) => {
  if (rtSessionActive) throw new Error('リアルタイム文字起こしは既に実行中です');
  if (activeBatchJobs > 0) throw new Error('ファイルの文字起こし中は開始できません。完了を待ってください。');
  // 通常は rt:prepare 済みのワーカーを即使う（未準備ならここで起動して待つ）
  const w = await ensureRtWorker();
  fs.mkdirSync(previewDir, { recursive: true });
  const id = Date.now();
  rtRecording = {
    pcmPath: path.join(previewDir, `rec-${id}.pcm`),
    wavPath: path.join(previewDir, `rec-${id}.wav`),
  };
  rtSessionActive = true;
  rtSessionPromise = rpc(w, 'rtSession', { vad: opts.vad || {}, ...rtRecording }, (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rt:segment', ev);
  });
  // ワーカーの異常終了（設定変更による強制終了を含む）を renderer に通知する。
  // 正常停止後や別セッションの失敗を拾わないよう、ワーカーの同一性を確認する。
  rtSessionPromise.catch((e) => {
    if (rtWorker !== w) return;
    destroyRtWorker();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rt:error', { message: e.message || String(e) });
    }
  });
  return { ok: true };
});

// 高頻度・応答不要の PCM チャンク経路（100ms ≒ 6.4KB）
ipcMain.on('rt:feed', (event, chunk) => {
  if (!rtWorker) return;
  const arr = toFloat32(chunk);
  if (arr && arr.length) rpc(rtWorker, 'rtFeed', { chunk: arr }).catch(() => {});
});

ipcMain.handle('rt:stop', async () => {
  if (!rtWorker || !rtSessionActive) throw new Error('リアルタイム文字起こしは実行されていません');
  try {
    const result = await rpc(rtWorker, 'rtStop', {});
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return {
      ...result,
      name: `録音_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.wav`,
    };
  } finally {
    // ワーカーは次の録音に備えて保持する（破棄はモード離脱・設定変更・終了時）。
    // 録音 WAV は結果として参照されるため消さない。
    rtSessionActive = false;
    rtSessionPromise = null;
    rtRecording = null;
  }
});

ipcMain.handle('rt:cancel', () => {
  const wavPath = rtRecording ? rtRecording.wavPath : null;
  destroyRtWorker();
  if (wavPath) fs.rm(wavPath, { force: true }, () => {});
  return { ok: true };
});

// 録音 WAV は一時領域（終了時に削除）にあるため、残したい場合はここで複製する
ipcMain.handle('rt:saveWav', async (event, wavPath, suggestedName) => {
  const base = String(suggestedName || 'recording').replace(/[\\/:*?"<>|]/g, '_');
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${base}.wav`,
    filters: [{ name: 'WAV', extensions: ['wav'] }],
  });
  if (res.canceled) return { saved: false };
  await fs.promises.copyFile(wavPath, res.filePath);
  return { saved: true, path: res.filePath };
});

// ---- IPC ----
ipcMain.handle('app-preferences:get', () => appPreferences());
ipcMain.handle('app-preferences:set', (event, value) => saveAppPreferences(value));
ipcMain.on('app:unsaved-state', (event, value) => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) return;
  latestUnsavedState = unsavedState.normalizeState(value);
});

ipcMain.handle('model:status', () => {
  const r = resolveModels();
  return { ready: r.ready, source: r.source };
});

ipcMain.handle('model:download', async (event) => {
  const baseDir = userDataModelsDir();
  await modelManager.downloadAll(baseDir, (p) => {
    event.sender.send('model:progress', p);
  });
  destroyPool(); // モデルを読み直させる
  destroyRtWorker();
  return { ready: modelManager.isComplete(baseDir) };
});

ipcMain.handle('model:separation-status', () => {
  const resolved = resolveSeparationModel();
  return {
    ready: resolved.ready,
    source: resolved.source,
    model: {
      id: modelManager.SEPARATION_MODEL.id,
      name: modelManager.SEPARATION_MODEL.name,
      bytes: modelManager.SEPARATION_MODEL.bytes,
      license: modelManager.SEPARATION_MODEL.license,
      sourceUrl: modelManager.SEPARATION_MODEL.sourceUrl,
    },
  };
});

ipcMain.handle('model:separation-download', async (event) => {
  const baseDir = userDataModelsDir();
  await modelManager.downloadSeparation(baseDir, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('model:separation-progress', progress);
  });
  destroySeparatorWorker();
  return { ready: modelManager.isSeparationComplete(baseDir, { verifyHash: true }) };
});

// 認識設定（辞書＋高精度モード）の取得/保存。保存時はプールを落として次回再構築させる。
ipcMain.handle('hotwords:get', () => {
  const rs = currentRecognizerSettings();
  return { text: rs.text, score: rs.score, enabled: rs.enabled, highAccuracy: rs.highAccuracy };
});
ipcMain.handle('hotwords:set', (event, { text, score, enabled }) => {
  // 空行/前後空白を除いて 1 行 1 語に正規化
  const words = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  fs.mkdirSync(path.dirname(hotwordsPath()), { recursive: true });
  fs.writeFileSync(hotwordsPath(), words.join('\n') + (words.length ? '\n' : ''), 'utf8');
  const s = readSettings();
  if (typeof score === 'number' && isFinite(score)) s.hotwordsScore = score;
  if (typeof enabled === 'boolean') s.hotwordsEnabled = enabled;
  writeSettings(s);
  destroyPool(); // 次回の文字起こしで新しい辞書を読み込ませる
  destroyRtWorker(); // 実行中のリアルタイムセッションも新設定で作り直させる
  return { ok: true, count: words.length };
});
// 高精度モード（beam search）の ON/OFF。辞書とは独立。即時保存してプールを作り直す。
ipcMain.handle('accuracy:set', (event, highAccuracy) => {
  const s = readSettings();
  s.highAccuracy = !!highAccuracy;
  writeSettings(s);
  destroyPool();
  destroyRtWorker();
  return { ok: true, highAccuracy: s.highAccuracy };
});

// 区切り設定のユーザー定義プリセット。settings.json に最大20件保存する。
ipcMain.handle('vad-presets:get', () => customVadPresets());
ipcMain.handle('vad-presets:save', (event, value) => {
  const incoming = normalizeCustomVadPreset(value);
  if (!incoming) throw new Error('プリセット名を入力してください');
  const s = readSettings();
  const presets = customVadPresets();
  let index = presets.findIndex((p) => p.id === incoming.id);
  if (index < 0) index = presets.findIndex((p) => p.name.toLocaleLowerCase() === incoming.name.toLocaleLowerCase());
  if (index >= 0) {
    incoming.id = presets[index].id;
    presets[index] = incoming;
  } else {
    if (presets.length >= MAX_CUSTOM_VAD_PRESETS) throw new Error(`保存できるプリセットは${MAX_CUSTOM_VAD_PRESETS}件までです`);
    presets.push(incoming);
  }
  s.vadPresets = presets;
  writeSettings(s);
  return { ok: true, preset: incoming, presets };
});
ipcMain.handle('vad-presets:delete', (event, id) => {
  const s = readSettings();
  const presets = customVadPresets().filter((p) => p.id !== String(id || ''));
  s.vadPresets = presets;
  writeSettings(s);
  return { ok: true, presets };
});

ipcMain.handle('dialog:openFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音声/動画', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm', 'avi'] },
      { name: 'すべて', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

function checkCancel(jobId) {
  if (cancelled.has(jobId)) { cancelled.delete(jobId); throw new Error('中止しました'); }
}

function deliverTranscribeStatus(sender, jobId, payload, delivery = {}) {
  const status = { jobId, at: Date.now(), ...(delivery.extra || {}), ...payload };
  if (sender && !sender.isDestroyed()) sender.send(delivery.channel || 'transcribe:status', status);
  const queueId = delivery.queueId == null ? jobId : delivery.queueId;
  if (delivery.taskbar !== false && batchQueue.activeId === queueId) updateTaskbarProgress(status);
}

ipcMain.handle('transcribe:cancel', (event, jobId) => {
  if (batchQueue.hasQueued(jobId)) {
    const error = transcriptionProgress.describeError(new Error('中止しました'), 'queued', true);
    deliverTranscribeStatus(event.sender, jobId, { state: 'cancelled', phase: 'queued', error });
    batchQueue.cancelQueued(jobId, new Error('中止しました'));
    return true;
  }
  if (batchQueue.activeId !== jobId) return false;
  cancelled.add(jobId);
  deliverTranscribeStatus(event.sender, jobId, { state: 'cancelling' });
  // ネイティブ処理は中断できないため、プールを落として確実に止める（次回再生成）
  destroyPool();
  destroySeparatorWorker();
  return true;
});

ipcMain.handle('transcribe:skip-overlap', (event, jobId) => {
  if (batchQueue.activeId !== jobId || activeTranscriptionPhases.get(jobId) !== 'overlap') {
    return false;
  }
  if (skipOverlapRequested.has(jobId)) return true;
  skipOverlapRequested.add(jobId);
  deliverTranscribeStatus(event.sender, jobId, {
    state: 'running', phase: 'overlap', skippingOverlap: true,
  });
  // 個々の diarizer.process は途中で止められないためプールを停止する。
  // デコード済みPCMは残し、performTranscription が新しいプールで通常ASRだけを続ける。
  destroyPool();
  return true;
});

function trialRunKey(jobId, trialId) {
  return `trial:${String(jobId)}:${String(trialId)}`;
}

function autoTuneRunKey(jobId, tuneId) {
  return `auto-tune:${String(jobId)}:${String(tuneId)}`;
}

ipcMain.handle('transcribe:trial-cancel', (event, jobId, trialId) => {
  const runKey = trialRunKey(jobId, trialId);
  const delivery = {
    channel: 'transcribe:trial-status', taskbar: false, queueId: runKey, extra: { trialId },
  };
  if (batchQueue.hasQueued(runKey)) {
    const error = transcriptionProgress.describeError(new Error('中止しました'), 'queued', true);
    deliverTranscribeStatus(event.sender, jobId, { state: 'cancelled', phase: 'queued', error }, delivery);
    batchQueue.cancelQueued(runKey, new Error('中止しました'));
    return true;
  }
  if (batchQueue.activeId !== runKey) return false;
  cancelled.add(runKey);
  deliverTranscribeStatus(event.sender, jobId, { state: 'cancelling' }, delivery);
  destroyPool();
  destroySeparatorWorker();
  return true;
});

ipcMain.handle('transcribe:auto-tune-cancel', (event, jobId, tuneId) => {
  const runKey = autoTuneRunKey(jobId, tuneId);
  const delivery = {
    channel: 'transcribe:auto-tune-status', taskbar: false, queueId: runKey, extra: { tuneId },
  };
  if (batchQueue.hasQueued(runKey)) {
    const error = transcriptionProgress.describeError(new Error('中止しました'), 'queued', true);
    deliverTranscribeStatus(event.sender, jobId, { state: 'cancelled', phase: 'queued', error }, delivery);
    batchQueue.cancelQueued(runKey, new Error('中止しました'));
    return true;
  }
  if (batchQueue.activeId !== runKey) return false;
  cancelled.add(runKey);
  deliverTranscribeStatus(event.sender, jobId, { state: 'cancelling', phase: 'tuning' }, delivery);
  // ネイティブ推論の途中でも確実に止めるため、既存の文字起こし中止と同じ扱いにする。
  destroyPool();
  return true;
});

// 手本（話者ごとの代表区間）で全区間を再識別する
// 手本（話者ごとの代表区間）で全区間を再識別する。遠い区間は -1（不明）。
ipcMain.handle('diarize:reassign', (event, jobId, references) => {
  const embs = jobEmbeddings.get(jobId);
  if (!embs) throw new Error('声紋データが見つかりません。「話者でタグ付け」をやり直してください。');
  const labels = assignByReferences(embs, references, { threshold: UNKNOWN_THRESHOLD });
  // 手本に指定された区間はその話者で固定
  for (const [sid, idxs] of Object.entries(references)) {
    for (const i of idxs) labels[i] = Number(sid);
  }
  return { labels, speakerCount: new Set(labels.filter((l) => l >= 0)).size };
});

// 後付けの話者タグ付け用に、全区間の話者埋め込みを遅延計算してキャッシュする
ipcMain.handle('embeddings:compute', async (event, jobId, filePath, denoiseStrength, segments) => {
  await ensurePool();
  fs.mkdirSync(previewDir, { recursive: true });
  const pcmPath = path.join(previewDir, `emb-${jobId}-${Date.now()}.pcm`);
  const sendProgress = (ratio) => mainWindow && mainWindow.webContents.send('embed:progress', { jobId, ratio });
  try {
    sendProgress(0.02);
    const total = segments.length;
    const separated = separatedEmbeddings.get(jobId) || new Map();
    const embs = new Array(total);
    const rawItems = [];
    segments.forEach((segment, idx) => {
      const cached = segment.separationEmbeddingId
        ? separated.get(segment.separationEmbeddingId) : null;
      if (cached) embs[idx] = cached;
      else rawItems.push({ idx, start: segment.start, end: segment.end });
    });
    if (rawItems.length) {
      await rpc(pool[0], 'decodePcm', { filePath, denoiseStrength: denoiseStrength || 0, outPath: pcmPath });
    }
    const batches = Array.from({ length: pool.length }, () => []);
    rawItems.forEach((item, index) => batches[index % pool.length].push(item));
    let done = total - rawItems.length;
    await Promise.all(batches.map((items, w) => {
      if (!items.length) return null;
      return rpc(pool[w], 'embedBatch', { pcmPath, items }, (ev) => {
        if (ev.kind === 'emb') { done += ev.n; sendProgress(0.05 + 0.93 * (done / total)); }
      }).then((res) => { for (const r of res) embs[r.idx] = r.embedding; });
    }));
    cacheEmbeddings(jobId, embs);
    sendProgress(1);
    return { ok: true, count: total };
  } finally {
    fs.rm(pcmPath, { force: true }, () => {});
  }
});

// メディアファイルの中身を丸ごと返す（結果画面の再生プレイヤー用）。
// renderer はこれを Blob URL にして <audio> に渡す。app-media URL を直接
// <audio> に渡すと、区間の頭出し（シーク）で MEDIA_ERR_NETWORK になるため
// （src/main/mediaProtocol.js の注記参照）、ネットワーク層を完全に迂回する。
const MAX_MEDIA_READ_BYTES = 1024 * 1024 * 1024; // 1GB。超える場合は renderer 側でフォールバック
ipcMain.handle('media:read', async (event, filePath) => {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_MEDIA_READ_BYTES) throw new Error('ファイルが大きすぎます');
  const data = await fs.promises.readFile(filePath);
  const type = MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  return { data, type };
});

// 区間の音声クリップを生成して再生用パスを返す（試聴）
ipcMain.handle('clip:segment', async (event, filePath, start, end) => {
  await ensurePool();
  fs.mkdirSync(previewDir, { recursive: true });
  const outPath = path.join(previewDir, `clip-${Date.now()}-${Math.round(start * 1000)}.wav`);
  return rpc(pool[0], 'clip', { filePath, start, end, outPath });
});

// 修正タイムラインの1発話について、境界違いの認識候補を遅延生成する。
// 通常の文字起こしと同時にモデルを使わないよう、同じ直列キューへ積む。
ipcMain.handle('transcribe:segment-candidates', (event, filePath, request = {}) => {
  const requestId = `segment-candidates-${randomUUID()}`;
  return batchQueue.enqueue({
    id: requestId,
    run: async () => {
      await ensurePool();
      return rpc(pool[0], 'segmentCandidates', {
        filePath,
        start: Number(request.start),
        end: Number(request.end),
        denoiseStrength: Number(request.denoiseStrength) || 0,
      });
    },
  });
});

function meanEmbedding(segments) {
  const values = (Array.isArray(segments) ? segments : [])
    .map((segment) => segment.embedding)
    .filter((embedding) => Array.isArray(embedding) && embedding.length);
  return values.length ? Array.from(centroid(values)) : null;
}

function assignSeparatedStemSpeakers(stems, anchorsBySpeaker) {
  const embeddings = stems.map((stem) => stem.embedding);
  const speakerEntries = [...anchorsBySpeaker.entries()]
    .filter(([, values]) => values.length)
    .map(([speaker, values]) => [speaker, centroid(values)]);
  if (!embeddings.every((embedding) => Array.isArray(embedding) && embedding.length)
    || speakerEntries.length < 2) return stems;

  let best = null;
  let secondScore = Infinity;
  for (let first = 0; first < speakerEntries.length; first++) {
    for (let second = 0; second < speakerEntries.length; second++) {
      if (first === second) continue;
      const d0 = cosineDistance(l2normalize(embeddings[0]), speakerEntries[first][1]);
      const d1 = cosineDistance(l2normalize(embeddings[1]), speakerEntries[second][1]);
      const score = d0 + d1;
      if (!best || score < best.score) {
        if (best) secondScore = best.score;
        best = { score, distances: [d0, d1], indexes: [first, second] };
      } else if (score < secondScore) secondScore = score;
    }
  }
  if (!best || best.distances.some((distance) => distance > UNKNOWN_THRESHOLD)) return stems;
  const margin = Number.isFinite(secondScore) ? secondScore - best.score : 0;
  return stems.map((stem, index) => ({
    ...stem,
    speakerHint: speakerEntries[best.indexes[index]][0],
    confidence: Math.max(0, Math.min(1, 1 - best.distances[index])) * Math.min(1, 0.5 + margin * 4),
  }));
}

async function runOverlapSeparation({
  runId, pcmPath, duration, overlapIntervals, speakerSegments, vad,
  baselineSegments, sendStatus, checkCancelled,
}) {
  const windows = separationTools.buildSeparationWindows(overlapIntervals, duration);
  if (!windows.length) {
    return { segments: baselineSegments, embeddings: new Map(), requested: true, windows: 0, adopted: 0 };
  }
  const resolved = resolveSeparationModel();
  if (!resolved.ready) throw new Error('話者別音声分離モデルが未取得です');
  await ensureSeparatorWorker();
  checkCancelled();

  fs.mkdirSync(previewDir, { recursive: true });
  const safeRunId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const outputDir = fs.mkdtempSync(path.join(previewDir, `separation-${safeRunId}-`));
  try {
    let separatedDone = 0;
    const totalUnits = windows.length * 3;
    sendStatus({
      phase: 'separating', completed: 0, total: totalUnits,
      ratio: 0, totalAudioSec: duration,
    });
    const separated = await separatorRpc('separateBatch', {
      pcmPath, outputDir, windows,
    }, (event) => {
      if (event.kind !== 'separationWindow') return;
      separatedDone += 1;
      sendStatus({
        phase: 'separating', completed: separatedDone, total: totalUnits,
        ratio: separatedDone / totalUnits, totalAudioSec: duration,
      });
    });
    checkCancelled();

    const stemItems = separated.flatMap((entry) => {
      const window = windows[entry.windowIndex];
      return entry.files.map((file) => ({
        windowIndex: entry.windowIndex,
        stemIndex: file.stemIndex,
        pcmPath: file.pcmPath,
        windowStart: window.start,
        overlapStart: window.overlapStart,
        overlapEnd: window.overlapEnd,
      }));
    });
    const batches = Array.from({ length: pool.length }, () => []);
    stemItems.forEach((item, index) => batches[index % pool.length].push(item));
    const recognizedValues = await Promise.all(batches.map((items, workerIndex) => {
      if (!items.length) return [];
      return rpc(pool[workerIndex], 'processSeparatedBatch', { items, vad }, (event) => {
        if (event.kind !== 'separatedStem') return;
        separatedDone += 1;
        sendStatus({
          phase: 'separating', completed: separatedDone, total: totalUnits,
          ratio: Math.min(1, separatedDone / totalUnits), totalAudioSec: duration,
        });
      });
    }));
    checkCancelled();

    const anchors = separationTools.buildSpeakerAnchorItems(
      windows, speakerSegments, overlapIntervals,
    );
    const anchorEmbeddings = new Map();
    if (anchors.length) {
      const anchorBatches = Array.from({ length: pool.length }, () => []);
      anchors.forEach((item, index) => anchorBatches[index % pool.length].push(item));
      const anchorResults = await Promise.all(anchorBatches.map((items, workerIndex) => (
        items.length ? rpc(pool[workerIndex], 'embedBatch', { pcmPath, items }) : []
      )));
      const metadata = new Map(anchors.map((item) => [item.idx, item]));
      for (const result of anchorResults.flat()) {
        const item = metadata.get(result.idx);
        if (!item || !Array.isArray(result.embedding)) continue;
        const key = `${item.windowIndex}:${item.speaker}`;
        if (!anchorEmbeddings.has(key)) anchorEmbeddings.set(key, []);
        anchorEmbeddings.get(key).push(result.embedding);
      }
    }

    const recognized = recognizedValues.flat();
    const additions = [];
    const embeddingCache = new Map();
    const rejectedReasons = {};
    let adopted = 0;
    for (const window of windows) {
      let stems = [0, 1].map((stemIndex) => {
        const result = recognized.find((item) => item.windowIndex === window.index
          && item.stemIndex === stemIndex) || { segments: [] };
        return {
          stemIndex,
          segments: result.segments || [],
          embedding: meanEmbedding(result.segments || []),
        };
      });
      const anchorsForWindow = new Map();
      for (const [key, values] of anchorEmbeddings) {
        const prefix = `${window.index}:`;
        if (key.startsWith(prefix)) anchorsForWindow.set(key.slice(prefix.length), values);
      }
      stems = assignSeparatedStemSpeakers(stems, anchorsForWindow);
      const entry = separated.find((item) => item.windowIndex === window.index);
      const metrics = { ...(entry && entry.metrics ? entry.metrics : {}) };
      if (stems[0].embedding && stems[1].embedding) {
        metrics.embeddingDistance = cosineDistance(
          l2normalize(stems[0].embedding), l2normalize(stems[1].embedding),
        );
      }
      const decision = separationTools.selectSeparatedAdditions({
        window, stems, metrics, baselineSegments,
      });
      if (!decision.accepted) {
        rejectedReasons[decision.reason] = (rejectedReasons[decision.reason] || 0) + 1;
        continue;
      }
      adopted += 1;
      for (const segment of decision.additions) {
        const stem = stems[segment.separationTrack];
        const embedding = segment.embedding || (stem && stem.embedding);
        const embeddingId = `sep-${runId}-${window.index}-${segment.separationTrack}-${embeddingCache.size}`;
        const { embedding: _embedding, ...clean } = segment;
        if (embedding) embeddingCache.set(embeddingId, embedding);
        additions.push({
          ...clean,
          separationEmbeddingId: embedding ? embeddingId : undefined,
        });
      }
    }
    return {
      segments: separationTools.mergeSeparatedSegments(baselineSegments, additions),
      embeddings: embeddingCache,
      requested: true,
      windows: windows.length,
      adopted,
      recovered: additions.length,
      rejectedReasons,
      model: modelManager.SEPARATION_MODEL.id,
    };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

async function performTranscription(sender, filePath, runId, opts = {}, execution = {}) {
  const publicJobId = execution.jobId == null ? runId : execution.jobId;
  const safeRunId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  const pcmPath = path.join(previewDir, `work-${safeRunId}-${Date.now()}.pcm`);
  const rawPcmPath = path.join(previewDir, `work-${safeRunId}-${Date.now()}-raw.pcm`);
  const delivery = {
    channel: execution.statusChannel || 'transcribe:status',
    taskbar: execution.taskbar !== false,
    queueId: runId,
    extra: execution.trialId == null ? {} : { trialId: execution.trialId },
  };
  let currentPhase = 'preparing';
  activeTranscriptionPhases.set(runId, currentPhase);
  const sendStatus = (payload = {}) => {
    if (payload.phase) currentPhase = payload.phase;
    activeTranscriptionPhases.set(runId, currentPhase);
    deliverTranscribeStatus(sender, publicJobId, {
      state: 'running', phase: currentPhase, ...payload,
    }, delivery);
  };
  // 旧進捗イベントは互換用に残す。新しい画面は transcribe:status を使う。
  const sendProgress = (ratio) => {
    if (execution.emitLegacyProgress !== false && !sender.isDestroyed()) {
      sender.send('transcribe:progress', { jobId: publicJobId, ratio });
    }
  };

  try {
    sendStatus({ phase: 'preparing' });
    // リアルタイム実行中は CPU を取り合うため排他にする（rt:start 側も逆向きに確認する）。
    // 準備済みのアイドルワーカーは対象外（録音セッション中だけ弾く）。
    if (rtSessionActive) {
      throw new Error('リアルタイム文字起こしの実行中は開始できません。先に録音を停止してください。');
    }
    checkCancel(runId);
    await ensurePool();
    checkCancel(runId);
    fs.mkdirSync(previewDir, { recursive: true });
    // Stage A: デコード+ノイズ除去+VADを行い、原音の重なり解析は別工程で
    // 120秒チャンクへ分けてワーカープール全体に並列化する。
    sendProgress(0.02);
    const vadOpts = opts.vad || {};
    const trialRange = opts.range ? rangeTools.normalizeTrialRange(opts.range) : null;
    const overlapOpts = {
      enabled: vadOpts.overlapAware === true,
      numSpeakers: Number.isInteger(vadOpts.overlapSpeakers)
        ? Math.min(4, Math.max(2, vadOpts.overlapSpeakers)) : 2,
      separation: vadOpts.overlapSeparation === true,
    };
    const denoiseStrength = Number(opts.denoiseStrength) || 0;
    const overlapPcmPath = overlapOpts.enabled && denoiseStrength > 0 ? rawPcmPath : pcmPath;
    const prepareAudio = () => rpc(pool[0], 'prepare', {
      filePath, denoiseStrength: opts.denoiseStrength || 0, outPath: pcmPath,
      rawOutPath: overlapPcmPath === rawPcmPath ? rawPcmPath : null,
      vad: vadOpts, // 発話検出の設定（未指定なら core の標準値）
      // 重なり解析は下でチャンク並列化する。prepare 内の旧経路は互換用に残す。
      overlap: { enabled: false },
      range: trialRange,
    }, (ev) => {
      if (ev.kind === 'phase') {
        sendStatus({ phase: ev.phase, totalAudioSec: ev.totalAudioSec || 0 });
      }
    });
    const prep = await prepareAudio();
    let overlapSkipped = false;
    let overlapCached = false;
    prep.speakerSegments = [];
    prep.overlapError = '';
    if (overlapOpts.enabled) {
      const cacheKey = overlapCacheKey(filePath, trialRange, overlapOpts.numSpeakers);
      const cached = readOverlapCache(cacheKey);
      if (cached) {
        prep.speakerSegments = cached;
        overlapCached = true;
        sendStatus({
          phase: 'overlap', completed: 1, total: 1, ratio: 1,
          totalAudioSec: prep.duration, cached: true,
        });
      } else {
        let analysisError = null;
        try {
          prep.speakerSegments = await analyzeOverlapInParallel({
            pcmPath: overlapPcmPath,
            duration: prep.duration,
            numSpeakers: overlapOpts.numSpeakers,
            sendStatus,
          });
        } catch (error) {
          analysisError = error;
        }
        if (skipOverlapRequested.delete(runId)) {
          overlapSkipped = true;
          overlapOpts.enabled = false;
          prep.speakerSegments = [];
          sendStatus({ phase: 'preparing', skippingOverlap: true });
          if (cancelled.has(runId)) checkCancel(runId);
          await ensurePool();
          sendStatus({
            state: 'warning',
            warning: '重なり音声の解析をスキップし、通常の文字起こしを続けています。',
          });
        } else if (analysisError) {
          if (cancelled.has(runId)) checkCancel(runId);
          prep.overlapError = analysisError.message || String(analysisError);
          if (/ワーカーが終了/.test(prep.overlapError)) {
            destroyPool();
            await ensurePool();
          }
        } else {
          writeOverlapCache(cacheKey, prep.speakerSegments);
        }
      }
    }
    checkCancel(runId);
    const maxDuration = (typeof vadOpts.maxSpeechDuration === 'number' && isFinite(vadOpts.maxSpeechDuration))
      ? Math.min(30, Math.max(2, vadOpts.maxSpeechDuration)) : 6;
    const sourceOffsetSeconds = Number(prep.sourceOffsetSeconds) || 0;
    const baseSegments = prep.range
      ? rangeTools.selectSegments(
        prep.segments,
        prep.range.selectionStartSeconds,
        prep.range.selectionEndSeconds,
      )
      : prep.segments;
    const recognitionPlan = overlapTools.buildRecognitionItems(
      baseSegments,
      prep.speakerSegments || [],
      { enabled: overlapOpts.enabled, maxDuration },
    );
    const segs = recognitionPlan.items;
    const plannedTotal = segs.length;
    const plannedWorkSec = segs.reduce(
      (sum, item) => sum + Math.max(0, item.end - item.start), 0,
    );
    const reportedDuration = prep.range ? prep.range.actualDurationSeconds : prep.duration;
    const resultRange = prep.range ? {
      startSeconds: prep.range.startSeconds,
      endSeconds: prep.range.startSeconds + prep.range.actualDurationSeconds,
      durationSeconds: prep.range.actualDurationSeconds,
      requestedDurationSeconds: prep.range.requestedDurationSeconds,
    } : null;
    if (prep.overlapError) {
      sendStatus({
        state: 'warning', phase: 'overlap',
        warning: '重なり音声の解析を省略し、通常の文字起こしを続けています。',
        warningDetail: prep.overlapError,
        totalAudioSec: reportedDuration,
      });
    }
    if (plannedTotal === 0) {
      sendStatus({ phase: 'finalizing', totalAudioSec: reportedDuration });
      sendStatus({ state: 'completed', phase: 'finalizing', ratio: 1, totalAudioSec: reportedDuration });
      sendProgress(1);
      return {
        segments: [], text: '', duration: reportedDuration, range: resultRange,
        filePath, name: path.basename(filePath), jobId: publicJobId,
      };
    }

    // Stage B: base と primary（最大3候補）を先に認識し、候補が割れた
    // repairId だけ extended 候補を追加する。
    let done = 0;
    let completedWorkSec = 0;
    const partial = new Array(plannedTotal);
    const initialIndexes = [];
    const extendedIndexes = [];
    segs.forEach((item, index) => {
      if (item.kind === 'repair' && item.variantTier === 'extended') extendedIndexes.push(index);
      else initialIndexes.push(index);
    });
    let scheduledTotal = initialIndexes.length;
    let scheduledWorkSec = initialIndexes.reduce(
      (sum, index) => sum + Math.max(0, segs[index].end - segs[index].start), 0,
    );

    const recognizeIndexes = async (indexes) => {
      const batches = Array.from({ length: pool.length }, () => []);
      indexes.forEach((index, order) => {
        const item = segs[index];
        batches[order % pool.length].push({ idx: index, start: item.start, end: item.end });
      });
      sendStatus({
        phase: 'recognizing', completed: done, total: plannedTotal,
        completedWorkSec, totalWorkSec: plannedWorkSec,
        totalAudioSec: reportedDuration,
        ratio: plannedWorkSec > 0 ? Math.min(1, completedWorkSec / plannedWorkSec) : 0,
      });
      await Promise.all(batches.map((items, workerIndex) => {
        if (!items.length) return null;
        return rpc(pool[workerIndex], 'processBatch', {
          pcmPath, items, wantEmbedding: false,
        }, (event) => {
          if (event.kind !== 'seg') return;
          done += event.n;
          completedWorkSec += Math.max(0, Number(event.workSec) || 0);
          const ratio = plannedWorkSec > 0
            ? Math.min(1, completedWorkSec / plannedWorkSec) : done / plannedTotal;
          const item = segs[event.idx];
          if (item) partial[event.idx] = { ...item, text: event.text || '' };
          const partialUpdate = item && item.kind === 'base' && String(event.text || '').trim()
            ? {
              index: event.idx,
              start: item.start + sourceOffsetSeconds,
              end: item.end + sourceOffsetSeconds,
              text: String(event.text).trim(),
            }
            : null;
          sendStatus({
            phase: 'recognizing', completed: done, total: plannedTotal,
            completedWorkSec, totalWorkSec: plannedWorkSec,
            totalAudioSec: reportedDuration, ratio,
            partial: partialUpdate,
          });
          sendProgress(0.05 + 0.9 * ratio);
        }).then((results) => {
          for (const result of results) {
            partial[result.idx] = { ...segs[result.idx], text: result.text };
          }
        });
      }));
    };

    await recognizeIndexes(initialIndexes);
    checkCancel(runId);
    const expandRepairs = overlapTools.repairsNeedingExpansion(partial.filter(Boolean));
    const selectedExtendedIndexes = extendedIndexes.filter(
      (index) => expandRepairs.has(segs[index].repairId),
    );
    if (selectedExtendedIndexes.length) {
      scheduledTotal += selectedExtendedIndexes.length;
      scheduledWorkSec += selectedExtendedIndexes.reduce(
        (sum, index) => sum + Math.max(0, segs[index].end - segs[index].start), 0,
      );
      await recognizeIndexes(selectedExtendedIndexes);
    }
    checkCancel(runId);

    sendStatus({
      phase: 'finalizing', completed: done, total: scheduledTotal,
      completedWorkSec: scheduledWorkSec, totalWorkSec: scheduledWorkSec,
      totalAudioSec: reportedDuration,
    });
    const finalized = overlapTools.finalizeRecognition(partial.filter(Boolean));
    let separationResult = {
      segments: finalized.segments,
      embeddings: new Map(),
      requested: overlapOpts.separation,
      windows: 0,
      adopted: 0,
      recovered: 0,
      error: '',
    };
    if (overlapOpts.enabled && overlapOpts.separation
      && recognitionPlan.overlapIntervals.length) {
      try {
        separationResult = await runOverlapSeparation({
          runId,
          pcmPath: overlapPcmPath,
          duration: prep.duration,
          overlapIntervals: recognitionPlan.overlapIntervals,
          speakerSegments: prep.speakerSegments || [],
          vad: vadOpts,
          baselineSegments: finalized.segments,
          sendStatus,
          checkCancelled: () => checkCancel(runId),
        });
      } catch (error) {
        if (cancelled.has(runId) || /中止|cancel/i.test(String(error && error.message))) throw error;
        separationResult.error = error.message || String(error);
        sendStatus({
          state: 'warning', phase: 'separating',
          warning: '話者別音声分離を適用できなかったため、従来の重なり補正結果を使用します。',
          warningDetail: separationResult.error,
          totalAudioSec: reportedDuration,
        });
      }
    }
    checkCancel(runId);
    sendStatus({ phase: 'finalizing', ratio: 1, totalAudioSec: reportedDuration });
    const selected = prep.range
      ? rangeTools.selectSegments(
        separationResult.segments,
        prep.range.selectionStartSeconds,
        prep.range.selectionEndSeconds,
      )
      : separationResult.segments;
    const ordered = rangeTools.offsetSegments(selected, sourceOffsetSeconds);
    if (!execution.trialId) {
      cacheSeparatedEmbeddings(publicJobId, separationResult.embeddings);
    }
    sendProgress(1);
    sendStatus({ state: 'completed', phase: 'finalizing', ratio: 1, totalAudioSec: reportedDuration });
    return {
      segments: ordered,
      text: ordered.map((s) => s.text).join('\n'),
      duration: reportedDuration,
      range: resultRange,
      overlap: {
        enabled: overlapOpts.enabled,
        skipped: overlapSkipped,
        cached: overlapCached,
        detected: recognitionPlan.overlapIntervals.length,
        recovered: finalized.recoveredGroups,
        candidatesRecognized: done,
        candidatesPlanned: plannedTotal,
        error: prep.overlapError || '',
        separation: {
          requested: overlapOpts.separation,
          model: separationResult.model || modelManager.SEPARATION_MODEL.id,
          windows: separationResult.windows || 0,
          adopted: separationResult.adopted || 0,
          recovered: separationResult.recovered || 0,
          rejectedReasons: separationResult.rejectedReasons || {},
          error: separationResult.error || '',
        },
      },
      filePath, name: path.basename(filePath), jobId: publicJobId,
    };
  } catch (e) {
    const wasCancelled = cancelled.has(runId) || /中止|cancel/i.test(String((e && e.message) || e));
    const error = transcriptionProgress.describeError(e, currentPhase, wasCancelled);
    sendStatus({ state: wasCancelled ? 'cancelled' : 'error', error });
    throw e;
  } finally {
    cancelled.delete(runId);
    skipOverlapRequested.delete(runId);
    activeTranscriptionPhases.delete(runId);
    fs.rm(pcmPath, { force: true }, () => {});
    fs.rm(rawPcmPath, { force: true }, () => {});
  }
}

function intervalSeconds(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(Number(a.end) || 0, Number(b.end) || 0)
    - Math.max(Number(a.start) || 0, Number(b.start) || 0));
}

// pyannote の内部クラスタ番号を、利用者が手本へ付けた話者IDへ対応付ける。
// 2〜4人なので全組合せ最適化より、重なり時間の大きい組から一対一で確定する方が
// 欠損行にも安定し、対応が付かなかったクラスタは「不明」のまま扱える。
function mapTuneSpeakers(referenceRows, speakerSegments, sourceOffsetSeconds) {
  const rows = autoTune.normalizeReferenceRows(referenceRows);
  const labels = [...new Set(rows.map((row) => row.speaker))];
  if (labels.length < 2 || !speakerSegments.length) return new Map();
  const clusters = [...new Set(speakerSegments.map((segment) => String(segment.speaker)))];
  const pairs = [];
  for (const cluster of clusters) {
    const tracks = speakerSegments
      .filter((segment) => String(segment.speaker) === cluster)
      .map((segment) => ({
        start: segment.start + sourceOffsetSeconds,
        end: segment.end + sourceOffsetSeconds,
      }));
    for (const label of labels) {
      const score = rows.filter((row) => row.speaker === label && row.start != null && row.end != null)
        .reduce((sum, row) => sum + tracks.reduce((n, track) => n + intervalSeconds(row, track), 0), 0);
      pairs.push({ cluster, label, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedClusters = new Set();
  const usedLabels = new Set();
  const mapping = new Map();
  for (const pair of pairs) {
    if (pair.score <= 0 || usedClusters.has(pair.cluster) || usedLabels.has(pair.label)) continue;
    mapping.set(pair.cluster, pair.label);
    usedClusters.add(pair.cluster);
    usedLabels.add(pair.label);
  }
  return mapping;
}

function assignTuneSpeaker(segment, speakerSegments, mapping) {
  let best = null;
  let bestSeconds = 0;
  for (const track of speakerSegments) {
    const overlap = intervalSeconds(segment, track);
    if (overlap > bestSeconds) { bestSeconds = overlap; best = String(track.speaker); }
  }
  return best == null ? '' : (mapping.get(best) || '');
}

function tuneSpeakerAccuracy(referenceRows, segments, speakerSegments, mapping) {
  const rows = autoTune.normalizeReferenceRows(referenceRows);
  const labels = [...new Set(rows.map((row) => row.speaker))];
  if (labels.length < 2 || !mapping.size) return null;
  let referenceLength = 0;
  let weightedErrors = 0;
  for (const label of labels) {
    const reference = rows.filter((row) => row.speaker === label).map((row) => row.normalizedText).join('');
    const hypothesis = segments.filter((segment) => segment.referenceSpeaker === label)
      .map((segment) => segment.text).join('');
    const metrics = autoTune.scoreText(reference, hypothesis);
    referenceLength += metrics.referenceLength;
    weightedErrors += metrics.weightedErrors;
  }
  return Math.max(0, 1 - weightedErrors / Math.max(1, referenceLength));
}

function tuneRecognitionKey(pcmPath, item) {
  return `${pcmPath}|${Number(item.start).toFixed(3)}:${Number(item.end).toFixed(3)}`;
}

async function recognizeTunePlan(runId, pcmPath, items, cache) {
  const unique = [];
  const pendingKeys = new Set();
  for (const item of items) {
    const key = tuneRecognitionKey(pcmPath, item);
    if (cache.has(key) || pendingKeys.has(key)) continue;
    pendingKeys.add(key);
    unique.push({ key, start: item.start, end: item.end });
  }
  if (unique.length) {
    const batches = Array.from({ length: pool.length }, () => []);
    unique.forEach((item, idx) => batches[idx % pool.length].push({ idx, start: item.start, end: item.end }));
    await Promise.all(batches.map((batch, workerIndex) => {
      if (!batch.length) return null;
      return rpc(pool[workerIndex], 'processBatch', {
        pcmPath, items: batch, wantEmbedding: false,
      }).then((results) => {
        for (const result of results) {
          const item = unique[result.idx];
          if (item) cache.set(item.key, String(result.text || '').trim());
        }
      });
    }));
    checkCancel(runId);
  }
  return items.map((item) => ({ ...item, text: cache.get(tuneRecognitionKey(pcmPath, item)) || '' }));
}

function timedReferenceRows(referenceRows) {
  return autoTune.normalizeReferenceRows(referenceRows).filter((row) => (
    row.start != null && row.end != null && row.end > row.start
  ));
}

// 未確定の発話が候補側に存在しても「余計な挿入」として減点しないよう、
// ユーザーが確定した時間窓と重なる認識区間だけを本文評価へ使う。
function hypothesisForReferenceRows(referenceRows, segments) {
  const windows = timedReferenceRows(referenceRows);
  if (!windows.length) return segments.map((segment) => segment.text).join('');
  return segments.filter((segment) => windows.some((row) => {
    const overlap = intervalSeconds(row, segment);
    const midpoint = ((Number(segment.start) || 0) + (Number(segment.end) || 0)) / 2;
    return overlap >= 0.05 || (midpoint >= row.start && midpoint <= row.end);
  })).map((segment) => segment.text).join('');
}

function tuneBoundaryAccuracy(referenceRows, segments) {
  const rows = timedReferenceRows(referenceRows);
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => {
    let best = 0;
    for (const segment of segments) {
      const intersection = intervalSeconds(row, segment);
      const union = Math.max(row.end, Number(segment.end) || 0)
        - Math.min(row.start, Number(segment.start) || 0);
      if (union > 0) best = Math.max(best, intersection / union);
    }
    return sum + best;
  }, 0);
  return total / rows.length;
}

function manualTuneSpeakerTracks(referenceRows, sourceOffsetSeconds) {
  return timedReferenceRows(referenceRows).map((row) => ({
    start: Math.max(0, row.start - sourceOffsetSeconds),
    end: Math.max(0, row.end - sourceOffsetSeconds),
    speaker: `manual:${row.speaker}`,
  })).filter((row) => row.end > row.start);
}

async function evaluateTuneCandidate({
  runId, candidate, prepared, referenceRows, reference, speakerMapping, recognitionCache,
}) {
  const maxDuration = candidate.options.vad.maxSpeechDuration;
  const manualTracks = manualTuneSpeakerTracks(referenceRows, prepared.sourceOffsetSeconds || 0);
  const manualOverlapIntervals = overlapTools.detectOverlapIntervals(manualTracks);
  const plan = overlapTools.buildRecognitionItems(
    prepared.segments,
    prepared.speakerSegments || [],
    {
      enabled: candidate.options.vad.overlapAware === true,
      maxDuration,
      manualOverlapIntervals,
      manualSpeakerSegments: manualTracks,
    },
  );
  const recognized = await recognizeTunePlan(runId, prepared.pcmPath, plan.items, recognitionCache);
  const finalized = overlapTools.finalizeRecognition(recognized.filter(Boolean));
  const selected = rangeTools.selectSegments(
    finalized.segments,
    prepared.range.selectionStartSeconds,
    prepared.range.selectionEndSeconds,
  );
  const relative = selected.map((segment) => ({
    ...segment,
    referenceSpeaker: assignTuneSpeaker(segment, prepared.speakerSegments, speakerMapping),
  }));
  const ordered = rangeTools.offsetSegments(relative, prepared.sourceOffsetSeconds);
  const hypothesis = hypothesisForReferenceRows(referenceRows, ordered);
  const metrics = autoTune.scoreText(reference, hypothesis);
  const speakerAccuracy = tuneSpeakerAccuracy(
    referenceRows, ordered, prepared.speakerSegments, speakerMapping,
  );
  const boundaryAccuracy = tuneBoundaryAccuracy(referenceRows, ordered);
  let rankScore = metrics.accuracy;
  if (boundaryAccuracy != null && speakerAccuracy != null) {
    rankScore = metrics.accuracy * 0.8 + speakerAccuracy * 0.1 + boundaryAccuracy * 0.1;
  } else if (boundaryAccuracy != null) {
    rankScore = metrics.accuracy * 0.9 + boundaryAccuracy * 0.1;
  } else if (speakerAccuracy != null) {
    rankScore = metrics.accuracy * 0.85 + speakerAccuracy * 0.15;
  }
  return {
    ...candidate,
    metrics,
    speakerAccuracy,
    boundaryAccuracy,
    rankScore,
    result: {
      segments: ordered,
      text: ordered.map((segment) => segment.text).join('\n'),
      range: {
        startSeconds: prepared.range.startSeconds,
        endSeconds: prepared.range.startSeconds + prepared.range.actualDurationSeconds,
        durationSeconds: prepared.range.actualDurationSeconds,
        requestedDurationSeconds: prepared.range.requestedDurationSeconds,
      },
      overlap: {
        enabled: candidate.options.vad.overlapAware === true,
        detected: plan.overlapIntervals.length,
        recovered: finalized.recoveredGroups,
      },
    },
  };
}

async function performAutoTune(sender, filePath, jobId, tuneId, opts = {}) {
  const runId = autoTuneRunKey(jobId, tuneId);
  const delivery = {
    channel: 'transcribe:auto-tune-status', taskbar: false, queueId: runId, extra: { tuneId },
  };
  const sendStatus = (payload) => deliverTranscribeStatus(sender, jobId, {
    state: 'running', phase: 'tuning', ...payload,
  }, delivery);
  const rows = autoTune.normalizeReferenceRows(opts.referenceRows).slice(0, 100);
  const reference = rows.map((row) => row.normalizedText).join('').slice(0, 5000);
  if (Array.from(reference).length < autoTune.MIN_REFERENCE_CHARS) {
    throw new Error(`文字起こしを句読点を除いて${autoTune.MIN_REFERENCE_CHARS}文字以上に修正してください。`);
  }
  const speakerCount = Math.min(4, Math.max(1, new Set(rows.map((row) => row.speaker)).size));
  const range = rangeTools.normalizeTrialRange(opts.range || {});
  const coarse = autoTune.buildCoarseCandidates(opts.current || {}, { speakerCount });
  const pcmPaths = [];
  const recognitionCache = new Map();
  let currentPhase = 'preparing';
  try {
    if (rtSessionActive) {
      throw new Error('リアルタイム文字起こしの実行中は開始できません。先に録音を停止してください。');
    }
    sendStatus({ phase: 'preparing', candidateIndex: 0, totalCandidates: coarse.length });
    await ensurePool();
    checkCancel(runId);
    fs.mkdirSync(previewDir, { recursive: true });
    const strengths = [...new Set(coarse.map((candidate) => candidate.options.denoiseStrength))];
    const pcmVariants = strengths.map((strength, index) => {
      const outPath = path.join(previewDir, `tune-${jobId}-${tuneId}-${index}-${Date.now()}.pcm`);
      pcmPaths.push(outPath);
      return { strength, outPath };
    });
    const prep = await rpc(pool[0], 'prepareAutoTune', {
      filePath, range, candidates: coarse, pcmVariants, speakerCount,
    }, (event) => {
      if (event.kind === 'phase') {
        currentPhase = event.phase;
        sendStatus({ phase: event.phase, candidateIndex: 0, totalCandidates: coarse.length });
      }
    });
    checkCancel(runId);
    const speakerMapping = mapTuneSpeakers(rows, prep.speakerSegments || [], prep.sourceOffsetSeconds || 0);
    const preparedById = new Map((prep.candidates || []).map((candidate) => [candidate.id, {
      ...candidate,
      speakerSegments: prep.speakerSegments || [],
      sourceOffsetSeconds: prep.sourceOffsetSeconds || 0,
      range: prep.range,
    }]));

    const evaluated = [];
    for (let index = 0; index < coarse.length; index++) {
      const candidate = coarse[index];
      currentPhase = 'tuning';
      sendStatus({
        phase: 'tuning', candidateIndex: index + 1, totalCandidates: coarse.length,
        candidateLabel: candidate.label,
      });
      const prepared = preparedById.get(candidate.id);
      if (!prepared) throw new Error(`認識設定の調整候補を準備できませんでした: ${candidate.id}`);
      evaluated.push(await evaluateTuneCandidate({
        runId, candidate, prepared, referenceRows: rows, reference,
        speakerMapping, recognitionCache,
      }));
    }

    const coarseBest = autoTune.selectBestCandidate(evaluated);
    const refinements = autoTune.buildRefinementCandidates(coarseBest, evaluated);
    if (refinements.length) {
      const pcmByStrength = new Map(pcmVariants.map((variant) => [Number(variant.strength), variant.outPath]));
      const segmented = await rpc(pool[0], 'segmentAutoTuneCandidates', {
        candidates: refinements.map((candidate) => ({
          ...candidate,
          pcmPath: pcmByStrength.get(Number(candidate.options.denoiseStrength)),
        })),
      });
      const segmentedById = new Map(segmented.map((candidate) => [candidate.id, {
        ...candidate,
        speakerSegments: prep.speakerSegments || [],
        sourceOffsetSeconds: prep.sourceOffsetSeconds || 0,
        range: prep.range,
      }]));
      const totalCandidates = coarse.length + refinements.length;
      for (let index = 0; index < refinements.length; index++) {
        const candidate = refinements[index];
        sendStatus({
          phase: 'tuning', candidateIndex: coarse.length + index + 1, totalCandidates,
          candidateLabel: candidate.label,
        });
        evaluated.push(await evaluateTuneCandidate({
          runId, candidate, prepared: segmentedById.get(candidate.id), referenceRows: rows,
          reference, speakerMapping, recognitionCache,
        }));
      }
    }
    checkCancel(runId);

    const best = autoTune.selectBestCandidate(evaluated);
    if (!best) throw new Error('有効な認識設定の調整結果を得られませんでした。');
    const baseline = evaluated[0];
    const confidence = autoTune.confidenceFor(best, evaluated);
    const ranked = evaluated.slice().sort((a, b) => b.rankScore - a.rankScore);
    sendStatus({ state: 'completed', phase: 'finalizing', ratio: 1 });
    return {
      best: {
        id: best.id,
        label: best.label,
        options: best.options,
        metrics: best.metrics,
        speakerAccuracy: best.speakerAccuracy,
        boundaryAccuracy: best.boundaryAccuracy,
        rankScore: best.rankScore,
        result: best.result,
      },
      baselineAccuracy: baseline ? baseline.metrics.accuracy : null,
      improvement: baseline ? best.metrics.accuracy - baseline.metrics.accuracy : 0,
      confidence,
      speakerCount,
      speakerAnalysisWarning: prep.speakerError || '',
      candidates: ranked.slice(0, 5).map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        options: candidate.options,
        metrics: candidate.metrics,
        speakerAccuracy: candidate.speakerAccuracy,
        boundaryAccuracy: candidate.boundaryAccuracy,
        rankScore: candidate.rankScore,
      })),
      range: best.result.range,
    };
  } catch (error) {
    const wasCancelled = cancelled.has(runId) || /中止|cancel/i.test(String(error && error.message || error));
    const described = transcriptionProgress.describeError(error, currentPhase, wasCancelled);
    deliverTranscribeStatus(sender, jobId, {
      state: wasCancelled ? 'cancelled' : 'error', phase: currentPhase, error: described,
    }, delivery);
    throw error;
  } finally {
    cancelled.delete(runId);
    for (const pcmPath of pcmPaths) fs.rm(pcmPath, { force: true }, () => {});
  }
}

ipcMain.handle('transcribe:file', (event, filePath, jobId, opts = {}) => {
  batchRunKinds.set(jobId, 'full');
  return batchQueue.enqueue({
    id: jobId,
    onPosition: ({ position, total }) => {
      deliverTranscribeStatus(event.sender, jobId, {
        state: 'queued', phase: 'queued', queuePosition: position, queueTotal: total,
      });
    },
    run: async () => {
      const result = await performTranscription(event.sender, filePath, jobId, opts);
      showTranscriptionNotification(filePath, result);
      return result;
    },
  }).finally(() => { batchRunKinds.delete(jobId); });
});

ipcMain.handle('transcribe:trial', (event, filePath, jobId, trialId, opts = {}) => {
  const runKey = trialRunKey(jobId, trialId);
  const delivery = {
    channel: 'transcribe:trial-status', taskbar: false, queueId: runKey, extra: { trialId },
  };
  batchRunKinds.set(runKey, 'trial');
  const trialOpts = { ...opts, range: rangeTools.normalizeTrialRange(opts.range || {}) };
  return batchQueue.enqueue({
    id: runKey,
    onPosition: ({ position, total }) => {
      deliverTranscribeStatus(event.sender, jobId, {
        state: 'queued', phase: 'queued', queuePosition: position, queueTotal: total,
      }, delivery);
    },
    run: () => performTranscription(event.sender, filePath, runKey, trialOpts, {
      jobId,
      trialId,
      statusChannel: 'transcribe:trial-status',
      taskbar: false,
      emitLegacyProgress: false,
    }),
  }).finally(() => { batchRunKinds.delete(runKey); });
});

ipcMain.handle('transcribe:auto-tune', (event, filePath, jobId, tuneId, opts = {}) => {
  const runKey = autoTuneRunKey(jobId, tuneId);
  const delivery = {
    channel: 'transcribe:auto-tune-status', taskbar: false, queueId: runKey, extra: { tuneId },
  };
  batchRunKinds.set(runKey, 'tune');
  return batchQueue.enqueue({
    id: runKey,
    onPosition: ({ position, total }) => {
      deliverTranscribeStatus(event.sender, jobId, {
        state: 'queued', phase: 'queued', queuePosition: position, queueTotal: total,
      }, delivery);
    },
    run: () => performAutoTune(event.sender, filePath, jobId, tuneId, opts),
  }).finally(() => { batchRunKinds.delete(runKey); });
});

// プレビュー WAV を生成し、再生用のパスを返す。
// 元音声は全体を確認できるよう無制限、処理負荷の高いノイズ除去後は先頭10秒に留める。
const DENOISED_PREVIEW_SECONDS = 10;
ipcMain.handle('preview:generate', async (event, filePath, reqId, denoiseStrength) => {
  await ensurePool();
  fs.mkdirSync(previewDir, { recursive: true });
  const outPath = path.join(previewDir, `preview-${reqId}-${Date.now()}.wav`);
  const strength = Number(denoiseStrength) || 0;
  return rpc(pool[0], 'preview', {
    filePath,
    outPath,
    denoiseStrength: strength,
    maxSeconds: strength > 0 ? DENOISED_PREVIEW_SECONDS : 0,
  });
});

// ---- ライセンス / バージョン情報（About 画面） ----
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  name: 'モコシ',
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// licenses/ 配下のライセンス全文を返す（id はホワイトリストで検証しパストラバーサルを防ぐ）
const LICENSE_FILES = {
  'apache-2.0': 'apache-2.0.txt',
  'lgpl-3.0': 'lgpl-3.0.txt',
  'gpl-3.0': 'gpl-3.0.txt',
  'mit': 'mit.txt',
  'notice': 'NOTICE.txt',
};
ipcMain.handle('license:read', (event, id) => {
  const file = LICENSE_FILES[id];
  if (!file) throw new Error(`unknown license id: ${id}`);
  return fs.readFileSync(path.join(__dirname, '..', '..', 'licenses', file), 'utf8');
});

// Chromium/Electron の完全なライセンス一覧（パッケージ時に exe と同階層に同梱される）
ipcMain.handle('license:openChromium', async () => {
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), 'LICENSES.chromium.html'),
    path.join(process.resourcesPath || '', '..', 'LICENSES.chromium.html'),
  ];
  const found = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!found) throw new Error('LICENSES.chromium.html が見つかりません（開発実行中は未同梱です）。');
  const err = await shell.openPath(found);
  if (err) throw new Error(err);
  return { ok: true };
});

// 外部リンク（配布元・ソースコードのページ）を既定ブラウザで開く
ipcMain.handle('shell:openExternal', (event, url) => {
  if (!/^https:\/\//i.test(String(url))) throw new Error('invalid url');
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('export:save', async (event, { result, format }) => {
  const exp = exporters.EXPORTERS[format];
  if (!exp) throw new Error(`unknown format: ${format}`);
  const base = (result.name || 'transcript').replace(/\.[^.]+$/, '');
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${base}.${exp.ext}`,
    filters: [{ name: format.toUpperCase(), extensions: [exp.ext] }],
  });
  if (res.canceled) return { saved: false };
  fs.writeFileSync(res.filePath, exp.build(result), 'utf8');
  return { saved: true, path: res.filePath };
});

// ==== メンテナンス（データ初期化 / 完全アンインストール） ====

// ディレクトリ配下の総バイト数（存在しなければ 0）。
function dirSize(p) {
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return 0; }
  let total = 0;
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else { try { total += fs.statSync(full).size; } catch (_) { /* ignore */ } }
  }
  return total;
}

// アプリが生成した既知データ（モデル・辞書・設定）と一時ファイルを削除する。
// Chromium キャッシュ等は起動中ロックされるため触らない（完全削除は quit 後に行う）。
function removeKnownData() {
  const ud = app.getPath('userData');
  for (const rel of ['models', 'hotwords.txt', 'settings.json']) {
    try { fs.rmSync(path.join(ud, rel), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// NSIS が設置するアンインストーラ（"Uninstall <productName>.exe"）を探す。
// dev 実行（electron .）では見つからず null を返す。
function findWindowsUninstaller() {
  if (process.platform !== 'win32') return null;
  const dir = path.dirname(app.getPath('exe'));
  try {
    const entry = fs.readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
    if (entry) return path.join(dir, entry);
  } catch (_) { /* ignore */ }
  return null;
}

// アプリ終了後に userData 全体を消し、NSIS アンインストーラをサイレント起動する
// 使い捨て PowerShell を detached で起動する。実行中はロックされる Chromium
// キャッシュも、プロセス終了を待ってから消すことで確実に削除できる。
function scheduleWindowsUninstall() {
  const uninstaller = findWindowsUninstaller();
  const ud = app.getPath('userData').replace(/'/g, "''");
  const unin = uninstaller ? uninstaller.replace(/'/g, "''") : '';
  const script = [
    'Start-Sleep -Milliseconds 1500',
    `try { Remove-Item -LiteralPath '${ud}' -Recurse -Force -ErrorAction SilentlyContinue } catch {}`,
    unin ? `if (Test-Path -LiteralPath '${unin}') { Start-Process -FilePath '${unin}' -ArgumentList '/S' }` : '',
  ].join('\n');
  const scriptPath = path.join(os.tmpdir(), `reazonspeech-uninstall-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

// 削除対象の情報（サイズ・アンインストール可否）を返す。
ipcMain.handle('app:dataInfo', () => ({
  userDataPath: app.getPath('userData'),
  bytes: dirSize(app.getPath('userData')) + dirSize(previewDir),
  hasModels: modelManager.isComplete(userDataModelsDir()),
  canUninstall: !!findWindowsUninstaller(),
}));

// データ初期化：モデル・設定・辞書・一時ファイルを削除（アプリ本体は残す）。
ipcMain.handle('app:wipeData', async () => {
  destroyPool(); // モデル .onnx のロックを解放
  destroySeparatorWorker();
  destroyRtWorker();
  await new Promise((r) => setTimeout(r, 250)); // ワーカー終了とロック解放を待つ
  removeKnownData();
  return { ok: true };
});

// 完全アンインストール：既知データを消し、quit 後に残りと本体を除去して終了する。
ipcMain.handle('app:uninstall', async () => {
  destroyPool();
  destroySeparatorWorker();
  destroyRtWorker();
  await new Promise((r) => setTimeout(r, 250));
  removeKnownData();
  if (process.platform === 'win32') scheduleWindowsUninstall();
  // 直前に二段階の削除確認を終えているため、通常の未保存確認は重ねない。
  allowCloseOnce = true;
  setTimeout(() => app.quit(), 200);
  return { ok: true, platform: process.platform };
});

// ==== 自動アップデート（electron-updater + GitHub Releases） ====
// ハイブリッド運用: 起動時に静かにチェックし、見つかったらUIで通知。
// ダウンロードと再起動はユーザーが選ぶ（autoDownload=false）。
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true; // 未インストールの更新は終了時に自動適用

// renderer が生きていれば更新イベントを転送する。
function sendUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

autoUpdater.on('checking-for-update', () => sendUpdate('update:status', { state: 'checking' }));
autoUpdater.on('update-available', (info) =>
  sendUpdate('update:status', { state: 'available', version: info.version }));
autoUpdater.on('update-not-available', (info) =>
  sendUpdate('update:status', { state: 'none', version: info.version }));
autoUpdater.on('download-progress', (p) =>
  sendUpdate('update:progress', { percent: p.percent, transferred: p.transferred, total: p.total }));
autoUpdater.on('update-downloaded', (info) =>
  sendUpdate('update:status', { state: 'downloaded', version: info.version }));
autoUpdater.on('error', (err) =>
  sendUpdate('update:status', { state: 'error', message: String((err && err.message) || err) }));

// パッケージ済みでのみ動作（dev/zip では app-update.yml が無く例外になる）。
const updaterEnabled = () => app.isPackaged;

ipcMain.handle('update:check', async () => {
  if (!updaterEnabled()) return { ok: false, reason: 'disabled' };
  const r = await autoUpdater.checkForUpdates();
  return { ok: true, version: r && r.updateInfo ? r.updateInfo.version : null };
});

ipcMain.handle('update:download', async () => {
  if (!updaterEnabled()) return { ok: false, reason: 'disabled' };
  await autoUpdater.downloadUpdate();
  return { ok: true };
});

ipcMain.handle('update:install', async () => {
  if (!updaterEnabled()) return { ok: false, reason: 'disabled' };
  if (!(await confirmAppCloseIfNeeded())) return { ok: false, cancelled: true };
  allowCloseOnce = true;
  destroyPool(); // ワーカーを止めてからインストーラへ
  destroySeparatorWorker();
  destroyRtWorker();
  // isSilent=false（インストーラUIを表示）, isForceRunAfter=true（更新後に再起動）
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

// 起動時の静かなチェック（結果は update:status で renderer に届く）。
function checkForUpdatesOnStartup() {
  if (!updaterEnabled()) return;
  autoUpdater.checkForUpdates().catch((e) => {
    sendUpdate('update:status', { state: 'error', message: String((e && e.message) || e) });
  });
}

function createWindow() {
  allowCloseOnce = false;
  quitRequested = false;
  latestUnsavedState = unsavedState.normalizeState({});
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    title: 'モコシ',
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined, // Win/Linux 用（macは無視される）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (allowCloseOnce || !unsavedState.shouldConfirm(latestUnsavedState, appPreferences())) return;
    event.preventDefault();
    if (closeDialogOpen) return;
    confirmAppCloseIfNeeded().then((approved) => {
      if (!approved || !mainWindow || mainWindow.isDestroyed()) {
        quitRequested = false;
        return;
      }
      allowCloseOnce = true;
      if (quitRequested) app.quit();
      else mainWindow.close();
    }).catch((error) => {
      quitRequested = false;
      console.error('終了確認を表示できませんでした:', error);
    });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  // リロード等で renderer が消えると音声チャンクの供給元が失われるため、
  // 取り残されたリアルタイムセッションは読み込みのたびに破棄する（初回は no-op）。
  mainWindow.webContents.on('did-finish-load', () => destroyRtWorker());
}

app.whenReady().then(() => {
  // macOS の dev 起動時、Dock アイコンを差し替え（パッケージ後は .app 内 icns が使われる）
  if (process.platform === 'darwin' && app.dock && fs.existsSync(appIconPath)) {
    try { app.dock.setIcon(appIconPath); } catch (_) { /* ignore */ }
  }
  registerMediaProtocol(protocol);
  createWindow();
  // 起動直後に静かに更新チェック（UIが受け取れるよう少し遅らせる）
  mainWindow.webContents.once('did-finish-load', () => setTimeout(checkForUpdatesOnStartup, 1500));
});
app.on('before-quit', (event) => {
  if (allowCloseOnce || !mainWindow || mainWindow.isDestroyed()
    || !unsavedState.shouldConfirm(latestUnsavedState, appPreferences())) return;
  event.preventDefault();
  quitRequested = true;
  mainWindow.close();
});
// ウィンドウの終了確認がキャンセルされた場合に認識器を先に破棄しないよう、
// 実際の終了が確定してから後始末する。
app.on('will-quit', () => {
  destroyPool();
  destroySeparatorWorker();
  destroyRtWorker();
  // 一時ファイルを掃除
  try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
