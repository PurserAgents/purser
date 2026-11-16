#!/usr/bin/env bash
# Publish every Purser package to npm under @purseragents, in dependency order.
#   ./packages/publish.sh            (from the repo root, logged in with `npm login` as the account that owns @purseragents)
#   ./packages/publish.sh --dry-run  (pack and check, publish nothing)
# Inside the repo the packages point at the SDK with "file:../sdk"; the published copies point at the SDK's version.
set -euo pipefail
cd "$(dirname "$0")"
DRY=""; [ "${1:-}" = "--dry-run" ] && DRY="--dry-run"
if [ -z "$DRY" ]; then
  who=$(npm whoami 2>/dev/null || true)
  [ -n "$who" ] || { echo "Not logged in to npm. Run: npm login"; exit 1; }
  echo "npm user: $who"
fi
SDK_VERSION=$(node -p "require('./sdk/package.json').version")
OUT=$(mktemp -d)
for p in sdk mcp cli ai-sdk langchain plugin-purser; do
  echo "== $p"
  (cd "$p" && npm install --silent && npm run build --silent)
  mkdir -p "$OUT/$p"
  cp -R "$p/package.json" "$p/README.md" "$p/dist" "$OUT/$p/"
  [ -d "$p/images" ] && cp -R "$p/images" "$OUT/$p/"
  [ -f "../LICENSE" ] && cp ../LICENSE "$OUT/$p/"
  node -e '
    const fs = require("fs"); const f = process.argv[1]; const v = process.argv[2];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const k of ["dependencies", "peerDependencies"]) for (const [n, s] of Object.entries(j[k] || {})) if (String(s).startsWith("file:")) j[k][n] = "^" + v;
    delete j.scripts; delete j.devDependencies;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  ' "$OUT/$p/package.json" "$SDK_VERSION"
  if grep -q '"file:' "$OUT/$p/package.json"; then echo "a file: link is left in $p"; exit 1; fi
  (cd "$OUT/$p" && npm publish --access public $DRY)
done
echo "Done. Check: npm view @purseragents/ai-sdk version"
