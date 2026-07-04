// 話者埋め込みの凝集型クラスタリング（純 JS・ネイティブ依存なし）。
// メイン/ワーカー双方から利用する。

// マージしきい値（コサイン距離。小さいほど別話者になりやすい）
const DIARIZE_THRESHOLD = 0.55;
// 手本ベース割当で「話者不明」にするコサイン距離しきい値（これより遠ければ不明）
const UNKNOWN_THRESHOLD = 0.75;

function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

function cosineDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

/**
 * 埋め込み群を平均連結の凝集型クラスタリングで話者ラベル化する。
 * numSpeakers>0 ならその数まで統合、そうでなければ threshold で自動停止。
 * @param {Float32Array[]} embeddings
 * @returns {number[]} 各要素の話者ID（出現順 0,1,2,...）
 */
function clusterEmbeddings(embeddings, { numSpeakers = 0, threshold = DIARIZE_THRESHOLD } = {}) {
  const N = embeddings.length;
  if (N === 0) return [];
  if (N === 1) return [0];
  const vecs = embeddings.map(l2normalize);

  const clusters = vecs.map((_, i) => [i]);
  const active = clusters.map(() => true);
  const D = Array.from({ length: N }, () => new Float64Array(N));
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const d = cosineDistance(vecs[i], vecs[j]);
      D[i][j] = d; D[j][i] = d;
    }
  }
  let count = N;
  const targetK = (numSpeakers && numSpeakers > 0) ? Math.min(numSpeakers, N) : 1;

  while (count > targetK) {
    let bi = -1, bj = -1, best = Infinity;
    for (let i = 0; i < N; i++) {
      if (!active[i]) continue;
      for (let j = i + 1; j < N; j++) {
        if (!active[j]) continue;
        if (D[i][j] < best) { best = D[i][j]; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;
    if (!(numSpeakers && numSpeakers > 0) && best > threshold) break;

    const ni = clusters[bi].length, nj = clusters[bj].length;
    for (let k = 0; k < N; k++) {
      if (!active[k] || k === bi || k === bj) continue;
      const nd = (ni * D[bi][k] + nj * D[bj][k]) / (ni + nj);
      D[bi][k] = nd; D[k][bi] = nd;
    }
    clusters[bi] = clusters[bi].concat(clusters[bj]);
    active[bj] = false;
    count--;
  }

  const labels = new Array(N).fill(0);
  let next = 0;
  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    for (const m of clusters[i]) labels[m] = next;
    next++;
  }
  return labels;
}

/** 正規化済みベクトル平均（重心）を返す。 */
function centroid(vecs) {
  const dim = vecs[0].length;
  const c = new Float64Array(dim);
  for (const v of vecs) { const n = l2normalize(v); for (let d = 0; d < dim; d++) c[d] += n[d]; }
  let s = 0; for (let d = 0; d < dim; d++) s += c[d] * c[d]; s = Math.sqrt(s) || 1;
  const out = new Float32Array(dim); for (let d = 0; d < dim; d++) out[d] = c[d] / s;
  return out;
}

/**
 * 手本（話者ごとの代表区間）を基準に、各埋め込みを最近傍の話者へ割り当てる。
 * @param {Float32Array[]|number[][]} embeddings 全区間の埋め込み
 * @param {Object<number, number[]>} references { 話者ID: [区間index,...] }
 * @param {object} [opts] { threshold?: number } これより遠ければ -1（不明）
 * @returns {number[]} 各区間の話者ID（不明は -1）
 */
function assignByReferences(embeddings, references, { threshold = null } = {}) {
  const ids = Object.keys(references).map(Number).filter((id) => references[id] && references[id].length);
  if (!ids.length) return embeddings.map(() => -1);
  const centroids = ids.map((id) => centroid(references[id].map((i) => embeddings[i])));
  return embeddings.map((e) => {
    const v = l2normalize(e);
    let best = -1, bestDist = Infinity;
    for (let k = 0; k < ids.length; k++) {
      const d = cosineDistance(v, centroids[k]);
      if (d < bestDist) { bestDist = d; best = ids[k]; }
    }
    if (threshold != null && bestDist > threshold) return -1;
    return best;
  });
}

module.exports = { clusterEmbeddings, assignByReferences, DIARIZE_THRESHOLD, UNKNOWN_THRESHOLD };
