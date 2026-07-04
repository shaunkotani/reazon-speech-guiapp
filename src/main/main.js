const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork, spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');

const { autoUpdater } = require('electron-updater');
const modelManager = require('./modelManager');
const exporters = require('../shared/export');
const { assignByReferences, UNKNOWN_THRESHOLD } = require('../shared/cluster');

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

function spawnWorker(initArgs) {
  const proc = fork(path.join(__dirname, 'asrWorker.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    // 埋め込みはプレーン配列で渡すため通常シリアライズで十分（外部バッファ回避）
  });
  const w = { proc, rpcs: new Map(), readyResolve: null, readyReject: null };
  w.ready = new Promise((res, rej) => { w.readyResolve = res; w.readyReject = rej; });
  proc.on('message', (msg) => {
    if (msg.type === 'ready') { w.readyResolve(); return; }
    if (msg.type === 'initError') { w.readyReject(new Error(msg.message)); return; }
    const r = w.rpcs.get(msg.rid);
    if (!r) return;
    if (msg.type === 'event') { if (r.onEvent) r.onEvent(msg.payload); return; }
    if (msg.type === 'response') {
      w.rpcs.delete(msg.rid);
      if (msg.error) r.reject(new Error(msg.error)); else r.resolve(msg.result);
    }
  });
  proc.on('exit', () => {
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
  const { modelDir, vadPath, denoiserPath, embPath } = modelManager.pathsFor(baseDir);
  const rs = currentRecognizerSettings();
  pool = Array.from({ length: POOL_SIZE }, () =>
    spawnWorker({ modelDir, vadPath, denoiserPath, embPath,
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
  return { ok: true, count: words.length };
});
// 高精度モード（beam search）の ON/OFF。辞書とは独立。即時保存してプールを作り直す。
ipcMain.handle('accuracy:set', (event, highAccuracy) => {
  const s = readSettings();
  s.highAccuracy = !!highAccuracy;
  writeSettings(s);
  destroyPool();
  return { ok: true, highAccuracy: s.highAccuracy };
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

ipcMain.handle('transcribe:cancel', (event, jobId) => {
  cancelled.add(jobId);
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

// 区間の音声クリップを生成して再生用パスを返す（試聴）
ipcMain.handle('clip:segment', async (event, filePath, start, end) => {
  await ensurePool();
  fs.mkdirSync(previewDir, { recursive: true });
  const outPath = path.join(previewDir, `clip-${Date.now()}-${Math.round(start * 1000)}.wav`);
  return rpc(pool[0], 'clip', { filePath, start, end, outPath });
});

ipcMain.handle('transcribe:file', async (event, filePath, jobId, opts = {}) => {
  await ensurePool();
  fs.mkdirSync(previewDir, { recursive: true });
  const pcmPath = path.join(previewDir, `work-${jobId}-${Date.now()}.pcm`);
  const sendProgress = (ratio) => mainWindow && mainWindow.webContents.send('transcribe:progress', { jobId, ratio });

  try {
    // Stage A: 1 ワーカーでデコード+ノイズ除去+VAD → 共有 PCM と区間境界
    sendProgress(0.02);
    const prep = await rpc(pool[0], 'prepare', { filePath, denoiseStrength: opts.denoiseStrength || 0, outPath: pcmPath });
    checkCancel(jobId);
    const segs = prep.segments;
    const total = segs.length;
    if (total === 0) {
      return { segments: [], text: '', duration: prep.duration, filePath, name: path.basename(filePath), jobId };
    }

    // Stage B: 区間をプールにラウンドロビン分配し、ASR を並列実行（埋め込みは後付け）
    const batches = Array.from({ length: pool.length }, () => []);
    segs.forEach((s, idx) => batches[idx % pool.length].push({ idx, start: s.start, end: s.end }));
    let done = 0;
    const partial = new Array(total);
    await Promise.all(batches.map((items, w) => {
      if (!items.length) return null;
      return rpc(pool[w], 'processBatch', { pcmPath, items, wantEmbedding: false }, (ev) => {
        if (ev.kind === 'seg') { done += ev.n; sendProgress(0.05 + 0.9 * (done / total)); }
      }).then((res) => {
        for (const r of res) partial[r.idx] = { start: segs[r.idx].start, end: segs[r.idx].end, text: r.text };
      });
    }));
    checkCancel(jobId);

    const ordered = partial.filter((x) => x && x.text);
    sendProgress(1);
    return {
      segments: ordered,
      text: ordered.map((s) => s.text).join('\n'),
      duration: prep.duration,
      filePath, name: path.basename(filePath), jobId,
    };
  } finally {
    cancelled.delete(jobId);
    fs.rm(pcmPath, { force: true }, () => {});
  }
});

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
  await new Promise((r) => setTimeout(r, 250)); // ワーカー終了とロック解放を待つ
  removeKnownData();
  return { ok: true };
});

// 完全アンインストール：既知データを消し、quit 後に残りと本体を除去して終了する。
ipcMain.handle('app:uninstall', async () => {
  destroyPool();
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
}

app.whenReady().then(() => {
  // macOS の dev 起動時、Dock アイコンを差し替え（パッケージ後は .app 内 icns が使われる）
  if (process.platform === 'darwin' && app.dock && fs.existsSync(appIconPath)) {
    try { app.dock.setIcon(appIconPath); } catch (_) { /* ignore */ }
  }
  // app-media://media/<絶対パス> をローカルファイルとして配信（範囲リクエスト対応で seek 可能）
  protocol.handle('app-media', (request) => {
    const u = new URL(request.url);
    const filePath = decodeURIComponent(u.pathname);
    return net.fetch('file://' + filePath, { headers: request.headers });
  });
  createWindow();
  // 起動直後に静かに更新チェック（UIが受け取れるよう少し遅らせる）
  mainWindow.webContents.once('did-finish-load', () => setTimeout(checkForUpdatesOnStartup, 1500));
});
app.on('before-quit', () => {
  destroyPool();
  // 一時ファイルを掃除
  try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
