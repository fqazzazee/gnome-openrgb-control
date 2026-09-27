#!/usr/bin/env bash
# Installs a system service that loads your OpenRGB "off" profile at boot, so
# the LEDs go dark before anyone logs in. Rerun it after changing that
# profile or your OpenRGB device settings.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/OpenRGB"
UNIT="openrgb-boot-off.service"

if [[ ! -f "$CONF/profiles/off.json" ]]; then
    echo "No OpenRGB profile named \"off\" in $CONF/profiles. Save one first." >&2
    exit 1
fi

sudo install -d /etc/openrgb/profiles
sudo install -m 644 "$CONF/profiles/off.json" /etc/openrgb/profiles/off.json
# Same detector settings as your user, so the same devices are found.
[[ -f "$CONF/OpenRGB.json" ]] && sudo install -m 644 "$CONF/OpenRGB.json" /etc/openrgb/OpenRGB.json
sed "s#/usr/bin/openrgb#$(command -v openrgb)#" "$ROOT/systemd/$UNIT" \
    | sudo tee "/etc/systemd/system/$UNIT" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT"
echo "Enabled $UNIT: LEDs will turn off at boot."
echo "Uninstall: sudo systemctl disable $UNIT && sudo rm /etc/systemd/system/$UNIT"
