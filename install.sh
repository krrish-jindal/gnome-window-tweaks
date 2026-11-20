#!/usr/bin/env bash
# Install the WinTile fork and/or the Window Effects daemon for the current user.
#
#   ./install.sh                  install both and enable them
#   ./install.sh --wintile-only   only the WinTile extension
#   ./install.sh --effects-only   only the Window Effects daemon
#   ./install.sh --files-only     copy files only; do not touch systemd or GNOME
#   ./install.sh --skip-deps      do not check for required programs
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
UUID="wintile@nowsci.com"
EXT_DIR="$DATA/gnome-shell/extensions/$UUID"
BACKUPS="$DATA/gnome-window-tweaks-backups"
BIN="$HOME/.local/bin"
MARK=".installed-by-gnome-window-tweaks"

DO_WINTILE=1
DO_EFFECTS=1
ENABLE=1
CHECK_DEPS=1

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
    case "$arg" in
        --wintile-only) DO_EFFECTS=0 ;;
        --effects-only) DO_WINTILE=0 ;;
        --files-only)   ENABLE=0 ;;
        --skip-deps)    CHECK_DEPS=0 ;;
        -h|--help)      usage; exit 0 ;;
        *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
    esac
done
if [ "$DO_WINTILE" -eq 0 ] && [ "$DO_EFFECTS" -eq 0 ]; then
    echo "nothing to install (--wintile-only and --effects-only cancel each other out)" >&2
    exit 2
fi

# --- dependencies -----------------------------------------------------------
if [ "$CHECK_DEPS" -eq 1 ]; then
    missing=()
    need() { command -v "$1" >/dev/null 2>&1 || missing+=("$1  (package: $2)"); }

    if [ "$DO_WINTILE" -eq 1 ]; then
        need glib-compile-schemas libglib2.0-bin
        if [ "$ENABLE" -eq 1 ]; then need gnome-extensions gnome-shell; fi
    fi
    if [ "$DO_EFFECTS" -eq 1 ]; then
        need python3 python3
        need xprop x11-utils
        need xwininfo x11-utils
        need xrandr x11-xserver-utils
        need gsettings libglib2.0-bin
        need notify-send libnotify-bin
        if [ "$ENABLE" -eq 1 ]; then need systemctl systemd; fi
        if ! python3 -c 'import PIL' 2>/dev/null; then
            missing+=("Python module PIL  (package: python3-pil)")
        fi
    fi

    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Missing dependencies:" >&2
        printf '  - %s\n' "${missing[@]}" >&2
        echo >&2
        echo "On Ubuntu/Debian:" >&2
        echo "  sudo apt install x11-utils x11-xserver-utils libnotify-bin libglib2.0-bin python3-pil" >&2
        exit 1
    fi

    if [ "$DO_EFFECTS" -eq 1 ]; then
        if ! python3 -c "import gi; gi.require_version('Adw', '1'); gi.require_version('Gtk', '4.0')" 2>/dev/null; then
            echo "note: the settings window needs  sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1"
            echo "      (the daemon itself works without it)"
        fi
        if [ "${XDG_SESSION_TYPE:-x11}" != "x11" ]; then
            echo "warning: Window Effects need an X11 session; this one is '${XDG_SESSION_TYPE}'."
            echo "         Installing anyway, but the effect will not work until you log in to an X11 session."
        fi
    fi
fi

# --- WinTile ----------------------------------------------------------------
install_wintile() {
    echo "== WinTile (fork) =="
    if [ -d "$EXT_DIR" ] && [ ! -f "$EXT_DIR/$MARK" ]; then
        # Someone else's WinTile (e.g. the upstream release): keep it, outside the
        # extensions folder so GNOME does not try to load the copy.
        mkdir -p "$BACKUPS"
        local backup
        backup="$BACKUPS/wintile-$(date +%Y%m%d-%H%M%S)"
        mv "$EXT_DIR" "$backup"
        echo "  existing WinTile moved to $backup"
    else
        rm -rf "$EXT_DIR"
    fi
    mkdir -p "$EXT_DIR"
    cp -r "$SRC/$UUID/." "$EXT_DIR/"
    touch "$EXT_DIR/$MARK"
    glib-compile-schemas "$EXT_DIR/schemas"
    echo "  installed to $EXT_DIR"

    if [ "$ENABLE" -eq 1 ]; then
        if gnome-extensions enable "$UUID" 2>/dev/null; then
            echo "  enabled"
        else
            echo "  not enabled yet: GNOME has not noticed the new extension."
            echo "  Restart the shell (below), then run:  gnome-extensions enable $UUID"
        fi
    fi
    NEED_RELOAD=1
}

# --- Window Effects ---------------------------------------------------------
install_effects() {
    echo "== Window Effects =="
    mkdir -p "$BIN" "$CONF/systemd/user" "$DATA/applications"
    local f
    for f in focus-opacity focus-opacity-toggle focus-opacity-prefs; do
        install -m 755 "$SRC/focus-opacity/bin/$f" "$BIN/$f"
    done
    install -m 644 "$SRC/focus-opacity/systemd/focus-opacity.service" \
        "$CONF/systemd/user/focus-opacity.service"
    sed "s|@HOME@|$HOME|g" "$SRC/focus-opacity/applications/focus-opacity-prefs.desktop.in" \
        > "$DATA/applications/focus-opacity-prefs.desktop"
    chmod 644 "$DATA/applications/focus-opacity-prefs.desktop"
    echo "  scripts   -> $BIN"
    echo "  unit      -> $CONF/systemd/user/focus-opacity.service"
    echo "  launcher  -> $DATA/applications/focus-opacity-prefs.desktop"

    if [ "$ENABLE" -eq 1 ]; then
        systemctl --user daemon-reload
        systemctl --user enable focus-opacity.service
        # restart, not just start: a reinstall must pick up new code
        if systemctl --user restart focus-opacity.service; then
            echo "  service enabled and running"
        else
            echo "  service enabled but did not start; see: journalctl --user -u focus-opacity.service"
        fi
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DATA/applications" 2>/dev/null || true
    fi
}

NEED_RELOAD=0
if [ "$DO_WINTILE" -eq 1 ]; then install_wintile; fi
if [ "$DO_EFFECTS" -eq 1 ]; then install_effects; fi

echo
echo "Done."
if [ "$NEED_RELOAD" -eq 1 ] && [ "$ENABLE" -eq 1 ]; then
    echo
    echo "GNOME Shell only loads extension code at start-up. To load WinTile now:"
    echo "  X11:      press Alt+F2, type  r  and press Enter (your apps stay open)"
    echo "  Wayland:  log out and back in"
fi
if [ "$DO_EFFECTS" -eq 1 ]; then
    echo
    echo "Window Effects: open 'Window Effects' from the app grid (or run focus-opacity-prefs)."
    echo "For a keyboard toggle, add a custom shortcut whose command is:"
    echo "  $BIN/focus-opacity-toggle"
fi
