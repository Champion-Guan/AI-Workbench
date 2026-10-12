#!/bin/sh
set -eu
MIGRATION_PROJECT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$MIGRATION_PROJECT"
if [ -x "$MIGRATION_PROJECT/runtime/node" ]; then
  exec "$MIGRATION_PROJECT/runtime/node" scripts/run-port-migration.mjs "$@"
fi
if [ -x /opt/homebrew/bin/node ]; then
  exec /opt/homebrew/bin/node scripts/run-port-migration.mjs "$@"
fi
if ! command -v node >/dev/null 2>&1; then
  echo '没有找到 Node.js；请使用包含 runtime/node 的完整工作台目录。未修改任何数据。' >&2
  exit 1
fi
exec node scripts/run-port-migration.mjs "$@"
