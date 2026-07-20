# 日本語・重なり音声の評価データ

話者別音声分離モデルを、単なる聞き比べではなく同じ条件で比較するためのローカル評価形式です。
音声・参照文字起こし・詳細結果は権利や個人情報を含み得るため、`local/` と `results/` は Git の対象外です。

## 1. 暫定データを作る

入力文字起こしは、1行1発話で話者名を必ず含めます。

```text
[00:00:01.200 --> 00:00:03.100] 話者A: おはようございます
[00:00:02.000 --> 00:00:02.800] 話者B: おはよう
```

```powershell
npm run eval:separation:prepare -- `
  --audio samples/twospeaksample.mp3 `
  --transcript samples/twospeaksample.txt `
  --output evaluation/local/twospeaksample.json `
  --license local-evaluation-only `
  --consent unverified `
  --annotation-status provisional
```

異なる話者の時刻が重なる箇所を抽出し、2話者・最大10秒の評価ケースへ変換します。発話単位の時刻しかないデータは、重なり部分だけの本文を厳密に切れないため `provisional` のまま扱います。

## 2. 現在モデルを測る

```powershell
npm run eval:separation -- `
  --manifest evaluation/local/twospeaksample.json `
  --output evaluation/results/current-convtasnet.json
```

`--manifest` は複数指定できます。詳細 JSON と、参照文・仮説文を載せない Markdown 集計が生成されます。

### 単独発話から条件制御した重なりを合成する

自然会話の発話単位文字起こしだけでは、重なり区間内の正解本文を厳密に切れません。そこで異なる話者の非重なり発話を切り出し、SNRと重なり率を固定して合成できます。

```powershell
npm run eval:separation:synthesize -- `
  --audio samples/conversationsample.wav `
  --transcript samples/conversationsample.txt `
  --output-dir evaluation/local/synthetic-conversation `
  --count 48 `
  --snr=-6,0,6 `
  --overlap-ratios=.25,.5,.75,1

npm run eval:separation -- `
  --manifest evaluation/local/synthetic-conversation/manifest.json `
  --output evaluation/results/synthetic-convtasnet.json
```

各ケースには混合音声に加えて、同じゲイン・時間配置の正解stemを保存します。評価時は正解stemを先にASRし、その結果を疑似正解として混合音声と分離音声を比較します。これにより、人手文字起こしの誤差を除いて「単独なら認識できた内容を分離処理が保てたか」を測れます。合成評価は実会話の代替ではなく、モデル比較とSNR・重なり率別の弱点分析に使います。

同じ入出力契約（16kHz mono、`[1,T] -> [1,2,T]`）の候補ONNXは、アプリへ組み込む前に直接比較できます。

```powershell
npm run eval:separation -- `
  --manifest evaluation/local/synthetic-conversation/manifest.json `
  --separation-model models/candidates/model.onnx `
  --model-id candidate-v1 `
  --model-name "Candidate v1" `
  --model-license unverified `
  --output evaluation/results/candidate-v1.json
```

任意モデルではファイルサイズとSHA-256も結果へ記録されます。入出力が異なるモデルは直接指定せず、専用アダプターかONNX変換を先に用意します。

主な指標:

- `mixtureCer`: 話者参照の連結順を入れ替えて最良にした、混合音声1本の cpCER。
- `separatedPitCer`: 分離出力と正解話者の割当を入れ替えて最良にした PIT-CER。小さいほど良い。
- `cerDelta`: `mixtureCer - separatedPitCer`。正なら分離で改善。
- `baselineCoverage` / `applicationCoverage`: 同時発話の語順に左右されない文字多重集合による補助的な漏れ・誤追加指標。
- `separationRtf`: 分離処理秒 ÷ 音声秒。1未満なら実時間より高速。
- `gateAccepted`: 実アプリと同じ相関・声紋・重複判定を通過したケース数。
- `cleanReferenceSummary`: 合成元stemのASRを疑似正解にした分離劣化。合成マニフェストでのみ出力。

cpCER と PIT-CER は比較可能な文字誤り率ですが、文字カバレッジは語順を見ない補助指標です。カバレッジだけでモデルを選定しません。

## 3. reviewed / gold データの作成基準

最終的なモデル選定には、暫定データではなく次を満たすデータを用意します。

1. 音声の利用許諾・話者同意・保存期限を記録し、外部共有可能範囲を明記する。
2. 日本語会議、電話、オンライン会議、残響、大小の声量、短い相槌を含める。
3. 重なりの開始・終了と各話者本文を、可能なら100ms以下の単位で付与する。
4. 1人が作業し別の1人が照合して `reviewed`、不一致を解消したものだけ `gold` とする。
5. 同じ収録・同じ話者がモデル調整用と最終テストへ跨らないよう分割する。
6. 最低200ケースを目安にし、条件別の件数とCERを併記する。短い相槌は別集計する。

マニフェストの `dataset.license`、`dataset.consent`、`dataset.annotationStatus` は空にしないでください。最終テストでは `annotationStatus` が `reviewed` または `gold` でない場合、評価結果にも警告が残ります。
