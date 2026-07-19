(function initUnsavedState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UnsavedState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const DEFAULT_PREFERENCES = Object.freeze({ confirmOnCloseWithUnsaved: true });

  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));

  function normalizePreferences(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      confirmOnCloseWithUnsaved: source.confirmOnCloseWithUnsaved !== false,
    };
  }

  function normalizeState(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      resultCount: count(source.resultCount),
      recordingCount: count(source.recordingCount),
      dictionaryChanged: source.dictionaryChanged === true,
      presetDraftCount: count(source.presetDraftCount),
      activeJobCount: count(source.activeJobCount),
      recordingActive: source.recordingActive === true,
    };
  }

  function hasUnsaved(state) {
    const value = normalizeState(state);
    return value.resultCount > 0
      || value.recordingCount > 0
      || value.dictionaryChanged
      || value.presetDraftCount > 0;
  }

  function hasActiveWork(state) {
    const value = normalizeState(state);
    return value.activeJobCount > 0 || value.recordingActive;
  }

  function shouldConfirm(state, preferences) {
    const prefs = normalizePreferences(preferences);
    return hasActiveWork(state) || (prefs.confirmOnCloseWithUnsaved && hasUnsaved(state));
  }

  function detailLines(state) {
    const value = normalizeState(state);
    const lines = [];
    if (value.recordingActive) lines.push('・録音中の音声');
    if (value.activeJobCount) lines.push(`・処理中の文字起こし ${value.activeJobCount}件`);
    if (value.resultCount) lines.push(`・保存していない文字起こし結果 ${value.resultCount}件`);
    if (value.recordingCount) lines.push(`・保存していない録音 ${value.recordingCount}件`);
    if (value.dictionaryChanged) lines.push('・用語辞書の変更');
    if (value.presetDraftCount) lines.push(`・保存していないカスタム設定 ${value.presetDraftCount}件`);
    return lines;
  }

  function buildDialogOptions(state) {
    const active = hasActiveWork(state);
    const options = {
      type: 'warning',
      title: 'モコシを終了しますか？',
      message: active ? '処理中または保存していない内容があります' : '保存していない内容があります',
      detail: [
        ...detailLines(state),
        '',
        '終了すると、これらの内容は失われます。',
        active
          ? '処理中・録音中の終了確認は無効にできません。'
          : 'この確認は、右上の「設定」からいつでも変更できます。',
      ].join('\n'),
      buttons: ['保存せず終了', '戻る'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    if (!active) {
      options.checkboxLabel = '次回から確認しない';
      options.checkboxChecked = false;
    }
    return options;
  }

  return {
    DEFAULT_PREFERENCES,
    normalizePreferences,
    normalizeState,
    hasUnsaved,
    hasActiveWork,
    shouldConfirm,
    detailLines,
    buildDialogOptions,
  };
}));
