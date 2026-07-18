// app-media 配信の実挙動テスト（GUI 不要・Electron 上で実行）。
//
// 区間再生は「元ファイルを <audio> に読ませて seek する」方式なので、
// シークが成立するかどうかがそのまま機能の成否になる。ここでは
// 実際の mediaProtocol ハンドラを登録し、隠しウィンドウで
// 読み込み → 中間地点へシーク → 再生 まで通るかを確認する。
//
//   npx electron scripts/test-media-seek.js [ファイル...]
const path = require('path');
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const { registerMediaProtocol } = require('../src/main/mediaProtocol');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app-media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = files.length ? files : [
  path.join(__dirname, '..', 'samples', 'twospeaksample.mp3'),
  path.join(__dirname, '..', 'samples', 'natural.wav'),
  path.join(__dirname, '..', 'samples', 'long.m4a'),
];

function mediaUrl(absPath) {
  const enc = absPath.split('/').map(encodeURIComponent).join('/');
  return 'app-media://media' + (enc.startsWith('/') ? enc : '/' + enc);
}

const PAGE = `
<script>
const { ipcRenderer } = require('electron');
ipcRenderer.on('probe', async (_e, url) => {
  const a = new Audio();
  const fail = (stage, extra) => ipcRenderer.send('result', {
    ok: false, stage,
    code: a.error && a.error.code, msg: a.error && a.error.message, ...extra,
  });
  a.src = url;
  try {
    await new Promise((res, rej) => {
      a.addEventListener('loadedmetadata', res, { once: true });
      a.addEventListener('error', () => rej(new Error('load')), { once: true });
      setTimeout(() => rej(new Error('timeout')), 10000);
    });
  } catch (e) { return fail('load: ' + e.message); }

  const duration = a.duration;
  const target = duration * 0.65;          // 区間ボタンと同じく中間へシーク
  try {
    const seeked = new Promise((res, rej) => {
      a.addEventListener('seeked', res, { once: true });
      a.addEventListener('error', () => rej(new Error('seek')), { once: true });
      setTimeout(() => rej(new Error('timeout')), 10000);
    });
    a.currentTime = target;   // 監視を張ってから実際にシークさせる
    await seeked;
  } catch (e) { return fail('seek: ' + e.message, { duration, target }); }

  try { await a.play(); } catch (e) { return fail('play: ' + e.message, { duration, target }); }

  // 再生が実際に進むか（進まなければ音は出ていない）
  const t0 = a.currentTime;
  await new Promise((r) => setTimeout(r, 700));
  const advanced = a.currentTime - t0;
  if (a.error) return fail('after-play', { duration, target, advanced });
  ipcRenderer.send('result', {
    ok: advanced > 0.05, stage: 'played',
    duration, target, from: t0, advanced,
  });
});
</script>`;

// ハーネス内で例外が出ても必ず終了させる（隠しウィンドウのゾンビ化防止）
setTimeout(() => { console.error('\nタイムアウト: 強制終了'); app.exit(2); }, 60 * 1000);

app.whenReady().then(async () => {
  registerMediaProtocol(protocol);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));

  let failed = 0;
  for (const f of targets) {
    const abs = path.resolve(f);
    const r = await new Promise((resolve) => {
      ipcMain.once('result', (_e, payload) => resolve(payload));
      win.webContents.send('probe', mediaUrl(abs));
    });
    const name = path.basename(abs);
    if (r.ok) {
      console.log(`OK   ${name}  seek→${r.target.toFixed(2)}s 再生位置が ${r.advanced.toFixed(2)}s 進行`);
    } else {
      failed++;
      console.log(`FAIL ${name}  stage=${r.stage} code=${r.code || '-'} msg=${r.msg || '-'}`);
    }
  }
  console.log(failed ? `\n${failed} 件失敗` : '\nすべて成功');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('\nハーネス自体のエラー:', e.message || e); app.exit(2); });
