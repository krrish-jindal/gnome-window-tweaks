# gnome-window-tweaks

Two independent pieces for GNOME on Linux. Install either or both.

| | What it is | Where it lives |
|---|---|---|
| **WinTile (fork)** | A GNOME Shell *extension*: the upstream [WinTile](https://github.com/fmstrat/wintile) plus an **auto-tile mode** that follows your monitor's orientation and lets you **drag a window onto another to swap them**. | `wintile@nowsci.com/` |
| **Window Effects** | A background *daemon* (not an extension): fades windows that are not focused and blurs the wallpaper behind them, **per monitor**. Has a settings window and a one-key toggle. | `focus-opacity/` |

> **Tested on:** Ubuntu 22.04, GNOME Shell 42.9, an **X11** session, three monitors.
> WinTile's `metadata.json` still lists shell versions 3.36 to 44 (inherited from upstream),
> but nothing here has been tried outside GNOME 42. Window Effects are **X11 only**.

---

## What you get

### WinTile fork

Everything upstream WinTile does (`Super`+arrows tiling, grid previews, gaps), plus:

- **Auto-tile mode.** Every tileable window on the workspace is laid into the grid and
  re-laid whenever a window opens, closes, minimises or changes monitor. Toggle it with
  **`Super`+`Shift`+`T`** (or the `auto-tile` setting).
- **Follows monitor orientation.**
  - *Landscape:* windows go **side by side** (left/right).
  - *Portrait:* up to 3 windows go **stacked** (top/bottom), each full width; from 4 up they
    **pair up two to a row** (4 is a 2x2 grid, 5 is 2+2+1, 6 is 2+2+2). Never more than two
    side by side: a portrait screen is too narrow for that.
  - Rotating a monitor re-lays it out straight away.
- **Respects minimum window sizes.** Many apps cannot be made smaller than a minimum (a
  Chromium-based browser is about 580 px wide), and a tile smaller than that makes the window
  spill over its neighbour. After each layout WinTile checks whether any window is still bigger
  than its tile; if so it remembers that window's minimum and re-lays out so everything fits.
  On a portrait screen that means two windows that are too wide to share a row (two Brave
  windows are each at least ~580 px) get a row each while the others still pair up; on a
  landscape screen it can mean stacking instead of two columns. With no such windows nothing
  changes.
- **Drag to swap.** Drag a tiled window by its title bar onto another tile on the **same
  monitor** and drop it: the two trade places. A soft blue outline shows the tile you would
  swap with. Dropped anywhere else (empty desktop, another monitor, over a dialog) the
  window just returns to its own slot.
- **Even gaps** around and between tiles (`gap` setting).
- **Hand-resize follows.** Dragging an edge shared with a neighbour resizes the neighbour to
  match, so the screen stays gapless. Dragging an edge on the *screen border* floats that
  window out of the layout.
- **Never-tile list** (`auto-tile-blacklist`): windows matched by class or title are left
  alone. Picture-in-picture players are on it by default.

Good to know:

- Slot sizes stay with the **slot**, not the window: if you hand-resized one tile and then
  swap, the other window takes that size.
- A new window always goes last. Switching auto-tile off and on again clears swaps.
- While enabled, WinTile takes over GNOME's own `Super`+arrow maximise/half-tile shortcuts;
  disabling the extension gives them back.

### Window Effects

- Unfocused windows fade to a configurable opacity (default 80%), including maximised ones,
  so the wallpaper shows through. Fullscreen and always-on-top windows (video, PiP) are
  skipped by default.
- The wallpaper is blurred **only on monitors that have a window on them**. GNOME can show
  only one background image across all screens, so the daemon pre-composites one image per
  combination of busy monitors and switches between them (up to 4 monitors).
- A GTK4/libadwaita settings window ("Window Effects" in the app grid) and a one-shot
  toggle command for a keyboard shortcut.

---

## Install

### 1. Requirements

```bash
# WinTile needs only glib's schema compiler (usually already present)
sudo apt install libglib2.0-bin

# Window Effects
sudo apt install x11-utils x11-xserver-utils libnotify-bin python3-pil \
                 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1
```

`python3-gi`, `gir1.2-gtk-4.0` and `gir1.2-adw-1` are only for the settings window; the
daemon runs without them.

### 2. Install

```bash
git clone <your-repo-url> gnome-window-tweaks
cd gnome-window-tweaks
./install.sh                 # both
# or:  ./install.sh --wintile-only
#      ./install.sh --effects-only
#      ./install.sh --files-only     # copy files, don't touch systemd/GNOME
```

The installer:

- copies the extension to `~/.local/share/gnome-shell/extensions/wintile@nowsci.com/`,
  compiles its settings schema and tries to enable it. **If you already have a WinTile
  installed it is moved to `~/.local/share/gnome-window-tweaks-backups/`, not overwritten.**
- copies the three Window Effects scripts to `~/.local/bin/`, installs the systemd *user*
  unit and the app-grid launcher, then enables and (re)starts the service.

### 3. Load the extension

GNOME Shell only reads extension code at start-up.

- **X11:** press `Alt`+`F2`, type `r`, press `Enter`. The shell restarts in place and your
  apps stay open.
- **Wayland:** log out and back in. (Window Effects will not work on Wayland, see above.)

Then, if the installer could not enable it earlier:

```bash
gnome-extensions enable wintile@nowsci.com
```

### 4. Check it works

```bash
gnome-extensions info wintile@nowsci.com      # State: ENABLED
systemctl --user status focus-opacity.service # active (running)
```

Open three windows and press `Super`+`Shift`+`T`: they should snap into a grid.

---

## Using WinTile

WinTile keeps its schema inside the extension folder, so `gsettings` needs `--schemadir`:

```bash
S=~/.local/share/gnome-shell/extensions/wintile@nowsci.com/schemas
W="gsettings --schemadir $S"

$W set org.gnome.shell.extensions.wintile auto-tile true     # same as Super+Shift+T
$W set org.gnome.shell.extensions.wintile gap 6              # px around and between tiles
$W get org.gnome.shell.extensions.wintile auto-tile-blacklist
```

Changes apply immediately. `gnome-extensions prefs wintile@nowsci.com` opens the settings
window.

| Setting | Default | Meaning |
|---|---|---|
| `auto-tile` | `false` | Tile every window automatically |
| `auto-tile-blacklist` | PiP titles | Class or title fragments that are never tiled |
| `gap` | `0` | Gap in px around and between tiles |
| `cols` / `rows` | `2` / `2` | Grid size; in auto-tile, `cols` caps how many lanes the long axis is split into |
| `ultrawide-only`, `non-ultra-cols`, `non-ultra-rows` | | Different grid for non-ultrawide screens |
| `preview`, `double-width`, `distance`, `delay` | | Upstream mouse-snap preview |
| `debug` | `false` | Verbose log lines |

**Keeping a window out of tiling.** Run `tools/wintile-never-tile`, then open the window you
want left alone. It reports how that window identifies itself; with `--add` it adds it to
the never-tile list. It picks the *title* when the class is shared with other windows (a
browser pop-up has the same class as every other browser window).

---

## Using Window Effects

Open **Window Effects** from the app grid, or run `focus-opacity-prefs`. Settings live in
`~/.config/focus-opacity.json`; the useful keys are:

| Key | Default | Meaning |
|---|---|---|
| `unfocused` / `focused` | `80` / `100` | Window opacity, percent |
| `fade_ms`, `fade_fps` | `200`, `60` | Cross-fade length and smoothness (`0` = snap) |
| `blur_radius` | `16` | Wallpaper blur strength |
| `cover_threshold` | `0.10` | Fraction of a screen a window must cover for it to count as "busy" |
| `per_monitor_wallpaper` | `true` | `false` = one blur decision for all screens |
| `skip_classes` | `[]` | Window classes that are never faded |
| `skip_fullscreen`, `skip_above` | `true` | Never fade fullscreen or always-on-top windows |
| `sharp_light`, `sharp_dark` | HydraPaper cache | Source wallpaper images (see below) |

### Wallpaper source

By default the daemon takes its *sharp* wallpaper from
[HydraPaper](https://gitlab.gnome.org/GabMus/HydraPaper)'s cache
(`~/.cache/org.gabmus.hydrapaper/merged_wallpaper*.png`), which is how it was developed and
tested. It also watches GNOME's `picture-uri` and adopts any image you pick afterwards (in
Settings, or HydraPaper), then rebuilds the blur images. **If you do not use HydraPaper**,
pick your wallpaper once while the service is running, or set `sharp_light` and
`sharp_dark` in the config to the image files you want.

### Turn it on and off

```bash
systemctl --user stop focus-opacity.service     # off: windows opaque, wallpaper sharp again
systemctl --user start focus-opacity.service    # on
~/.local/bin/focus-opacity-toggle               # flips it, with a notification
focus-opacity --help                            # also: --reblur  --restore  --status  --once
```

For a keyboard shortcut: *Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → +*,
command `/home/<you>/.local/bin/focus-opacity-toggle` (use the full path), shortcut of your
choice, for example `Super`+`Shift`+`D`.

---

## Update

```bash
git pull
./install.sh
# then reload the shell as in step 3
```

## Uninstall

```bash
./uninstall.sh            # --files-only to skip systemd/GNOME calls
```

This stops the daemon (which restores window opacity and your sharp wallpaper), removes the
files this repo installed and disables the extension. Your `~/.config/focus-opacity.json` and
`~/.local/share/backgrounds/focus-blur/` are **kept**. A WinTile you had before is still in
`~/.local/share/gnome-window-tweaks-backups/`; the uninstaller prints the command to put it
back. Reload the shell afterwards so GNOME lets go of the shortcuts.

---

## Troubleshooting

```bash
# WinTile / shell errors (wintile logs with the prefix [WinTile])
journalctl -qf | grep -i -e wintile -e 'js error'

# Window Effects
journalctl --user -u focus-opacity.service -f
```

- **Nothing changes after install.** Reload the shell (step 3); extension code is only read
  at start-up.
- **`Failed to add keybinding: '<Super><Control>left'`** in the log means another program or
  extension already owns that shortcut. WinTile still works, but its "grow tile" shortcut for
  that key does not. Find the other owner in *Settings → Keyboard* or disable the conflicting
  extension.
- **No fade or blur.** Check `echo $XDG_SESSION_TYPE`; it must be `x11`. Then
  `focus-opacity --status`.
- **Wallpaper is not blurring.** See *Wallpaper source* above, then run
  `focus-opacity --reblur`.
- **Two windows overlap.** Usually one of them has a minimum size larger than its tile. The
  first layout may overlap for a fraction of a second; WinTile then learns the minimum and
  fixes it. If it still overlaps, there are probably more windows than fit on that monitor:
  add some to the never-tile list or move them to another monitor. Always-on-top windows
  (such as a pinned terminal) are never tiled and float over the layout on purpose.
- **A window seems stuck in a slot.** Dragging it onto another tile now swaps them. To free a
  window completely, drag one of its screen-border edges (it floats), or add it to the
  never-tile list.

## Tests

```bash
./tests/run.sh      # needs node >= 18, python3, libglib2.0-bin
```

The WinTile tests run the **real** layout, resize and drag-swap functions from
`extension.js` against fake windows and a fake pointer. They check, among other things, that
landscape output is identical to the version before orientation support
(`tests/fixtures/`), that portrait stacks up to 3 and pairs from 4, that windows with a minimum
size larger than their tile are re-laid out instead of overlapping, and that swaps keep
hand-resized sizes.
The install test runs `install.sh` / `uninstall.sh` in a throw-away `HOME` with stand-ins for
`systemctl` and `gnome-extensions`, so it cannot touch your system.

These tests cover logic, not the live shell: how the swap outline looks and feels with a real
mouse has to be checked by hand.

## Repository layout

```
wintile@nowsci.com/     the extension (install target)
focus-opacity/          Window Effects: bin/, systemd/, applications/
tools/                  wintile-never-tile
tests/                  node + shell tests, fixtures/
install.sh  uninstall.sh
NOTICE.md               upstream credit and a dated record of what was changed
LICENSE                 GPL-3.0
```

## Credits and license

`wintile@nowsci.com/` is a modified copy of [WinTile](https://github.com/fmstrat/wintile)
(GPL-3.0). `NOTICE.md` and the git history record what was changed and when. Because WinTile
is GPL-3.0, this whole repository is licensed **GPL-3.0**; see `LICENSE`.

The extension keeps upstream's UUID (`wintile@nowsci.com`) so it drops in as a replacement.
That also means it cannot be uploaded to extensions.gnome.org under that UUID.
