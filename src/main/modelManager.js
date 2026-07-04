// モデルファイルの所在解決と、未取得時の初回ダウンロードを担う。
//
// 解決順:
//   1) 開発時にリポジトリ直下 ./models があればそれを使う（再DL回避）
//   2) なければ userData/models を使い、欠けていれば HuggingFace 等から取得
const fs = require('fs');
const path = require('path');
const https = require('https');

const K2_FILES = [
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.int8.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'tokens.txt',
];
const K2_BASE =
  'https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/main';
const VAD_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const DENOISER_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx';
const EMB_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx';

/** ダウンロードが必要なファイル一覧 [{url, dest}] を返す */
function plannedDownloads(baseDir) {
  const k2Dir = path.join(baseDir, 'reazonspeech-k2-v2');
  const items = K2_FILES.map((f) => ({ url: `${K2_BASE}/${f}`, dest: path.join(k2Dir, f) }));
  items.push({ url: VAD_URL, dest: path.join(baseDir, 'silero_vad.onnx') });
  items.push({ url: DENOISER_URL, dest: path.join(baseDir, 'gtcrn_simple.onnx') });
  items.push({ url: EMB_URL, dest: path.join(baseDir, 'wespeaker_en_voxceleb_resnet34_LM.onnx') });
  return items;
}

function pathsFor(baseDir) {
  return {
    modelDir: path.join(baseDir, 'reazonspeech-k2-v2'),
    vadPath: path.join(baseDir, 'silero_vad.onnx'),
    denoiserPath: path.join(baseDir, 'gtcrn_simple.onnx'),
    embPath: path.join(baseDir, 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
  };
}

function isComplete(baseDir) {
  const { modelDir, vadPath, denoiserPath, embPath } = pathsFor(baseDir);
  return K2_FILES.every((f) => fs.existsSync(path.join(modelDir, f)))
    && fs.existsSync(vadPath) && fs.existsSync(denoiserPath) && fs.existsSync(embPath);
}

/**
 * 使用するモデルのベースディレクトリを決める。
 * @param {object} opts { repoModels?: string, userDataModels: string }
 * @returns {{baseDir:string, ready:boolean, source:'repo'|'userData'}}
 */
function resolveBaseDir({ repoModels, userDataModels }) {
  if (repoModels && isComplete(repoModels)) {
    return { baseDir: repoModels, ready: true, source: 'repo' };
  }
  return { baseDir: userDataModels, ready: isComplete(userDataModels), source: 'userData' };
}

/** 1ファイルをリダイレクト追従でダウンロードし、進捗を通知する */
function downloadFile(url, dest, onBytes) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { headers: { 'User-Agent': 'reazonspeech-app' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(tmp, { force: true });
        // HuggingFace は相対パスへリダイレクトすることがあるため基底 URL で解決する
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(downloadFile(nextUrl, dest, onBytes));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(tmp, { force: true });
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.on('data', (chunk) => onBytes && onBytes(chunk.length));
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
    });
    req.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
  });
}

/**
 * baseDir に欠けているモデルをすべてダウンロードする。
 * @param {string} baseDir
 * @param {(p:{file:string, downloaded:number, totalFiles:number, fileIndex:number})=>void} onProgress
 */
async function downloadAll(baseDir, onProgress) {
  const items = plannedDownloads(baseDir).filter((it) => !fs.existsSync(it.dest));
  let downloaded = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await downloadFile(it.url, it.dest, (n) => {
      downloaded += n;
      onProgress && onProgress({
        file: path.basename(it.dest),
        downloaded,
        totalFiles: items.length,
        fileIndex: i,
      });
    });
  }
}

module.exports = { pathsFor, isComplete, resolveBaseDir, downloadAll, plannedDownloads };
