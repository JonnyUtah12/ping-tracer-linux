#!/usr/bin/env bash
# PingTracer (Linux) dependency check.
#
# Reports what is installed, what is missing, and the exact apt package that provides it.
# Design rule (spec §4): a missing *tool* is always reported as a missing tool. The app never
# dresses up a missing binary as a network failure, and this script never guesses credentials
# or runs anything as root — it prints the command for the user to run.
set -uo pipefail

# Node needs >= 22.5: the app stores history with node:sqlite (node:sqlite is stable from 22.5).
NODE_MIN=22.5
REQUIRED=0

ok()   { printf 'OK      %s\n' "$1"; }
warn() { printf 'OPTION  %s\n' "$1"; }
bad()  { printf 'MISSING %s\n' "$1"; REQUIRED=1; }

ver_ge() { # ver_ge A B  -> true when A >= B (dot-separated numeric compare)
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- required: the app does not start without these ----------------------------------------------------
if have node; then
  nv="$(node --version 2>/dev/null | sed 's/^v//')"
  if ver_ge "$nv" "$NODE_MIN"; then ok "node v$nv (>= $NODE_MIN required: node:sqlite history store)"
  else bad "node v$nv is too old (need >= $NODE_MIN) — sudo apt install nodejs (NodeSource) or: sudo snap install node --classic"; fi
else
  bad "node (>= $NODE_MIN) — sudo apt install nodejs   (Ubuntu's own nodejs is usually older: see README 'System requirements')"
fi

# --- required for the probe engines ---------------------------------------------------------------------
have ping      && ok "ping ($(ping -V 2>&1 | head -n1 | grep -o 'iputils[ /][0-9]*' | tr -d '/' | head -n1)) — iputils-ping" \
               || bad "ping — sudo apt install iputils-ping"
have tracepath && ok "tracepath — hop discovery for the 'tracepath + ping' engine" \
               || bad "tracepath — sudo apt install iputils-tracepath (or iputils-ping on older releases)"
have ip        && ok "ip (iproute2) — route, neighbour and interface lookups (replaces 'arp -a')" \
               || bad "ip — sudo apt install iproute2"

# --- required for HTTPS (self-signed certificate generation) --------------------------------------------
have openssl && ok "openssl — self-signed certificate generation (replaces the Windows certificate store)" \
             || bad "openssl — sudo apt install openssl"

# --- recommended: better engines, nicer desktop integration ----------------------------------------------
have traceroute && ok "traceroute — continuous per-hop tracing engine (recommended)" \
                || warn "traceroute — sudo apt install traceroute   (without it, hop addresses come from tracepath and the destination is polled with ping)"
have stdbuf     && ok "stdbuf (coreutils) — line-buffers tracepath so hops appear while discovery runs" \
                || warn "stdbuf — sudo apt install coreutils"
have xdg-open   && ok "xdg-open — opens the interface in your browser" \
                || warn "xdg-open — sudo apt install xdg-utils"
have systemctl  && ok "systemctl — 'start at login' via a systemd *user* service (no root, no registry)" \
                || warn "systemctl — the 'start at login' switch needs systemd; run 'pingtracer' manually instead"
have jq         && ok "jq — pretty-printing for 'pingtracer cli ...' output" \
                || warn "jq — sudo apt install jq (optional)"

# --- only needed to build the .deb / run the test suite ---------------------------------------------------
have dpkg-deb   && ok "dpkg-deb — build the .deb (scripts/build-deb.sh)" \
                || warn "dpkg-deb — sudo apt install dpkg (only needed to build a .deb)"

echo
if [ "$REQUIRED" -eq 0 ]; then
  echo "All required tools are present. PingTracer can run."
else
  echo "Some required tools are missing (see MISSING lines above). Install them, then re-run this script."
fi
exit "$REQUIRED"
