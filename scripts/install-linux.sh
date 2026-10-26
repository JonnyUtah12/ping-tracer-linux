#!/usr/bin/env bash
# PingTracer (Linux) per-user installer — no root, no system services, no registry.
#
# What it does:
#   * copies the app to  $PREFIX/share/pingtracer          (default PREFIX: ~/.local)
#   * writes a launcher  $PREFIX/bin/pingtracer            (also 'pingtracer cli ...')
#   * writes a menu entry ~/.local/share/applications/pingtracer.desktop
#   * with --autostart: a systemd *user* service ~/.config/systemd/user/pingtracer-linux.service
#   * keeps your data in ~/.local/share/PingTracer/data    (override with PP_DATA=...)
#
# Usage: scripts/install-linux.sh [--prefix DIR] [--port N] [--autostart] [--no-desktop] [--no-deps]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PP_PREFIX:-$HOME/.local}"
PORT=""
AUTOSTART=0
DESKTOP=1
DEPS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)     PREFIX="$2"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --autostart)  AUTOSTART=1; shift ;;
    --no-desktop) DESKTOP=0; shift ;;
    --no-deps)    DEPS=0; shift ;;
    -h|--help)    sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is not installed — see scripts/check-deps.sh for the package to install" >&2; exit 1; }

[ "$DEPS" -eq 1 ] && { echo "== dependency check =="; "$ROOT/scripts/check-deps.sh" || echo "(required tools missing — the app may not start; install them, then re-run)"; echo; }

APP_DIR="$PREFIX/share/pingtracer"
BIN_DIR="$PREFIX/bin"
DATA_DIR="${PP_DATA:-$HOME/.local/share/PingTracer/data}"
UNIT="pingtracer-linux.service"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
DESK="$HOME/.local/share/applications/pingtracer.desktop"

mkdir -p "$APP_DIR" "$BIN_DIR" "$DATA_DIR"
# server.js + public/ only: app/data (runtime state) and app/sea-config.json (Windows single-exe packaging) are not copied.
cp -a "$ROOT/app/server.js" "$APP_DIR/server.js"
cp -a "$ROOT/app/public" "$APP_DIR/public"
rm -rf "$APP_DIR/public/data" 2>/dev/null || true
[ -d "$ROOT/app/extensions" ] && { mkdir -p "$APP_DIR/extensions"; cp -a "$ROOT/app/extensions/." "$APP_DIR/extensions/"; }

# --- launcher -------------------------------------------------------------------------------------------
cat > "$BIN_DIR/pingtracer" <<EOF
#!/usr/bin/env bash
# PingTracer launcher (Linux). Data: \$PP_DATA (default $DATA_DIR). Port: \$PORT (default 8765).
# 'pingtracer' starts the app; 'pingtracer cli ...' drives the running instance from a terminal.
set -euo pipefail
export PP_DATA="\${PP_DATA:-$DATA_DIR}"
[ -n "$PORT" ] && export PORT="\${PORT:-$PORT}"
if [ "\${1:-}" = "cli" ]; then shift; exec node "$APP_DIR/server.js" cli "\$@"; fi
exec node "$APP_DIR/server.js" "\$@"
EOF
chmod +x "$BIN_DIR/pingtracer"

# --- desktop / menu entry -------------------------------------------------------------------------------
if [ "$DESKTOP" -eq 1 ]; then
  mkdir -p "$(dirname "$DESK")"
  cat > "$DESK" <<EOF
[Desktop Entry]
Type=Application
Name=PingTracer
GenericName=Network tracer monitor
Comment=Continuous traceroute and ping monitor with per-hop history
Exec=$BIN_DIR/pingtracer
Icon=utilities-network
Terminal=false
Categories=Network;System;
Keywords=network;traceroute;ping;latency;packet loss;
EOF
  command -v desktop-file-validate >/dev/null 2>&1 && desktop-file-validate "$DESK"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESK")" 2>/dev/null || true
fi

# --- start at login: systemd user service (no root) ------------------------------------------------------
if [ "$AUTOSTART" -eq 1 ]; then
  mkdir -p "$(dirname "$UNIT_FILE")"
  {
    printf '[Unit]\nDescription=PingTracer (Linux) - continuous traceroute & ping monitor\nDocumentation=https://github.com/JonnyUtah12/ping-tracer-linux\nAfter=network-online.target\n\n[Service]\n'
    printf 'ExecStart=%s %s/server.js --background\n' "$(command -v node)" "$APP_DIR"
    printf 'Environment=PP_NO_OPEN=1\nEnvironment=PP_DATA=%s\n' "$DATA_DIR"
    [ -n "$PORT" ] && printf 'Environment=PORT=%s\n' "$PORT"
    printf 'WorkingDirectory=%s\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n' "$APP_DIR"
  } > "$UNIT_FILE"
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT"
  systemctl --user start "$UNIT" 2>/dev/null || true
  echo "start-at-login service enabled: systemctl --user status $UNIT"
fi

case ":$PATH:" in *":$BIN_DIR:"*) BIN_OK=1 ;; *) BIN_OK=0 ;; esac

echo "== installed =="
echo "app      $APP_DIR"
echo "launcher $BIN_DIR/pingtracer"
[ "$DESKTOP" -eq 1 ] && echo "menu     $DESK"
echo "data     $DATA_DIR"
echo "logs     journalctl --user -u ${UNIT} (if --autostart was used)"
echo
echo "start it with:  $BIN_DIR/pingtracer      (interface: http://127.0.0.1:${PORT:-8765})"
[ "$BIN_OK" -eq 0 ] && echo "note: $BIN_DIR is not in your PATH — add it:  export PATH=\"\$PATH:$BIN_DIR\""
