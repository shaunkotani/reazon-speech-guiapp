// main.js と同じ方法で asrWorker を ELECTRON_RUN_AS_NODE で fork し、
// 「External buffers are not allowed」が解消され結果が返るか検証する。
const path = require('path');
const { fork } = require('child_process');

const electronExec = require('electron'); // electron バイナリの絶対パス文字列
const MODELS = path.join(__dirname, '..', 'models');
const worker = fork(path.join(__dirname, '..', 'src', 'main', 'asrWorker.js'), [], {
  execPath: electronExec,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});

worker.on('message', (msg) => {
  if (msg.type === 'ready') {
    worker.send({
      type: 'transcribe', jobId: 1,
      filePath: path.join(__dirname, '..', 'samples', 'natural.wav'),
    });
  } else if (msg.type === 'progress') {
    process.stdout.write(`\rprogress ${(msg.ratio * 100).toFixed(0)}%   `);
  } else if (msg.type === 'result') {
    process.stdout.write('\n');
    console.log('RESULT segments:', msg.result.segments.length);
    for (const s of msg.result.segments) {
      console.log(`[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`);
    }
    worker.kill(); process.exit(0);
  } else if (msg.type === 'error') {
    console.error('\nWORKER ERROR:', msg.message);
    worker.kill(); process.exit(1);
  }
});
worker.send({
  type: 'init',
  modelDir: path.join(MODELS, 'reazonspeech-k2-v2'),
  vadPath: path.join(MODELS, 'silero_vad.onnx'),
});
