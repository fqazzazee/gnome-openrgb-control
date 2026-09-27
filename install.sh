#!/usr/bin/env bash
# Installs RGB Lighting into your local GNOME Shell extensions folder and sets
# up the OpenRGB SDK server as a systemd user service.
set -euo pipefail

UUID="openrgb-control@tesla.local"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT="openrgb-server.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/
glib-compile-schemas "$DEST/schemas"

# `gnome-extensions enable` fails until GNOME Shell has seen the extension
# (after re-login on Wayland), so fall back to adding it to the enabled list.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" != *"'$UUID'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
            new="['$UUID']"
        else
            new="${current%]}, '$UUID']"
        fi
        gsettings set org.gnome.shell enabled-extensions "$new"
    fi
fi
echo "Installed extension to $DEST"

if [[ "${1:-}" == "--no-service" ]]; then
    echo "Skipped the OpenRGB server service (--no-service)."
elif ! command -v openrgb >/dev/null; then
    echo "OpenRGB is not installed; install it, then rerun this script to set up the server service."
else
    mkdir -p "$UNIT_DIR"
    sed "s#/usr/bin/openrgb#$(command -v openrgb)#" "$ROOT/systemd/$UNIT" > "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT"
    echo "Enabled $UNIT (OpenRGB SDK server on 127.0.0.1:6742)"
fi

echo "Log out and back in to load the extension (required on Wayland)."
