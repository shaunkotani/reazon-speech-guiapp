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
let transcribeCalls = 0;
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
    transcribeStatusListener({ jobId, state: 'running', phase: 'overlap', totalAudioSec: RESULT.duration });
    await pause(20);
    transcribeStatusListener({ jobId, state: 'running', phase: 'vad', totalAudioSec: RESULT.duration });
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
  computeEmbeddings: async () => ({ ok: true, count: RESULT.segments.length }),
  onEmbedProgress: noop,
  // 区間クリップ（フォールバック経路）。呼ばれたことを主側へ通知する
  clipSegment: async () => {
    ipcRenderer.send('clip-used');
    return { wavPath: path.join(SAMPLES, 'test.wav') };
  },
  previewRange: async () => ({ wavPath: path.join(SAMPLES, 'test.wav') }),
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
  rtSaveWav: async () => ({ saved: false }),
  saveExport: async () => ({ ok: true }),
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
