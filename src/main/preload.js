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
  onTranscribeStatus: (cb) => ipcRenderer.on('transcribe:status', (_e, p) => cb(p)),
  onTranscribeProgress: (cb) => ipcRenderer.on('transcribe:progress', (_e, p) => cb(p)),
  // 設定確認用の短区間文字起こし。本結果とは別に扱い、同じ認識パイプラインを使う。
  transcribeTrial: (filePath, jobId, trialId, opts) =>
    ipcRenderer.invoke('transcribe:trial', filePath, jobId, trialId, opts),
  cancelTranscribeTrial: (jobId, trialId) =>
    ipcRenderer.invoke('transcribe:trial-cancel', jobId, trialId),
  onTranscribeTrialStatus: (cb) =>
    ipcRenderer.on('transcribe:trial-status', (_e, p) => cb(p)),
  // 話者タグ付け用に全区間の声紋を遅延計算 -> { ok, count }
  computeEmbeddings: (jobId, filePath, denoiseStrength, segments) =>
    ipcRenderer.invoke('embeddings:compute', jobId, filePath, denoiseStrength, segments),
  onEmbedProgress: (cb) => ipcRenderer.on('embed:progress', (_e, p) => cb(p)),
  // 区間の音声クリップ生成（試聴） -> { wavPath }
  clipSegment: (filePath, start, end) => ipcRenderer.invoke('clip:segment', filePath, start, end),
  // 仕上がりテストで指定した範囲の音声クリップ生成 -> { wavPath }
  previewRange: (filePath, start, end) => ipcRenderer.invoke('clip:segment', filePath, start, end),
  // メディアファイルの中身を丸ごと取得（結果プレイヤーの Blob 化用） -> { data, type }
  readMedia: (filePath) => ipcRenderer.invoke('media:read', filePath),
  // 手本（references: { 話者ID: [区間index,...] }）で再識別 -> { labels, speakerCount }
  reassignSpeakers: (jobId, references) => ipcRenderer.invoke('diarize:reassign', jobId, references),

  // プレビュー WAV 生成（元音声は全体、ノイズ除去後は先頭10秒） -> { wavPath, duration }
  preview: (filePath, reqId, denoiseStrength) =>
    ipcRenderer.invoke('preview:generate', filePath, reqId, denoiseStrength),

  // リアルタイム文字起こし（マイク）
  // モード進入時の事前準備（専用ワーカー起動+モデル読込）。録音開始を即時にする -> { ok }
  rtPrepare: () => ipcRenderer.invoke('rt:prepare'),
  // モード離脱時にワーカーを解放する（録音中は no-op） -> { ok }
  rtRelease: () => ipcRenderer.invoke('rt:release'),
  // 開始（opts: { vad }）。準備済みワーカーがあれば即開始する -> { ok }
  rtStart: (opts) => ipcRenderer.invoke('rt:start', opts),
  // 16kHz mono Float32Array チャンクを送る（高頻度・応答なし）
  rtFeed: (chunk) => ipcRenderer.send('rt:feed', chunk),
  // 停止 -> { segments, duration, wavPath, name }（wavPath は一時領域の録音 WAV）
  rtStop: () => ipcRenderer.invoke('rt:stop'),
  // 破棄（結果を作らずに中止）
  rtCancel: () => ipcRenderer.invoke('rt:cancel'),
  // 確定区間イベント { kind:'seg', start, end, text } / { kind:'segError', message }
  onRtSegment: (cb) => ipcRenderer.on('rt:segment', (_e, p) => cb(p)),
  // セッション異常終了（設定変更・ワーカー落ち）
  onRtError: (cb) => ipcRenderer.on('rt:error', (_e, p) => cb(p)),
  // 一時領域の録音 WAV を任意の場所へ保存 -> { saved, path }
  rtSaveWav: (wavPath, suggestedName) => ipcRenderer.invoke('rt:saveWav', wavPath, suggestedName),

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
