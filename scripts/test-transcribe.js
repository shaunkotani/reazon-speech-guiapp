// Phase 1 検証用: sherpa-onnx で reazonspeech-k2-v2 をロードし wav を文字起こしする
const path = require('path');
const sherpa = require('sherpa-onnx');

const MODEL_DIR = path.join(__dirname, '..', 'models', 'reazonspeech-k2-v2');

function createRecognizer() {
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(MODEL_DIR, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(MODEL_DIR, 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner: path.join(MODEL_DIR, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(MODEL_DIR, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
      modelType: 'transducer',
    },
    decodingMethod: 'greedy_search',
  };
  return sherpa.createOfflineRecognizer(config);
}

function main() {
  const wav = process.argv[2] || path.join(__dirname, '..', 'samples', 'test.wav');
  console.log('loading recognizer...');
  const t0 = Date.now();
  const recognizer = createRecognizer();
  console.log(`recognizer loaded in ${Date.now() - t0}ms`);

  const wave = sherpa.readWave(wav);
  console.log(`wav: sampleRate=${wave.sampleRate}, samples=${wave.samples.length}`);

  const t1 = Date.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform(wave.sampleRate, wave.samples);
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  console.log(`decoded in ${Date.now() - t1}ms`);
  console.log('--- RESULT ---');
  console.log(JSON.stringify(result, null, 2));
}

main();
