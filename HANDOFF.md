# 引き継ぎドキュメント（ReazonSpeech ローカル文字起こしアプリ）

> 新しいセッションはまずこのファイルと `README.md` を読むこと。
> 実装の詳細な理由・ハマりどころはコード内コメントにも記載済み。

## 1. これは何か / ゴール
- ReazonSpeech の **k2 モデル**を **sherpa-onnx** で動かす、**完全ローカル・オフライン**の日本語文字起こし **Electron デスクトップアプリ**。
- ゴール: **Python も ReazonSpeech も入れていない端末で、誰でもダブルクリックで使える**こと。
- 対象OS: **macOS(Apple Silicon)＋Windows**。**Windows は CI（`release.yml`）でビルド→GitHub Releases 配布中。現行 v1.3.0**。mac は dmg のローカルビルドのみ。
- ライセンス: アプリ Apache-2.0 / モデル・sherpa-onnx も Apache-2.0。
- **配布方針（2026-07 更新）**: Windows は **Microsoft Store（AppX/MSIX）へ移行予定**（署名を Store に任せる）。→ 第6.5章・`docs/MICROSOFT_STORE.md`。

## 2. 技術スタック
| 層 | 採用 |
|---|---|
| デスクトップ | Electron 42 + electron-builder（`.dmg`/`.exe`） |
| 推論 | **sherpa-onnx-node**（ネイティブ addon・CPU・Python不要） |
| ASR モデル | reazonspeech-k2-v2（Zipformer transducer, int8, 約150MB） |
| 音声デコード | ffmpeg-static 同梱（任意フォーマット→16kHz mono） |
| 発話分割 | Silero VAD |
| ノイズ除去 | GTCRN（gtcrn_simple.onnx, 約0.5MB） |
| 話者埋め込み | wespeaker ResNet34（25MB, 話者識別用） |
| 音声再生 | `app-media://` カスタムプロトコルで `<audio>` 配信 |

## 3. ディレクトリ構成
```
src/
  core/asr.js          推論コア（decode/denoise/VAD/認識/埋め込み/クラスタ呼び出し/raw PCM I/O）
  main/main.js         Electron メイン（ウィンドウ/IPC/ワーカープール/プロトコル）
  main/asrWorker.js    子プロセス（純Node）。汎用RPCで prepare/processBatch/embedBatch/clip/preview/decodePcm
  main/preload.js      contextBridge（window.api.*）
  main/modelManager.js モデルの所在解決・初回ダウンロード
  renderer/            UI（index.html / renderer.js / styles.css）※バンドラなしの素のJS
  shared/export.js     TXT/SRT/VTT/JSON 整形（話者名対応）
  shared/cluster.js    話者クラスタリング＆手本ベース割当（純JS・ネイティブ非依存）
scripts/
  test-pool.js         並列プール＋話者分離のCLI検証
  test-enroll.js       後付けタグ付けフロー（文字起こし→遅延埋め込み→手本割当）のCLI検証
  test-pipeline.js     単一ワーカーのパイプライン検証
models/                gitignore。dev時に置くと優先使用（無ければ userData に初回DL）
release/               ビルド成果物（.dmg 等）
```

## 4. ⚠️ 重要なハマりどころ（必読・再発防止）
1. **`sherpa-onnx`(npm) は WASM 専用** → VAD がファイルパスから読めない。必ず **`sherpa-onnx-node` + プラットフォーム別ネイティブ**（`sherpa-onnx-darwin-arm64` 等・optionalDependencies）を使う。
2. **Electron は「外部バッファ」を全面禁止**（`ELECTRON_RUN_AS_NODE` でも同じ）。ネイティブ addon が外部バッファを返す箇所で `External buffers are not allowed` になる。対処:
   - `vad.front(false)`（enableExternalBuffer=false）
   - `extractor.compute(stream, false)`
   - `denoiser.run({..., enableExternalBuffer:false})`
   - **`sherpa.readWave()` は使用不可**（外部バッファを返す）→ ワーカー間 PCM 共有は **raw float32 の自前 I/O**（`core.writePcmRaw`/`readPcmRaw`）。
   - プロセス間で `Float32Array` を渡さない（埋め込みは `Array.from()` でプレーン配列化して IPC）。
3. **重い推論は必ず子プロセス**（`ELECTRON_RUN_AS_NODE=1` で fork）。メインで直接呼ぶと外部バッファで死ぬ＆UIが固まる。
4. **VAD区間先頭の語落ち** → 各区間の前後に 0.3秒無音パディング（`padSamples`）。
5. **HuggingFace は相対パスへリダイレクト**する → ダウンロードは `new URL(location, base)` で解決（`modelManager.downloadFile`）。
6. **ffmpeg-static のパス**はパッケージ後 asar 内になる → `app.asar`→`app.asar.unpacked` に置換（`resolveFfmpegPath`）。asarUnpack 対象: ffmpeg-static / sherpa-onnx-node / sherpa-onnx-*。
7. **`app-media:` スキームの `<audio>` はシーク不可**（protocol.handle の制約。Range を 206 で正しく返しても
   ファイル途中の読み直しで `MEDIA_ERR_NETWORK` / `PIPELINE_ERROR_READ`。`fetch(app-media://…)` も
   file:// ページからは Chromium が拒否）。→ シークが要る結果プレイヤーは **IPC `media:read` で中身を受け取り
   Blob URL 化**（renderer `loadResultAudio`）。CSP の media-src に `blob:` が必要。頭から流すだけのクリップ再生は
   app-media 直のままで良い。回帰テスト: `npx electron scripts/test-renderer-playback.js`（認識はスタブ・GUI 不要）／
   `npx electron scripts/test-media-seek.js`。テストハーネスは**必ず watchdog で強制終了**させること
   （例外→未処理 rejection→隠しウィンドウのままゾンビ化、が実際に起きた）。

## 5. 実装済み機能（すべて実機GUI検証済み）
1. ファイルD&D／選択 → 文字起こし（タイムスタンプ付き）
2. **取り込み音声のプレビュー再生**＋**ノイズ除去**（なし/弱/中/強・強度ブレンド）＋**除去後プレビュー**（先頭10秒クリップ）
3. エクスポート TXT/SRT/VTT/JSON＋コピー
4. **並列ワーカープール**（CPUコア数-1、最大4）で VAD区間を分配し ASR を並列実行（長尺高速化）＋**中止ボタン**＋進捗表示（文字起こし・声紋計算の進捗バーに**推定残り時間**を表示 = renderer `etaText()`。序盤 ratio<0.08 は非表示）
5. **話者識別（手本＝エンロールメント方式）**※UI刷新済み:
   - 事前オプションは無し。文字起こしは埋め込み無しで軽量。
   - 結果後に「話者でタグ付け」→ **声紋を遅延計算**（decodePcm+embedBatch を並列）→ タグ付けモード。
   - 各区間に ▶（クリップ生成方式で再生）＋話者割当プルダウン（未割当/話者N/＋新しい話者）。話者名は編集可能。
   - 確かな区間だけ手本を付け「手本で話者識別」→ 残りを最近傍で自動割当。**遠い区間は「話者不明」**（`UNKNOWN_THRESHOLD=0.75`）。
   - クラスタリング（`clusterEmbeddings`）は残置だが既定フローでは未使用。
6. モデル初回ダウンロード（k2 int8 / silero_vad / gtcrn / wespeaker）。dev は `./models` 優先。
7. **用語辞書（ホットワード）＋ modified_beam_search（C+A・実装済み・CLI検証済み）**:
   - UI: 上部の「用語辞書（ホットワード）」パネル（`#hotwords`）に 1行1語で登録＋「効き具合」スライダー（hotwordsScore 0.5〜5）＋ON/OFF。保存で `userData/hotwords.txt` と `userData/settings.json` に永続化。
   - 保存時に `destroyPool()` → 次回文字起こしで新辞書を読み込み。辞書が有効かつ非空なら `core.createRecognizer` が **`modified_beam_search` + `hotwordsFile` + `modelingUnit:'cjkchar'`** に自動切替（greedy に戻すのは辞書OFF/空のとき）。
   - **検証結果（HANDOFF第8章の未確認点の答え）**: tokens.txt が文字ベースの k2 でも **`modelingUnit:'cjkchar'` を付ければ素の「1行1語」hotwords がそのまま効く**。`bpeVocab` は不要。`node scripts/test-hotwords.js samples/natural.wav "文字起こし" 3.0` で `文字を誇示→文字起こし` を確認済み。
   - beam search 単体でも精度が上がる（辞書なしでも誤変換が減る例あり）。速度は greedy よりやや低下。
8. **高精度モード（beam search）トグル（実装済み・CLI検証済み）**:
   - 辞書とは独立したスイッチ。UI: 認識設定セクション上部の「高精度モード」チェックボックス（`#high-accuracy`）＋速度トレードオフの注記。変更で即 `accuracy:set` 保存＋`destroyPool()`。設定は `settings.highAccuracy`。
   - `core.createRecognizer` の `beamSearch` フラグで実現（`useBeam = useHotwords || beamSearch`）。**チェックボックスは常に操作可**（ユーザー自身の希望値 `userHighAccuracy` を表示）。辞書ON時は beam が OR で強制されるため「オフでも高精度で動作します」の注記のみ表示（UI: `syncAccuracyUI()`、`savedDictActive`）。以前は辞書ON時にチェック固定＋無効化していたが「触れない」と分かりにくいため独立操作に変更。
   - 検証: `beamSearch:true`（辞書なし）で `文字を誇示→文字起し` の矯正を確認（beam 単体効果）。
9. **テキスト出力に時刻プレフィックス（v1.1.0）**: TXT 書き出しとクリップボードコピーの各行頭に `[HH:MM:SS --> HH:MM:SS]` を付与（`shared/export.js` の `timePrefix`/`formatClock`、renderer `plainTextWithSpeakers`）。SRT/VTT/JSON は元々時刻ありで不変。
10. **データ初期化 / 完全アンインストール（v1.2.0）**: About モーダルの「メンテナンス」セクション。
    - `app:wipeData` = モデル・設定・辞書・一時ファイル削除（本体は残す）。`app:uninstall` = 上記＋終了後に userData 全削除＋NSIS アンインストーラを `/S` 起動（Windows）。
    - **削除前に必ず `destroyPool()`**（モデル .onnx のファイルロック解放）。`findWindowsUninstaller()` が `Uninstall *.exe` を探し、無ければ（dev/zip/**AppX**）「完全アンインストール」ボタンは自動 disabled。
    - ⚠️ **Store(AppX) では NSIS 経路は無効**（自動 disabled）。data 初期化のみ有効。→ MICROSOFT_STORE.md §0-2。
11. **自動アップデート（v1.3.0・electron-updater + GitHub Releases）**: ハイブリッド運用。
    - 起動1.5秒後に静かにチェック → 更新ありで上部バナー通知 → ユーザーが DL（進捗%）→「再起動して更新」（`quitAndInstall`）。About に手動「更新を確認」。
    - `autoDownload=false` / `autoInstallOnAppQuit=true`。`updaterEnabled()=app.isPackaged` でガード（IPC: `update:check`/`download`/`install`、イベント `update:status`/`update:progress`）。
    - `build.publish` に GitHub provider を明示。**フィード `latest.yml` は CI の `--publish always` が生成**。
    - ⚠️ **前提: リポジトリが public であること**（private だと updater が latest.yml を取得できない）。**Store(AppX) では無効化が必要**（`!process.windowsStore` を追加）→ MICROSOFT_STORE.md §0-1。

## 6. ビルド / 実行 / 検証
```bash
npm install
npm start                              # dev 起動（./models があれば使用）
npm run dist:mac                       # macOS(arm64) .dmg → release/
npm run dist:win                       # Windows(x64) .exe ※Windows実機で実行
node scripts/test-pool.js samples/twospeaksample.mp3 2  # 並列＋話者分離CLI検証
node scripts/test-enroll.js                        # 後付けタグ付けフローCLI検証
node scripts/test-hotwords.js samples/natural.wav "文字起こし,議事録" 3.0  # 辞書+beam検証（greedy比較）
```
- 成果物: `release/モコシ-1.0.0-arm64.dmg`、`release/mac-arm64/モコシ.app`（productName=「モコシ」）
- 署名: ユーザーの Apple Development 証明書で自動署名（未公証→他人のMacでは Gatekeeper 警告）。
- **アプリ名/アイコン**: 表示名は productName=「モコシ」（画面 `<h1>`・`<title>`・BrowserWindow title も「モコシ」）。npm の `name` は `reazonspeech` のまま。**userData は `app.setPath('userData', appData/'reazonspeech')` で固定**しているので、表示名を変えてもモデル/辞書/設定の保存先（`~/Library/Application Support/reazonspeech/`）は不変。
- **アイコンの置き場/生成**: `build/icon.png`（正方形1024px）を置くと electron-builder が mac用 `.icns`・win用 `.ico` を自動生成。元画像から整形は `bash scripts/make-icon.sh build/icon-source.png`（白背景で中央寄せパディング）。dev の Dock は `app.dock.setIcon(build/icon.png)` で差し替え。`.gitignore` は `build/*` を無視しつつ `icon.png`/`icon-source.png` のみコミット対象。

## 6.5 配布対応（ライセンス）— 2026-07 追加
- **FFmpeg を LGPL 化**: 配布物は `vendor/ffmpeg/<platform>-<arch>/ffmpeg[.exe]`（LGPL v3 ビルド）を同梱し、`core.resolveFfmpegPath` がこれを最優先で使う。`ffmpeg-static`（GPL）は開発フォールバックのみで、**Windows 配布からは `build.win.files` で除外**。
  - **Windows(x64) は配置済み**（BtbN win64-lgpl）。**mac(arm64) は未配置＝現状 GPL フォールバック**。配布前に `vendor/ffmpeg/darwin-arm64/ffmpeg` に LGPL mac ビルドを置くこと。
  - `vendor/ffmpeg/**` は `asarUnpack`（実行ファイルは asar 内から起動不可のため）。
- **アプリ内ライセンス画面**: ヘッダ「ⓘ 情報」→ `#about-modal`。IPC は `app:info` / `license:read`（`licenses/` をホワイトリスト読み）/ `license:openChromium`（同梱 `LICENSES.chromium.html` を既定アプリで開く）/ `shell:openExternal`。全文テキストは `licenses/{apache-2.0,lgpl-3.0,gpl-3.0,mit}.txt` と `licenses/NOTICE.txt`。
- **コード署名 / Windows 配布 — 方針転換（2026-07）**: Azure Trusted Signing は**やめて Microsoft Store（AppX/MSIX）配布に切り替え**。Store 経由なら Microsoft が自動署名し SmartScreen 警告も出ない。**計画・手順・既存機能への影響は `docs/MICROSOFT_STORE.md`（必読）**。旧 Azure 手順（`electron-builder.signed.js` / `dist:win:signed` / `docs/CODE_SIGNING.md`）は**非推奨**として残置（Store 一本化時に撤去可）。
  - ⚠️ **Store 化は自動アップデート(v1.3.0)と完全アンインストール(v1.2.0)に影響する**（Store が更新・アンインストールを担うため）。詳細と必要なコード変更（`updaterEnabled()` に `!process.windowsStore` を追加 等）は MICROSOFT_STORE.md §0 を参照。
- **未確認/要対応**: (1) mac LGPL ffmpeg の配置と mac 実機ビルド。(2) GTCRN / wespeaker(VoxCeleb) モデルの再配布ライセンスの最終確認（NOTICE に「上流準拠」で記載中）。(3) **Microsoft Store 対応**（Partner Center 登録・Identity取得・`appx`ターゲット追加・updater/uninstall の Store 分岐）→ `docs/MICROSOFT_STORE.md` の TODO。(4) mac 署名/公証（Developer ID＋notarize）は別途。

## 7. モデルURL（modelManager 参照）
- k2: `https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/main/{encoder,decoder,joiner}-epoch-99-avg-1.int8.onnx, tokens.txt`（**fp32版**は `.int8` を外したファイル名で同ディレクトリに存在）
- VAD: `.../releases/download/asr-models/silero_vad.onnx`
- 除去: `.../releases/download/speech-enhancement-models/gtcrn_simple.onnx`
- 埋め込み: `.../releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx`
- （不使用）pyannote分割: HF `csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx`

## 8. 未着手・次にやろうとしていたこと（精度向上）
- **A. modified_beam_search 復号 … 実装済み**（「高精度モード」トグルで辞書と独立に ON/OFF 可。辞書ON時は自動で強制 ON。第5章7・8参照）。
- **C. ホットワード辞書 … 実装済み・実機GUIは未検証**（CLI検証済み。第5章7参照）。**残: Electron 実プロセスでのGUI通し確認**（外部バッファ懸念は低いが未確認。beam の返り値は文字列なので greedy と同じマーシャリング）。
- **B. fp32 高精度モード**（未着手）… int8→fp32（encoder ~600MB・速度低下）。任意トグル案。fp32版ファイルは同ディレクトリに `.int8` を外した名前で存在。
- **D. 音量正規化**（未着手・ffmpeg loudnorm/dynaudnorm）… 小さい/ムラのある音声に有効。デコード段に追加。
- **F. nemo（619M・最高精度）を sherpa で動かせるか調査**（未着手）… 当たれば最大のジャンプだが不確実。

**次アクション候補**:
- **(最優先) Microsoft Store 対応** → `docs/MICROSOFT_STORE.md` の TODO（Partner Center 登録・`appx` 追加・updater/uninstall の Store 分岐）。方針転換で決定済み。
- (1) 用語辞書を実機GUIで通し検証（保存→文字起こしで反映されるか）。(2) hotwordsScore の既定値（現状2.0）を実運用で調整。(3) 余力あれば D（音量正規化）。
- 自動アップデート(v1.3.0)の実地確認: **リポジトリを public 化**した上で、旧バージョン→新バージョンの更新検知・DL・再起動適用を実機で確認。

### 発話区間の分割（VAD）— 認識結果を最も左右するノブ
**k2-v2 は短い発話で学習された RNN-T なので、1区間が長いと出力が数トークンに潰れる。**
区間長は精度の微調整ではなく「文字が出るか消えるか」を決める。19秒の電話音声
（`samples/twospeaksample.mp3`）を旧既定 `minSilence 0.5 / maxSpeech 20` で通すと、
無音が無いため全体が1区間になり結果が「もう楽しかった」7文字に潰れた。実測:

| 設定 (threshold/minSilence/maxSpeech) | 区間数 | 認識文字数 |
|---|---|---|
| 0.5 / 0.5 / 20（旧既定） | 1 | 7 |
| 0.5 / 0.35 / 12（新既定 standard） | 3 | 57 |
| 0.35 / 0.2 / 6（conversation） | 4 | 77 |

`natural.wav` / `test.wav` は standard で旧既定と同一結果（劣化なし）。conversation は
無音の多い独話だと文中で切れるため、プリセットを分けている。

- プリセット定義は `core/asr.js` の `VAD_PRESETS`（standard / conversation / lecture）。
  **レンダラの `renderer.js` にも同じ表を持つ**（require できないため）ので、変更時は両方直す。
- UI はジョブ単位（`.vad-row` のプリセット + `.vad-details` の3スライダー）。
  値は `transcribe:file` の `opts.vad` → worker `prepare` へ流れ、`vadFor()` が
  設定変更時だけ VAD を作り直す（**認識モデルは再ロードしない**ので切替は軽い）。
- `normalizeVadOptions()` が範囲外・不正値を丸める（UI 以外から来ても壊れない）。

その他の感度ノブ:
- VAD `threshold`(0.5): 下げると小声も拾う（過検出も増）
- `minSpeechDuration`(0.25s): これより短い発話を無視（相槌/ノイズ除去）
- recognizer `blankPenalty`: 上げると出力を促す（脱落減・挿入増リスク）
- 各区間に 0.3秒パディング（`PAD_SEC`）
- `createRecognizer` の `hotwordsScore`(既定2.0)/`maxActivePaths`(既定4): 辞書の効き具合と beam 探索幅

## 9. サンプル音声（samples/、gitignore）
- `twospeaksample.mp3` **実録音の2人の電話（19秒）**。話者分離・VAD 検証の標準 fixture。
  `test-pool.js` / `test-enroll.js` の既定入力。相槌が重なり無音がほぼ無いので、
  VAD 設定の検証にもこれを使う（合成音声では長区間潰れが再現しない）。
- `natural.wav` 1話者（自然なポーズ入り）／`long.m4a`／`test.wav`
- 旧 `twospk.wav`（`say` の Kyoko/Otoya 合成）は**実聴で同一話者に聞こえ 2話者 fixture として機能しない**ため削除し、
  `twospeaksample.mp3` に置き換えた。
- 合成音声(`say`)は声が似ていて自動クラスタリングが効きにくい。**話者識別の検証は「人数指定 or 手本」で行うこと**（実音声なら自動でも分離する）。
