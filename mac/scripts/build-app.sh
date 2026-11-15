#!/bin/sh
# Build Ungrind.app into mac/dist, with the Node engine bundled in Resources/engine.
# Usage: scripts/build-app.sh [--dmg]
set -e
MAC="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$MAC/.." && pwd)"
APP="$MAC/dist/Ungrind.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"

cd "$MAC"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/Ungrind"

mkdir -p "$MAC/dist"
STAGE="$(mktemp -d "$MAC/dist/stage.XXXXXX")"
mkdir -p "$STAGE/Ungrind.app/Contents/MacOS" "$STAGE/Ungrind.app/Contents/Resources/engine"
cp "$BIN" "$STAGE/Ungrind.app/Contents/MacOS/Ungrind"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/prompts" "$ROOT/package.json" "$STAGE/Ungrind.app/Contents/Resources/engine/"
cat > "$STAGE/Ungrind.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Ungrind</string>
  <key>CFBundleDisplayName</key><string>Ungrind</string>
  <key>CFBundleIdentifier</key><string>com.ungrind.mac</string>
  <key>CFBundleExecutable</key><string>Ungrind</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --deep --sign - "$STAGE/Ungrind.app" >/dev/null 2>&1

# Swap the finished bundle into place.
if [ -d "$APP" ]; then mv "$APP" "$STAGE/previous.app"; fi
mv "$STAGE/Ungrind.app" "$APP"
echo "Built $APP (version $VERSION)"

if [ "$1" = "--dmg" ]; then
  DMG="$MAC/dist/Ungrind-$VERSION.dmg"
  mkdir -p "$STAGE/dmg"
  cp -R "$APP" "$STAGE/dmg/"
  ln -s /Applications "$STAGE/dmg/Applications"
  hdiutil create -quiet -ov -volname "Ungrind" -srcfolder "$STAGE/dmg" -format UDZO "$DMG"
  echo "Built $DMG (ad-hoc signed, not notarized)"
fi
echo "Leftover staging folder (safe to delete): $STAGE"
