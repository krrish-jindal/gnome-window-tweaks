/* global global */

const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const ExtensionUtils = imports.misc.extensionUtils;

const {Clutter, St} = imports.gi;

const Config = imports.misc.config;
const SHELL_VERSION = parseFloat(Config.PACKAGE_VERSION);

let onWindowGrabBegin, onWindowGrabEnd;
let requestMoveTimer, checkForMoveTimer, windowGrabBeginTimer, windowGrabEndTimer, checkIfNearGridTimer, keyManagerTimer;
let preview;
let windowMoving = false;
let dragStart = null;
let gsettings;


// View logs with `journalctl -qf |grep -i -e Wintile -e 'js error' `
/**
 * @param {string} message - the actual log to be logged
 */
function _log(message) {
    if (config.debug)
        log('[WinTile]', message);
}

let config = {
    cols: 2,
    rows: 2,
    ultrawideOnly: false,
    nonUltraCols: 2,
    nonUltraRows: 2,
    useMaximize: true,
    useMinimize: true,
    preview: {
        enabled: true,
        doubleWidth: true,
        distance: 75,
        delay: 500,
    },
    gap: 0,
    autoTile: false,
    autoTileBlacklist: [],
    debug: true,
};

/**
 *
 */
function updateSettings() {
    config.cols = gsettings.get_value('cols').deep_unpack();
    config.rows = gsettings.get_value('rows').deep_unpack();
    config.preview.doubleWidth = gsettings.get_value('double-width').deep_unpack();
    config.ultrawideOnly = gsettings.get_value('ultrawide-only').deep_unpack();
    config.nonUltraCols = gsettings.get_value('non-ultra-cols').deep_unpack();
    config.nonUltraRows = gsettings.get_value('non-ultra-rows').deep_unpack();
    config.useMaximize = gsettings.get_value('use-maximize').deep_unpack();
    config.useMinimize = gsettings.get_value('use-minimize').deep_unpack();
    config.preview.enabled = gsettings.get_value('preview').deep_unpack();
    config.preview.distance = gsettings.get_value('distance').deep_unpack();
    config.preview.delay = gsettings.get_value('delay').deep_unpack();
    config.gap = gsettings.get_value('gap').deep_unpack();
    config.debug = gsettings.get_value('debug').deep_unpack();

    config.autoTile = gsettings.get_value('auto-tile').deep_unpack();
    config.autoTileBlacklist = gsettings.get_value('auto-tile-blacklist').deep_unpack();
    _log(JSON.stringify(config));

    // Decide from whether the listeners are really attached, not from whether the
    // setting changed: disable() detaches them, but this module (and so the old
    // `config.autoTile`) survives a disable/enable. GNOME does exactly that on
    // every screen lock and unlock, and comparing with the remembered value would
    // then see "no change" and leave auto-tiling dead.
    const connected = autoTileSignals.length > 0;
    _log(`updateSettings) autoTile=${config.autoTile} listenersAttached=${connected}`);
    if (config.autoTile && !connected)
        autoTileConnect();
    else if (!config.autoTile && connected)
        autoTileDisconnect();
    else if (config.autoTile)
        // cols/rows/gap changed while auto-tiling: relayout with the new grid
        scheduleRetile();
}

const wintile = {
    extdatadir: imports.misc.extensionUtils.getCurrentExtension().path,
    shell_version: parseInt(Config.PACKAGE_VERSION.split('.')[1], 10),
};
imports.searchPath.unshift(wintile.extdatadir);

const KeyBindings = imports.keybindings;
let keyManager = null;
var oldbindings = {
    unmaximize: [],
    maximize: [],
    toggle_tiled_left: [],
    toggle_tiled_right: [],
};

// Minimize app if config allows
/**
 *
 * @param {object} app the window object
 */
function requestMinimize(app) {
    _log(`useMinimize: ${config.useMinimize}`);
    if (config.useMinimize) {
        _log('Minimize');
        app.minimize();
    } else {
        _log('Not minimizing due to config');
    }
}

// --- Tile geometry ----------------------------------------------------------
// Gaps are uniform: `gap` px along every screen edge and between neighbouring
// tiles. Upstream inset each tile by gap/2 on all four sides, which left screen
// edges with half the gap that tile-to-tile seams got.
/**
 * Split a span into `count` slices bracketed and separated by `gap` px.
 *
 * @param {number} start - first pixel of the span
 * @param {number} size - length of the span
 * @param {number} count - number of slices
 * @param {number} gap - gap in px at both ends and between slices
 * @returns {Array} array of [offset, length] pairs
 */
function splitSpan(start, size, count, gap) {
    const inner = size - gap * (count + 1);
    const base = Math.floor(inner / count);
    const rem = inner - base * count;
    let pos = start + gap;
    const out = [];
    for (let i = 0; i < count; i++) {
        // Hand the rounding remainder to the leading slices so the trailing
        // edge gap stays exactly `gap` instead of absorbing the leftovers.
        const len = base + (i < rem ? 1 : 0);
        out.push([pos, len]);
        pos += len + gap;
    }
    return out;
}

/**
 * Split a span into slices sized by weight, with uniform gaps between them and
 * at both ends. Falls back to an even split when the weights make no sense.
 *
 * @param {number} start - first pixel of the span
 * @param {number} size - length of the span
 * @param {Array} weights - one positive weight per slice
 * @param {number} gap - pixels between slices, and at both ends
 * @returns {Array} array of [position, length]
 */
function splitSpanWeighted(start, size, weights, gap) {
    const count = weights.length;
    const inner = size - gap * (count + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    if (count === 0 || inner < count || total <= 0)
        return splitSpan(start, size, Math.max(1, count), gap);

    const lens = weights.map(w => Math.max(1, Math.round(inner * w / total)));
    // Rounding and the 1px floor both drift. Settle up on the widest slice so
    // the trailing edge gap stays exactly `gap` and no slice is visibly off.
    let widest = 0;
    for (let i = 1; i < count; i++) {
        if (lens[i] > lens[widest])
            widest = i;
    }
    lens[widest] = Math.max(1, lens[widest] + (inner - lens.reduce((a, b) => a + b, 0)));

    let pos = start + gap;
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push([pos, lens[i]]);
        pos += lens[i] + gap;
    }
    return out;
}

/**
 * The configured gap, clamped so every tile keeps a positive size.
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @returns {number} usable gap in px
 */
function effectiveGap(monitor) {
    const maxCol = Math.floor((monitor.width - monitor.colCount) / (monitor.colCount + 1));
    const maxRow = Math.floor((monitor.height - monitor.rowCount) / (monitor.rowCount + 1));
    return Math.max(0, Math.min(config.gap, maxCol, maxRow));
}

/**
 * Final on-screen rectangle for a grid location, gaps already applied.
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @param {object} loc = { col, row, width, height }
 * @returns {object} { x, y, w, h }
 */
function getTileRect(monitor, loc) {
    const gap = effectiveGap(monitor);
    const cols = splitSpan(monitor.x, monitor.width, monitor.colCount, gap);
    const rows = splitSpan(monitor.y, monitor.height, monitor.rowCount, gap);
    const clamp = (v, max) => Math.max(0, Math.min(v, max));
    const first = cols[clamp(loc.col, monitor.colCount - 1)];
    const last = cols[clamp(loc.col + loc.width - 1, monitor.colCount - 1)];
    const top = rows[clamp(loc.row, monitor.rowCount - 1)];
    const bottom = rows[clamp(loc.row + loc.height - 1, monitor.rowCount - 1)];
    // A tile spanning several cells swallows the gaps between them.
    return {
        x: first[0],
        y: top[0],
        w: last[0] + last[1] - first[0],
        h: bottom[0] + bottom[1] - top[0],
    };
}

// Move window to specified location and size.
// On paper, the move_resize_frame should not need the preceding move_frame,
// but the additional move_frame is known to fix errors with gnome-terminal
// and [gnome-]terminator.
// A similar fix is used in the gTile extension:
// See https://github.com/gTile/gTile/commit/fc68797015e13143f74606fcbb9d48859f55dca9 by jshack88.
/**
 *
 * @param {object} app - the window object
 * @param {number} x - desired x value
 * @param {number} y - desired y value
 * @param {number} w - desired width
 * @param {number} h - desired height
 */
function moveAppCoordinates(app, x, y, w, h) {
    // Gaps are already baked into the rectangle by getTileRect()/autoTileRects().
    // Re-applying them here would double-count them, and it also used to shrink
    // floating windows every time one was restored.
    _log(`moveAppCoordinates) Moving window to (${x},${y}), size (${w},${h})`);
    app.move_frame(true, x, y);
    app.move_resize_frame(true, x, y, w, h);
}

/**
 *
 * @param {object} app the window object
 * @param {object} loc = { col, row, width, height }
 */
function moveApp(app, loc) {
    _log(`moveApp) ${JSON.stringify(loc)}`);
    // A deliberate placement -- Super+Arrow, or a drag that snapped to the grid
    // -- is the user asking for a tile again, so stop floating this window. The
    // slot goes too: the window is no longer where the auto layout put it, so
    // its old shared edges mean nothing until the next relayout stamps new ones.
    delete app.wintileFloat;
    delete app.wintileSlot;
    var monitor = null;
    var monitorIndex = null;
    if (loc.mouse)
        monitorIndex = getCurrentMonitor();
    else
        monitorIndex = app.get_monitor();

    monitor = getMonitorInfo(monitorIndex);

    _log(`moveApp) monitor: ${JSON.stringify(monitor)}`);

    var colCount = monitor.colCount;
    var rowCount = monitor.rowCount;

    // if the colCount >= than loc.col means that we're moving into a non-ultrawide monitor and it's near the right of the screen
    if (loc.col >= colCount)
        loc.col = colCount - 1;

    // if the rowCount >= than loc.row means that we're moving into a non-ultrawide monitor and it's near the bottom of the screen
    if (loc.row >= rowCount)
        loc.row = rowCount - 1;

    const rect = getTileRect(monitor, loc);
    let x = rect.x;
    let y = rect.y;
    let w = rect.w;
    let h = rect.h;

    if (!config.useMaximize) {
        unMaximizeIfMaximized(app);
        moveAppCoordinates(app, x, y, w, h);
    } else {
        if (loc.height < rowCount || loc.width < colCount)
            unMaximizeIfMaximized(app);

        moveAppCoordinates(app, x, y, w, h);
        if (loc.height === rowCount && loc.width === colCount && !config.gap) {
            // Maximize
            _log('moveApp) maximize');
            app.maximize(Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL);
        } else if (loc.height === rowCount && !config.gap) {
            // Maximize vertically
            _log('moveApp) maximize - v');
            app.maximize(Meta.MaximizeFlags.VERTICAL);
        } else if (loc.width === colCount && !config.gap) {
            // Maximize horizontally
            _log('moveApp) maximize - h');
            app.maximize(Meta.MaximizeFlags.HORIZONTAL);
        }
    }

    app.wintile.col = loc.col;
    app.wintile.row = loc.row;
    app.wintile.width = loc.width;
    app.wintile.height = loc.height;
    let window = app.get_frame_rect();
    let leftShift = window.width - w;
    let upShift = window.height - h;
    if (leftShift && loc.col === colCount - 1) {
        _log(`moveApp) window wider than anticipated. Shift left by ${leftShift} px`);
        x -= leftShift;
        w = window.width;
    }
    if (upShift && loc.row === rowCount - 1) {
        _log(`moveApp) window lower than anticipated. Shift up by ${upShift} px`);
        y -= upShift;
        h = window.height;
    }
    if (upShift || leftShift)
        moveAppCoordinates(app, x, y, w, h);

    _log(`moveApp) window.x: ${window.x} window.y: ${window.y} window.width: ${window.width} window.height: ${window.height}`);
}

/**
 *
 * @param {object} app - The window object
 */
function unMaximizeIfMaximized(app) {
    if (app.maximized_horizontally || app.maximized_vertically)
        app.unmaximize(Meta.MaximizeFlags.BOTH);
}

/**
 *
 * @param {object} app - The window object
 * @param {boolean} maximized - Treat as already maximized
 */
function initApp(app, maximized = false) {
    const coords = app.get_frame_rect() || getDefaultFloatingRectangle(app);
    if (!maximized) {
        _log('initApp) init as normal');
        app.wintile = {
            origFrame: {'x': coords.x, 'y': coords.y, 'width': coords.width, 'height': coords.height},
            row: -1,
            col: -1,
            height: -1,
            width: -1,
        };
    } else {
        _log('initApp) init as maximize');
        app.wintile = {
            origFrame: {'x': coords.x, 'y': coords.y, 'width': coords.width, 'height': coords.height},
            row: 0,
            col: 0,
            height: config.rows,
            width: config.cols,
        };
    }
    _log(`initApp) app.wintile: ${JSON.stringify(app.wintile)}`);
}

/**
 *
 * @param {object} app the window object
 */
function getDefaultFloatingRectangle(app) {
    _log('getDefaultFloatingRectangle) Getting default rectangle.');
    let padding = 100;
    let workspace = app.get_work_area_current_monitor();
    return {
        x: workspace.x + padding,
        y: workspace.y + padding,
        width: workspace.width - padding * 2,
        height: workspace.height - padding * 2,
    };
}

/**
 *
 * @param {object} app the window object
 * @param {boolean} move -
 */
function restoreApp(app, move = true) {
    _log(`restoreApp) move: ${move}`);
    _log(`restoreApp) app.wintile: ${JSON.stringify(app.wintile)}`);
    unMaximizeIfMaximized(app);

    const [mouseX, mouseY] = global.get_pointer();
    if (move) {
        var space = app.get_work_area_current_monitor();
        if (app.wintile.origFrame.x + app.wintile.origFrame.width > space.x + space.width)
            app.wintile.origFrame.x = space.x + space.width - app.wintile.origFrame.width - 100;

        if (app.wintile.origFrame.y + app.wintile.origFrame.height > space.y + space.height)
            app.wintile.origFrame.y = space.y + space.height - app.wintile.origFrame.height - 100;

        moveAppCoordinates(app, app.wintile.origFrame.x, app.wintile.origFrame.y, app.wintile.origFrame.width, app.wintile.origFrame.height);
    } else {
        // BUG: when clicking the maximize button, then dragging the window off, it moves to below the mouse cursor
        let window = app.get_frame_rect();
        _log(`restoreApp A) mouse - mouseX:${mouseX} mouseY:${mouseY}`);
        _log(`restoreApp A) window - x:${window.x} y:${window.y} w:${window.width} h:${window.height}`);
        window = app.wintile.origFrame;
        _log(`restoreApp A) origFrame - x:${window.x} y:${window.y} w:${window.width} h:${window.height}`);
        moveAppCoordinates(app, Math.floor(mouseX - app.wintile.origFrame.width / 2), mouseY - 10, app.wintile.origFrame.width, app.wintile.origFrame.height);
        window = app.get_frame_rect();
        _log(`restoreApp B) mouse - mouseX:${mouseX} mouseY:${mouseY}`);
        _log(`restoreApp B) window - x:${window.x} y:${window.y} w:${window.width} h:${window.height}`);
        window = app.wintile.origFrame;
        _log(`restoreApp B) origFrame - x:${window.x} y:${window.y} w:${window.width} h:${window.height}`);
    }
    app.wintile = null;
}

/**
 *
 * @param {string} direction - must be left, right, up, or down
 * @param {boolean} ctrlPressed - self explanatory
 */
function sendMove(direction, ctrlPressed = false) {
    _log('---');
    _log(`sendMove) ${direction} ctrl: ${ctrlPressed}`);
    var app = global.display.focus_window;
    var monitorIndex = app.get_monitor();
    var curMonitor = getMonitorInfo(monitorIndex);

    let monitorToLeft = -1;
    let monitorToRight = -1;
    _log(`sendMove) curMonitor: ${JSON.stringify(curMonitor)}`);
    for (var i = 0; i < Main.layoutManager.monitors.length; i++) {
        if (i === monitorIndex)
            continue;

        let testMonitor = getMonitorInfo(i);
        let monitorHeightDiff = Math.abs(testMonitor.height - curMonitor.height);
        _log(`sendMove) testMonitor: ${JSON.stringify(testMonitor)}`);
        _log(`sendMove) monitorsHeightDiff :${monitorHeightDiff}`);

        if (testMonitor.x < curMonitor.x &&
            Math.abs(testMonitor.y - curMonitor.y) < (100 + monitorHeightDiff) &&
            (monitorToLeft === -1 || (monitorToLeft >= 0 && testMonitor.x > Main.layoutManager.monitors[monitorToLeft].x)))
            monitorToLeft = i;

        if (testMonitor.x > curMonitor.x && Math.abs(testMonitor.y - curMonitor.y) < (100 + monitorHeightDiff) &&
            (monitorToRight === -1 || (monitorToRight >= 0 && testMonitor.x < Main.layoutManager.monitors[monitorToRight].x)))
            monitorToRight = i;
    }
    _log(`sendMove) monitorToLeft: ${monitorToLeft} monitorToRight: ${monitorToRight}`);

    // First, check if maximized and apply a wintile state if so
    if (!app.wintile && app.maximized_horizontally && app.maximized_vertically)
        initApp(app, true);

    var colCount = curMonitor.colCount;
    var rowCount = curMonitor.rowCount;

    if (!app.wintile) {
        // We are not in a tile. Reset and find the most logical position
        _log('sendMove) Not in tile.');
        if (colCount === 4 || colCount === 5) {
            // 4 col grid
            switch (direction) {
            case 'left':
                // Move to the left half at full height
                initApp(app);
                moveApp(app, {'row': 0, 'col': 0, 'height': rowCount, 'width': 2});
                break;
            case 'right':
                // Move to the right half at full height
                initApp(app);
                moveApp(app, {'row': 0, 'col': colCount - 2, 'height': rowCount, 'width': 2});
                break;
            case 'up':
                // Maximize to center leaving 1 column on either side
                initApp(app);
                moveApp(app, {'row': 0, 'col': 1, 'height': rowCount, 'width': colCount - 2});
                break;
            case 'down':
                // Minimize
                requestMinimize(app);
                break;
            }
        } else {
            switch (direction) {
            case 'left':
                // Move to the far left at full height
                initApp(app);
                moveApp(app, {'row': 0, 'col': 0, 'height': rowCount, 'width': 1});
                break;
            case 'right':
                // Move to the far right at full height
                initApp(app);
                moveApp(app, {'row': 0, 'col': colCount - 1, 'height': rowCount, 'width': 1});
                break;
            case 'up':
                // Maximize
                initApp(app);
                moveApp(app, {'row': 0, 'col': 0, 'height': rowCount, 'width': colCount});
                break;
            case 'down':
                // Minimize
                requestMinimize(app);
                break;
            }
        }
    } else {
        // We are already in a tile.
        _log('sendMove) Already in a tile.');
        _log(`sendMove) ${JSON.stringify(app.wintile)}`);
        if (app.wintile.width > colCount) {
            _log(`sendMove) columns higher than expected. Lowering to ${colCount}`);
            app.wintile.width = colCount;
        }
        if (app.wintile.height > rowCount) {
            _log(`sendMove) rows higher than expected. Lowering to ${rowCount}`);
            app.wintile.height = rowCount;
        }

        if (ctrlPressed) {
            // any amount of columns
            switch (direction) {
            case 'left':
                if (app.wintile.col > 0) {
                    _log('sendMove) left - grow');
                    moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col - 1, 'height': app.wintile.height, 'width': app.wintile.width + 1});
                } else {
                    _log('sendMove) left - can\'t grow');
                }
                break;
            case 'right':
                if (app.wintile.col + app.wintile.width < colCount) {
                    _log('sendMove) right - grow');
                    moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col, 'height': app.wintile.height, 'width': app.wintile.width + 1});
                } else {
                    _log('sendMove) right - can\'t grow');
                }
                break;
            case 'up':
                if (app.wintile.row > 0) {
                    _log('sendMove) up - grow');
                    moveApp(app, {'row': app.wintile.row - 1, 'col': app.wintile.col, 'height': app.wintile.height + 1, 'width': app.wintile.width});
                } else {
                    _log('sendMove) up - can\'t grow');
                }
                break;
            case 'down':
                if (app.wintile.row + app.wintile.height < rowCount) {
                    _log('sendMove) down - grow');
                    moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col, 'height': app.wintile.height + 1, 'width': app.wintile.width});
                } else {
                    _log('sendMove) down - can\'t grow');
                }
                break;
            }
        } else {
            // any col grid
            switch (direction) {
            case 'left':
                _log('sendMove) left');
                if (app.wintile.col > 0) {
                    if (ctrlPressed) {
                        // We can grow left
                        _log('sendMove) left - grow');
                        moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col - 1, 'height': app.wintile.height, 'width': app.wintile.width + 1});
                    } else {
                        // We can move left on this monitor and keep our size
                        _log('sendMove) left - move');
                        moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col - 1, 'height': app.wintile.height, 'width': app.wintile.width});
                    }
                } else if (app.wintile.col === 0 && app.wintile.width > 1) {
                    // We are not yet to smallest width, so shrink
                    _log('sendMove) left - shrink');
                    moveApp(app, {'row': app.wintile.row, 'col': 0, 'height': app.wintile.height, 'width': app.wintile.width - 1});
                } else if (monitorToLeft !== -1) {
                    // There is a monitor to the left, so let's go there
                    _log('sendMove) left - yes monitor');
                    let newMonitor = getMonitorInfo(monitorToLeft);
                    app.move_to_monitor(monitorToLeft);
                    if (app.wintile.height === rowCount)
                        moveApp(app, {'row': app.wintile.row, 'col': newMonitor.colCount - 1, 'height': newMonitor.rowCount, 'width': 1});
                    else
                        moveApp(app, {'row': app.wintile.row, 'col': newMonitor.colCount - 1, 'height': app.wintile.height, 'width': 1});
                } else {
                    // We are already on the left, and there is no other monitor to the left
                    // Move to the left most column at full height
                    _log('sendMove) left - full-height');
                    moveApp(app, {'row': 0, 'col': 0, 'height': rowCount, 'width': 1});
                }
                break;
            case 'right':
                _log('sendMove) right');
                if (app.wintile.col + app.wintile.width - 1 < colCount - 1) {
                    // We can move right on this monitor and keep our size
                    _log('sendMove) right - move');
                    moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col + 1, 'height': app.wintile.height, 'width': app.wintile.width});
                } else if (app.wintile.col + app.wintile.width - 1 === colCount - 1 && app.wintile.width > 1) {
                    // We are not yet to smallest width, so shrink
                    _log('sendMove) right - shrink');
                    moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col + 1, 'height': app.wintile.height, 'width': app.wintile.width - 1});
                } else if (monitorToRight !== -1) {
                    // There is a monitor to the right, so let's go there
                    _log('sendMove) right - yes monitor');
                    let newMonitor = getMonitorInfo(monitorToRight);
                    app.move_to_monitor(monitorToRight);
                    if (app.wintile.height === rowCount)
                        moveApp(app, {'row': app.wintile.row, 'col': 0, 'height': newMonitor.rowCount, 'width': 1});
                    else
                        moveApp(app, {'row': app.wintile.row, 'col': 0, 'height': app.wintile.height, 'width': 1});
                } else {
                    // We are already on the right, and there is no other monitor to the right
                    // Move to the right most column at full height
                    _log('sendMove) right - full-height');
                    moveApp(app, {'row': 0, 'col': colCount - 1, 'height': rowCount, 'width': 1});
                }
                break;
            case 'up':
                _log('sendMove) up');
                if (app.wintile.row > 0) {
                    // We can move up on this monitor and keep our size
                    _log('sendMove) up - move');
                    moveApp(app, {'row': app.wintile.row - 1, 'col': app.wintile.col, 'height': app.wintile.height, 'width': app.wintile.width});
                } else if ((colCount === 4 || colCount === 5) && app.wintile.height === rowCount && app.wintile.width === colCount - 2 && app.wintile.col === 1) {
                    // We are in 1st maximize, go to full maximize
                    _log('sendMove) up - 1st max to full max');
                    moveApp(app, {'row': 0, 'col': 0, 'height': rowCount, 'width': colCount});
                } else if (app.wintile.row === 0 && app.wintile.height > 1) {
                    // We are already on the top, shrink
                    _log('sendMove) up - shrink');
                    moveApp(app, {'row': app.wintile.row, 'col': app.wintile.col, 'height': app.wintile.height - 1, 'width': app.wintile.width});
                } else if (app.wintile.row === rowCount - 1) {
                    // We are bottom row, go to full height, keeping width
                    _log('sendMove) up - bottom up');
                    moveApp(app, {'row': 0, 'col': app.wintile.col, 'height': rowCount, 'width': app.wintile.width});
                } else {
                    // We are top row, go straight to 2nd maximize
                    _log('sendMove) up - top up');
                    moveApp(app, {'row': 0, 'col': 0, 'height': rowCount, 'width': colCount});
                }
                break;
            case 'down':
                _log('sendMove) down');
                if (app.wintile.col === 0 && app.wintile.width === colCount && app.wintile.height === rowCount) {
                    if (colCount === 4 || colCount === 5) {
                        // We are 2nd maximized, go to 1st maximized
                        _log('sendMove) down - 2nd max to 1st max');
                        moveApp(app, {'row': 0, 'col': 1, 'height': rowCount, 'width': colCount - 2});
                    } else {
                        // We are maximized, restore
                        _log('sendMove) down - restore');
                        restoreApp(app);
                    }
                } else if ((colCount === 4 || colCount === 5) && app.wintile.col === 1 && app.wintile.width === colCount - 2) {
                    // We are 1st maximized, restore
                    _log('sendMove) down - 1st max to restore');
                    restoreApp(app);
                } else if (app.wintile.row + app.wintile.height < rowCount) {
                    // We can move down on this monitor and keep our size
                    _log('sendMove) down - move');
                    moveApp(app, {'row': app.wintile.row + 1, 'col': app.wintile.col, 'height': app.wintile.height, 'width': app.wintile.width});
                } else if (app.wintile.row + app.wintile.height === rowCount && app.wintile.height > 1) {
                    // We are already at the bottom, shrink
                    _log('sendMove) down - shrink');
                    moveApp(app, {'row': app.wintile.row + 1, 'col': app.wintile.col, 'height': app.wintile.height - 1, 'width': app.wintile.width});
                } else if (app.wintile.row === rowCount - 1 && app.wintile.width !== colCount) {
                    // We are not full bottom but are a tile, go full width
                    _log('sendMove) down - full-width');
                    moveApp(app, {'row': app.wintile.row, 'col': 0, 'height': 1, 'width': colCount});
                } else {
                    // We are bottom half, minimize
                    _log('sendMove) down - try minimize');
                    requestMinimize(app);
                }
                break;
            }
        }
    }
}

/**
 *
 * @param {string} direction - must be left, right, up, or down
 * @param {boolean} ctrlPressed - self explanatory
 */
function requestMove(direction, ctrlPressed = false) {
    requestMoveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        sendMove(direction, ctrlPressed);
    });
}

/**
 *
 * @param {number} x - desired x value
 * @param {number} y - desired y value
 * @param {object} app - the window object
 */
function checkForMove(x, y, app) {
    _log(`checkForMove) x: ${x}, y: ${y}`);
    if (!windowMoving)
        return;
    checkForMoveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        let [xAfter, yAfter] = global.get_pointer();
        if (x !== xAfter || y !== yAfter)
            restoreApp(app, false);
        else
            checkForMove(x, y, app);
    });
}

/**
 *
 * @param {object} mask - the mouse event mask from metaGrabOp
 *
 */
function isResize(mask) {
    let resizes = [Meta.GrabOp.RESIZING_NW,
        Meta.GrabOp.RESIZING_N,
        Meta.GrabOp.RESIZING_NE,
        Meta.GrabOp.RESIZING_E,
        Meta.GrabOp.RESIZING_SW,
        Meta.GrabOp.RESIZING_S,
        Meta.GrabOp.RESIZING_SE,
        Meta.GrabOp.RESIZING_W,
        // Alt+F8 keyboard resizing is a hand resize just as much as a drag is.
        // Older Meta versions may not define every member, so drop the gaps.
        Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
        Meta.GrabOp.KEYBOARD_RESIZING_N,
        Meta.GrabOp.KEYBOARD_RESIZING_S,
        Meta.GrabOp.KEYBOARD_RESIZING_E,
        Meta.GrabOp.KEYBOARD_RESIZING_W,
        Meta.GrabOp.KEYBOARD_RESIZING_NE,
        Meta.GrabOp.KEYBOARD_RESIZING_NW,
        Meta.GrabOp.KEYBOARD_RESIZING_SE,
        Meta.GrabOp.KEYBOARD_RESIZING_SW].filter(op => op !== undefined);

    const resize = resizes.some(value => mask === value);
    _log(`isResize) mask: ${mask} resize: ${resize}`);
    return resize;
}


/**
 *
 * @param {object} metaWindow - window object
 * @param {object} metaGrabOp - type of window being grabbed
 */
function windowGrabBegin(metaWindow, metaGrabOp) {
    let [mouseX, mouseY] = global.get_pointer();
    if (isResize(metaGrabOp))
        return false;

    var app = global.display.focus_window;
    let window = app.get_frame_rect();
    _log(`windowGrabBegin) mouse - mouseX:${mouseX} mouseY:${mouseY}`);
    _log(`windowGrabBegin) window - x:${window.x} y:${window.y} w:${window.width} h:${window.height}`);

    if (metaWindow && metaGrabOp !== Meta.GrabOp.WAYLAND_POPUP) {
        windowMoving = true;

        if (app.wintile) {
            window = app.wintile.origFrame;
            _log(`windowGrabBegin) origFrame - x:${window.x} y:${window.y} w:${window.width} h:${window.height}`);
            checkForMove(mouseX, mouseY, app);
        }
        if (metaWindow.resizeable && config.preview.enabled) {
            app.origFrameRect = app.get_frame_rect();
            windowGrabBeginTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.preview.delay, () => {
                checkIfNearGrid(app);
            });
        }
    }
}

/**
 *
 * @param {object} metaWindow - the window object
 * @param {object} metaGrabOp - another window object
 */
function windowGrabEnd(metaWindow, metaGrabOp) {
    _log('windowGrabEnd)');
    if (metaWindow && metaGrabOp !== Meta.GrabOp.WAYLAND_POPUP) {
        windowMoving = false;
        if (metaWindow.resizeable && config.preview.enabled) {
            if (preview.visible) {
                const app = global.display.focus_window;
                if (!app.wintile)
                    initApp(app);

                moveApp(app, {
                    row: preview.loc.row,
                    col: preview.loc.col,
                    height: preview.loc.height,
                    width: preview.loc.width,
                    mouse: true,
                });

                hidePreview();
            } else {
                windowGrabEndTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    const app = global.display.focus_window;
                    if (app.maximized_horizontally && app.maximized_vertically)
                        initApp(app, true);
                });
            }
        }
    }
    dragStart = null;
}

/**
 *
 * @param {object} settingsObject - Keybinding object
 * @param {string} key - Name of key being changed. E.g. maximize, unmaximize, toggle-tiled-left, toggle-tiled-right
 * @param {string} oldBinding - What the binding was
 * @param {string} newBinding - What the new binding will be
 */
function changeBinding(settingsObject, key, oldBinding, newBinding) {
    var binding = oldbindings[key.replace(/-/g, '_')];
    var _newbindings = [];
    for (var i = 0; i < binding.length; i++) {
        let currentbinding = binding[i];
        if (currentbinding === oldBinding)
            currentbinding = newBinding;

        _newbindings.push(currentbinding);
    }
    settingsObject.set_strv(key, _newbindings);
}

/**
 *
 * @param {number} a - first number
 * @param {number} b - second number
 * @param {number} distance - how far apart can numbers be?
 */
function isClose(a, b, distance = config.preview.distance) {
    return Math.abs(a - b) < distance;
}

/**
 *
 * @param {object} loc = { col, row, width, height }
 * @param {object} monitor - monitor info from getMonitorInfo()
 */
function showPreview(loc, monitor) {
    if (preview.loc && JSON.stringify(preview.loc) === JSON.stringify(loc))
        return;

    let [mouseX, mouseY] = global.get_pointer();
    preview.x = mouseX;
    preview.y = mouseY;
    preview.visible = true;
    preview.loc = loc;
    const rect = getTileRect(monitor, loc);
    preview.ease({
        time: 0.125,
        opacity: 255,
        visible: true,
        transition: Clutter.AnimationMode.EASE_OUT_QUAD,
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
    });
}

/**
 *
 */
function hidePreview() {
    preview.visible = false;
    preview.loc = null;
    preview.width = -1;
    preview.height = -1;
    preview.x = -1;
    preview.y = -1;
}

/**
 *
 * @param {object} app the window object
 */
function checkIfNearGrid(app) {
    _log('checkIfNearGrid)');
    if (!windowMoving)
        return;

    let [mouseX, mouseY, mask] = global.get_pointer();
    let ctrlPressed = mask & Clutter.ModifierType.CONTROL_MASK;
    let superPressed = mask & Clutter.ModifierType.MOD4_MASK; // windows key
    var close = false;

    var monitorIndex = getCurrentMonitor();
    var monitor = getMonitorInfo(monitorIndex);
    _log(`checkIfNearGrid) monitor: ${JSON.stringify(monitor)}`);

    var colCount = monitor.colCount;
    var rowCount = monitor.rowCount;

    var colWidth = Math.floor(monitor.width / colCount);
    var rowHeight = Math.floor(monitor.height / rowCount);

    let window = app.get_frame_rect();
    _log(`checkIfNearGrid) mouse - mouseX:${mouseX} mouseY:${mouseY} mask:${mask}`);
    _log(`checkIfNearGrid) keys - ctrl:${ctrlPressed} superPressed:${superPressed}`);
    _log(`checkIfNearGrid) monitor - x:${monitor.x} y:${monitor.y} w:${monitor.width} h:${monitor.height}`);
    _log(`checkIfNearGrid) window - x:${window.x} y:${window.y} w:${window.width} h:${window.height}`);
    var c = Math.floor((mouseX - monitor.x) / colWidth);
    var r = Math.floor((mouseY - monitor.y) / rowHeight);
    c = Math.max(0, Math.min(c, colCount - 1));
    r = Math.max(0, Math.min(r, rowCount - 1));

    var gridX = c * colWidth + monitor.x;
    var inGrid = mouseX > gridX && mouseX < gridX + colWidth;
    var centerOfGrid = mouseX > Math.floor(gridX + colWidth / 3) && mouseX < Math.floor(gridX + (2 * colWidth / 3));
    var topRow = mouseY < monitor.y + rowHeight;
    var bottomRow = mouseY > monitor.y + monitor.height - rowHeight;
    var nearTop = isClose(mouseY, monitor.y) || mouseY < monitor.y;
    var nearBottom = isClose(mouseY, monitor.y + monitor.height) || mouseY > monitor.y + monitor.height;
    var nearLeft = isClose(mouseX, monitor.x) || mouseX < monitor.x;
    var nearRight = isClose(mouseX, monitor.rightEdge) || mouseX > monitor.rightEdge;

    var centerOfScreenH = monitor.x + Math.floor(monitor.width / 2);
    var columnWidthFraction = Math.floor(colWidth / 3);
    var nearCenterH = mouseX > centerOfScreenH - (columnWidthFraction / 2) && mouseX < centerOfScreenH + (columnWidthFraction / 2);

    var centerOfScreenV = monitor.y + Math.floor(monitor.height / 2);
    var rowHeightFraction = Math.floor(rowHeight / 3);
    var nearCenterV = mouseY > centerOfScreenV - (rowHeightFraction / 2) && mouseY < centerOfScreenV + (rowHeightFraction / 2);

    if (ctrlPressed && superPressed && dragStart === null) {
        dragStart = {col: c, row: r, monitorIndex};
        _log(`checkIfNearGrid) dragStart: ${JSON.stringify(dragStart)}`);
    }

    if (ctrlPressed && superPressed) {
        // check if it's on the samescreen it was on before, otherwise reinitialize dragStart
        if (dragStart.monitorIndex !== monitorIndex)
            dragStart = {col: c, row: r, monitor};
        // If ctrl and super are pressed, draw the box from start to finish
        showPreview({
            col: Math.min(c, dragStart.col),
            row: Math.min(r, dragStart.row),
            width: Math.abs(c - dragStart.col) + 1,
            height: Math.abs(r - dragStart.row) + 1,
        }, monitor);
        close = true;
    } else if (nearTop && nearCenterH) {
        // If we are in the center top, show a preview for maximize
        showPreview({
            col: 0,
            row: 0,
            width: colCount,
            height: rowCount,
        }, monitor);
        close = true;
    } else if (nearBottom && nearCenterH) {
        // If we are in the center bottom, show a preview for bottom maximized horizontally
        showPreview({
            col: 0,
            row: rowCount - 1,
            width: colCount,
            height: 1,
        }, monitor);
        close = true;
    } else if (nearLeft && nearCenterV) {
        // If we are in the center left, show a preview for left maximize
        if ((colCount === 4 || colCount === 5) && config.preview.doubleWidth) {
            showPreview({
                col: 0,
                row: 0,
                width: 2,
                height: rowCount,
            }, monitor);
        } else {
            showPreview({
                col: 0,
                row: 0,
                width: 1,
                height: rowCount,
            }, monitor);
        }
        close = true;
    } else if (nearRight && nearCenterV) {
        // If we are in the center right, show a preview for right maximize
        if ((colCount === 4 || colCount === 5) && config.preview.doubleWidth) {
            showPreview({
                col: colCount - 2,
                row: 0,
                width: 2,
                height: rowCount,
            }, monitor);
        } else {
            showPreview({
                col: colCount - 1,
                row: 0,
                width: 1,
                height: rowCount,
            }, monitor);
        }
        close = true;
    } else if (nearLeft && topRow) {
        // If we are close to the top left, show the top left grid item
        if ((colCount === 4 || colCount === 5) && config.preview.doubleWidth) {
            showPreview({
                col: 0,
                row: 0,
                width: 2,
                height: 1,
            }, monitor);
        } else {
            showPreview({
                col: 0,
                row: 0,
                width: 1,
                height: 1,
            }, monitor);
        }
        close = true;
    } else if (nearLeft && bottomRow) {
        // If we are close to the bottom left, show the bottom left grid item
        if ((colCount === 4 || colCount === 5) && config.preview.doubleWidth) {
            showPreview({
                col: 0,
                row: rowCount - 1,
                width: 2,
                height: 1,
            }, monitor);
        } else {
            showPreview({
                col: 0,
                row: rowCount - 1,
                width: 1,
                height: 1,
            }, monitor);
        }
        close = true;
    } else if (nearRight && topRow) {
        // If we are close to the top right, show the top right grid item
        if ((colCount === 4 || colCount === 5) && config.preview.doubleWidth) {
            showPreview({
                col: colCount - 2,
                row: 0,
                width: 2,
                height: 1,
            }, monitor);
        } else {
            showPreview({
                col: colCount - 1,
                row: 0,
                width: 1,
                height: 1,
            }, monitor);
        }
        close = true;
    } else if (nearRight && bottomRow) {
        // If we are close to the bottom right, show the bottom right grid item
        if ((colCount === 4 || colCount === 5) && config.preview.doubleWidth) {
            showPreview({
                col: colCount - 2,
                row: rowCount - 1,
                width: 2,
                height: 1,
            }, monitor);
            close = true;
        } else if (ctrlPressed || nearLeft || nearRight) {
            // If we are close to the left or right or ctrl pressed, show the preview, wherever the pointer is
            showPreview({
                col: colCount - 1,
                row: rowCount - 1,
                width: 1,
                height: 1,
            }, monitor);
        }
        close = true;
    } else if (nearTop && inGrid) {
        // If we are close to the top, show a preview for the top grid item
        showPreview({
            col: c,
            row: 0,
            width: 1,
            height: 1,
        }, monitor);
        close = true;
    } else if (nearBottom && centerOfGrid) {
        // If we are close to the bottom and in the middle of a grid, show a preview for the bottom grid item at full height
        showPreview({
            col: c,
            row: 0,
            width: 1,
            height: rowCount,
        }, monitor);
        close = true;
    } else if (nearBottom && inGrid) {
        // If we are close to the bottom, show a preview for the bottom grid item
        showPreview({
            col: c,
            row: rowCount - 1,
            width: 1,
            height: 1,
        }, monitor);
        close = true;
    } else if (ctrlPressed || nearLeft || nearRight) {
        // If we are close to the left or right or ctrl pressed, show the preview, wherever the pointer is
        showPreview({
            col: c,
            row: r,
            width: 1,
            height: 1,
        }, monitor);
        close = true;
    }

    if (!close)
        hidePreview();

    checkIfNearGridTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, config.preview.delay, () => {
        checkIfNearGrid(app);
    });
}

/**
 *
 */
function getActiveWorkspace() {
    if (global.screen) { // mutter < 3.29
        return global.screen.get_active_workspace();
    } else { // mutter >= 3.29
        let workspaceManager = global.workspace_manager;
        return workspaceManager.get_active_workspace();
    }
}

/**
 *
 */
function getCurrentMonitor() {
    let monitorProvider = global.screen || global.display;
    return monitorProvider.get_current_monitor();
}

/**
 * @param {int} monitorIndex self explanatory
 */
function getMonitorInfo(monitorIndex) {
    let space = getActiveWorkspace().get_work_area_for_monitor(monitorIndex);
    let isPortrait = space.width < space.height;
    let isNotUltrawide = (space.height / space.width) < 1.9 && (space.width / space.height) < 1.9;
    var colCount = config.ultrawideOnly && isNotUltrawide ? config.nonUltraCols : config.cols;
    var rowCount = config.ultrawideOnly && isNotUltrawide ? config.nonUltraRows : config.rows;

    // swap col and row in portrait mode
    if (isPortrait)
        [colCount, rowCount] = [rowCount, colCount];

    let monitor = {
        monitorIndex,
        x: space.x,
        y: space.y,
        width: space.width,
        height: space.height,
        leftEdge: space.x,
        rightEdge: space.x + space.width,
        topEdge: space.y,
        bottomEdge: space.y + space.height,
        isPortrait,
        isNotUltrawide,
        colCount,
        rowCount,
    };
    return monitor;
}

// --- Auto-tiling ------------------------------------------------------------
// When on, every tileable window on the active workspace is laid into the grid
// and re-laid whenever windows open, close, minimize or change monitor. When
// off, nothing is moved and WinTile behaves exactly as before (manual mode).
// Dragging an edge a window shares with a neighbour resizes the neighbour to
// match, so a hand resize is kept as part of the layout rather than undone; only
// a drag on the screen border, which has no neighbour to trade space with, takes
// the window out of the layout -- keeping its slot reserved, so the others stay
// put. Either way the monitor is laid out afresh, evenly, as soon as a window
// arrives on it or leaves it.
let autoTileSignals = [];
let autoTileTimer = null;
let autoTiling = false;
// `workspace:monitor` -> { population, columns, rowCounts, colWeights, rowWeights }.
// The population tells a window arriving or leaving apart from any other reason
// to retile. The weights are how a hand resize survives: dragging an edge shared
// with a neighbour rewrites them rather than moving one window out of the layout.
const layoutState = new Map();
// No tile may be dragged below this fraction of the span it sits in.
const MIN_SLICE = 0.08;

/**
 * Whether a window is eligible for auto-tiling, ignoring whether it is currently
 * floating after a hand resize. Floating is deliberately NOT considered here:
 * retileAll() compares this set to decide when a window has come or gone, and a
 * float that changed the set would immediately cancel itself.
 *
 * @param {object} app - the window object
 * @returns {boolean} true when the window can be tiled
 */
function isTileCandidate(app) {
    if (!app)
        return false;

    let reason = null;
    if (app.window_type !== Meta.WindowType.NORMAL)
        reason = `type=${app.window_type}`;
    else if (app.is_skip_taskbar())
        reason = 'skip-taskbar';
    else if (app.minimized)
        reason = 'minimized';
    else if (app.is_fullscreen())
        reason = 'fullscreen';
    else if (app.is_above())
        // Always-on-top windows are floating on purpose -- browser
        // picture-in-picture players are the common case. Tiling one into the
        // grid is exactly what the user did not ask for.
        reason = 'always-on-top';
    else if (isBlacklisted(app))
        reason = 'blacklisted';
    else if (!app.resizeable)
        // The `resizeable` property is the window's inherent capability. Do NOT
        // use allows_resize()/allows_move() here: those describe whether the user
        // could drag-resize it *right now* and are false while a window is
        // maximized, which silently excluded every maximized window. retileAll()
        // unmaximizes before moving, so the standing capability is what counts.
        reason = 'not resizeable';

    if (reason) {
        _log(`isTileCandidate) skipping ${app.get_wm_class()}: ${reason}`);
        return false;
    }
    return true;
}

/**
 * Match a window against the never-auto-tile list, by WM_CLASS or by title.
 *
 * Matching the title too catches windows that share their app's class but are
 * not ordinary windows -- a browser's picture-in-picture player is titled
 * "Picture in picture" while still reporting the browser's class.
 *
 * @param {object} app - the window object
 * @returns {boolean} true when the window must be left alone
 */
function isBlacklisted(app) {
    const list = config.autoTileBlacklist;
    if (!list || !list.length)
        return false;
    const cls = (app.get_wm_class() || '').toLowerCase();
    const title = (app.get_title() || '').toLowerCase();
    return list.some(entry => {
        const needle = (entry || '').trim().toLowerCase();
        return needle && (cls.includes(needle) || title.includes(needle));
    });
}

/**
 * How many columns `count` windows use, and how many rows go in each. `cols`
 * caps the column count and the windows spread as evenly as possible: 1 fills
 * the screen, 2 split it left/right, 3 put one in one column and two in the
 * other.
 *
 * The layout follows the monitor's orientation: a landscape screen is cut into
 * columns side by side (left/right), a portrait one into rows stacked top to
 * bottom (up/down). `columns` and `rowCounts` therefore mean "lanes along the
 * long axis" and "tiles across each lane" -- literal columns/rows on landscape,
 * transposed on portrait. The names are kept so the weight bookkeeping and the
 * hand-resize code stay a single code path for both orientations.
 *
 * Landscape spreads the windows evenly over at most the grid's column count.
 * Portrait stacks up to three windows full width; from four up, windows pair up
 * two to a row (4 -> 2x2, 5 -> 2,2,1, 6 -> 2,2,2), because a portrait screen is
 * too narrow for more than two side by side.
 *
 * Windows with a known minimum size (learned by verifyTiles()) can veto that.
 * Every way of splitting the windows into lanes is scored by how far the even
 * tiles would fall short of the windows' minimums, and the best split wins; among
 * equally good ones, the one that moves the fewest windows from the preferred
 * layout. So two windows too wide to share a portrait row are given a row each,
 * while the others still pair up. With no known minimums this is simply the
 * preferred layout.
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @param {number} count - number of windows to place
 * @param {Array} [mins] - per window, in layout order: { w, h } minimum frame size or undefined
 * @returns {object} { columns, rowCounts, portrait }
 */
function autoTileStructure(monitor, count, mins) {
    const portrait = !!monitor.isPortrait;
    const wanted = preferredRowCounts(monitor, count);
    const make = rowCounts => ({columns: rowCounts.length, rowCounts, portrait});
    const preferred = make(wanted);
    if (!mins || !mins.some(Boolean))
        return preferred;
    if (structureViolation(monitor, preferred, mins) === 0)
        return preferred;

    // Which lane each window lands in, for measuring how far a split is from the
    // preferred one.
    const laneOf = rowCounts => {
        const lanes = [];
        rowCounts.forEach((n, lane) => {
            for (let k = 0; k < n; k++)
                lanes.push(lane);
        });
        return lanes;
    };
    const wantedLane = laneOf(wanted);
    const wantedMax = Math.max(...wanted);
    const distance = rowCounts => {
        let moved = Math.abs(rowCounts.length - wanted.length);
        laneOf(rowCounts).forEach((lane, i) => {
            if (lane !== wantedLane[i])
                moved++;
        });
        // Crowding a lane beyond what the preferred layout does is a far bigger
        // departure than moving a window. Windows whose minimum is not known yet
        // count as zero, so without this they would be packed three to a row.
        for (const n of rowCounts)
            moved += Math.max(0, n - wantedMax) * 10;
        return moved;
    };

    // Every ordered way to cut `count` windows into lanes is 2^(count-1) splits:
    // fine up to about ten windows. Beyond that, only the even splits.
    const candidates = [];
    if (count <= 10) {
        const walk = (left, current) => {
            if (left === 0) {
                candidates.push(current.slice());
                return;
            }
            for (let n = 1; n <= left; n++) {
                current.push(n);
                walk(left - n, current);
                current.pop();
            }
        };
        walk(count, []);
    } else {
        for (let lanes = 1; lanes <= count; lanes++) {
            const perLane = Math.floor(count / lanes);
            const extra = count - perLane * lanes;
            candidates.push(Array.from({length: lanes}, (_, c) => perLane + (c < extra ? 1 : 0)));
        }
    }

    const scored = candidates.map(rowCounts => ({
        rowCounts,
        score: structureViolation(monitor, make(rowCounts), mins),
        moved: distance(rowCounts),
    }));
    const bestScore = Math.min(...scored.map(s => s.score));
    let best = null;
    for (const s of scored) {
        if (s.score <= bestScore + 1 && (!best || s.moved < best.moved))
            best = s;
    }
    return make(best.rowCounts);
}

/**
 * How the windows are cut into lanes when nothing stands in the way: the number
 * of windows in each lane, in layout order.
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @param {number} count - number of windows to place
 * @returns {Array} windows per lane
 */
function preferredRowCounts(monitor, count) {
    let lanes;
    if (monitor.isPortrait)
        lanes = count <= 3 ? count : Math.ceil(count / 2);
    else
        lanes = Math.min(count, monitor.colCount);
    lanes = Math.max(1, lanes);
    const perLane = Math.floor(count / lanes);
    const extra = count - perLane * lanes;
    return Array.from({length: lanes}, (_, c) => perLane + (c < extra ? 1 : 0));
}

/**
 * How many pixels, summed over the lanes and the tiles inside them, the windows'
 * known minimum sizes overshoot the room there is. Tiles do not have to be equal,
 * so a lane is only short of room when its minimums together do not fit: a wide
 * window and a narrow one can share a row that two wide ones could not. Zero
 * means everything fits (see fitWeights() for how the room is then divided).
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @param {object} structure - from autoTileStructure()
 * @param {Array} mins - per window, in layout order: { w, h } or undefined
 * @returns {number} total shortfall in px
 */
function structureViolation(monitor, structure, mins) {
    const gap = config.gap;
    const lanes = structure.columns;
    // Lanes run along x on landscape and along y on portrait.
    const laneSpan = structure.portrait ? monitor.height : monitor.width;
    const itemSpan = structure.portrait ? monitor.width : monitor.height;
    const along = m => (m ? (structure.portrait ? m.h : m.w) : 0);
    const across = m => (m ? (structure.portrait ? m.w : m.h) : 0);

    let total = 0;
    let laneNeed = 0;
    let i = 0;
    for (let c = 0; c < lanes; c++) {
        const n = structure.rowCounts[c];
        let laneMin = 0;
        let itemNeed = 0;
        for (let r = 0; r < n; r++, i++) {
            laneMin = Math.max(laneMin, along(mins[i]));
            itemNeed += across(mins[i]);
        }
        laneNeed += laneMin;
        total += Math.max(0, itemNeed - (itemSpan - gap * (n + 1)));
    }
    total += Math.max(0, laneNeed - (laneSpan - gap * (lanes + 1)));
    return total;
}

/**
 * The gap for a structure, clamped against the busiest column so no tile
 * collapses to zero size.
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @param {object} structure - from autoTileStructure()
 * @returns {number} usable gap in px
 */
function autoTileGap(monitor, structure) {
    const maxRows = Math.max(...structure.rowCounts);
    // Lanes run along x on landscape and along y on portrait.
    const laneSpan = structure.portrait ? monitor.height : monitor.width;
    const itemSpan = structure.portrait ? monitor.width : monitor.height;
    return Math.max(0, Math.min(
        config.gap,
        Math.floor((laneSpan - structure.columns) / (structure.columns + 1)),
        Math.floor((itemSpan - maxRows) / (maxRows + 1))));
}

/**
 * Relative sizes for `mins.length` tiles sharing a span, each at least its minimum
 * where that is possible and otherwise as equal as possible. All ones (an even
 * split) when every minimum already fits an even share.
 *
 * Tiles below their minimum are pinned to it and the room that is left is shared
 * by the rest; if the minimums cannot all fit, everyone is scaled down together.
 *
 * @param {number} span - pixels available along the axis
 * @param {number} gap - gap in px at both ends and between tiles
 * @param {Array} mins - minimum size of each tile along the axis (0 = unknown)
 * @returns {Array} one positive weight per tile
 */
function fitWeights(span, gap, mins) {
    const n = mins.length;
    const avail = span - gap * (n + 1);
    const equal = avail / n;
    if (avail <= 0 || mins.every(m => !(m > equal)))
        return Array.from({length: n}, () => 1);

    const sizes = Array.from({length: n}, () => equal);
    const pinned = Array.from({length: n}, () => false);
    for (;;) {
        let more = false;
        for (let i = 0; i < n; i++) {
            if (!pinned[i] && sizes[i] < mins[i]) {
                pinned[i] = true;
                more = true;
            }
        }
        if (!more)
            break;
        let pinnedTotal = 0;
        let free = 0;
        for (let i = 0; i < n; i++) {
            if (pinned[i])
                pinnedTotal += mins[i];
            else
                free++;
        }
        const share = free > 0 ? (avail - pinnedTotal) / free : 0;
        for (let i = 0; i < n; i++)
            sizes[i] = pinned[i] ? mins[i] : Math.max(1, share);
        if (free === 0 || share <= 0)
            break;
    }
    const total = sizes.reduce((x, y) => x + y, 0);
    if (total > avail)
        return sizes.map(s => s * avail / total);
    return sizes;
}

/**
 * A short string identifying the minimum sizes a layout was sized around, so a
 * newly learned minimum can be told apart from "nothing changed".
 *
 * @param {Array} mins - per window: { w, h } or undefined
 * @returns {string} '' when no minimum is known
 */
function minsKeyOf(mins) {
    if (!mins || !mins.some(Boolean))
        return '';
    return JSON.stringify(mins.map(m => (m ? [Math.round(m.w), Math.round(m.h)] : 0)));
}

/**
 * Layout state with the starting weights: even (every column the same width, every
 * row in a column the same height), except where known minimum sizes need more
 * room than an even share, in which case those tiles are sized up to their minimum
 * and the others give way.
 *
 * @param {object} structure - from autoTileStructure()
 * @param {string} population - the window set these weights describe
 * @param {Array} [mins] - per window, in layout order: { w, h } or undefined
 * @param {object} [monitor] - monitor info, needed to size around the minimums
 * @returns {object} fresh layout state
 */
function evenLayoutState(structure, population, mins, monitor) {
    const state = {
        population,
        columns: structure.columns,
        portrait: !!structure.portrait,
        rowCounts: structure.rowCounts.slice(),
        colWeights: structure.rowCounts.map(() => 1),
        rowWeights: structure.rowCounts.map(n => Array.from({length: n}, () => 1)),
        minsKey: minsKeyOf(mins),
    };
    if (!state.minsKey || !monitor)
        return state;

    const gap = config.gap;
    const laneSpan = structure.portrait ? monitor.height : monitor.width;
    const itemSpan = structure.portrait ? monitor.width : monitor.height;
    const along = m => (m ? (structure.portrait ? m.h : m.w) : 0);
    const across = m => (m ? (structure.portrait ? m.w : m.h) : 0);
    const laneMins = [];
    const itemMins = [];
    let i = 0;
    for (const n of structure.rowCounts) {
        let laneMin = 0;
        const items = [];
        for (let r = 0; r < n; r++, i++) {
            laneMin = Math.max(laneMin, along(mins[i]));
            items.push(across(mins[i]));
        }
        laneMins.push(laneMin);
        itemMins.push(items);
    }
    state.colWeights = fitWeights(laneSpan, gap, laneMins);
    state.rowWeights = itemMins.map(items => fitWeights(itemSpan, gap, items));
    return state;
}

/**
 * Place the windows of a structure using its stored weights, gaps applied.
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @param {object} structure - from autoTileStructure()
 * @param {object} state - layout state holding the weights
 * @returns {Array} array of { x, y, w, h, col, row }
 */
function autoTileRects(monitor, structure, state) {
    const gap = autoTileGap(monitor, structure);
    const portrait = !!structure.portrait;
    // Lanes are columns on landscape and rows on portrait; the tiles inside a
    // lane run across the other axis. `col`/`row` below are lane/tile indices
    // into the stored weights, not screen coordinates.
    const laneSpans = splitSpanWeighted(portrait ? monitor.y : monitor.x,
        portrait ? monitor.height : monitor.width, state.colWeights, gap);
    const rects = [];
    for (let c = 0; c < structure.columns; c++) {
        const itemSpans = splitSpanWeighted(portrait ? monitor.x : monitor.y,
            portrait ? monitor.width : monitor.height, state.rowWeights[c], gap);
        for (let r = 0; r < structure.rowCounts[c]; r++) {
            const [lanePos, laneLen] = laneSpans[c];
            const [itemPos, itemLen] = itemSpans[r];
            rects.push({
                x: portrait ? itemPos : lanePos,
                y: portrait ? lanePos : itemPos,
                w: portrait ? itemLen : laneLen,
                h: portrait ? laneLen : itemLen,
                col: c,
                row: r,
            });
        }
    }
    return rects;
}

/**
 * Lay every tileable window on the active workspace out, one monitor at a time.
 */
function retileAll() {
    if (!config.autoTile || windowMoving || autoTiling)
        return;

    const wsIndex = global.workspace_manager.get_active_workspace_index();
    const byMonitor = new Map();
    for (const app of getActiveWorkspace().list_windows()) {
        if (!isTileCandidate(app))
            continue;
        const idx = app.get_monitor();
        if (!byMonitor.has(idx))
            byMonitor.set(idx, []);
        byMonitor.get(idx).push(app);
    }

    autoTiling = true;
    try {
        for (const [idx, candidates] of byMonitor) {
            // Creation order unless the user swapped two windows by dragging, so a
            // window keeps its slot as others come and go.
            candidates.sort((a, b) => autoTileKey(a) - autoTileKey(b));

            const key = `${wsIndex}:${idx}`;
            // Sorted numerically so a swap, which only reorders the windows, is not
            // mistaken for one arriving or leaving -- that would reset hand resizes.
            const population = candidates.map(a => a.get_stable_sequence())
                .sort((x, y) => x - y).join(',');
            let state = layoutState.get(key);

            // A window arriving on or leaving this monitor means the layout is
            // stale: hand-resized windows rejoin the grid and the tiles go back
            // to even. Anything else that retiles -- a workspace switch, a
            // settings change -- keeps both. Zero columns never matches a real
            // structure, so the weights are rebuilt just below.
            if (!state || state.population !== population) {
                _log(`retileAll) ${key} window set changed, laying it out afresh`);
                for (const app of candidates) {
                    delete app.wintileFloat;
                    delete app.wintileSlot;
                }
                state = {population, columns: 0, rowCounts: [], colWeights: [], rowWeights: []};
                layoutState.set(key, state);
            }

            const monitor = getMonitorInfo(idx);
            // What the user arranged by dragging wins over the automatic layout,
            // for as long as the orientation holds and every window still fits.
            let arranged = null;
            const saved = arrangement.get(key);
            if (saved && saved.portrait === !!monitor.isPortrait) {
                const rows = reconcileRows(saved.rows, candidates);
                if (rowsFeasible(monitor, rows)) {
                    arranged = rows;
                } else {
                    _log(`retileAll) ${key} the arrangement no longer fits; back to automatic`);
                    arrangement.delete(key);
                    Main.notify('WinTile', 'A window is too large for your arrangement; back to the automatic layout.');
                }
            } else if (saved) {
                arrangement.delete(key);
            }
            if (arranged) {
                // `candidates` is sorted by key: hand the same keys out in the
                // arranged order so the layout order follows the rows.
                const keys = candidates.map(autoTileKey);
                const ordered = arranged.flat();
                ordered.forEach((w, i) => {
                    w.wintileOrder = keys[i];
                });
                candidates.splice(0, candidates.length, ...ordered);
                arrangement.set(key, {
                    portrait: !!monitor.isPortrait,
                    rows: arranged.map(r => r.map(w => w.get_stable_sequence())),
                });
            }
            // Floating windows are counted in the structure even though they are
            // not placed, so their slot stays reserved and the windows around
            // them never shuffle just because one left the layout.
            const mins = candidates.map(a => a.wintileMin);
            const structure = arranged
                ? {columns: arranged.length, rowCounts: arranged.map(r => r.length), portrait: !!monitor.isPortrait}
                : autoTileStructure(monitor, candidates.length, mins);
            // Weights only describe the structure they were built for.
            // That includes the orientation: rotating a monitor turns left/right
            // into up/down, so weights from the old arrangement must not carry over.
            // And the minimum sizes they were sized around: a newly learned minimum
            // re-sizes the tiles so that window fits.
            if (state.columns !== structure.columns ||
                state.portrait !== structure.portrait ||
                state.rowCounts.join(',') !== structure.rowCounts.join(',') ||
                state.minsKey !== minsKeyOf(mins)) {
                state = evenLayoutState(structure, population, mins, monitor);
                layoutState.set(key, state);
            }

            const rects = autoTileRects(monitor, structure, state);
            _log(`retileAll) monitor ${idx}: ${candidates.length} window(s)`);
            candidates.forEach((app, i) => {
                if (app.wintileFloat) {
                    // Owns no shared edges while it sits outside the layout.
                    delete app.wintileSlot;
                    delete app.wintileTarget;
                    return;
                }
                const rect = rects[i];
                unMaximizeIfMaximized(app);
                moveAppCoordinates(app, rect.x, rect.y, rect.w, rect.h);
                // Remembered so a later hand resize knows which edges this
                // window shares with a neighbour.
                app.wintileSlot = {key, col: rect.col, row: rect.row};
                // What verifyTiles() later compares the real size against.
                app.wintileTarget = {w: rect.w, h: rect.h};
                // Drop stale manual-tiling state so Super+Arrow re-reads the
                // window's real position the next time it is used.
                delete app.wintile;
            });
        }
    } finally {
        autoTiling = false;
    }
    scheduleVerify();
}

/**
 * Coalesce bursts of window events into a single relayout.
 *
 * @param {number} delay - milliseconds to wait before retiling
 */
function scheduleRetile(delay = 120) {
    if (!config.autoTile)
        return;
    if (autoTileTimer) {
        GLib.source_remove(autoTileTimer);
        autoTileTimer = null;
    }
    autoTileTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        autoTileTimer = null;
        retileAll();
        return GLib.SOURCE_REMOVE;
    });
}

// --- Minimum sizes ----------------------------------------------------------
// A window cannot be made smaller than the minimum its application sets, so a
// tile below that makes it spill over its neighbours. The minimum is not
// readable from here, but it shows: mutter clamps the frame to it, so a window
// that is still bigger than the tile it was given has hit its minimum. That size
// is remembered (it only ever grows) and the next layout picks a lane count in
// which everything fits.
let verifyTimer = null;

/**
 * Check the placed windows shortly after a layout, once they have settled.
 *
 * @param {number} delay - milliseconds to wait
 */
function scheduleVerify(delay = 160) {
    if (verifyTimer) {
        GLib.source_remove(verifyTimer);
        verifyTimer = null;
    }
    verifyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        verifyTimer = null;
        verifyTiles();
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Learn minimum sizes from windows that did not fit the tile they were given,
 * and relayout when one is found.
 */
function verifyTiles() {
    if (!config.autoTile || windowMoving || autoTiling)
        return;
    // Mid-drag a window is legitimately bigger or smaller than its tile.
    try {
        if (global.display.get_grab_op() !== Meta.GrabOp.NONE)
            return;
    } catch (e) {
        // No grab query on this shell: carry on.
    }

    let learned = false;
    for (const app of getActiveWorkspace().list_windows()) {
        const target = app.wintileTarget;
        if (!target || app.wintileFloat || app.minimized || app.is_fullscreen() || app.is_above() ||
            app.maximized_horizontally || app.maximized_vertically)
            continue;
        const f = app.get_frame_rect();
        const overW = f.width > target.w + 1;
        const overH = f.height > target.h + 1;
        if (!overW && !overH)
            continue;

        const monitor = getMonitorInfo(app.get_monitor());
        const prev = app.wintileMin || {w: 0, h: 0};
        const next = {
            w: overW ? Math.max(prev.w, f.width) : prev.w,
            h: overH ? Math.max(prev.h, f.height) : prev.h,
        };
        // Bigger than the whole monitor is not a minimum size, it is something else.
        if (next.w > monitor.width || next.h > monitor.height)
            continue;
        if (next.w - prev.w > 1 || next.h - prev.h > 1) {
            _log(`verifyTiles) ${app.get_wm_class()} cannot go below ${next.w}x${next.h}`);
            app.wintileMin = next;
            learned = true;
        }
    }
    if (learned)
        scheduleRetile(0);
}

// --- Drag to swap -----------------------------------------------------------
// Dragging a tiled window by its title bar and dropping it on another tile on
// the same monitor arranges the two by WHERE on the tile it lands:
//   middle of the tile   swap places with it
//   a side edge          sit beside it, in its row (portrait) or column (landscape)
//   top/bottom edge      go above or below it
// (on a landscape screen the two pairs trade roles: the lanes are columns there).
// The result is remembered per monitor as explicit rows of windows and wins over
// the automatic layout for as long as it still fits and the orientation holds;
// windows that open later get a lane of their own, closed ones simply drop out.
// A drop that cannot fit, because the windows' minimum sizes do not add up to the
// room, is refused: the outline turns red and a message says so. Dropped anywhere
// else, the window goes back to its own slot as before.
let swapDrag = null;       // { app, monitor, cx, cy } while a candidate is dragged
let swapDragTimer = null;  // polls the pointer to move the highlight
let swapHighlight = null;  // soft outline over where the dragged window would land
const SWAP_STYLE_OK = 'background-color: rgba(120, 160, 255, 0.28); ' +
    'border: 2px solid rgba(120, 160, 255, 0.9); border-radius: 12px;';
const SWAP_STYLE_NO = 'background-color: rgba(255, 90, 90, 0.25); ' +
    'border: 2px solid rgba(255, 90, 90, 0.9); border-radius: 12px;';
// `workspace:monitor` -> { portrait, rows: [[stable sequence, ...], ...] }: what the
// user arranged by dragging. Rows are lanes: rows in portrait, columns in landscape.
const arrangement = new Map();

/**
 * Sort key deciding which slot a window takes: its creation order, unless the
 * user has swapped it with another window by dragging.
 *
 * @param {object} app - the window object
 * @returns {number} sort key; lower keys take earlier slots
 */
function autoTileKey(app) {
    return app.wintileOrder !== undefined ? app.wintileOrder : app.get_stable_sequence();
}

/**
 * Key under which a monitor's layout is remembered on the active workspace.
 *
 * @param {number} monitorIndex - monitor index
 * @returns {string} `workspace:monitor`
 */
function layoutKey(monitorIndex) {
    return `${global.workspace_manager.get_active_workspace_index()}:${monitorIndex}`;
}

/**
 * Every tileable window of a monitor on the active workspace, in layout order.
 *
 * @param {number} monitorIndex - monitor index
 * @returns {Array} windows sorted by their layout key
 */
function tileCandidates(monitorIndex) {
    const out = getActiveWorkspace().list_windows()
        .filter(w => w.get_monitor() === monitorIndex && isTileCandidate(w));
    out.sort((a, b) => autoTileKey(a) - autoTileKey(b));
    return out;
}

/**
 * Bring a remembered arrangement up to date with the windows that exist now:
 * closed windows drop out, empty rows vanish, and a window that opened since gets
 * a lane of its own at the end.
 *
 * @param {Array} savedRows - [[stable sequence, ...], ...]
 * @param {Array} candidates - the monitor's current tileable windows
 * @returns {Array} [[window, ...], ...]
 */
function reconcileRows(savedRows, candidates) {
    const byId = new Map(candidates.map(a => [a.get_stable_sequence(), a]));
    const rows = [];
    for (const ids of savedRows) {
        const row = [];
        for (const id of ids) {
            if (byId.has(id)) {
                row.push(byId.get(id));
                byId.delete(id);
            }
        }
        if (row.length)
            rows.push(row);
    }
    for (const w of byId.values())
        rows.push([w]);
    return rows;
}

/**
 * How the monitor's windows are laid out right now, as rows of windows: the
 * user's arrangement if there is one, otherwise whatever structure the last
 * layout used.
 *
 * @param {number} monitorIndex - monitor index
 * @param {Array} candidates - the monitor's tileable windows in layout order
 * @returns {Array} [[window, ...], ...]
 */
function currentRows(monitorIndex, candidates) {
    const key = layoutKey(monitorIndex);
    const monitor = getMonitorInfo(monitorIndex);
    const saved = arrangement.get(key);
    if (saved && saved.portrait === !!monitor.isPortrait)
        return reconcileRows(saved.rows, candidates);

    const state = layoutState.get(key);
    let rowCounts = null;
    if (state && state.rowCounts && state.rowCounts.reduce((x, y) => x + y, 0) === candidates.length)
        rowCounts = state.rowCounts;
    if (!rowCounts)
        rowCounts = autoTileStructure(monitor, candidates.length, candidates.map(w => w.wintileMin)).rowCounts;
    const rows = [];
    let i = 0;
    for (const n of rowCounts) {
        rows.push(candidates.slice(i, i + n));
        i += n;
    }
    return rows;
}

/**
 * Whether the windows' known minimum sizes fit in an arrangement.
 *
 * @param {object} monitor - monitor info from getMonitorInfo()
 * @param {Array} rows - [[window, ...], ...]
 * @returns {boolean} true when nothing would be squeezed below its minimum
 */
function rowsFeasible(monitor, rows) {
    const structure = {
        columns: rows.length,
        rowCounts: rows.map(r => r.length),
        portrait: !!monitor.isPortrait,
    };
    return structureViolation(monitor, structure, rows.flat().map(w => w.wintileMin)) === 0;
}

/**
 * Where on a tile the pointer is: the middle swaps, an edge means "beside" or
 * "above/below". The pointer may be in the gap just outside the tile; it counts
 * as the nearest edge.
 *
 * @param {object} target - the tile under the pointer
 * @returns {string} 'swap', 'left', 'right', 'top' or 'bottom'
 */
function dropZone(target) {
    const [px, py] = global.get_pointer();
    const r = target.get_frame_rect();
    const fx = Math.min(1, Math.max(0, (px - r.x) / r.width));
    const fy = Math.min(1, Math.max(0, (py - r.y) / r.height));
    const dist = {left: fx, right: 1 - fx, top: fy, bottom: 1 - fy};
    const nearest = Object.keys(dist).reduce((a, b) => (dist[b] < dist[a] ? b : a));
    return dist[nearest] >= 0.25 ? 'swap' : nearest;
}

/**
 * The part of a tile that a drop would take, for the outline.
 *
 * @param {object} r - the tile's frame rect
 * @param {string} zone - from dropZone()
 * @returns {object} { x, y, w, h }
 */
function zoneRect(r, zone) {
    const hw = Math.round(r.width / 2);
    const hh = Math.round(r.height / 2);
    switch (zone) {
    case 'left': return {x: r.x, y: r.y, w: hw, h: r.height};
    case 'right': return {x: r.x + r.width - hw, y: r.y, w: hw, h: r.height};
    case 'top': return {x: r.x, y: r.y, w: r.width, h: hh};
    case 'bottom': return {x: r.x, y: r.y + r.height - hh, w: r.width, h: hh};
    default: return {x: r.x, y: r.y, w: r.width, h: r.height};
    }
}

/**
 * Work out what dropping `app` on `target` at `zone` would do, without doing it.
 *
 * @param {object} app - the dragged window
 * @param {object} target - the tile it is over
 * @param {string} zone - from dropZone()
 * @param {number} monitorIndex - monitor of the drag
 * @returns {object|null} { rows, candidates, fits, same } or null if either window is not tiled here
 */
function proposeDrop(app, target, zone, monitorIndex) {
    const monitor = getMonitorInfo(monitorIndex);
    const candidates = tileCandidates(monitorIndex);
    if (!candidates.includes(app) || !candidates.includes(target))
        return null;
    const rows = currentRows(monitorIndex, candidates).map(r => r.slice());
    const describe = rs => rs.map(r => r.map(w => w.get_stable_sequence()).join('.')).join('|');
    const before = describe(rows);
    const portrait = !!monitor.isPortrait;
    const locate = w => {
        for (let i = 0; i < rows.length; i++) {
            const j = rows[i].indexOf(w);
            if (j >= 0)
                return [i, j];
        }
        return [-1, -1];
    };

    if (zone === 'swap') {
        const [ai, aj] = locate(app);
        const [ti, tj] = locate(target);
        rows[ai][aj] = target;
        rows[ti][tj] = app;
    } else {
        const [ai, aj] = locate(app);
        rows[ai].splice(aj, 1);
        if (rows[ai].length === 0)
            rows.splice(ai, 1);
        const [ti, tj] = locate(target);
        // Beside the target means in its lane: left/right in portrait, top/bottom in landscape.
        const beforeInLane = portrait ? zone === 'left' : zone === 'top';
        const afterInLane = portrait ? zone === 'right' : zone === 'bottom';
        if (beforeInLane || afterInLane) {
            rows[ti].splice(beforeInLane ? tj : tj + 1, 0, app);
        } else {
            const newLaneBefore = portrait ? zone === 'top' : zone === 'left';
            rows.splice(newLaneBefore ? ti : ti + 1, 0, [app]);
        }
    }
    return {rows, candidates, fits: rowsFeasible(monitor, rows), same: describe(rows) === before};
}

/**
 * Make an arrangement the layout: remember it, and give the windows sort keys in
 * its order (reusing the same keys, so the window set is unchanged).
 *
 * @param {number} monitorIndex - monitor index
 * @param {Array} rows - [[window, ...], ...]
 * @param {Array} candidates - the monitor's tileable windows, sorted by key
 */
function applyRows(monitorIndex, rows, candidates) {
    const keys = candidates.map(autoTileKey);
    rows.flat().forEach((w, i) => {
        w.wintileOrder = keys[i];
    });
    arrangement.set(layoutKey(monitorIndex), {
        portrait: !!getMonitorInfo(monitorIndex).isPortrait,
        rows: rows.map(r => r.map(w => w.get_stable_sequence())),
    });
}

/**
 * The tile under the pointer that dropping `app` there would swap with. Only the
 * topmost window at the pointer counts, so a dialog lying over a tile is not
 * "seen through". The match is padded by the gap so a drop on the sliver between
 * two tiles still lands on one of them.
 *
 * @param {object} app - the window being dragged
 * @param {number} monitorIndex - monitor the drag started on; swaps stay on it
 * @returns {object|null} the window to swap with, or null
 */
function findSwapTarget(app, monitorIndex) {
    const [px, py] = global.get_pointer();
    const pad = config.gap + 2;
    const workspace = getActiveWorkspace();
    const actors = global.get_window_actors();
    // Actors are listed bottom to top, so walk them backwards.
    for (let i = actors.length - 1; i >= 0; i--) {
        const win = actors[i].meta_window;
        if (!win || win === app || win.minimized || !actors[i].visible)
            continue;
        if (!win.located_on_workspace(workspace))
            continue;
        const r = win.get_frame_rect();
        if (px < r.x - pad || px >= r.x + r.width + pad ||
            py < r.y - pad || py >= r.y + r.height + pad)
            continue;
        if (win.get_monitor() !== monitorIndex || win.wintileFloat || !isTileCandidate(win))
            return null;
        return win;
    }
    return null;
}

/**
 * Whether the dragged window has really been pulled away from where it started,
 * so a plain click on the title bar is never taken for a drag.
 *
 * @param {object} drag - the swapDrag record
 * @param {object} app - the window being dragged
 * @returns {boolean} true once it has moved
 */
function swapDragMoved(drag, app) {
    const f = app.get_frame_rect();
    return Math.abs(f.x + f.width / 2 - drag.cx) + Math.abs(f.y + f.height / 2 - drag.cy) > 12;
}

/**
 * Tear the drag state down: stop polling and remove the highlight.
 */
function stopSwapDrag() {
    if (swapDragTimer) {
        GLib.source_remove(swapDragTimer);
        swapDragTimer = null;
    }
    if (swapHighlight) {
        swapHighlight.destroy();
        swapHighlight = null;
    }
    swapDrag = null;
}

/**
 * Timer callback: outline where the dragged window would land, red if it cannot.
 *
 * @returns {boolean} GLib.SOURCE_CONTINUE while the drag lasts
 */
function updateSwapHighlight() {
    const drag = swapDrag;
    if (!drag) {
        swapDragTimer = null;
        return GLib.SOURCE_REMOVE;
    }
    try {
        let target = null;
        let zone = null;
        let plan = null;
        if (swapDragMoved(drag, drag.app) && drag.app.get_monitor() === drag.monitor) {
            target = findSwapTarget(drag.app, drag.monitor);
            if (target) {
                zone = dropZone(target);
                plan = proposeDrop(drag.app, target, zone, drag.monitor);
            }
        }
        const hint = target && plan ? `${target.get_wm_class()}:${zone}:${plan.fits}` : 'none';
        if (hint !== drag.lastHint) {
            drag.lastHint = hint;
            _log(`updateSwapHighlight) outline -> ${hint}`);
        }
        if (swapHighlight) {
            if (target && plan) {
                const r = zoneRect(target.get_frame_rect(), zone);
                swapHighlight.set_position(r.x, r.y);
                swapHighlight.set_size(r.w, r.h);
                swapHighlight.set_style(plan.fits ? SWAP_STYLE_OK : SWAP_STYLE_NO);
                swapHighlight.show();
            } else {
                swapHighlight.hide();
            }
        }
    } catch (e) {
        // The dragged window can vanish mid-drag; give up quietly.
        _log(`updateSwapHighlight) stopping: ${e.message}`);
        swapDragTimer = null;
        if (swapHighlight)
            swapHighlight.hide();
        return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
}

/**
 * A move grab began: remember where the window started and start outlining
 * swap targets. Windows auto-tiling would not place have no slot to trade.
 *
 * @param {object} app - the window being dragged
 */
function beginSwapDrag(app) {
    stopSwapDrag();
    if (app.wintileFloat || !isTileCandidate(app)) {
        _log(`beginSwapDrag) ${app.get_wm_class()} is not tracked (floating: ${!!app.wintileFloat})`);
        return;
    }
    _log(`beginSwapDrag) tracking ${app.get_wm_class()} on monitor ${app.get_monitor()}`);
    const frame = app.get_frame_rect();
    swapDrag = {
        app,
        monitor: app.get_monitor(),
        cx: frame.x + frame.width / 2,
        cy: frame.y + frame.height / 2,
    };
    try {
        swapHighlight = new St.Widget({
            style: SWAP_STYLE_OK,
            visible: false,
            reactive: false,
        });
        Main.uiGroup.add_actor(swapHighlight);
    } catch (e) {
        // The swap still works without the outline.
        _log(`beginSwapDrag) no highlight: ${e.message}`);
        swapHighlight = null;
    }
    swapDragTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, updateSwapHighlight);
}

/**
 * A move grab ended: if the window was dropped on another tile on the same
 * monitor, arrange it there by where on the tile it landed.
 *
 * @param {object} app - the window that was dragged
 * @returns {boolean} true when the arrangement changed
 */
function endSwapDrag(app) {
    const drag = swapDrag;
    stopSwapDrag();
    if (!drag) {
        _log(`endSwapDrag) ${app.get_wm_class()}: no drag was being tracked (floating, or not a tile)`);
        return false;
    }
    if (drag.app !== app) {
        _log('endSwapDrag) the grab ended on a different window than the one tracked');
        return false;
    }
    if (!swapDragMoved(drag, app)) {
        _log(`endSwapDrag) ${app.get_wm_class()} did not move: a click, not a drag`);
        return false;
    }
    if (app.get_monitor() !== drag.monitor) {
        _log(`endSwapDrag) ${app.get_wm_class()} was dropped on another monitor`);
        return false;
    }
    const target = findSwapTarget(app, drag.monitor);
    if (!target) {
        _log(`endSwapDrag) no tile under the pointer at ${JSON.stringify(global.get_pointer().slice(0, 2))}`);
        return false;
    }
    const zone = dropZone(target);
    const plan = proposeDrop(app, target, zone, drag.monitor);
    if (!plan) {
        _log('endSwapDrag) one of the two windows is not tiled on this monitor');
        return false;
    }
    if (plan.same) {
        _log(`endSwapDrag) ${zone} of ${target.get_wm_class()}: already arranged like that`);
        return false;
    }
    if (!plan.fits) {
        _log(`endSwapDrag) ${zone} drop of ${app.get_wm_class()} on ${target.get_wm_class()} does not fit`);
        Main.notify('WinTile', 'That arrangement will not fit: one of those windows cannot be made small enough.');
        return false;
    }
    _log(`endSwapDrag) ${app.get_wm_class()} -> ${zone} of ${target.get_wm_class()}`);
    applyRows(drag.monitor, plan.rows, plan.candidates);
    return true;
}

/**
 * Start reacting to window changes.
 */
function autoTileConnect() {
    autoTileDisconnect();
    _log('autoTileConnect) auto-tiling on');
    const watch = (obj, signal, delay) => {
        autoTileSignals.push([obj, obj.connect(signal, () => scheduleRetile(delay))]);
    };
    // A new window needs a beat to be mapped and placed before we move it.
    watch(global.display, 'window-created', 350);
    watch(global.display, 'window-entered-monitor', 120);
    autoTileSignals.push([global.display,
        global.display.connect('grab-op-begin', (...args) => onAutoTileGrab(args, true))]);
    autoTileSignals.push([global.display,
        global.display.connect('grab-op-end', (...args) => onAutoTileGrab(args, false))]);
    watch(global.window_manager, 'destroy', 120);
    watch(global.window_manager, 'minimize', 120);
    watch(global.window_manager, 'unminimize', 120);
    watch(global.workspace_manager, 'active-workspace-changed', 120);
    watch(Main.layoutManager, 'monitors-changed', 400);
    // Switching auto-tiling on starts fresh: nothing is floating yet. Covers
    // every workspace, not just the active one.
    for (const actor of global.get_window_actors()) {
        if (actor.meta_window) {
            delete actor.meta_window.wintileFloat;
            delete actor.meta_window.wintileOrder;
        }
    }
    layoutState.clear();
    arrangement.clear();
    scheduleRetile(0);
}

/**
 * Grab bookkeeping for auto-tiling.
 *
 * A drag that moves a window should still trigger a relayout, but a hand resize
 * must not: the plain relayout would undo the size the user just chose. The
 * resize is handed to applyManualResize() instead, which folds it into the
 * layout so the neighbours follow the dragged edge.
 *
 * @param {Array} args - raw signal arguments, emitter first
 * @param {boolean} begin - true for grab-op-begin, false for grab-op-end
 */
function onAutoTileGrab(args, begin) {
    // GNOME 40 dropped the screen argument these signals used to carry.
    const [app, grabOp] = SHELL_VERSION >= 40
        ? [args[1], args[2]]
        : [args[2], args[3]];
    if (!app)
        return;

    if (!isResize(grabOp)) {
        if (begin) {
            beginSwapDrag(app);
            return;
        }
        // Dropped on another tile: the two trade places. Anywhere else, the
        // relayout puts the window back in its own slot, as before.
        endSwapDrag(app);
        scheduleRetile(200);
        return;
    }

    const frame = app.get_frame_rect();
    if (!frame)
        return;

    if (begin) {
        // Kept so that clicking a border and releasing it without dragging is
        // not mistaken for a resize, and so the edges that actually moved can
        // be worked out when the grab ends.
        app.wintileGrabFrame = {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
        };
        return;
    }

    const before = app.wintileGrabFrame;
    delete app.wintileGrabFrame;
    // With no starting frame there is no way to tell which edges moved, so the
    // safe move is to leave the window alone.
    if (!before || (before.width === frame.width && before.height === frame.height))
        return;

    applyManualResize(app, before, frame);
}

/**
 * Absorb a hand resize into the layout.
 *
 * An edge shared with a neighbour is a boundary: dragging it rewrites the stored
 * weights, so the windows on the other side give up or take on that space and
 * the monitor stays gapless. An edge on the screen border has no neighbour to
 * trade with, so a drag there floats the window out of the layout instead --
 * that being the only way to honour it at all.
 *
 * @param {object} app - the window object
 * @param {object} before - frame rect before the grab
 * @param {object} after - frame rect after the grab
 */
function applyManualResize(app, before, after) {
    const slot = app.wintileSlot;
    const state = slot ? layoutState.get(slot.key) : null;

    // The slot has to still exist in the layout the weights describe.
    if (!state || slot.col >= state.columns ||
        slot.row >= (state.rowCounts[slot.col] || 0)) {
        _log(`applyManualResize) ${app.get_wm_class()} holds no known slot, floating it`);
        app.wintileFloat = true;
        delete app.wintileSlot;
        return;
    }

    const monitor = getMonitorInfo(app.get_monitor());
    // Measured in the orientation the layout was built for, not the monitor's
    // current one: if the screen has just been rotated, the stored weights still
    // describe the old arrangement until the pending retile rebuilds them.
    const portrait = !!state.portrait;
    const structure = {columns: state.columns, rowCounts: state.rowCounts, portrait};
    const gap = autoTileGap(monitor, structure);
    const rows = state.rowWeights[slot.col];
    // Lanes run along x on landscape and along y on portrait; the tiles inside a
    // lane run along the other axis.
    const laneContent = (portrait ? monitor.height : monitor.width) -
        gap * (state.columns + 1);
    const itemContent = (portrait ? monitor.width : monitor.height) -
        gap * (rows.length + 1);

    let moved = false;
    let stuck = false;
    const edge = (delta, weights, index, content) => {
        if (delta === 0)
            return;
        if (index < 0 || index >= weights.length - 1) {
            // An outer edge: no neighbour on the far side to trade with.
            stuck = true;
            return;
        }
        if (shiftBoundary(weights, index, delta, content))
            moved = true;
    };

    // Each edge is measured on its own, so dragging a corner can move both a
    // column boundary and a row boundary in one go.
    const dxLo = after.x - before.x;
    const dxHi = (after.x + after.width) - (before.x + before.width);
    const dyLo = after.y - before.y;
    const dyHi = (after.y + after.height) - (before.y + before.height);
    const [laneLo, laneHi, itemLo, itemHi] = portrait
        ? [dyLo, dyHi, dxLo, dxHi]
        : [dxLo, dxHi, dyLo, dyHi];
    edge(laneLo, state.colWeights, slot.col - 1, laneContent);
    edge(laneHi, state.colWeights, slot.col, laneContent);
    edge(itemLo, rows, slot.row - 1, itemContent);
    edge(itemHi, rows, slot.row, itemContent);

    if (moved) {
        _log(`applyManualResize) ${app.get_wm_class()} moved a shared edge, reflowing neighbours`);
        scheduleRetile(0);
    } else if (stuck) {
        _log(`applyManualResize) ${app.get_wm_class()} resized against the screen edge, floating it`);
        app.wintileFloat = true;
        delete app.wintileSlot;
    }
}

/**
 * Move the boundary between two slices, taking space from one and giving it to
 * the other so their combined size is unchanged.
 *
 * @param {Array} weights - weights to rewrite in place
 * @param {number} index - the boundary between `index` and `index + 1`
 * @param {number} deltaPx - how far it moved; right and down are positive
 * @param {number} contentPx - pixels these weights are spread across
 * @returns {boolean} true when the weights actually changed
 */
function shiftBoundary(weights, index, deltaPx, contentPx) {
    if (contentPx <= 0)
        return false;

    const total = weights.reduce((a, b) => a + b, 0);
    const floor = total * MIN_SLICE;
    const before = weights[index];
    const after = weights[index + 1];
    // Clamped so the drag stops where a neighbour would otherwise collapse.
    const delta = Math.max(floor - before,
        Math.min(deltaPx / contentPx * total, after - floor));
    if (Math.abs(delta) < total * 1e-4)
        return false;

    weights[index] = before + delta;
    weights[index + 1] = after - delta;
    return true;
}

/**
 * Stop reacting to window changes. Windows are left exactly where they are.
 */
function autoTileDisconnect() {
    for (const [obj, id] of autoTileSignals)
        obj.disconnect(id);
    autoTileSignals = [];
    stopSwapDrag();
    if (verifyTimer) {
        GLib.source_remove(verifyTimer);
        verifyTimer = null;
    }
    layoutState.clear();
    arrangement.clear();
    if (autoTileTimer) {
        GLib.source_remove(autoTileTimer);
        autoTileTimer = null;
    }
}

/**
 * Flip auto-tiling. Writing the setting is what drives updateSettings(), which
 * connects or disconnects the signals.
 */
function toggleAutoTile() {
    const on = !gsettings.get_boolean('auto-tile');
    gsettings.set_boolean('auto-tile', on);
    Main.notify('WinTile', on ? 'Auto-tiling on' : 'Auto-tiling off \u2014 manual mode');
}

/**
 *
 */
function enable() {
    _log('enable) Keymanager is being defined');
    keyManager = new KeyBindings.Manager();
    let desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
    let mutterKeybindingSettings = new Gio.Settings({schema_id: 'org.gnome.mutter.keybindings'});
    let mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    try {
        let shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell.overrides'});
        shellSettings.set_boolean('edge-tiling', false);
    } catch (error) {
        _log('enable) org.gnome.shell.overrides does not exist');
    }
    oldbindings['unmaximize'] = desktopSettings.get_strv('unmaximize');
    oldbindings['maximize'] = desktopSettings.get_strv('maximize');
    oldbindings['toggle_tiled_left'] = mutterKeybindingSettings.get_strv('toggle-tiled-left');
    oldbindings['toggle_tiled_right'] = mutterKeybindingSettings.get_strv('toggle-tiled-right');
    changeBinding(desktopSettings, 'unmaximize', '<Super>Down', '<Control><Shift><Super>Down');
    changeBinding(desktopSettings, 'maximize', '<Super>Up', '<Control><Shift><Super>Up');
    changeBinding(mutterKeybindingSettings, 'toggle-tiled-left', '<Super>Left', '<Control><Shift><Super>Left');
    changeBinding(mutterKeybindingSettings, 'toggle-tiled-right', '<Super>Right', '<Control><Shift><Super>Right');
    mutterSettings.set_boolean('edge-tiling', false);
    keyManagerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
        keyManager.add('<Super><Control>left', () => {
            requestMove('left', true);
        });
        keyManager.add('<Super><Control>right', () => {
            requestMove('right', true);
        });
        keyManager.add('<Super><Control>up', () => {
            requestMove('up', true);
        });
        keyManager.add('<Super><Control>down', () => {
            requestMove('down', true);
        });
        keyManager.add('<Super>left', () => {
            requestMove('left');
        });
        keyManager.add('<Super>right', () => {
            requestMove('right');
        });
        keyManager.add('<Super>up', () => {
            requestMove('up');
        });
        keyManager.add('<Super>down', () => {
            requestMove('down');
        });
        keyManager.add('<Super><Shift>t', () => {
            toggleAutoTile();
        });
    });

    // Since GNOME 40 the metaDisplay argument isn't passed anymore to these callbacks.
    // We "translate" the parameters here so that things work on both GNOME 3 and 40.
    onWindowGrabBegin = global.display.connect('grab-op-begin', (metaDisplay, metaScreen, metaWindow, metaGrabOp, _gpointer) => {
        if (SHELL_VERSION >= 40)
            windowGrabBegin(metaScreen, metaWindow);
        else
            windowGrabBegin(metaWindow, metaGrabOp);
    });
    onWindowGrabEnd = global.display.connect('grab-op-end', (metaDisplay, metaScreen, metaWindow, metaGrabOp, _gpointer) => {
        if (SHELL_VERSION >= 40)
            windowGrabEnd(metaScreen, metaWindow);
        else
            windowGrabEnd(metaWindow, metaGrabOp);
    });

    // Create a new gsettings object
    preview = new St.BoxLayout({
        style_class: 'tile-preview',
        visible: false,
    });
    Main.uiGroup.add_actor(preview);

    gsettings = ExtensionUtils.getSettings();
    updateSettings();

    // Watch the gsettings for changes
    gsettings.connect('changed', updateSettings.bind());
}

/**
 *
 */
function disable() {
    _log('disable) Keymanager is being removed');
    autoTileDisconnect();
    keyManager.removeAll();
    keyManager.destroy();
    keyManager = null;
    let desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
    let mutterKeybindingSettings = new Gio.Settings({schema_id: 'org.gnome.mutter.keybindings'});
    let mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    try {
        let shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell.overrides'});
        shellSettings.reset('edge-tiling');
    } catch (error) {
        _log('disable) org.gnome.shell.overrides does not exist');
    }
    desktopSettings.reset('unmaximize');
    desktopSettings.reset('maximize');
    desktopSettings = null;
    mutterKeybindingSettings.reset('toggle-tiled-left');
    mutterKeybindingSettings.reset('toggle-tiled-right');
    mutterKeybindingSettings = null;
    mutterSettings.reset('edge-tiling');
    mutterSettings = null;
    global.display.disconnect(onWindowGrabBegin);
    global.display.disconnect(onWindowGrabEnd);
    onWindowGrabBegin = null;
    onWindowGrabEnd = null;
    GLib.source_remove(requestMoveTimer);
    GLib.source_remove(checkForMoveTimer);
    GLib.source_remove(windowGrabBeginTimer);
    GLib.source_remove(windowGrabEndTimer);
    GLib.source_remove(checkIfNearGridTimer);
    GLib.source_remove(keyManagerTimer);
    gsettings = null;
    preview = null;
    dragStart = null;
}
