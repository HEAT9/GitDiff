#!/bin/bash
# 从「VSCode插件图标设计.png」中心取正方形，按菱形遮罩裁切后生成扩展图标 media/gtdiff-diamond.png
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/VSCode插件图标设计.png"
OUT="$ROOT/media/gtdiff-diamond.png"
W="${1:-1200}"

if ! command -v convert >/dev/null 2>&1; then
  echo "需要 ImageMagick（convert 命令）。" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "未找到源图: $SRC" >&2
  exit 1
fi

mkdir -p "$ROOT/media"
SQ=$(mktemp /tmp/gtdiff-sq.XXXXXX.png)
trap 'rm -f "$SQ"' EXIT

convert "$SRC" -gravity center -crop "${W}x${W}+0+0" +repage "$SQ"
HW=$((W - 1))
HM=$((W / 2))
convert "$SQ" \( -size "${W}x${W}" xc:black -fill white \
  -draw "polygon ${HM},0 ${HW},${HM} ${HM},${HW} 0,${HM}" \) \
  -alpha off -compose CopyOpacity -composite PNG32:/tmp/gtdiff-masked.png
convert /tmp/gtdiff-masked.png -trim +repage -resize 256x256 PNG32:"$OUT"
rm -f /tmp/gtdiff-masked.png
echo "已生成: $OUT ($(identify -format '%wx%h' "$OUT"))"
