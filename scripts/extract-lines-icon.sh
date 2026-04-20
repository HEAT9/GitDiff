#!/bin/bash
# 从「VSCode插件图标设计.png」提取可小尺寸识别的黑色线稿图标（白色背景）
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/VSCode插件图标设计.png"
OUT="$ROOT/media/gtdiff-lines.png"
TMP1="/tmp/gtdiff-gray.png"
TMP2="/tmp/gtdiff-edge.png"
TMP3="/tmp/gtdiff-tight.png"

if ! command -v convert >/dev/null 2>&1; then
  echo "需要 ImageMagick（convert 命令）。" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "未找到源图: $SRC" >&2
  exit 1
fi

mkdir -p "$ROOT/media"

# 1) 转灰度并平滑，避免噪点
convert "$SRC" -colorspace Gray -blur 0x0.9 "$TMP1"

# 2) 边缘提取：只保留线条轮廓，避免整块黑糊
convert "$TMP1" -canny 0x1+12%+32% -negate "$TMP2"

# 3) 仅保留黑线、去噪点、轻微加粗，便于缩小时可读
convert "$TMP2" \
  -threshold 68% \
  -despeckle \
  -morphology Dilate Diamond \
  -fill black -opaque white \
  -fill white -opaque black \
  -trim +repage \
  "$TMP3"

# 4) 白色背景 + 居中留白，提升 16/24/32 尺寸辨识度
convert "$TMP3" \
  -background white -gravity center -extent 860x860 \
  -resize 256x256 PNG24:"$OUT"

rm -f "$TMP1" "$TMP2" "$TMP3"
echo "已生成: $OUT ($(identify -format '%wx%h' "$OUT"))"
