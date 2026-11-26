#!/usr/bin/env bash
# Nexuzy PMS - Startup Script for Linux & macOS
set -e
cd "$(dirname "$0")"

echo "========================================================"
echo "  Launching Nexuzy PMS..."
echo "  Nexuzy PMS opens in its own app window."
echo "  Without Chrome, Edge, Brave or Chromium the actual"
echo "  address is printed and opened in the default browser."
echo "========================================================"
echo ""

if [ ! -d "node_modules/express" ]; then
  echo "[ERROR] Dependencies are not installed. Run ./install.sh first."
  exit 1
fi

exec node scripts/launch.js
