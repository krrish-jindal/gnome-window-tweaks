// Drag to arrange: runs the REAL retileAll / drop-zone / arrangement functions from extension.js
// against fake windows and a fake pointer.
//   node tests/arrange_test.js <extension.js>
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const names = ['splitSpan', 'splitSpanWeighted', 'autoTileStructure', 'preferredRowCounts', 'structureViolation',
    'fitWeights', 'minsKeyOf', 'autoTileGap', 'evenLayoutState', 'autoTileRects', 'isTileCandidate', 'isBlacklisted',
    'retileAll', 'autoTileKey', 'layoutKey', 'tileCandidates', 'reconcileRows', 'currentRows', 'rowsFeasible',
    'dropZone', 'zoneRect', 'proposeDrop', 'applyRows', 'findSwapTarget', 'swapDragMoved', 'stopSwapDrag',
    'updateSwapHighlight', 'beginSwapDrag', 'endSwapDrag', 'scheduleVerify', 'verifyTiles'];
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
        pointer: [0, 0], wins: [], monitors, notices: [], retileScheduled: 0, grabOp: 0,
        config: {gap: G, autoTile: true, autoTileBlacklist: []},
        Meta: {WindowType: {NORMAL: 0}, GrabOp: {NONE: 0}},
        _log() {},
        GLib: {SOURCE_REMOVE: false, SOURCE_CONTINUE: true, timeout_add: () => 7, source_remove() {}},
        St: {Widget: class {
            constructor(o) { Object.assign(this, o); }
            set_position(x, y) { this.px = x; this.py = y; } set_size(w, h) { this.pw = w; this.ph = h; }
            set_style(s) { this.style = s; }
            show() { this.visible = true; } hide() { this.visible = false; } destroy() { this.destroyed = true; } }},
        Main: {uiGroup: {add_actor() {}}, notify(title, msg) { env.notices.push(msg); }},
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
        get_pointer: () => [env.pointer[0], env.pointer[1], 0],
        get_window_actors: () => env.wins.map(w => ({meta_window: w, visible: true})),
        workspace_manager: {get_active_workspace_index: () => 0},
        display: {get_grab_op: () => env.grabOp},
    };
    env.workspace = {list_windows: () => env.wins};
    env.getActiveWorkspace = () => env.workspace;
    vm.createContext(env);
    vm.runInContext('let windowMoving = false, autoTiling = false, swapDrag = null, swapDragTimer = null, ' +
        'swapHighlight = null, verifyTimer = null; const layoutState = new Map(); const arrangement = new Map(); ' +
        "const SWAP_STYLE_OK = 'ok', SWAP_STYLE_NO = 'no';", env);
    vm.runInContext(code, env);
    return env;
}
let seq = 0;
function win(env, cls, hardMin, monitor = 0) {
    const w = {
        id: ++seq, cls, monitor, hardMin, rect: {x: 0, y: 0, width: 100, height: 100}, minimized: false, resizeable: true,
        window_type: 0, maximized_horizontally: false, maximized_vertically: false,
        get_stable_sequence() { return this.id; }, get_wm_class() { return this.cls; }, get_title() { return this.cls; },
        get_monitor() { return this.monitor; }, get_frame_rect() { return this.rect; },
        is_skip_taskbar: () => false, is_fullscreen: () => false, is_above: () => false,
        located_on_workspace: () => true,
    };
    env.wins.push(w);
    return w;
}
const center = r => [r.x + r.width / 2, r.y + r.height / 2];
const at = (w, fx, fy) => [w.rect.x + w.rect.width * fx, w.rect.y + w.rect.height * fy];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const R = w => ({...w.rect});
const run = (env, s) => vm.runInContext(s, env);
const overlaps = (a, b) => a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width &&
    a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height;
const anyOverlap = ws => ws.some((a, i) => ws.slice(i + 1).some(b => overlaps(a, b)));
const rowsOf = env => { const a = run(env, 'arrangement.get("0:0")'); return a ? a.rows : null; };

// Drag `app` so it ends up centred on `pt`: begin -> move.
function dragTo(env, app, pt) {
    run(env, 'swapDrag = null');
    env.beginSwapDrag(app);
    const [cx, cy] = center(app.rect);
    app.rect = {...app.rect, x: app.rect.x + (pt[0] - cx), y: app.rect.y + (pt[1] - cy)};
    env.pointer = pt;
}
// Drop `app` on `target` at a fraction (fx,fy) of the target's tile; returns whether the arrangement changed.
function drop(env, app, target, fx, fy) {
    dragTo(env, app, at(target, fx, fy));
    const changed = env.endSwapDrag(app);
    env.retileAll();
    return changed;
}

// ===== D. drop zones =====
console.log('D. which part of the tile you drop on');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const T = win(env, 'T'); T.rect = {x: 100, y: 100, width: 400, height: 300};
    const z = (fx, fy) => { env.pointer = [100 + 400 * fx, 100 + 300 * fy]; return env.dropZone(T); };
    ok(z(0.5, 0.5) === 'swap' && z(0.3, 0.3) === 'swap' && z(0.7, 0.7) === 'swap', 'the middle swaps');
    ok(z(0.1, 0.5) === 'left' && z(0.9, 0.5) === 'right' && z(0.5, 0.1) === 'top' && z(0.5, 0.9) === 'bottom', 'the four edges');
    ok(z(0.2, 0.5) === 'left' && z(0.8, 0.5) === 'right', 'a quarter in from a side is still that side');
    env.pointer = [100 - 4, 250]; ok(env.dropZone(T) === 'left', 'the gap just outside the left edge counts as left');
    env.pointer = [500 + 4, 250]; ok(env.dropZone(T) === 'right', 'the gap just outside the right edge counts as right');
    const r = T.rect, zr = env.zoneRect;
    ok(same(zr(r, 'left'), {x: 100, y: 100, w: 200, h: 300}) && same(zr(r, 'right'), {x: 300, y: 100, w: 200, h: 300}) &&
       same(zr(r, 'top'), {x: 100, y: 100, w: 400, h: 150}) && same(zr(r, 'bottom'), {x: 100, y: 250, w: 400, h: 150}) &&
       same(zr(r, 'swap'), {x: 100, y: 100, w: 400, h: 300}), 'the outline covers the half of the tile the drop would take');
    console.log('  middle swaps; edges are beside / above / below; the gap resolves to the nearest edge');
}

// ===== E. swap in the middle (landscape) =====
console.log('E. middle drop swaps, landscape 1920x1080, 3 windows');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const A = win(env, 'A'), B = win(env, 'B'), C = win(env, 'C');
    env.retileAll();
    const a0 = R(A), b0 = R(B), c0 = R(C);
    ok(a0.x === b0.x && a0.y < b0.y && c0.x > a0.x, 'initial layout: A over B on the left, C on the right');
    const st = run(env, "layoutState.get('0:0')");
    st.colWeights[0] = 3;                       // a hand-resized weight: a swap must keep it
    const wBefore = JSON.stringify(st.colWeights);
    env.retileAll();
    const a1 = R(A), c1 = R(C);

    dragTo(env, A, center(C.rect));
    ok(run(env, 'swapHighlight') !== null, 'highlight created at drag start');
    env.updateSwapHighlight();
    const hl = run(env, 'swapHighlight');
    ok(hl.visible === true && hl.px === c1.x && hl.py === c1.y && hl.pw === c1.width && hl.ph === c1.height && hl.style === 'ok',
        `highlight should cover C in the OK colour, got ${hl.px},${hl.py} ${hl.pw}x${hl.ph} ${hl.style}`);
    ok(env.endSwapDrag(A) === true, 'a swap should be reported');
    ok(run(env, 'swapHighlight') === null && run(env, 'swapDrag') === null && hl.destroyed === true, 'drag state cleaned up');
    ok(A.wintileOrder === C.id && C.wintileOrder === A.id, `keys traded: A=${A.wintileOrder} C=${C.wintileOrder}`);
    env.retileAll();
    ok(same(R(A), c1) && same(R(C), a1), 'A and C traded slots');
    ok(JSON.stringify(run(env, "layoutState.get('0:0')").colWeights) === wBefore, 'hand-resized weights kept through the swap');

    ok(drop(env, A, C, 0.5, 0.5) === true && same(R(A), a1) && same(R(C), c1), 'swapping back restores the layout');
    const D = win(env, 'D');
    env.retileAll();
    ok(D.rect.width > 0 && !anyOverlap([A, B, C, D]), 'a window that opens later is placed without overlap');
    console.log('  swapped, weights kept, swapped back; a new window fits in');
}

// ===== Z1. portrait zones =====
console.log('Z1. portrait 1080x1920: beside / above');
{
    const env = makeEnv([monInfo(1920, 0, 1080, 1920)]);
    const A = win(env, 'A'), B = win(env, 'B'), C = win(env, 'C');
    env.retileAll();
    ok(A.rect.y < B.rect.y && B.rect.y < C.rect.y && A.rect.width === 1068, 'start: three full-width rows');

    // A onto B's RIGHT edge -> A sits beside B, in B's row
    ok(drop(env, A, B, 0.9, 0.5) === true, 'right-edge drop is accepted');
    ok(same(rowsOf(env), [[B.id, A.id], [C.id]]), `rows should be [[B,A],[C]], got ${JSON.stringify(rowsOf(env))}`);
    ok(B.rect.y === A.rect.y && B.rect.x < A.rect.x && C.rect.y > B.rect.y && C.rect.width === 1068 && !anyOverlap([A, B, C]),
        'B | A side by side on top, C full width below');

    // C onto B's TOP edge -> C gets a row of its own above B's row
    ok(drop(env, C, B, 0.5, 0.1) === true, 'top-edge drop is accepted');
    ok(same(rowsOf(env), [[C.id], [B.id, A.id]]), `rows should be [[C],[B,A]], got ${JSON.stringify(rowsOf(env))}`);
    ok(C.rect.y < B.rect.y && C.rect.width === 1068 && B.rect.y === A.rect.y && !anyOverlap([A, B, C]), 'C on its own row above the pair');

    // A onto C's BOTTOM edge -> A leaves the pair and takes a row below C
    ok(drop(env, A, C, 0.5, 0.9) === true, 'bottom-edge drop is accepted');
    ok(same(rowsOf(env), [[C.id], [A.id], [B.id]]), `rows should be [[C],[A],[B]], got ${JSON.stringify(rowsOf(env))}`);
    ok(C.rect.y < A.rect.y && A.rect.y < B.rect.y && A.rect.width === 1068 && !anyOverlap([A, B, C]), 'three full-width rows again, in the new order');

    // B onto C's LEFT edge -> B sits beside C, on C's left
    ok(drop(env, B, C, 0.1, 0.5) === true, 'left-edge drop is accepted');
    ok(same(rowsOf(env), [[B.id, C.id], [A.id]]), `rows should be [[B,C],[A]], got ${JSON.stringify(rowsOf(env))}`);
    ok(B.rect.y === C.rect.y && B.rect.x < C.rect.x, 'B on the left of C');

    // dropping where it already is changes nothing
    ok(drop(env, B, C, 0.1, 0.5) === false, 'dropping B onto the left of C again is a no-op');
    console.log('  beside (right/left), above (top), below (bottom): each lands where dropped');
}

// ===== Z2. landscape zones =====
console.log('Z2. landscape 1920x1080: above/below stack in a column, left/right make a column');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const A = win(env, 'A'), B = win(env, 'B'), C = win(env, 'C'), D = win(env, 'D');
    env.retileAll();
    ok(same(run(env, "layoutState.get('0:0')").rowCounts, [2, 2]), 'start: two columns of two');

    // B onto C's LEFT edge -> a new column between them
    ok(drop(env, B, C, 0.1, 0.5) === true, 'left-edge drop accepted');
    ok(same(rowsOf(env), [[A.id], [B.id], [C.id, D.id]]), `columns should be [[A],[B],[C,D]], got ${JSON.stringify(rowsOf(env))}`);
    ok(A.rect.x < B.rect.x && B.rect.x < C.rect.x && A.rect.height === 1080 - 2 * G && C.rect.x === D.rect.x && C.rect.y < D.rect.y && !anyOverlap([A, B, C, D]),
        'three columns: A, B, then C over D');

    // A onto D's TOP edge -> A joins D's column, above D
    ok(drop(env, A, D, 0.5, 0.1) === true, 'top-edge drop accepted');
    ok(same(rowsOf(env), [[B.id], [C.id, A.id, D.id]]), `columns should be [[B],[C,A,D]], got ${JSON.stringify(rowsOf(env))}`);
    ok(C.rect.x === A.rect.x && A.rect.x === D.rect.x && C.rect.y < A.rect.y && A.rect.y < D.rect.y && !anyOverlap([A, B, C, D]), 'C, A, D stacked in one column');

    // C onto B's RIGHT edge -> a column of its own right of B
    ok(drop(env, C, B, 0.9, 0.5) === true, 'right-edge drop accepted');
    ok(same(rowsOf(env), [[B.id], [C.id], [A.id, D.id]]), `columns should be [[B],[C],[A,D]], got ${JSON.stringify(rowsOf(env))}`);
    console.log('  top/bottom join the column, left/right start a column');
}

// ===== F. drops that must NOT arrange anything =====
console.log('F. drops that change nothing');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080), monInfo(1920, 0, 1920, 1080)]);
    const A = win(env, 'A'), B = win(env, 'B'), C = win(env, 'C');
    const X = win(env, 'X', undefined, 1);
    env.retileAll();
    const before = JSON.stringify([A, B, C, X].map(w => w.wintileOrder));

    run(env, 'swapDrag = null'); env.beginSwapDrag(A); env.pointer = center(B.rect);
    ok(env.endSwapDrag(A) === false, 'a click without movement does nothing');
    dragTo(env, A, [5000, 5000]);
    ok(env.endSwapDrag(A) === false, 'drop on empty desktop does nothing');
    const dlg = win(env, 'dlg'); dlg.window_type = 1; dlg.rect = {...B.rect};
    dragTo(env, A, center(B.rect));
    ok(env.endSwapDrag(A) === false, 'drop on a dialog covering B does nothing');
    env.wins.splice(env.wins.indexOf(dlg), 1);
    B.wintileFloat = true;
    dragTo(env, A, center(B.rect));
    ok(env.endSwapDrag(A) === false, 'drop on a floating window does nothing');
    delete B.wintileFloat;
    dragTo(env, A, center(X.rect)); A.monitor = 1;
    ok(env.endSwapDrag(A) === false, 'a drop on another monitor does nothing');
    A.monitor = 0;
    A.wintileFloat = true;
    run(env, 'swapDrag = null'); env.beginSwapDrag(A);
    ok(run(env, 'swapDrag') === null && run(env, 'swapHighlight') === null, 'a floating window starts no drag');
    delete A.wintileFloat;
    ok(JSON.stringify([A, B, C, X].map(w => w.wintileOrder)) === before && run(env, 'arrangement.size') === 0, 'nothing was arranged by any of those');
    console.log('  click, empty desktop, covering dialog, floating target, other monitor, floating dragger');

    // landscape, A | B side by side: dropping A back on B's left edge is where it already is
    const env2 = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const P = win(env2, 'P'), Q = win(env2, 'Q');
    env2.retileAll();
    const gapPt = [P.rect.x + P.rect.width + 3, P.rect.y + 200];   // the 6px gap between them
    dragTo(env2, P, gapPt);
    ok(env2.dropZone(Q) === 'left', 'the gap resolves to Q\'s left edge');
    ok(env2.endSwapDrag(P) === false, 'P is already left of Q: nothing changes');
    ok(drop(env2, P, Q, 0.9, 0.5) === true && same(rowsOf(env2), [[Q.id], [P.id]]) && Q.rect.x < P.rect.x, 'dropping P on Q\'s right edge puts P on the right');
    console.log('  dropping where a window already is is a no-op; the 6px gap resolves to an edge');
}

// ===== I. minimum sizes: refuse what cannot fit =====
console.log('I. a drop that cannot fit is refused (red outline + message)');
{
    const port = monInfo(1920, 0, 1080, 1920);
    // (i) minimums already learned: two 578px windows cannot share a 1062px row
    const env = makeEnv([port]);
    const A = win(env, 'A', {w: 578, h: 100}), B = win(env, 'B', {w: 578, h: 100}), T = win(env, 'T', {w: 373, h: 100});
    env.retileAll();
    A.wintileMin = {w: 578, h: 0}; B.wintileMin = {w: 578, h: 0};
    dragTo(env, A, at(B, 0.9, 0.5));
    env.updateSwapHighlight();
    ok(run(env, 'swapHighlight').style === 'no' && run(env, 'swapHighlight').visible === true, 'hovering an impossible spot shows the red outline');
    ok(env.endSwapDrag(A) === false, 'the drop is refused');
    ok(env.notices.length === 1 && /will not fit/.test(env.notices[0]), `the user is told why: ${JSON.stringify(env.notices)}`);
    env.retileAll();
    ok(run(env, 'arrangement.size') === 0 && !anyOverlap([A, B, T]), 'nothing changed, nothing overlaps');

    // a wide window and a narrow one CAN share the row
    ok(drop(env, T, B, 0.9, 0.5) === true, 'the narrow window beside the wide one is accepted');
    env.retileAll();
    ok(B.rect.y === T.rect.y && B.rect.x < T.rect.x && B.rect.width >= 578 && T.rect.width >= 373 && !anyOverlap([A, B, T]),
        'B (>= 578px) and T (>= 373px) side by side, no overlap');
    console.log('  two wide windows: refused with a message; wide + narrow: accepted and sized to fit');

    // (ii) minimums NOT known yet: the drop is accepted, the windows collide, the minimums are learned,
    //      and the layout falls back to automatic rather than leaving them overlapped
    const env2 = makeEnv([port]);
    const A2 = win(env2, 'A', {w: 578, h: 100}), B2 = win(env2, 'B', {w: 578, h: 100}), T2 = win(env2, 'T', {w: 373, h: 100});
    env2.retileAll();
    ok(drop(env2, A2, B2, 0.9, 0.5) === true, 'unknown minimums: the drop is accepted');
    ok(anyOverlap([A2, B2]), 'precondition: the two wide windows collide');
    env2.verifyTiles();
    ok(A2.wintileMin && B2.wintileMin, 'the minimums are learned');
    env2.retileAll();
    ok(run(env2, 'arrangement.size') === 0 && env2.notices.length === 1 && !anyOverlap([A2, B2, T2]),
        'the arrangement is dropped with a message and the automatic layout does not overlap');
    console.log('  an arrangement that turns out not to fit falls back to automatic, with a message');
}

// ===== P. the arrangement persists =====
console.log('P. arrangement survives windows opening and closing, ends when the orientation changes');
{
    const env = makeEnv([monInfo(1920, 0, 1080, 1920)]);
    const A = win(env, 'A'), B = win(env, 'B'), C = win(env, 'C');
    env.retileAll();
    drop(env, A, B, 0.9, 0.5);                                    // [[B,A],[C]]
    ok(same(rowsOf(env), [[B.id, A.id], [C.id]]), 'precondition: [[B,A],[C]]');
    env.retileAll(); env.retileAll();
    ok(same(rowsOf(env), [[B.id, A.id], [C.id]]) && B.rect.y === A.rect.y, 'it stays put across relayouts');

    const D = win(env, 'D');                                       // a window opens: a row of its own, at the end
    env.retileAll();
    ok(same(rowsOf(env), [[B.id, A.id], [C.id], [D.id]]) && D.rect.y > C.rect.y && !anyOverlap([A, B, C, D]),
        'a new window gets its own row at the end; the arrangement is kept');
    env.wins.splice(env.wins.indexOf(C), 1);                       // C closes
    env.retileAll();
    ok(same(rowsOf(env), [[B.id, A.id], [D.id]]) && B.rect.y === A.rect.y && D.rect.y > B.rect.y, 'a closed window just drops out');
    env.wins.splice(env.wins.indexOf(D), 1);
    env.retileAll();
    ok(same(rowsOf(env), [[B.id, A.id]]), 'an emptied row disappears');

    env.monitors[0] = monInfo(0, 0, 1920, 1080);                   // the monitor is rotated to landscape
    env.retileAll();
    ok(run(env, 'arrangement.size') === 0, 'rotating the monitor ends the arrangement');
    console.log('  kept across relayouts; new window = own row at the end; closed windows drop out; rotation resets');
}

// ===== G. portrait swap =====
console.log('G. portrait: middle drop swaps top and bottom');
{
    const env = makeEnv([monInfo(0, 0, 1080, 1920)]);
    const T = win(env, 'T'), U = win(env, 'U');
    env.retileAll();
    const t0 = R(T), u0 = R(U);
    ok(t0.y < u0.y && t0.x === u0.x, 'a portrait pair starts stacked');
    ok(drop(env, T, U, 0.5, 0.5) === true && same(R(T), u0) && same(R(U), t0), 'top and bottom windows traded places');
    console.log('  top and bottom windows traded places');
}

// ===== H. teardown =====
console.log('H. teardown');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const A = win(env, 'A'); win(env, 'B');
    env.retileAll();
    env.beginSwapDrag(A);
    const hl = run(env, 'swapHighlight');
    env.stopSwapDrag();
    ok(hl.destroyed && run(env, 'swapDrag') === null && run(env, 'swapDragTimer') === null && run(env, 'swapHighlight') === null,
        'stopSwapDrag releases the timer and the highlight');
    console.log('  stopSwapDrag releases timer + highlight');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
