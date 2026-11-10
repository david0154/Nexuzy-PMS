#!/usr/bin/env bash
# Nexuzy PMS - Startup Script for Linux & macOS

echo "========================================================"
echo "  Launching Nexuzy PMS Server..."
echo "  Access local dashboard: http://localhost:5000"
echo "========================================================"
echo ""

# Attempt to open default browser if desktop session is detected
if command -v xdg-open >/dev/null 2>&1; then
    (sleep 1 && xdg-open "http://localhost:5000") &
elif command -v open >/dev/null 2>&1; then
    (sleep 1 && open "http://localhost:5000") &
fi

npm start
