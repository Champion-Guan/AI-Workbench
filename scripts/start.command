#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js，然后重新打开此文件。'
  read -r answer
  exit 1
fi
node scripts/start-portable.mjs
