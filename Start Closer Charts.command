#!/usr/bin/env bash
# Double-click launcher for Closer Charts.
# - cd's to this script's folder
# - runs build_data.py if data/chart.json doesn't exist yet (auto mode)
# - starts server.py (which auto-opens the browser)

cd "$(dirname "$0")" || exit 1

if [ ! -f data/chart.json ]; then
  echo "[start] First run — building data from Excel (auto-resolve names)…"
  python3 build_data.py --auto || { echo "[start] build_data.py failed"; read -r -p "Press enter to close…"; exit 1; }
fi

echo "[start] launching server at http://127.0.0.1:8765/"
python3 server.py
