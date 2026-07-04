// main.js のプール処理を模した検証ハーネス（electron-as-node で fork）。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const electronExec = require('electron');
const { clusterEmbeddings } = require('../src/shared/cluster');

const M = path.join(__dirname, '..', 'models');
const POOL = Math.max(1, Math.min(4, os.cpus().length - 1));
let ridSeq = 0;

function spawnWorker() {
  const proc = fork(path.join(__dirname, '..', 'src', 'main', 'asrWorker.js'), [], {
    execPath: electronExec, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const w = { proc, rpcs: new Map() };
  w.ready = new Promise((res) => proc.on('message', function h(m) { if (m.type === 'ready') { proc.off('message', h); res(); } }));
  proc.on('message', (msg) => {
    if (msg.type !== 'response' && msg.type !== 'event') return;
    const r = w.rpcs.get(msg.rid); if (!r) return;
    if (msg.type === 'event') { if (r.onEvent) r.onEvent(msg.payload); return; }
    w.rpcs.delete(msg.rid);
    if (msg.error) r.reject(new Error(msg.error)); else r.resolve(msg.result);
  });
  proc.send({ type: 'init', modelDir: path.join(M, 'reazonspeech-k2-v2'), vadPath: path.join(M, 'silero_vad.onnx'), denoiserPath: path.join(M, 'gtcrn_simple.onnx'), embPath: path.join(M, 'wespeaker_en_voxceleb_resnet34_LM.onnx') });
  return w;
}
function rpc(w, op, args, onEvent) {
  const rid = ++ridSeq;
  return new Promise((resolve, reject) => { w.rpcs.set(rid, { resolve, reject, onEvent }); w.proc.send({ type: 'request', rid, op, args }); });
}

(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'samples', 'twospk.wav');
  const numSpeakers = parseInt(process.argv[3] || '2', 10);
  const pool = Array.from({ length: POOL }, spawnWorker);
  await Promise.all(pool.map((w) => w.ready));
  console.log(`pool ready (${POOL} workers)`);

  const pcmPath = path.join(os.tmpdir(), `pooltest-${Date.now()}.pcm`);
  const t0 = Date.now();
  const prep = await rpc(pool[0], 'prepare', { filePath: file, denoiseStrength: 0, outPath: pcmPath });
  console.log(`prepare: ${prep.segments.length} segments, ${prep.duration.toFixed(1)}s (${Date.now() - t0}ms)`);

  const batches = Array.from({ length: pool.length }, () => []);
  prep.segments.forEach((s, idx) => batches[idx % pool.length].push({ idx, start: s.start, end: s.end }));
  let done = 0;
  const partial = new Array(prep.segments.length);
  const t1 = Date.now();
  await Promise.all(batches.map((items, w) => items.length ? rpc(pool[w], 'processBatch', { pcmPath, items, wantEmbedding: true }, (ev) => { done += ev.n; process.stdout.write(`\r  ${done}/${prep.segments.length}   `); }).then((res) => { for (const r of res) partial[r.idx] = { ...prep.segments[r.idx], text: r.text, embedding: r.embedding }; }) : null));
  process.stdout.write('\n');
  console.log(`parallel ASR+embedding done in ${Date.now() - t1}ms`);

  const ordered = partial.filter((x) => x && x.text);
  const withEmb = ordered.filter((o) => o.embedding);
  const labels = clusterEmbeddings(withEmb.map((o) => o.embedding), { numSpeakers });
  withEmb.forEach((o, i) => { o.speaker = labels[i]; });
  console.log(`speakers: ${new Set(labels).size}`);
  for (const o of ordered) console.log(`  話者${(o.speaker ?? 0) + 1} [${o.start.toFixed(1)}] ${o.text}`);
  console.log(`TOTAL ${Date.now() - t0}ms for ${prep.duration.toFixed(1)}s audio`);
  fs.rmSync(pcmPath, { force: true });
  for (const w of pool) w.proc.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
