// リアルタイム文字起こし用の AudioWorklet プロセッサ。
// 16kHz の AudioContext 上で動き、入力チャンネル 0 を 100ms（1600 サンプル）
// ごとにまとめて main スレッドへ postMessage する。
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(this.buf.length - this.fill, ch.length - i);
        this.buf.set(ch.subarray(i, i + n), this.fill);
        this.fill += n;
        i += n;
        if (this.fill === this.buf.length) {
          // slice でコピーを渡し、内部バッファは再利用する
          this.port.postMessage(this.buf.slice());
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
