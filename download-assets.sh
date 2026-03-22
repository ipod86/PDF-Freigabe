#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  download-assets.sh — Lädt Fonts und JS-Bibliotheken lokal herunter
#  Wird automatisch von setup.sh aufgerufen
# ═══════════════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FONT_DIR="$SCRIPT_DIR/public/fonts"
VENDOR_DIR="$SCRIPT_DIR/public/vendor"

mkdir -p "$FONT_DIR" "$VENDOR_DIR"

echo "📦 Lade Schriftarten herunter (DSGVO-konform, kein Google-CDN)..."

# DM Sans von Bunny Fonts (datenschutzkonformer Mirror mit stabilen URLs)
echo "  → DM Sans..."
curl -sL -o "$FONT_DIR/dm-sans-latin-400-normal.woff2" \
  "https://fonts.bunny.net/dm-sans/files/dm-sans-latin-400-normal.woff2"
curl -sL -o "$FONT_DIR/dm-sans-latin-500-normal.woff2" \
  "https://fonts.bunny.net/dm-sans/files/dm-sans-latin-500-normal.woff2"
curl -sL -o "$FONT_DIR/dm-sans-latin-700-normal.woff2" \
  "https://fonts.bunny.net/dm-sans/files/dm-sans-latin-700-normal.woff2"
curl -sL -o "$FONT_DIR/dm-sans-latin-400-italic.woff2" \
  "https://fonts.bunny.net/dm-sans/files/dm-sans-latin-400-italic.woff2"

# JetBrains Mono von Bunny Fonts
echo "  → JetBrains Mono..."
curl -sL -o "$FONT_DIR/jetbrains-mono-latin-400-normal.woff2" \
  "https://fonts.bunny.net/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"
curl -sL -o "$FONT_DIR/jetbrains-mono-latin-600-normal.woff2" \
  "https://fonts.bunny.net/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2"

# Prüfen ob Downloads gültige Fonts sind
FONT_OK=true
for f in "$FONT_DIR"/*.woff2; do
  if file "$f" | grep -q "HTML\|ASCII\|text"; then
    echo "  ⚠ FEHLER: $f ist keine gültige Font-Datei!"
    FONT_OK=false
  fi
done
if $FONT_OK; then
  echo "  ✓ Alle Fonts OK"
fi

echo "📦 Lade JavaScript-Bibliotheken..."

# Chart.js wird via npm installiert und von setup.sh aus node_modules kopiert
CHART_FILE="$VENDOR_DIR/chart.umd.min.js"
CHART_SIZE=$(wc -c < "$CHART_FILE" 2>/dev/null || echo 0)
if [ "$CHART_SIZE" -gt 100000 ]; then
  CHART_KB=$((CHART_SIZE / 1024))
  echo "  ✓ Chart.js vorhanden (${CHART_KB}K)"
else
  echo "  ℹ Chart.js wird nach npm install aus node_modules kopiert"
fi

echo ""
echo "✅ Alle Assets heruntergeladen:"
ls -lh "$FONT_DIR"/*.woff2 2>/dev/null | awk '{print "   " $NF " (" $5 ")"}'
ls -lh "$VENDOR_DIR"/*.js 2>/dev/null | awk '{print "   " $NF " (" $5 ")"}'
echo ""
