// レンダラ: モデル確認、ファイル投入、プレビュー＋ノイズ除去設定、文字起こし、結果表示・エクスポート。
const $ = (sel) => document.querySelector(sel);

const banner = $('#model-banner');
const downloadBtn = $('#download-btn');
const modelProgress = $('#model-progress');
const modelProgressText = $('#model-progress-text');
const dropzone = $('#dropzone');
const pickBtn = $('#pick-btn');
const jobsEl = $('#jobs');
const jobTpl = $('#job-template');
const transcriptionProgress = window.TranscriptionProgress;
const unsavedState = window.UnsavedState;
const autoTuneTools = window.AutoTune;
const correctionTools = window.TranscriptCorrections;

let modelReady = false;
let jobSeq = 0;
let previewSeq = 0; // プレビュー生成リクエストの一意ID
let trialSeq = 0;   // 短区間テストの一意ID
let autoTuneSeq = 0; // 文字起こし修正による自動調整の一意ID
let correctionSeq = 0; // 確定した修正範囲の一意ID
let autoReferenceRowSeq = 0; // タイムライン発話の一意ID
let recognizerConfigLoaded = false;
let realtimeRecordingActive = false;
let lastUnsavedStateJson = '';
let savedRecognizerConfig = {
  highAccuracy: false, hotwordsText: '', hotwordsScore: 2, hotwordsEnabled: true,
};
const jobs = new Map(); // jobId -> { el, filePath, result }

function normalizedDictionaryConfig() {
  return {
    hotwordsText: document.querySelector('#hotwords-text')
      ? $('#hotwords-text').value.split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
      : '',
    hotwordsScore: document.querySelector('#hotwords-score') ? Number($('#hotwords-score').value) : 2,
    hotwordsEnabled: document.querySelector('#hotwords-enabled')
      ? $('#hotwords-enabled').checked
      : true,
  };
}

function dictionaryHasUnsavedChanges() {
  if (!recognizerConfigLoaded) return false;
  const current = normalizedDictionaryConfig();
  return current.hotwordsText !== savedRecognizerConfig.hotwordsText
    || current.hotwordsScore !== Number(savedRecognizerConfig.hotwordsScore)
    || current.hotwordsEnabled !== savedRecognizerConfig.hotwordsEnabled;
}

function collectUnsavedState() {
  let resultCount = 0;
  let recordingCount = 0;
  let presetDraftCount = 0;
  let activeJobCount = 0;
  jobs.forEach((job) => {
    const hasUnsavedResult = job.result && job.resultRevision !== job.savedResultRevision;
    const hasPendingCorrection = !job.result && Array.isArray(job.corrections) && job.corrections.length > 0;
    if (hasUnsavedResult || hasPendingCorrection) resultCount++;
    if (job.isRecording && !job.recordingSaved) recordingCount++;
    if (typeof job._hasUnsavedPreset === 'function' && job._hasUnsavedPreset()) presetDraftCount++;
    if (job.isTranscribing || job.activeTrialId || job.activeAutoTuneId
      || job.isEmbedding || job.isReassigning) activeJobCount++;
  });
  return unsavedState.normalizeState({
    resultCount,
    recordingCount,
    dictionaryChanged: dictionaryHasUnsavedChanges(),
    presetDraftCount,
    activeJobCount,
    recordingActive: realtimeRecordingActive,
  });
}

function reportUnsavedState() {
  if (!unsavedState || typeof window.api.updateUnsavedState !== 'function') return;
  const value = collectUnsavedState();
  const serialized = JSON.stringify(value);
  if (serialized === lastUnsavedStateJson) return;
  lastUnsavedStateJson = serialized;
  window.api.updateUnsavedState(value);
}

function markJobResultChanged(job) {
  if (!job || !job.result) return;
  job.resultRevision = (job.resultRevision || 0) + 1;
  reportUnsavedState();
}

function applyLockedCorrections(job, result) {
  if (!correctionTools || !job || !Array.isArray(job.corrections)) return result;
  return correctionTools.applyCorrections(result, job.corrections);
}

function appliedCorrectionIds(result) {
  return Array.isArray(result && result.appliedCorrectionIds) ? result.appliedCorrectionIds : [];
}

function syncTrialCorrectionUi(job, result) {
  if (!job) return;
  const ids = appliedCorrectionIds(result);
  const note = job.el.querySelector('.trial-correction-note');
  const unlock = job.el.querySelector('.trial-unlock-btn');
  if (note) {
    note.textContent = ids.length
      ? '修正済み区間です。この文章は確定され、再び文字起こししても変更されません。'
      : '';
    note.classList.toggle('hidden', ids.length === 0);
  }
  if (unlock) unlock.classList.toggle('hidden', ids.length === 0);
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// 経過時間と進捗率から推定残り時間の表示文字列を作る（早すぎる/不安定な段階は空文字）
function etaText(startTime, ratio) {
  const elapsed = (Date.now() - startTime) / 1000;
  if (ratio < 0.08 || elapsed < 1.5) return ''; // 序盤は推定が暴れるので出さない
  if (ratio >= 1) return '';
  const remain = elapsed * (1 - ratio) / ratio;
  const sec = Math.max(1, Math.round(remain));
  if (sec < 60) return `残り 約${sec}秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `残り 約${m}分${String(s).padStart(2, '0')}秒`;
}

// ---- モデル状態 ----
async function refreshModelStatus() {
  const st = await window.api.modelStatus();
  modelReady = st.ready;
  banner.classList.toggle('hidden', st.ready);
}

window.api.onModelProgress((p) => {
  modelProgress.classList.remove('hidden');
  const ratio = (p.fileIndex + 0.5) / p.totalFiles;
  modelProgress.querySelector('.bar').style.width = `${Math.round(ratio * 100)}%`;
  modelProgressText.textContent = `取得中: ${p.file} (${p.fileIndex + 1}/${p.totalFiles})`;
});

downloadBtn.addEventListener('click', async () => {
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'ダウンロード中…';
  try {
    await window.api.downloadModel();
    modelProgress.querySelector('.bar').style.width = '100%';
    modelProgressText.textContent = '完了';
    await refreshModelStatus();
  } catch (e) {
    modelProgressText.textContent = `失敗: ${e.message}`;
    downloadBtn.disabled = false;
    downloadBtn.textContent = '再試行';
  }
});

// ---- 発話の区切り方（VAD）のプリセット ----
// 数値は src/core/asr.js の VAD_PRESETS と一致させること（レンダラからは require できない）。
// 実測の根拠は HANDOFF.md「発話区間の分割」を参照。
const VAD_PRESETS = {
  standard: {
    maxSpeechDuration: 6, minSilenceDuration: 0.2, minSpeechDuration: 0.15, threshold: 0.5,
    overlapAware: false, overlapSpeakers: 2,
    note: '精度と文のつながりのバランスを取った設定',
  },
  conversation: {
    maxSpeechDuration: 3, minSilenceDuration: 0.1, minSpeechDuration: 0.2, threshold: 0.7,
    overlapAware: true, overlapSpeakers: 2,
    note: '同時発話を再解析し、3秒単位で細かく認識する設定（処理時間は長め）',
  },
  interview: {
    maxSpeechDuration: 3, minSilenceDuration: 0.1, minSpeechDuration: 0.15, threshold: 0.2,
    overlapAware: true, overlapSpeakers: 2,
    note: '小さな声や短い応答を拾いながら、重なり音声を3秒単位で再解析する設定（処理時間は長め）',
  },
  lecture: {
    maxSpeechDuration: 8, minSilenceDuration: 0.35, minSpeechDuration: 0.15, threshold: 0.45,
    overlapAware: false, overlapSpeakers: 2,
    note: '一人の長めの発話を保ちつつ、認識区間は長くしすぎない設定',
  },
};

const SCENARIO_META = {
  interview: { label: 'インタビュー', summary: '短い回答や小さな声を拾いやすくします' },
  meeting: { label: '会議', summary: '複数人の交代や声の重なりを詳しく解析します' },
  phone: { label: '電話・通話', summary: '短い応答と声の重なりを細かく解析します' },
  lecture: { label: '講演・一人語り', summary: '長めの発話が細かく切れすぎないようにします' },
  normal: { label: '通常', summary: '音声の種類を問わずバランスよく認識します' },
};

// 保存済みプリセットは settings.json に置き、追加済みの全ジョブへ即時反映する。
let customVadPresets = [];
const vadPresetViews = new Set();
function setCustomVadPresets(values) {
  customVadPresets = Array.isArray(values) ? values : [];
  vadPresetViews.forEach((view) => view.render());
}
const vadPresetsReady = window.api.getVadPresets()
  .then(setCustomVadPresets)
  .catch(() => { customVadPresets = []; });

// ---- 認識設定（高精度モード・用語辞書） ----
const hwText = $('#hotwords-text');
const hwEnabled = $('#hotwords-enabled');
const hwScore = $('#hotwords-score');
const hwScoreVal = $('#hotwords-score-val');
const hwSave = $('#hotwords-save');
const hwStatus = $('#hotwords-status');
const hwSummary = $('#hotwords-summary');
const accToggle = $('#high-accuracy');
const accHint = $('#accuracy-hint');

let userHighAccuracy = false; // ユーザーが選んだ高精度モードの希望値
let savedDictActive = false;  // 保存済み辞書が有効か（有効なら beam を強制）

function hotwordsCount(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).length;
}
function updateHotwordsSummary() {
  const n = hotwordsCount(hwText.value);
  hwSummary.textContent = !hwEnabled.checked ? '（オフ）' : n ? `${n}語` : '（未登録）';
}
// チェックボックスは常に操作可能。ユーザー自身の希望値を表示し、辞書使用中は
// 「オフでも高精度で動く」旨の注記だけ添える（実際の beam は main 側で
// 「高精度モード ON または 辞書ON」の OR で決まる）。
function syncAccuracyUI() {
  accToggle.checked = userHighAccuracy;
  accHint.classList.toggle('hidden', !savedDictActive);
}

accToggle.addEventListener('change', async () => {
  userHighAccuracy = accToggle.checked;
  try {
    const result = await window.api.setHighAccuracy(userHighAccuracy);
    savedRecognizerConfig.highAccuracy = result.highAccuracy === true;
    markAllTrialResultsForSettingsChange();
  }
  catch (e) { alert(`高精度モードの保存に失敗: ${e.message}`); }
});

hwScore.addEventListener('input', () => {
  hwScoreVal.textContent = Number(hwScore.value).toFixed(1);
  reportUnsavedState();
});
hwText.addEventListener('input', () => { updateHotwordsSummary(); reportUnsavedState(); });
hwEnabled.addEventListener('change', () => { updateHotwordsSummary(); reportUnsavedState(); });

hwSave.addEventListener('click', async () => {
  hwSave.disabled = true;
  hwStatus.textContent = '保存中…';
  try {
    const res = await window.api.setHotwords({
      text: hwText.value,
      score: Number(hwScore.value),
      enabled: hwEnabled.checked,
    });
    hwStatus.textContent = `保存しました（${res.count}語）`;
    savedDictActive = hwEnabled.checked && res.count > 0;
    savedRecognizerConfig = {
      ...savedRecognizerConfig,
      hotwordsText: hwText.value.split('\n').map((line) => line.trim()).filter(Boolean).join('\n'),
      hotwordsScore: Number(hwScore.value),
      hotwordsEnabled: hwEnabled.checked,
    };
    markAllTrialResultsForSettingsChange();
    syncAccuracyUI();
    updateHotwordsSummary();
    reportUnsavedState();
    setTimeout(() => { hwStatus.textContent = ''; }, 2500);
  } catch (e) {
    hwStatus.textContent = `保存失敗: ${e.message}`;
  } finally {
    hwSave.disabled = false;
  }
});

(async () => {
  try {
    const hw = await window.api.getHotwords();
    hwText.value = hw.text || '';
    hwEnabled.checked = hw.enabled !== false;
    hwScore.value = String(hw.score);
    hwScoreVal.textContent = Number(hw.score).toFixed(1);
    userHighAccuracy = hw.highAccuracy === true;
    savedDictActive = hwEnabled.checked && hotwordsCount(hwText.value) > 0;
    savedRecognizerConfig = {
      highAccuracy: userHighAccuracy,
      hotwordsText: hwText.value.split('\n').map((line) => line.trim()).filter(Boolean).join('\n'),
      hotwordsScore: Number(hwScore.value),
      hotwordsEnabled: hwEnabled.checked,
    };
    recognizerConfigLoaded = true;
    syncAccuracyUI();
    updateHotwordsSummary();
    reportUnsavedState();
  } catch (_) { /* 起動直後は無視 */ }
})();

// 起動直後にも空の状態をMainへ渡し、前のウィンドウの状態を残さない。
reportUnsavedState();

// ---- ファイル投入 ----
async function handleFiles(paths) {
  if (!paths.length) return;
  if (!modelReady) {
    await refreshModelStatus();
    if (!modelReady) { alert('先にモデルをダウンロードしてください。'); return; }
  }
  for (const p of paths) addJob(p);
}

pickBtn.addEventListener('click', async () => {
  const paths = await window.api.openFiles();
  handleFiles(paths);
});

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const paths = Array.from(e.dataTransfer.files).map((f) => window.api.pathForFile(f));
  handleFiles(paths);
});

// ---- ジョブ（取込 → 設定/プレビュー → 文字起こし） ----
async function createAudioObjectUrl(filePath) {
  const { data, type } = await window.api.readMedia(filePath);
  return URL.createObjectURL(new Blob([data], { type }));
}

function replaceAudioObjectUrl(audio, job, key, objectUrl) {
  if (job[key]) URL.revokeObjectURL(job[key]);
  job[key] = objectUrl;
  audio.src = objectUrl;
  audio.load();
}

function clearAudioObjectUrl(audio, job, key) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (job[key]) {
    URL.revokeObjectURL(job[key]);
    job[key] = null;
  }
}

function parseTrialStart(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length >= 2 && parts[parts.length - 1] >= 60) return null;
  if (parts.length === 3 && parts[1] >= 60) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatTrialStart(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function trialSettingsFingerprint(opts) {
  const vad = opts && opts.vad ? opts.vad : {};
  return JSON.stringify({
    recognizer: savedRecognizerConfig,
    denoiseStrength: Number(opts && opts.denoiseStrength) || 0,
    vad: {
      scenario: String(vad.scenario || ''),
      maxSpeechDuration: Number(vad.maxSpeechDuration),
      minSilenceDuration: Number(vad.minSilenceDuration),
      minSpeechDuration: Number(vad.minSpeechDuration),
      threshold: Number(vad.threshold),
      overlapAware: vad.overlapAware === true,
      overlapSpeakers: Number(vad.overlapSpeakers),
    },
  });
}

function trialSettingsSummary(opts) {
  const denoise = { 0: 'なし', 0.5: '弱', 0.8: '中', 1: '強' }[Number(opts.denoiseStrength) || 0] || String(opts.denoiseStrength);
  const presetNames = { standard: '標準', conversation: '会話・電話', interview: 'インタビュー', lecture: '講演・朗読', custom: 'カスタム' };
  const vad = opts.vad || {};
  const scenario = vad.scenario === 'custom'
    ? `カスタム（${vad.scenarioName || '保存した設定'}）`
    : (SCENARIO_META[vad.scenario]
      ? SCENARIO_META[vad.scenario].label
      : (vad.scenarioName || presetNames[vad.preset] || vad.preset || '未選択'));
  const recognizer = [
    ...(savedRecognizerConfig.highAccuracy ? ['高精度'] : []),
    ...(savedDictActive ? ['用語辞書'] : []),
  ];
  return [
    `ノイズの低減 ${denoise}`,
    `シチュエーション ${scenario}`,
    `最大${Number(vad.maxSpeechDuration) || 6}秒`,
    vad.overlapAware ? `重なり再解析 ${Number(vad.overlapSpeakers) || 2}人` : '重なり再解析なし',
    recognizer.length ? recognizer.join('・') : '通常認識',
  ].join(' ・ ');
}

function refreshTrialFreshness(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (!job.lastTrial || typeof job._getTranscribeOpts !== 'function') {
    job.trialIsFresh = false;
    if (typeof job._refreshSetupFlow === 'function') job._refreshSetupFlow();
    return;
  }
  const stale = job.lastTrial.fingerprint !== trialSettingsFingerprint(job._getTranscribeOpts());
  const el = job.el;
  el.querySelector('.trial-stale').classList.toggle('hidden', !stale);
  el.querySelector('.trial-fresh').classList.toggle('hidden', stale);
  const useButton = el.querySelector('.trial-use-btn');
  if (useButton) {
    const closesOnly = useButton.classList.contains('is-secondary');
    useButton.disabled = stale && !closesOnly;
    useButton.title = stale && !closesOnly ? '設定が変わったため、もう一度テストしてください' : '';
  }
  const completeStartButton = el.querySelector('.trial-complete-start-btn');
  if (completeStartButton) {
    completeStartButton.disabled = stale;
    completeStartButton.title = stale ? '設定が変わったため、もう一度テストしてください' : '';
  }
  job.trialIsFresh = !stale;
  if (typeof job._refreshSetupFlow === 'function') job._refreshSetupFlow();
}

function markAllTrialResultsForSettingsChange() {
  for (const jobId of jobs.keys()) refreshTrialFreshness(jobId);
}

function applyTrialStatus(status) {
  const job = jobs.get(status.jobId);
  if (!job || String(job.activeTrialId) !== String(status.trialId)) return;
  const el = job.el;
  const progress = el.querySelector('.trial-progress');
  const label = progress.querySelector('.trial-progress-label');
  const count = progress.querySelector('.trial-progress-count');
  const bar = progress.querySelector('.bar');
  if (status.error) job.trialErrorInfo = status.error;
  if (status.warning) job.trialWarning = status.warning;
  if (status.state === 'cancelling') {
    label.textContent = '中止しています…';
    progress.querySelector('.trial-cancel').disabled = true;
    return;
  }
  if (['completed', 'cancelled', 'error'].includes(status.state)) return;
  if (status.state === 'queued') {
    label.textContent = `開始待ち（${status.queuePosition || 1}番目 / 全${status.queueTotal || 1}件）`;
    count.textContent = '';
  } else {
    label.textContent = transcriptionProgress.phaseMeta(status.phase).active;
    if (status.phase === 'recognizing' && Number(status.total) > 0) {
      count.textContent = `${Number(status.completed) || 0} / ${status.total}区間`;
    } else count.textContent = '';
  }
  const ratio = Number(status.ratio);
  if (status.phase === 'recognizing' && Number.isFinite(ratio)) {
    bar.classList.remove('is-indeterminate');
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  } else {
    bar.classList.add('is-indeterminate');
    bar.style.width = '';
  }
}

let trialSharedAudio = null;
let trialSharedStop = null;
async function playTrialSegment(job, segment, button) {
  if (trialSharedStop) trialSharedStop();
  if (!trialSharedAudio) trialSharedAudio = new Audio();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    trialSharedAudio.pause();
    button.textContent = '▶';
    button.classList.remove('is-playing');
    if (trialSharedStop === stop) trialSharedStop = null;
  };
  trialSharedStop = stop;
  try {
    if (!segment._trialClip) {
      button.textContent = '…';
      const clip = await window.api.clipSegment(job.filePath, segment.start, segment.end);
      segment._trialClip = window.api.mediaUrl(clip.wavPath);
    }
    trialSharedAudio.src = segment._trialClip;
    button.textContent = '■';
    button.classList.add('is-playing');
    trialSharedAudio.addEventListener('ended', stop, { once: true });
    await trialSharedAudio.play();
  } catch (e) {
    stop();
    console.error('trial clip play failed', e);
  }
}

function invalidateAutoTuneReference(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.el.querySelector('.auto-tune-result').classList.add('hidden');
  job.el.querySelector('.trial-result-actions').classList.add('hidden');
  job.el.querySelector('.trial-more-actions').classList.add('hidden');
}

function autoReferenceCharacterCount(job) {
  if (!job || !job.autoReference || !autoTuneTools) return 0;
  return Array.from(autoTuneTools.referenceText(job.autoReference.rows)).length;
}

function updateAutoReferenceCount(job) {
  const count = autoReferenceCharacterCount(job);
  const badge = job.el.querySelector('.auto-reference-count');
  badge.textContent = `確定 ${count} / ${autoTuneTools.MIN_REFERENCE_CHARS}文字以上`;
  badge.classList.toggle('is-short', count < autoTuneTools.MIN_REFERENCE_CHARS);
}

function renderAutoSpeakerNames(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.autoReference) return;
  const holder = job.el.querySelector('.auto-speaker-names');
  holder.replaceChildren();
  job.autoReference.speakers.forEach((speaker, index) => {
    const label = document.createElement('label');
    label.className = 'auto-speaker-name';
    label.append(document.createTextNode(`話者${index + 1}`));
    const input = document.createElement('input');
    input.maxLength = 40;
    input.value = speaker.name;
    input.setAttribute('aria-label', `話者${index + 1}の名前`);
    input.addEventListener('change', () => {
      speaker.name = input.value.trim() || `話者${index + 1}`;
      input.value = speaker.name;
      renderAutoReferenceRows(jobId);
    });
    label.appendChild(input);
    holder.appendChild(label);
  });
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'speaker-add-btn auto-add-speaker';
  addButton.textContent = '＋ 話者を追加';
  addButton.disabled = job.autoReference.speakers.length >= 4;
  addButton.title = addButton.disabled ? '自動調整で指定できる話者は4人までです' : '';
  addButton.addEventListener('click', () => addAutoReferenceSpeaker(jobId));
  holder.appendChild(addButton);
}

function addAutoReferenceSpeaker(jobId, assignRowIndex = null) {
  const job = jobs.get(jobId);
  if (!job || !job.autoReference) return null;
  if (job.autoReference.speakers.length >= 4) {
    job.el.querySelector('.auto-reference-error').textContent =
      '文字起こしの修正による自動調整は4話者までです。';
    return null;
  }
  const index = job.autoReference.speakers.length + 1;
  const speaker = { id: `speaker-${index}`, name: `話者${index}` };
  job.autoReference.speakers.push(speaker);
  if (Number.isInteger(assignRowIndex) && job.autoReference.rows[assignRowIndex]) {
    job.autoReference.rows[assignRowIndex].speaker = speaker.id;
  }
  job.el.querySelector('.auto-reference-error').textContent = '';
  renderAutoSpeakerNames(jobId);
  renderAutoReferenceRows(jobId);
  invalidateAutoTuneReference(jobId);
  requestAnimationFrame(() => {
    const inputs = job.el.querySelectorAll('.auto-speaker-name input');
    if (inputs[index - 1]) inputs[index - 1].focus();
  });
  return speaker;
}

function focusAutoReferenceRow(jobId, job, rowIndex) {
  if (!job || !job.autoReference || !job.autoReference.rows[rowIndex]) return;
  job.autoReference.selectedRowId = job.autoReference.rows[rowIndex].id;
  renderAutoReferenceRows(jobId);
  requestAnimationFrame(() => job.el.querySelector('.auto-inspector-text')?.focus());
}

function inferredAutoReferenceRange(rows, insertionIndex) {
  const previous = rows[insertionIndex - 1];
  const next = rows[insertionIndex];
  if (previous && next && previous.end != null && next.start != null) {
    const gapStart = Number(previous.end);
    const gapEnd = Number(next.start);
    if (Number.isFinite(gapStart) && Number.isFinite(gapEnd) && gapEnd - gapStart >= 0.05) {
      return { start: gapStart, end: gapEnd };
    }
    // 前後の発話が重なっている場合、その交差区間を欠落発話の初期位置にする。
    const overlapStart = Math.max(Number(previous.start) || 0, Number(next.start) || 0);
    const overlapEnd = Math.min(Number(previous.end) || 0, Number(next.end) || 0);
    if (overlapEnd - overlapStart >= 0.1) return { start: overlapStart, end: overlapEnd };
  }
  if (previous && Number.isFinite(Number(previous.end))) {
    return { start: Number(previous.end), end: Number(previous.end) + 1 };
  }
  if (next && Number.isFinite(Number(next.start))) {
    return { start: Math.max(0, Number(next.start) - 1), end: Number(next.start) };
  }
  return { start: 0, end: 1 };
}

function createAutoReferenceRow(values = {}) {
  const sourceStart = values.sourceStart == null ? null : Number(values.sourceStart);
  const sourceEnd = values.sourceEnd == null ? null : Number(values.sourceEnd);
  return {
    id: values.id || `auto-row-${++autoReferenceRowSeq}`,
    speaker: values.speaker || 'speaker-1',
    text: String(values.text || ''),
    start: values.start == null ? null : Number(values.start),
    end: values.end == null ? null : Number(values.end),
    sourceStart: Number.isFinite(sourceStart) ? sourceStart : null,
    sourceEnd: Number.isFinite(sourceEnd) ? sourceEnd : null,
    operation: values.operation === 'insert' ? 'insert' : 'replace',
    confirmed: values.confirmed === true,
    candidates: Array.isArray(values.candidates) ? values.candidates : null,
  };
}

function autoReferenceRange(job) {
  const reference = job && job.autoReference;
  if (!reference) return { start: 0, end: 1, duration: 1 };
  const starts = reference.rows.map((row) => Number(row.start)).filter(Number.isFinite);
  const ends = reference.rows.map((row) => Number(row.end)).filter(Number.isFinite);
  let start = Number(reference.rangeStart);
  let end = Number(reference.rangeEnd);
  if (!Number.isFinite(start)) start = starts.length ? Math.min(...starts) : 0;
  if (!Number.isFinite(end) || !(end > start)) end = ends.length ? Math.max(...ends) : start + 1;
  if (!(end > start)) end = start + 1;
  return { start, end, duration: end - start };
}

function clampAutoReferenceRow(job, row) {
  const range = autoReferenceRange(job);
  let start = Number(row.start);
  let end = Number(row.end);
  if (!Number.isFinite(start)) start = range.start;
  if (!Number.isFinite(end)) end = start + 1;
  start = Math.max(range.start, Math.min(range.end - 0.05, start));
  end = Math.max(start + 0.05, Math.min(range.end, end));
  row.start = Math.round(start * 100) / 100;
  row.end = Math.round(end * 100) / 100;
}

function invalidateAutoReferenceRow(jobId, row) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (row) {
    row.candidates = null;
    row._candidateKey = '';
    row._candidateError = '';
    row._trialClip = null;
  }
  updateAutoReferenceCount(job);
  invalidateAutoTuneReference(jobId);
}

function insertAutoReferenceRow(jobId, insertionIndex, defaultSpeaker, explicitRange = null) {
  const job = jobs.get(jobId);
  if (!job || !job.autoReference) return;
  const rows = job.autoReference.rows;
  const index = Math.max(0, Math.min(rows.length, insertionIndex));
  const range = explicitRange || inferredAutoReferenceRange(rows, index);
  const created = createAutoReferenceRow({
    speaker: defaultSpeaker || job.autoReference.speakers[0].id,
    text: '',
    operation: 'insert',
    confirmed: false,
    ...range,
  });
  clampAutoReferenceRow(job, created);
  rows.splice(index, 0, created);
  job.autoReference.selectedRowId = created.id;
  renderAutoReferenceRows(jobId);
  invalidateAutoReferenceRow(jobId, created);
  focusAutoReferenceRow(jobId, job, index);
}

function selectedAutoReferenceRow(job) {
  if (!job || !job.autoReference) return null;
  return job.autoReference.rows.find((row) => row.id === job.autoReference.selectedRowId) || null;
}

function selectAutoReferenceRow(jobId, rowId, { focusText = false } = {}) {
  const job = jobs.get(jobId);
  if (!job || !job.autoReference) return;
  job.autoReference.selectedRowId = rowId;
  renderAutoReferenceRows(jobId);
  if (focusText) requestAnimationFrame(() => job.el.querySelector('.auto-inspector-text')?.focus());
}

const AUTO_TIMELINE = Object.freeze({ labelWidth: 92, waveformHeight: 58, rulerHeight: 25, laneHeight: 52 });

function autoTimelineBasePixelsPerSecond(reference) {
  const levels = [12, 20, 32, 48, 70];
  const index = Math.max(0, Math.min(levels.length - 1, Number(reference.zoomIndex) || 0));
  return levels[index];
}

function autoTimelinePixelsPerSecond(reference) {
  return Number(reference.renderPixelsPerSecond) || autoTimelineBasePixelsPerSecond(reference);
}

function drawAutoTimelineWaveform(job) {
  const reference = job && job.autoReference;
  if (!reference) return;
  const canvas = job.el.querySelector('.auto-timeline-waveform');
  const range = autoReferenceRange(job);
  const pixelsPerSecond = autoTimelinePixelsPerSecond(reference);
  const cssWidth = Math.max(1, Math.round(range.duration * pixelsPerSecond));
  const drawWidth = Math.max(300, Math.min(2400, cssWidth));
  canvas.width = drawWidth;
  canvas.height = AUTO_TIMELINE.waveformHeight * 2;
  canvas.style.left = `${AUTO_TIMELINE.labelWidth}px`;
  canvas.style.width = `${cssWidth}px`;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const middle = canvas.height / 2;
  context.strokeStyle = '#cbd5e1';
  context.beginPath(); context.moveTo(0, middle); context.lineTo(canvas.width, middle); context.stroke();
  if (!Array.isArray(reference.waveformPeaks) || !reference.waveformPeaks.length) return;
  context.strokeStyle = '#64748b';
  context.lineWidth = 1;
  context.beginPath();
  reference.waveformPeaks.forEach((peak, index) => {
    const x = index / Math.max(1, reference.waveformPeaks.length - 1) * canvas.width;
    const height = Math.max(1, Math.min(1, peak) * (middle - 5));
    context.moveTo(x, middle - height);
    context.lineTo(x, middle + height);
  });
  context.stroke();
}

async function loadAutoTimelineWaveform(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.autoReference || !job._trialRangePreviewUrl || typeof AudioContext === 'undefined') return;
  const key = job._trialRangePreviewUrl;
  if (job.autoReference.waveformKey === key || job.autoReference.waveformLoading) return;
  job.autoReference.waveformLoading = true;
  try {
    const response = await fetch(key);
    const data = await response.arrayBuffer();
    const audioContext = new AudioContext();
    const buffer = await audioContext.decodeAudioData(data.slice(0));
    const samples = buffer.getChannelData(0);
    const bucketCount = 1200;
    const bucketSize = Math.max(1, Math.floor(samples.length / bucketCount));
    const peaks = [];
    for (let offset = 0; offset < samples.length; offset += bucketSize) {
      let peak = 0;
      const limit = Math.min(samples.length, offset + bucketSize);
      for (let index = offset; index < limit; index++) peak = Math.max(peak, Math.abs(samples[index]));
      peaks.push(peak);
    }
    await audioContext.close();
    if (!job.autoReference || job._trialRangePreviewUrl !== key) return;
    job.autoReference.waveformKey = key;
    job.autoReference.waveformPeaks = peaks;
    drawAutoTimelineWaveform(job);
  } catch (error) {
    console.warn('timeline waveform unavailable', error);
  } finally {
    if (job.autoReference) job.autoReference.waveformLoading = false;
  }
}

function updateAutoTimelinePlayhead(job) {
  if (!job || !job.autoReference) return;
  const playhead = job.el.querySelector('.auto-timeline-playhead');
  const audio = job.el.querySelector('.trial-range-audio');
  const range = autoReferenceRange(job);
  const seconds = Math.max(0, Math.min(range.duration, Number(audio.currentTime) || 0));
  const playheadX = AUTO_TIMELINE.labelWidth
    + seconds * autoTimelinePixelsPerSecond(job.autoReference);
  playhead.style.left = `${playheadX}px`;
  const timelineScroll = job.el.querySelector('.auto-timeline-scroll');
  if (timelineScroll && timelineScroll.scrollWidth > timelineScroll.clientWidth) {
    const trackViewportWidth = Math.max(1, timelineScroll.clientWidth - AUTO_TIMELINE.labelWidth);
    const visibleTrackStart = timelineScroll.scrollLeft + AUTO_TIMELINE.labelWidth;
    const followStart = visibleTrackStart + trackViewportWidth * 0.18;
    const followEnd = visibleTrackStart + trackViewportWidth * 0.82;
    if (playheadX < followStart || playheadX > followEnd) {
      const maxScrollLeft = Math.max(0, timelineScroll.scrollWidth - timelineScroll.clientWidth);
      const nextScrollLeft = playheadX - AUTO_TIMELINE.labelWidth - trackViewportWidth * 0.35;
      timelineScroll.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft));
    }
  }
  const playToggle = job.el.querySelector('.auto-timeline-play-toggle');
  const stop = job.el.querySelector('.auto-timeline-stop');
  const time = job.el.querySelector('.auto-timeline-play-time');
  if (playToggle) {
    playToggle.textContent = audio.paused ? '▶ 再生' : '❚❚ 一時停止';
    playToggle.disabled = !audio.src;
  }
  if (stop) stop.disabled = !audio.src || (audio.paused && seconds <= 0.001);
  if (time) time.textContent = `${formatTrialStart(range.start + seconds)} / ${formatTrialStart(range.end)}`;
}

function autoTimelineShortcutUsesTextInput(target) {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function handleAutoTimelineShortcut(job, event) {
  if (!job || !job.autoReference || event.defaultPrevented || event.ctrlKey || event.metaKey
    || autoTimelineShortcutUsesTextInput(event.target)) return false;
  const reference = job.el.querySelector('.auto-reference');
  const audio = job.el.querySelector('.trial-range-audio');
  if (!reference || reference.classList.contains('hidden') || !audio.src) return false;

  const code = event.code || '';
  const key = event.key || '';
  const seekStep = event.shiftKey ? 5 : 1;
  const seekBy = (delta) => {
    const duration = autoReferenceRange(job).duration;
    audio.currentTime = Math.max(0, Math.min(duration, (Number(audio.currentTime) || 0) + delta));
    updateAutoTimelinePlayhead(job);
  };
  let handled = true;
  if (code === 'Space') {
    // 押しっぱなしで再生と一時停止が高速反転しないよう、リピート入力は消費だけする。
    if (!event.repeat) job.el.querySelector('.auto-timeline-play-toggle').click();
  } else if (key === 'ArrowLeft' || code === 'KeyJ') {
    seekBy(-seekStep);
  } else if (key === 'ArrowRight' || code === 'KeyL') {
    seekBy(seekStep);
  } else if (key === 'Home') {
    audio.currentTime = 0;
    updateAutoTimelinePlayhead(job);
  } else if (code === 'KeyK') {
    if (!event.repeat) audio.pause();
    updateAutoTimelinePlayhead(job);
  } else if (code === 'KeyS') {
    if (!event.repeat) job.el.querySelector('.auto-timeline-stop').click();
  } else {
    handled = false;
  }
  if (!handled) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function updateAutoBlockGeometry(job, row, block) {
  const range = autoReferenceRange(job);
  const pixelsPerSecond = autoTimelinePixelsPerSecond(job.autoReference);
  const laneIndex = Math.max(0, job.autoReference.speakers.findIndex((speaker) => speaker.id === row.speaker));
  block.style.left = `${AUTO_TIMELINE.labelWidth + (row.start - range.start) * pixelsPerSecond}px`;
  block.style.width = `${Math.max(7, (row.end - row.start) * pixelsPerSecond)}px`;
  block.style.top = `${AUTO_TIMELINE.waveformHeight + AUTO_TIMELINE.rulerHeight
    + laneIndex * AUTO_TIMELINE.laneHeight + 9}px`;
}

function installAutoBlockDrag(jobId, row, block) {
  block.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const job = jobs.get(jobId);
    if (!job || !job.autoReference) return;
    job.autoReference.selectedRowId = row.id;
    const handle = event.target.closest('.auto-resize-handle');
    const mode = handle ? (handle.classList.contains('is-start') ? 'start' : 'end') : 'move';
    const origin = { x: event.clientX, start: row.start, end: row.end, speaker: row.speaker };
    const pixelsPerSecond = autoTimelinePixelsPerSecond(job.autoReference);
    const range = autoReferenceRange(job);
    let moved = false;
    block.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const deltaSeconds = Math.round(((moveEvent.clientX - origin.x) / pixelsPerSecond) * 20) / 20;
      if (Math.abs(moveEvent.clientX - origin.x) > 2) moved = true;
      if (mode === 'start') {
        row.start = Math.max(range.start, Math.min(origin.end - 0.05, origin.start + deltaSeconds));
      } else if (mode === 'end') {
        row.end = Math.min(range.end, Math.max(origin.start + 0.05, origin.end + deltaSeconds));
      } else {
        const duration = origin.end - origin.start;
        row.start = Math.max(range.start, Math.min(range.end - duration, origin.start + deltaSeconds));
        row.end = row.start + duration;
        const contentRect = job.el.querySelector('.auto-timeline-content').getBoundingClientRect();
        const laneY = moveEvent.clientY - contentRect.top
          - AUTO_TIMELINE.waveformHeight - AUTO_TIMELINE.rulerHeight;
        const laneIndex = Math.max(0, Math.min(job.autoReference.speakers.length - 1,
          Math.floor(laneY / AUTO_TIMELINE.laneHeight)));
        if (job.autoReference.speakers[laneIndex]) row.speaker = job.autoReference.speakers[laneIndex].id;
      }
      clampAutoReferenceRow(job, row);
      updateAutoBlockGeometry(job, row, block);
    };
    const onUp = () => {
      block.removeEventListener('pointermove', onMove);
      block.removeEventListener('pointerup', onUp);
      block.removeEventListener('pointercancel', onUp);
      if (moved) invalidateAutoReferenceRow(jobId, row);
      renderAutoReferenceRows(jobId);
    };
    block.addEventListener('pointermove', onMove);
    block.addEventListener('pointerup', onUp);
    block.addEventListener('pointercancel', onUp);
  });
}

function renderAutoReferenceInspector(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.autoReference) return;
  const inspector = job.el.querySelector('.auto-block-inspector');
  const row = selectedAutoReferenceRow(job);
  inspector.classList.toggle('hidden', !row);
  if (!row) return;
  const rowIndex = job.autoReference.rows.indexOf(row);
  inspector.querySelector('.auto-inspector-title').textContent = `発話 ${rowIndex + 1}`;
  inspector.querySelector('.auto-inspector-kind').textContent = row.operation === 'insert'
    ? '欠落発話として追加' : '認識結果を修正';

  const speaker = inspector.querySelector('.auto-inspector-speaker');
  speaker.replaceChildren(...job.autoReference.speakers.map((item) => new Option(item.name, item.id)));
  speaker.value = row.speaker;
  speaker.onchange = () => {
    row.speaker = speaker.value;
    invalidateAutoReferenceRow(jobId, row);
    renderAutoReferenceRows(jobId);
  };
  const start = inspector.querySelector('.auto-inspector-start');
  const end = inspector.querySelector('.auto-inspector-end');
  start.value = Number(row.start).toFixed(2);
  end.value = Number(row.end).toFixed(2);
  const applyTimes = () => {
    row.start = Number(start.value);
    row.end = Number(end.value);
    clampAutoReferenceRow(job, row);
    invalidateAutoReferenceRow(jobId, row);
    renderAutoReferenceRows(jobId);
  };
  start.onchange = applyTimes;
  end.onchange = applyTimes;

  const text = inspector.querySelector('.auto-inspector-text');
  text.value = row.text;
  text.oninput = () => {
    row.text = text.value;
    const blockText = job.el.querySelector(`.auto-timeline-block[data-row-id="${row.id}"] .auto-block-text`);
    if (blockText) blockText.textContent = row.text.trim() || '（文章未入力）';
    invalidateAutoReferenceRow(jobId, row);
  };
  const confirmed = inspector.querySelector('.auto-inspector-confirmed');
  confirmed.checked = row.confirmed === true;
  confirmed.onchange = () => {
    if (confirmed.checked && (!row.text.trim() || !(row.end > row.start))) {
      confirmed.checked = false;
      job.el.querySelector('.auto-reference-error').textContent = '確定する発話には、正しい文章と開始・終了時刻が必要です。';
      return;
    }
    row.confirmed = confirmed.checked;
    job.el.querySelector('.auto-reference-error').textContent = '';
    updateAutoReferenceCount(job);
    invalidateAutoTuneReference(jobId);
    renderAutoReferenceRows(jobId);
  };

  const play = inspector.querySelector('.auto-inspector-play');
  play.onclick = () => playTrialSegment(job, row, play);
  inspector.querySelector('.auto-insert-before').onclick = () => insertAutoReferenceRow(jobId, rowIndex, row.speaker);
  inspector.querySelector('.auto-insert-after').onclick = () => insertAutoReferenceRow(jobId, rowIndex + 1, row.speaker);
  const remove = inspector.querySelector('.auto-row-remove');
  remove.disabled = job.autoReference.rows.length <= 1;
  remove.onclick = () => {
    if (job.autoReference.rows.length <= 1) return;
    job.autoReference.rows.splice(rowIndex, 1);
    job.autoReference.selectedRowId = job.autoReference.rows[Math.min(rowIndex, job.autoReference.rows.length - 1)].id;
    invalidateAutoReferenceRow(jobId, null);
    renderAutoReferenceRows(jobId);
  };

  const candidateStatus = inspector.querySelector('.auto-candidate-status');
  const candidateList = inspector.querySelector('.auto-candidate-list');
  candidateList.replaceChildren();
  if (Array.isArray(row.candidates)) {
    const seen = new Set();
    row.candidates.forEach((candidate) => {
      const normalized = autoTuneTools.normalizeText(candidate.text);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'auto-candidate-option';
      const label = document.createElement('small');
      label.textContent = candidate.label || '候補';
      const value = document.createElement('span');
      value.textContent = candidate.text;
      button.append(label, value);
      button.addEventListener('click', () => {
        row.text = candidate.text;
        row.confirmed = true;
        job.el.querySelector('.auto-reference-error').textContent = '';
        invalidateAutoTuneReference(jobId);
        renderAutoReferenceRows(jobId);
      });
      candidateList.appendChild(button);
    });
    candidateStatus.textContent = candidateList.childElementCount
      ? `${candidateList.childElementCount}件` : '異なる候補はありませんでした';
  } else candidateStatus.textContent = '';
  if (row._candidateError) candidateStatus.textContent = row._candidateError;

  const generate = inspector.querySelector('.auto-candidate-generate');
  generate.disabled = row._candidateLoading === true || typeof window.api.segmentCandidates !== 'function';
  generate.textContent = row._candidateLoading ? '候補を生成中…' : '境界を変えて候補を生成';
  generate.onclick = async () => {
    if (row._candidateLoading || typeof window.api.segmentCandidates !== 'function') return;
    row._candidateLoading = true;
    row._candidateError = '';
    renderAutoReferenceInspector(jobId);
    try {
      const current = typeof job._getTranscribeOpts === 'function' ? job._getTranscribeOpts() : {};
      const candidates = await window.api.segmentCandidates(job.filePath, {
        start: row.start,
        end: row.end,
        denoiseStrength: Number(current.denoiseStrength) || 0,
      });
      row.candidates = [{ label: '現在の認識', text: row.text }].concat(Array.isArray(candidates) ? candidates : []);
      row._candidateKey = `${row.start}:${row.end}:${Number(current.denoiseStrength) || 0}`;
    } catch (error) {
      row.candidates = [];
      row._candidateError = `候補を生成できませんでした: ${error.message || error}`;
    } finally {
      row._candidateLoading = false;
      renderAutoReferenceInspector(jobId);
    }
  };
}

function renderAutoReferenceRows(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.autoReference) return;
  const reference = job.autoReference;
  const range = autoReferenceRange(job);
  const timelineScroll = job.el.querySelector('.auto-timeline-scroll');
  const basePixelsPerSecond = autoTimelineBasePixelsPerSecond(reference);
  reference.renderPixelsPerSecond = Math.max(basePixelsPerSecond,
    (Math.max(300, timelineScroll.clientWidth) - AUTO_TIMELINE.labelWidth) / range.duration);
  const pixelsPerSecond = autoTimelinePixelsPerSecond(reference);
  const trackWidth = Math.max(280, range.duration * pixelsPerSecond);
  const contentWidth = AUTO_TIMELINE.labelWidth + trackWidth;
  const contentHeight = AUTO_TIMELINE.waveformHeight + AUTO_TIMELINE.rulerHeight
    + reference.speakers.length * AUTO_TIMELINE.laneHeight;
  const content = job.el.querySelector('.auto-timeline-content');
  const ruler = job.el.querySelector('.auto-timeline-ruler');
  const lanes = job.el.querySelector('.auto-timeline-lanes');
  content.style.width = `${contentWidth}px`;
  content.style.height = `${contentHeight}px`;
  ruler.style.width = `${contentWidth}px`;
  lanes.style.width = `${contentWidth}px`;
  lanes.style.height = `${reference.speakers.length * AUTO_TIMELINE.laneHeight}px`;
  ruler.replaceChildren();
  lanes.replaceChildren();

  const step = pixelsPerSecond >= 60 ? 1 : (pixelsPerSecond >= 30 ? 2 : (pixelsPerSecond >= 18 ? 5 : 10));
  const firstTick = Math.ceil(range.start / step) * step;
  for (let seconds = firstTick; seconds <= range.end + 1e-6; seconds += step) {
    const tick = document.createElement('div');
    tick.className = 'auto-timeline-tick';
    tick.style.left = `${AUTO_TIMELINE.labelWidth + (seconds - range.start) * pixelsPerSecond}px`;
    const label = document.createElement('span');
    label.textContent = formatTrialStart(seconds);
    tick.appendChild(label);
    ruler.appendChild(tick);
  }

  reference.speakers.forEach((speaker, laneIndex) => {
    const lane = document.createElement('div');
    lane.className = 'auto-timeline-lane';
    lane.dataset.speakerId = speaker.id;
    lane.style.top = `${laneIndex * AUTO_TIMELINE.laneHeight}px`;
    lane.style.backgroundSize = `${Math.max(1, pixelsPerSecond)}px 100%`;
    const label = document.createElement('div');
    label.className = 'auto-timeline-lane-label';
    label.textContent = speaker.name;
    lane.appendChild(label);
    lane.addEventListener('dblclick', (event) => {
      if (event.target !== lane) return;
      const rect = content.getBoundingClientRect();
      const at = range.start + Math.max(0, event.clientX - rect.left - AUTO_TIMELINE.labelWidth) / pixelsPerSecond;
      const start = Math.max(range.start, Math.min(range.end - 0.1, at));
      insertAutoReferenceRow(jobId, reference.rows.length, speaker.id, {
        start,
        end: Math.min(range.end, start + 1),
      });
    });
    lanes.appendChild(lane);
  });

  content.querySelectorAll(':scope > .auto-timeline-block').forEach((block) => block.remove());
  reference.rows.forEach((row, rowIndex) => {
    clampAutoReferenceRow(job, row);
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'auto-timeline-block';
    block.classList.toggle('is-confirmed', row.confirmed === true);
    block.classList.toggle('is-insert', row.operation === 'insert');
    block.classList.toggle('is-selected', row.id === reference.selectedRowId);
    block.classList.toggle('is-loading', row._candidateLoading === true);
    block.dataset.rowId = row.id;
    block.setAttribute('aria-label', `発話${rowIndex + 1} ${formatTrialStart(row.start)}から${formatTrialStart(row.end)} ${row.text}`);
    const startHandle = document.createElement('span');
    startHandle.className = 'auto-resize-handle is-start';
    const blockText = document.createElement('span');
    blockText.className = 'auto-block-text';
    blockText.textContent = row.text.trim() || '（文章未入力）';
    const endHandle = document.createElement('span');
    endHandle.className = 'auto-resize-handle is-end';
    block.append(startHandle, blockText, endHandle);
    block.addEventListener('click', () => selectAutoReferenceRow(jobId, row.id));
    installAutoBlockDrag(jobId, row, block);
    updateAutoBlockGeometry(job, row, block);
    content.appendChild(block);
  });

  job.el.querySelector('.auto-zoom-label').textContent = pixelsPerSecond > basePixelsPerSecond + 0.5
    ? '全体' : `${Math.round(basePixelsPerSecond / 20 * 100)}%`;
  drawAutoTimelineWaveform(job);
  updateAutoTimelinePlayhead(job);
  renderAutoReferenceInspector(jobId);
  updateAutoReferenceCount(job);
}

function initializeAutoReference(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  const segments = Array.isArray(result.segments) ? result.segments : [];
  const speakers = [];
  const localSpeakerByKey = new Map();
  segments.forEach((segment) => {
    const key = segment.correctionSpeakerKey;
    if (!key || localSpeakerByKey.has(key) || speakers.length >= 4) return;
    const id = `speaker-${speakers.length + 1}`;
    localSpeakerByKey.set(key, id);
    speakers.push({ id, name: segment.correctionSpeakerName || `話者${speakers.length + 1}` });
  });
  if (!speakers.length) speakers.push({ id: 'speaker-1', name: '話者1' });
  const fallbackSpeakerId = speakers[0].id;
  const resultRange = result.range || {};
  const starts = segments.map((segment) => Number(segment.start)).filter(Number.isFinite);
  const ends = segments.map((segment) => Number(segment.end)).filter(Number.isFinite);
  const rangeStart = Number.isFinite(Number(resultRange.startSeconds))
    ? Number(resultRange.startSeconds) : (starts.length ? Math.min(...starts) : 0);
  let rangeEnd = Number(resultRange.endSeconds);
  if (!Number.isFinite(rangeEnd) || !(rangeEnd > rangeStart)) {
    rangeEnd = ends.length ? Math.max(...ends) : rangeStart + Math.max(1, Number(result.duration) || 1);
  }
  const rows = segments.length ? segments.map((segment) => createAutoReferenceRow({
    speaker: localSpeakerByKey.get(segment.correctionSpeakerKey) || fallbackSpeakerId,
    text: segment.text || '',
    start: segment.start,
    end: segment.end,
    sourceStart: segment.correctionSourceStart != null ? segment.correctionSourceStart : segment.start,
    sourceEnd: segment.correctionSourceEnd != null ? segment.correctionSourceEnd : segment.end,
    operation: segment.correctionOperation || 'replace',
    confirmed: segment.lockedCorrection === true,
  })) : [createAutoReferenceRow({
    speaker: fallbackSpeakerId, text: '', start: rangeStart,
    end: Math.min(rangeEnd, rangeStart + 1), operation: 'insert', confirmed: false,
  })];
  job.autoReference = {
    speakers,
    rows,
    rangeStart,
    rangeEnd,
    selectedRowId: rows[0].id,
    zoomIndex: 1,
    waveformPeaks: null,
  };
  const section = job.el.querySelector('.auto-reference');
  section.classList.remove('hidden');
  job.el.querySelector('.trial-segments').classList.add('hidden');
  job.el.querySelector('.trial-settings').classList.add('hidden');
  job.el.querySelector('.auto-tune-result').classList.add('hidden');
  job.el.querySelector('.trial-result-actions').classList.add('hidden');
  job.el.querySelector('.trial-more-actions').classList.add('hidden');
  setAutoTuneWorkflowState(job, 'editing');
  renderAutoSpeakerNames(jobId);
  renderAutoReferenceRows(jobId);
  updateAutoReferenceCount(job);
  job.el.querySelector('.auto-reference-error').textContent = '';
  loadAutoTimelineWaveform(jobId);
}

function autoReferenceRowsForRequest(job) {
  if (!job || !job.autoReference) return [];
  const speakerNames = new Map(job.autoReference.speakers.map((speaker) => [speaker.id, speaker.name]));
  return job.autoReference.rows.map((row, order) => ({
    speaker: row.speaker,
    speakerName: speakerNames.get(row.speaker) || '',
    text: row.text,
    start: row.start,
    end: row.end,
    sourceStart: row.sourceStart,
    sourceEnd: row.sourceEnd,
    operation: row.operation,
    confirmed: row.confirmed === true,
    _order: order,
  })).sort((a, b) => {
    const startA = Number.isFinite(Number(a.start)) ? Number(a.start) : Infinity;
    const startB = Number.isFinite(Number(b.start)) ? Number(b.start) : Infinity;
    return startA - startB || Number(a.end) - Number(b.end) || a._order - b._order;
  }).map(({ _order, ...row }) => row);
}

function setAutoReferenceDisabled(job, disabled) {
  job.el.querySelectorAll('.auto-reference input, .auto-reference textarea, .auto-reference select, .auto-reference button')
    .forEach((node) => { node.disabled = disabled; });
}

function setTrialResultActionMode(job, mode) {
  if (!job) return;
  const actions = job.el.querySelector('.trial-result-actions');
  const more = job.el.querySelector('.trial-more-actions');
  const autoButton = more.querySelector('.trial-auto-btn');
  const completeButton = actions.querySelector('.trial-complete-start-btn');
  const useButton = actions.querySelector('.trial-use-btn');
  const editAgainButton = more.querySelector('.trial-edit-again-btn');
  actions.classList.remove('hidden');
  more.classList.remove('hidden');
  more.open = false;
  const completed = mode === 'completed';
  actions.classList.toggle('is-complete', completed);
  actions.querySelector(':scope > span').textContent = completed
    ? '調整と修正内容を適用しました'
    : '次の操作を選んでください';
  autoButton.classList.toggle('hidden', completed);
  completeButton.classList.toggle('hidden', !completed);
  editAgainButton.classList.toggle('hidden', !completed);
  useButton.textContent = completed ? '閉じる' : 'この設定で進む';
  useButton.classList.toggle('is-secondary', completed);
  if (completed) {
    completeButton.disabled = job.trialIsFresh !== true;
    completeButton.title = job.trialIsFresh === true ? '' : '設定が変わったため、もう一度テストしてください';
    useButton.disabled = false;
    useButton.title = '';
  }
}

function setAutoTuneWorkflowState(job, state, error = null) {
  if (!job) return;
  job.autoTuneUiState = state;
  const overlay = job.el.querySelector('.auto-tune-overlay');
  const modalCard = job.el.querySelector('.trial-modal-card');
  const trialModal = job.el.querySelector('.trial-modal');
  const visible = ['tuning', 'cancelling', 'failed'].includes(state);
  overlay.classList.toggle('hidden', !visible);
  overlay.classList.toggle('is-cancelling', state === 'cancelling');
  overlay.classList.toggle('is-error', state === 'failed');
  trialModal.setAttribute('aria-busy', state === 'tuning' || state === 'cancelling' ? 'true' : 'false');
  modalCard.inert = visible;
  if (visible) modalCard.setAttribute('aria-hidden', 'true');
  else modalCard.removeAttribute('aria-hidden');

  const progress = overlay.querySelector('.auto-tune-overlay-progress');
  const details = overlay.querySelector('.auto-tune-overlay-details');
  const errorBox = overlay.querySelector('.auto-tune-overlay-error');
  const cancel = overlay.querySelector('.auto-tune-overlay-cancel');
  const returnButton = overlay.querySelector('.auto-tune-overlay-return');
  const failed = state === 'failed';
  progress.classList.toggle('hidden', failed);
  details.classList.toggle('hidden', failed);
  errorBox.classList.toggle('hidden', !failed);
  cancel.classList.toggle('hidden', failed);
  returnButton.classList.toggle('hidden', !failed);

  if (state === 'tuning') {
    overlay.querySelector('.auto-tune-overlay-kicker').textContent = '文字起こし精度を向上中';
    overlay.querySelector('.auto-tune-overlay-title').textContent = '修正内容に近づく認識設定を探しています';
    cancel.disabled = false;
  } else if (state === 'cancelling') {
    overlay.querySelector('.auto-tune-overlay-kicker').textContent = '中止しています';
    overlay.querySelector('.auto-tune-overlay-title').textContent = '安全に処理を終了しています';
    cancel.disabled = true;
  } else if (failed) {
    const raw = String(error && (error.message || error) || '不明なエラー');
    const info = transcriptionProgress.describeError(error, null, false);
    overlay.querySelector('.auto-tune-overlay-kicker').textContent = '処理を完了できませんでした';
    overlay.querySelector('.auto-tune-overlay-title').textContent = '修正内容はそのまま残っています';
    errorBox.querySelector('.auto-tune-overlay-error-message').textContent =
      info && info.message ? `${info.title}: ${info.message}` : raw;
    const technical = errorBox.querySelector('.auto-tune-overlay-error-details');
    const technicalText = errorBox.querySelector('.auto-tune-overlay-error-technical');
    const showTechnical = !!raw && (!info || !String(info.message || '').includes(raw));
    technical.classList.toggle('hidden', !showTechnical);
    technical.open = false;
    technicalText.textContent = showTechnical ? raw : '';
  }

  if (visible) {
    requestAnimationFrame(() => {
      const target = failed ? returnButton : cancel;
      if (target && !target.disabled) target.focus();
      else overlay.querySelector('.auto-tune-overlay-card').focus();
    });
  }
}

function renderAutoTuneOutcome(jobId, outcome, elapsedSeconds) {
  const job = jobs.get(jobId);
  if (!job || !outcome || !outcome.best) return;
  const box = job.el.querySelector('.auto-tune-result');
  const metrics = outcome.best.metrics;
  const accuracy = Math.round(Math.max(0, metrics.accuracy) * 100);
  const confidence = { high: '差が明確', medium: '有力候補', low: '差が小さい' }[outcome.confidence] || '';
  box.querySelector('.auto-tune-score').textContent = `修正内容との一致 ${accuracy}%`;
  box.querySelector('.auto-tune-summary').textContent =
    `${outcome.speakerCount}話者・${metrics.referenceLength}文字で比較し、${metrics.deletions}文字の抜け、`
    + `${metrics.substitutions}文字の置換、${metrics.insertions}文字の余分な認識でした。`
    + `${confidence ? `（${confidence}）` : ''} 所要 ${transcriptionProgress.formatElapsed(elapsedSeconds)}`;
  box.querySelector('.auto-tune-settings').textContent =
    `適用設定: ${trialSettingsSummary(job._getTranscribeOpts())}`;
  box.querySelector('.auto-correction-confirmed').textContent =
    'この範囲の修正内容を確定しました。再び文字起こししても、テスト・全体結果・書き出しで維持します。';
  const warning = box.querySelector('.auto-tune-warning');
  const warnings = [];
  if (outcome.confidence === 'low') warnings.push('候補間の差が小さいため、全体実行前に別の区間でも確認してください。');
  if (outcome.speakerAnalysisWarning) warnings.push(`話者解析: ${outcome.speakerAnalysisWarning}`);
  warning.textContent = warnings.join(' ');
  warning.classList.toggle('hidden', !warnings.length);
  box.classList.remove('hidden');
  setAutoTuneWorkflowState(job, 'completed');
  setTrialResultActionMode(job, 'completed');
  syncTrialCorrectionUi(job, job.lastTrial && job.lastTrial.result);
}

function applyAutoTuneStatus(status) {
  const job = jobs.get(status.jobId);
  if (!job || String(job.activeAutoTuneId) !== String(status.tuneId)) return;
  const progress = job.el.querySelector('.auto-tune-overlay-progress');
  const label = progress.querySelector('.auto-tune-overlay-label');
  const count = progress.querySelector('.auto-tune-overlay-count');
  const bar = progress.querySelector('.bar');
  if (status.state === 'cancelling') {
    setAutoTuneWorkflowState(job, 'cancelling');
    label.textContent = '認識設定の調整を中止しています…';
    job.el.querySelector('.auto-tune-overlay-detail').textContent = '現在の候補比較を安全に終了し、修正画面へ戻ります。';
    return;
  }
  if (['completed', 'cancelled', 'error'].includes(status.state)) return;
  if (status.state === 'queued') {
    label.textContent = `開始待ち（${status.queuePosition || 1}番目 / 全${status.queueTotal || 1}件）`;
    count.textContent = '';
  } else if (status.phase === 'decoding') label.textContent = '対象音声を読み込み中…';
  else if (status.phase === 'overlap') label.textContent = '話者の重なりを解析中…';
  else if (status.phase === 'denoising') label.textContent = 'ノイズ低減候補を準備中…';
  else if (status.phase === 'vad') label.textContent = '発話の区切り候補を準備中…';
  else if (status.phase === 'tuning') {
    label.textContent = status.candidateLabel
      ? `候補「${status.candidateLabel}」を比較中…`
      : '認識設定を比較中…';
  } else label.textContent = '認識設定の調整を準備中…';

  const detailByPhase = {
    decoding: '修正した範囲の音声を読み込み、比較の準備をしています。',
    overlap: '同時に話している箇所を調べ、話者ごとの認識候補を準備しています。',
    denoising: '声を聞き取りやすくする強さを変えながら候補を準備しています。',
    vad: '発話の区切り方を変えながら、聞き落としが少ない候補を準備しています。',
    tuning: '修正した正しい文章と各候補を比較し、最も近い設定を選んでいます。',
  };
  job.el.querySelector('.auto-tune-overlay-detail').textContent = status.state === 'queued'
    ? 'ほかの処理が終わり次第、自動で開始します。修正内容は保持されています。'
    : (detailByPhase[status.phase] || '音声と修正内容を使って、認識設定を準備しています。');

  const index = Number(status.candidateIndex) || 0;
  const total = Number(status.totalCandidates) || 0;
  count.textContent = total > 0 ? `${index} / ${total}候補` : '';
  if (total > 0 && index > 0) {
    bar.classList.remove('is-indeterminate');
    bar.style.width = `${Math.round(index / total * 100)}%`;
  } else {
    bar.classList.add('is-indeterminate');
    bar.style.width = '';
  }
}

async function startAutoTune(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.activeTrialId || job.activeAutoTuneId || !job.autoReference
    || typeof job._getTranscribeOpts !== 'function') return;
  const rows = autoReferenceRowsForRequest(job);
  const confirmedRows = rows.filter((row) => row.confirmed === true);
  const charCount = Array.from(autoTuneTools.referenceText(rows)).length;
  const errorEl = job.el.querySelector('.auto-reference-error');
  if (charCount < autoTuneTools.MIN_REFERENCE_CHARS) {
    errorEl.textContent = `句読点を除いて${autoTuneTools.MIN_REFERENCE_CHARS}文字以上に修正してください。`;
    const textarea = job.el.querySelector('.auto-reference textarea');
    if (textarea) textarea.focus();
    return;
  }
  if (confirmedRows.some((row) => !Number.isFinite(Number(row.start))
    || !Number.isFinite(Number(row.end)) || Number(row.end) <= Number(row.start))) {
    errorEl.textContent = '確定した発話の開始・終了時刻を確認してください。';
    return;
  }
  const speakers = new Set(confirmedRows
    .filter((row) => autoTuneTools.normalizeText(row.text)).map((row) => row.speaker));
  if (speakers.size > 4) {
    errorEl.textContent = '文字起こしの修正による自動調整は4話者までです。';
    return;
  }
  errorEl.textContent = '';
  const resultRange = job.lastTrial && job.lastTrial.result && job.lastTrial.result.range;
  const range = resultRange ? {
    startSeconds: resultRange.startSeconds,
    durationSeconds: resultRange.requestedDurationSeconds || resultRange.durationSeconds,
  } : job.lastTrial.range;
  const tuneId = ++autoTuneSeq;
  const startedAt = Date.now();
  job.activeAutoTuneId = tuneId;
  reportUnsavedState();
  setAutoReferenceDisabled(job, true);
  job.el.querySelector('.trial-error').classList.add('hidden');
  setAutoTuneWorkflowState(job, 'tuning');
  job.el.querySelector('.auto-tune-overlay-label').textContent = '認識設定の調整を準備中…';
  job.el.querySelector('.auto-tune-overlay-count').textContent = '';
  job.el.querySelector('.auto-tune-overlay-detail').textContent =
    '音声の強調や発話の区切り方を複数試し、修正内容に最も近い候補を比較します。';
  job.el.querySelector('.auto-tune-overlay-progress .bar').classList.add('is-indeterminate');
  job.el.querySelector('.auto-tune-overlay-progress .bar').style.width = '';
  job.el.querySelector('.auto-tune-overlay-elapsed').textContent = '経過 00:00';
  job.el.querySelector('.start-btn').disabled = true;
  job.el.querySelector('.job-status').textContent = '認識設定を調整中';
  job.autoTuneTimer = setInterval(() => {
    job.el.querySelector('.auto-tune-overlay-elapsed').textContent =
      `経過 ${transcriptionProgress.formatElapsed((Date.now() - startedAt) / 1000)}`;
  }, 1000);
  let cancelled = false;
  let failed = false;
  try {
    const outcome = await window.api.autoTune(job.filePath, jobId, tuneId, {
      range,
      referenceRows: rows,
      current: job._getTranscribeOpts(),
    });
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    if (typeof job._applyAutoTuneResult === 'function') {
      job._applyAutoTuneResult(outcome, elapsedSeconds, rows, range);
    }
    renderAutoTuneOutcome(jobId, outcome, elapsedSeconds);
    job.el.querySelector('.job-status').textContent = job.result ? '設定を変更中' : '精度向上の調整完了';
  } catch (error) {
    cancelled = /中止|cancel/i.test(String(error.message || error));
    failed = !cancelled;
    setAutoTuneWorkflowState(job, failed ? 'failed' : 'editing', failed ? error : null);
    job.el.querySelector('.job-status').textContent = job.result
      ? '設定を変更中'
      : (cancelled ? '調整を中止' : '調整を完了できませんでした');
  } finally {
    if (job.autoTuneTimer) clearInterval(job.autoTuneTimer);
    job.autoTuneTimer = null;
    if (String(job.activeAutoTuneId) === String(tuneId)) job.activeAutoTuneId = null;
    setAutoReferenceDisabled(job, false);
    reportUnsavedState();
    refreshTrialFreshness(jobId);
    if (cancelled) {
      requestAnimationFrame(() => job.el.querySelector('.auto-tune-btn').focus());
    } else if (failed) {
      job.el.querySelector('.auto-tune-overlay-return').focus();
    }
  }
}

if (typeof window.api.onAutoTuneStatus === 'function') {
  window.api.onAutoTuneStatus(applyAutoTuneStatus);
}

function renderTrialResult(jobId, result, attempt) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.lastTrial = { ...attempt, result };
  const el = job.el;
  const box = el.querySelector('.trial-result');
  const range = result.range || attempt.range;
  const end = range.endSeconds == null ? range.startSeconds + range.durationSeconds : range.endSeconds;
  box.querySelector('.trial-result-meta').textContent =
    `${formatTrialStart(range.startSeconds)}〜${formatTrialStart(end)} ・ ${result.segments.length}区間 ・ ${transcriptionProgress.formatElapsed(attempt.elapsedSeconds)}`;
  box.querySelector('.trial-settings').textContent = `使用設定: ${attempt.summary}${job.trialWarning ? ` ・ ${job.trialWarning}` : ''}`;
  const segments = box.querySelector('.trial-segments');
  segments.replaceChildren();
  if (!result.segments.length) {
    const empty = document.createElement('div');
    empty.className = 'trial-seg-empty';
    empty.textContent = '（この区間では発話を検出できませんでした）';
    segments.appendChild(empty);
  } else {
    result.segments.forEach((segment) => {
      const row = document.createElement('div');
      row.className = 'trial-seg';
      const play = document.createElement('button');
      play.className = 'seg-play';
      play.textContent = '▶';
      play.title = '音声でこの区間を確認';
      play.addEventListener('click', () => {
        if (play.classList.contains('is-playing')) { if (trialSharedStop) trialSharedStop(); }
        else playTrialSegment(job, segment, play);
      });
      const time = document.createElement('span');
      time.className = 'ts';
      time.textContent = formatTrialStart(segment.start);
      const text = document.createElement('span');
      text.className = 'txt';
      text.textContent = segment.text;
      row.append(play, time, text);
      if (segment.lockedCorrection) {
        const badge = document.createElement('span');
        badge.className = 'locked-correction-badge';
        badge.textContent = '修正済み';
        badge.title = 'この文章はユーザーの修正内容として確定されています';
        row.appendChild(badge);
      }
      segments.appendChild(row);
    });
  }
  segments.classList.remove('hidden');
  box.querySelector('.trial-settings').classList.remove('hidden');
  box.querySelector('.auto-reference').classList.add('hidden');
  box.querySelector('.auto-tune-result').classList.add('hidden');
  setAutoTuneWorkflowState(job, 'idle');
  setTrialResultActionMode(job, 'trial');
  syncTrialCorrectionUi(job, result);
  box.classList.remove('hidden');
  refreshTrialFreshness(jobId);
}

function unlockCurrentTrialCorrections(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.lastTrial) return;
  const ids = appliedCorrectionIds(job.lastTrial.result);
  if (!ids.length) return;
  if (!confirm('この範囲の確定した修正を解除し、自動認識の文章へ戻しますか？')) return;
  const idSet = new Set(ids);
  job.corrections = job.corrections.filter((block) => !idSet.has(block.id));
  const rawTrial = job.lastTrial.rawResult || job.lastTrial.result;
  const result = applyLockedCorrections(job, rawTrial);
  const attempt = { ...job.lastTrial, rawResult: rawTrial };
  job.autoReference = null;
  renderTrialResult(jobId, result, attempt);
  if (job.rawResult) {
    job.result = applyLockedCorrections(job, job.rawResult);
    markJobResultChanged(job);
  }
  job.el.querySelector('.job-status').textContent = job.result ? '設定を変更中' : '修正を解除しました';
  reportUnsavedState();
}

async function startTranscriptionTrial(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.activeTrialId || typeof job._getTranscribeOpts !== 'function'
    || (typeof job._hasScenario === 'function' && !job._hasScenario())) return;
  const el = job.el;
  const startInput = el.querySelector('.trial-start');
  const durationInput = el.querySelector('.trial-duration');
  const rangeError = el.querySelector('.trial-range-error');
  const startSeconds = parseTrialStart(startInput.value);
  if (startSeconds == null) {
    rangeError.textContent = '開始位置は 05:30 または 01:05:30 の形式で入力してください';
    startInput.focus();
    return;
  }
  startInput.value = formatTrialStart(startSeconds);
  rangeError.textContent = '';
  const durationSeconds = Number(durationInput.value) || 60;
  const range = { startSeconds, durationSeconds };
  const opts = job._getTranscribeOpts();
  const attempt = {
    range,
    fingerprint: trialSettingsFingerprint(opts),
    summary: trialSettingsSummary(opts),
    startedAt: Date.now(),
  };
  const trialId = ++trialSeq;
  job.activeTrialId = trialId;
  reportUnsavedState();
  if (typeof job._refreshSetupFlow === 'function') job._refreshSetupFlow();
  job.trialErrorInfo = null;
  job.trialWarning = '';
  el.querySelector('.trial-error').classList.add('hidden');
  // 前回の試行結果を表示したままだと、新しい試行が完了したように見えるため一旦隠す。
  el.querySelector('.trial-result').classList.add('hidden');
  el.querySelector('.trial-progress').classList.remove('hidden');
  el.querySelector('.trial-progress .bar').classList.add('is-indeterminate');
  el.querySelector('.trial-progress .bar').style.width = '';
  el.querySelector('.trial-progress-label').textContent = '開始を待っています…';
  el.querySelector('.trial-progress-count').textContent = '';
  el.querySelector('.trial-cancel').disabled = false;
  el.querySelector('.trial-btn').disabled = true;
  el.querySelector('.start-btn').disabled = true;
  startInput.disabled = true;
  durationInput.disabled = true;
  el.querySelector('.job-status').textContent = '仕上がりをテスト中';
  job.trialTimer = setInterval(() => {
    el.querySelector('.trial-elapsed').textContent =
      `経過 ${transcriptionProgress.formatElapsed((Date.now() - attempt.startedAt) / 1000)}`;
  }, 1000);

  try {
    const rawResult = await window.api.transcribeTrial(job.filePath, jobId, trialId, { ...opts, range });
    const result = applyLockedCorrections(job, rawResult);
    attempt.rawResult = rawResult;
    attempt.elapsedSeconds = (Date.now() - attempt.startedAt) / 1000;
    renderTrialResult(jobId, result, attempt);
    el.querySelector('.job-status').textContent = job.result ? '設定を変更中' : 'テスト完了';
  } catch (error) {
    const info = job.trialErrorInfo || transcriptionProgress.describeError(error, null, /中止/.test(String(error.message || error)));
    const cancelled = info.cancelled || info.code === 'CANCELLED';
    if (!cancelled) {
      const errorBox = el.querySelector('.trial-error');
      const raw = String(error.message || error);
      errorBox.textContent = raw.includes('指定した試行区間') ? raw : `${info.title}: ${info.message}`;
      errorBox.classList.remove('hidden');
    }
    el.querySelector('.job-status').textContent = job.result ? '設定を変更中' : (cancelled ? '試行を中止' : '準備完了');
  } finally {
    if (job.trialTimer) clearInterval(job.trialTimer);
    job.trialTimer = null;
    if (String(job.activeTrialId) === String(trialId)) job.activeTrialId = null;
    reportUnsavedState();
    el.querySelector('.trial-progress').classList.add('hidden');
    el.querySelector('.trial-btn').disabled = false;
    el.querySelector('.start-btn').disabled = false;
    startInput.disabled = false;
    durationInput.disabled = false;
    refreshTrialFreshness(jobId);
  }
}

if (typeof window.api.onTranscribeTrialStatus === 'function') {
  window.api.onTranscribeTrialStatus(applyTrialStatus);
}

function addJob(filePath, { name = '', deferPreview = false } = {}) {
  const jobId = ++jobSeq;
  const node = jobTpl.content.cloneNode(true);
  const el = node.querySelector('.job');
  el.querySelector('.job-name').textContent = name || filePath.split(/[\\/]/).pop();
  el.querySelector('.job-status').textContent = '準備完了';
  jobsEl.prepend(el);
  jobs.set(jobId, {
    el,
    filePath,
    result: null,
    resultRevision: 0,
    savedResultRevision: 0,
    recordingSaved: false,
    isTranscribing: false,
    activeAutoTuneId: null,
    autoTuneUiState: 'idle',
    autoTuneApplied: false,
    autoReference: null,
    corrections: [],
    rawResult: null,
  });
  const job = jobs.get(jobId);

  const audioOriginal = el.querySelector('.audio-original');
  const origStatus = el.querySelector('.orig-status');
  const segOpts = Array.from(el.querySelectorAll('.denoise-seg .seg-opt'));
  const previewBtn = el.querySelector('.preview-btn');
  const previewStatus = el.querySelector('.preview-status');
  const denoisedRow = el.querySelector('.denoised-row');
  const audioDenoised = el.querySelector('.audio-denoised');

  // 元音声プレビュー（音声全体を WAV に変換して再生）。
  // リアルタイム録音の結果ジョブは設定画面を開くまで不要なうえ、生成が
  // ワーカープールを起動してしまうため、deferPreview で遅延させる。
  const ensureOriginalPreview = async () => {
    origStatus.textContent = '読み込み中…';
    try {
      const r = await window.api.preview(filePath, ++previewSeq, 0);
      const objectUrl = await createAudioObjectUrl(r.wavPath);
      replaceAudioObjectUrl(audioOriginal, job, '_originalPreviewUrl', objectUrl);
      origStatus.textContent = '';
    } catch (e) {
      origStatus.textContent = `読み込み失敗: ${e.message}`;
    }
  };
  if (deferPreview) job._ensurePreview = ensureOriginalPreview;
  else ensureOriginalPreview();

  // ノイズ除去の強さは「なし/弱/中/強」のセグメントボタンで選ぶ（ネイティブ
  // <select> のポップアップに依存しないので、どの状態でも必ず切り替えられる）。
  let denoiseStrength = 0;   // 既定「なし」（HTML の is-active と一致）
  let previewReq = 0;        // このジョブの最新プレビュー要求ID（古い応答を捨てる）

  function setDenoise(v) {
    denoiseStrength = v;
    segOpts.forEach((b) => b.classList.toggle('is-active', parseFloat(b.dataset.value) === v));
    // 別強度で作った「除去後」プレビューは無効 → 破棄して、その強度で再プレビューできる状態に戻す
    previewReq++;
    clearAudioObjectUrl(audioDenoised, job, '_denoisedPreviewUrl');
    denoisedRow.classList.add('hidden');
    previewStatus.textContent = '';
    previewBtn.disabled = denoiseStrength <= 0;
    refreshTrialFreshness(jobId);
  }
  segOpts.forEach((b) => b.addEventListener('click', () => {
    job.autoTuneApplied = false;
    setDenoise(parseFloat(b.dataset.value));
  }));

  // 除去後プレビュー生成（先頭10秒）
  previewBtn.addEventListener('click', async () => {
    if (denoiseStrength <= 0) { alert('「ノイズの低減」を弱/中/強のいずれかにしてください。'); return; }
    const myReq = ++previewReq;
    previewBtn.disabled = true;
    previewStatus.textContent = '生成中…';
    try {
      const r = await window.api.preview(filePath, ++previewSeq, denoiseStrength);
      if (myReq !== previewReq) return; // 生成中に強さが変更された → 古い結果は破棄
      const objectUrl = await createAudioObjectUrl(r.wavPath);
      if (myReq !== previewReq) { URL.revokeObjectURL(objectUrl); return; }
      replaceAudioObjectUrl(audioDenoised, job, '_denoisedPreviewUrl', objectUrl);
      denoisedRow.classList.remove('hidden');
      previewStatus.textContent = '生成しました';
    } catch (e) {
      if (myReq === previewReq) previewStatus.textContent = `失敗: ${e.message}`;
    } finally {
      if (myReq === previewReq) previewBtn.disabled = denoiseStrength <= 0;
    }
  });

  // ---- 発話の区切り方（VAD）----
  // 認識モデルは短い発話向けなので、1区間が長すぎると中身が数文字に潰れる。
  // 音声の性質（会話か独話か）で最適値が変わるためジョブ単位で選べるようにする。
  const vadSeg = Array.from(el.querySelectorAll('.setting-choice-layout .scenario-card'));
  const builtInScenarioButtons = vadSeg.filter((button) => !!button.dataset.preset);
  const customScenarioBtn = el.querySelector('.custom-scenario-card');
  const customChoicePanel = el.querySelector('.custom-choice-panel');
  const customChoiceSelect = el.querySelector('.custom-choice-select');
  const customChoiceEmpty = el.querySelector('.custom-choice-empty');
  const customChoiceCreate = el.querySelector('.custom-choice-create');
  const vadMax = el.querySelector('.vad-max');
  const vadSil = el.querySelector('.vad-sil');
  const vadMinSpeech = el.querySelector('.vad-min-speech');
  const vadTh = el.querySelector('.vad-th');
  const overlapAware = el.querySelector('.overlap-aware');
  const overlapSpeakers = el.querySelector('.overlap-speakers');
  const vadPresetNote = el.querySelector('.vad-preset-note');
  const vadBadge = el.querySelector('.vad-custom-badge');
  const savedSelect = el.querySelector('.vad-saved-select');
  const presetName = el.querySelector('.vad-preset-name');
  const savePresetBtn = el.querySelector('.vad-save');
  const deletePresetBtn = el.querySelector('.vad-delete');
  const savePresetStatus = el.querySelector('.vad-save-status');

  // 数値の初期値には standard を使うが、シチュエーションはユーザーが必ず選ぶ。
  let selectedScenario = '';
  let selectedScenarioName = '';
  let selectedCustomPresetId = '';
  let presetSource = { kind: 'builtin', id: 'standard', scenario: '' };

  const hasCompleteSettingChoice = () => !!selectedScenario
    && (selectedScenario !== 'custom' || !!selectedCustomPresetId);

  function currentVadValues() {
    return {
      maxSpeechDuration: Number(vadMax.value),
      minSilenceDuration: Number(vadSil.value),
      minSpeechDuration: Number(vadMinSpeech.value),
      threshold: Number(vadTh.value),
      overlapAware: overlapAware.checked,
      overlapSpeakers: Number(overlapSpeakers.value),
    };
  }

  function hasUnsavedPresetDraft() {
    const name = presetName.value.trim();
    if (!name) return false;
    const reference = presetSource.kind === 'custom'
      ? customVadPresets.find((item) => item.id === presetSource.id)
      : null;
    if (!reference || reference.name !== name) return true;
    const current = currentVadValues();
    return current.maxSpeechDuration !== reference.maxSpeechDuration
      || current.minSilenceDuration !== reference.minSilenceDuration
      || current.minSpeechDuration !== reference.minSpeechDuration
      || current.threshold !== reference.threshold
      || current.overlapAware !== reference.overlapAware
      || current.overlapSpeakers !== reference.overlapSpeakers;
  }
  job._hasUnsavedPreset = hasUnsavedPresetDraft;

  function syncScenarioUi() {
    vadSeg.forEach((button) => {
      const selected = !!selectedScenario && button.dataset.scenario === selectedScenario;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
    const complete = hasCompleteSettingChoice();
    customChoicePanel.classList.toggle('hidden', selectedScenario !== 'custom');
    const requiredNote = el.querySelector('.scenario-required-note');
    requiredNote.classList.toggle('hidden', complete);
    requiredNote.textContent = selectedScenario === 'custom'
      ? '保存した設定を選ぶと、次の工程へ進めます。'
      : '選ぶと、音声に合った認識設定を自動で適用します。';
    el.querySelector('.scenario-applied').classList.toggle('hidden', !complete);
    el.querySelector('.scenario-selected-name').textContent = selectedScenarioName;
    if (selectedScenario === 'custom') customChoiceSelect.value = selectedCustomPresetId;
    if (typeof job._refreshSetupFlow === 'function') job._refreshSetupFlow();
  }

  function applyPresetValues(p) {
    vadMax.value = p.maxSpeechDuration;
    vadSil.value = p.minSilenceDuration;
    vadMinSpeech.value = p.minSpeechDuration;
    vadTh.value = p.threshold;
    overlapAware.checked = p.overlapAware;
    overlapSpeakers.value = String(p.overlapSpeakers);
    syncVadLabels();
    syncOverlapUi();
    vadBadge.classList.add('hidden');
    refreshTrialFreshness(jobId);
  }

  function applyBuiltInPreset(name, scenario = name) {
    const p = VAD_PRESETS[name];
    if (!p) return;
    job.autoTuneApplied = false;
    el.querySelector('.auto-reference').classList.add('hidden');
    el.querySelector('.auto-tune-result').classList.add('hidden');
    el.querySelector('.trial-segments').classList.remove('hidden');
    el.querySelector('.trial-settings').classList.remove('hidden');
    if (job.lastTrial) setTrialResultActionMode(job, 'trial');
    selectedScenario = scenario;
    selectedScenarioName = SCENARIO_META[scenario] ? SCENARIO_META[scenario].label : '';
    selectedCustomPresetId = '';
    presetSource = { kind: 'builtin', id: name, scenario };
    applyPresetValues(p);
    syncScenarioUi();
    savedSelect.value = '';
    presetName.value = '';
    deletePresetBtn.disabled = true;
    vadPresetNote.textContent = SCENARIO_META[scenario] ? SCENARIO_META[scenario].summary : '';
    savePresetStatus.textContent = '';
    reportUnsavedState();
  }

  function applySavedPreset(id, asCustomScenario = selectedScenario === 'custom') {
    const p = customVadPresets.find((item) => item.id === id);
    if (!p) return;
    job.autoTuneApplied = false;
    el.querySelector('.auto-reference').classList.add('hidden');
    el.querySelector('.auto-tune-result').classList.add('hidden');
    el.querySelector('.trial-segments').classList.remove('hidden');
    el.querySelector('.trial-settings').classList.remove('hidden');
    if (job.lastTrial) setTrialResultActionMode(job, 'trial');
    if (asCustomScenario) {
      selectedScenario = 'custom';
      selectedScenarioName = p.name;
      selectedCustomPresetId = p.id;
    }
    presetSource = { kind: 'custom', id: p.id, scenario: selectedScenario };
    applyPresetValues(p);
    syncScenarioUi();
    savedSelect.value = p.id;
    customChoiceSelect.value = asCustomScenario ? p.id : '';
    presetName.value = p.name;
    deletePresetBtn.disabled = false;
    vadPresetNote.textContent = '保存した詳細設定を適用しています';
    savePresetStatus.textContent = '';
    reportUnsavedState();
  }

  function chooseCustomScenario(forceReset = false) {
    if (!forceReset && selectedScenario === 'custom' && selectedCustomPresetId) {
      syncScenarioUi();
      return;
    }
    job.autoTuneApplied = false;
    el.querySelector('.auto-reference').classList.add('hidden');
    el.querySelector('.auto-tune-result').classList.add('hidden');
    el.querySelector('.trial-segments').classList.remove('hidden');
    el.querySelector('.trial-settings').classList.remove('hidden');
    if (job.lastTrial) setTrialResultActionMode(job, 'trial');
    selectedScenario = 'custom';
    selectedScenarioName = '';
    selectedCustomPresetId = '';
    presetSource = { kind: 'builtin', id: 'standard', scenario: 'custom' };
    applyPresetValues(VAD_PRESETS.standard);
    savedSelect.value = '';
    presetName.value = '';
    deletePresetBtn.disabled = true;
    vadPresetNote.textContent = '';
    syncScenarioUi();
    reportUnsavedState();
  }

  function syncVadLabels() {
    el.querySelector('.vad-max-val').textContent = vadMax.value;
    el.querySelector('.vad-sil-val').textContent = Number(vadSil.value).toFixed(2);
    el.querySelector('.vad-min-speech-val').textContent = Number(vadMinSpeech.value).toFixed(2);
    el.querySelector('.vad-th-val').textContent = Number(vadTh.value).toFixed(2);
  }

  function syncOverlapUi() {
    overlapSpeakers.disabled = !overlapAware.checked;
  }

  // スライダーを動かしたらプリセットから外れた印を出す（値そのものは保持）
  function markCustom() {
    job.autoTuneApplied = false;
    syncVadLabels();
    const p = presetSource.kind === 'builtin'
      ? VAD_PRESETS[presetSource.id]
      : customVadPresets.find((item) => item.id === presetSource.id);
    const same = !!p && Number(vadMax.value) === p.maxSpeechDuration
      && Number(vadSil.value) === p.minSilenceDuration
      && Number(vadMinSpeech.value) === p.minSpeechDuration
      && Number(vadTh.value) === p.threshold
      && overlapAware.checked === p.overlapAware
      && Number(overlapSpeakers.value) === p.overlapSpeakers;
    vadBadge.textContent = 'カスタム';
    vadBadge.classList.toggle('hidden', same);
    refreshTrialFreshness(jobId);
    reportUnsavedState();
  }

  function renderSavedPresets() {
    const selected = presetSource.kind === 'custom' ? presetSource.id : '';
    const placeholder = new Option('保存した設定', '');
    placeholder.disabled = true;
    savedSelect.replaceChildren(placeholder);
    customVadPresets.forEach((p) => savedSelect.add(new Option(p.name, p.id)));
    const hasSavedPresets = customVadPresets.length > 0;
    const selectedStillExists = customVadPresets.some((p) => p.id === selected);
    savedSelect.disabled = !hasSavedPresets;
    savedSelect.value = selectedStillExists ? selected : '';

    customChoiceSelect.replaceChildren(new Option('設定を選んでください', ''));
    customVadPresets.forEach((p) => customChoiceSelect.add(new Option(p.name, p.id)));
    customChoiceSelect.classList.toggle('hidden', !hasSavedPresets);
    customChoiceSelect.disabled = !hasSavedPresets;
    customChoiceEmpty.classList.toggle('hidden', hasSavedPresets);

    if (selectedCustomPresetId && !customVadPresets.some((p) => p.id === selectedCustomPresetId)) {
      selectedCustomPresetId = '';
      selectedScenarioName = '';
      if (selectedScenario === 'custom') syncScenarioUi();
    }
    customChoiceSelect.value = selectedCustomPresetId;
  }

  const presetView = { render: renderSavedPresets };
  vadPresetViews.add(presetView);
  vadPresetsReady.then(renderSavedPresets);

  builtInScenarioButtons.forEach((b) => b.addEventListener('click', () => {
    applyBuiltInPreset(b.dataset.preset, b.dataset.scenario);
  }));
  customScenarioBtn.addEventListener('click', () => chooseCustomScenario());
  customChoiceSelect.addEventListener('change', () => {
    if (customChoiceSelect.value) applySavedPreset(customChoiceSelect.value, true);
  });
  customChoiceCreate.addEventListener('click', () => {
    const details = el.querySelector('.vad-details');
    details.open = true;
    requestAnimationFrame(() => {
      details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      presetName.focus();
    });
  });
  savedSelect.addEventListener('change', () => {
    if (savedSelect.value) applySavedPreset(savedSelect.value);
  });
  presetName.addEventListener('input', reportUnsavedState);
  [vadMax, vadSil, vadMinSpeech, vadTh].forEach((s) => s.addEventListener('input', markCustom));
  overlapAware.addEventListener('change', () => { syncOverlapUi(); markCustom(); });
  overlapSpeakers.addEventListener('change', markCustom);
  el.querySelector('.vad-reset').addEventListener('click', () => {
    if (presetSource.kind === 'custom') applySavedPreset(presetSource.id);
    else applyBuiltInPreset(presetSource.id, presetSource.scenario);
  });

  savePresetBtn.addEventListener('click', async () => {
    const name = presetName.value.trim();
    if (!name) { savePresetStatus.textContent = '名前を入力してください'; presetName.focus(); return; }
    savePresetBtn.disabled = true;
    savePresetStatus.textContent = '保存中…';
    try {
      const res = await window.api.saveVadPreset({
        id: presetSource.kind === 'custom' ? presetSource.id : undefined,
        name,
        maxSpeechDuration: Number(vadMax.value),
        minSilenceDuration: Number(vadSil.value),
        minSpeechDuration: Number(vadMinSpeech.value),
        threshold: Number(vadTh.value),
        overlapAware: overlapAware.checked,
        overlapSpeakers: Number(overlapSpeakers.value),
      });
      setCustomVadPresets(res.presets);
      applySavedPreset(res.preset.id);
      savePresetStatus.textContent = '保存しました';
    } catch (e) {
      savePresetStatus.textContent = `保存失敗: ${e.message}`;
    } finally {
      savePresetBtn.disabled = false;
    }
  });

  deletePresetBtn.addEventListener('click', async () => {
    if (presetSource.kind !== 'custom') return;
    const p = customVadPresets.find((item) => item.id === presetSource.id);
    if (!p || !confirm(`プリセット「${p.name}」を削除しますか？`)) return;
    deletePresetBtn.disabled = true;
    try {
      const res = await window.api.deleteVadPreset(p.id);
      setCustomVadPresets(res.presets);
      if (selectedScenario === 'custom') {
        chooseCustomScenario(true);
        savePresetStatus.textContent = '削除しました。別の保存済み設定を選んでください';
        return;
      }
      const presetForScenario = {
        interview: 'interview', meeting: 'conversation', phone: 'conversation', lecture: 'lecture',
        normal: 'standard',
      }[selectedScenario];
      applyBuiltInPreset(presetForScenario || 'standard', selectedScenario);
    } catch (e) {
      savePresetStatus.textContent = `削除失敗: ${e.message}`;
      deletePresetBtn.disabled = false;
    }
  });

  // シチュエーション選択前も詳細設定の数値は安全な標準値で初期化しておく。
  applyBuiltInPreset('standard', '');

  const vadOptions = () => ({
    preset: presetSource.kind === 'builtin' ? presetSource.id : 'custom',
    scenario: selectedScenario,
    scenarioName: selectedScenarioName,
    maxSpeechDuration: Number(vadMax.value),
    minSilenceDuration: Number(vadSil.value),
    minSpeechDuration: Number(vadMinSpeech.value),
    threshold: Number(vadTh.value),
    overlapAware: overlapAware.checked,
    overlapSpeakers: Number(overlapSpeakers.value),
  });
  job._getTranscribeOpts = () => ({ denoiseStrength, vad: vadOptions() });
  job._hasScenario = hasCompleteSettingChoice;
  job._applyAutoTuneResult = (outcome, elapsedSeconds, referenceRows, correctionRange) => {
    if (!outcome || !outcome.best) return;
    const options = outcome.best.options;
    const baseScenarioName = selectedScenarioName || '現在の設定';
    job.autoTuneApplied = true;
    setDenoise(Number(options.denoiseStrength) || 0);
    applyPresetValues({ ...options.vad, overlapSpeakers: Math.max(2, outcome.speakerCount) });
    vadBadge.textContent = '自動調整';
    vadBadge.classList.remove('hidden');
    vadPresetNote.textContent = `${baseScenarioName}を基準に、修正した文字起こしから自動調整しました`;
    syncScenarioUi();
    const correction = correctionTools.createCorrectionBlock({
      id: `job-${jobId}-correction-${++correctionSeq}`,
      range: outcome.range || correctionRange,
      rows: referenceRows,
      replaceEntireRange: false,
    });
    if (correction) {
      job.corrections = correctionTools.upsertCorrectionBlock(job.corrections, correction);
      if (job.result) {
        job.result = applyLockedCorrections(job, job.rawResult || job.result);
        markJobResultChanged(job);
      }
    }
    const current = job._getTranscribeOpts();
    const correctedTrialResult = applyLockedCorrections(job, outcome.best.result);
    job.lastTrial = {
      result: correctedTrialResult,
      rawResult: outcome.best.result,
      range: outcome.range,
      fingerprint: trialSettingsFingerprint(current),
      summary: trialSettingsSummary(current),
      elapsedSeconds,
    };
    refreshTrialFreshness(jobId);
  };

  // 短区間の確認は設定カード内に常設せず、必要な時だけ独立したモーダルで開く。
  const trialModal = el.querySelector('.trial-modal');
  const autoTuneOverlay = el.querySelector('.auto-tune-overlay');
  const trialOpenBtn = el.querySelector('.trial-open-btn');
  const startBtn = el.querySelector('.start-btn');
  const setupActions = el.querySelector('.setup-actions');
  const trialRangeAudio = el.querySelector('.trial-range-audio');
  const trialRangeStatus = el.querySelector('.trial-range-status');
  const trialStartInput = el.querySelector('.trial-start');
  const trialDurationInput = el.querySelector('.trial-duration');
  const trialRunBtn = el.querySelector('.trial-btn');
  const trialBox = el.querySelector('.trial-box');
  const trialHelp = el.querySelector('.trial-help');
  const trialRangePreview = el.querySelector('.trial-range-preview');
  const trialAdjustView = el.querySelector('.trial-adjust-view');
  const trialAdjustSettingsHost = el.querySelector('.trial-adjust-settings-host');
  const trialAdjustAudioHost = el.querySelector('.trial-adjust-audio-host');
  const vadDetails = el.querySelector('.vad-details');
  const vadBody = el.querySelector('.vad-body');
  let trialRangePreviewReq = 0;
  let trialRangePreviewKey = '';
  let trialAdjustmentSnapshot = null;

  function refreshSetupFlow() {
    const hasScenario = hasCompleteSettingChoice();
    const trialFresh = !!job.lastTrial && job.trialIsFresh === true;
    const trialActive = !!job.activeTrialId || !!job.activeAutoTuneId;
    const currentStep = !hasScenario ? 1 : (trialFresh ? 3 : 2);
    el.querySelectorAll('[data-setup-step]').forEach((step) => {
      const number = Number(step.dataset.setupStep);
      step.classList.toggle('is-complete', number < currentStep);
      step.classList.toggle('is-current', number === currentStep);
    });

    trialOpenBtn.disabled = !hasScenario || trialActive;
    startBtn.disabled = !hasScenario || trialActive;
    startBtn.classList.toggle('hidden', !hasScenario);
    startBtn.classList.toggle('is-trial-verified', trialFresh);
    setupActions.classList.toggle('is-scenario-required', !hasScenario);
    setupActions.classList.toggle('is-test-next', hasScenario && !trialFresh);
    setupActions.classList.toggle('is-transcribe-next', trialFresh);

    const title = el.querySelector('.next-action-title');
    const note = el.querySelector('.next-action-note');
    if (!hasScenario) {
      title.textContent = selectedScenario === 'custom'
        ? '保存した設定を選んでください'
        : '音声に合う設定を選んでください';
      note.textContent = '選択後に、仕上がりを確認できます。';
      trialOpenBtn.textContent = '仕上がりをテスト';
    } else if (trialFresh) {
      title.textContent = job.autoTuneApplied ? '精度向上の調整が完了しました' : '仕上がりを確認できました';
      note.textContent = 'この設定で音声全体の文字起こしを開始できます。';
      trialOpenBtn.textContent = 'もう一度テスト';
      startBtn.textContent = 'この設定で全体を文字起こし';
    } else {
      title.textContent = '仕上がりをテスト';
      note.textContent = '短い区間で結果を確認してから、全体を始めるのがおすすめです。';
      trialOpenBtn.textContent = job.lastTrial ? '設定を変えて再テスト' : '仕上がりをテスト';
      startBtn.textContent = 'テストせず全体を文字起こし';
    }
  }
  job._refreshSetupFlow = refreshSetupFlow;
  refreshSetupFlow();

  async function refreshTrialRangePreview() {
    const start = parseTrialStart(trialStartInput.value);
    const duration = Number(trialDurationInput.value) || 60;
    if (start == null) {
      trialRangePreviewReq++;
      trialRangePreviewKey = '';
      clearAudioObjectUrl(trialRangeAudio, job, '_trialRangePreviewUrl');
      trialRangeStatus.textContent = '開始位置を確認してください';
      trialRunBtn.disabled = false;
      return;
    }
    const key = `${start}:${duration}`;
    if (key === trialRangePreviewKey && job._trialRangePreviewUrl) return;
    const myReq = ++trialRangePreviewReq;
    trialRangePreviewKey = '';
    trialRunBtn.disabled = true;
    trialRangeStatus.textContent = '読み込み中…';
    clearAudioObjectUrl(trialRangeAudio, job, '_trialRangePreviewUrl');
    try {
      const generate = typeof window.api.previewRange === 'function'
        ? window.api.previewRange
        : window.api.clipSegment;
      const clip = await generate(filePath, start, start + duration);
      const objectUrl = await createAudioObjectUrl(clip.wavPath);
      if (myReq !== trialRangePreviewReq) { URL.revokeObjectURL(objectUrl); return; }
      replaceAudioObjectUrl(trialRangeAudio, job, '_trialRangePreviewUrl', objectUrl);
      trialRangePreviewKey = key;
      trialRangeStatus.textContent = `${formatTrialStart(start)}〜${formatTrialStart(start + duration)}`;
    } catch (error) {
      if (myReq === trialRangePreviewReq) trialRangeStatus.textContent = `音声を読み込めません: ${error.message || error}`;
    } finally {
      if (myReq === trialRangePreviewReq && !job.activeTrialId) trialRunBtn.disabled = false;
    }
  }

  function setTrialModalHeader(mode) {
    const adjusting = mode === 'adjust';
    const title = trialModal.querySelector('.modal-head h2');
    title.textContent = adjusting ? '発話の拾い方などを調整' : '仕上がりをテスト';
    trialModal.querySelector('.modal-head p').textContent = adjusting
      ? '気になる点に合わせて設定を変え、同じ範囲でもう一度テストします。'
      : '音声の一部を、全体と同じ設定で文字起こしします。';
    trialModal.setAttribute('aria-label', title.textContent);
  }

  function captureTrialAdjustmentSettings() {
    const trackedViews = ['.auto-reference', '.auto-tune-result', '.trial-segments', '.trial-settings'];
    return {
      denoiseStrength,
      vad: currentVadValues(),
      selectedScenario,
      selectedScenarioName,
      selectedCustomPresetId,
      presetSource: { ...presetSource },
      savedSelectValue: savedSelect.value,
      presetName: presetName.value,
      deletePresetDisabled: deletePresetBtn.disabled,
      savePresetStatus: savePresetStatus.textContent,
      vadPresetNote: vadPresetNote.textContent,
      vadBadgeText: vadBadge.textContent,
      vadBadgeHidden: vadBadge.classList.contains('hidden'),
      autoTuneApplied: job.autoTuneApplied,
      detailsOpen: vadDetails.open,
      actionMode: el.querySelector('.trial-complete-start-btn').classList.contains('hidden')
        ? 'trial' : 'completed',
      moreOpen: el.querySelector('.trial-more-actions').open,
      trackedViews: Object.fromEntries(trackedViews.map((selector) => [
        selector, el.querySelector(selector).classList.contains('hidden'),
      ])),
    };
  }

  function restoreTrialAdjustmentSettings(snapshot) {
    if (!snapshot) return;
    if (denoiseStrength !== snapshot.denoiseStrength) setDenoise(snapshot.denoiseStrength);
    selectedScenario = snapshot.selectedScenario;
    selectedScenarioName = snapshot.selectedScenarioName;
    selectedCustomPresetId = snapshot.selectedCustomPresetId;
    presetSource = { ...snapshot.presetSource };
    vadMax.value = snapshot.vad.maxSpeechDuration;
    vadSil.value = snapshot.vad.minSilenceDuration;
    vadMinSpeech.value = snapshot.vad.minSpeechDuration;
    vadTh.value = snapshot.vad.threshold;
    overlapAware.checked = snapshot.vad.overlapAware;
    overlapSpeakers.value = String(snapshot.vad.overlapSpeakers);
    syncVadLabels();
    syncOverlapUi();
    syncScenarioUi();
    savedSelect.value = snapshot.savedSelectValue;
    presetName.value = snapshot.presetName;
    deletePresetBtn.disabled = snapshot.deletePresetDisabled;
    savePresetStatus.textContent = snapshot.savePresetStatus;
    vadPresetNote.textContent = snapshot.vadPresetNote;
    vadBadge.textContent = snapshot.vadBadgeText;
    vadBadge.classList.toggle('hidden', snapshot.vadBadgeHidden);
    job.autoTuneApplied = snapshot.autoTuneApplied;
    Object.entries(snapshot.trackedViews).forEach(([selector, hidden]) => {
      el.querySelector(selector).classList.toggle('hidden', hidden);
    });
    setTrialResultActionMode(job, snapshot.actionMode);
    el.querySelector('.trial-more-actions').open = snapshot.moreOpen;
    refreshTrialFreshness(jobId);
    reportUnsavedState();
  }

  function restoreTrialAdjustmentNodes() {
    if (vadBody.parentElement !== vadDetails) vadDetails.appendChild(vadBody);
    if (trialRangePreview.parentElement !== trialBox) trialBox.insertBefore(trialRangePreview, trialHelp);
  }

  function leaveTrialAdjustment({ restore = false, focusResult = false } = {}) {
    if (!trialModal.classList.contains('is-adjusting')) return;
    const snapshot = trialAdjustmentSnapshot;
    restoreTrialAdjustmentNodes();
    trialModal.classList.remove('is-adjusting');
    trialAdjustView.classList.add('hidden');
    if (restore) restoreTrialAdjustmentSettings(snapshot);
    if (snapshot) vadDetails.open = snapshot.detailsOpen;
    trialAdjustmentSnapshot = null;
    setTrialModalHeader('trial');
    trialModal.querySelector('.modal-body').scrollTop = 0;
    if (focusResult) requestAnimationFrame(() => el.querySelector('.trial-adjust-btn').focus());
  }

  function openTrialAdjustment() {
    if (!job.lastTrial || job.activeTrialId || job.activeAutoTuneId) return;
    trialAdjustmentSnapshot = captureTrialAdjustmentSettings();
    trialRangeAudio.pause();
    if (trialSharedStop) trialSharedStop();
    trialAdjustAudioHost.appendChild(trialRangePreview);
    trialAdjustSettingsHost.appendChild(vadBody);
    trialAdjustView.classList.remove('hidden');
    trialModal.classList.add('is-adjusting');
    setTrialModalHeader('adjust');
    const range = job.lastTrial.result.range || job.lastTrial.range;
    const end = range.endSeconds == null ? range.startSeconds + range.durationSeconds : range.endSeconds;
    trialAdjustView.querySelector('.trial-adjust-range').textContent =
      `テスト範囲 ${formatTrialStart(range.startSeconds)}〜${formatTrialStart(end)}`;
    trialAdjustView.querySelector('.trial-adjust-before-settings').textContent =
      `変更前: ${trialSettingsSummary(job._getTranscribeOpts())}`;
    trialModal.querySelector('.modal-body').scrollTop = 0;
    requestAnimationFrame(() => {
      const title = trialModal.querySelector('.modal-head h2');
      title.tabIndex = -1;
      title.focus();
    });
  }

  const closeTrialModal = () => {
    // 認識中に閉じて背面の設定を変更すると、返ってきた結果と画面の条件がずれる。
    // 完了を待つか、モーダル内の「中止」を使ってから閉じる。
    if (job.activeTrialId || job.activeAutoTuneId || !autoTuneOverlay.classList.contains('hidden')) return;
    leaveTrialAdjustment({ restore: true });
    trialModal.classList.add('hidden');
    trialRangeAudio.pause();
    if (trialSharedStop) trialSharedStop();
    trialOpenBtn.focus();
  };
  trialOpenBtn.addEventListener('click', () => {
    if (!hasCompleteSettingChoice()) return;
    setTrialModalHeader('trial');
    trialRunBtn.textContent = 'テストを開始';
    el.querySelector('.trial-help').textContent = '会話が始まる位置を指定すると、実際の仕上がりを確認しやすくなります。';
    trialModal.classList.remove('hidden');
    refreshTrialRangePreview();
    requestAnimationFrame(() => el.querySelector('.trial-start').focus());
  });
  trialStartInput.addEventListener('change', refreshTrialRangePreview);
  trialDurationInput.addEventListener('change', refreshTrialRangePreview);
  trialModal.querySelectorAll('[data-trial-close]').forEach((node) => {
    node.addEventListener('click', closeTrialModal);
  });
  trialModal.addEventListener('keydown', (event) => {
    if (!trialModal.classList.contains('is-adjusting') && handleAutoTimelineShortcut(job, event)) return;
    if (event.key === 'Escape') closeTrialModal();
  });
  autoTuneOverlay.addEventListener('keydown', (event) => {
    // 背面モーダルへ Escape / Tab を渡さず、処理表示の中だけで操作を完結させる。
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (job.autoTuneUiState === 'failed') autoTuneOverlay.querySelector('.auto-tune-overlay-return').click();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...autoTuneOverlay.querySelectorAll('button:not(:disabled):not(.hidden), summary, [tabindex="0"]')]
      .filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  el.querySelector('.trial-use-btn').addEventListener('click', () => {
    closeTrialModal();
    startBtn.focus();
  });
  const openCorrectionEditor = () => {
    if (!job.lastTrial || !job.lastTrial.result) return;
    initializeAutoReference(jobId, job.lastTrial.result);
  };
  el.querySelector('.trial-auto-btn').addEventListener('click', openCorrectionEditor);
  el.querySelector('.trial-edit-again-btn').addEventListener('click', openCorrectionEditor);
  el.querySelector('.auto-edit-cancel').addEventListener('click', () => {
    if (!job.lastTrial || !job.lastTrial.result) return;
    renderTrialResult(jobId, job.lastTrial.result, job.lastTrial);
  });
  el.querySelector('.trial-unlock-btn').addEventListener('click', () => {
    unlockCurrentTrialCorrections(jobId);
  });
  el.querySelector('.trial-adjust-btn').addEventListener('click', openTrialAdjustment);
  el.querySelector('.trial-adjust-back-btn').addEventListener('click', () => {
    leaveTrialAdjustment({ restore: true, focusResult: true });
  });
  el.querySelector('.trial-adjust-retest-btn').addEventListener('click', () => {
    leaveTrialAdjustment();
    startTranscriptionTrial(jobId);
  });

  el.querySelector('.auto-add-row').addEventListener('click', () => {
    if (!job.autoReference) return;
    const selected = selectedAutoReferenceRow(job);
    const selectedIndex = selected ? job.autoReference.rows.indexOf(selected) : job.autoReference.rows.length - 1;
    insertAutoReferenceRow(jobId, selectedIndex + 1,
      selected ? selected.speaker : job.autoReference.speakers[0].id);
  });
  el.querySelector('.auto-confirm-all').addEventListener('click', () => {
    if (!job.autoReference) return;
    job.autoReference.rows.forEach((row) => {
      if (row.text.trim() && row.end > row.start) row.confirmed = true;
    });
    el.querySelector('.auto-reference-error').textContent = '';
    updateAutoReferenceCount(job);
    invalidateAutoTuneReference(jobId);
    renderAutoReferenceRows(jobId);
  });
  el.querySelector('.auto-zoom-out').addEventListener('click', () => {
    if (!job.autoReference) return;
    job.autoReference.zoomIndex = Math.max(0, Number(job.autoReference.zoomIndex) - 1);
    renderAutoReferenceRows(jobId);
  });
  el.querySelector('.auto-zoom-in').addEventListener('click', () => {
    if (!job.autoReference) return;
    job.autoReference.zoomIndex = Math.min(4, Number(job.autoReference.zoomIndex) + 1);
    renderAutoReferenceRows(jobId);
  });
  const timelineContent = el.querySelector('.auto-timeline-content');
  timelineContent.addEventListener('click', (event) => {
    if (!job.autoReference || event.target.closest('.auto-timeline-block')
      || event.target.closest('.auto-timeline-lane-label')) return;
    const rect = timelineContent.getBoundingClientRect();
    const range = autoReferenceRange(job);
    const seconds = Math.max(0, Math.min(range.duration,
      (event.clientX - rect.left - AUTO_TIMELINE.labelWidth) / autoTimelinePixelsPerSecond(job.autoReference)));
    trialRangeAudio.currentTime = seconds;
    updateAutoTimelinePlayhead(job);
  });
  el.querySelector('.auto-timeline-play-toggle').addEventListener('click', async () => {
    if (!trialRangeAudio.src) return;
    if (!trialRangeAudio.paused) {
      trialRangeAudio.pause();
      return;
    }
    if (Number.isFinite(trialRangeAudio.duration)
      && trialRangeAudio.currentTime >= trialRangeAudio.duration - 0.05) {
      trialRangeAudio.currentTime = 0;
    }
    try {
      await trialRangeAudio.play();
    } catch (error) {
      el.querySelector('.auto-timeline-play-time').textContent = `再生できません: ${error.message || error}`;
    }
  });
  el.querySelector('.auto-timeline-stop').addEventListener('click', () => {
    trialRangeAudio.pause();
    trialRangeAudio.currentTime = 0;
    updateAutoTimelinePlayhead(job);
  });
  ['timeupdate', 'seeked', 'loadedmetadata', 'play', 'pause', 'ended'].forEach((eventName) => {
    trialRangeAudio.addEventListener(eventName, () => updateAutoTimelinePlayhead(job));
  });
  el.querySelector('.auto-tune-btn').addEventListener('click', () => startAutoTune(jobId));
  el.querySelector('.auto-tune-overlay-return').addEventListener('click', () => {
    setAutoTuneWorkflowState(job, 'editing');
    requestAnimationFrame(() => el.querySelector('.auto-tune-btn').focus());
  });
  el.querySelector('.auto-tune-overlay-cancel').addEventListener('click', async () => {
    const button = el.querySelector('.auto-tune-overlay-cancel');
    if (!job.activeAutoTuneId) return;
    button.disabled = true;
    try {
      await window.api.cancelAutoTune(jobId, job.activeAutoTuneId);
    } catch (error) {
      button.disabled = false;
      el.querySelector('.auto-tune-overlay-detail').textContent =
        `中止を要求できませんでした。処理の完了を待っています: ${error.message || error}`;
    }
  });

  // 文字起こし開始
  const startFullTranscription = () => {
    if (!hasCompleteSettingChoice()) return;
    setAutoTuneWorkflowState(job, 'idle');
    trialModal.classList.add('hidden');
    trialRangeAudio.pause();
    if (trialSharedStop) trialSharedStop();
    startTranscribe(jobId, filePath, job._getTranscribeOpts());
  };
  startBtn.addEventListener('click', startFullTranscription);
  el.querySelector('.trial-complete-start-btn').addEventListener('click', startFullTranscription);

  // 全体実行の前に、同じ設定で短い区間だけを確認する。
  el.querySelector('.trial-btn').addEventListener('click', () => startTranscriptionTrial(jobId));
  el.querySelector('.trial-cancel').addEventListener('click', async () => {
    const button = el.querySelector('.trial-cancel');
    button.disabled = true;
    try {
      if (job.activeTrialId) await window.api.cancelTranscribeTrial(jobId, job.activeTrialId);
      else button.disabled = false;
    }
    catch (e) { el.querySelector('.trial-error').textContent = `中止できませんでした: ${e.message || e}`; }
  });

  // ---- 結果側の操作は「ジョブ生成時に1回だけ」束ねる ----
  // やり直しで onJobDone が複数回走るため、ここ以外で addEventListener すると
  // ハンドラが二重登録され、書き出しが2回走るなどの不具合になる。
  el.querySelector('.skip-overlap-btn').addEventListener('click', async () => {
    const skipBtn = el.querySelector('.skip-overlap-btn');
    skipBtn.disabled = true;
    applyTranscribeStatus(jobId, {
      state: 'running', phase: 'overlap', skippingOverlap: true,
    });
    try {
      const accepted = await window.api.skipTranscribeOverlap(jobId);
      if (!accepted) throw new Error('重なり解析はすでに終了しています');
    } catch (e) {
      if (job.currentProgress && job.currentProgress.phase === 'overlap') {
        applyTranscribeStatus(jobId, {
          state: 'running', phase: 'overlap', skippingOverlap: false,
        });
      }
      job.slowWarning = `重なり解析をスキップできませんでした: ${e.message || e}`;
      renderProgressHealth(job);
    }
  });
  el.querySelector('.cancel-btn').addEventListener('click', async () => {
    const cancelBtn = el.querySelector('.cancel-btn');
    cancelBtn.disabled = true;
    applyTranscribeStatus(jobId, { state: 'cancelling' });
    el.querySelector('.job-status').textContent = '中止中…';
    try {
      await window.api.cancelTranscribe(jobId);
    } catch (e) {
      cancelBtn.disabled = false;
      job.slowWarning = `中止の要求を送れませんでした: ${e.message || e}`;
      renderProgressHealth(job);
    }
  });
  el.querySelector('.retry-btn').addEventListener('click', () => el.querySelector('.start-btn').click());
  el.querySelector('.redo-btn').addEventListener('click', () => reopenSetup(jobId));
  el.querySelector('.back-btn').addEventListener('click', () => closeSetup(jobId));
  el.querySelector('.tag-btn').addEventListener('click', () => {
    if (jobs.get(jobId).result) enterTaggingMode(jobId);
  });
  el.querySelector('.reassign-btn').addEventListener('click', () => doReassign(jobId));
  el.querySelectorAll('.toolbar button[data-fmt]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const job = jobs.get(jobId);
      if (!job.result) return;
      const revision = job.resultRevision;
      try {
        const result = await window.api.saveExport(exportPayload(job), btn.dataset.fmt);
        if (result && result.saved && job.resultRevision === revision) {
          job.savedResultRevision = revision;
          reportUnsavedState();
        }
      } catch (error) {
        alert(`保存に失敗: ${error.message || error}`);
      }
    });
  });
  el.querySelector('.copy-btn').addEventListener('click', () => {
    const job = jobs.get(jobId);
    if (job.result) navigator.clipboard.writeText(plainTextWithSpeakers(job));
  });
  // リアルタイム録音の結果ジョブのみ表示（録音 WAV は一時領域にあるため）
  el.querySelector('.save-audio-btn').addEventListener('click', async () => {
    const job = jobs.get(jobId);
    if (!job.result) return;
    const base = (job.result.name || 'recording').replace(/\.[^.]+$/, '');
    try {
      const result = await window.api.rtSaveWav(job.result.filePath, base);
      if (result && result.saved) {
        job.recordingSaved = true;
        reportUnsavedState();
      }
    }
    catch (e) { alert(`録音の保存に失敗: ${e.message}`); }
  });
  el.querySelector('.merge-spk').addEventListener('change', () => markJobResultChanged(job));
  el.querySelector('.audio-result').addEventListener('error', () => {
    // Chromium が扱えない形式。区間再生はクリップ方式へ、全体再生は隠す。
    const job = jobs.get(jobId);
    if (!job.result) return; // src 未設定/クリア時の空振りは無視
    job.fullAudioBroken = true;
    el.querySelector('.result-audio-row').classList.add('hidden');
  });

  return jobId;
}

// 文字起こし済みのジョブを設定画面に戻す（別条件でやり直すため）。
// 設定コントロールは DOM に残っているので、前回の値がそのまま初期値になる。
function reopenSetup(jobId) {
  const job = jobs.get(jobId);
  const el = job.el;
  stopSegmentPlayback(job);
  // 遅延させていた元音声プレビューを初回オープン時に生成する（リアルタイム録音由来）
  if (job._ensurePreview) { job._ensurePreview(); job._ensurePreview = null; }
  el.querySelector('.audio-result').pause();
  el.querySelector('.job-result').classList.add('hidden');
  el.querySelector('.job-setup').classList.remove('hidden');
  // 実際にやり直すまで前の結果は保持しておき、いつでも戻れるようにする
  el.querySelector('.back-btn').classList.toggle('hidden', !job.result);
  const status = el.querySelector('.job-status');
  status.textContent = '設定を変更中';
  status.classList.remove('done', 'error', 'warning');
}

// やり直しをやめて、保持しておいた前回の結果表示に戻る
function closeSetup(jobId) {
  const job = jobs.get(jobId);
  const el = job.el;
  if (!job.result) return;
  el.querySelector('.job-setup').classList.add('hidden');
  el.querySelector('.job-result').classList.remove('hidden');
  const status = el.querySelector('.job-status');
  status.textContent = '完了';
  status.classList.remove('error', 'warning');
  status.classList.add('done');
}

function startTranscribe(jobId, filePath, opts) {
  const job = jobs.get(jobId);
  job.denoiseStrength = opts.denoiseStrength || 0; // 後付け声紋計算で同条件にする
  job.lastTranscribeOpts = opts;
  const el = job.el;
  resetResultUi(job);
  job.isTranscribing = true;
  reportUnsavedState();
  el.querySelector('.back-btn').classList.add('hidden');
  el.querySelector('.job-setup').classList.add('hidden');
  const status = el.querySelector('.job-status');
  status.textContent = '処理中';
  status.classList.remove('done', 'error', 'warning');
  initializeTranscribeProgress(jobId, job, opts);
  job.startTime = Date.now();               // 残り時間推定の基点

  window.api.transcribe(filePath, jobId, opts)
    .then((result) => onJobDone(jobId, result))
    .catch((err) => onJobError(jobId, err));
}

// やり直し時に前回の結果表示を白紙に戻す（話者タグ付けの状態も含めて）。
function resetResultUi(job) {
  const el = job.el;
  stopSegmentPlayback(job);
  job.result = null;
  job.rawResult = null;
  job.names = {};
  job.anchors = new Map();
  job.maxSpeaker = -1;
  job.tagging = false;
  job.fullAudioBroken = false;

  const audio = el.querySelector('.audio-result');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (job._audioObjectUrl) { URL.revokeObjectURL(job._audioObjectUrl); job._audioObjectUrl = null; }

  el.querySelector('.job-result').classList.add('hidden');
  el.querySelector('.job-error').classList.add('hidden');
  el.querySelector('.result-audio-row').classList.remove('hidden');
  el.querySelector('.segments').innerHTML = '';
  el.querySelector('.embed-progress').classList.add('hidden');
  el.querySelector('.diar-edit').classList.add('hidden');
  el.querySelector('.merge-toggle').classList.add('hidden');
  el.querySelector('.merge-spk').checked = false;
  el.querySelector('.reassign-status').textContent = '';
  const bar = el.querySelector('.speakers-bar');
  if (bar) bar.remove();
  const tagBtn = el.querySelector('.tag-btn');
  tagBtn.classList.remove('hidden');
  tagBtn.disabled = false;
}

// 話者ごとの色（最大8色で循環）
const SPEAKER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];
function speakerColor(spk) {
  return spk < 0 ? '#6b7280' : SPEAKER_COLORS[spk % SPEAKER_COLORS.length];
}
function speakerLabel(job, spk) {
  if (spk == null) return '';        // 未割当
  if (spk < 0) return '話者不明';
  return job.names[spk] || `話者${spk + 1}`;
}

function renderPartialTranscript(job, partial) {
  if (partial && String(partial.text || '').trim()) {
    job.partialSegments.set(partial.index, { ...partial, receivedAt: Date.now() });
  }
  const box = job.el.querySelector('.partial-transcript');
  const list = box.querySelector('.partial-segments');
  const recent = [...job.partialSegments.values()]
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 8)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  box.classList.toggle('hidden', recent.length === 0);
  list.replaceChildren(...recent.map((segment) => {
    const row = document.createElement('div');
    const time = document.createElement('span');
    const text = document.createElement('span');
    row.className = 'partial-seg';
    time.className = 'partial-seg-time';
    text.className = 'partial-seg-text';
    time.textContent = fmtTime(segment.start);
    text.textContent = segment.text;
    row.append(time, text);
    return row;
  }));
}

function renderProgressSteps(job) {
  const list = job.el.querySelector('.progress-steps');
  const phases = job.progressPhases || [];
  const current = job.currentProgress ? job.currentProgress.phase : 'preparing';
  const currentIndex = Math.max(0, phases.indexOf(current));
  list.replaceChildren(...phases.map((phase, index) => {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    const label = document.createElement('span');
    icon.className = 'progress-step-icon';
    if (index < currentIndex) {
      li.className = 'is-complete';
      icon.textContent = '✓';
    } else if (index === currentIndex) {
      li.className = 'is-current';
      icon.textContent = '→';
    } else {
      icon.textContent = '○';
    }
    label.textContent = transcriptionProgress.phaseMeta(phase).label;
    li.append(icon, label);
    return li;
  }));
}

function renderProgressHealth(job) {
  const wrap = job.el.querySelector('.progress-wrap');
  const health = wrap.querySelector('.health-text');
  const warning = wrap.querySelector('.progress-warning');
  const jobStatus = job.el.querySelector('.job-status');
  const cancelling = job.currentProgress && job.currentProgress.state === 'cancelling';
  const queued = job.currentProgress && job.currentProgress.state === 'queued';
  const delayed = !!job.slowWarning;
  const degraded = !!job.pipelineWarning;
  wrap.classList.toggle('is-cancelling', cancelling);
  wrap.classList.toggle('is-queued', queued);
  wrap.classList.toggle('is-warning', !cancelling && (delayed || degraded));
  jobStatus.classList.toggle('warning', !cancelling && !queued && (delayed || degraded));

  if (cancelling) health.textContent = '中止しています';
  else if (queued) health.textContent = '待機中';
  else if (delayed) health.textContent = '通常より時間がかかっています';
  else if (degraded) health.textContent = '一部機能を省略して処理中';
  else health.textContent = '正常に処理中';
  if (queued) jobStatus.textContent = '待機中';
  else if (!cancelling) jobStatus.textContent = '処理中';

  const messages = [];
  if (job.pipelineWarning) messages.push(job.pipelineWarning);
  if (job.slowWarning) messages.push(job.slowWarning);
  warning.textContent = messages.join(' ');
  warning.classList.toggle('hidden', messages.length === 0);
}

function renderOverlapSkip(job) {
  const button = job.el.querySelector('.skip-overlap-btn');
  const progress = job.currentProgress || {};
  const supported = typeof window.api.skipTranscribeOverlap === 'function';
  const visible = supported && progress.phase === 'overlap' && progress.state !== 'cancelling';
  button.classList.toggle('hidden', !visible);
  button.disabled = progress.skippingOverlap === true;
  button.textContent = progress.skippingOverlap ? 'スキップ中…' : '重なり解析をスキップ';
}

function stopProgressTimer(job) {
  if (job.progressTimer) clearInterval(job.progressTimer);
  job.progressTimer = null;
}

function updateProgressClock(job) {
  if (!job.progressStartedAt) return;
  const now = Date.now();
  const current = job.currentProgress;
  job.el.querySelector('.elapsed').textContent =
    `${current && current.state === 'queued' ? '待機' : '経過'} ${transcriptionProgress.formatElapsed((now - job.progressStartedAt) / 1000)}`;

  if (!current || current.state === 'cancelling') return;
  if (current.phase === 'recognizing' || current.phase === 'finalizing') {
    job.el.querySelector('.eta').textContent = transcriptionProgress.updateEta(job.etaState, current, now);
  }
  const threshold = transcriptionProgress.slowThresholdMs(current.phase, current.totalAudioSec);
  if (now - job.lastProgressAt > threshold && !job.slowWarning) {
    job.slowWarning = 'この工程の終了はまだ確認できていません。このまま待つか、中止できます。';
    renderProgressHealth(job);
  }
}

function initializeTranscribeProgress(jobId, job, opts) {
  stopProgressTimer(job);
  const wrap = job.el.querySelector('.progress-wrap');
  wrap.classList.remove('hidden', 'is-warning', 'is-cancelling', 'is-queued');
  wrap.querySelector('.cancel-btn').disabled = false;
  wrap.querySelector('.skip-overlap-btn').classList.add('hidden');
  wrap.querySelector('.skip-overlap-btn').disabled = false;
  wrap.querySelector('.skip-overlap-btn').textContent = '重なり解析をスキップ';
  wrap.querySelector('.progress-details').open = false;
  job.progressPhases = transcriptionProgress.configuredPhases(opts);
  job.progressStartedAt = Date.now();
  job.lastProgressAt = job.progressStartedAt;
  job.etaState = transcriptionProgress.createEtaState();
  job.pipelineWarning = '';
  job.pipelineWarningDetail = '';
  job.slowWarning = '';
  job.errorInfo = null;
  job.currentProgress = null;
  job.partialSegments = new Map();
  wrap.querySelector('.partial-transcript').classList.add('hidden');
  wrap.querySelector('.partial-segments').replaceChildren();
  wrap.querySelector('.elapsed').textContent = '経過 00:00';
  applyTranscribeStatus(jobId, { state: 'queued', phase: 'queued', queuePosition: 1, queueTotal: 1, ratio: null });
  job.progressTimer = setInterval(() => updateProgressClock(job), 1000);
}

function applyTranscribeStatus(jobId, incoming) {
  const job = jobs.get(jobId);
  if (!job) return;
  const wrap = job.el.querySelector('.progress-wrap');
  const now = Date.now();

  if (incoming.error) job.errorInfo = incoming.error;
  if (incoming.partial) renderPartialTranscript(job, incoming.partial);
  if (incoming.warning) {
    job.pipelineWarning = incoming.warning;
    job.pipelineWarningDetail = incoming.warningDetail || '';
    renderProgressHealth(job);
    return;
  }
  if (incoming.state === 'error' || incoming.state === 'cancelled' || incoming.state === 'completed') return;
  if (incoming.state === 'cancelling') {
    job.currentProgress = { ...(job.currentProgress || {}), state: 'cancelling' };
    wrap.querySelector('.progress-stage').textContent = '処理を中止しています…';
    wrap.querySelector('.cancel-btn').disabled = true;
    renderOverlapSkip(job);
    renderProgressHealth(job);
    return;
  }

  const previous = job.currentProgress || {};
  const progress = {
    ...previous,
    ...incoming,
    state: incoming.state || 'running',
    phase: incoming.phase || previous.phase || 'preparing',
    totalAudioSec: incoming.totalAudioSec || previous.totalAudioSec || 0,
  };
  job.currentProgress = progress;
  job.lastProgressAt = now;
  job.slowWarning = '';

  const meta = transcriptionProgress.phaseMeta(progress.phase);
  wrap.querySelector('.progress-stage').textContent = progress.state === 'queued'
    ? `開始待ち（${progress.queuePosition || 1}番目 / 全${progress.queueTotal || 1}件）`
    : (progress.phase === 'overlap' && progress.skippingOverlap
      ? '重なり音声の解析をスキップしています…'
      : meta.active);
  const count = wrap.querySelector('.progress-count');
  if (progress.state === 'queued') {
    count.textContent = `${progress.queuePosition || 1} / ${progress.queueTotal || 1}件`;
  } else if (progress.phase === 'recognizing' && Number(progress.total) > 0) {
    const done = Math.min(Number(progress.total), Math.max(0, Number(progress.completed) || 0));
    const ratio = isFinite(Number(progress.ratio)) ? Math.max(0, Math.min(1, Number(progress.ratio))) : done / progress.total;
    count.textContent = `${done} / ${progress.total}区間（${Math.round(ratio * 100)}%）`;
  } else {
    count.textContent = '';
  }

  const bar = wrap.querySelector('.bar');
  const progressBar = bar.parentElement;
  const ratio = Number(progress.ratio);
  if (progress.phase === 'recognizing' && isFinite(ratio)) {
    const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    bar.classList.remove('is-indeterminate');
    bar.style.width = `${percent}%`;
    progressBar.setAttribute('aria-valuenow', String(percent));
  } else {
    bar.style.width = '';
    bar.classList.add('is-indeterminate');
    progressBar.removeAttribute('aria-valuenow');
  }
  wrap.querySelector('.eta').textContent = transcriptionProgress.updateEta(job.etaState, progress, now);
  renderOverlapSkip(job);
  renderProgressSteps(job);
  renderProgressHealth(job);
}

if (typeof window.api.onTranscribeStatus === 'function') {
  window.api.onTranscribeStatus((status) => applyTranscribeStatus(status.jobId, status));
} else {
  // 古い preload と組み合わせた場合の互換表示。
  window.api.onTranscribeProgress(({ jobId, ratio }) => {
    const job = jobs.get(jobId);
    if (!job) return;
    applyTranscribeStatus(jobId, {
      state: 'running', phase: 'recognizing', ratio,
      completedWorkSec: ratio, totalWorkSec: 1,
      completed: Math.round(ratio * 100), total: 100,
    });
  });
}

// 声紋計算の進捗
window.api.onEmbedProgress(({ jobId, ratio }) => {
  const job = jobs.get(jobId);
  if (!job) return;
  const ep = job.el.querySelector('.embed-progress');
  ep.querySelector('.bar').style.width = `${Math.round(ratio * 100)}%`;
  if (job.embedStartTime) ep.querySelector('.embed-eta').textContent = etaText(job.embedStartTime, ratio);
});

function onJobDone(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  stopProgressTimer(job);
  job.isTranscribing = false;
  job.rawResult = result;
  job.result = applyLockedCorrections(job, result);
  job.resultRevision = (job.resultRevision || 0) + 1;
  job.savedResultRevision = 0;
  job.names = {};            // 話者ID -> 名前
  job.anchors = new Map();   // 区間index -> 手本として割り当てた話者ID
  job.maxSpeaker = -1;       // まだ話者なし
  job.tagging = false;       // 話者タグ付けモード

  const el = job.el;
  el.querySelector('.progress-wrap').classList.add('hidden');
  const status = el.querySelector('.job-status');
  status.textContent = '完了';
  status.classList.remove('error', 'warning');
  status.classList.add('done');
  el.querySelector('.job-result').classList.remove('hidden');

  // 結果欄の再生プレイヤー。各区間の ▶ もこの要素をシークして鳴らすので、
  // ここが唯一の音源になる。
  // 操作系のハンドラは addJob で一度だけ登録済み（やり直しでの二重登録を避けるため）。
  loadResultAudio(job);
  if (!job.result.segments.length) el.querySelector('.tag-btn').classList.add('hidden');
  // リアルタイム録音由来のジョブは、やり直し後も「録音を保存」を出し続ける
  el.querySelector('.save-audio-btn').classList.toggle('hidden', !job.isRecording);

  renderResult(jobId);
  reportUnsavedState();
}

// 結果欄の音源を Blob URL として読み込む。
// app-media URL を <audio> に直接渡すと、区間の頭出し（シーク）の瞬間に
// MEDIA_ERR_NETWORK で落ちる（src/main/mediaProtocol.js の注記参照）。
// IPC でファイルの中身を受け取り Blob にすれば、シークはメモリ内で完結して安定する。
// （fetch(app-media://…) は file:// ページからだと Chromium に拒否されるので使えない）
async function loadResultAudio(job) {
  const audio = job.el.querySelector('.audio-result');
  try {
    const objectUrl = await createAudioObjectUrl(job.result.filePath);
    replaceAudioObjectUrl(audio, job, '_audioObjectUrl', objectUrl);
  } catch (e) {
    // 取得に失敗したら直接 URL で読む（再生は可能・シークは不安定）
    console.warn('media read failed, falling back to direct URL', e);
    audio.src = window.api.mediaUrl(job.result.filePath);
  }
}

function seedCorrectionSpeakers(job) {
  const speakerIds = new Map();
  job.result.segments.forEach((segment, index) => {
    if (!segment.lockedCorrection || !segment.correctionSpeakerKey) return;
    let speakerId = speakerIds.get(segment.correctionSpeakerKey);
    if (speakerId == null) {
      speakerId = ++job.maxSpeaker;
      speakerIds.set(segment.correctionSpeakerKey, speakerId);
      job.names[speakerId] = segment.correctionSpeakerName || `話者${speakerId + 1}`;
    }
    segment.speaker = speakerId;
    job.anchors.set(index, speakerId);
  });
}

// 話者タグ付けモードに入る（声紋を遅延計算してから編集UIを出す）
async function enterTaggingMode(jobId) {
  const job = jobs.get(jobId);
  const el = job.el;
  const tagBtn = el.querySelector('.tag-btn');
  tagBtn.disabled = true;
  const ep = el.querySelector('.embed-progress');
  job.isEmbedding = true;
  reportUnsavedState();
  ep.classList.remove('hidden');
  ep.querySelector('.embed-eta').textContent = '';
  job.embedStartTime = Date.now();
  try {
    await window.api.computeEmbeddings(jobId, job.result.filePath, job.denoiseStrength || 0, job.result.segments);
    job.tagging = true;
    seedCorrectionSpeakers(job);
    if (job.maxSpeaker < 0) job.maxSpeaker = 0; // 最初の話者を用意
    ep.classList.add('hidden');
    tagBtn.classList.add('hidden');
    el.querySelector('.merge-toggle').classList.remove('hidden'); // まとめ設定は話者識別後のみ
    el.querySelector('.diar-edit').classList.remove('hidden');
    renderResult(jobId);
  } catch (e) {
    ep.querySelector('.embed-label').textContent = `声紋解析に失敗: ${e.message}`;
    tagBtn.disabled = false;
  } finally {
    job.isEmbedding = false;
    reportUnsavedState();
  }
}

// 結果（メタ・話者バー・区間リスト）を再描画
function renderResult(jobId) {
  const job = jobs.get(jobId);
  const result = job.result;
  const el = job.el;

  let meta = `長さ ${fmtTime(result.duration)} ・ ${result.segments.length} 区間`;
  if (result.overlap && result.overlap.recovered > 0) {
    meta += ` ・ 重なり補正 ${result.overlap.recovered} 区間`;
  } else if (result.overlap && result.overlap.skipped) {
    meta += ' ・ 重なり解析スキップ';
  } else if (result.overlap && result.overlap.error) {
    meta += ' ・ 重なり補正失敗';
  }
  if (job.tagging) {
    const used = new Set(result.segments.map((s) => s.speaker).filter((x) => x != null && x >= 0));
    meta += ` ・ 話者 ${used.size} 人`;
  }
  el.querySelector('.meta').textContent = meta;

  if (job.tagging) renderSpeakersBar(jobId);

  // 行を作り直すと再生中ボタンの参照が失われるので、先に止めておく
  stopSegmentPlayback(job);

  const segEl = el.querySelector('.segments');
  segEl.innerHTML = '';
  if (!result.segments.length) {
    segEl.innerHTML = '<div class="seg"><span class="txt">（発話を検出できませんでした）</span></div>';
    return;
  }
  result.segments.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'seg';
    if (s.overlapRecovered) row.classList.add('overlap-recovered');
    if (s.lockedCorrection) row.classList.add('locked-correction');

    // ▶ は常時表示（話者タグ付け中でなくても区間を聴き返せるように）
    const play = document.createElement('button');
    play.className = 'seg-play';
    play.textContent = '▶';
    play.title = 'この区間を再生';
    play.addEventListener('click', () => playSegment(jobId, s, play));
    row.appendChild(play);

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTime(s.start);
    row.appendChild(ts);

    if (job.tagging) row.appendChild(buildSpeakerSelect(jobId, idx, s));

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = s.text;
    row.appendChild(txt);
    if (s.overlapRecovered) {
      const badge = document.createElement('span');
      badge.className = 'overlap-badge';
      badge.textContent = '重なり補正';
      badge.title = '話者の重なりを検出し、境界を変えて再認識した区間です';
      row.appendChild(badge);
    }
    if (s.lockedCorrection) {
      const badge = document.createElement('span');
      badge.className = 'locked-correction-badge';
      badge.textContent = '修正済み';
      badge.title = 'この文章はユーザーの修正内容として確定されています';
      row.appendChild(badge);
    }
    segEl.appendChild(row);
  });
}

// 区間の話者割当セレクト（変更＝手本アンカー）。初期は「未割当」。
function buildSpeakerSelect(jobId, idx, seg) {
  const job = jobs.get(jobId);
  const sel = document.createElement('select');
  sel.className = 'seg-spk';

  const oNone = document.createElement('option');
  oNone.value = ''; oNone.textContent = '未割当';
  sel.appendChild(oNone);
  for (let id = 0; id <= job.maxSpeaker; id++) {
    const o = document.createElement('option');
    o.value = String(id);
    o.textContent = speakerLabel(job, id);
    sel.appendChild(o);
  }
  const oNew = document.createElement('option');
  oNew.value = 'new'; oNew.textContent = '＋ 新しい話者';
  sel.appendChild(oNew);

  const cur = seg.speaker;
  sel.value = (cur != null && cur >= 0) ? String(cur) : '';
  const applyStyle = () => {
    if (sel.value === '' || sel.value === 'new') {
      sel.style.color = ''; sel.style.background = '';
      sel.classList.toggle('unknown', cur != null && cur < 0);
      if (cur != null && cur < 0) sel.value = ''; // 不明は未割当表示にしない→下で別処理
    } else {
      sel.style.color = '#fff'; sel.style.background = speakerColor(parseInt(sel.value, 10));
    }
  };
  // 不明（-1）は専用表示
  if (cur != null && cur < 0) {
    const oUnknown = document.createElement('option');
    oUnknown.value = '-1'; oUnknown.textContent = '話者不明';
    sel.insertBefore(oUnknown, oNew);
    sel.value = '-1';
    sel.style.color = '#fff'; sel.style.background = speakerColor(-1);
  } else {
    applyStyle();
  }
  if (job.anchors.has(idx)) sel.classList.add('anchored');

  sel.addEventListener('change', () => {
    let id;
    if (sel.value === 'new') { id = ++job.maxSpeaker; }
    else if (sel.value === '') { id = null; }
    else { id = parseInt(sel.value, 10); }
    seg.speaker = id;
    if (id != null && id >= 0) job.anchors.set(idx, id); // 手で選んだら手本に
    else job.anchors.delete(idx);
    markJobResultChanged(job);
    renderResult(jobId);
  });
  return sel;
}

// 話者名の編集バー
function renderSpeakersBar(jobId) {
  const job = jobs.get(jobId);
  const bar = job.el.querySelector('.speakers-bar') || (() => {
    const b = document.createElement('div'); b.className = 'speakers-bar';
    job.el.querySelector('.diar-tools').before(b); return b;
  })();
  bar.innerHTML = '';
  for (let id = 0; id <= job.maxSpeaker; id++) {
    const chip = document.createElement('span');
    chip.className = 'spk-chip';
    const dot = document.createElement('span');
    dot.className = 'spk-dot'; dot.style.background = speakerColor(id);
    const inp = document.createElement('input');
    inp.className = 'spk-name';
    inp.value = job.names[id] || `話者${id + 1}`;
    inp.addEventListener('change', () => {
      const next = inp.value.trim() || `話者${id + 1}`;
      if ((job.names[id] || `話者${id + 1}`) !== next) {
        job.names[id] = next;
        markJobResultChanged(job);
      }
      renderResult(jobId);
    });
    chip.appendChild(dot); chip.appendChild(inp);
    bar.appendChild(chip);
  }
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'speaker-add-btn diar-add-speaker';
  addButton.textContent = '＋ 話者を追加';
  addButton.addEventListener('click', () => {
    const newId = ++job.maxSpeaker;
    renderResult(jobId);
    requestAnimationFrame(() => {
      const inputs = job.el.querySelectorAll('.speakers-bar .spk-name');
      if (inputs[newId]) inputs[newId].focus();
    });
  });
  bar.appendChild(addButton);
}

// ---- 区間再生 ----
// 基本は結果欄の <audio>（元ファイルそのもの）を区間の開始位置へシークし、
// 終了時刻で止める。クリップ生成が不要なので即座に鳴る。
// ただし Chromium が元ファイルを再生できない形式（一部の動画コンテナ等）もあるため、
// その場合は従来どおり ffmpeg でクリップを作って鳴らす方式へ自動的に切り替える。
function stopSegmentPlayback(job) {
  if (job._segStop) { job._segStop(); job._segStop = null; }
}

async function playSegmentViaFullAudio(job, seg, btn) {
  const audio = job.el.querySelector('.audio-result');
  stopSegmentPlayback(job);

  const onTimeUpdate = () => { if (audio.currentTime >= seg.end) stop(); };
  const stop = () => {
    audio.removeEventListener('timeupdate', onTimeUpdate);
    audio.removeEventListener('pause', stop);
    audio.pause();
    btn.textContent = '▶';
    btn.classList.remove('is-playing');
    job._segStop = null;
  };

  audio.currentTime = seg.start;
  btn.textContent = '■';
  btn.classList.add('is-playing');
  job._segStop = stop;

  // 再生が始まってから監視を付ける。play() 解決前に timeupdate/pause が来ると
  // stop() → pause() が走り、play() が AbortError で落ちる。
  await audio.play();
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('pause', stop);
}

// フォールバック: 区間のクリップを生成して頭から再生（シーク不要で確実）
let sharedAudio = null;
async function playSegmentViaClip(jobId, seg, btn) {
  const job = jobs.get(jobId);
  if (!sharedAudio) sharedAudio = new Audio();
  sharedAudio.pause();
  try {
    if (!seg._clip) {
      btn.textContent = '…';
      const r = await window.api.clipSegment(job.result.filePath, seg.start, seg.end);
      seg._clip = window.api.mediaUrl(r.wavPath);
    }
    btn.textContent = '▶';
    sharedAudio.src = seg._clip;
    sharedAudio.play();
  } catch (e) {
    btn.textContent = '▶';
    console.error('clip play failed', e);
  }
}

async function playSegment(jobId, seg, btn) {
  const job = jobs.get(jobId);
  // 再生中の区間をもう一度押したら停止
  if (btn.classList.contains('is-playing')) { stopSegmentPlayback(job); return; }
  if (!job.fullAudioBroken) {
    // play() の reject は「形式が扱えない」とは限らない（連打による中断など）。
    // クリップ方式への切り替えは <audio> の error イベントだけで判断する。
    try {
      await playSegmentViaFullAudio(job, seg, btn);
    } catch (e) {
      stopSegmentPlayback(job);
      console.warn('segment playback interrupted', e);
    }
    return;
  }
  await playSegmentViaClip(jobId, seg, btn);
}

// 手本（アンカー）で再識別
async function doReassign(jobId) {
  const job = jobs.get(jobId);
  const statusEl = job.el.querySelector('.reassign-status');
  if (!job.anchors.size) { statusEl.textContent = 'まず確かな区間に話者を割り当ててください'; return; }
  // references: { 話者ID: [区間index,...] }
  const refs = {};
  for (const [idx, sid] of job.anchors) { (refs[sid] = refs[sid] || []).push(idx); }
  statusEl.textContent = '再識別中…';
  job.isReassigning = true;
  reportUnsavedState();
  try {
    const { labels, speakerCount } = await window.api.reassignSpeakers(jobId, refs);
    job.result.segments.forEach((s, i) => { if (labels[i] != null) s.speaker = labels[i]; });
    job.result.speakerCount = speakerCount;
    markJobResultChanged(job);
    renderResult(jobId);
    statusEl.textContent = '再識別しました';
  } catch (e) {
    statusEl.textContent = `失敗: ${e.message}`;
  } finally {
    job.isReassigning = false;
    reportUnsavedState();
  }
}

// 「同じ話者をまとめる」がONか（話者タグ付け中のみ有効）
function mergeEnabled(job) {
  return job.tagging && job.el.querySelector('.merge-spk').checked;
}

// 連続する同一話者の区間を1つにまとめる（shared/export.js の mergeSameSpeaker と同じ規則）
function mergeSameSpeaker(segments) {
  const join = (a, b) => (!a ? b : !b ? a : (a.endsWith('。') ? `${a}${b}` : `${a}。${b}`));
  const out = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && s.speaker != null && s.speaker >= 0 && prev.speaker === s.speaker) {
      prev.end = s.end;
      prev.text = join(prev.text, s.text);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// エクスポート/コピー用に話者名を埋め込んだ結果を作る
function exportPayload(job) {
  return { ...job.result, speakerNames: { ...job.names }, mergeSpeakers: mergeEnabled(job) };
}
// 秒 -> "HH:MM:SS"（コピー用の時刻プレフィックス。export.js の formatClock と揃える）
function fmtClock(sec) {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
function plainTextWithSpeakers(job) {
  const segments = mergeEnabled(job) ? mergeSameSpeaker(job.result.segments) : job.result.segments;
  return segments.map((s) => {
    const ts = `[${fmtClock(s.start)} --> ${fmtClock(s.end)}] `;
    const n = job.tagging ? speakerLabel(job, s.speaker) : '';
    return ts + (n ? `${n}: ${s.text}` : s.text);
  }).join('\n');
}

function onJobError(jobId, err) {
  const job = jobs.get(jobId);
  if (!job) return;
  stopProgressTimer(job);
  job.isTranscribing = false;
  job.el.querySelector('.progress-wrap').classList.add('hidden');
  const status = job.el.querySelector('.job-status');
  const msg = String(err.message || err);
  const info = job.errorInfo || transcriptionProgress.describeError(
    err,
    job.currentProgress && job.currentProgress.phase,
    msg.includes('中止'),
  );
  const cancelled = info.cancelled || info.code === 'CANCELLED';
  status.classList.remove('done', 'warning', 'error');
  status.textContent = cancelled ? '中止しました' : '失敗';
  if (!cancelled) status.classList.add('error');

  const errorBox = job.el.querySelector('.job-error');
  errorBox.classList.toggle('hidden', cancelled);
  if (!cancelled) {
    errorBox.querySelector('.job-error-title').textContent = info.title;
    errorBox.querySelector('.job-error-message').textContent = info.message;
    const phase = job.currentProgress && job.currentProgress.phase;
    const phaseText = phase ? `発生工程: ${transcriptionProgress.phaseMeta(phase).label}\n` : '';
    errorBox.querySelector('.job-error-technical').textContent =
      `コード: ${info.code || 'TRANSCRIBE_FAILED'}\n${phaseText}${info.technical || msg}`;
    errorBox.querySelector('.job-error-details').open = false;
    errorBox.querySelector('.retry-btn').classList.toggle('hidden', info.retryable === false);
  }
  // 失敗・中止したら設定画面に戻し、条件を変えて再実行できるようにする
  job.el.querySelector('.job-setup').classList.remove('hidden');
  job.el.querySelector('.back-btn').classList.toggle('hidden', !job.result);
  reportUnsavedState();
}

// ---- リアルタイム文字起こし（マイク） ----
// renderer: getUserMedia + 16kHz AudioContext + AudioWorklet で 100ms ごとの
// Float32Array チャンクを main へ送る。認識は main 側の専用ワーカーが行い、
// 確定区間が rt:segment イベントで届く。停止すると録音 WAV と全区間が返り、
// 通常のジョブカード（再生・書き出し・話者タグ付け・やり直し）へ合流する。
(() => {
  const deviceSel = $('#rt-device');
  const vadSel = $('#rt-vad');
  const startBtn = $('#rt-start');
  const stopBtn = $('#rt-stop');
  const statusEl = $('#rt-status');
  const liveWrap = $('#rt-live-wrap');
  const liveEl = $('#rt-live');
  const elapsedEl = $('#rt-elapsed');
  const meterBar = $('#rt-meter-bar');
  const modeLocalBtn = $('#mode-local');
  const modeRealtimeBtn = $('#mode-realtime');
  const realtimeSection = $('#realtime');

  let cap = null; // { stream, ctx, src, node, samples, peak, timer }
  let mode = 'local'; // 既定はローカルファイル
  let preparing = null; // rtPrepare の実行中 Promise

  function setModeSwitchEnabled(on) {
    modeLocalBtn.disabled = !on;
    modeRealtimeBtn.disabled = !on;
  }

  // リアルタイムモードへ入った時点で専用ワーカーを事前起動し、録音開始を即時にする
  async function prepareRt() {
    if (mode !== 'realtime' || cap) return;
    if (!modelReady) {
      await refreshModelStatus();
      if (!modelReady) { statusEl.textContent = 'モデルのダウンロード後に利用できます'; return; }
    }
    if (preparing) return preparing;
    statusEl.textContent = '認識モデルを準備中…';
    preparing = window.api.rtPrepare()
      .then(() => {
        // 準備中にローカルへ戻っていたら即解放する
        if (mode === 'realtime') statusEl.textContent = '準備完了';
        else window.api.rtRelease();
      })
      .catch((e) => { statusEl.textContent = `準備に失敗: ${e.message}`; })
      .finally(() => { preparing = null; });
    return preparing;
  }

  // 入力モード切替（ローカルファイル / リアルタイム）。録音中はボタンを無効化している。
  function setMode(next) {
    if (mode === next || cap) return;
    mode = next;
    modeLocalBtn.classList.toggle('is-active', next === 'local');
    modeRealtimeBtn.classList.toggle('is-active', next === 'realtime');
    dropzone.classList.toggle('hidden', next !== 'local');
    realtimeSection.classList.toggle('hidden', next !== 'realtime');
    if (next === 'realtime') {
      prepareRt();
    } else {
      statusEl.textContent = '';
      window.api.rtRelease(); // ワーカーを解放しメモリを返す（録音中は main 側で no-op）
    }
  }
  modeLocalBtn.addEventListener('click', () => setMode('local'));
  modeRealtimeBtn.addEventListener('click', () => setMode('realtime'));

  // 話し方プリセット（組み込み4種 + 保存済みカスタム）。値は VAD_PRESETS を流用する。
  function renderVadChoices() {
    const cur = vadSel.value || 'standard';
    vadSel.replaceChildren(
      new Option('標準', 'standard'),
      new Option('会話・電話', 'conversation'),
      new Option('インタビュー', 'interview'),
      new Option('講演・朗読', 'lecture'),
    );
    customVadPresets.forEach((p) => vadSel.add(new Option(p.name, `custom:${p.id}`)));
    vadSel.value = Array.from(vadSel.options).some((o) => o.value === cur) ? cur : 'standard';
  }
  renderVadChoices();
  vadPresetViews.add({ render: renderVadChoices });
  vadPresetsReady.then(renderVadChoices);

  function rtVadOptions() {
    const v = vadSel.value;
    if (v.startsWith('custom:')) {
      const p = customVadPresets.find((x) => `custom:${x.id}` === v);
      if (p) {
        // 重なり再解析はオフライン処理のためリアルタイムでは使わない
        return {
          preset: 'custom',
          maxSpeechDuration: p.maxSpeechDuration,
          minSilenceDuration: p.minSilenceDuration,
          minSpeechDuration: p.minSpeechDuration,
          threshold: p.threshold,
        };
      }
    }
    return { preset: v };
  }

  // マイク一覧。ラベルは一度マイク許可が下りるまで空のことがある
  async function refreshDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cur = deviceSel.value;
      deviceSel.replaceChildren(new Option('既定のマイク', ''));
      devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
        .forEach((d, i) => deviceSel.add(new Option(d.label || `マイク ${i + 1}`, d.deviceId)));
      if (Array.from(deviceSel.options).some((o) => o.value === cur)) deviceSel.value = cur;
    } catch (_) { /* 取得できなくても既定マイクで動ける */ }
  }
  refreshDevices();
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  function setIdleUi() {
    startBtn.classList.remove('hidden');
    startBtn.disabled = false;
    stopBtn.classList.add('hidden');
    deviceSel.disabled = false;
    vadSel.disabled = false;
    setModeSwitchEnabled(true);
  }

  async function cleanupCapture() {
    if (!cap) return;
    const c = cap;
    cap = null; // 以降に届く worklet チャンクは捨てる
    clearInterval(c.timer);
    try { c.src.disconnect(); } catch (_) { /* ignore */ }
    try { c.node.disconnect(); } catch (_) { /* ignore */ }
    try { await c.ctx.close(); } catch (_) { /* ignore */ }
    c.stream.getTracks().forEach((t) => t.stop());
  }

  startBtn.addEventListener('click', async () => {
    if (cap) return;
    if (!modelReady) {
      await refreshModelStatus();
      if (!modelReady) { alert('先にモデルをダウンロードしてください。'); return; }
    }
    startBtn.disabled = true;
    setModeSwitchEnabled(false);
    statusEl.textContent = 'マイクを準備中…';
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceSel.value ? { exact: deviceSel.value } : undefined,
          channelCount: 1,
        },
      });
      refreshDevices(); // 許可後はラベル付きで一覧を取り直せる
      // モード進入時に事前準備済みなら即開始。準備中なら完了を待つ
      if (preparing) { statusEl.textContent = '認識モデルを準備中…'; await preparing; }
      await window.api.rtStart({ vad: rtVadOptions() });
    } catch (e) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      statusEl.textContent = '';
      startBtn.disabled = false;
      setModeSwitchEnabled(true);
      alert(`リアルタイム文字起こしを開始できません: ${e.message}`);
      return;
    }

    try {
      // 16kHz を指定すると Chromium がリサンプルする（FFmpeg 不要）
      const ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule('recorder-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
      cap = { stream, ctx, src, node, samples: 0, peak: 0, timer: 0 };
      realtimeRecordingActive = true;
      reportUnsavedState();
      node.port.onmessage = (e) => {
        if (!cap) return;
        const chunk = e.data;
        cap.samples += chunk.length;
        let peak = 0;
        for (let i = 0; i < chunk.length; i++) {
          const v = Math.abs(chunk[i]);
          if (v > peak) peak = v;
        }
        cap.peak = Math.max(peak, cap.peak * 0.7); // 減衰付きピークホールド
        window.api.rtFeed(chunk);
      };
      src.connect(node); // 出力へは繋がない（ハウリング防止）
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      window.api.rtCancel(); // セッションとワーカーを破棄する
      statusEl.textContent = '';
      startBtn.disabled = false;
      setModeSwitchEnabled(true);
      alert(`マイク音声の取得を開始できません: ${e.message}`);
      prepareRt(); // 次の録音開始を即時にできるよう作り直しておく
      return;
    }

    liveEl.innerHTML = '';
    liveWrap.classList.remove('hidden');
    elapsedEl.textContent = '00:00';
    meterBar.style.width = '0%';
    cap.timer = setInterval(() => {
      if (!cap) return;
      elapsedEl.textContent = fmtTime(cap.samples / 16000);
      meterBar.style.width = `${Math.min(100, Math.round(cap.peak * 140))}%`;
    }, 200);

    startBtn.classList.add('hidden');
    startBtn.disabled = false;
    stopBtn.classList.remove('hidden');
    stopBtn.disabled = false;
    deviceSel.disabled = true;
    vadSel.disabled = true;
    statusEl.textContent = '録音中';
  });

  window.api.onRtSegment((ev) => {
    if (!cap) return;
    if (ev.kind === 'seg') {
      const row = document.createElement('div');
      row.className = 'seg';
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmtTime(ev.start);
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = ev.text;
      row.append(ts, txt);
      liveEl.appendChild(row);
      liveEl.scrollTop = liveEl.scrollHeight;
    } else if (ev.kind === 'segError') {
      statusEl.textContent = `一部の区間の認識に失敗: ${ev.message}`;
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (!cap) return;
    stopBtn.disabled = true;
    statusEl.textContent = '仕上げ中…（末尾の認識と録音の保存）';
    await cleanupCapture();
    try {
      const r = await window.api.rtStop();
      addRealtimeResultJob(r);
      // ワーカーは main 側で保持されたままなので、次の録音もすぐ開始できる
      statusEl.textContent = '準備完了';
      liveWrap.classList.add('hidden');
    } catch (e) {
      statusEl.textContent = `停止に失敗: ${e.message}`;
    }
    realtimeRecordingActive = false;
    reportUnsavedState();
    setIdleUi();
  });

  // 設定変更・ワーカー落ちなどでセッションが main 側から止められた場合
  window.api.onRtError(async ({ message }) => {
    await cleanupCapture();
    realtimeRecordingActive = false;
    reportUnsavedState();
    statusEl.textContent = `リアルタイム文字起こしが中断されました: ${message}`;
    setIdleUi();
  });
})();

// リアルタイム録音の結果を通常のジョブカードとして表示する。
// 設定画面（プレビュー・VAD・やり直し）と結果画面のすべてがそのまま使え、
// 「設定を変えてやり直す」は録音 WAV をバッチパイプラインで再解析する。
function addRealtimeResultJob(r) {
  const jobId = addJob(r.wavPath, { name: r.name, deferPreview: true });
  const job = jobs.get(jobId);
  job.isRecording = true;
  job.el.querySelector('.job-setup').classList.add('hidden');
  onJobDone(jobId, {
    segments: r.segments,
    text: r.segments.map((s) => s.text).join('\n'),
    duration: r.duration,
    filePath: r.wavPath,
    name: r.name,
    jobId,
  });
}

// ---- アプリ設定 ----
(() => {
  const modal = $('#settings-modal');
  const openBtn = $('#settings-btn');
  const confirmToggle = $('#confirm-unsaved-close');
  const status = $('#settings-status');

  async function loadPreferences() {
    try {
      const prefs = await window.api.getAppPreferences();
      confirmToggle.checked = prefs.confirmOnCloseWithUnsaved !== false;
      status.textContent = '';
    } catch (error) {
      status.textContent = `設定を読み込めませんでした: ${error.message || error}`;
    }
  }

  async function openModal() {
    modal.classList.remove('hidden');
    await loadPreferences();
    confirmToggle.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
    openBtn.focus();
  }

  confirmToggle.addEventListener('change', async () => {
    const next = confirmToggle.checked;
    confirmToggle.disabled = true;
    status.textContent = '保存中…';
    try {
      const prefs = await window.api.setAppPreferences({ confirmOnCloseWithUnsaved: next });
      confirmToggle.checked = prefs.confirmOnCloseWithUnsaved !== false;
      status.textContent = '変更しました';
    } catch (error) {
      confirmToggle.checked = !next;
      status.textContent = `保存できませんでした: ${error.message || error}`;
    } finally {
      confirmToggle.disabled = false;
    }
  });

  openBtn.addEventListener('click', openModal);
  modal.querySelectorAll('[data-settings-close]').forEach((node) => node.addEventListener('click', closeModal));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });
  loadPreferences();
})();

// ---- このアプリについて / ライセンス（About モーダル） ----
(() => {
  const modal = $('#about-modal');
  const openBtn = $('#about-btn');
  const mainView = modal.querySelector('.about-main');
  const licView = modal.querySelector('.about-license');
  const licText = modal.querySelector('.lic-text');
  const verEl = $('#about-version');
  let versionLoaded = false;

  function showList() {
    licView.classList.add('hidden');
    mainView.classList.remove('hidden');
  }
  async function openModal() {
    showList();
    modal.classList.remove('hidden');
    if (!versionLoaded) {
      try {
        const info = await window.api.appInfo();
        verEl.textContent = `v${info.version}（Electron ${info.electron} / Node ${info.node}）`;
        versionLoaded = true;
      } catch (_) { /* 情報取得失敗は無視 */ }
    }
    refreshMaint();
  }

  // ---- メンテナンス（データ初期化 / 完全アンインストール） ----
  const maintSize = $('#maint-size');
  const maintStatus = $('#maint-status');
  const resetBtn = $('#reset-data-btn');
  const uninstallBtn = $('#uninstall-btn');

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  async function refreshMaint() {
    try {
      const info = await window.api.dataInfo();
      maintSize.textContent = fmtBytes(info.bytes);
      resetBtn.disabled = false;
      if (info.canUninstall) {
        uninstallBtn.disabled = false;
        uninstallBtn.title = '';
      } else {
        uninstallBtn.disabled = true;
        uninstallBtn.title = 'アンインストーラが見つからないため無効です（開発実行中など）';
      }
    } catch (_) {
      maintSize.textContent = '不明';
    }
  }

  resetBtn.addEventListener('click', async () => {
    if (!confirm(
      'モデル・設定・用語辞書・一時ファイルをすべて削除します。\n'
      + 'アプリ本体は残り、次回の文字起こし時にモデルの再ダウンロードが必要になります。\n\n'
      + '実行しますか？（元に戻せません）'
    )) return;
    resetBtn.disabled = true; uninstallBtn.disabled = true;
    maintStatus.textContent = '削除中…';
    try {
      await window.api.wipeData();
      maintStatus.textContent = '削除しました。次回起動時にモデルの再取得が必要です。';
      modelReady = false;
      refreshModelStatus();
    } catch (e) {
      maintStatus.textContent = `失敗: ${e.message}`;
    } finally {
      refreshMaint();
    }
  });

  uninstallBtn.addEventListener('click', async () => {
    if (!confirm(
      '【完全にアンインストール】\n'
      + 'アプリ本体とすべてのデータ（モデル・設定・辞書）を削除し、アプリを終了します。\n\n'
      + '本当に実行しますか？'
    )) return;
    if (!confirm('この操作は元に戻せません。最終確認：完全にアンインストールしますか？')) return;
    uninstallBtn.disabled = true; resetBtn.disabled = true;
    maintStatus.textContent = 'アンインストールしています。まもなくアプリが終了します…';
    try {
      await window.api.uninstall();
    } catch (e) {
      maintStatus.textContent = `失敗: ${e.message}`;
      refreshMaint();
    }
  });
  function closeModal() { modal.classList.add('hidden'); }

  openBtn.addEventListener('click', openModal);
  modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

  // 各ボタン（ライセンス全文 / Chromium一覧 / 外部リンク）をイベント委譲で処理
  modal.addEventListener('click', async (e) => {
    const btn = e.target.closest('.lic-btn');
    if (btn) {
      if (btn.dataset.license) {
        try {
          licText.textContent = await window.api.readLicense(btn.dataset.license);
          mainView.classList.add('hidden');
          licView.classList.remove('hidden');
          modal.querySelector('.modal-body').scrollTop = 0;
        } catch (err) { alert(`ライセンスの読み込みに失敗: ${err.message}`); }
      } else if (btn.dataset.chromium !== undefined) {
        try { await window.api.openChromiumLicenses(); }
        catch (err) { alert(err.message); }
      } else if (btn.dataset.url) {
        window.api.openExternal(btn.dataset.url);
      }
      return;
    }
    if (e.target.closest('.lic-back')) showList();
  });
})();

// ---- アップデート（electron-updater。ハイブリッド運用） ----
(() => {
  const banner = $('#update-banner');
  const bannerText = $('#update-banner-text');
  const dlBtn = $('#update-download-btn');
  const installBtn = $('#update-install-btn');
  const dismissBtn = $('#update-dismiss-btn');
  const bannerProgress = $('#update-progress');
  const checkBtn = $('#check-update-btn');
  const modalStatus = $('#update-modal-status');

  let latestVersion = '';

  function setModal(text) { if (modalStatus) modalStatus.textContent = text; }
  function showBanner() { banner.classList.remove('hidden'); }

  window.api.onUpdateStatus((p) => {
    switch (p.state) {
      case 'checking':
        setModal('確認中…');
        break;
      case 'available':
        latestVersion = p.version;
        bannerText.textContent = `新しいバージョン v${p.version} が利用可能です。`;
        dlBtn.classList.remove('hidden');
        dlBtn.disabled = false;
        dlBtn.textContent = 'ダウンロード';
        installBtn.classList.add('hidden');
        showBanner();
        setModal(`v${p.version} が利用可能です`);
        break;
      case 'none':
        setModal(`最新版です（v${p.version}）`);
        break;
      case 'downloaded':
        bannerText.textContent = `v${p.version} の準備ができました。再起動して更新します。`;
        bannerProgress.classList.add('hidden');
        dlBtn.classList.add('hidden');
        installBtn.classList.remove('hidden');
        showBanner();
        setModal('ダウンロード完了。再起動で更新できます');
        break;
      case 'error':
        setModal(`更新の確認に失敗: ${p.message}`);
        break;
      default:
        break;
    }
  });

  window.api.onUpdateProgress((p) => {
    const pct = Math.round(p.percent || 0);
    bannerProgress.classList.remove('hidden');
    bannerProgress.querySelector('.bar').style.width = `${pct}%`;
    dlBtn.disabled = true;
    dlBtn.textContent = `ダウンロード中… ${pct}%`;
  });

  dlBtn.addEventListener('click', async () => {
    dlBtn.disabled = true;
    dlBtn.textContent = 'ダウンロード開始…';
    try { await window.api.downloadUpdate(); }
    catch (e) { setModal(`ダウンロード失敗: ${e.message}`); dlBtn.disabled = false; dlBtn.textContent = 'ダウンロード'; }
  });

  installBtn.addEventListener('click', () => {
    window.api.installUpdate();
  });

  dismissBtn.addEventListener('click', () => banner.classList.add('hidden'));

  checkBtn.addEventListener('click', async () => {
    setModal('確認中…');
    try {
      const r = await window.api.checkUpdate();
      if (r && r.ok === false) {
        setModal('この版では自動更新を利用できません（開発版 / zip 版）。');
      }
      // 見つかった場合は update:status イベント側で banner/status を更新
    } catch (e) {
      setModal(`確認に失敗: ${e.message}`);
    }
  });
})();

refreshModelStatus();
