'use strict';

const assert = require('assert');
const separation = require('../src/shared/separation');

const windows = separation.buildSeparationWindows([
  { start: 2, end: 2.8 },
  { start: 3.0, end: 3.7 },
  { start: 18, end: 19 },
], 30);
assert.strictEqual(windows.length, 2);
assert.deepStrictEqual(
  { start: windows[0].start, end: windows[0].end, overlapStart: windows[0].overlapStart, overlapEnd: windows[0].overlapEnd },
  { start: 1, end: 4.7, overlapStart: 2, overlapEnd: 3.7 },
);
assert(windows.every((window) => window.end - window.start <= 10));

const long = separation.buildSeparationWindows([{ start: 1, end: 24 }], 30);
assert(long.length >= 3);
assert(long.every((window) => window.end - window.start <= 10.000001));

const window = {
  index: 0, start: 1, end: 5, overlapStart: 2, overlapEnd: 4,
};
const decision = separation.selectSeparatedAdditions({
  window,
  metrics: { sourceShares: [0.55, 0.45], stemCorrelation: 0.12, embeddingDistance: 0.4 },
  baselineSegments: [{ start: 1.5, end: 4.2, text: 'こんにちは' }],
  stems: [
    { stemIndex: 0, segments: [{ start: 1.8, end: 3.2, text: 'こんにちは' }] },
    { stemIndex: 1, segments: [{ start: 2.4, end: 3.4, text: 'はいお願いします' }] },
  ],
});
assert.strictEqual(decision.accepted, true);
assert.strictEqual(decision.additions.length, 1);
assert.strictEqual(decision.additions[0].text, 'はいお願いします');
assert.strictEqual(decision.additions[0].overlapSeparated, true);

const rejected = separation.selectSeparatedAdditions({
  window,
  metrics: { sourceShares: [0.5, 0.5], stemCorrelation: 0.99 },
  baselineSegments: [],
  stems: [
    { stemIndex: 0, segments: [{ start: 2, end: 3, text: '同じです' }] },
    { stemIndex: 1, segments: [{ start: 2, end: 3, text: '同じです' }] },
  ],
});
assert.strictEqual(rejected.accepted, false);

const unanchored = separation.selectSeparatedAdditions({
  window,
  metrics: { sourceShares: [0.5, 0.5], stemCorrelation: 0.1, embeddingDistance: 0.3 },
  baselineSegments: [{ start: 1, end: 4, text: '本来の文字起こし' }],
  stems: [
    { stemIndex: 0, segments: [{ start: 2, end: 3, text: '無関係な候補です' }] },
    { stemIndex: 1, segments: [{ start: 2, end: 3, text: '別の無関係な候補' }] },
  ],
});
assert.strictEqual(unanchored.accepted, false);
assert.strictEqual(unanchored.reason, 'unanchored-transcript');

const merged = separation.mergeSeparatedSegments(
  [{ start: 1.5, end: 4.2, text: 'こんにちは' }],
  decision.additions,
);
assert.strictEqual(merged.length, 2);

const anchors = separation.buildSpeakerAnchorItems(
  [window],
  [
    { start: 0.4, end: 2.7, speaker: 'a' },
    { start: 2.2, end: 5.4, speaker: 'b' },
  ],
  [{ start: 2, end: 4 }],
);
assert(anchors.length >= 2);
assert(anchors.every((item) => item.end <= 2 || item.start >= 4));

console.log('separation tests: OK');
