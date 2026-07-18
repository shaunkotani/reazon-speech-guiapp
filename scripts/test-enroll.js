// 後付け話者タグ付けフローの検証: 文字起こし(埋め込み無し) → 遅延埋め込み → 手本割当(不明閾値)。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const electronExec = require('electron');
const { assignByReferences, UNKNOWN_THRESHOLD } = require('../src/shared/cluster');

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
  const file = path.join(__dirname, '..', 'samples', 'twospeaksample.mp3');
  const pool = Array.from({ length: POOL }, spawnWorker);
  await Promise.all(pool.map((w) => w.ready));

  // 1) 文字起こし（埋め込み無し）
  const pcm1 = path.join(os.tmpdir(), `enr-${Date.now()}.pcm`);
  const prep = await rpc(pool[0], 'prepare', { filePath: file, denoiseStrength: 0, outPath: pcm1 });
  const partial = new Array(prep.segments.length);
  const batches = Array.from({ length: pool.length }, () => []);
  prep.segments.forEach((s, idx) => batches[idx % pool.length].push({ idx, start: s.start, end: s.end }));
  await Promise.all(batches.map((items, w) => items.length ? rpc(pool[w], 'processBatch', { pcmPath: pcm1, items, wantEmbedding: false }).then((res) => { for (const r of res) partial[r.idx] = { ...prep.segments[r.idx], text: r.text }; }) : null));
  const segments = partial.filter((x) => x && x.text);
  console.log('文字起こし:', segments.length, '区間（埋め込み無し）');
  fs.rmSync(pcm1, { force: true });

  // 2) 遅延で埋め込み計算（decodePcm + embedBatch）
  const pcm2 = path.join(os.tmpdir(), `enr2-${Date.now()}.pcm`);
  await rpc(pool[0], 'decodePcm', { filePath: file, denoiseStrength: 0, outPath: pcm2 });
  const embs = new Array(segments.length);
  const eb = Array.from({ length: pool.length }, () => []);
  segments.forEach((s, idx) => eb[idx % pool.length].push({ idx, start: s.start, end: s.end }));
  await Promise.all(eb.map((items, w) => items.length ? rpc(pool[w], 'embedBatch', { pcmPath: pcm2, items }).then((res) => { for (const r of res) embs[r.idx] = r.embedding; }) : null));
  fs.rmSync(pcm2, { force: true });
  console.log('声紋:', embs.filter(Boolean).length, '区間ぶん計算');

  // 3) 手本: 区間0を話者0、区間1を話者1 として割当（不明閾値あり）
  const refs = { 0: [0], 1: [1] };
  const labels = assignByReferences(embs, refs, { threshold: UNKNOWN_THRESHOLD });
  for (const [sid, idxs] of Object.entries(refs)) for (const i of idxs) labels[i] = Number(sid);
  console.log('手本: 区間0=話者1, 区間1=話者2 → 再識別:');
  segments.forEach((s, i) => console.log(`  ${labels[i] < 0 ? '話者不明' : '話者' + (labels[i] + 1)}  ${s.text}`));

  for (const w of pool) w.proc.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
