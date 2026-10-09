#!/usr/bin/env bash
#
# 由 SVG 源生成 PNG。
#
# 为什么要有这一步，而不是直接把 PNG 提交进仓库：
# 图标是**唯一事实源在矢量**的资源。提交一个 PNG 之后，改颜色就得重新导一遍，
# 而且没有人知道那个 PNG 是怎么来的（什么尺寸、什么工具、有没有被压缩过）。
# 提交 SVG + 一个确定性的转换脚本，代价是一次命令，收益是可追溯。
#
# ⚠️ 渲染器的选择在这里是**有实际后果的**：ImageMagick 在没有 librsvg 的情况下会用
# 内置解析器，而它对渐变与描边的支持不完整 —— 结果是**生成一个纯黑的方块而且退出码
# 为 0**。打包不会报错，看起来只是"图标怎么是黑的"。因此：
#   1. 浏览器（Chrome/Chromium）排在 ImageMagick 之前
#   2. 生成后强制做一次"颜色数"校验，平坦的产物直接判失败
#
# 用法：bash scripts/make-icons.sh

set -euo pipefail

SRC="build/icon.svg"
OUT="build/icon.png"
SIZE=512

cd "$(dirname "$0")/.."

if [ ! -f "$SRC" ]; then
  echo "找不到 $SRC" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

renderer=''

try() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1 && [ -s "$work/icon.png" ]; then
    renderer="$name"
    return 0
  fi
  rm -f "$work/icon.png"
  return 1
}

# --- 1. librsvg（质量最好，依赖最轻）----------------------------------------
if command -v rsvg-convert >/dev/null 2>&1; then
  try 'rsvg-convert' rsvg-convert -w "$SIZE" -h "$SIZE" -o "$work/icon.png" "$SRC" || true
fi

# --- 2. Inkscape ------------------------------------------------------------
if [ -z "$renderer" ] && command -v inkscape >/dev/null 2>&1; then
  try 'inkscape' inkscape "$SRC" --export-type=png --export-filename="$work/icon.png" \
    --export-width="$SIZE" --export-height="$SIZE" || true
fi

# --- 3. 无头浏览器 ----------------------------------------------------------
#
# 与打包产物同源的渲染引擎，保真度最高。两个细节：
#   - `--user-data-dir` 指向临时目录：不能碰用户真实的浏览器配置
#   - 以 root 运行时必须 `--no-sandbox`（容器 / 部分 CI）；普通用户下不加
if [ -z "$renderer" ]; then
  browser=''
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      browser="$(command -v "$candidate")"
      break
    fi
  done

  if [ -n "$browser" ]; then
    extra=()
    [ "$(id -u)" = '0' ] && extra+=(--no-sandbox)

    try 'headless browser' "$browser" --headless=new "${extra[@]}" --disable-gpu \
      --hide-scrollbars --default-background-color=00000000 --force-device-scale-factor=1 \
      --user-data-dir="$work/chrome-profile" --window-size="$SIZE,$SIZE" \
      --screenshot="$work/icon.png" "file://$PWD/$SRC" || true

    # 旧版 Chrome 不认 `--headless=new`。
    if [ -z "$renderer" ]; then
      try 'headless browser (legacy)' "$browser" --headless "${extra[@]}" --disable-gpu \
        --hide-scrollbars --default-background-color=00000000 --force-device-scale-factor=1 \
        --user-data-dir="$work/chrome-profile" --window-size="$SIZE,$SIZE" \
        --screenshot="$work/icon.png" "file://$PWD/$SRC" || true
    fi
  fi
fi

# --- 4. ImageMagick（最后手段）---------------------------------------------
if [ -z "$renderer" ]; then
  if command -v magick >/dev/null 2>&1; then
    try 'ImageMagick' magick -background none -density 384 "$SRC" -resize "${SIZE}x${SIZE}" \
      "$work/icon.png" || true
  elif command -v convert >/dev/null 2>&1; then
    try 'ImageMagick' convert -background none -density 384 "$SRC" -resize "${SIZE}x${SIZE}" \
      "$work/icon.png" || true
  fi

  if [ -n "$renderer" ]; then
    echo "⚠️  只有 ImageMagick 可用。若它编译时没带 librsvg，图标会被渲染成一个纯色方块。" >&2
    echo "   更强的做法：sudo apt install librsvg2-bin" >&2
  fi
fi

if [ -z "$renderer" ]; then
  cat >&2 <<'EOF'
没有可用的 SVG 转换工具。任选一个安装：

  sudo apt install librsvg2-bin     # 推荐：轻量、质量好
  sudo apt install inkscape
  # 或者：系统里已经有 Chrome / Chromium 也会被自动使用
EOF
  exit 1
fi

# --- 校验：平坦的产物说明渲染器不支持这个 SVG --------------------------------
if command -v identify >/dev/null 2>&1; then
  colors="$(identify -format '%k' "$work/icon.png")"
  dimensions="$(identify -format '%wx%h' "$work/icon.png")"

  if [ "$colors" -lt 16 ]; then
    echo "✗ 渲染结果只有 $colors 种颜色 —— 渲染器很可能不支持这个 SVG 的渐变/描边。" >&2
    echo "  换个渲染器重试：sudo apt install librsvg2-bin" >&2
    exit 1
  fi

  echo "· 渲染器：$renderer"
  echo "· 生成 $OUT（$dimensions，$colors 色）"
else
  echo "· 渲染器：$renderer"
  echo "· 生成 $OUT"
fi

# 先写临时文件再 mv：避免失败时留下一个坏掉的 icon.png，
# 而 electron-builder 对坏图标的反应是"打包成功但图标是空白"。
mv "$work/icon.png" "$OUT"
