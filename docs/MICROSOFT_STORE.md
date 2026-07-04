# Microsoft Store 配布（MSIX / AppX）

> **方針転換（2026-07）**: Windows 配布の署名は **Azure Trusted Signing をやめ、Microsoft Store 配布に切り替える**。
> Store 経由なら Microsoft が自動で署名し、SmartScreen 警告も出ず、更新も Store が担う。
> 旧 Azure 署名の手順（[CODE_SIGNING.md](CODE_SIGNING.md)）は**非推奨（deprecated）**。

このドキュメントは「次セッションが Store 配布を実装するための計画書」。まだ**未実装**（コードは NSIS 前提のまま）。

---

## 0. なぜ切り替えるか / 何が変わるか

| 項目 | 従来（NSIS + GitHub Releases） | Microsoft Store（AppX/MSIX） |
|---|---|---|
| 署名 | 自前（Azure Trusted Signing・有料・要本人確認） | **Microsoft が自動署名**（自前証明書不要） |
| SmartScreen | 未署名だと警告 | **警告なし**（Store 信頼） |
| パッケージ形式 | `nsis`（`.exe` インストーラ） | **`appx`（`.msix`）** |
| インストール先 | `%LOCALAPPDATA%\Programs\モコシ`（書込可） | `%ProgramFiles%\WindowsApps\...`（**読取専用・ACLロック**） |
| 更新 | **electron-updater**（自前・v1.3.0で実装） | **Store が自動更新**（electron-updater は使えない） |
| アンインストール | NSIS アンインストーラ（自前・v1.2.0で実装） | **Store / 設定アプリ**から（NSIS 経路は無効） |
| 配布 | GitHub Releases に添付 | **Partner Center** へ提出（審査あり） |

### ⚠️ 既存機能への影響（重要）
1. **自動アップデート（v1.3.0, electron-updater）は Store ビルドでは動かない。**
   - Store アプリは `WindowsApps` 配下（読取専用）に入り、electron-updater がファイルを置換できない。更新は Store が行う。
   - Electron は AppX 実行時に **`process.windowsStore === true`** を立てる。→ updater をこのフラグで無効化する必要がある。
   - **要コード変更**: `src/main/main.js` の `updaterEnabled()` を
     `const updaterEnabled = () => app.isPackaged && !process.windowsStore;` に変更。
     併せて renderer 側の「アップデート」UI（About の `#check-update-btn`／起動時バナー）は
     Store ビルドで隠す or 「更新は Microsoft Store から」と表示する分岐を入れる。
2. **完全アンインストール（v1.2.0, NSIS 経路）は Store ビルドでは無効化される（自動）。**
   - `findWindowsUninstaller()` は `Uninstall *.exe` を探すが AppX には存在しない → **null → ボタンは自動で disabled**（既に graceful degrade 済み）。
   - 「アプリデータを初期化」（`app:wipeData`）は Store でも有効（userData を消すだけ）。
   - 補足文言を「本体のアンインストールは Windows の設定 → アプリ から」に変えると親切。

---

## 1. 前提（Partner Center）
1. **Microsoft Partner Center の開発者アカウント**を作成（個人は一度きりの登録料。要本人確認）。
2. **アプリ名を予約**（Partner Center → アプリとゲーム → 新規作成 → 名前の予約）。
3. **Identity 値を控える**（Partner Center → 製品 → 製品管理 → **製品 ID / パッケージ ID**）:
   - `Package/Identity/Name` → electron-builder の `appx.identityName`
   - `Package/Identity/Publisher`（`CN=...` 形式）→ `appx.publisher`
   - `Publisher display name` → `appx.publisherDisplayName`
   これらは Store が発行する固定値で、**ローカルの値と一致しないと提出が弾かれる**。

## 2. electron-builder の設定（次セッションで追加）
`package.json` の `build` に AppX ターゲットと `appx` ブロックを足す。NSIS を残すか置き換えるかは §5 の判断次第。

```jsonc
// build.win.target に "appx" を追加（NSIS と併存も可）
"win": { "target": [{ "target": "appx", "arch": ["x64"] }] },
"appx": {
  "identityName": "<Partner Center の Package/Identity/Name>",
  "publisher": "CN=<Partner Center の Publisher ID>",
  "publisherDisplayName": "<Publisher display name>",
  "applicationId": "Mokoshi",          // 英数字・先頭は英字・スペース不可
  "backgroundColor": "#ffffff",
  "showNameOnTiles": true,
  "languages": ["ja-JP", "en-US"]
}
```
- アイコン/タイル画像は `build/icon.png` から electron-builder が自動生成（必要なら `build/appx/` に個別アセットを置いて上書き）。
- `extraResources`（vendor/ffmpeg）と `asarUnpack`（sherpa-onnx-node / ffmpeg-static）は**そのまま有効**。AppX コンテナ内でも子プロセス（ffmpeg・ワーカー fork）の実行は可能。
- npm scripts 案: `"dist:win:store": "node scripts/fetch-ffmpeg.js && electron-builder --win appx --x64"`。

## 3. ビルドと成果物
```powershell
npm run dist:win:store   # release/*.appx (または *.msix) を生成
```
- 生成物は **自分では署名しない**（Store が署名する）。ローカル動作確認だけしたい場合は §4 のテスト署名。

## 4. ローカル検証（サイドロード）
Store 提出前に手元で動かすには **テスト証明書**で署名して sideload する:
```powershell
# 開発用の自己署名証明書を作り、appx に署名して信頼ストアに入れて Add-AppxPackage
# （electron-builder の appx は署名なしを出すので、makeappx/signtool で手動署名 or
#  自己署名運用にする。詳細は次セッションで確定）
Add-AppxPackage -Path ".\release\モコシ_x.y.z_x64.appx"
```
> 注意: sideload には「開発者モード」または署名済みパッケージ＋証明書の信頼が必要。
> Store 提出用の最終確認は Partner Center の検証（WACK: Windows App Certification Kit）で行う。

## 5. 提出とチャンネル方針（次セッションの判断ポイント）
- **A) Store 一本化**: NSIS/GitHub Releases をやめ、AppX のみ。updater 機能は撤去 or 無効化。運用が最もシンプル。
- **B) 併存**: GitHub Releases（NSIS + electron-updater, 直接DL勢向け）と Store（AppX）を両方維持。
  - この場合 `process.windowsStore` ゲートで updater は Store ビルドだけ無効になり、クリーンに共存できる。
  - CI は NSIS 発行（既存 `release.yml`）＋ AppX ビルドの 2 ジョブに。
- 現状の **既定リリースフロー（タグ push → NSIS を GitHub Releases へ）は当面維持**しておき、Store 対応は並行で足すのが安全（推奨: まず B、落ち着いたら A を検討）。

提出手順（概要）: `release/*.appx` を Partner Center の該当製品 → パッケージへアップロード → 年齢レーティング・価格・提出 → 審査（数日）。

## 6. TODO（次セッション着手順）
1. Partner Center 登録・アプリ名予約・Identity 値の取得（§1）。**これが無いと `appx` の値が埋められない。**
2. `package.json` に `appx` ブロック＋`dist:win:store` を追加（§2）。
3. `updaterEnabled()` に `!process.windowsStore` を追加し、Store ビルドで updater UI を隠す（§0-1）。
4. アンインストール UI の文言を Store 用に分岐（§0-2、任意）。
5. ローカル sideload で起動確認（ffmpeg・ネイティブ addon・モデル初回DL が AppX コンテナで動くか）。
6. WACK 通過 → Partner Center 提出。
7. 旧 Azure 署名の残骸（`electron-builder.signed.js`・`dist:win:signed`・`predist:win:signed`・[CODE_SIGNING.md](CODE_SIGNING.md)）を撤去するか判断（Store 一本化なら削除）。

## 7. 未確認・リスク
- AppX コンテナ内での **ffmpeg.exe / sherpa-onnx-node(.node) の実行可否**（asarUnpack + extraResources で package 内に展開されるが、実機 sideload で要検証）。
- **userData の場所**: AppX では `app.getPath('userData')` が仮想化された AppData（`...\Packages\<identity>\LocalCache\...`）にリダイレクトされることがある。モデル保存・データ初期化の挙動を実機確認。
- モデル初回ダウンロード（HuggingFace/GitHub への HTTPS）は Store ポリシー上問題なし（ユーザー同意のもとダウンロード）だが、初回サイズ（約150MB+）の UX を確認。
- Store 審査ポリシー（外部ダウンロード・LGPL ffmpeg 同梱）への適合確認。
