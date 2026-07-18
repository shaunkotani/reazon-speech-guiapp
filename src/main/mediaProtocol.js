// app-media://media/<絶対パス> をローカルファイルとして <audio>/<video> に配信する。
//
// 重要: このスキーム経由の「ファイル途中からの読み直し」は Electron の
// protocol.handle では安定しない（実測。Range を正しく 206 で返しても、
// 200 全体返しでも、preload="metadata" の <audio> をシークした瞬間に
// MEDIA_ERR_NETWORK / PIPELINE_ERROR_READ になる）。
// そのため renderer 側は、シークが必要な用途（結果画面の全体プレイヤーと
// 区間の頭出し再生）では、この URL を fetch で丸ごと取得して Blob URL に
// 変換してから <audio> に渡す（scripts/test-renderer-playback.js で検証）。
// ここは「全体を一度で読み切る」だけの単純な配信に徹する。
//
// fetch はページ（file://）から見ると cross-origin になるので CORS を許可する。
const fs = require('fs');
const path = require('path');

const MEDIA_MIME = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

// app-media URL からローカルの実パスを取り出す
function filePathFromUrl(url) {
  let p = decodeURIComponent(new URL(url).pathname);
  // Windows: "/D:\..." の先頭スラッシュを落として実パスに戻す
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

async function handleMediaRequest(request) {
  const filePath = filePathFromUrl(request.url);

  let stat;
  try { stat = await fs.promises.stat(filePath); }
  catch (_) { return new Response(null, { status: 404 }); }

  const headers = {
    'Content-Type': MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Access-Control-Allow-Origin': '*', // file:// のページから fetch できるように
  };
  const { Readable } = require('stream');
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), { status: 200, headers });
}

function registerMediaProtocol(protocol) {
  protocol.handle('app-media', handleMediaRequest);
}

module.exports = { registerMediaProtocol, handleMediaRequest, filePathFromUrl, MEDIA_MIME };
