// リアルタイム文字起こしのワーカー経路の回帰: 本番の asrWorker を fork し、
// main と同じ手順（advanced serialization + rtSession/rtFeed/rtStop RPC）で駆動する。
// - Float32Array チャンクが子プロセスへ正しく届くか
// - 確定区間イベントが順に届き、rtStop の結果と一致するか
// - 録音 WAV が生成され、作業用 raw PCM が削除されるか
//
// ./models と samples/twospeaksample.mp3 が必要。
// 使い方: node scripts/test-realtime-worker.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');
const core = require('../src/core/asr');

const REPO = path.join(__dirname, '..');
const outDir = path.join(os.tmpdir(), 'reazonspeech-rt-test');
fs.mkdirSync(outDir, { recursive: true });
const pcmPath = path.join(outDir, 'rec.pcm');
const wavPath = path.join(outDir, 'rec.wav');

const proc = fork(path.join(REPO, 'src', 'main', 'asrWorker.js'), [], {
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  serialization: 'advanced', // main の rt ワーカーと同じ
});

let ridSeq = 0;
const rpcs = new Map();
proc.on('message', (msg) => {
  if (msg.type === 'ready') { rpcs.get('ready').resolve(); return; }
  if (msg.type === 'initError') { rpcs.get('ready').reject(new Error(msg.message)); return; }
  const r = rpcs.get(msg.rid);
  if (!r) return;
  if (msg.type === 'event') { if (r.onEvent) r.onEvent(msg.payload); return; }
  if (msg.type === 'response') {
    rpcs.delete(msg.rid);
    if (msg.error) r.reject(new Error(msg.error)); else r.resolve(msg.result);
  }
});

function rpc(op, args, onEvent) {
  const rid = ++ridSeq;
  return new Promise((resolve, reject) => {
    rpcs.set(rid, { resolve, reject, onEvent });
    proc.send({ type: 'request', rid, op, args });
  });
}

async function main() {
  const ready = new Promise((resolve, reject) => rpcs.set('ready', { resolve, reject }));
  proc.send({
    type: 'init',
    modelDir: path.join(REPO, 'models', 'reazonspeech-k2-v2'),
    vadPath: path.join(REPO, 'models', 'silero_vad.onnx'),
    hotwordsFile: '', hotwordsScore: 2.0, beamSearch: false,
  });
  await ready;

  const events = [];
  const sessionPromise = rpc('rtSession', { vad: { preset: 'standard' }, pcmPath, wavPath }, (ev) => {
    events.push(ev);
    if (ev.kind === 'seg') console.log(`event [${ev.start.toFixed(2)}-${ev.end.toFixed(2)}] ${ev.text}`);
    else console.log('event', ev);
  });

  const samples = await core.decodeToPcm(path.join(REPO, 'samples', 'twospeaksample.mp3'));
  const chunkLen = 1600; // renderer と同じ 100ms チャンク
  for (let i = 0; i < samples.length; i += chunkLen) {
    await rpc('rtFeed', { chunk: samples.slice(i, i + chunkLen) });
  }
  const result = await rpc('rtStop', {});
  await sessionPromise;

  console.log(`segments=${result.segments.length} duration=${result.duration.toFixed(2)}s`);

  const wavBytes = fs.statSync(wavPath).size;
  const expectBytes = 44 + samples.length * 2; // 16bit mono
  const checks = [
    ['確定区間が届いた', result.segments.length >= 4],
    ['イベント数と結果区間数が一致', events.filter((e) => e.kind === 'seg').length === result.segments.length],
    ['長さが入力と一致', Math.abs(result.duration - samples.length / 16000) < 0.01],
    ['録音WAVのサイズが正しい', Math.abs(wavBytes - expectBytes) <= 2],
    ['作業用raw PCMが削除済み', !fs.existsSync(pcmPath)],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'OK  ' : 'NG  '} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? 'realtime worker tests: OK' : 'realtime worker tests: NG');
  proc.kill();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
