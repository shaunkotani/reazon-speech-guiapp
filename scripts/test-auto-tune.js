'use strict';

const assert = require('assert');
const autoTune = require('../src/shared/autoTune');

assert.strictEqual(autoTune.normalizeText(' 今日は、ＡＩです。\n'), '今日はaiです');

const exact = autoTune.scoreText('今日は晴れです', '今日は晴れです');
assert.strictEqual(exact.accuracy, 1);
assert.strictEqual(exact.distance, 0);

const omitted = autoTune.scoreText('今日はとても良い天気です', '今日は良い天気です');
const inserted = autoTune.scoreText('今日は良い天気です', '今日はとても良い天気です');
assert(omitted.errorRate > inserted.errorRate, '発話の抜けを誤挿入より重く評価する');
assert.strictEqual(omitted.deletions, 3);

const rows = autoTune.normalizeReferenceRows([
  { speaker: 'a', speakerName: '司会', text: 'こんにちは。', start: 1, end: 2 },
  { speaker: 'b', speakerName: '回答者', text: ' よろしくお願いします ', start: 2, end: 4 },
  { speaker: 'b', text: '未確定の誤認識', start: 4, end: 5, confirmed: false },
  { speaker: 'b', text: '  ', start: null, end: null },
]);
assert.strictEqual(rows.length, 2);
assert.strictEqual(autoTune.normalizeReferenceRows([{ speaker: 'a', text: '追加発言', start: null, end: null }])[0].start, null);
assert.strictEqual(autoTune.referenceText(rows), 'こんにちはよろしくお願いします');
assert.strictEqual(autoTune.referenceText([
  { text: '確定', confirmed: true }, { text: '未確定', confirmed: false },
]), '確定');

const coarse = autoTune.buildCoarseCandidates({
  denoiseStrength: 0.5,
  vad: { maxSpeechDuration: 5, minSilenceDuration: 0.2, minSpeechDuration: 0.15, threshold: 0.4 },
}, { speakerCount: 3 });
assert(coarse.length >= 8 && coarse.length <= 12);
assert(coarse.some((item) => item.options.denoiseStrength === 0));
assert(coarse.some((item) => item.options.denoiseStrength === 0.8));
assert(coarse.some((item) => item.options.vad.overlapAware && item.options.vad.overlapSpeakers === 3));
assert.strictEqual(new Set(coarse.map((item) => autoTune.candidateKey(item.options))).size, coarse.length);
assert.strictEqual(coarse[0].seedDistance, 0);

const singleSpeaker = autoTune.buildCoarseCandidates({}, { speakerCount: 1 });
assert(singleSpeaker.every((item) => !item.options.vad.overlapAware));

const refinements = autoTune.buildRefinementCandidates(coarse[0], coarse);
assert(refinements.length >= 2 && refinements.length <= 4);

const candidates = [
  { id: 'slow', options: { denoiseStrength: 0.8, vad: { overlapAware: true } }, metrics: autoTune.scoreText('abcdef', 'abcdef') },
  { id: 'simple', options: { denoiseStrength: 0, vad: { overlapAware: false } }, metrics: autoTune.scoreText('abcdef', 'abcdef') },
  { id: 'bad', options: {}, metrics: autoTune.scoreText('abcdef', 'abxx') },
];
assert.strictEqual(autoTune.selectBestCandidate(candidates).id, 'simple');
assert.strictEqual(autoTune.confidenceFor(candidates[1], candidates), 'medium');

const nearSeed = {
  id: 'near', seedDistance: 0.1, options: { denoiseStrength: 0 },
  metrics: autoTune.scoreText('abcdef', 'abcxef'),
};
const farSeed = {
  id: 'far', seedDistance: 1.2, options: { denoiseStrength: 0 },
  metrics: autoTune.scoreText('abcdef', 'abcxef'),
};
assert.strictEqual(autoTune.selectBestCandidate([farSeed, nearSeed]).id, 'near');

console.log('auto tune tests: OK');
