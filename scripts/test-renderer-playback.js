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
  ipcMain.on('clip-used', () => { clipUsed = true; });

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

  // ファイルを取り込み → 文字起こし実行
  await run(`document.querySelector('#pick-btn').click()`);
  await waitFor(`document.querySelector('.job .start-btn')`, 'ジョブが作られる');
  await run(`document.querySelector('.job .start-btn').click()`);
  await waitFor(`document.querySelectorAll('.job .seg-play').length === 3`, '文字起こし結果が描画される');

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
