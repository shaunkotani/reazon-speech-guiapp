// 重なり音声補正の純 JS 回帰テスト。モデル不要。
const assert = require('assert');
const overlap = require('../src/shared/overlap');

function testStrictSplit() {
  const parts = overlap.splitStrictSegments([{ start: 0, end: 7.2 }], 3);
  assert(parts.length >= 3);
  assert(parts.every((s) => s.end - s.start <= 3 + 1e-6));
  assert(parts[1].start < parts[0].end, '境界には語落ち防止の重なりが必要');

  const nearLimit = overlap.splitStrictSegments([{ start: 0, end: 6.45 }], 6);
  assert(nearLimit[nearLimit.length - 1].end - nearLimit[nearLimit.length - 1].start >= 0.8 - 1e-6,
    '上限超過が小さくても末尾を短すぎる断片にしない');
}

function testOverlapDetection() {
  const hits = overlap.detectOverlapIntervals([
    { start: 0.6, end: 3.37, speaker: 0 },
    { start: 2.78, end: 5.21, speaker: 1 },
  ]);
  assert.strictEqual(hits.length, 1);
  assert(Math.abs(hits[0].start - 2.78) < 1e-6);
  assert(Math.abs(hits[0].end - 3.37) < 1e-6);
}

function testCandidatePlanning() {
  const vad = [{ start: 2.47, end: 5.212 }];
  const speakers = [
    { start: 0.605, end: 3.372, speaker: 0 },
    { start: 2.782, end: 5.212, speaker: 1 },
  ];
  const plan = overlap.buildRecognitionItems(vad, speakers, { enabled: true, maxDuration: 3 });
  assert.strictEqual(plan.overlapGroupCount, 1);
  assert(plan.items.some((x) => x.kind === 'repair' && x.speakerHint === 1));

  // 主話者区間が元 VAD と同じで、もう一方が短すぎる場合は正常結果を触らない。
  const harmless = overlap.buildRecognitionItems(
    [{ start: 5.286, end: 6.78 }],
    [
      { start: 5.279, end: 9.278, speaker: 0 },
      { start: 6.325, end: 6.68, speaker: 1 },
    ],
    { enabled: true, maxDuration: 3 },
  );
  assert.strictEqual(harmless.overlapGroupCount, 0);
  assert.strictEqual(harmless.items.length, 1);

  const manualTracks = [
    { start: 0, end: 2.5, speaker: 'manual:a' },
    { start: 1.5, end: 4, speaker: 'manual:b' },
  ];
  const manual = overlap.buildRecognitionItems(
    [{ start: 0, end: 4 }],
    [],
    {
      enabled: true,
      maxDuration: 6,
      manualOverlapIntervals: overlap.detectOverlapIntervals(manualTracks),
      manualSpeakerSegments: manualTracks,
    },
  );
  assert.strictEqual(manual.overlapGroupCount, 1,
    'ユーザー指定の重なり区間は自動検出が空でも再認識候補を作る');
  assert(manual.items.some((item) => item.kind === 'repair' && item.speakerHint === 'manual:b'));
}

function testConsensusAndFinalize() {
  const texts = [
    'どうしよう',
    'どうしたどうしたわざわざ',
    'どうしようどうしよう',
    'どうしよう',
    'どうしたどうしたわざわざ',
    'どうしようどうしよう',
    'どうしようどうしようわざわ',
    'どうしたどうし',
    'どうしようどうしよう',
  ];
  const selected = overlap.selectConsensus(texts.map((text, i) => ({
    text, start: 2.78 + i * 0.001, end: 5.21,
  })));
  assert.strictEqual(selected.text, 'どうしようどうしよう');

  const recognized = [
    { kind: 'base', groupId: 'g0', chainId: 'v0', start: 2.47, end: 5.212, text: 'ありがとうございます' },
    // 短い側は相対長フィルタで落ちる。
    { kind: 'repair', groupId: 'g0', chainId: 'v0', repairId: 'r0', speakerHint: 0,
      repairSpanDuration: 0.9, start: 2.47, end: 3.37, text: 'ありがとうございました' },
    ...texts.map((text, i) => ({
      kind: 'repair', groupId: 'g0', chainId: 'v0', repairId: 'r1', speakerHint: 1,
      repairSpanDuration: 2.43, start: 2.78 + i * 0.001, end: 5.21, text,
    })),
  ];
  const final = overlap.finalizeRecognition(recognized);
  assert.strictEqual(final.recoveredGroups, 1);
  assert.strictEqual(final.segments.length, 1);
  assert.strictEqual(final.segments[0].text, 'どうしようどうしよう');
  assert.strictEqual(final.segments[0].overlapRecovered, true);
}

testStrictSplit();
testOverlapDetection();
testCandidatePlanning();
testConsensusAndFinalize();
console.log('overlap tests: OK');
