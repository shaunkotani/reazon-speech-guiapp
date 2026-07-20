// 実モデルを使い、重なり解析のチャンク分割・ワーカー並列経路を検証する。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const electronExec = require('electron');
const core = require('../src/core/asr');
const overlap = require('../src/shared/overlap');

const ROOT = path.join(__dirname, '..');
const MODELS = path.join(ROOT, 'models');
let rid = 0;

function spawnWorker() {
  const proc = fork(path.join(ROOT, 'src', 'main', 'asrWorker.js'), [], {
    execPath: electronExec,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const worker = { proc, pending: new Map() };
  worker.ready = new Promise((resolve, reject) => {
    proc.on('message', function onReady(message) {
      if (message.type === 'ready') {
        proc.off('message', onReady);
        resolve();
      } else if (message.type === 'initError') {
        proc.off('message', onReady);
        reject(new Error(message.message));
      }
    });
  });
  proc.on('message', (message) => {
    const request = worker.pending.get(message.rid);
    if (!request) return;
    if (message.type === 'event') {
      if (request.onEvent) request.onEvent(message.payload);
      return;
    }
    if (message.type !== 'response') return;
    worker.pending.delete(message.rid);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  proc.send({
    type: 'init',
    modelDir: path.join(MODELS, 'reazonspeech-k2-v2'),
    vadPath: path.join(MODELS, 'silero_vad.onnx'),
    denoiserPath: path.join(MODELS, 'gtcrn_simple.onnx'),
    embPath: path.join(MODELS, 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
    segmentationPath: path.join(MODELS, 'pyannote-segmentation.onnx'),
  });
  return worker;
}

function rpc(worker, op, args, onEvent) {
  const requestId = ++rid;
  return new Promise((resolve, reject) => {
    worker.pending.set(requestId, { resolve, reject, onEvent });
    worker.proc.send({ type: 'request', rid: requestId, op, args });
  });
}

async function main() {
  const input = process.argv[2] || path.join(ROOT, 'samples', 'twospeaksample.mp3');
  const maxSeconds = Math.max(0, Number(process.argv[3]) || 0);
  const chunkDuration = Math.max(10, Number(process.argv[4]) || overlap.DEFAULTS.diarizationChunkDuration);
  const context = Math.max(0, Number(process.argv[5]) || overlap.DEFAULTS.diarizationContext);
  const samples = await core.decodeToPcm(input, { maxSeconds });
  const duration = samples.length / core.SAMPLE_RATE;
  const pcmPath = path.join(os.tmpdir(), `overlap-worker-${process.pid}-${Date.now()}.pcm`);
  core.writePcmRaw(samples, pcmPath);
  const chunks = overlap.buildDiarizationChunks(duration, { chunkDuration, context });
  const workerCount = Math.min(4, chunks.length);
  const workers = Array.from({ length: workerCount }, spawnWorker);
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    const threads = overlap.diarizationThreads(os.cpus().length, workerCount);
    const batches = Array.from({ length: workerCount }, () => []);
    chunks.forEach((chunk, index) => batches[index % workerCount].push(chunk));
    const started = Date.now();
    const results = await Promise.all(batches.map((items, index) => rpc(
      workers[index], 'diarizeBatch',
      { pcmPath, items, numSpeakers: 2, numThreads: threads },
    )));
    const tracks = results.flat();
    assert(tracks.every((track) => track.start >= 0 && track.end <= duration + 1e-6
      && track.end > track.start));
    const intervals = overlap.detectOverlapIntervals(tracks);
    if (/twospeaksample/i.test(path.basename(input))) {
      assert(intervals.length > 0, '標準2話者サンプルの重なりを検出できない');
    }
    let recognition = null;
    if (/twospeaksample/i.test(path.basename(input))) {
      const vad = core.createVad(path.join(MODELS, 'silero_vad.onnx'), core.VAD_PRESETS.conversation);
      const vadSegments = core.collectVadSegments(samples, vad)
        .map((segment) => ({ start: segment.start, end: segment.end }));
      const plan = overlap.buildRecognitionItems(vadSegments, tracks, {
        enabled: true,
        maxDuration: core.VAD_PRESETS.conversation.maxSpeechDuration,
      });
      const partial = new Array(plan.items.length);
      const runIndexes = async (indexes) => {
        const processBatches = Array.from({ length: workerCount }, () => []);
        indexes.forEach((index, order) => {
          const item = plan.items[index];
          processBatches[order % workerCount].push({ idx: index, start: item.start, end: item.end });
        });
        const values = await Promise.all(processBatches.map((items, index) => (
          items.length ? rpc(workers[index], 'processBatch', {
            pcmPath, items, wantEmbedding: false,
          }) : []
        )));
        for (const value of values.flat()) {
          partial[value.idx] = { ...plan.items[value.idx], text: value.text };
        }
      };
      const initial = [];
      const extended = [];
      plan.items.forEach((item, index) => {
        if (item.kind === 'repair' && item.variantTier === 'extended') extended.push(index);
        else initial.push(index);
      });
      await runIndexes(initial);
      const expand = overlap.repairsNeedingExpansion(partial.filter(Boolean));
      const selectedExtended = extended.filter((index) => expand.has(plan.items[index].repairId));
      await runIndexes(selectedExtended);
      const finalized = overlap.finalizeRecognition(partial.filter(Boolean));
      assert(finalized.segments.length > 0, '段階的な再認識から結果を確定できない');
      const remainingExtended = extended.filter((index) => !partial[index]);
      await runIndexes(remainingExtended);
      const fullFinalized = overlap.finalizeRecognition(partial.filter(Boolean));
      assert.deepStrictEqual(
        finalized.segments.map((segment) => segment.text),
        fullFinalized.segments.map((segment) => segment.text),
        '段階認識の確定文が全候補認識から変わった',
      );
      recognition = {
        planned: plan.items.length,
        recognized: initial.length + selectedExtended.length,
        recovered: finalized.recoveredGroups,
        text: finalized.segments.map((segment) => segment.text),
      };
    }
    console.log(JSON.stringify({
      duration,
      chunks: chunks.length,
      workers: workerCount,
      threadsPerWorker: threads,
      elapsedMs: Date.now() - started,
      tracks: tracks.length,
      overlaps: intervals.length,
      overlapIntervals: intervals.length <= 20 ? intervals : undefined,
      recognition,
    }, null, 2));
  } finally {
    fs.rmSync(pcmPath, { force: true });
    for (const worker of workers) worker.proc.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
