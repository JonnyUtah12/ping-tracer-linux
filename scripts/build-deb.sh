#!/usr/bin/env bash
# Build a .deb for PingTracer (Linux) — no root needed, no signing (see README, "Verifying your download").
#
#   scripts/build-deb.sh [output-dir]        ->  dist/pingtracer_<version>-1_all.deb
#
# Dependency note, stated honestly: the Depends line requires nodejs >= 22.5 because the app keeps its
# history in node:sqlite. Ubuntu's own `nodejs` apt package is older than that on 22.04/24.04, so on a
# stock Ubuntu the dependency is satisfied by the NodeSource / Node.js LTS apt repository (the README's
# System requirements section gives the commands), not by the distro package. `dpkg-deb -I` output below
# shows exactly what the package asks for.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/dist}"
MAINTAINER="${PP_MAINTAINER:-Aaron Vest <https://github.com/JonnyUtah12>}"

command -v dpkg-deb >/dev/null 2>&1 || { echo "dpkg-deb not found — sudo apt install dpkg" >&2; exit 1; }
VER="$(sed -n "s/.*const APP_VERSION = '\([^']*\)'.*/\1/p" "$ROOT/app/server.js" | head -n1)"
[ -n "$VER" ] || { echo "could not read APP_VERSION from app/server.js" >&2; exit 1; }
REV="${VER}-1"

STAGE="$OUT_DIR/stage-$REV"
rm -rf "$STAGE"; mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/usr/share/pingtracer/public" \
  "$STAGE/usr/share/pingtracer/scripts" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/doc/pingtracer"

cp -a "$ROOT/app/server.js"            "$STAGE/usr/share/pingtracer/server.js"
cp -a "$ROOT/app/public/."             "$STAGE/usr/share/pingtracer/public/"
cp -a "$ROOT/scripts/check-deps.sh"    "$STAGE/usr/share/pingtracer/scripts/check-deps.sh"
chmod 755 "$STAGE/usr/share/pingtracer/scripts/check-deps.sh"

cat > "$STAGE/usr/bin/pingtracer" <<'EOF'
#!/usr/bin/env bash
# PingTracer (system install). Each user keeps their own data under ~/.local/share/PingTracer/data.
# 'pingtracer' starts the app; 'pingtracer check-deps' reports missing tools; 'pingtracer cli ...' drives a running instance.
set -euo pipefail
APP=/usr/share/pingtracer
if [ "${1:-}" = "check-deps" ]; then exec bash "$APP/scripts/check-deps.sh"; fi
export PP_DATA="${PP_DATA:-$HOME/.local/share/PingTracer/data}"
mkdir -p "$PP_DATA"
if [ "${1:-}" = "cli" ]; then shift; exec node "$APP/server.js" cli "$@"; fi
exec node "$APP/server.js" "$@"
EOF
chmod 755 "$STAGE/usr/bin/pingtracer"

cat > "$STAGE/usr/share/applications/pingtracer.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=PingTracer
GenericName=Network tracer monitor
Comment=Continuous traceroute and ping monitor with per-hop history
Exec=/usr/bin/pingtracer
Icon=utilities-network
Terminal=false
Categories=Network;System;
Keywords=network;traceroute;ping;latency;packet loss;
EOF

cat > "$STAGE/DEBIAN/control" <<EOF
Package: pingtracer
Version: $REV
Section: net
Priority: optional
Architecture: all
Maintainer: $MAINTAINER
Depends: nodejs (>= 22.5), iputils-ping, iproute2, openssl
Recommends: traceroute, xdg-utils
Suggests: jq
Homepage: https://github.com/JonnyUtah12/ping-tracer-linux
Description: continuous traceroute & ping monitor
 Traces several targets at once and watches every hop in real time, keeping months of
 history so you can see where a network problem starts, not just that the internet is slow.
 .
 Probe engines on Linux, in order of preference: an unprivileged ICMP ping socket, the
 traceroute utility, then tracepath for hop discovery plus ping for the destination.
 No root, no daemon and no firewall rules are required.
EOF

cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
chmod 755 /usr/bin/pingtracer 2>/dev/null || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications 2>/dev/null || true
exit 0
EOF
cat > "$STAGE/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications 2>/dev/null || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/postrm"

cat > "$STAGE/usr/share/doc/pingtracer/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: PingTracer
Upstream-Contact: $MAINTAINER

Files: *
Copyright: 2026 Aaron Vest
License: proprietary
 The upstream repository carries no LICENSE file, so no redistribution rights are
 granted. This package is a convenience build for the author's own systems; ask the
 upstream contact before redistributing it.
 .
 It embeds no third-party compiled code: Node.js, iputils, iproute2 and openssl are
 ordinary apt dependencies of the package.
EOF

cp "$ROOT/README.md" "$STAGE/usr/share/doc/pingtracer/README.md"
[ -f "$ROOT/CHANGELOG.md" ] && gzip -9c "$ROOT/CHANGELOG.md" > "$STAGE/usr/share/doc/pingtracer/changelog.gz"
printf "ping-tracer-linux %s\n" "$VER" > /tmp/.ptl-dch.$$
{ echo "ping-tracer-linux ($VER) stable; urgency=low"; echo; echo "  * See changelog.gz for the release notes."; echo; echo " -- $MAINTAINER  $(date -R)"; } > "$STAGE/usr/share/doc/pingtracer/changelog.Debian"
gzip -9 "$STAGE/usr/share/doc/pingtracer/changelog.Debian"
rm -f /tmp/.ptl-dch.$$

OUT="$OUT_DIR/pingtracer_${REV}_all.deb"
chmod -R a+rX "$STAGE"
if dpkg-deb --build --root-owner-group "$STAGE" "$OUT" 2>/dev/null; then BUILT=1
elif command -v fakeroot >/dev/null 2>&1 && fakeroot dpkg-deb --build "$STAGE" "$OUT"; then BUILT=1
else echo "dpkg-deb --build failed" >&2; exit 1; fi
rm -rf "$STAGE"

echo "== built =="; ls -l "$OUT"; echo
dpkg-deb --info "$OUT" | sed -n '1,30p'
echo
echo "contents:"; dpkg-deb --contents "$OUT" | awk '{print $NF}' | sed -n '1,20p'
echo
echo "sha256:"; sha256sum "$OUT"
