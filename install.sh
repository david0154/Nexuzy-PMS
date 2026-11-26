#!/usr/bin/env bash
# Nexuzy PMS - Automated Installation for Linux & macOS
# Developed by Nexuzy Lab

set -e

echo "========================================================"
echo "  Nexuzy PMS - Automated Installation (Linux / macOS)"
echo "  Developed by Nexuzy Lab"
echo "========================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed."
    echo "Please install Node.js (v18 or v20 LTS) using your package manager:"
    echo "  Ubuntu/Debian: sudo apt update && sudo apt install -y nodejs npm"
    echo "  macOS (Homebrew): brew install node"
    exit 1
fi

echo "[1/4] Node.js version detected: $(node -v)"
echo "[2/4] Installing application dependencies..."
npm install --no-audit

echo "[3/4] Preparing data and backup storage..."
mkdir -p data backups
chmod +x start.sh 2>/dev/null || true

echo "[4/4] Creating a desktop shortcut..."
node scripts/create-shortcut.js || echo "[WARN] Shortcut could not be created. Run 'npm run shortcut' later; the PMS still starts with ./start.sh."

echo ""
echo "========================================================"
echo "  Installation Completed Successfully!"
echo "  Run './start.sh' to launch Nexuzy PMS."
echo "========================================================"
