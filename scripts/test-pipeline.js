// Phase 2 検証: フルパイプライン（ffmpegデコード -> VAD分割 -> 認識）
const path = require('path');
const core = require('../src/core/asr');

const MODEL_DIR = path.join(__dirname, '..', 'models', 'reazonspeech-k2-v2');
const VAD_PATH = path.join(__dirname, '..', 'models', 'silero_vad.onnx');

async function main() {
  const input = process.argv[2] || path.join(__dirname, '..', 'samples', 'long.m4a');
  console.log('loading models...');
  const t0 = Date.now();
  const recognizer = core.createRecognizer(MODEL_DIR);
  const vad = core.createVad(VAD_PATH);
  console.log(`loaded in ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const result = await core.transcribeFile(input, { recognizer, vad }, {
    onProgress: (r) => process.stdout.write(`\rprogress: ${(r * 100).toFixed(0)}%   `),
  });
  process.stdout.write('\n');
  const elapsed = Date.now() - t1;
  console.log(`audio duration: ${result.duration.toFixed(2)}s, processed in ${elapsed}ms (${(result.duration * 1000 / elapsed).toFixed(1)}x realtime)`);
  console.log('--- SEGMENTS ---');
  for (const s of result.segments) {
    console.log(`[${s.start.toFixed(2)} - ${s.end.toFixed(2)}] ${s.text}`);
  }
  console.log('--- FULL TEXT ---');
  console.log(result.text);
}

main().catch((e) => { console.error(e); process.exit(1); });
