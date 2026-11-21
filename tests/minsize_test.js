// Minimum-size awareness: windows that cannot shrink to their tile must not overlap their neighbours.
// Runs the REAL retileAll / verifyTiles / autoTileStructure from extension.js against fake windows whose
// move_resize_frame is clamped to a minimum size, the way mutter clamps real windows.
//   node tests/minsize_test.js <extension.js>
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const names = ['splitSpan', 'splitSpanWeighted', 'autoTileStructure', 'structureViolation', 'autoTileGap',
    'evenLayoutState', 'autoTileRects', 'isTileCandidate', 'isBlacklisted', 'retileAll', 'autoTileKey',
    'scheduleVerify', 'verifyTiles'];
let code = '';
for (const n of names) {
    const m = new RegExp(`^function ${n}\\(`, 'm').exec(src);
    if (!m) throw new Error(`function ${n} not found`);
    code += src.slice(m.index, src.indexOf('\n}\n', m.index) + 3) + '\n';
}

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL:', msg); } return c; };
const G = 6;

function monInfo(x, y, width, height) {
    return {monitorIndex: 0, x, y, width, height, isPortrait: width < height, colCount: 2, rowCount: 2};
}
function makeEnv(monitors) {
    const env = {
        wins: [], monitors, retileScheduled: 0, grabOp: 0,
        config: {gap: G, autoTile: true, autoTileBlacklist: []},
        Meta: {WindowType: {NORMAL: 0}, GrabOp: {NONE: 0}},
        _log() {},
        GLib: {SOURCE_REMOVE: false, SOURCE_CONTINUE: true, timeout_add: () => 7, source_remove() {}},
        getMonitorInfo: i => env.monitors[i],
        unMaximizeIfMaximized() {},
        scheduleRetile() { env.retileScheduled++; },
        // mutter clamps the frame to the application's minimum size
        moveAppCoordinates(app, x, y, w, h) {
            const min = app.hardMin || {w: 0, h: 0};
            app.rect = {x, y, width: Math.max(w, min.w), height: Math.max(h, min.h)};
        },
    };
    env.global = {
        workspace_manager: {get_active_workspace_index: () => 0},
        display: {get_grab_op: () => env.grabOp},
    };
    env.workspace = {list_windows: () => env.wins};
    env.getActiveWorkspace = () => env.workspace;
    vm.createContext(env);
    vm.runInContext('let windowMoving = false, autoTiling = false, verifyTimer = null; ' +
        'const layoutState = new Map();', env);
    vm.runInContext(code, env);
    return env;
}
let seq = 0;
function win(env, cls, hardMin, monitor = 0) {
    const w = {
        id: ++seq, cls, monitor, hardMin, rect: {x: 0, y: 0, width: 100, height: 100}, minimized: false,
        resizeable: true, window_type: 0, maximized_horizontally: false, maximized_vertically: false,
        get_stable_sequence() { return this.id; }, get_wm_class() { return this.cls; }, get_title() { return this.cls; },
        get_monitor() { return this.monitor; }, get_frame_rect() { return this.rect; },
        is_skip_taskbar: () => false, is_fullscreen: () => false, is_above: () => false,
    };
    env.wins.push(w);
    return w;
}
const overlaps = (a, b) => a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width &&
    a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height;
const anyOverlap = ws => ws.some((a, i) => ws.slice(i + 1).some(b => overlaps(a, b)));
const run = (env, s) => vm.runInContext(s, env);

// ---- 1. structure choice ----
console.log('1. lane count follows minimum sizes');
{
    const env = makeEnv([]);
    const land = monInfo(0, 0, 1920, 1080), port = monInfo(0, 0, 1080, 1920);
    const lanes = (m, n, mins) => env.autoTileStructure(m, n, mins).columns;

    ok(lanes(land, 2) === 2 && lanes(land, 3) === 2 && lanes(land, 5) === 2, 'landscape with no minimums: 2 columns as before');
    ok(lanes(port, 2) === 2 && lanes(port, 3) === 3 && lanes(port, 5) === 5, 'portrait with no minimums: every window its own row');
    ok(lanes(land, 4, [undefined, undefined, undefined, undefined]) === 2, 'all-unknown minimums change nothing');

    // landscape, two windows that need 1200px: two 951px columns cannot hold them -> stack instead
    ok(lanes(land, 2, [{w: 1200, h: 0}, {w: 1200, h: 0}]) === 1, 'landscape: 1200px-wide windows should stack, not sit in 951px columns');
    // minimums that already fit leave the preferred layout alone
    ok(lanes(land, 2, [{w: 600, h: 300}, {w: 600, h: 300}]) === 2, 'landscape: minimums that fit keep two columns');
    // portrait Brave-like windows (wide minimum, short) fit full width
    ok(lanes(port, 3, [{w: 578, h: 110}, {w: 578, h: 110}, {w: 373, h: 100}]) === 3, 'portrait: 578px-wide minimums fit a full-width stack');
    // portrait: tall minimums cannot all stack -> fewer rows
    ok(lanes(port, 4, Array(4).fill({w: 0, h: 600})) === 3, 'portrait: 4 windows needing 600px height fall back to 3 rows');
    // impossible: choose the least-bad, deterministic, never throw
    const bad = env.autoTileStructure(land, 3, Array(3).fill({w: 5000, h: 5000}));
    ok(bad.columns >= 1 && bad.columns <= 3 && bad.rowCounts.reduce((a, b) => a + b, 0) === 3, 'impossible minimums still give a valid structure');
    console.log('  landscape keeps columns, portrait stacks, and minimums that do not fit change the lane count');
}

// ---- 2. the full cycle: place -> window clamps -> learn -> relayout -> no overlap ----
console.log('2. place, learn the minimum, relayout (landscape 1920x1080, two windows that cannot go below 1200px wide)');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const A = win(env, 'A', {w: 1200, h: 200}), B = win(env, 'B', {w: 1200, h: 200});
    env.retileAll();
    ok(overlaps(A, B), 'precondition: the first (unaware) layout should overlap');
    env.verifyTiles();
    ok(A.wintileMin && A.wintileMin.w === 1200 && B.wintileMin && B.wintileMin.w === 1200, `minimums not learned: ${JSON.stringify(A.wintileMin)}`);
    ok(env.retileScheduled === 1, 'learning a minimum should request exactly one relayout');
    env.retileAll();
    ok(!overlaps(A, B), 'after the relayout the windows should not overlap');
    ok(A.rect.width >= 1200 && B.rect.width >= 1200 && A.rect.y < B.rect.y, 'they should be stacked top/bottom at full width');
    // settled: another verify finds nothing new
    env.retileScheduled = 0; env.verifyTiles();
    ok(env.retileScheduled === 0, 'a settled layout must not ask for further relayouts (no loop)');
    console.log('  first layout overlaps, the minimum is learned once, the relayout stacks them, then it is stable');
}

// ---- 3. the case from the screenshot: portrait, two Brave windows + a terminal ----
console.log('3. portrait 1080x1920: two windows with a 578px minimum width + one terminal');
{
    const env = makeEnv([monInfo(1920, 0, 1080, 1920)]);
    const Y1 = win(env, 'brave', {w: 578, h: 110}, 0), Y2 = win(env, 'brave', {w: 578, h: 110}, 0), T = win(env, 'term', {w: 373, h: 100}, 0);
    env.retileAll(); env.verifyTiles();
    ok(!anyOverlap([Y1, Y2, T]), 'portrait stack should not overlap');
    ok(env.retileScheduled === 0, 'nothing to learn: the stack already fits');
    ok([Y1, Y2, T].every(w => w.rect.width === 1080 - 2 * G), 'every window should be full width');
    console.log('  stacked at full width, no overlap, nothing to relearn');
}

// ---- 4. when NOT to learn ----
console.log('4. things that must not be mistaken for a minimum size');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const A = win(env, 'A'), B = win(env, 'B');
    env.retileAll();
    const check = (label, setup, undo) => {
        setup(); env.retileScheduled = 0; env.verifyTiles();
        ok(!A.wintileMin && env.retileScheduled === 0, `${label}: learned a bogus minimum`);
        undo(); delete A.wintileMin;
    };
    const big = {x: 0, y: 0, width: 1900, height: 1000};
    const keep = A.rect;
    check('maximized window', () => { A.rect = big; A.maximized_horizontally = A.maximized_vertically = true; }, () => { A.rect = keep; A.maximized_horizontally = A.maximized_vertically = false; });
    check('floating window', () => { A.rect = big; A.wintileFloat = true; }, () => { A.rect = keep; delete A.wintileFloat; });
    check('minimized window', () => { A.rect = big; A.minimized = true; }, () => { A.rect = keep; A.minimized = false; });
    check('mid-drag (a grab is active)', () => { A.rect = big; env.grabOp = 5; }, () => { A.rect = keep; env.grabOp = 0; });
    check('fullscreen window', () => { A.rect = big; A.is_fullscreen = () => true; }, () => { A.rect = keep; A.is_fullscreen = () => false; });
    check('always-on-top window', () => { A.rect = big; A.is_above = () => true; }, () => { A.rect = keep; A.is_above = () => false; });
    check('window bigger than the whole monitor', () => { A.rect = {x: 0, y: 0, width: 5000, height: 4000}; }, () => { A.rect = keep; });
    check('window exactly its tile (+1px rounding)', () => { A.rect = {...keep, width: keep.width + 1}; }, () => { A.rect = keep; });
    // a hand-resize turned off auto-tile: nothing is verified at all
    env.config.autoTile = false; A.rect = big; env.verifyTiles();
    ok(!A.wintileMin, 'verifyTiles must do nothing when auto-tile is off');
    console.log('  maximized, floating, minimized, mid-drag, fullscreen, always-on-top, oversized, 1px rounding, auto-tile off: all ignored');
}

// ---- 5. minimums only grow and a window that keeps clamping cannot cause a relayout storm ----
console.log('5. relayout storm guard');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const A = win(env, 'A', {w: 1200, h: 100}), B = win(env, 'B', {w: 1200, h: 100});
    let rounds = 0;
    for (; rounds < 10; rounds++) {
        env.retileScheduled = 0;
        env.retileAll(); env.verifyTiles();
        if (env.retileScheduled === 0) break;
    }
    ok(rounds <= 2, `layout should settle within 2 rounds, took ${rounds + 1}`);
    const before = JSON.stringify([A.wintileMin, B.wintileMin]);
    env.retileAll(); env.verifyTiles(); env.retileAll(); env.verifyTiles();
    ok(JSON.stringify([A.wintileMin, B.wintileMin]) === before, 'minimums changed after the layout had settled');
    console.log('  settled after %d round(s); minimums stable afterwards', rounds + 1);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
