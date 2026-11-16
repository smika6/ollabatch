#!/bin/sh
# ollabatch installer for macOS and Linux, served by the host:
#   curl -fsSL __HOST__/install.sh | sh
# Unpacks the host's copy of ollabatch into ~/.ollabatch/app, puts `ollabatch`
# in ~/.local/bin, starts the agent at login, and opens its page. No sudo.
set -e
HOST='__HOST__'
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]")" -lt 20 ]; then
  echo "ollabatch needs Node.js 20 or newer. Install it, then run this again:"
  echo "  macOS:  brew install node      Linux: your distribution's nodejs package (20+)"
  exit 1
fi
APP="$HOME/.ollabatch/app"
mkdir -p "$APP"
echo "Downloading ollabatch from $HOST ..."
curl -fsSL "$HOST/ollabatch.tar" | tar -xf - -C "$APP"
node "$APP/bin/ollabatch.mjs" install
echo "Done. ollabatch runs at login; its page opens now so you can lend this machine."
echo "Open a new terminal to use the ollabatch command."
i=0; while [ $i -lt 30 ] && ! curl -fs http://127.0.0.1:11510/status >/dev/null 2>&1; do sleep 0.5; i=$((i + 1)); done
(open "http://127.0.0.1:11510/#join=$HOST" 2>/dev/null || xdg-open "http://127.0.0.1:11510/#join=$HOST" 2>/dev/null) || true
