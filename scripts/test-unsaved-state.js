const assert = require('assert');
const unsaved = require('../src/shared/unsavedState');

function test(name, fn) {
  try {
    fn();
    console.log(`OK   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('終了確認は既定で有効', () => {
  assert.deepStrictEqual(unsaved.normalizePreferences({}), { confirmOnCloseWithUnsaved: true });
  assert.deepStrictEqual(unsaved.normalizePreferences({ confirmOnCloseWithUnsaved: false }), {
    confirmOnCloseWithUnsaved: false,
  });
});

test('保存していない結果・録音・辞書・プリセットを判定する', () => {
  const state = unsaved.normalizeState({
    resultCount: 2,
    recordingCount: 1,
    dictionaryChanged: true,
    presetDraftCount: 1,
  });
  assert.strictEqual(unsaved.hasUnsaved(state), true);
  assert.strictEqual(unsaved.shouldConfirm(state, { confirmOnCloseWithUnsaved: true }), true);
  assert.deepStrictEqual(unsaved.detailLines(state), [
    '・保存していない文字起こし結果 2件',
    '・保存していない録音 1件',
    '・用語辞書の変更',
    '・保存していないカスタム設定 1件',
  ]);
});

test('確認を無効にすると通常の未保存内容では確認しない', () => {
  const state = { resultCount: 1 };
  assert.strictEqual(unsaved.shouldConfirm(state, { confirmOnCloseWithUnsaved: false }), false);
});

test('処理中・録音中は設定にかかわらず確認する', () => {
  assert.strictEqual(unsaved.shouldConfirm({ activeJobCount: 1 }, { confirmOnCloseWithUnsaved: false }), true);
  assert.strictEqual(unsaved.shouldConfirm({ recordingActive: true }, { confirmOnCloseWithUnsaved: false }), true);
  const options = unsaved.buildDialogOptions({ recordingActive: true });
  assert.strictEqual(options.checkboxLabel, undefined);
  assert.match(options.detail, /終了確認は無効にできません/);
});

test('通常の未保存確認には次回から確認しない選択肢と設定画面の案内がある', () => {
  const options = unsaved.buildDialogOptions({ resultCount: 1 });
  assert.strictEqual(options.checkboxLabel, '次回から確認しない');
  assert.strictEqual(options.defaultId, 1);
  assert.strictEqual(options.cancelId, 1);
  assert.match(options.detail, /右上の「設定」/);
});

console.log('\nすべて成功');
