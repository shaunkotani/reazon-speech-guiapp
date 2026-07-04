# コード署名（Windows / Azure Trusted Signing）

Windows 配布物（`モコシ Setup x.y.z.exe` と中の `モコシ.exe`）を Azure Trusted Signing で
署名する手順。署名しないと Windows SmartScreen の警告が出ます。

- 未署名ビルド:  `npm run dist:win`（ローカル検証用・従来どおり）
- 署名ビルド:    `npm run dist:win:signed`（下記の環境変数が必要）

署名は electron-builder 26 のネイティブ対応（`win.azureSignOptions`）を使います。
設定は [`electron-builder.signed.js`](../electron-builder.signed.js) にあり、`package.json`
の `build` を継承して署名オプションだけを足しています。

---

## 1. 一度だけの Azure 側セットアップ

1. **Trusted Signing アカウント**を作成（Azure Portal → "Trusted Signing Accounts"）。
   作成した**リージョン**に対応する Endpoint URI を控える（例: 西ヨーロッパなら
   `https://weu.codesigning.azure.net/`、東US なら `https://eus.codesigning.azure.net/` など）。
2. **アイデンティティ検証**を完了する（Portal の Identity validations）。
   - 個人: 本人確認。組織: 事業者確認。**承認まで数日かかる**ことがある。
   - Public 証明書タイプは 3 年以上の履歴が必要。個人/新規は Private/検証タイプになる。
3. **証明書プロファイル**を作成（Certificate profiles）。プロファイル名を控える。
   - 発行される証明書の Subject（例 `CN=Your Name`）を控える → `AZURE_TS_PUBLISHER` に使う。

## 2. 署名用のサービスプリンシパル（アプリ登録）

1. Microsoft Entra ID → App registrations → 新規登録。
2. その App に**クライアントシークレット**を発行。
3. Trusted Signing アカウント（または証明書プロファイル）の IAM で、その App に
   ロール **「Trusted Signing Certificate Profile Signer」** を割り当てる。
4. 控える値:
   - テナントID → `AZURE_TENANT_ID`
   - アプリ(クライアント)ID → `AZURE_CLIENT_ID`
   - クライアントシークレット → `AZURE_CLIENT_SECRET`

## 3. 署名を実行する環境

- **Windows** で実行すること（signtool ベースのため）。
- **Windows SDK の `signtool.exe`** が使えること（Visual Studio / Windows SDK 同梱）。
- electron-builder が Trusted Signing 用の署名ツール（dlib）を利用します。

## 4. 環境変数

| 変数 | 種別 | 例 / 説明 |
|---|---|---|
| `AZURE_TENANT_ID` | 機密 | サービスプリンシパルのテナントID |
| `AZURE_CLIENT_ID` | 機密 | アプリ(クライアント)ID |
| `AZURE_CLIENT_SECRET` | 機密 | クライアントシークレット |
| `AZURE_TS_ENDPOINT` | 非機密 | `https://weu.codesigning.azure.net/`（作成リージョン） |
| `AZURE_TS_ACCOUNT` | 非機密 | Code Signing アカウント名 |
| `AZURE_TS_PROFILE` | 非機密 | 証明書プロファイル名 |
| `AZURE_TS_PUBLISHER` | 非機密 | 証明書 Subject と一致する表示名（例 `CN=Your Name`） |

> 機密（AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET）は**コミットしない**。
> ローカルは一時的な環境変数、CI は Secrets で渡す。

### ローカルでの実行例（PowerShell）

```powershell
$env:AZURE_TENANT_ID="..."; $env:AZURE_CLIENT_ID="..."; $env:AZURE_CLIENT_SECRET="..."
$env:AZURE_TS_ENDPOINT="https://weu.codesigning.azure.net/"
$env:AZURE_TS_ACCOUNT="your-account"
$env:AZURE_TS_PROFILE="your-profile"
$env:AZURE_TS_PUBLISHER="CN=Your Name"
npm run dist:win:signed
```

## 5. 署名の確認

```powershell
Get-AuthenticodeSignature ".\release\モコシ Setup 1.0.0.exe" | Format-List Status, SignerCertificate
```
`Status` が `Valid`、証明書の発行者が Microsoft ID Verified CS ... になっていれば成功。

## 6. GitHub Actions（任意）

`windows-latest` ランナーで署名まで自動化する例:

```yaml
jobs:
  build-win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run dist:win:signed
        env:
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_TS_ENDPOINT: ${{ vars.AZURE_TS_ENDPOINT }}
          AZURE_TS_ACCOUNT: ${{ vars.AZURE_TS_ACCOUNT }}
          AZURE_TS_PROFILE: ${{ vars.AZURE_TS_PROFILE }}
          AZURE_TS_PUBLISHER: ${{ vars.AZURE_TS_PUBLISHER }}
      - uses: actions/upload-artifact@v4
        with:
          name: win-installer
          path: release/*.exe
```

## 注意
- Azure Trusted Signing は**署名の実行に対して課金**されます（月額 + 署名数）。
- タイムスタンプは既定で `http://timestamp.acs.microsoft.com` を使用（`electron-builder.signed.js` で変更可）。
- macOS 側の署名/公証は本書の対象外（別途 Apple Developer ID ＋ notarize が必要）。
