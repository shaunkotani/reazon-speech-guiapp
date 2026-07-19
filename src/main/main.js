const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { fork, spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Notification } = require('electron');

const { autoUpdater } = require('electron-updater');
const modelManager = require('./modelManager');
const exporters = require('../shared/export');
const { assignByReferences, UNKNOWN_THRESHOLD } = require('../shared/cluster');
const overlapTools = require('../shared/overlap');
const transcriptionProgress = require('../shared/transcriptionProgress');
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
const previewDir = path.join(os.tmpdir(), 'reazonspeech-preview');
const cancelled = new Set(); // 中止された jobId
const jobEmbeddings = new Map(); // jobId -> number[][]（区間順、手本ベース再識別用）

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

// ==== ワーカープール（CPU コア数に応じて並列） ====
const POOL_SIZE = Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));
let pool = null;        // [{ proc, rpcs:Map }]
let poolReady = null;   // 全 init 完了の Promise
let ridSeq = 0;

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

const batchQueue = new SerialJobQueue({
  onChange: ({ activeId, size }) => {
    activeBatchJobs = size;
    if (size === 0) setWindowProgress(-1);
    else if (activeId == null) setWindowProgress(2, { mode: 'indeterminate' });
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

function deliverTranscribeStatus(sender, jobId, payload) {
  const status = { jobId, at: Date.now(), ...payload };
  if (sender && !sender.isDestroyed()) sender.send('transcribe:status', status);
  if (batchQueue.activeId === jobId) updateTaskbarProgress(status);
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
    await rpc(pool[0], 'decodePcm', { filePath, denoiseStrength: denoiseStrength || 0, outPath: pcmPath });
    const total = segments.length;
    const batches = Array.from({ length: pool.length }, () => []);
    segments.forEach((s, idx) => batches[idx % pool.length].push({ idx, start: s.start, end: s.end }));
    let done = 0;
    const embs = new Array(total);
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

async function performTranscription(sender, filePath, jobId, opts = {}) {
  const pcmPath = path.join(previewDir, `work-${jobId}-${Date.now()}.pcm`);
  let currentPhase = 'preparing';
  const sendStatus = (payload = {}) => {
    if (payload.phase) currentPhase = payload.phase;
    deliverTranscribeStatus(sender, jobId, {
      state: 'running', phase: currentPhase, ...payload,
    });
  };
  // 旧進捗イベントは互換用に残す。新しい画面は transcribe:status を使う。
  const sendProgress = (ratio) => {
    if (!sender.isDestroyed()) sender.send('transcribe:progress', { jobId, ratio });
  };

  try {
    sendStatus({ phase: 'preparing' });
    // リアルタイム実行中は CPU を取り合うため排他にする（rt:start 側も逆向きに確認する）。
    // 準備済みのアイドルワーカーは対象外（録音セッション中だけ弾く）。
    if (rtSessionActive) {
      throw new Error('リアルタイム文字起こしの実行中は開始できません。先に録音を停止してください。');
    }
    checkCancel(jobId);
    await ensurePool();
    checkCancel(jobId);
    fs.mkdirSync(previewDir, { recursive: true });
    // Stage A: 1 ワーカーでデコード+重なり検出+ノイズ除去+VAD → 共有 PCM と区間境界
    sendProgress(0.02);
    const vadOpts = opts.vad || {};
    const overlapOpts = {
      enabled: vadOpts.overlapAware === true,
      numSpeakers: Number.isInteger(vadOpts.overlapSpeakers)
        ? Math.min(4, Math.max(2, vadOpts.overlapSpeakers)) : 2,
    };
    const prep = await rpc(pool[0], 'prepare', {
      filePath, denoiseStrength: opts.denoiseStrength || 0, outPath: pcmPath,
      vad: vadOpts, // 発話検出の設定（未指定なら core の標準値）
      overlap: overlapOpts,
    }, (ev) => {
      if (ev.kind === 'phase') {
        sendStatus({ phase: ev.phase, totalAudioSec: ev.totalAudioSec || 0 });
      }
    });
    checkCancel(jobId);
    const maxDuration = (typeof vadOpts.maxSpeechDuration === 'number' && isFinite(vadOpts.maxSpeechDuration))
      ? Math.min(30, Math.max(2, vadOpts.maxSpeechDuration)) : 6;
    const recognitionPlan = overlapTools.buildRecognitionItems(
      prep.segments,
      prep.speakerSegments || [],
      { enabled: overlapOpts.enabled, maxDuration },
    );
    const segs = recognitionPlan.items;
    const total = segs.length;
    const totalWorkSec = segs.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    if (prep.overlapError) {
      sendStatus({
        state: 'warning', phase: 'overlap',
        warning: '重なり音声の解析を省略し、通常の文字起こしを続けています。',
        warningDetail: prep.overlapError,
        totalAudioSec: prep.duration,
      });
    }
    if (total === 0) {
      sendStatus({ phase: 'finalizing', totalAudioSec: prep.duration });
      sendStatus({ state: 'completed', phase: 'finalizing', ratio: 1, totalAudioSec: prep.duration });
      sendProgress(1);
      return { segments: [], text: '', duration: prep.duration, filePath, name: path.basename(filePath), jobId };
    }

    // Stage B: 区間をプールにラウンドロビン分配し、ASR を並列実行（埋め込みは後付け）
    const batches = Array.from({ length: pool.length }, () => []);
    segs.forEach((s, idx) => batches[idx % pool.length].push({ idx, start: s.start, end: s.end }));
    let done = 0;
    let completedWorkSec = 0;
    const partial = new Array(total);
    sendStatus({
      phase: 'recognizing', completed: 0, total,
      completedWorkSec: 0, totalWorkSec, totalAudioSec: prep.duration, ratio: 0,
    });
    await Promise.all(batches.map((items, w) => {
      if (!items.length) return null;
      return rpc(pool[w], 'processBatch', { pcmPath, items, wantEmbedding: false }, (ev) => {
        if (ev.kind === 'seg') {
          done += ev.n;
          completedWorkSec += Math.max(0, Number(ev.workSec) || 0);
          const ratio = totalWorkSec > 0 ? Math.min(1, completedWorkSec / totalWorkSec) : done / total;
          const item = segs[ev.idx];
          if (item) partial[ev.idx] = { ...item, text: ev.text || '' };
          const partialUpdate = item && item.kind === 'base' && String(ev.text || '').trim()
            ? { index: ev.idx, start: item.start, end: item.end, text: String(ev.text).trim() }
            : null;
          sendStatus({
            phase: 'recognizing', completed: done, total,
            completedWorkSec, totalWorkSec, totalAudioSec: prep.duration, ratio,
            partial: partialUpdate,
          });
          sendProgress(0.05 + 0.9 * ratio);
        }
      }).then((res) => {
        for (const r of res) partial[r.idx] = { ...segs[r.idx], text: r.text };
      });
    }));
    checkCancel(jobId);

    sendStatus({
      phase: 'finalizing', completed: total, total,
      completedWorkSec: totalWorkSec, totalWorkSec, totalAudioSec: prep.duration,
    });
    const finalized = overlapTools.finalizeRecognition(partial.filter(Boolean));
    const ordered = finalized.segments;
    sendProgress(1);
    sendStatus({ state: 'completed', phase: 'finalizing', ratio: 1, totalAudioSec: prep.duration });
    return {
      segments: ordered,
      text: ordered.map((s) => s.text).join('\n'),
      duration: prep.duration,
      overlap: {
        enabled: overlapOpts.enabled,
        detected: recognitionPlan.overlapIntervals.length,
        recovered: finalized.recoveredGroups,
        error: prep.overlapError || '',
      },
      filePath, name: path.basename(filePath), jobId,
    };
  } catch (e) {
    const wasCancelled = cancelled.has(jobId) || /中止|cancel/i.test(String((e && e.message) || e));
    const error = transcriptionProgress.describeError(e, currentPhase, wasCancelled);
    sendStatus({ state: wasCancelled ? 'cancelled' : 'error', error });
    throw e;
  } finally {
    cancelled.delete(jobId);
    fs.rm(pcmPath, { force: true }, () => {});
  }
}

ipcMain.handle('transcribe:file', (event, filePath, jobId, opts = {}) =>
  batchQueue.enqueue({
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
  }));

// プレビュー WAV を生成し、再生用のパスを返す（先頭 PREVIEW_SECONDS 秒、必要ならノイズ除去）
const PREVIEW_SECONDS = 10;
ipcMain.handle('preview:generate', async (event, filePath, reqId, denoiseStrength) => {
  await ensurePool();
  fs.mkdirSync(previewDir, { recursive: true });
  const outPath = path.join(previewDir, `preview-${reqId}-${Date.now()}.wav`);
  return rpc(pool[0], 'preview', { filePath, outPath, denoiseStrength: denoiseStrength || 0, maxSeconds: PREVIEW_SECONDS });
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
  destroyRtWorker();
  await new Promise((r) => setTimeout(r, 250)); // ワーカー終了とロック解放を待つ
  removeKnownData();
  return { ok: true };
});

// 完全アンインストール：既知データを消し、quit 後に残りと本体を除去して終了する。
ipcMain.handle('app:uninstall', async () => {
  destroyPool();
  destroyRtWorker();
  await new Promise((r) => setTimeout(r, 250));
  removeKnownData();
  if (process.platform === 'win32') scheduleWindowsUninstall();
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

ipcMain.handle('update:install', () => {
  if (!updaterEnabled()) return { ok: false, reason: 'disabled' };
  destroyPool(); // ワーカーを止めてからインストーラへ
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
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
app.on('before-quit', () => {
  destroyPool();
  destroyRtWorker();
  // 一時ファイルを掃除
  try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
