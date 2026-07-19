// 実モデルの worker prepare 経路で、範囲デコードと前後文脈が反映されるかを確認する。
// models/ と samples/ は開発用（gitignore）のため、揃っていない環境ではスキップする。
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
  path.join(models, 'reazonspeech-k2-v2', 'encoder-epoch-99-avg-1.int8.onnx'),
];

if (!required.every(fs.existsSync)) {
  console.log('transcription range worker test: SKIP (local models/samples not found)');
  process.exit(0);
}

let rid = 0;
const worker = fork(path.join(root, 'src', 'main', 'asrWorker.js'), [], {
  execPath: electronExec,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});
const pending = new Map();
const ready = new Promise((resolve, reject) => {
  worker.on('message', (message) => {
    if (message.type === 'ready') { resolve(); return; }
    if (message.type === 'initError') { reject(new Error(message.message)); return; }
    if (!['response', 'event'].includes(message.type)) return;
    const request = pending.get(message.rid);
    if (!request) return;
    if (message.type === 'event') return;
    pending.delete(message.rid);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  worker.on('exit', (code) => {
    if (pending.size) reject(new Error(`worker exited before response: ${code}`));
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
  console.error('transcription range worker test: TIMEOUT');
  worker.kill();
  process.exit(2);
}, 60000);

(async () => {
  worker.send({
    type: 'init',
    modelDir: path.join(models, 'reazonspeech-k2-v2'),
    vadPath: path.join(models, 'silero_vad.onnx'),
  });
  await ready;
  const pcmPath = path.join(os.tmpdir(), `range-worker-${process.pid}-${Date.now()}.pcm`);
  try {
    const result = await rpc('prepare', {
      filePath,
      outPath: pcmPath,
      denoiseStrength: 0,
      vad: {},
      overlap: { enabled: false },
      range: { startSeconds: 5, durationSeconds: 10, contextSeconds: 1.5 },
    });
    assert(result.range, 'range metadata is missing');
    assert.strictEqual(result.sourceOffsetSeconds, 3.5);
    assert.strictEqual(result.range.selectionStartSeconds, 1.5);
    assert(Math.abs(result.range.actualDurationSeconds - 10) < 0.05);
    assert(result.duration >= 12.9 && result.duration <= 13.1);
    assert(fs.statSync(pcmPath).size > 0);
    console.log('transcription range worker test: OK');
  } finally {
    fs.rmSync(pcmPath, { force: true });
    clearTimeout(watchdog);
    worker.kill();
  }
})().catch((error) => {
  clearTimeout(watchdog);
  worker.kill();
  console.error(error);
  process.exit(1);
});
