// モデルファイルの所在解決と、未取得時の初回ダウンロードを担う。
//
// 解決順:
//   1) 開発時にリポジトリ直下 ./models があればそれを使う（再DL回避）
//   2) なければ userData/models を使い、欠けていれば HuggingFace 等から取得
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

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
const SEGMENTATION_URL =
  'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx';

// 16kHz・モノラル・2話者の ONNX 分離モデル。分離層は [1,T] -> [1,2,T]
// の契約に閉じてあり、MossFormer2 の ONNX 化後もモデル定義だけで交換できる。
const SEPARATION_MODEL = Object.freeze({
  id: 'convtasnet-libri2mix-16k-onnx',
  name: 'Conv-TasNet Libri2Mix 16kHz',
  filename: 'convtasnet_16k.onnx',
  url: 'https://huggingface.co/welcomyou/convtasnet-libri2mix-16k-onnx/resolve/da50e0fa7789356790994bc898290134fef5d42d/convtasnet_16k.onnx',
  bytes: 20154131,
  sha256: '22185d8e13bf5251c0eeab09e52099ac76c063cd9a5e5df1f5c242f535f6f151',
  license: 'CC-BY-SA-4.0',
  sourceUrl: 'https://huggingface.co/welcomyou/convtasnet-libri2mix-16k-onnx',
  sampleRate: 16000,
  speakers: 2,
});

/** ダウンロードが必要なファイル一覧 [{url, dest}] を返す */
function plannedDownloads(baseDir) {
  const k2Dir = path.join(baseDir, 'reazonspeech-k2-v2');
  const items = K2_FILES.map((f) => ({ url: `${K2_BASE}/${f}`, dest: path.join(k2Dir, f) }));
  items.push({ url: VAD_URL, dest: path.join(baseDir, 'silero_vad.onnx') });
  items.push({ url: DENOISER_URL, dest: path.join(baseDir, 'gtcrn_simple.onnx') });
  items.push({ url: EMB_URL, dest: path.join(baseDir, 'wespeaker_en_voxceleb_resnet34_LM.onnx') });
  items.push({ url: SEGMENTATION_URL, dest: path.join(baseDir, 'pyannote-segmentation.onnx') });
  return items;
}

function pathsFor(baseDir) {
  return {
    modelDir: path.join(baseDir, 'reazonspeech-k2-v2'),
    vadPath: path.join(baseDir, 'silero_vad.onnx'),
    denoiserPath: path.join(baseDir, 'gtcrn_simple.onnx'),
    embPath: path.join(baseDir, 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
    segmentationPath: path.join(baseDir, 'pyannote-segmentation.onnx'),
  };
}

function separationPathsFor(baseDir) {
  return {
    modelPath: path.join(baseDir, 'speech-separation', SEPARATION_MODEL.filename),
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes) hash.update(buffer.subarray(0, bytes));
    } while (bytes);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function isSeparationComplete(baseDir, { verifyHash = false } = {}) {
  const { modelPath } = separationPathsFor(baseDir);
  try {
    const stat = fs.statSync(modelPath);
    if (stat.size !== SEPARATION_MODEL.bytes) return false;
    return !verifyHash || sha256File(modelPath) === SEPARATION_MODEL.sha256;
  } catch (_) {
    return false;
  }
}

function isComplete(baseDir) {
  const { modelDir, vadPath, denoiserPath, embPath, segmentationPath } = pathsFor(baseDir);
  return K2_FILES.every((f) => fs.existsSync(path.join(modelDir, f)))
    && fs.existsSync(vadPath) && fs.existsSync(denoiserPath) && fs.existsSync(embPath)
    && fs.existsSync(segmentationPath);
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
function downloadFile(url, dest, onBytes, expectedSha256 = '') {
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
        return resolve(downloadFile(nextUrl, dest, onBytes, expectedSha256));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(tmp, { force: true });
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.on('data', (chunk) => onBytes && onBytes(chunk.length));
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        try {
          if (expectedSha256 && sha256File(tmp) !== expectedSha256.toLowerCase()) {
            fs.rmSync(tmp, { force: true });
            reject(new Error(`モデルの検証に失敗しました: ${path.basename(dest)}`));
            return;
          }
          fs.renameSync(tmp, dest);
          resolve();
        } catch (error) {
          fs.rmSync(tmp, { force: true });
          reject(error);
        }
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

async function downloadSeparation(baseDir, onProgress) {
  if (isSeparationComplete(baseDir, { verifyHash: true })) return;
  const { modelPath } = separationPathsFor(baseDir);
  if (fs.existsSync(modelPath)) fs.rmSync(modelPath, { force: true });
  let downloaded = 0;
  await downloadFile(SEPARATION_MODEL.url, modelPath, (bytes) => {
    downloaded += bytes;
    if (onProgress) onProgress({
      file: SEPARATION_MODEL.filename,
      downloaded,
      totalBytes: SEPARATION_MODEL.bytes,
      ratio: Math.min(1, downloaded / SEPARATION_MODEL.bytes),
    });
  }, SEPARATION_MODEL.sha256);
}

module.exports = {
  pathsFor,
  isComplete,
  resolveBaseDir,
  downloadAll,
  plannedDownloads,
  SEPARATION_MODEL,
  separationPathsFor,
  isSeparationComplete,
  downloadSeparation,
};
