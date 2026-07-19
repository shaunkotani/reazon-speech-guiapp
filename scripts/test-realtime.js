// リアルタイム文字起こしの検証: ファイルを 100ms チャンクの擬似ストリームとして
// RealtimeSegmenter(VAD) に投入し、確定区間を厳密分割→認識する。
// 「発話終了 → テキスト確定」の遅延と、実時間内に処理が追いつくかを実測する。
//
// 使い方: node scripts/test-realtime.js [音声ファイル] [maxSpeechDuration秒]
const path = require('path');
const core = require('../src/core/asr');
const { splitStrictSegments } = require('../src/shared/overlap');

const MODEL_DIR = path.join(__dirname, '..', 'models', 'reazonspeech-k2-v2');
const VAD_PATH = path.join(__dirname, '..', 'models', 'silero_vad.onnx');

const CHUNK_SEC = 0.1; // renderer からの想定チャンク長

async function main() {
  const input = process.argv[2] || path.join(__dirname, '..', 'samples', 'twospeaksample.mp3');
  const maxSpeech = Number(process.argv[3]) || 6;

  console.log('loading models...');
  const t0 = Date.now();
  const recognizer = core.createRecognizer(MODEL_DIR);
  const vad = core.createVad(VAD_PATH, { maxSpeechDuration: maxSpeech });
  console.log(`loaded in ${Date.now() - t0}ms`);

  const samples = await core.decodeToPcm(input);
  const duration = samples.length / core.SAMPLE_RATE;
  console.log(`input: ${input} (${duration.toFixed(2)}s), chunk=${CHUNK_SEC * 1000}ms, maxSpeech=${maxSpeech}s`);

  const seg = new core.RealtimeSegmenter(vad);
  const chunkLen = Math.round(CHUNK_SEC * core.SAMPLE_RATE);
  const results = [];
  let totalDecodeMs = 0;

  // 1 つの VAD 確定区間を厳密分割し、各部分を認識する
  async function handleSegment(s, arrivalSec) {
    const parts = splitStrictSegments([{ start: s.start, end: s.end }], maxSpeech);
    for (const p of parts) {
      const a = Math.round((p.start - s.start) * core.SAMPLE_RATE);
      const b = Math.round((p.end - s.start) * core.SAMPLE_RATE);
      const t = Date.now();
      const r = await core.recognizeSegment(recognizer, s.samples.subarray(a, b));
      const decodeMs = Date.now() - t;
      totalDecodeMs += decodeMs;
      // emissionDelay: 発話が実際に終わってから VAD が区間を確定するまで(仮想時刻)
      const emissionDelay = arrivalSec - s.end;
      results.push({
        start: p.start, end: p.end,
        text: (r.text || '').trim(),
        emissionDelay, decodeMs,
        latency: emissionDelay + decodeMs / 1000,
      });
    }
  }

  const tWall = Date.now();
  for (let i = 0; i < samples.length; i += chunkLen) {
    const arrivalSec = Math.min(samples.length, i + chunkLen) / core.SAMPLE_RATE;
    for (const s of seg.feed(samples.subarray(i, i + chunkLen))) {
      await handleSegment(s, arrivalSec);
    }
  }
  for (const s of seg.flush()) {
    await handleSegment(s, duration);
  }
  const wallMs = Date.now() - tWall;

  console.log('--- SEGMENTS ---');
  for (const r of results) {
    console.log(
      `[${r.start.toFixed(2)} - ${r.end.toFixed(2)}] ` +
      `vad+${r.emissionDelay.toFixed(2)}s asr+${(r.decodeMs / 1000).toFixed(2)}s ` +
      `(計${r.latency.toFixed(2)}s) ${r.text}`
    );
  }

  const lat = results.map((r) => r.latency).sort((a, b) => a - b);
  const avg = lat.reduce((s, v) => s + v, 0) / (lat.length || 1);
  console.log('--- SUMMARY ---');
  console.log(`segments: ${results.length}`);
  console.log(`latency avg=${avg.toFixed(2)}s median=${(lat[Math.floor(lat.length / 2)] || 0).toFixed(2)}s max=${(lat[lat.length - 1] || 0).toFixed(2)}s`);
  console.log(`asr total=${(totalDecodeMs / 1000).toFixed(2)}s / audio=${duration.toFixed(2)}s (RTF=${(totalDecodeMs / 1000 / duration).toFixed(3)})`);
  console.log(`feed+asr wall=${(wallMs / 1000).toFixed(2)}s → ${wallMs / 1000 < duration ? '実時間内に追いつく' : '実時間より遅い(要検討)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
