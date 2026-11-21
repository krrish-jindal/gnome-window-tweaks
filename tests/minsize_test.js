// Minimum-size awareness: windows that cannot shrink to their tile must not overlap their neighbours.
// Runs the REAL retileAll / verifyTiles / autoTileStructure from extension.js against fake windows whose
// move_resize_frame is clamped to a minimum size, the way mutter clamps real windows.
//   node tests/minsize_test.js <extension.js>
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const names = ['splitSpan', 'splitSpanWeighted', 'autoTileStructure', 'preferredRowCounts', 'structureViolation', 'autoTileGap',
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
console.log('1. how windows are split into lanes, with and without known minimum sizes');
{
    const env = makeEnv([]);
    const land = monInfo(0, 0, 1920, 1080), port = monInfo(0, 0, 1080, 1920);
    const split = (m, n, mins) => env.autoTileStructure(m, n, mins).rowCounts.join(',');
    const none = n => Array(n).fill(undefined);

    // landscape is unchanged: spread over at most 2 columns
    ok(split(land, 2) === '1,1' && split(land, 3) === '2,1' && split(land, 5) === '3,2', 'landscape with no minimums: columns as before');
    // portrait: up to 3 stack, then two to a row
    const wantPortrait = {1: '1', 2: '1,1', 3: '1,1,1', 4: '2,2', 5: '2,2,1', 6: '2,2,2', 7: '2,2,2,1', 8: '2,2,2,2'};
    for (const n of Object.keys(wantPortrait))
        ok(split(port, +n) === wantPortrait[n], `portrait n=${n}: want ${wantPortrait[n]}, got ${split(port, +n)}`);
    ok(split(port, 4, none(4)) === '2,2', 'all-unknown minimums change nothing');

    // landscape, two windows that need 1200px: two 951px columns cannot hold them -> stack instead
    ok(split(land, 2, [{w: 1200, h: 0}, {w: 1200, h: 0}]) === '2', 'landscape: 1200px-wide windows should stack, not sit in 951px columns');
    ok(split(land, 2, [{w: 600, h: 300}, {w: 600, h: 300}]) === '1,1', 'landscape: minimums that fit keep two columns');
    // portrait: Brave-like windows (578 wide) fit a full-width stack of 3
    ok(split(port, 3, [{w: 578, h: 110}, {w: 578, h: 110}, {w: 373, h: 100}]) === '1,1,1', 'portrait: 578px-wide minimums fit a full-width stack');

    // THE REPORTED CASE: 4 windows in portrait. Normal windows pair up as a 2x2 grid ...
    ok(split(port, 4, Array(4).fill({w: 373, h: 100})) === '2,2', 'portrait n=4 with narrow-enough windows: 2x2 grid');
    // ... but two 578px-wide windows (Brave) cannot share a 1080px row (2x531 < 2x578): give them a row each,
    // and let the two narrow windows still pair up.
    const wide = {w: 578, h: 110}, narrow = {w: 373, h: 100};
    ok(split(port, 4, [wide, wide, narrow, narrow]) === '1,1,2', `portrait n=4, two wide + two narrow: want 1,1,2, got ${split(port, 4, [wide, wide, narrow, narrow])}`);
    ok(split(port, 4, [wide, narrow, wide, narrow]) === '1,1,1,1' || env.structureViolation(port, env.autoTileStructure(port, 4, [wide, narrow, wide, narrow]), [wide, narrow, wide, narrow]) === 0,
        'portrait n=4 interleaved wide/narrow: must still be a zero-overlap layout');
    // all four wide: nothing can pair up, so a full stack is the only fit
    ok(split(port, 4, Array(4).fill(wide)) === '1,1,1,1', 'portrait n=4, all wide: full stack');
    // every chosen layout really has zero shortfall when one exists
    for (const mins of [[wide, wide, narrow, narrow], [narrow, wide, wide, narrow], [wide, narrow, narrow, wide], Array(4).fill(wide)]) {
        const st = env.autoTileStructure(port, 4, mins);
        ok(env.structureViolation(port, st, mins) === 0, `portrait n=4 ${JSON.stringify(mins.map(m => m.w))}: layout [${st.rowCounts}] should fit with zero shortfall`);
    }
    // tall minimums that two rows cannot hold (2 x 951px) -> fewer, taller lanes
    ok(split(port, 4, Array(4).fill({w: 0, h: 1000})) === '4', 'portrait: 4 windows each needing 1000px of height leave a single lane');

    // impossible: least-bad, deterministic, never throws
    const bad = env.autoTileStructure(land, 3, Array(3).fill({w: 5000, h: 5000}));
    ok(bad.rowCounts.length >= 1 && bad.rowCounts.reduce((a, b) => a + b, 0) === 3, 'impossible minimums still give a valid structure');
    // more than 10 windows falls back to even splits rather than enumerating thousands
    const many = env.autoTileStructure(port, 14, Array(14).fill({w: 300, h: 100}));
    ok(many.rowCounts.reduce((a, b) => a + b, 0) === 14, 'a 14-window layout is still valid');
    console.log('  landscape keeps columns; portrait stacks to 3 then pairs; wide windows get their own row while the rest pair up');
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

// ---- 3b. the reported case: FOUR windows in portrait, two of them Brave-like ----
console.log('3b. portrait 1080x1920, four windows, two with a 578px minimum width');
{
    const env = makeEnv([monInfo(1920, 0, 1080, 1920)]);
    const Y1 = win(env, 'brave', {w: 578, h: 110}), Y2 = win(env, 'brave', {w: 578, h: 110});
    const T = win(env, 'term', {w: 373, h: 100}), O = win(env, 'other', {w: 300, h: 100});
    env.retileAll();
    ok(env.autoTileStructure(monInfo(1920, 0, 1080, 1920), 4).rowCounts.join() === '2,2', 'precondition: the unaware layout is the 2x2 grid');
    ok(overlaps(Y1, Y2), 'precondition: in that grid the two 578px windows collide in a 531px tile');
    env.verifyTiles();
    ok(Y1.wintileMin && Y2.wintileMin && !T.wintileMin && !O.wintileMin,
        `only the two wide windows should learn a minimum: ${JSON.stringify([Y1.wintileMin, Y2.wintileMin, T.wintileMin, O.wintileMin])}`);
    ok(env.retileScheduled === 1, 'exactly one relayout should be requested');
    env.retileAll();
    ok(!anyOverlap([Y1, Y2, T, O]), 'after the relayout nothing overlaps');
    ok(Y1.rect.width === 1080 - 2 * G && Y2.rect.width === 1080 - 2 * G && Y1.rect.y < Y2.rect.y, 'the wide windows get a full-width row each');
    ok(T.rect.y === O.rect.y && T.rect.x < O.rect.x && T.rect.y > Y2.rect.y, 'the two narrow windows still sit side by side, below them');
    env.retileScheduled = 0; env.verifyTiles();
    ok(env.retileScheduled === 0, 'and the layout is stable');
    console.log('  2x2 first, the two wide windows are learned, then: row, row, and a side-by-side pair');

    // four ordinary windows: a real 2x2 grid, nothing to learn
    const env2 = makeEnv([monInfo(1920, 0, 1080, 1920)]);
    const ws = [1, 2, 3, 4].map(i => win(env2, 'app' + i, {w: 373, h: 100}));
    env2.retileAll(); env2.verifyTiles();
    ok(!anyOverlap(ws) && env2.retileScheduled === 0, 'four ordinary windows: no overlap, nothing to relearn');
    ok(ws[0].rect.y === ws[1].rect.y && ws[2].rect.y === ws[3].rect.y && ws[0].rect.x < ws[1].rect.x && ws[0].rect.y < ws[2].rect.y,
        'four ordinary windows form a 2x2 grid (left/right, then left/right)');
    console.log('  four ordinary windows: a 2x2 grid, left/right then left/right');
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
