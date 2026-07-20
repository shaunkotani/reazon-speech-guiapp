'use strict';

const assert = require('assert');
const corrections = require('../src/shared/corrections');

const block = corrections.createCorrectionBlock({
  id: 'locked-1',
  range: { startSeconds: 1, endSeconds: 4 },
  rows: [
    { speaker: 'a', speakerName: '司会', text: '正しい冒頭', start: 1.1, end: 1.7 },
    { speaker: 'b', speakerName: '回答者', text: '抜けていた発言', start: null, end: null, operation: 'insert' },
    { speaker: 'a', speakerName: '司会', text: '正しい続き', start: 2.2, end: 3 },
  ],
});
assert(block);
assert.strictEqual(block.start, 1.1);
assert.strictEqual(block.end, 3);
assert(block.rows[1].start >= 1.7 && block.rows[1].end <= 2.2);
assert(block.rows[1].start >= block.rows[0].end && block.rows[1].end <= block.rows[2].start);

const raw = {
  duration: 5,
  segments: [
    { start: 0, end: 1, text: '範囲外の前' },
    { start: 1.1, end: 1.8, text: '間違った冒頭' },
    { start: 2, end: 3.1, text: '間違った続き' },
    { start: 4, end: 5, text: '範囲外の後' },
  ],
};
const applied = corrections.applyCorrections(raw, [block]);
assert.deepStrictEqual(applied.segments.map((segment) => segment.text), [
  '範囲外の前', '正しい冒頭', '抜けていた発言', '正しい続き', '範囲外の後',
]);
assert.strictEqual(applied.segments.filter((segment) => segment.lockedCorrection).length, 3);
assert.strictEqual(applied.segments[2].correctionSpeakerName, '回答者');
assert.deepStrictEqual(applied.appliedCorrectionIds, ['locked-1']);
assert.strictEqual(raw.segments[1].text, '間違った冒頭', '元の認識結果は変更しない');

const leading = corrections.createCorrectionBlock({
  id: 'locked-leading',
  range: { startSeconds: 10, endSeconds: 20 },
  rows: [
    { speaker: 'a', text: '先頭で欠落', start: null, end: null },
    { speaker: 'a', text: '検出済み', start: 13, end: 15 },
  ],
});
assert.strictEqual(leading.start, 10);
assert.strictEqual(leading.end, 15);
assert(leading.rows[0].start >= 10 && leading.rows[0].end <= 13);

const wholeRange = corrections.createCorrectionBlock({
  id: 'locked-whole',
  range: { startSeconds: 30, endSeconds: 40 },
  replaceEntireRange: true,
  rows: [{ speaker: 'a', text: '残した唯一の発言', start: 34, end: 36 }],
});
assert.strictEqual(wholeRange.start, 30);
assert.strictEqual(wholeRange.end, 40);

const reordered = corrections.createCorrectionBlock({
  id: 'locked-reordered',
  range: { startSeconds: 0, endSeconds: 10 },
  rows: [
    { speaker: 'a', text: '後の発言を先に', start: 6, end: 8 },
    { speaker: 'b', text: '前の発言を後に', start: 1, end: 3 },
  ],
});
assert.strictEqual(reordered.rows[0].start, 6);
assert.strictEqual(reordered.rows[1].start, 1, '明示した時刻は表示順と異なっても保持する');

const selective = corrections.createCorrectionBlock({
  id: 'selective', range: { startSeconds: 1, endSeconds: 4 },
  rows: [
    {
      speaker: 'a', text: '一人目だけ修正', start: 1.05, end: 1.95,
      sourceStart: 1, sourceEnd: 2, confirmed: true,
    },
    {
      speaker: 'b', text: '重なっていた欠落発話', start: 1.4, end: 1.8,
      operation: 'insert', confirmed: true,
    },
    { speaker: 'a', text: '未確定なので使わない', start: 3, end: 4, confirmed: false },
  ],
});
assert.strictEqual(selective.rows.length, 2, '未確定行は確定修正へ含めない');
const selectiveApplied = corrections.applyCorrections({
  duration: 5,
  segments: [
    { start: 1, end: 2, text: '置換対象' },
    { start: 1.2, end: 2.2, text: '同時に話していた別発話' },
    { start: 3, end: 4, text: '未確定部分の再認識' },
  ],
}, [selective]);
assert(selectiveApplied.segments.some((segment) => segment.text === '一人目だけ修正'));
assert(selectiveApplied.segments.some((segment) => segment.text === '重なっていた欠落発話'));
assert(selectiveApplied.segments.some((segment) => segment.text === '同時に話していた別発話'),
  '追加発話と重なる既存発話を削除しない');
assert(selectiveApplied.segments.some((segment) => segment.text === '未確定部分の再認識'),
  '未確定部分は再認識結果を保持する');

const fragmented = corrections.createCorrectionBlock({
  id: 'fragmented', range: { startSeconds: 1, endSeconds: 3 },
  rows: [{
    speaker: 'a', text: '区切りも直した発話', start: 1, end: 3,
    sourceStart: 1, sourceEnd: 3, confirmed: true,
  }],
});
const fragmentedApplied = corrections.applyCorrections({
  duration: 4,
  segments: [
    { start: 1, end: 2.1, text: '分割された前半' },
    { start: 1.95, end: 3, text: '分割された後半' },
  ],
}, [fragmented]);
assert.deepStrictEqual(fragmentedApplied.segments.map((segment) => segment.text), ['区切りも直した発話'],
  '同じ元発話を再認識が連続区間へ分割しても断片を残さない');

const nonOverlap = corrections.createCorrectionBlock({
  id: 'locked-2', range: { startSeconds: 20, endSeconds: 25 },
  rows: [{ speaker: 'a', text: '別範囲', start: 21, end: 22 }],
});
const replacement = corrections.createCorrectionBlock({
  id: 'locked-3', range: { startSeconds: 1, endSeconds: 4 },
  rows: [{ speaker: 'a', text: '新しい修正', start: 1.2, end: 2.5 }],
});
const updated = corrections.upsertCorrectionBlock([block, nonOverlap], replacement);
assert.deepStrictEqual(updated.map((item) => item.id), ['locked-3', 'locked-2']);

console.log('correction tests: OK');
