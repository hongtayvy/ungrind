#!/bin/sh
# Copy the demo into a fresh git repo so Ungrind can branch and commit safely.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEST="${1:-$ROOT/demo-sandbox}"
rm -rf "$DEST"
cp -R "$HERE" "$DEST"
rm -f "$DEST/setup.sh"
cd "$DEST"
git init -q -b main
git add -A
git -c user.name=ungrind -c user.email=ungrind@localhost commit -qm "demo: initial"
echo "Demo repo ready at $DEST"
echo "Next: node $ROOT/bin/ungrind.js validate --config $DEST/ungrind.config.yaml"
