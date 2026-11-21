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
  fit (for example, giving two too-wide windows a row each while the rest still pair up),
  instead of letting them overlap.
