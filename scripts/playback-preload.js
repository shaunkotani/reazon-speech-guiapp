// scripts/test-renderer-playback.js 用のスタブ preload。
// 本物の preload.js と同じ形の window.api を用意し、認識だけを固定の結果に差し替える。
// （ワーカーやモデルを起動せずに、レンダラの再生まわりだけを検証するため）
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

const SAMPLES = path.join(__dirname, '..', 'samples');
const TARGET = path.join(SAMPLES, 'twospeaksample.mp3');

function mediaUrl(absPath) {
  const enc = absPath.split('/').map(encodeURIComponent).join('/');
  return 'app-media://media' + (enc.startsWith('/') ? enc : '/' + enc);
}

const noop = () => {};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let transcribeStatusListener = noop;
let trialStatusListener = noop;
let autoTuneStatusListener = noop;
let transcribeCalls = 0;
let overlapSkipRequested = false;
let nextAutoTuneFailure = false;
const cancelledAutoTunes = new Set();
let appPreferences = { confirmOnCloseWithUnsaved: true };
let nextExportSaved = true;
let nextAudioSaved = false;
let savedVadPresets = [{
  id: 'short-replies', name: '短い相槌',
  maxSpeechDuration: 3, minSilenceDuration: 0.05, minSpeechDuration: 0.05, threshold: 0.65,
  overlapAware: true, overlapSpeakers: 2,
}];
const RESULT = {
  segments: [
    { start: 0.65, end: 1.99, text: 'はいもしもし' },
    { start: 2.41, end: 8.89, text: 'いやいやいやほんとに何か受け入れてくれてる感じが' },
    { start: 12.36, end: 18.81, text: 'いや何かみんな盛り上がって楽しかった' },
  ],
  text: 'dummy',
  duration: 19.03,
  filePath: TARGET,
  name: path.basename(TARGET),
  jobId: 1,
};
const TRIAL_RESULT = {
  segments: RESULT.segments,
  text: RESULT.text,
  duration: RESULT.duration,
  range: { startSeconds: 0, endSeconds: RESULT.duration, durationSeconds: RESULT.duration, requestedDurationSeconds: 60 },
  filePath: TARGET,
  name: path.basename(TARGET),
  jobId: 1,
};

contextBridge.exposeInMainWorld('api', {
  getAppPreferences: async () => ({ ...appPreferences }),
  setAppPreferences: async (value) => {
    appPreferences = {
      confirmOnCloseWithUnsaved: value.confirmOnCloseWithUnsaved !== false,
    };
    ipcRenderer.send('app-preferences', appPreferences);
    return { ...appPreferences };
  },
  updateUnsavedState: (value) => ipcRenderer.send('unsaved-state', value),
  modelStatus: async () => ({ ready: true, source: 'test' }),
  downloadModel: async () => ({ ready: true }),
  onModelProgress: noop,
  getHotwords: async () => ({ text: '', score: 2, enabled: true, highAccuracy: false }),
  setHotwords: async () => ({ ok: true, count: 0 }),
  setHighAccuracy: async (on) => ({ ok: true, highAccuracy: !!on }),
  getVadPresets: async () => savedVadPresets,
  saveVadPreset: async (value) => {
    const preset = { ...value, id: value.id || `test-${savedVadPresets.length + 1}` };
    const index = savedVadPresets.findIndex((p) => p.id === preset.id || p.name === preset.name);
    if (index >= 0) savedVadPresets[index] = preset; else savedVadPresets.push(preset);
    return { ok: true, preset, presets: savedVadPresets };
  },
  deleteVadPreset: async (id) => {
    savedVadPresets = savedVadPresets.filter((p) => p.id !== id);
    return { ok: true, presets: savedVadPresets };
  },
  openFiles: async () => [TARGET],
  pathForFile: (f) => f.path || TARGET,
  mediaUrl,
  transcribe: async (_filePath, jobId, opts) => {
    transcribeCalls++;
    overlapSkipRequested = false;
    ipcRenderer.send('transcribe-opts', opts);
    transcribeStatusListener({
      jobId, state: 'queued', phase: 'queued', queuePosition: 1, queueTotal: 1,
    });
    await pause(100);
    transcribeStatusListener({ jobId, state: 'running', phase: 'preparing' });
    await pause(20);
    transcribeStatusListener({ jobId, state: 'running', phase: 'decoding' });
    await pause(20);
    if (transcribeCalls === 3) {
      const error = {
        code: 'NO_DISK_SPACE', retryable: true,
        title: '作業用の空き容量が不足しています',
        message: 'ディスクの空き容量を増やしてから、もう一度お試しください。',
        technical: 'ENOSPC: test',
      };
      transcribeStatusListener({ jobId, state: 'error', phase: 'decoding', error });
      throw new Error(error.technical);
    }
    transcribeStatusListener({ jobId, state: 'running', phase: 'vad', totalAudioSec: RESULT.duration });
    transcribeStatusListener({
      jobId, state: 'running', phase: 'overlap', completed: 0, total: 1,
      completedWorkSec: 0, totalWorkSec: RESULT.duration, totalAudioSec: RESULT.duration,
    });
    for (let waited = 0; waited < 300 && !overlapSkipRequested; waited += 10) await pause(10);
    await pause(20);
    transcribeStatusListener({
      jobId, state: 'running', phase: 'recognizing', completed: 0, total: 3,
      completedWorkSec: 0, totalWorkSec: 14.27, totalAudioSec: RESULT.duration, ratio: 0,
    });
    await pause(220);
    transcribeStatusListener({
      jobId, state: 'running', phase: 'recognizing', completed: 2, total: 3,
      completedWorkSec: 7.82, totalWorkSec: 14.27, totalAudioSec: RESULT.duration, ratio: 0.548,
      partial: { index: 0, start: 0.65, end: 1.99, text: 'はいもしもし' },
    });
    await pause(220);
    transcribeStatusListener({ jobId, state: 'running', phase: 'finalizing', completed: 3, total: 3 });
    await pause(20);
    return RESULT;
  },
  cancelTranscribe: async () => true,
  skipTranscribeOverlap: async (jobId) => {
    overlapSkipRequested = true;
    ipcRenderer.send('overlap-skip', jobId);
    return true;
  },
  onTranscribeStatus: (cb) => { transcribeStatusListener = cb; },
  onTranscribeProgress: noop,
  transcribeTrial: async (_filePath, jobId, trialId, opts) => {
    ipcRenderer.send('trial-opts', opts);
    trialStatusListener({ jobId, trialId, state: 'queued', phase: 'queued', queuePosition: 1, queueTotal: 1 });
    await pause(30);
    trialStatusListener({ jobId, trialId, state: 'running', phase: 'decoding' });
    await pause(30);
    trialStatusListener({
      jobId, trialId, state: 'running', phase: 'recognizing', completed: 1, total: 3,
      completedWorkSec: 2, totalWorkSec: 14.27, totalAudioSec: RESULT.duration, ratio: 0.14,
    });
    await pause(40);
    trialStatusListener({ jobId, trialId, state: 'completed', phase: 'finalizing', ratio: 1 });
    return { ...TRIAL_RESULT, jobId };
  },
  cancelTranscribeTrial: async () => true,
  onTranscribeTrialStatus: (cb) => { trialStatusListener = cb; },
  autoTune: async (_filePath, jobId, tuneId, opts) => {
    const shouldFail = nextAutoTuneFailure;
    nextAutoTuneFailure = false;
    const tuneKey = `${jobId}:${tuneId}`;
    const throwIfCancelled = () => {
      if (!cancelledAutoTunes.delete(tuneKey)) return;
      throw new Error('中止しました');
    };
    ipcRenderer.send('auto-tune-opts', opts);
    autoTuneStatusListener({ jobId, tuneId, state: 'queued', phase: 'queued', queuePosition: 1, queueTotal: 1 });
    await pause(20);
    throwIfCancelled();
    autoTuneStatusListener({ jobId, tuneId, state: 'running', phase: 'decoding', candidateIndex: 0, totalCandidates: 8 });
    await pause(20);
    throwIfCancelled();
    autoTuneStatusListener({ jobId, tuneId, state: 'running', phase: 'tuning', candidateIndex: 4, totalCandidates: 8, candidateLabel: 'interview-0' });
    await pause(40);
    throwIfCancelled();
    if (shouldFail) {
      autoTuneStatusListener({ jobId, tuneId, state: 'error', phase: 'tuning' });
      throw new Error('ENOSPC: auto tune test');
    }
    autoTuneStatusListener({ jobId, tuneId, state: 'completed', phase: 'finalizing', ratio: 1 });
    return {
      best: {
        id: 'test-best', label: 'テスト候補',
        options: {
          denoiseStrength: 0.5,
          vad: {
            maxSpeechDuration: 4, minSilenceDuration: 0.1,
            minSpeechDuration: 0.15, threshold: 0.3,
            overlapAware: true, overlapSpeakers: 2,
          },
        },
        metrics: {
          referenceLength: 55, hypothesisLength: 52, matches: 48,
          substitutions: 2, deletions: 3, insertions: 2,
          weightedErrors: 8.05, accuracy: 0.854,
        },
        result: { ...TRIAL_RESULT, jobId },
      },
      baselineAccuracy: 0.7,
      improvement: 0.154,
      confidence: 'high',
      speakerCount: 2,
      speakerAnalysisWarning: '',
      range: TRIAL_RESULT.range,
      candidates: [],
    };
  },
  cancelAutoTune: async (jobId, tuneId) => {
    cancelledAutoTunes.add(`${jobId}:${tuneId}`);
    autoTuneStatusListener({ jobId, tuneId, state: 'cancelling', phase: 'tuning' });
    return true;
  },
  onAutoTuneStatus: (cb) => { autoTuneStatusListener = cb; },
  segmentCandidates: async (_filePath, request) => ([
    { label: '指定した区間', start: request.start, end: request.end, text: '候補の文字起こしです' },
    { label: '前後を0.2秒広げる', start: Math.max(0, request.start - 0.2), end: request.end + 0.2, text: '別の候補です' },
  ]),
  testSetNextAutoTuneFailure: () => { nextAutoTuneFailure = true; },
  computeEmbeddings: async () => ({ ok: true, count: RESULT.segments.length }),
  onEmbedProgress: noop,
  // 区間クリップ（フォールバック経路）。呼ばれたことを主側へ通知する
  clipSegment: async () => {
    ipcRenderer.send('clip-used');
    return { wavPath: path.join(SAMPLES, 'test.wav') };
  },
  // 仕上がりテスト結果（19.03秒）と同じ長さの音源を返し、タイムライン終端まで検証できるようにする。
  previewRange: async () => ({ wavPath: TARGET }),
  // 本物と同じく中身を丸ごと返す（Blob 化はレンダラ側の責務）
  readMedia: async (filePath) => ({
    data: require('fs').readFileSync(filePath),
    type: path.extname(filePath).toLowerCase() === '.wav' ? 'audio/wav' : 'audio/mpeg',
  }),
  reassignSpeakers: async () => ({ labels: [], speakerCount: 0 }),
  preview: async () => ({ wavPath: path.join(SAMPLES, 'test.wav'), duration: 9 }),
  // リアルタイム文字起こし（マイクは使わないためすべて空実装）
  rtPrepare: async () => ({ ok: true }),
  rtRelease: async () => ({ ok: true }),
  rtStart: async () => ({ ok: true }),
  rtFeed: noop,
  rtStop: async () => ({ segments: [], duration: 0, wavPath: path.join(SAMPLES, 'test.wav'), name: 'rec.wav' }),
  rtCancel: async () => ({ ok: true }),
  onRtSegment: noop,
  onRtError: noop,
  testSetNextAudioSaved: (saved) => { nextAudioSaved = !!saved; },
  rtSaveWav: async () => {
    const saved = nextAudioSaved;
    nextAudioSaved = false;
    return saved ? { saved: true, path: 'recording.wav' } : { saved: false };
  },
  testSetNextExportSaved: (saved) => { nextExportSaved = !!saved; },
  saveExport: async (result, format) => {
    ipcRenderer.send('export-payload', { result, format });
    const saved = nextExportSaved;
    nextExportSaved = true;
    return saved ? { saved: true, path: 'test.txt' } : { saved: false };
  },
  checkUpdate: async () => ({}),
  downloadUpdate: async () => ({}),
  installUpdate: async () => ({}),
  onUpdateStatus: noop,
  onUpdateProgress: noop,
  dataInfo: async () => ({ bytes: 0 }),
  wipeData: async () => ({ ok: true }),
  uninstall: async () => ({ ok: true }),
  appInfo: async () => ({ version: 'test' }),
  readLicense: async () => '',
  openChromiumLicenses: noop,
  openExternal: noop,
});
