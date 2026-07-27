#!/bin/bash
# 安装编译本扩展所需的 npm 依赖（TypeScript、@types/vscode 等）
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node，请先安装 Node.js（建议 LTS），并确保 node 在 PATH 中。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误: 未找到 npm，请安装 Node.js 自带的 npm，或启用 corepack。" >&2
  exit 1
fi

echo "Node: $(node -v)"
echo "npm:  $(npm -v)"
echo "在 $ROOT 执行 npm install ..."

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "依赖已安装。可执行: npm run compile 或 npm run package"
