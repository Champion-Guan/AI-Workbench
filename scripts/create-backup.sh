#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_root="${GUAN_AI_WORKBENCH_BACKUP_DIR:-"$project_root/../guan-ai-workbench-backups"}"
description="${*:-manual}"

# Keep archive names portable and easy to sort. Use ASCII kebab-case for the
# optional stage description so the same command behaves consistently on macOS
# and Linux.
description="$(printf '%s' "$description" | sed -E 's/[[:space:]]+/-/g; s#[/]+#-#g; s/[^[:alnum:]_.-]+/-/g; s/-+/-/g; s/^-+//; s/-+$//')"
if [ -z "$description" ]; then
  description="manual"
fi

mkdir -p "$backup_root"
stamp="$(date '+%Y%m%d-%H%M%S')"
archive="$backup_root/guan-ai-workbench-${stamp}-${description}.tar.gz"
suffix=1
while [ -e "$archive" ]; do
  archive="$backup_root/guan-ai-workbench-${stamp}-${description}-$(printf '%02d' "$suffix").tar.gz"
  suffix=$((suffix + 1))
done

# Runtime dependencies and generated test output are intentionally omitted;
# package-lock files and source/dist assets are kept so the project can be
# restored and dependencies reinstalled deterministically.
tar -czf "$archive" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./output' \
  --exclude='./.playwright-cli' \
  --exclude='./playground-settings/node_modules' \
  -C "$project_root" .

printf 'Created backup: %s\n' "$archive"
