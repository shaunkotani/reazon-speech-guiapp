const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 絶対パス -> <audio> で再生できる app-media URL
function mediaUrl(absPath) {
  // パス区切りはそのまま、各セグメントだけエンコード
  const enc = absPath.split('/').map(encodeURIComponent).join('/');
  return 'app-media://media' + (enc.startsWith('/') ? enc : '/' + enc);
}

contextBridge.exposeInMainWorld('api', {
  // モデル
  modelStatus: () => ipcRenderer.invoke('model:status'),
  downloadModel: () => ipcRenderer.invoke('model:download'),
  onModelProgress: (cb) => ipcRenderer.on('model:progress', (_e, p) => cb(p)),

  // 認識設定（辞書＋高精度モード） -> { text, score, enabled, highAccuracy } / 保存 -> { ok, count }
  getHotwords: () => ipcRenderer.invoke('hotwords:get'),
  setHotwords: (payload) => ipcRenderer.invoke('hotwords:set', payload),
  // 高精度モード（beam search）ON/OFF -> { ok, highAccuracy }
  setHighAccuracy: (on) => ipcRenderer.invoke('accuracy:set', on),
  // ユーザー定義の区切り設定プリセット
  getVadPresets: () => ipcRenderer.invoke('vad-presets:get'),
  saveVadPreset: (preset) => ipcRenderer.invoke('vad-presets:save', preset),
  deleteVadPreset: (id) => ipcRenderer.invoke('vad-presets:delete', id),

  // ファイル選択（ダイアログ / ドロップ）
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  // Electron 32+ は File.path が無いため webUtils でパス解決する
  pathForFile: (file) => webUtils.getPathForFile(file),
  mediaUrl,

  // 文字起こし（opts: { denoiseStrength:0..1, diarize:bool, numSpeakers:int,
  //   vad:{ preset, threshold, minSilenceDuration, minSpeechDuration, maxSpeechDuration,
  //         overlapAware, overlapSpeakers } }）
  transcribe: (filePath, jobId, opts) =>
    ipcRenderer.invoke('transcribe:file', filePath, jobId, opts),
  cancelTranscribe: (jobId) => ipcRenderer.invoke('transcribe:cancel', jobId),
  onTranscribeProgress: (cb) => ipcRenderer.on('transcribe:progress', (_e, p) => cb(p)),
  // 話者タグ付け用に全区間の声紋を遅延計算 -> { ok, count }
  computeEmbeddings: (jobId, filePath, denoiseStrength, segments) =>
    ipcRenderer.invoke('embeddings:compute', jobId, filePath, denoiseStrength, segments),
  onEmbedProgress: (cb) => ipcRenderer.on('embed:progress', (_e, p) => cb(p)),
  // 区間の音声クリップ生成（試聴） -> { wavPath }
  clipSegment: (filePath, start, end) => ipcRenderer.invoke('clip:segment', filePath, start, end),
  // メディアファイルの中身を丸ごと取得（結果プレイヤーの Blob 化用） -> { data, type }
  readMedia: (filePath) => ipcRenderer.invoke('media:read', filePath),
  // 手本（references: { 話者ID: [区間index,...] }）で再識別 -> { labels, speakerCount }
  reassignSpeakers: (jobId, references) => ipcRenderer.invoke('diarize:reassign', jobId, references),

  // プレビュー WAV 生成（先頭10秒、strength=0 なら原音そのまま） -> { wavPath, duration }
  preview: (filePath, reqId, denoiseStrength) =>
    ipcRenderer.invoke('preview:generate', filePath, reqId, denoiseStrength),

  // エクスポート
  saveExport: (result, format) => ipcRenderer.invoke('export:save', { result, format }),

  // アップデート（electron-updater）
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, p) => cb(p)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),

  // メンテナンス（データ初期化 / 完全アンインストール）
  dataInfo: () => ipcRenderer.invoke('app:dataInfo'),
  wipeData: () => ipcRenderer.invoke('app:wipeData'),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),

  // ライセンス / バージョン情報（About 画面）
  appInfo: () => ipcRenderer.invoke('app:info'),
  readLicense: (id) => ipcRenderer.invoke('license:read', id),
  openChromiumLicenses: () => ipcRenderer.invoke('license:openChromium'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
