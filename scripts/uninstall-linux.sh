#!/usr/bin/env bash
# PingTracer (Linux) uninstaller — removes exactly what scripts/install-linux.sh created.
#
# Your collected data (targets, history, comments) is NOT removed unless you pass --data.
# The source repository is never touched.
#
# Usage: scripts/uninstall-linux.sh [--prefix DIR] [--data]
set -euo pipefail

PREFIX="${PP_PREFIX:-$HOME/.local}"
DATA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --data)   DATA=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

APP_DIR="$PREFIX/share/pingtracer"
BIN="$PREFIX/bin/pingtracer"
UNIT="pingtracer-linux.service"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
DESK="$HOME/.local/share/applications/pingtracer.desktop"
DATA_DIR="${PP_DATA:-$HOME/.local/share/PingTracer/data}"

# stop and remove the start-at-login service first, so nothing restarts after the files are gone
if [ -f "$UNIT_FILE" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "removed  $UNIT_FILE (start-at-login service disabled)"
fi

[ -x "$BIN" ] && { rm -f "$BIN"; echo "removed  $BIN"; }
[ -f "$DESK" ] && { rm -f "$DESK"; echo "removed  $DESK"; }
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESK")" 2>/dev/null || true
[ -d "$APP_DIR" ] && { rm -rf "$APP_DIR"; echo "removed  $APP_DIR"; }

if [ "$DATA" -eq 1 ]; then
  rm -rf "$DATA_DIR" && echo "removed  $DATA_DIR (targets, history, secret key, extensions)"
else
  echo "kept     $DATA_DIR  (history and settings; remove with: $0 --data)"
fi
echo "done."
