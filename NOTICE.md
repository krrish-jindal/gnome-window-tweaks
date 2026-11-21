# Notice and modification record

## Upstream

`wintile@nowsci.com/` is a modified copy of **WinTile**, "Windows 10 window tiling
for GNOME".

- Upstream project: <https://github.com/fmstrat/wintile>
- Upstream license: GNU General Public License v3.0 (the `LICENSE.md` in that repository)
- Copyright in the original code belongs to its upstream authors.

Because WinTile is GPL-3.0, this whole repository is distributed under the GPL-3.0
as well (see `LICENSE`). Section 5(a) of the GPL requires modified works to carry
prominent notices stating that they were modified, with a relevant date; this file
and the git history are that record.

## Baseline

The first commit imports WinTile **v15** (per its `metadata.json`) exactly as it was
installed before any customisation. It was not byte-compared against upstream's
tagged release, so treat "matches upstream v15" as the intent rather than a proof.

## Modifications

### 2026-08-18 to 2026-08-20 — auto-tile mode

Modified `extension.js`, `prefs.js` and the settings schema to add:

- **Auto-tile mode** (`auto-tile` setting; `Super+Shift+T` toggles it): every tileable
  window on the active workspace is laid into the grid and re-laid when windows open,
  close, minimise or change monitor.
- Even outer and inner **gaps** in auto-tile mode (`gap` setting).
- **Hand-resize follows**: dragging an edge shared with a neighbour resizes the
  neighbour to match; dragging a screen-border edge floats that window.
- **Never-tile list** (`auto-tile-blacklist`), matched by WM_CLASS or title, with
  picture-in-picture players excluded by default; `tools/wintile-never-tile` helps
  fill it in.

### 2026-11-16 — orientation-aware auto-tile and drag-to-swap

Modified `extension.js`:

- **Orientation follows the monitor.** Landscape monitors tile into columns (windows
  side by side); portrait monitors tile into rows (windows stacked top/bottom), with
  the extra windows beside each other inside a row. Hand-resize works on the right
  axis in both orientations, and rotating a monitor resets its layout weights.
- **Drag to swap.** Dropping a tiled window on another tile on the same monitor
  exchanges their places (a highlight outlines the target while dragging). Dropped
  anywhere else, the window returns to its own slot.

### 2026-11-21 — portrait stacks fully; minimum window sizes respected

Modified `extension.js`:

- **Portrait layout rule changed.** Up to three windows stack in full-width rows; from four
  up they pair two to a row (4 = 2x2, 5 = 2+2+1). The earlier portrait layout put two windows
  side by side as soon as there were three, which is too narrow for most applications.
- **Minimum sizes.** After a layout the extension compares each window's real size with its
  tile; a window that is still larger has hit its application's minimum size. That minimum
  is remembered and the next layout picks the split into columns/rows in which the windows
  fit, and sizes the tiles unequally where that helps (a wide window and a narrow one can
  share a row that two wide ones could not), instead of letting windows overlap.

### 2026-11-21 (later) — drag to arrange

Modified `extension.js`:

- **Drop zones.** Dropping a dragged tile on the middle of another swaps them; on a side edge
  puts it beside the target; on the top or bottom edge puts it above or below (the roles of
  the two pairs trade places on a landscape monitor, where the lanes are columns).
- The result is kept per monitor as explicit rows of windows and takes precedence over the
  automatic layout while the orientation holds and every window's minimum size still fits; new
  windows get a lane of their own, closed ones drop out.
- A drop that cannot fit is refused: the outline turns red and a notification says why.

### 2026-11-21 (later still) — auto-tile survives disable/enable

Modified `extension.js`:

- `updateSettings()` now decides whether to attach auto-tile's window and drag listeners from
  whether they are actually attached, not from whether the setting changed. GNOME disables and
  re-enables the extension on every screen lock and unlock while the module (and its remembered
  `config.autoTile`) survives; the old comparison saw "no change" and left auto-tiling silently
  dead until the shell was restarted.
- Diagnostic `_log` lines (only with the `debug` setting on) at each early exit of the drag
  handler.

### 2026-11-21 (evening) — force resize

Added `wintile@nowsci.com/force-size.py` and modified `extension.js`, the schema and the tests:

- New setting `force-resize` (default on). Applications declare a minimum size in the
  `WM_NORMAL_HINTS` property of their window and mutter enforces it. `force-size.py` (Python,
  ctypes on libX11) lowers that minimum, never raises it, and remembers the original in
  `$XDG_RUNTIME_DIR/wintile-size-hints.json` so `restore` can put it back. The extension lowers
  every tiled X11 window to about 400 x 120 (plus the window's shadow) once, asynchronously,
  and relays out when the helper is done; layout plans with the lowered minimum straight away.
- `verifyTiles()` no longer writes a window off at its first miss: a window still bigger than its
  tile is lowered again (up to three times, verification waits 400 ms instead of 160) and only
  then, if it keeps refusing (normal Chrome windows do: they resize themselves back and rewrite
  their own hint), is its real size learned as its minimum, as before.
- Switching the setting off restores every original minimum. Disabling the extension (a screen
  lock) deliberately does not, which would make windows jump on every unlock.
- `updateSettings()` asks the schema whether `force-resize` exists before reading it: a compiled
  schema without a key aborts the whole shell when asked for it.
- Tests: `tests/force_test.js` (new); the existing harnesses register the new functions.

