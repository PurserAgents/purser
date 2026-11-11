#!/usr/bin/env bash
# Starts everything locally for a preview: a local copy of Robinhood Chain (anvil), Purser deployed on it, the engine
# in test mode with seeded agents, and the website built against it. Nothing is sent to the live chain.
#
#   ./preview.sh              plain local chain (fast, works offline)
#   ./preview.sh --fork       a fork of the live Robinhood Chain (reads the public node, never sends to it)
#   ./preview.sh --no-open    do not open the browser
#
# Engine on http://localhost:8787 (PURSER_PORT), site on http://localhost:3000 (WEB_PORT). Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
ENGINE_PORT="${PURSER_PORT:-8787}"
WEB_PORT="${WEB_PORT:-3000}"
FORK=""
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --fork) FORK="--fork" ;;
    --no-open) OPEN=0 ;;
  esac
done

export PATH="$HOME/.foundry/bin:$PATH"
command -v anvil >/dev/null || { echo "anvil (Foundry) is needed: https://getfoundry.sh"; exit 1; }
for dir in engine web; do
  [ -d "$dir/node_modules" ] || (cd "$dir" && npm install --no-audit --no-fund)
done

LOG="$ROOT/engine/data/preview-engine.log"
mkdir -p "$ROOT/engine/data"
cleanup() {
  trap - INT TERM EXIT
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true
  [ -n "${ENGINE_PID:-}" ] && kill "$ENGINE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "Stopped."
}
trap cleanup INT TERM EXIT

echo "Starting the engine in test mode${FORK:+ on a fork of Robinhood Chain}..."
(cd engine && PURSER_LOG=0 exec nice ./node_modules/.bin/tsx scripts/testmode.ts --port "$ENGINE_PORT" $FORK >"$LOG" 2>&1) &
ENGINE_PID=$!
for _ in $(seq 1 240); do
  grep -q "is running" "$LOG" 2>/dev/null && break
  kill -0 "$ENGINE_PID" 2>/dev/null || { cat "$LOG"; exit 1; }
  sleep 1
done
grep -q "is running" "$LOG" || { cat "$LOG"; exit 1; }

echo "Building the site against it..."
(cd web && PURSER_ENGINE_URL="http://localhost:$ENGINE_PORT" NEXT_TELEMETRY_DISABLED=1 PURSER_DIST_DIR=.next-preview nice node node_modules/next/dist/bin/next build >/dev/null)
(cd web && PURSER_ENGINE_URL="http://localhost:$ENGINE_PORT" NEXT_TELEMETRY_DISABLED=1 PURSER_DIST_DIR=.next-preview exec node node_modules/next/dist/bin/next start -p "$WEB_PORT" >/dev/null 2>&1) &
WEB_PID=$!
for _ in $(seq 1 60); do
  curl -fs "http://localhost:$WEB_PORT/own-risk" >/dev/null 2>&1 && break
  sleep 1
done

sed -n '/Purser test mode is running/,/Firewall demo/p' "$LOG" | grep -v "Firewall demo"
cat <<MSG

  Site            http://localhost:$WEB_PORT
  Dashboard       Connect wallet, then "Use the test wallet" (it owns the seeded agents)
  Firewall        http://localhost:$WEB_PORT/firewall, press "Run it"

Press Ctrl-C to stop the site, the engine and the local chain.
MSG
[ "$OPEN" = 1 ] && command -v open >/dev/null && open "http://localhost:$WEB_PORT" || true
wait "$WEB_PID"
