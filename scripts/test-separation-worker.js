'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const electronExec = require('electron');
const core = require('../src/core/asr');
const overlap = require('../src/shared/overlap');
const separationTools = require('../src/shared/separation');
const { centroid, l2normalize, cosineDistance } = require('../src/shared/cluster');

const ROOT = path.join(__dirname, '..');
const MODELS = path.join(ROOT, 'models');
let rid = 0;

function spawn(script, init) {
  const proc = fork(path.join(ROOT, 'src', 'main', script), [], {
    execPath: electronExec,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const worker = { proc, pending: new Map() };
  worker.ready = new Promise((resolve, reject) => {
    proc.on('message', function onReady(message) {
      if (message.type === 'ready') { proc.off('message', onReady); resolve(); }
      if (message.type === 'initError') { proc.off('message', onReady); reject(new Error(message.message)); }
    });
  });
  proc.on('message', (message) => {
    const request = worker.pending.get(message.rid);
    if (!request || message.type === 'event') return;
    if (message.type !== 'response') return;
    worker.pending.delete(message.rid);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  proc.send({ type: 'init', ...init });
  return worker;
}

function rpc(worker, op, args) {
  const requestId = ++rid;
  return new Promise((resolve, reject) => {
    worker.pending.set(requestId, { resolve, reject });
    worker.proc.send({ type: 'request', rid: requestId, op, args });
  });
}

async function main() {
  const input = process.argv[2] || path.join(ROOT, 'samples', 'twospeaksample.mp3');
  const modelPath = path.join(MODELS, 'speech-separation', 'convtasnet_16k.onnx');
  if (!fs.existsSync(modelPath)) throw new Error(`分離モデルがありません: ${modelPath}`);
  const samples = await core.decodeToPcm(input, { maxSeconds: 8 });
  const duration = samples.length / core.SAMPLE_RATE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'separation-worker-test-'));
  const pcmPath = path.join(tempDir, 'input.pcm');
  core.writePcmRaw(samples, pcmPath);
  const separator = spawn('separatorWorker.js', { modelPath });
  const asr = spawn('asrWorker.js', {
    modelDir: path.join(MODELS, 'reazonspeech-k2-v2'),
    vadPath: path.join(MODELS, 'silero_vad.onnx'),
    denoiserPath: path.join(MODELS, 'gtcrn_simple.onnx'),
    embPath: path.join(MODELS, 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
    segmentationPath: path.join(MODELS, 'pyannote-segmentation.onnx'),
  });
  try {
    await Promise.all([separator.ready, asr.ready]);
    const tracks = await rpc(asr, 'diarizeBatch', {
      pcmPath,
      numSpeakers: 2,
      numThreads: 4,
      items: [{ index: 0, start: 0, end: duration, coreStart: 0, coreEnd: duration }],
    });
    const overlapIntervals = overlap.detectOverlapIntervals(tracks);
    assert(overlapIntervals.length > 0, '重なり区間を検出できる');
    const windows = separationTools.buildSeparationWindows(overlapIntervals, duration);
    assert(windows.length > 0, '重なり区間から分離窓を作れる');
    const separated = await rpc(separator, 'separateBatch', {
      pcmPath,
      outputDir: tempDir,
      windows,
    });
    assert.strictEqual(separated.length, windows.length);
    assert(separated.every((entry) => entry.files.length === 2));
    assert(separated.every((entry) => entry.metrics.sourceShares.every((share) => share > 0)));
    const items = separated.flatMap((entry) => {
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
    const recognized = await rpc(asr, 'processSeparatedBatch', {
      items,
      vad: { threshold: 0.5, minSilenceDuration: 0.15, minSpeechDuration: 0.1, maxSpeechDuration: 4 },
    });
    assert.strictEqual(recognized.length, windows.length * 2);
    assert(recognized.some((stem) => stem.segments.some((segment) => segment.text)),
      '少なくとも一方の分離音声を認識できる');
    const embeddingDistances = windows.map((window) => {
      const vectors = [0, 1].map((stemIndex) => recognized
        .find((stem) => stem.windowIndex === window.index && stem.stemIndex === stemIndex)
        .segments.map((segment) => segment.embedding).filter(Boolean));
      if (vectors.some((values) => !values.length)) return null;
      return cosineDistance(l2normalize(centroid(vectors[0])), l2normalize(centroid(vectors[1])));
    });
    const baseline = await rpc(asr, 'processBatch', {
      pcmPath,
      wantEmbedding: false,
      items: windows.map((window) => ({ idx: window.index, start: window.start, end: window.end })),
    });
    const decisions = windows.map((window) => {
      const stems = [0, 1].map((stemIndex) => recognized
        .find((stem) => stem.windowIndex === window.index && stem.stemIndex === stemIndex));
      return separationTools.selectSeparatedAdditions({
        window,
        stems,
        metrics: { ...separated[window.index].metrics, embeddingDistance: embeddingDistances[window.index] },
        baselineSegments: baseline.filter((item) => item.idx === window.index).map((item) => ({
          start: window.start, end: window.end, text: item.text,
        })),
      });
    });
    console.log(JSON.stringify({
      duration,
      overlapIntervals,
      windows: windows.length,
      metrics: separated.map((entry) => entry.metrics),
      embeddingDistances,
      baseline: baseline.map((item) => item.text),
      decisions: decisions.map((decision) => ({
        accepted: decision.accepted,
        reason: decision.reason,
        additions: decision.additions.map((segment) => segment.text),
      })),
      stems: recognized.map((stem) => ({
        stemIndex: stem.stemIndex,
        text: stem.segments.map((segment) => segment.text),
      })),
    }, null, 2));
  } finally {
    separator.proc.kill();
    asr.proc.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
