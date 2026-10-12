#!/bin/sh
set -eu
GUAN_STABLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$GUAN_STABLE_ROOT/runtime/node" "$GUAN_STABLE_ROOT/scripts/start-macos.mjs"
