// 話者別音声分離専用ワーカー。
// sherpa-onnx と ONNX Runtime を同じプロセスへロードするとランタイムが競合するため、
// ASR ワーカーとは完全に分離する。PCM はファイル経由で受け渡す。
const fs = require('fs');
const path = require('path');
const os = require('os');
const ort = require('onnxruntime-node');

const SAMPLE_RATE = 16000;
let session = null;
let initConfig = null;

function readPcmRange(pcmPath, start, end) {
  const stat = fs.statSync(pcmPath);
  const totalSamples = Math.floor(stat.size / 4);
  const first = Math.max(0, Math.min(totalSamples, Math.round(Number(start) * SAMPLE_RATE)));
  const last = Math.max(first, Math.min(totalSamples, Math.round(Number(end) * SAMPLE_RATE)));
  const bytes = (last - first) * 4;
  const buffer = Buffer.allocUnsafe(bytes);
  const fd = fs.openSync(pcmPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, bytes, first * 4);
  } finally {
    fs.closeSync(fd);
  }
  return new Float32Array(buffer.buffer, buffer.byteOffset, last - first).slice();
}

function rms(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

function normalizeStem(values, targetRms) {
  let mean = 0;
  for (const value of values) mean += value;
  mean /= Math.max(1, values.length);
  let energy = 0;
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] - mean;
    values[i] = value;
    energy += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const sourceRms = Math.sqrt(energy / Math.max(1, values.length));
  const rmsScale = (Math.max(0.015, targetRms) * 1.15) / Math.max(1e-9, sourceRms);
  const peakScale = 0.95 / Math.max(1e-9, peak);
  const scale = Math.min(rmsScale, peakScale);
  for (let i = 0; i < values.length; i++) values[i] *= scale;
  return { rawRms: sourceRms, gain: scale, normalizedRms: rms(values) };
}

function correlation(a, b) {
  const length = Math.min(a.length, b.length);
  if (!length) return 1;
  let aa = 0;
  let bb = 0;
  let ab = 0;
  for (let i = 0; i < length; i++) {
    aa += a[i] * a[i];
    bb += b[i] * b[i];
    ab += a[i] * b[i];
  }
  return ab / Math.max(1e-12, Math.sqrt(aa * bb));
}

async function ensureSession() {
  if (session) return session;
  if (!initConfig || !fs.existsSync(initConfig.modelPath)) {
    throw new Error('話者別音声分離モデルが見つかりません');
  }
  session = await ort.InferenceSession.create(initConfig.modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, Math.min(4, (os.cpus().length || 2) - 1)),
    interOpNumThreads: 1,
  });
  return session;
}

async function separateWindow(pcmPath, outputDir, window) {
  const runtime = await ensureSession();
  const mixture = readPcmRange(pcmPath, window.start, window.end);
  if (mixture.length < Math.round(0.1 * SAMPLE_RATE)) throw new Error('分離対象の音声が短すぎます');
  const tensor = new ort.Tensor('float32', mixture, [1, mixture.length]);
  const outputs = await runtime.run({ [runtime.inputNames[0]]: tensor });
  const output = outputs[runtime.outputNames[0]];
  if (!output || output.dims.length !== 3 || Number(output.dims[1]) !== 2) {
    throw new Error(`未対応の分離モデル出力です: ${output ? output.dims.join('x') : 'none'}`);
  }
  const outputLength = Number(output.dims[2]);
  const length = Math.min(mixture.length, outputLength);
  const stems = [
    Float32Array.from(output.data.subarray(0, length)),
    Float32Array.from(output.data.subarray(outputLength, outputLength + length)),
  ];
  const mixtureRms = rms(mixture);
  const stemStats = stems.map((stem) => normalizeStem(stem, mixtureRms));
  const rawTotal = stemStats.reduce((sum, item) => sum + item.rawRms, 0) || 1;
  const sourceShares = stemStats.map((item) => item.rawRms / rawTotal);
  const stemCorrelation = correlation(stems[0], stems[1]);
  const files = stems.map((stem, stemIndex) => {
    const filePath = path.join(outputDir, `window-${window.index}-stem-${stemIndex}.pcm`);
    fs.writeFileSync(filePath, Buffer.from(stem.buffer, stem.byteOffset, stem.byteLength));
    return { stemIndex, pcmPath: filePath, samples: stem.length };
  });
  return {
    windowIndex: window.index,
    files,
    metrics: {
      mixtureRms,
      sourceShares,
      stemCorrelation,
      gains: stemStats.map((item) => item.gain),
    },
  };
}

const OPS = {
  async separateBatch({ pcmPath, outputDir, windows }, emit) {
    fs.mkdirSync(outputDir, { recursive: true });
    const out = [];
    for (const window of (Array.isArray(windows) ? windows : [])) {
      const started = Date.now();
      out.push(await separateWindow(pcmPath, outputDir, window));
      emit({ kind: 'separationWindow', n: 1, index: window.index, elapsedMs: Date.now() - started });
    }
    return out;
  },
};

process.on('message', async (message) => {
  if (message.type === 'init') {
    try {
      initConfig = { modelPath: message.modelPath };
      await ensureSession();
      process.send({ type: 'ready' });
    } catch (error) {
      process.send({ type: 'initError', message: error.message || String(error) });
    }
    return;
  }
  if (message.type !== 'request') return;
  const { rid, op, args } = message;
  const emit = (payload) => process.send({ type: 'event', rid, payload });
  try {
    if (!OPS[op]) throw new Error(`unknown op: ${op}`);
    const result = await OPS[op](args, emit);
    process.send({ type: 'response', rid, result });
  } catch (error) {
    process.send({ type: 'response', rid, error: error.message || String(error) });
  }
});
