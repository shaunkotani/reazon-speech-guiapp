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
  ipcMain.on('clip-used', () => { clipUsed = true; });
  ipcMain.on('transcribe-opts', (_event, opts) => { lastTranscribeOpts = opts; });

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
    return j.querySelector('.denoise-seg [data-value="0"]').classList.contains('is-active')
      && j.querySelector('.preview-btn').disabled;`),
    'ノイズ除去の初期値は「なし」');
  await waitFor(`document.querySelector('.job .vad-saved-select option[value="short-replies"]')`,
    '保存済みVADプリセットが読み込まれる');
  check(await run(`const j=document.querySelector('.job');
    return j.querySelector('.vad-max').value === '6'
      && j.querySelector('.vad-sil').value === '0.2'
      && j.querySelector('.vad-min-speech').value === '0.15'
      && j.querySelector('.vad-sil').min === '0.05';`),
    '見直し後の標準値と無音長0.05秒が画面へ反映される');
  await run(`const j=document.querySelector('.job');
    j.querySelector('.vad-sil').value='0.05';
    j.querySelector('.vad-sil').dispatchEvent(new Event('input'));
    j.querySelector('.vad-preset-name').value='検証用プリセット';
    j.querySelector('.vad-save').click();`);
  await waitFor(`document.querySelector('.job .vad-save-status').textContent === '保存しました'`,
    'カスタムVADプリセットが保存される');
  check(await run(`const s=document.querySelector('.job .vad-saved-select');
    return [...s.options].some((o) => o.textContent === '検証用プリセット') && !!s.value;`),
    '保存したカスタムプリセットを選択状態にできる');
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
  await run(`document.querySelector('.job .start-btn').click()`);
  await waitFor(`document.querySelectorAll('.job .seg-play').length === 3`, '文字起こし結果が描画される');
  check(lastTranscribeOpts && lastTranscribeOpts.denoiseStrength === 0,
    '文字起こしへノイズ除去「なし」が渡される');
  check(lastTranscribeOpts && lastTranscribeOpts.vad.minSpeechDuration === 0.2,
    '文字起こしへ短い発話の最小長が渡される');

  check(await run(`return !document.querySelector('.job .job-result').classList.contains('hidden')`),
    '文字起こし後に結果欄が表示される');
  check(await run(`return document.querySelectorAll('.job .seg-play').length === 3`),
    '各行に ▶ ボタンがある');
  check(!(await run(`return document.querySelector('.job .result-audio-row').classList.contains('hidden')`)),
    '全体プレイヤーの行が表示されている（読み込み直後）');

  // 音源が実際に読めているか
  await sleep(1200);
  const st = await run(`const a = document.querySelector('.job .audio-result');
    return { ready: a.readyState, dur: a.duration, err: a.error && a.error.code };`);
  check(st.ready >= 1 && st.dur > 0 && !st.err,
    `全体プレイヤーが音源を読み込めた (readyState=${st.ready} duration=${st.dur} error=${st.err || 'なし'})`);

  // 3番目の区間を再生（12.36s へ頭出し）
  await run(`document.querySelectorAll('.job .seg-play')[2].click()`);
  await sleep(1200);
  const play = await run(`const a = document.querySelector('.job .audio-result');
    return { ct: a.currentTime, paused: a.paused, err: a.error && a.error.code,
      rowHidden: document.querySelector('.job .result-audio-row').classList.contains('hidden'),
      btn: document.querySelectorAll('.job .seg-play')[2].textContent };`);

  check(!play.rowHidden, '▶ を押しても全体プレイヤーの行が消えない');
  check(!play.err, `再生でメディアエラーが出ない (error=${play.err || 'なし'})`);
  check(play.ct >= 12.0, `該当区間へ頭出しされた (currentTime=${(play.ct || 0).toFixed(2)}s)`);
  check(!play.paused, '再生中である');
  check(play.btn === '■', `再生中はボタンが停止表示になる (${play.btn})`);
  check(!clipUsed, 'クリップ生成のフォールバックに落ちていない');

  // 区間末で自動停止するか（12.36-18.81 なので終端まで待たず、停止操作で確認）
  await run(`document.querySelectorAll('.job .seg-play')[2].click()`);
  await sleep(300);
  const stopped = await run(`const a = document.querySelector('.job .audio-result');
    return { paused: a.paused, btn: document.querySelectorAll('.job .seg-play')[2].textContent };`);
  check(stopped.paused && stopped.btn === '▶', 'もう一度押すと停止して ▶ に戻る');

  // 「設定を変えてやり直す」→ 再実行後も再生が生きているか
  // （resetResultUi の Blob URL 破棄・再生成の経路を通す）
  await run(`document.querySelector('.job .redo-btn').click()`);
  await waitFor(`!document.querySelector('.job .job-setup').classList.contains('hidden')`, 'やり直しで設定画面に戻る');
  await run(`document.querySelector('.job .start-btn').click()`);
  await waitFor(`document.querySelectorAll('.job .seg-play').length === 3`, '再実行の結果が描画される');
  await sleep(800);
  await run(`document.querySelectorAll('.job .seg-play')[0].click()`);
  await sleep(800);
  const redo = await run(`const a = document.querySelector('.job .audio-result');
    return { ct: a.currentTime, paused: a.paused, err: a.error && a.error.code,
      rowHidden: document.querySelector('.job .result-audio-row').classList.contains('hidden') };`);
  check(!redo.rowHidden && !redo.err && !redo.paused && redo.ct >= 0.6,
    `やり直し後も区間再生が動く (currentTime=${(redo.ct || 0).toFixed(2)}s error=${redo.err || 'なし'})`);

  const errLogs = logs.filter((l) => /error|失敗|unavailable|interrupted/i.test(l));
  if (errLogs.length) { console.log('\n-- renderer console --'); errLogs.forEach((l) => console.log('  ' + l)); }

  console.log(fails.length ? `\n${fails.length} 件失敗` : '\nすべて成功');
  app.exit(fails.length ? 1 : 0);
}
