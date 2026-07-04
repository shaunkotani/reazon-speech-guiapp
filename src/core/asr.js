// ReazonSpeech ローカル文字起こしのコア処理
// - ffmpeg で任意の音声/動画を 16kHz mono float32 PCM に正規化
// - Silero VAD で発話区間に分割
// - 区間ごとに sherpa-onnx (reazonspeech-k2-v2) で認識し、開始/終了時刻つきセグメントを返す
//
// ネイティブ addon (`sherpa-onnx-node` + プラットフォーム別 .node) を使用する。
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sherpa = require('sherpa-onnx-node');
const { clusterEmbeddings, DIARIZE_THRESHOLD } = require('../shared/cluster');

const SAMPLE_RATE = 16000;

// asar 内パスは実行できないため、展開済み(app.asar.unpacked)を指すよう補正する
function unpackedPath(p) {
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
          .replace('app.asar/', 'app.asar.unpacked/');
}

/**
 * 同梱の ffmpeg バイナリのパス。無ければ null。
 * 配布物にはライセンス上クリーンな LGPL ビルドを置く。
 * - パッケージ後: extraResources により resources/ffmpeg/<platform>-<arch>/
 * - 開発時: リポジトリ直下 vendor/ffmpeg/<platform>-<arch>/
 */
function bundledFfmpegPath() {
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const rel = path.join('ffmpeg', `${process.platform}-${process.arch}`, bin);
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, rel) : null, // パッケージ後
    path.join(__dirname, '..', '..', 'vendor', rel),                       // 開発時
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

/**
 * ffmpeg のパスを解決する。
 * 1) 同梱の LGPL ビルド（配布時はこれ） 2) 開発時フォールバックの ffmpeg-static
 * （GPL。配布物には含めない） 3) system の `ffmpeg`。
 */
function resolveFfmpegPath() {
  const bundled = bundledFfmpegPath();
  if (bundled) return bundled;
  try {
    const p = require('ffmpeg-static');
    if (p) return unpackedPath(p);
  } catch (_) { /* ignore */ }
  return 'ffmpeg';
}

/**
 * 任意の音声/動画ファイルを 16kHz mono の Float32Array にデコードする。
 * @param {string} filePath
 * @param {object} [opts] { maxSeconds?: number } 指定時は先頭からその秒数だけ取り出す
 * @returns {Promise<Float32Array>}
 */
function decodeToPcm(filePath, opts = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    const args = ['-nostdin'];
    if (opts.startSeconds && opts.startSeconds > 0) {
      args.push('-ss', String(opts.startSeconds)); // 入力シーク（高速）。区間切り出し用
    }
    args.push('-i', filePath);
    if (opts.maxSeconds && opts.maxSeconds > 0) {
      args.push('-t', String(opts.maxSeconds)); // N 秒だけ
    }
    args.push(
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-',
    );
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`));
      }
      const buf = Buffer.concat(chunks);
      // little-endian float32。Buffer が 4byte 境界に揃うようにコピーする。
      const usable = buf.length - (buf.length % 4);
      const samples = new Float32Array(usable / 4);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buf.readFloatLE(i * 4);
      }
      resolve(samples);
    });
  });
}

/**
 * オフライン認識器を生成する。
 *
 * ホットワード辞書を渡すと復号を modified_beam_search に切り替える
 * （hotwords は beam search でしか効かない）。tokens.txt は日本語文字が
 * そのまま 1 トークンの「文字ベース」モデルなので modelingUnit='cjkchar' を
 * 指定し、hotwords ファイルの各語を文字単位に分割してマッチさせる。
 *
 * @param {string} modelDir reazonspeech-k2-v2 モデルのディレクトリ
 * @param {object} [opts]
 * @param {number} [opts.numThreads=2]
 * @param {string} [opts.hotwordsFile] 1行1語のホットワード辞書パス（空/不在なら無効）
 * @param {number} [opts.hotwordsScore=2.0] ホットワードの加点（大きいほど強制力↑・誤挿入リスク↑）
 * @param {number} [opts.maxActivePaths=4] beam search の探索幅
 * @param {boolean} [opts.beamSearch=false] 辞書が無くても modified_beam_search を使う（高精度モード・やや低速）
 */
function createRecognizer(modelDir, { numThreads = 2, hotwordsFile = '', hotwordsScore = 2.0, maxActivePaths = 4, beamSearch = false } = {}) {
  const useHotwords = !!hotwordsFile && fs.existsSync(hotwordsFile) && fs.statSync(hotwordsFile).size > 0;
  // 辞書は beam search 必須なので、辞書があれば高精度モードは強制 ON になる
  const useBeam = useHotwords || beamSearch;
  const modelConfig = {
    transducer: {
      encoder: path.join(modelDir, 'encoder-epoch-99-avg-1.int8.onnx'),
      decoder: path.join(modelDir, 'decoder-epoch-99-avg-1.int8.onnx'),
      joiner: path.join(modelDir, 'joiner-epoch-99-avg-1.int8.onnx'),
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads,
    provider: 'cpu',
    debug: 0,
    modelType: 'transducer',
  };
  if (useHotwords) modelConfig.modelingUnit = 'cjkchar';
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
    decodingMethod: useBeam ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths,
    hotwordsFile: useHotwords ? hotwordsFile : '',
    hotwordsScore: useHotwords ? hotwordsScore : 0,
  });
}

/**
 * ノイズ除去器（GTCRN）を生成する。
 * @param {string} modelPath gtcrn_simple.onnx のパス
 */
function createDenoiser(modelPath, { numThreads = 1 } = {}) {
  return new sherpa.OfflineSpeechDenoiser({
    model: {
      gtcrn: { model: modelPath },
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
  });
}

/**
 * PCM にノイズ除去をかける。strength(0..1) で原音とブレンドして除去強度を調整する。
 * 0 なら原音そのまま、1 なら完全除去。
 * @returns {Float32Array}
 */
function denoisePcm(denoiser, samples, strength) {
  if (!denoiser || !strength || strength <= 0) return samples;
  const a = Math.min(1, strength);
  // enableExternalBuffer=false: Electron では外部バッファ不可
  const out = denoiser.run({ samples, sampleRate: SAMPLE_RATE, enableExternalBuffer: false });
  const den = out.samples;
  if (a >= 1) return den;
  // 長さ差に備えて短い方に合わせてブレンド
  const n = Math.min(den.length, samples.length);
  const mixed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mixed[i] = (1 - a) * samples[i] + a * den[i];
  }
  return mixed;
}

/** PCM を WAV ファイルへ書き出す（プレビュー用）。 */
function writePcmToWav(samples, outPath) {
  sherpa.writeWave(outPath, { samples, sampleRate: SAMPLE_RATE });
  return outPath;
}

// ワーカー間で復号済み PCM を共有するための raw float32 入出力。
// sherpa.readWave は Electron で外部バッファを返して使えないため、自前で読み書きする。
function writePcmRaw(samples, outPath) {
  fs.writeFileSync(outPath, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  return outPath;
}

function readPcmRaw(p) {
  const buf = fs.readFileSync(p);
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n); // 通常 ArrayBuffer（外部バッファ回避）
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// ==== 話者分離（VAD 区間ごとの埋め込み + 自前クラスタリング） ====
// クラスタリング本体は ../shared/cluster.js（純 JS）に分離。

/**
 * 話者埋め込み抽出器を生成する。
 * @param {string} embPath 話者埋め込み .onnx（wespeaker 等）
 */
function createEmbeddingExtractor(embPath, { numThreads = 1 } = {}) {
  return new sherpa.SpeakerEmbeddingExtractor({
    model: embPath, numThreads, provider: 'cpu', debug: 0,
  });
}

/**
 * 1 区間分のサンプルから話者埋め込みベクトルを抽出する。
 * @returns {Float32Array}
 */
function extractEmbedding(extractor, samples) {
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  // enableExternalBuffer=false: Electron では外部バッファ不可
  return extractor.compute(stream, false);
}

/**
 * VAD を生成する。
 * @param {string} vadModelPath silero_vad.onnx のパス
 */
function createVad(vadModelPath, { numThreads = 1, bufferSizeInSeconds = 60 } = {}) {
  return new sherpa.Vad({
    sileroVad: {
      model: vadModelPath,
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads,
    provider: 'cpu',
    debug: 0,
  }, bufferSizeInSeconds);
}

// RNNT は区間先頭に無音が無いと最初の語を取りこぼすことがあるため、
// 各区間の前後に短い無音を付与してウォームアップさせる。
const PAD_SEC = 0.3;

function padSamples(samples) {
  const pad = Math.round(PAD_SEC * SAMPLE_RATE);
  const out = new Float32Array(pad + samples.length + pad);
  out.set(samples, pad);
  return out;
}

/**
 * 1つの発話区間を認識する（非同期・イベントループを塞がない）。
 */
async function recognizeSegment(recognizer, samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: padSamples(samples) });
  const r = await recognizer.decodeAsync(stream);
  return r;
}

/**
 * PCM を VAD で発話区間に分割し、各区間のサンプルを返す。
 * @returns {Array<{start:number,end:number,samples:Float32Array}>}
 */
function collectVadSegments(samples, vad) {
  vad.reset();
  const segs = [];
  const window = 512;
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front(false); // 外部バッファ不可
      vad.pop();
      segs.push({
        start: seg.start / SAMPLE_RATE,
        end: (seg.start + seg.samples.length) / SAMPLE_RATE,
        samples: seg.samples,
      });
    }
  };
  for (let i = 0; i < samples.length; i += window) {
    vad.acceptWaveform(samples.subarray(i, i + window));
    drain();
  }
  vad.flush();
  drain();
  return segs;
}

/**
 * ファイルを VAD で分割しつつ文字起こしする（単一ワーカー版）。
 * 並列版はメインプロセスのワーカープールが担う。話者分離は埋め込み+クラスタリング。
 */
async function transcribeFile(filePath, ctx, opts = {}) {
  const { recognizer, vad, denoiser, embedder } = ctx;
  const onProgress = opts.onProgress || (() => {});
  let samples = await decodeToPcm(filePath);
  if (denoiser && opts.denoiseStrength > 0) {
    samples = denoisePcm(denoiser, samples, opts.denoiseStrength);
  }
  const duration = samples.length / SAMPLE_RATE;

  const vadSegs = collectVadSegments(samples, vad);
  const segments = [];
  const embeddings = [];
  for (let i = 0; i < vadSegs.length; i++) {
    const seg = vadSegs[i];
    const r = await recognizeSegment(recognizer, seg.samples);
    const text = (r.text || '').trim();
    if (!text) continue;
    const entry = { start: seg.start, end: seg.end, text };
    if (opts.diarize && embedder) {
      embeddings.push(extractEmbedding(embedder, seg.samples));
      entry._emb = embeddings.length - 1;
    }
    segments.push(entry);
    onProgress(Math.min(0.99, (i + 1) / vadSegs.length));
  }
  onProgress(1);

  let diarized = false;
  let speakerCount = 0;
  if (opts.diarize && embedder && embeddings.length) {
    const labels = clusterEmbeddings(embeddings, { numSpeakers: opts.numSpeakers || 0 });
    for (const s of segments) { s.speaker = labels[s._emb]; delete s._emb; }
    diarized = true;
    speakerCount = new Set(labels).size;
  } else {
    for (const s of segments) delete s._emb;
  }

  return {
    segments,
    text: segments.map((s) => s.text).join('\n'),
    duration, diarized, speakerCount,
  };
}

/**
 * ファイルをデコード（必要ならノイズ除去）して WAV へ書き出す（プレビュー用）。
 * @returns {Promise<{wavPath:string, duration:number}>}
 */
async function renderPreviewWav(filePath, ctx, outPath, { denoiseStrength = 0, maxSeconds = 0 } = {}) {
  let samples = await decodeToPcm(filePath, { maxSeconds });
  if (ctx.denoiser && denoiseStrength > 0) {
    samples = denoisePcm(ctx.denoiser, samples, denoiseStrength);
  }
  writePcmToWav(samples, outPath);
  return { wavPath: outPath, duration: samples.length / SAMPLE_RATE };
}

module.exports = {
  SAMPLE_RATE,
  resolveFfmpegPath,
  decodeToPcm,
  createRecognizer,
  createVad,
  createDenoiser,
  createEmbeddingExtractor,
  extractEmbedding,
  clusterEmbeddings,
  collectVadSegments,
  recognizeSegment,
  writePcmRaw,
  readPcmRaw,
  denoisePcm,
  writePcmToWav,
  renderPreviewWav,
  transcribeFile,
};
