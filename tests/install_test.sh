#!/usr/bin/env bash
# Runs install.sh and uninstall.sh against a throw-away HOME, with stand-ins for
# systemctl / gnome-extensions / update-desktop-database placed first in PATH, so
# nothing on the real system is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v glib-compile-schemas >/dev/null 2>&1 || {
    echo "needs glib-compile-schemas (package libglib2.0-bin)"; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/stubs"
LOG="$T/calls.log"
for cmd in systemctl gnome-extensions update-desktop-database; do
    printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$cmd" "$LOG" > "$T/stubs/$cmd"
    chmod +x "$T/stubs/$cmd"
done
export PATH="$T/stubs:$PATH"
export GSETTINGS_BACKEND=memory
unset XDG_DATA_HOME XDG_CONFIG_HOME

FAILS=0
check() {  # check "description" command...
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "  ok    $desc"; else echo "  FAIL  $desc"; FAILS=$((FAILS + 1)); fi
}
fresh_home() { rm -rf "$T/home"; mkdir -p "$T/home"; export HOME="$T/home"; : > "$LOG"; }

echo "1. full install into an empty HOME"
fresh_home
"$ROOT/install.sh" --skip-deps >/dev/null
check "extension.js installed"            test -f "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com/extension.js"
check "schema compiled"                   test -f "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com/schemas/gschemas.compiled"
check "install marker written"            test -f "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com/.installed-by-gnome-window-tweaks"
check "auto-tile key is in the schema"    bash -c "gsettings --schemadir '$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com/schemas' list-keys org.gnome.shell.extensions.wintile | grep -qx auto-tile"
for f in focus-opacity focus-opacity-toggle focus-opacity-prefs; do
    check "$f is executable"              test -x "$HOME/.local/bin/$f"
done
check "systemd unit installed"            test -f "$HOME/.config/systemd/user/focus-opacity.service"
check "launcher has your HOME filled in"  grep -qx "Exec=$HOME/.local/bin/focus-opacity-prefs" "$HOME/.local/share/applications/focus-opacity-prefs.desktop"
check "launcher has no @HOME@ left"       bash -c "! grep -q '@HOME@' '$HOME/.local/share/applications/focus-opacity-prefs.desktop'"
check "service was enabled"               grep -q "systemctl --user enable focus-opacity.service" "$LOG"
check "service was restarted"             grep -q "systemctl --user restart focus-opacity.service" "$LOG"
check "extension enable was requested"    grep -q "gnome-extensions enable wintile@nowsci.com" "$LOG"

echo "2. installing again is a clean replace (no backup of our own copy)"
"$ROOT/install.sh" --skip-deps >/dev/null
check "no backup directory created"       bash -c "! test -e '$HOME/.local/share/gnome-window-tweaks-backups'"

echo "3. an existing, foreign WinTile is backed up, not clobbered"
fresh_home
mkdir -p "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com"
echo mine > "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com/foreign.txt"
"$ROOT/install.sh" --skip-deps --wintile-only >/dev/null
check "foreign copy saved in backups"     bash -c "ls '$HOME'/.local/share/gnome-window-tweaks-backups/wintile-*/foreign.txt"
check "our copy is now installed"         test -f "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com/extension.js"
check "effects not installed (--wintile-only)" bash -c "! test -e '$HOME/.local/bin/focus-opacity'"

echo "4. --files-only never calls systemd or GNOME"
fresh_home
"$ROOT/install.sh" --skip-deps --files-only >/dev/null
check "files copied"                      test -x "$HOME/.local/bin/focus-opacity"
check "no systemctl / gnome-extensions calls" bash -c "! grep -E '^(systemctl|gnome-extensions) ' '$LOG'"

echo "5. uninstall removes ours, keeps settings, leaves foreign copies alone"
fresh_home
"$ROOT/install.sh" --skip-deps --files-only >/dev/null
echo '{}' > "$HOME/.config/focus-opacity.json"
: > "$LOG"   # judge the uninstaller on its own, not the install above
"$ROOT/uninstall.sh" --files-only >/dev/null
check "extension removed"                 bash -c "! test -e '$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com'"
check "scripts removed"                   bash -c "! test -e '$HOME/.local/bin/focus-opacity'"
check "unit removed"                      bash -c "! test -e '$HOME/.config/systemd/user/focus-opacity.service'"
check "launcher removed"                  bash -c "! test -e '$HOME/.local/share/applications/focus-opacity-prefs.desktop'"
check "settings file kept"                test -f "$HOME/.config/focus-opacity.json"
check "no systemctl / gnome-extensions calls" bash -c "! grep -E '^(systemctl|gnome-extensions) ' '$LOG'"
mkdir -p "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com"
"$ROOT/uninstall.sh" --files-only >/dev/null
check "someone else's WinTile left alone" test -d "$HOME/.local/share/gnome-shell/extensions/wintile@nowsci.com"

echo "6. bad arguments are rejected"
check "unknown option exits non-zero"     bash -c "! '$ROOT/install.sh' --nope"
check "contradictory options exit non-zero" bash -c "! '$ROOT/install.sh' --skip-deps --wintile-only --effects-only"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL INSTALL CHECKS PASSED"; else echo "$FAILS INSTALL CHECK(S) FAILED"; exit 1; fi
