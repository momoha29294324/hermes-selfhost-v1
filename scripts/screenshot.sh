#!/usr/bin/env bash
# Captures the dashboard pages with headless Chrome, for review or documentation.
# Usage: scripts/screenshot.sh <output-dir> [base-url]
set -euo pipefail

OUT_DIR="${1:-var/screenshots}"
BASE="${2:-http://localhost:3210}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME" ]; then
  echo "Chrome introuvable: $CHROME" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

shot() {
  local url="$1" name="$2"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --virtual-time-budget=8000 \
    --window-size=1440,2400 --screenshot="$OUT_DIR/$name.png" "$url" >/dev/null 2>&1
  echo "$OUT_DIR/$name.png"
}

shot "$BASE/" "dashboard"

# First prospect that has a message, so the detail page shows the full chain.
PROSPECT_ID="${3:-}"
if [ -n "$PROSPECT_ID" ]; then
  shot "$BASE/prospects/$PROSPECT_ID" "prospect-detail"
fi
