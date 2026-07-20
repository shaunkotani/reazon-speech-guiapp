const assert = require('assert');
const progress = require('../src/shared/transcriptionProgress');

function test(name, fn) {
  try {
    fn();
    console.log(`OK   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

test('有効な設定だけを工程一覧へ含める', () => {
  assert.deepStrictEqual(progress.configuredPhases({ denoiseStrength: 0, vad: {} }), [
    'queued', 'preparing', 'decoding', 'vad', 'recognizing', 'finalizing',
  ]);
  assert.deepStrictEqual(progress.configuredPhases({
    denoiseStrength: 0.8, vad: { overlapAware: true },
  }), [
    'queued', 'preparing', 'decoding', 'denoising', 'vad', 'overlap', 'recognizing', 'finalizing',
  ]);
  assert.deepStrictEqual(progress.configuredPhases({
    denoiseStrength: 0, vad: { overlapAware: true, overlapSeparation: true },
  }), [
    'queued', 'preparing', 'decoding', 'vad', 'overlap', 'recognizing', 'separating', 'finalizing',
  ]);
});

test('待機中はETAを出さず、遅延警告の対象にしない', () => {
  const state = progress.createEtaState();
  assert.strictEqual(progress.updateEta(state, { phase: 'queued' }, 1000), '開始後に残り時間を計算');
  assert.strictEqual(progress.slowThresholdMs('queued'), Number.POSITIVE_INFINITY);
});

test('重なり解析中もチャンク進捗から残り時間を出す', () => {
  const state = progress.createEtaState();
  assert.strictEqual(progress.updateEta(state, {
    phase: 'overlap', completedWorkSec: 0, totalWorkSec: 120,
  }, 1000), '残り時間を計算中');
  assert.strictEqual(progress.updateEta(state, {
    phase: 'overlap', completedWorkSec: 60, totalWorkSec: 120,
  }, 5000), '残り 約10秒未満');
  assert.strictEqual(progress.updateEta(state, {
    phase: 'overlap', skippingOverlap: true,
  }, 6000), '通常の文字起こしへ切り替え中');
});

test('ETAは最初の有効な進捗から表示する', () => {
  const state = progress.createEtaState();
  const status = {
    phase: 'recognizing', completedWorkSec: 0, totalWorkSec: 100,
  };
  assert.strictEqual(progress.updateEta(state, status, 1000), '残り時間を計算中');
  assert.strictEqual(progress.updateEta(state, { ...status, completedWorkSec: 10 }, 2500), '残り 約15秒');
});

test('音声秒数がない進捗は区間数へフォールバックする', () => {
  const state = progress.createEtaState();
  progress.updateEta(state, { phase: 'recognizing', completed: 0, total: 10 }, 1000);
  assert.strictEqual(progress.updateEta(state, {
    phase: 'recognizing', completed: 2, total: 10,
  }, 4000), '残り 約15秒');
});

test('件数もない進捗は比率へフォールバックする', () => {
  const state = progress.createEtaState();
  progress.updateEta(state, { phase: 'recognizing', ratio: 0 }, 1000);
  assert.strictEqual(progress.updateEta(state, {
    phase: 'recognizing', ratio: 0.25,
  }, 4000), '残り 約10秒未満');
});

test('ETAは処理済み音声秒数から粗く安定した目安を返す', () => {
  const state = progress.createEtaState();
  progress.updateEta(state, { phase: 'recognizing', completedWorkSec: 0, totalWorkSec: 100 }, 1000);
  assert.strictEqual(progress.updateEta(state, {
    phase: 'recognizing', completedWorkSec: 20, totalWorkSec: 100,
  }, 6000), '残り 約20秒');
  assert.strictEqual(progress.updateEta(state, { phase: 'finalizing' }, 7000), 'まもなく完了');
});

test('長い音声の重い前処理には遅延警告までの猶予を持たせる', () => {
  assert.strictEqual(progress.slowThresholdMs('recognizing', 3600), 45000);
  assert(progress.slowThresholdMs('overlap', 3600) >= 90000);
  assert(progress.slowThresholdMs('overlap', 3600) <= 300000);
});

test('代表的な失敗を利用者向けエラーへ分類する', () => {
  assert.strictEqual(progress.describeError(new Error('ENOSPC: no space'), 'decoding').code, 'NO_DISK_SPACE');
  assert.strictEqual(progress.describeError(new Error('ENOENT: missing'), 'decoding').code, 'FILE_UNAVAILABLE');
  assert.strictEqual(progress.describeError(new Error('ワーカーが終了しました'), 'recognizing').code, 'WORKER_STOPPED');
  assert.strictEqual(progress.describeError(new Error('リアルタイム文字起こしの実行中は開始できません'), 'preparing').code, 'TRANSCRIBE_BUSY');
  assert.strictEqual(progress.describeError(new Error('中止しました'), 'recognizing', true).code, 'CANCELLED');
  assert.strictEqual(progress.describeError(new Error('unexpected'), 'vad').code, 'TRANSCRIBE_FAILED');
});

console.log('\nすべて成功');
