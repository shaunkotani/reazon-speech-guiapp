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

let modelReady = false;
let jobSeq = 0;
let previewSeq = 0; // プレビュー生成リクエストの一意ID
const jobs = new Map(); // jobId -> { el, filePath, result }

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
  try { await window.api.setHighAccuracy(userHighAccuracy); }
  catch (e) { alert(`高精度モードの保存に失敗: ${e.message}`); }
});

hwScore.addEventListener('input', () => { hwScoreVal.textContent = Number(hwScore.value).toFixed(1); });
hwText.addEventListener('input', updateHotwordsSummary);
hwEnabled.addEventListener('change', updateHotwordsSummary);

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
    syncAccuracyUI();
    updateHotwordsSummary();
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
    syncAccuracyUI();
    updateHotwordsSummary();
  } catch (_) { /* 起動直後は無視 */ }
})();

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

function addJob(filePath, { name = '', deferPreview = false } = {}) {
  const jobId = ++jobSeq;
  const node = jobTpl.content.cloneNode(true);
  const el = node.querySelector('.job');
  el.querySelector('.job-name').textContent = name || filePath.split(/[\\/]/).pop();
  el.querySelector('.job-status').textContent = '準備完了';
  jobsEl.prepend(el);
  jobs.set(jobId, { el, filePath, result: null });
  const job = jobs.get(jobId);

  const audioOriginal = el.querySelector('.audio-original');
  const origStatus = el.querySelector('.orig-status');
  const segOpts = Array.from(el.querySelectorAll('.denoise-seg .seg-opt'));
  const previewBtn = el.querySelector('.preview-btn');
  const previewStatus = el.querySelector('.preview-status');
  const denoisedRow = el.querySelector('.denoised-row');
  const audioDenoised = el.querySelector('.audio-denoised');

  // 元音声プレビュー（先頭10秒のクリップを生成して再生）。
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
  }
  segOpts.forEach((b) => b.addEventListener('click', () => setDenoise(parseFloat(b.dataset.value))));

  // 除去後プレビュー生成（先頭10秒）
  previewBtn.addEventListener('click', async () => {
    if (denoiseStrength <= 0) { alert('「ノイズ除去」を弱/中/強のいずれかにしてください。'); return; }
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
  const vadSeg = Array.from(el.querySelectorAll('.vad-seg .seg-opt'));
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

  let presetSource = { kind: 'builtin', id: 'standard' };

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
  }

  function applyBuiltInPreset(name) {
    const p = VAD_PRESETS[name];
    if (!p) return;
    presetSource = { kind: 'builtin', id: name };
    applyPresetValues(p);
    vadSeg.forEach((b) => b.classList.toggle('is-active', b.dataset.preset === name));
    savedSelect.value = '';
    presetName.value = '';
    deletePresetBtn.disabled = true;
    vadPresetNote.textContent = p.note;
    savePresetStatus.textContent = '';
  }

  function applySavedPreset(id) {
    const p = customVadPresets.find((item) => item.id === id);
    if (!p) return;
    presetSource = { kind: 'custom', id: p.id };
    applyPresetValues(p);
    vadSeg.forEach((b) => b.classList.remove('is-active'));
    savedSelect.value = p.id;
    presetName.value = p.name;
    deletePresetBtn.disabled = false;
    vadPresetNote.textContent = `保存した設定「${p.name}」`;
    savePresetStatus.textContent = '';
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
    vadBadge.classList.toggle('hidden', same);
  }

  function renderSavedPresets() {
    const selected = presetSource.kind === 'custom' ? presetSource.id : '';
    const placeholder = new Option('保存済みプリセット', '');
    placeholder.disabled = true;
    savedSelect.replaceChildren(placeholder);
    customVadPresets.forEach((p) => savedSelect.add(new Option(p.name, p.id)));
    savedSelect.disabled = customVadPresets.length === 0;
    savedSelect.value = customVadPresets.some((p) => p.id === selected) ? selected : '';
  }

  const presetView = { render: renderSavedPresets };
  vadPresetViews.add(presetView);
  vadPresetsReady.then(renderSavedPresets);

  vadSeg.forEach((b) => b.addEventListener('click', () => applyBuiltInPreset(b.dataset.preset)));
  savedSelect.addEventListener('change', () => {
    if (savedSelect.value) applySavedPreset(savedSelect.value);
  });
  [vadMax, vadSil, vadMinSpeech, vadTh].forEach((s) => s.addEventListener('input', markCustom));
  overlapAware.addEventListener('change', () => { syncOverlapUi(); markCustom(); });
  overlapSpeakers.addEventListener('change', markCustom);
  el.querySelector('.vad-reset').addEventListener('click', () => {
    if (presetSource.kind === 'custom') applySavedPreset(presetSource.id);
    else applyBuiltInPreset(presetSource.id);
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
      applyBuiltInPreset('standard');
    } catch (e) {
      savePresetStatus.textContent = `削除失敗: ${e.message}`;
      deletePresetBtn.disabled = false;
    }
  });

  applyBuiltInPreset('standard');

  const vadOptions = () => ({
    preset: presetSource.kind === 'builtin' ? presetSource.id : 'custom',
    maxSpeechDuration: Number(vadMax.value),
    minSilenceDuration: Number(vadSil.value),
    minSpeechDuration: Number(vadMinSpeech.value),
    threshold: Number(vadTh.value),
    overlapAware: overlapAware.checked,
    overlapSpeakers: Number(overlapSpeakers.value),
  });

  // 文字起こし開始
  el.querySelector('.start-btn').addEventListener('click', () => {
    startTranscribe(jobId, filePath, { denoiseStrength, vad: vadOptions() });
  });

  // ---- 結果側の操作は「ジョブ生成時に1回だけ」束ねる ----
  // やり直しで onJobDone が複数回走るため、ここ以外で addEventListener すると
  // ハンドラが二重登録され、書き出しが2回走るなどの不具合になる。
  el.querySelector('.cancel-btn').addEventListener('click', () => {
    window.api.cancelTranscribe(jobId);
    el.querySelector('.job-status').textContent = '中止中…';
  });
  el.querySelector('.redo-btn').addEventListener('click', () => reopenSetup(jobId));
  el.querySelector('.back-btn').addEventListener('click', () => closeSetup(jobId));
  el.querySelector('.tag-btn').addEventListener('click', () => {
    if (jobs.get(jobId).result) enterTaggingMode(jobId);
  });
  el.querySelector('.reassign-btn').addEventListener('click', () => doReassign(jobId));
  el.querySelectorAll('.toolbar button[data-fmt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const job = jobs.get(jobId);
      if (job.result) window.api.saveExport(exportPayload(job), btn.dataset.fmt);
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
    try { await window.api.rtSaveWav(job.result.filePath, base); }
    catch (e) { alert(`録音の保存に失敗: ${e.message}`); }
  });
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
  status.classList.remove('done', 'error');
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
  status.classList.add('done');
}

function startTranscribe(jobId, filePath, opts) {
  const job = jobs.get(jobId);
  job.denoiseStrength = opts.denoiseStrength || 0; // 後付け声紋計算で同条件にする
  const el = job.el;
  resetResultUi(job);
  el.querySelector('.back-btn').classList.add('hidden');
  el.querySelector('.job-setup').classList.add('hidden');
  el.querySelector('.progress-wrap').classList.remove('hidden');
  el.querySelector('.progress-wrap .bar').style.width = '0%';
  const status = el.querySelector('.job-status');
  status.textContent = opts.denoiseStrength > 0 ? '処理中…（ノイズ除去）' : '処理中…';
  status.classList.remove('done', 'error');
  job.startTime = Date.now();               // 残り時間推定の基点
  el.querySelector('.eta').textContent = '';

  window.api.transcribe(filePath, jobId, opts)
    .then((result) => onJobDone(jobId, result))
    .catch((err) => onJobError(jobId, err));
}

// やり直し時に前回の結果表示を白紙に戻す（話者タグ付けの状態も含めて）。
function resetResultUi(job) {
  const el = job.el;
  stopSegmentPlayback(job);
  job.result = null;
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

window.api.onTranscribeProgress(({ jobId, ratio }) => {
  const job = jobs.get(jobId);
  if (!job) return;
  job.el.querySelector('.progress-wrap .bar').style.width = `${Math.round(ratio * 100)}%`;
  if (job.startTime) job.el.querySelector('.eta').textContent = etaText(job.startTime, ratio);
});

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
  job.result = result;
  job.names = {};            // 話者ID -> 名前
  job.anchors = new Map();   // 区間index -> 手本として割り当てた話者ID
  job.maxSpeaker = -1;       // まだ話者なし
  job.tagging = false;       // 話者タグ付けモード

  const el = job.el;
  el.querySelector('.progress-wrap').classList.add('hidden');
  const status = el.querySelector('.job-status');
  status.textContent = '完了';
  status.classList.add('done');
  el.querySelector('.job-result').classList.remove('hidden');

  // 結果欄の再生プレイヤー。各区間の ▶ もこの要素をシークして鳴らすので、
  // ここが唯一の音源になる。
  // 操作系のハンドラは addJob で一度だけ登録済み（やり直しでの二重登録を避けるため）。
  loadResultAudio(job);
  if (!result.segments.length) el.querySelector('.tag-btn').classList.add('hidden');
  // リアルタイム録音由来のジョブは、やり直し後も「録音を保存」を出し続ける
  el.querySelector('.save-audio-btn').classList.toggle('hidden', !job.isRecording);

  renderResult(jobId);
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

// 話者タグ付けモードに入る（声紋を遅延計算してから編集UIを出す）
async function enterTaggingMode(jobId) {
  const job = jobs.get(jobId);
  const el = job.el;
  const tagBtn = el.querySelector('.tag-btn');
  tagBtn.disabled = true;
  const ep = el.querySelector('.embed-progress');
  ep.classList.remove('hidden');
  ep.querySelector('.embed-eta').textContent = '';
  job.embedStartTime = Date.now();
  try {
    await window.api.computeEmbeddings(jobId, job.result.filePath, job.denoiseStrength || 0, job.result.segments);
    job.tagging = true;
    if (job.maxSpeaker < 0) job.maxSpeaker = 0; // 最初の話者を用意
    ep.classList.add('hidden');
    tagBtn.classList.add('hidden');
    el.querySelector('.merge-toggle').classList.remove('hidden'); // まとめ設定は話者識別後のみ
    el.querySelector('.diar-edit').classList.remove('hidden');
    renderResult(jobId);
  } catch (e) {
    ep.querySelector('.embed-label').textContent = `声紋解析に失敗: ${e.message}`;
    tagBtn.disabled = false;
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
    inp.addEventListener('change', () => { job.names[id] = inp.value.trim() || `話者${id + 1}`; renderResult(jobId); });
    chip.appendChild(dot); chip.appendChild(inp);
    bar.appendChild(chip);
  }
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
  try {
    const { labels, speakerCount } = await window.api.reassignSpeakers(jobId, refs);
    job.result.segments.forEach((s, i) => { if (labels[i] != null) s.speaker = labels[i]; });
    job.result.speakerCount = speakerCount;
    renderResult(jobId);
    statusEl.textContent = '再識別しました';
  } catch (e) {
    statusEl.textContent = `失敗: ${e.message}`;
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
  job.el.querySelector('.progress-wrap').classList.add('hidden');
  const status = job.el.querySelector('.job-status');
  const msg = String(err.message || err);
  status.textContent = msg.includes('中止') ? '中止しました' : `エラー: ${msg}`;
  status.classList.add('error');
  // 失敗・中止したら設定画面に戻し、条件を変えて再実行できるようにする
  job.el.querySelector('.job-setup').classList.remove('hidden');
  job.el.querySelector('.back-btn').classList.toggle('hidden', !job.result);
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
    setIdleUi();
  });

  // 設定変更・ワーカー落ちなどでセッションが main 側から止められた場合
  window.api.onRtError(async ({ message }) => {
    await cleanupCapture();
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
