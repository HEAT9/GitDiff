#!/bin/bash
# 从「VSCode插件图标设计.png」提取两个圆形区域并增强清晰度，生成 media/gtdiff-icon.png
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/VSCode插件图标设计.png"
OUT="$ROOT/media/gtdiff-icon.png"

if ! command -v convert >/dev/null 2>&1; then
  echo "需要 ImageMagick（convert 命令）。" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "未找到源图: $SRC" >&2
  exit 1
fi

mkdir -p "$ROOT/media"
# 该区域覆盖设计稿中的两个圆形主体（可按需要微调）
convert "$SRC" -crop 620x840+560+600 +repage \
  -resize 1024x1024 \
  -sigmoidal-contrast 5,50% \
  -unsharp 0x1.1+1.1+0.02 \
  -background none -gravity center -extent 1024x1024 \
  -resize 256x256 PNG32:"$OUT"

echo "已生成: $OUT ($(identify -format '%wx%h' "$OUT"))"
