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
function addJob(filePath) {
  const jobId = ++jobSeq;
  const node = jobTpl.content.cloneNode(true);
  const el = node.querySelector('.job');
  el.querySelector('.job-name').textContent = filePath.split(/[\\/]/).pop();
  el.querySelector('.job-status').textContent = '準備完了';
  jobsEl.prepend(el);
  jobs.set(jobId, { el, filePath, result: null });

  const audioOriginal = el.querySelector('.audio-original');
  const origStatus = el.querySelector('.orig-status');
  const segOpts = Array.from(el.querySelectorAll('.denoise-seg .seg-opt'));
  const previewBtn = el.querySelector('.preview-btn');
  const previewStatus = el.querySelector('.preview-status');
  const denoisedRow = el.querySelector('.denoised-row');
  const audioDenoised = el.querySelector('.audio-denoised');

  // 元音声プレビュー（先頭10秒のクリップを生成して再生）
  (async () => {
    origStatus.textContent = '読み込み中…';
    try {
      const r = await window.api.preview(filePath, ++previewSeq, 0);
      audioOriginal.src = window.api.mediaUrl(r.wavPath) + `?t=${Date.now()}`;
      origStatus.textContent = '';
    } catch (e) {
      origStatus.textContent = `読み込み失敗: ${e.message}`;
    }
  })();

  // ノイズ除去の強さは「なし/弱/中/強」のセグメントボタンで選ぶ（ネイティブ
  // <select> のポップアップに依存しないので、どの状態でも必ず切り替えられる）。
  let denoiseStrength = 0.8; // 既定「中」（HTML の is-active と一致）
  let previewReq = 0;        // このジョブの最新プレビュー要求ID（古い応答を捨てる）

  function setDenoise(v) {
    denoiseStrength = v;
    segOpts.forEach((b) => b.classList.toggle('is-active', parseFloat(b.dataset.value) === v));
    // 別強度で作った「除去後」プレビューは無効 → 破棄して、その強度で再プレビューできる状態に戻す
    previewReq++;
    audioDenoised.pause();
    audioDenoised.removeAttribute('src');
    audioDenoised.load();
    denoisedRow.classList.add('hidden');
    previewStatus.textContent = '';
    previewBtn.disabled = false;
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
      audioDenoised.src = window.api.mediaUrl(r.wavPath) + `?t=${Date.now()}`;
      denoisedRow.classList.remove('hidden');
      previewStatus.textContent = '生成しました';
    } catch (e) {
      if (myReq === previewReq) previewStatus.textContent = `失敗: ${e.message}`;
    } finally {
      if (myReq === previewReq) previewBtn.disabled = false;
    }
  });

  // 文字起こし開始
  el.querySelector('.start-btn').addEventListener('click', () => {
    startTranscribe(jobId, filePath, { denoiseStrength });
  });
}

function startTranscribe(jobId, filePath, opts) {
  const job = jobs.get(jobId);
  job.denoiseStrength = opts.denoiseStrength || 0; // 後付け声紋計算で同条件にする
  const el = job.el;
  el.querySelector('.job-setup').classList.add('hidden');
  el.querySelector('.progress-wrap').classList.remove('hidden');
  const status = el.querySelector('.job-status');
  status.textContent = opts.denoiseStrength > 0 ? '処理中…（ノイズ除去）' : '処理中…';
  job.startTime = Date.now();               // 残り時間推定の基点
  el.querySelector('.eta').textContent = '';

  el.querySelector('.cancel-btn').addEventListener('click', () => {
    window.api.cancelTranscribe(jobId);
    status.textContent = '中止中…';
  });

  window.api.transcribe(filePath, jobId, opts)
    .then((result) => onJobDone(jobId, result))
    .catch((err) => onJobError(jobId, err));
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

  // 「話者でタグ付け」開始
  const tagBtn = el.querySelector('.tag-btn');
  if (result.segments.length) {
    tagBtn.addEventListener('click', () => enterTaggingMode(jobId));
  } else {
    tagBtn.classList.add('hidden');
  }
  el.querySelector('.reassign-btn').addEventListener('click', () => doReassign(jobId));

  renderResult(jobId);

  el.querySelectorAll('.toolbar button[data-fmt]').forEach((btn) => {
    btn.addEventListener('click', () => window.api.saveExport(exportPayload(job), btn.dataset.fmt));
  });
  el.querySelector('.copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(plainTextWithSpeakers(job));
  });
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
  if (job.tagging) {
    const used = new Set(result.segments.map((s) => s.speaker).filter((x) => x != null && x >= 0));
    meta += ` ・ 話者 ${used.size} 人`;
  }
  el.querySelector('.meta').textContent = meta;

  if (job.tagging) renderSpeakersBar(jobId);

  const segEl = el.querySelector('.segments');
  segEl.innerHTML = '';
  if (!result.segments.length) {
    segEl.innerHTML = '<div class="seg"><span class="txt">（発話を検出できませんでした）</span></div>';
    return;
  }
  result.segments.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'seg';

    if (job.tagging) {
      const play = document.createElement('button');
      play.className = 'seg-play';
      play.textContent = '▶';
      play.title = 'この区間を再生';
      play.addEventListener('click', () => playSegment(jobId, s, play));
      row.appendChild(play);
    }

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTime(s.start);
    row.appendChild(ts);

    if (job.tagging) row.appendChild(buildSpeakerSelect(jobId, idx, s));

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = s.text;
    row.appendChild(txt);
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

// 区間のクリップを生成して頭から再生（シーク不要で確実）
let sharedAudio = null;
async function playSegment(jobId, seg, btn) {
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

// エクスポート/コピー用に話者名を埋め込んだ結果を作る
function exportPayload(job) {
  return { ...job.result, speakerNames: { ...job.names } };
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
  return job.result.segments.map((s) => {
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

refreshModelStatus();
