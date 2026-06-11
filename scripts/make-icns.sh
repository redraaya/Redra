#!/bin/bash
# Generate build/icon.icns (+ build/icon-512.png for the dev dock icon)
# from design/icons/redra.svg. macOS-only: Electron (offscreen, keeps the
# alpha channel) + sips + iconutil.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/design/icons/redra.svg"
BUILD="$ROOT/build"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$SVG" ] || { echo "error: $SVG not found" >&2; exit 1; }
mkdir -p "$BUILD"

# 1) Rasterize the SVG to a 1024px master. Electron's offscreen renderer
#    keeps the transparent canvas margins (Big Sur grid); qlmanage flattens
#    SVG onto a white background, so it cannot be used here.
ELECTRON="$ROOT/node_modules/.bin/electron"
[ -x "$ELECTRON" ] || { echo "error: $ELECTRON not found (npm install first)" >&2; exit 1; }
MASTER="$TMP/master.png"
"$ELECTRON" "$ROOT/scripts/rasterize-icon.cjs" "$SVG" "$MASTER"
[ -f "$MASTER" ] || { echo "error: rasterizer produced no png" >&2; exit 1; }
# Retina sessions capture at 2x — normalize to the 1024 master.
sips -z 1024 1024 "$MASTER" >/dev/null

# 2) Build the iconset (16…512 + @2x; 1024 master is the 512@2x).
ICONSET="$TMP/redra.iconset"
mkdir "$ICONSET"
for SIZE in 16 32 64 128 256 512; do
  sips -z "$SIZE" "$SIZE" "$MASTER" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  DOUBLE=$((SIZE * 2))
  sips -z "$DOUBLE" "$DOUBLE" "$MASTER" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
# icon_64x64* is not part of the icns spec — drop it (kept above for the loop's simplicity).
rm "$ICONSET/icon_64x64.png" "$ICONSET/icon_64x64@2x.png"

# 3) Pack + export the dev dock png.
iconutil -c icns "$ICONSET" -o "$BUILD/icon.icns"
sips -z 512 512 "$MASTER" --out "$BUILD/icon-512.png" >/dev/null

echo "ok: $BUILD/icon.icns and $BUILD/icon-512.png"
