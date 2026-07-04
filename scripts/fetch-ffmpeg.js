// LGPL 版 FFmpeg バイナリを vendor/ffmpeg/<platform>-<arch>/ に取得する。
//
// なぜ: ffmpeg.exe は 100MB を超え GitHub のファイル上限に引っかかるため、
// リポジトリには含めず、ビルド時にここで取得する（dist:win の pre スクリプト）。
// 既に存在すれば何もしない（冪等）。
//
//   node scripts/fetch-ffmpeg.js            # 現在のプラットフォーム向けに取得
//
// 取得元は BtbN の LGPL 静的ビルド（--disable-gpl/nonfree、x264/x265/xvid 無効）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// プラットフォーム別の取得元。BtbN は Windows/Linux のみ提供（macOS は別途手当て）。
const SOURCES = {
  'win32-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip',
    bin: 'ffmpeg.exe',
  },
  'linux-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz',
    bin: 'ffmpeg',
  },
};

const key = `${process.platform}-${process.arch}`;
const destDir = path.join(__dirname, '..', 'vendor', 'ffmpeg', key);

async function main() {
  const src = SOURCES[key];
  if (!src) {
    console.log(`[fetch-ffmpeg] ${key} は自動取得の対象外です。`);
    console.log('  macOS(arm64) 等は LGPL ビルドを手動で vendor/ffmpeg/' + key + '/ に配置してください。');
    return; // ビルドを止めない（該当OSでの署名/配布時に別途対応）
  }
  const destBin = path.join(destDir, src.bin);
  if (fs.existsSync(destBin)) {
    console.log(`[fetch-ffmpeg] 既に存在: ${path.relative(process.cwd(), destBin)}（スキップ）`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-dl-'));
  const isZip = src.url.endsWith('.zip');
  const archive = path.join(tmp, isZip ? 'ffmpeg.zip' : 'ffmpeg.tar.xz');

  console.log(`[fetch-ffmpeg] ダウンロード中: ${src.url}`);
  const res = await fetch(src.url); // Node 18+ の global fetch（リダイレクト自動追従）
  if (!res.ok) throw new Error(`ダウンロード失敗: HTTP ${res.status}`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

  console.log('[fetch-ffmpeg] 展開中…');
  // tar は Windows 10+ / macOS(bsdtar) で zip も tar.xz も展開できる
  execFileSync('tar', ['-xf', archive, '-C', tmp], { stdio: 'inherit' });

  // 展開先から目的のバイナリを再帰探索してコピー
  const found = findFile(tmp, src.bin);
  if (!found) throw new Error(`展開物に ${src.bin} が見つかりません`);
  fs.copyFileSync(found, destBin);
  if (process.platform !== 'win32') fs.chmodSync(destBin, 0o755);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[fetch-ffmpeg] 配置完了: ${path.relative(process.cwd(), destBin)}`);
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name === name) return p;
  }
  return null;
}

main().catch((e) => { console.error('[fetch-ffmpeg] エラー:', e.message); process.exit(1); });
