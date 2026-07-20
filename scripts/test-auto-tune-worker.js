'use strict';

// 文字起こし修正による自動調整の前処理回帰。実モデルがある環境では、範囲デコードを一度だけ行い、
// 原音/GTCRN候補と複数VAD境界、追加の局所探索境界を生成できることを確認する。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const electronExec = require('electron');

const root = path.join(__dirname, '..');
const models = path.join(root, 'models');
const filePath = path.join(root, 'samples', 'twospeaksample.mp3');
const required = [
  filePath,
  path.join(models, 'silero_vad.onnx'),
  path.join(models, 'gtcrn_simple.onnx'),
  path.join(models, 'pyannote-segmentation.onnx'),
  path.join(models, 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
  path.join(models, 'reazonspeech-k2-v2', 'encoder-epoch-99-avg-1.int8.onnx'),
];
if (!required.every(fs.existsSync)) {
  console.log('auto tune worker test: SKIP (local models/samples not found)');
  process.exit(0);
}

let rid = 0;
const pending = new Map();
const worker = fork(path.join(root, 'src', 'main', 'asrWorker.js'), [], {
  execPath: electronExec,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});
const ready = new Promise((resolve, reject) => {
  worker.on('message', (message) => {
    if (message.type === 'ready') { resolve(); return; }
    if (message.type === 'initError') { reject(new Error(message.message)); return; }
    const request = pending.get(message.rid);
    if (!request || message.type === 'event') return;
    pending.delete(message.rid);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
});
function rpc(op, args) {
  const requestId = ++rid;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    worker.send({ type: 'request', rid: requestId, op, args });
  });
}

const watchdog = setTimeout(() => {
  console.error('auto tune worker test: TIMEOUT');
  worker.kill();
  process.exit(2);
}, 120000);

(async () => {
  worker.send({
    type: 'init',
    modelDir: path.join(models, 'reazonspeech-k2-v2'),
    vadPath: path.join(models, 'silero_vad.onnx'),
    denoiserPath: path.join(models, 'gtcrn_simple.onnx'),
    embPath: path.join(models, 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
    segmentationPath: path.join(models, 'pyannote-segmentation.onnx'),
  });
  await ready;
  const stamp = `${process.pid}-${Date.now()}`;
  const rawPath = path.join(os.tmpdir(), `auto-tune-raw-${stamp}.pcm`);
  const denoisedPath = path.join(os.tmpdir(), `auto-tune-den-${stamp}.pcm`);
  try {
    const candidates = [
      {
        id: 'standard',
        options: {
          denoiseStrength: 0,
          vad: { maxSpeechDuration: 6, minSilenceDuration: 0.2, minSpeechDuration: 0.15, threshold: 0.5 },
        },
      },
      {
        id: 'conversation-denoised',
        options: {
          denoiseStrength: 0.8,
          vad: { maxSpeechDuration: 3, minSilenceDuration: 0.1, minSpeechDuration: 0.2, threshold: 0.7 },
        },
      },
    ];
    const prepared = await rpc('prepareAutoTune', {
      filePath,
      range: { startSeconds: 0, durationSeconds: 10, contextSeconds: 1.5 },
      candidates,
      pcmVariants: [
        { strength: 0, outPath: rawPath },
        { strength: 0.8, outPath: denoisedPath },
      ],
      speakerCount: 2,
    });
    assert.strictEqual(prepared.candidates.length, 2);
    assert(prepared.candidates.every((candidate) => Array.isArray(candidate.segments)));
    assert(fs.statSync(rawPath).size > 0);
    const rawBytes = fs.statSync(rawPath).size;
    const denoisedBytes = fs.statSync(denoisedPath).size;
    assert(Math.abs(rawBytes - denoisedBytes) / rawBytes < 0.01, 'GTCRN の出力長差は1%未満');
    assert(Math.abs(prepared.range.actualDurationSeconds - 10) < 0.05);

    const refined = await rpc('segmentAutoTuneCandidates', {
      candidates: [{
        id: 'refined', pcmPath: rawPath,
        options: {
          denoiseStrength: 0,
          vad: { maxSpeechDuration: 4, minSilenceDuration: 0.15, minSpeechDuration: 0.1, threshold: 0.35 },
        },
      }],
    });
    assert.strictEqual(refined.length, 1);
    assert(Array.isArray(refined[0].segments));
    const segmentCandidates = await rpc('segmentCandidates', {
      filePath, start: 0.65, end: 1.99, denoiseStrength: 0,
    });
    assert(Array.isArray(segmentCandidates) && segmentCandidates.length >= 1);
    assert(segmentCandidates.every((candidate) => candidate.text
      && candidate.end > candidate.start && candidate.label));
    console.log('auto tune worker test: OK');
  } finally {
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(denoisedPath, { force: true });
    clearTimeout(watchdog);
    worker.kill();
  }
})().catch((error) => {
  clearTimeout(watchdog);
  worker.kill();
  console.error(error);
  process.exit(1);
});
