#!/usr/bin/env bash
# Remove what install.sh installed. Your settings are never deleted.
#
#   ./uninstall.sh                remove both and disable them
#   ./uninstall.sh --files-only   only delete files; do not touch systemd or GNOME
set -euo pipefail

DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
UUID="wintile@nowsci.com"
EXT_DIR="$DATA/gnome-shell/extensions/$UUID"
BACKUPS="$DATA/gnome-window-tweaks-backups"
BIN="$HOME/.local/bin"
MARK=".installed-by-gnome-window-tweaks"

ENABLE=1
case "${1:-}" in
    "") ;;
    --files-only) ENABLE=0 ;;
    -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
esac

echo "== Window Effects =="
if [ "$ENABLE" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
    # Stopping the unit runs `focus-opacity --restore`: windows go opaque again and
    # the sharp wallpaper comes back. Do this before deleting the script.
    systemctl --user disable --now focus-opacity.service 2>/dev/null || true
fi
rm -f "$CONF/systemd/user/focus-opacity.service" \
      "$DATA/applications/focus-opacity-prefs.desktop" \
      "$BIN/focus-opacity" "$BIN/focus-opacity-toggle" "$BIN/focus-opacity-prefs"
if [ "$ENABLE" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || true
fi
echo "  removed"

echo "== WinTile (fork) =="
if [ -f "$EXT_DIR/$MARK" ]; then
    if [ "$ENABLE" -eq 1 ] && command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions disable "$UUID" 2>/dev/null || true
    fi
    rm -rf "$EXT_DIR"
    echo "  removed $EXT_DIR"
elif [ -d "$EXT_DIR" ]; then
    echo "  left alone: $EXT_DIR was not installed by this repo"
else
    echo "  not installed"
fi
if [ -d "$BACKUPS" ] && [ -n "$(ls -A "$BACKUPS" 2>/dev/null)" ]; then
    echo "  a WinTile you had before is saved in $BACKUPS"
    echo "  to put it back:  mv \"$BACKUPS/<name>\" \"$EXT_DIR\""
fi

echo
echo "Kept (delete by hand if you want them gone):"
echo "  $CONF/focus-opacity.json                    Window Effects settings"
echo "  $DATA/backgrounds/focus-blur/    generated blur images and your original wallpaper paths"
if [ "$ENABLE" -eq 1 ]; then
    echo
    echo "If WinTile was running, restart the shell so it lets go of its shortcuts:"
    echo "  X11: Alt+F2, type r, Enter     Wayland: log out and back in"
fi
