// ホットワード辞書（C）＋ modified_beam_search（A）の効き目を CLI で検証する。
//
// 使い方:
//   node scripts/test-hotwords.js <audio> "語1,語2,..." [hotwordsScore]
// 例:
//   node scripts/test-hotwords.js samples/natural.wav "ReazonSpeech,文字起こし" 2.0
//
// greedy（辞書なし）と modified_beam_search（辞書あり）の全区間出力を並べて表示する。
// tokens.txt が文字ベースの k2 モデルで hotwords が実際に反映されるか（modelingUnit=cjkchar）
// を確認するための最小検証。ネイティブ addon を使うため ELECTRON_RUN_AS_NODE 相当の純 Node で実行。
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/core/asr');

async function segmentsOf(recognizer, segs, samples) {
  const sr = core.SAMPLE_RATE;
  const out = [];
  for (const s of segs) {
    const a = Math.max(0, Math.round(s.start * sr));
    const b = Math.min(samples.length, Math.round(s.end * sr));
    const r = await core.recognizeSegment(recognizer, samples.subarray(a, b));
    out.push((r.text || '').trim());
  }
  return out;
}

async function main() {
  const audio = process.argv[2] || 'samples/natural.wav';
  const words = (process.argv[3] || '').split(',').map((w) => w.trim()).filter(Boolean);
  const score = Number(process.argv[4] || 2.0);
  if (!words.length) {
    console.error('ホットワードを指定してください: node scripts/test-hotwords.js <audio> "語1,語2"');
    process.exit(1);
  }

  const modelDir = path.join(__dirname, '..', 'models', 'reazonspeech-k2-v2');
  const vadPath = path.join(__dirname, '..', 'models', 'silero_vad.onnx');

  const hotwordsFile = path.join(os.tmpdir(), `hotwords-test-${Date.now()}.txt`);
  fs.writeFileSync(hotwordsFile, words.join('\n') + '\n', 'utf8');
  console.log(`hotwords(${score}):`, words.join(' / '));
  console.log('audio:', audio, '\n');

  console.log('デコード + VAD 中...');
  const samples = await core.decodeToPcm(audio);
  const vad = core.createVad(vadPath);
  const segs = core.collectVadSegments(samples, vad).map((s) => ({ start: s.start, end: s.end }));
  console.log(`区間数: ${segs.length}\n`);

  const greedy = core.createRecognizer(modelDir);
  const beam = core.createRecognizer(modelDir, { hotwordsFile, hotwordsScore: score });

  const gOut = await segmentsOf(greedy, segs, samples);
  const bOut = await segmentsOf(beam, segs, samples);

  let diffs = 0;
  for (let i = 0; i < segs.length; i++) {
    const changed = gOut[i] !== bOut[i];
    if (changed) diffs++;
    const mark = changed ? '  <<< 変化' : '';
    console.log(`[${i}] greedy : ${gOut[i]}`);
    console.log(`    hotword: ${bOut[i]}${mark}\n`);
  }
  console.log(`変化した区間: ${diffs}/${segs.length}`);
  fs.rmSync(hotwordsFile, { force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
