#!/usr/bin/env bash
# アイコン整形: 任意の画像を 正方形1024px の build/icon.png にする（白背景で中央寄せ）。
# electron-builder が build/icon.png から mac用 .icns / win用 .ico を自動生成する。
#
# 使い方: bash scripts/make-icon.sh build/icon-source.png
set -euo pipefail
SRC="${1:-build/icon-source.png}"
OUT="build/icon.png"
[ -f "$SRC" ] || { echo "元画像が見つかりません: $SRC"; exit 1; }

TMP="$(mktemp -d)"
# 1) PNG に正規化
sips -s format png "$SRC" --out "$TMP/src.png" >/dev/null
# 2) 1024x1024 に白でパディング（中央寄せ・縦横比は保持）
sips -p 1024 1024 --padColor FFFFFF "$TMP/src.png" --out "$OUT" >/dev/null
rm -rf "$TMP"
echo "生成: $OUT"
sips -g pixelWidth -g pixelHeight "$OUT" | tail -2
