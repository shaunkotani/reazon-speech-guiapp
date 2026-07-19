// 実際の index.html + renderer.js を読み込み、結果画面の再生まわりを検証する（GUI 不要）。
//
//   npx electron scripts/test-renderer-playback.js
//
// 認識部分はスタブ（scripts/playback-preload.js）で固定結果に差し替え、
//   1) 文字起こし後に全体プレイヤーの行が出ているか
//   2) 各行の ▶ で該当区間へ頭出し再生されるか（＝行が消えないか）
//   3) クリップ生成のフォールバックに落ちていないか
// を確認する。
const path = require('path');
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const { registerMediaProtocol } = require('../src/main/mediaProtocol');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app-media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 何があっても必ずプロセスを終える。途中で例外が出ると未処理 rejection になり、
// 隠しウィンドウのままゾンビ化する（実際に起きた）ため、監視タイマーと
// try/catch の二段構えにする。
const WATCHDOG_MS = 60 * 1000;
setTimeout(() => {
  console.error(`\nタイムアウト: ${WATCHDOG_MS / 1000}s 以内に完了しなかったため強制終了`);
  app.exit(2);
}, WATCHDOG_MS);

const logs = [];
app.whenReady().then(main).catch((e) => {
  console.error('\nハーネス自体のエラー:', e.message || e);
  if (logs.length) { console.error('-- renderer console --'); logs.forEach((l) => console.error('  ' + l)); }
  app.exit(2);
});

async function main() {
  registerMediaProtocol(protocol);
  let clipUsed = false;
  let lastTranscribeOpts = null;
  let lastTrialOpts = null;
  let lastUnsavedState = null;
  let lastAppPreferences = null;
  ipcMain.on('clip-used', () => { clipUsed = true; });
  ipcMain.on('transcribe-opts', (_event, opts) => { lastTranscribeOpts = opts; });
  ipcMain.on('trial-opts', (_event, opts) => { lastTrialOpts = opts; });
  ipcMain.on('unsaved-state', (_event, value) => { lastUnsavedState = value; });
  ipcMain.on('app-preferences', (_event, value) => { lastAppPreferences = value; });

  const win = new BrowserWindow({
    show: false,
    // sandbox を切らないと preload 内で require('path') が使えない
    webPreferences: { preload: path.join(__dirname, 'playback-preload.js'), sandbox: false },
  });
  win.webContents.on('console-message', (e) => logs.push(e.message !== undefined ? e.message : String(e)));
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const run = (js) => win.webContents.executeJavaScript(`(() => { ${js} })()`);
  const fails = [];
  const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) fails.push(msg); };
  // DOM の更新を待つ（固定 sleep だと取込や認識の完了前に進んでしまう）
  async function waitFor(expr, what, timeout = 15000) {
    const t0 = Date.now();
    for (;;) {
      if (await run(`return !!(${expr})`)) return;
      if (Date.now() - t0 > timeout) throw new Error(`タイムアウト: ${what}`);
      await sleep(100);
    }
  }

  // 設定画面。終了確認を無効にした後も、この画面から戻せることを確認する。
  await run(`document.querySelector('#settings-btn').click()`);
  await waitFor(`!document.querySelector('#settings-modal').classList.contains('hidden')`,
    '設定画面が開く');
  check(await run(`return document.querySelector('#confirm-unsaved-close').checked
    && document.querySelector('.settings-note').textContent.includes('再びオン')
    && document.querySelector('.settings-note').textContent.includes('処理中');`),
    '設定画面に終了確認の切替と復帰方法が表示される');
  await run(`const c=document.querySelector('#confirm-unsaved-close');
    c.checked=false; c.dispatchEvent(new Event('change'));`);
  await waitFor(`document.querySelector('#settings-status').textContent === '変更しました'`,
    '終了確認設定が保存される');
  await sleep(50);
  check(lastAppPreferences && lastAppPreferences.confirmOnCloseWithUnsaved === false,
    '「次回から確認しない」と同じ設定を画面から無効にできる');
  await run(`const c=document.querySelector('#confirm-unsaved-close');
    c.checked=true; c.dispatchEvent(new Event('change'));`);
  await waitFor(`document.querySelector('#confirm-unsaved-close').checked
    && document.querySelector('#settings-status').textContent === '変更しました'`,
    '終了確認設定を再度有効にできる');
  await run(`document.querySelector('#settings-modal [data-settings-close]').click()`);
  check(await run(`return document.querySelector('#settings-modal').classList.contains('hidden')`),
    '設定画面を閉じられる');

  // 明示保存型の用語辞書は、編集から保存成功まで未保存として通知する。
  await waitFor(`typeof collectUnsavedState === 'function'`, '未保存状態の監視が初期化される');
  await run(`const t=document.querySelector('#hotwords-text'); t.value='検証語';
    t.dispatchEvent(new Event('input'));`);
  check(await run(`return collectUnsavedState().dictionaryChanged`)
      && lastUnsavedState && lastUnsavedState.dictionaryChanged,
    '用語辞書を編集すると未保存状態になる');
  await run(`document.querySelector('#hotwords-save').click()`);
  await waitFor(`document.querySelector('#hotwords-status').textContent.includes('保存しました')`,
    '用語辞書の保存が完了する');
  check(await run(`return !collectUnsavedState().dictionaryChanged`),
    '用語辞書の保存成功後は未保存状態を解除する');

  // 入力モード切替（既定はローカル。リアルタイムへ切替で録音パネル表示+事前準備）
  check(await run(`return document.querySelector('#mode-local').classList.contains('is-active')
    && !document.querySelector('#dropzone').classList.contains('hidden')
    && document.querySelector('#realtime').classList.contains('hidden');`),
    '初期状態はローカルモード（ドロップゾーン表示・録音パネル非表示）');
  await run(`document.querySelector('#mode-realtime').click()`);
  await waitFor(`document.querySelector('#rt-status').textContent === '準備完了'`,
    'リアルタイムモードへの切替で事前準備が完了する');
  check(await run(`return document.querySelector('#dropzone').classList.contains('hidden')
    && !document.querySelector('#realtime').classList.contains('hidden')
    && !document.querySelector('#rt-start').disabled;`),
    'リアルタイムモードで録音パネルが表示され、録音開始が押せる');
  check(await run(`return [...document.querySelector('#rt-vad').options]
    .some((o) => o.value === 'interview' && o.textContent === 'インタビュー');`),
    'リアルタイムのシチュエーションにもインタビュープリセットが表示される');
  check(await run(`return document.querySelector('#about-modal .about-repo-btn').dataset.url
    === 'https://github.com/shaunkotani/reazon-speech-guiapp';`),
    '情報画面にモコシのGitHubリポジトリへのリンクがある');
  await run(`document.querySelector('#mode-local').click()`);
  check(await run(`return !document.querySelector('#dropzone').classList.contains('hidden')
    && document.querySelector('#realtime').classList.contains('hidden');`),
    'ローカルモードへ戻るとドロップゾーンが再表示される');

  // ファイルを取り込み → 文字起こし実行
  await run(`document.querySelector('#pick-btn').click()`);
  await waitFor(`document.querySelector('.job .start-btn')`, 'ジョブが作られる');
  await waitFor(`document.querySelector('.job .audio-original').src.startsWith('blob:')`,
    '元音声プレビューがBlob URLを読み込む');
  await waitFor(`document.querySelector('.job .audio-original').readyState >= 1`,
    '元音声プレビューのメタデータが読み込まれる');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.audio-panel-label').textContent.trim() === '音声'
      && j.querySelector('.job-setup').firstElementChild.classList.contains('audio-panel')
      && j.querySelector('.denoise-row .plabel').textContent.trim() === 'ノイズの低減'
      && j.querySelector('.scenario-stage h3').textContent.includes('音声に合う設定')
      && j.querySelector('[data-scenario="normal"]')
      && j.querySelector('[data-scenario="custom"]')
      && j.querySelector('.vad-details summary').textContent.includes('さらに精度を調整');`),
    'ファイル名直下から音声・工程・6種類の設定・詳しい設定の順に表示される');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('[data-setup-step="1"]').classList.contains('is-current')
      && !j.querySelector('.scenario-card.is-active')
      && j.querySelector('.trial-open-btn').disabled
      && j.querySelector('.start-btn').classList.contains('hidden');`),
    '初期状態はシチュエーション選択が必須で、後工程を開始できない');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.denoise-seg [data-value="0"]').classList.contains('is-active')
      && j.querySelector('.preview-btn').disabled;`),
    'ノイズ除去の初期値は「なし」');
  await run(`document.querySelector('.job .vad-details summary').click()`);
  check(await run(`return document.querySelector('.job .vad-details').open`),
    '必要な場合だけ詳しい精度設定を開ける');
  await run(`const j=document.querySelector('.job');
    j.querySelector('.denoise-seg [data-value="0.5"]').click();
    j.querySelector('.preview-btn').click();`);
  await waitFor(`!document.querySelector('.job .denoised-row').classList.contains('hidden')
    && document.querySelector('.job .audio-denoised').src.startsWith('blob:')`,
    '折りたたみ内のノイズ低減プレビューが生成される');
  check(await run(`return !document.querySelector('.job .audio-denoised').error`),
    'ノイズ低減後の音声を読み込める');
  await run(`document.querySelector('.job .denoise-seg [data-value="0"]').click()`);
  await waitFor(`document.querySelector('.job .vad-saved-select option[value="short-replies"]')`,
    '保存済みVADプリセットが読み込まれる');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.vad-max').value === '6'
      && j.querySelector('.vad-sil').value === '0.2'
      && j.querySelector('.vad-min-speech').value === '0.15'
      && j.querySelector('.vad-sil').min === '0.05';`),
    '見直し後の標準値と無音長0.05秒が画面へ反映される');
  await run(`document.querySelector('.job [data-scenario="custom"]').click()`);
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('[data-scenario="custom"]').classList.contains('is-active')
      && !j.querySelector('.custom-choice-panel').classList.contains('hidden')
      && j.querySelector('.custom-choice-select option[value="short-replies"]')
      && j.querySelector('.trial-open-btn').disabled
      && j.querySelector('[data-setup-step="1"]').classList.contains('is-current');`),
    'カスタムは保存済み設定を選ぶまで工程1のままになる');
  await run(`const s=document.querySelector('.job .custom-choice-select');
    s.value='short-replies'; s.dispatchEvent(new Event('change'));`);
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.scenario-selected-name').textContent === '短い相槌'
      && j.querySelector('.vad-max').value === '3'
      && j.querySelector('.vad-sil').value === '0.05'
      && j.querySelector('[data-setup-step="1"]').classList.contains('is-complete')
      && j.querySelector('[data-setup-step="2"]').classList.contains('is-current')
      && !j.querySelector('.trial-open-btn').disabled;`),
    'カスタムで保存済み設定を選ぶと設定が適用され、工程2へ進む');
  await run(`document.querySelector('.job [data-scenario="normal"]').click()`);
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('[data-scenario="normal"]').classList.contains('is-active')
      && j.querySelector('.custom-choice-panel').classList.contains('hidden')
      && j.querySelector('.scenario-selected-name').textContent === '通常'
      && j.querySelector('.vad-max').value === '6'
      && j.querySelector('.vad-sil').value === '0.2'
      && j.querySelector('.vad-min-speech').value === '0.15'
      && j.querySelector('.vad-th').value === '0.5'
      && !j.querySelector('.trial-open-btn').disabled;`),
    '通常は標準値を適用し、明示選択後に工程2へ進む');
  await run(`const j=document.querySelector('.job');
    j.querySelector('.vad-sil').value='0.05';
    j.querySelector('.vad-sil').dispatchEvent(new Event('input'));
    j.querySelector('.vad-preset-name').value='検証用プリセット';
    j.querySelector('.vad-preset-name').dispatchEvent(new Event('input'));`);
  check(await run(`return collectUnsavedState().presetDraftCount === 1`),
    '名前を付けた未保存のカスタム設定を検出する');
  await run(`document.querySelector('.job .vad-save').click()`);
  await waitFor(`document.querySelector('.job .vad-save-status').textContent === '保存しました'`,
    'カスタムVADプリセットが保存される');
  check(await run(`const s=document.querySelector('.job .vad-saved-select');
    return [...s.options].some((o) => o.textContent === '検証用プリセット') && !!s.value
      && document.querySelector('.job [data-scenario="normal"]').classList.contains('is-active')
      && !document.querySelector('.job .trial-open-btn').disabled;`),
    '通常を選んだまま詳細設定を保存しても、工程の選択状態を保つ');
  check(await run(`return collectUnsavedState().presetDraftCount === 0`),
    'カスタム設定の保存成功後は未保存状態を解除する');
  await run(`return document.querySelector('.job .audio-original').play()`);
  await sleep(600);
  const preview = await run(`const a=document.querySelector('.job .audio-original');
    return { paused:a.paused, currentTime:a.currentTime, error:a.error && a.error.code, src:a.src };`);
  check(!preview.paused && preview.currentTime > 0 && !preview.error && preview.src.startsWith('blob:'),
    `元音声プレビューを再生できる (currentTime=${(preview.currentTime || 0).toFixed(2)}s error=${preview.error || 'なし'})`);
  await run(`document.querySelector('.job .audio-original').pause()`);
  check(await run(`const j=document.querySelector('.job');
    return !j.querySelector('.overlap-aware').checked && j.querySelector('.overlap-speakers').disabled;`),
    '標準プリセットでは重なり再解析がOFF');
  await run(`document.querySelector('.job [data-preset="conversation"]').click()`);
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.overlap-aware').checked && !j.querySelector('.overlap-speakers').disabled
      && j.querySelector('.overlap-speakers').value === '2'
      && j.querySelector('.vad-max').value === '3'
      && j.querySelector('.vad-sil').value === '0.1'
      && j.querySelector('.vad-min-speech').value === '0.2';`),
    '会話・電話プリセットへ指定値が入り、重なり再解析がON');
  await run(`document.querySelector('.job [data-preset="interview"]').click()`);
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.overlap-aware').checked && !j.querySelector('.overlap-speakers').disabled
      && j.querySelector('.overlap-speakers').value === '2'
      && j.querySelector('.vad-max').value === '3'
      && j.querySelector('.vad-sil').value === '0.1'
      && j.querySelector('.vad-min-speech').value === '0.15'
      && j.querySelector('.vad-th').value === '0.2'
      && j.querySelector('[data-setup-step="1"]').classList.contains('is-complete')
      && j.querySelector('[data-setup-step="2"]').classList.contains('is-current')
      && !j.querySelector('.trial-open-btn').disabled
      && !j.querySelector('.start-btn').classList.contains('hidden');`),
    'インタビュー選択で推奨値が入り、仕上がりテスト工程へ進む');
  check(await run(`const j=document.querySelector('.job'); const s=getComputedStyle(j.querySelector('.trial-open-btn'));
    return s.backgroundImage.includes('gradient') && Number(s.fontWeight) >= 700
      && j.querySelector('.start-btn').textContent.includes('テストせず');`),
    'テスト前は「仕上がりをテスト」が主操作になり、全体実行は控えめに表示される');

  // 全体実行前の短区間テスト。独立モーダルを開き、既定の冒頭60秒を試す。
  check(await run(`return document.querySelector('.job .trial-modal').classList.contains('hidden')`),
    '短区間の確認ウィンドウは初期状態では閉じている');
  await run(`document.querySelector('.job .trial-open-btn').click()`);
  check(await run(`return !document.querySelector('.job .trial-modal').classList.contains('hidden')`),
    '短区間の確認ボタンで独立ウィンドウが開く');
  await waitFor(`document.querySelector('.job .trial-range-audio').src.startsWith('blob:')
    && document.querySelector('.job .trial-range-status').textContent.includes('00:00〜01:00')
    && document.querySelector('.job .trial-range-audio').readyState >= 1`,
    'テスト範囲の音声プレビューが読み込まれる');
  check(await run(`return document.querySelector('.job .trial-range-audio').readyState >= 1
    && !document.querySelector('.job .trial-range-audio').error;`),
    'テスト範囲の音声を再生バーで確認できる');
  const firstRangeSrc = await run(`return document.querySelector('.job .trial-range-audio').src`);
  await run(`const s=document.querySelector('.job .trial-duration'); s.value='30'; s.dispatchEvent(new Event('change'))`);
  await waitFor(`document.querySelector('.job .trial-range-status').textContent.includes('00:00〜00:30')
    && document.querySelector('.job .trial-range-audio').src !== ${JSON.stringify(firstRangeSrc)}`,
    '指定範囲を変えると音声プレビューも更新される');
  await run(`const s=document.querySelector('.job .trial-duration'); s.value='60'; s.dispatchEvent(new Event('change'))`);
  await waitFor(`document.querySelector('.job .trial-range-status').textContent.includes('00:00〜01:00')`,
    'テスト範囲を既定の60秒へ戻す');
  await run(`document.querySelector('.job .trial-btn').click()`);
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.trial-start').disabled && j.querySelector('.trial-duration').disabled;`),
    '仕上がりテスト中は再生範囲を固定する');
  await waitFor(`!document.querySelector('.job .trial-result').classList.contains('hidden')`,
    '短区間の試し文字起こし結果が表示される');
  check(lastTrialOpts && lastTrialOpts.range.startSeconds === 0 && lastTrialOpts.range.durationSeconds === 60,
    '試し文字起こしへ既定の冒頭60秒が渡される');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelectorAll('.trial-seg').length === 3
      && j.querySelector('.trial-result-meta').textContent.includes('00:00')
      && !j.querySelector('.trial-fresh').classList.contains('hidden')
      && !j.querySelector('.trial-use-btn').disabled
      && !j.querySelector('.trial-start').disabled && !j.querySelector('.trial-duration').disabled
      && j.querySelector('.start-btn').textContent.includes('この設定で全体')
      && j.querySelector('[data-setup-step="3"]').classList.contains('is-current');`),
    'テスト結果を確認すると全体文字起こしが次の工程になる');
  await run(`const j=document.querySelector('.job');
    j.querySelector('.vad-max').value='4';
    j.querySelector('.vad-max').dispatchEvent(new Event('input'));`);
  check(await run(`const j=document.querySelector('.job');
    return !j.querySelector('.trial-stale').classList.contains('hidden') && j.querySelector('.trial-use-btn').disabled;`),
    '試行後に設定を変更すると再試行の警告が出る');
  await run(`document.querySelector('.job [data-preset="interview"]').click()`);
  check(await run(`return document.querySelector('.job .trial-stale').classList.contains('hidden')`),
    '試した設定へ戻すと確認済み状態へ戻る');
  await run(`document.querySelector('#high-accuracy').click()`);
  await sleep(50);
  check(await run(`return !document.querySelector('.job .trial-stale').classList.contains('hidden')`),
    'アプリ共通の高精度設定を変えても再試行の警告が出る');
  await run(`document.querySelector('#high-accuracy').click()`);
  await sleep(50);
  check(await run(`return document.querySelector('.job .trial-stale').classList.contains('hidden')`),
    '高精度設定も試行時へ戻すと確認済み状態へ戻る');
  await run(`document.querySelector('.job .trial-use-btn').click()`);
  check(await run(`return document.querySelector('.job .trial-modal').classList.contains('hidden')`),
    '「この設定で進む」で確認ウィンドウを閉じて全体実行へ進める');

  await run(`document.querySelector('.job .start-btn').click()`);
  check(await run(`return collectUnsavedState().activeJobCount === 1`),
    '処理開始直後は終了時に常に確認する状態になる');
  await waitFor(`document.querySelector('.job .progress-stage').textContent.includes('開始待ち')`,
    'キューの待機順が表示される');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.health-text').textContent === '待機中'
      && j.querySelector('.progress-count').textContent === '1 / 1件';`),
    '待機状態とキュー内の位置が表示される');
  check(await run(`applyTranscribeStatus(1, {
      state:'queued', phase:'queued', queuePosition:2, queueTotal:3
    }); const j=document.querySelector('.job');
    return j.querySelector('.progress-stage').textContent.includes('2番目 / 全3件')
      && j.querySelector('.progress-count').textContent === '2 / 3件';`),
    '待機ジョブの順番変更が画面へ反映される');
  await waitFor(`!document.querySelector('.job .progress-wrap').classList.contains('hidden')
    && document.querySelector('.job .progress-stage').textContent.includes('文字に変換')`,
    '文字起こし工程と進捗パネルが表示される');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.health-text').textContent === '正常に処理中'
      && j.querySelector('.progress-count').textContent.includes('/ 3区間')
      && j.querySelectorAll('.progress-steps li').length === 7;`),
    '正常性・処理区間数・工程一覧が表示される');
  await waitFor(`document.querySelector('.job .partial-seg-text')`, '認識済み文章が暫定表示される');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.partial-seg-text').textContent === 'はいもしもし'
      && j.querySelector('.partial-head').textContent.includes('暫定表示');`),
    '処理中の文字起こしを暫定結果と明記して表示する');
  check(await run(`const job=jobs.get(1); job.lastProgressAt=Date.now()-60000; updateProgressClock(job);
    return job.el.querySelector('.health-text').textContent === '通常より時間がかかっています'
      && !job.el.querySelector('.progress-warning').classList.contains('hidden');`),
    '更新が長く止まった工程はエラーと断定せず遅延警告を表示する');
  await waitFor(`document.querySelectorAll('.job-result .segments .seg-play').length === 3`, '文字起こし結果が描画される');
  check(lastTranscribeOpts && lastTranscribeOpts.denoiseStrength === 0,
    '文字起こしへノイズ除去「なし」が渡される');
  check(lastTranscribeOpts && lastTranscribeOpts.vad.preset === 'interview'
      && lastTranscribeOpts.vad.scenario === 'interview'
      && lastTranscribeOpts.vad.minSpeechDuration === 0.15
      && lastTranscribeOpts.vad.threshold === 0.2,
    '文字起こしへインタビュープリセットの値が渡される');

  check(await run(`return !document.querySelector('.job .job-result').classList.contains('hidden')`),
    '文字起こし後に結果欄が表示される');
  check(await run(`const s=collectUnsavedState(); return s.activeJobCount === 0 && s.resultCount === 1;`),
    '文字起こし完了後は未保存の結果として通知する');
  check(await run(`return document.querySelectorAll('.job-result .segments .seg-play').length === 3`),
    '各行に ▶ ボタンがある');
  check(await run(`const j=document.querySelector('.job');
    const redo=j.querySelector('.redo-btn');
    const redoStyle=getComputedStyle(redo);
    const tagStyle=getComputedStyle(j.querySelector('.tag-btn'));
    return !j.querySelector('.toolbar .redo-btn')
      && j.querySelector('.segments').nextElementSibling === j.querySelector('.result-rework')
      && j.querySelector('.result-rework-copy small').textContent.includes('この結果に戻れます')
      && redoStyle.borderTopStyle === 'solid'
      && redoStyle.backgroundColor !== tagStyle.backgroundColor;`),
    'やり直し操作は保存・話者操作から分離し、結果末尾に異なる見た目で表示される');
  check(await run(`const before=collectUnsavedState().resultCount;
    plainTextWithSpeakers(jobs.get(1));
    return before === 1 && collectUnsavedState().resultCount === 1;`),
    'コピー用テキストの生成だけでは保存済み扱いにしない');
  await run(`window.api.testSetNextExportSaved(false);
    document.querySelector('.job [data-fmt="txt"]').click()`);
  await sleep(50);
  check(await run(`return collectUnsavedState().resultCount === 1`),
    '保存ダイアログをキャンセルした場合は未保存状態を保つ');
  await run(`document.querySelector('.job [data-fmt="txt"]').click()`);
  await waitFor(`collectUnsavedState().resultCount === 0`, '文字起こし結果の保存状態が更新される');
  check(true, '文字起こし結果のファイル保存成功後は未保存状態を解除する');
  await run(`document.querySelector('.job .tag-btn').click()`);
  await waitFor(`!document.querySelector('.job .diar-edit').classList.contains('hidden')`,
    '話者タグ付け画面が開く');
  await run(`const s=document.querySelector('.job .seg-spk'); s.value='0'; s.dispatchEvent(new Event('change'));`);
  check(await run(`return collectUnsavedState().resultCount === 1`),
    '保存後に話者情報を変更すると再び未保存になる');
  await run(`document.querySelector('.job [data-fmt="txt"]').click()`);
  await waitFor(`collectUnsavedState().resultCount === 0`, '話者変更後の結果が再保存される');
  check(!(await run(`return document.querySelector('.job .result-audio-row').classList.contains('hidden')`)),
    '全体プレイヤーの行が表示されている（読み込み直後）');

  // 音源が実際に読めているか
  await sleep(1200);
  const st = await run(`const a = document.querySelector('.job .audio-result');
    return { ready: a.readyState, dur: a.duration, err: a.error && a.error.code };`);
  check(st.ready >= 1 && st.dur > 0 && !st.err,
    `全体プレイヤーが音源を読み込めた (readyState=${st.ready} duration=${st.dur} error=${st.err || 'なし'})`);

  // 3番目の区間を再生（12.36s へ頭出し）
  await run(`document.querySelectorAll('.job-result .segments .seg-play')[2].click()`);
  await sleep(1200);
  const play = await run(`const a = document.querySelector('.job .audio-result');
    return { ct: a.currentTime, paused: a.paused, err: a.error && a.error.code,
      rowHidden: document.querySelector('.job .result-audio-row').classList.contains('hidden'),
      btn: document.querySelectorAll('.job-result .segments .seg-play')[2].textContent };`);

  check(!play.rowHidden, '▶ を押しても全体プレイヤーの行が消えない');
  check(!play.err, `再生でメディアエラーが出ない (error=${play.err || 'なし'})`);
  check(play.ct >= 12.0, `該当区間へ頭出しされた (currentTime=${(play.ct || 0).toFixed(2)}s)`);
  check(!play.paused, '再生中である');
  check(play.btn === '■', `再生中はボタンが停止表示になる (${play.btn})`);
  check(!clipUsed, 'クリップ生成のフォールバックに落ちていない');

  // 区間末で自動停止するか（12.36-18.81 なので終端まで待たず、停止操作で確認）
  await run(`document.querySelectorAll('.job-result .segments .seg-play')[2].click()`);
  await sleep(300);
  const stopped = await run(`const a = document.querySelector('.job .audio-result');
    return { paused: a.paused, btn: document.querySelectorAll('.job-result .segments .seg-play')[2].textContent };`);
  check(stopped.paused && stopped.btn === '▶', 'もう一度押すと停止して ▶ に戻る');

  // 「設定を変えてやり直す」→ 再実行後も再生が生きているか
  // （resetResultUi の Blob URL 破棄・再生成の経路を通す）
  await run(`document.querySelector('.job .redo-btn').click()`);
  await waitFor(`!document.querySelector('.job .job-setup').classList.contains('hidden')`, 'やり直しで設定画面に戻る');
  await run(`document.querySelector('.job .start-btn').click()`);
  await waitFor(`document.querySelectorAll('.job-result .segments .seg-play').length === 3`, '再実行の結果が描画される');
  await sleep(800);
  await run(`document.querySelectorAll('.job-result .segments .seg-play')[0].click()`);
  await sleep(800);
  const redo = await run(`const a = document.querySelector('.job .audio-result');
    return { ct: a.currentTime, paused: a.paused, err: a.error && a.error.code,
      rowHidden: document.querySelector('.job .result-audio-row').classList.contains('hidden') };`);
  check(!redo.rowHidden && !redo.err && !redo.paused && redo.ct >= 0.6,
    `やり直し後も区間再生が動く (currentTime=${(redo.ct || 0).toFixed(2)}s error=${redo.err || 'なし'})`);

  // 構造化エラーが利用者向け説明と再試行導線へ変換されるか
  await run(`document.querySelector('#pick-btn').click()`);
  await waitFor(`document.querySelectorAll('.job').length === 2`, 'エラー表示検証用のジョブが作られる');
  await run(`document.querySelector('.job [data-scenario="interview"]').click()`);
  await run(`document.querySelector('.job .start-btn').click()`);
  await waitFor(`!document.querySelector('.job .job-error').classList.contains('hidden')`,
    '文字起こし失敗の説明が表示される');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.job-status').textContent === '失敗'
      && j.querySelector('.job-error-title').textContent.includes('空き容量')
      && j.querySelector('.job-error-technical').textContent.includes('NO_DISK_SPACE')
      && !j.querySelector('.retry-btn').classList.contains('hidden')
      && !j.querySelector('.job-setup').classList.contains('hidden');`),
    '失敗工程・技術情報・再試行ボタンを示し、設定画面へ戻る');

  // リアルタイム録音は文字起こし結果とは別に、WAV保存の成否を追跡する。
  await run(`addRealtimeResultJob({
    segments:[{start:0,end:1,text:'録音テスト'}], duration:1,
    wavPath:${JSON.stringify(path.join(__dirname, '..', 'samples', 'test.wav'))}, name:'録音テスト.wav'
  })`);
  check(await run(`return collectUnsavedState().recordingCount === 1`),
    'リアルタイム録音の結果は未保存の録音として通知する');
  await run(`document.querySelector('.job .save-audio-btn').click()`);
  await sleep(50);
  check(await run(`return collectUnsavedState().recordingCount === 1`),
    '録音の保存ダイアログをキャンセルした場合は未保存状態を保つ');
  await run(`window.api.testSetNextAudioSaved(true);
    document.querySelector('.job .save-audio-btn').click()`);
  await waitFor(`collectUnsavedState().recordingCount === 0`, '録音の保存状態が更新される');
  check(true, '録音のファイル保存成功後は未保存状態を解除する');

  const errLogs = logs.filter((l) => /error|失敗|unavailable|interrupted/i.test(l));
  if (errLogs.length) { console.log('\n-- renderer console --'); errLogs.forEach((l) => console.log('  ' + l)); }

  console.log(fails.length ? `\n${fails.length} 件失敗` : '\nすべて成功');
  app.exit(fails.length ? 1 : 0);
}
