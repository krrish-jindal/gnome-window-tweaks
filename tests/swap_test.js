// Runs the REAL retileAll / drag-swap functions from extension.js against fake windows.
//   node tests/swap_test.js <extension.js>
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const names = ['splitSpan', 'splitSpanWeighted', 'autoTileStructure', 'autoTileGap', 'evenLayoutState',
    'autoTileRects', 'isTileCandidate', 'isBlacklisted', 'retileAll', 'autoTileKey', 'swapAutoTileOrder',
    'findSwapTarget', 'swapDragMoved', 'stopSwapDrag', 'updateSwapHighlight', 'beginSwapDrag', 'endSwapDrag'];
let code = '';
for (const n of names) {
    const m = new RegExp(`^function ${n}\\(`, 'm').exec(src);
    if (!m) throw new Error(`function ${n} not found`);
    code += src.slice(m.index, src.indexOf('\n}\n', m.index) + 3) + '\n';
}

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL:', msg); } return c; };

// ---- environment stubs ----
function monInfo(x, y, width, height) {
    const isPortrait = width < height;
    const [colCount, rowCount] = [2, 2];
    return {monitorIndex: 0, x, y, width, height, isPortrait, colCount, rowCount};
}
function makeEnv(monitors) {
    const env = {
        pointer: [0, 0], wins: [], monitors,
        config: {gap: 6, autoTile: true, autoTileBlacklist: []},
        Meta: {WindowType: {NORMAL: 0}},
        _log() {},
        GLib: {SOURCE_REMOVE: false, SOURCE_CONTINUE: true, timeout_add: () => 7, source_remove() { env.removed = true; }},
        St: {Widget: class { constructor(o) { Object.assign(this, o); }
            set_position(x, y) { this.px = x; this.py = y; } set_size(w, h) { this.pw = w; this.ph = h; }
            show() { this.visible = true; } hide() { this.visible = false; } destroy() { this.destroyed = true; } }},
        Main: {uiGroup: {add_actor() {}}},
        getMonitorInfo: i => env.monitors[i],
        unMaximizeIfMaximized() {},
        moveAppCoordinates(app, x, y, w, h) { app.rect = {x, y, width: w, height: h}; },
    };
    env.global = {
        get_pointer: () => [env.pointer[0], env.pointer[1], 0],
        get_window_actors: () => env.wins.map(w => ({meta_window: w, visible: true})),
        workspace_manager: {get_active_workspace_index: () => 0},
    };
    env.workspace = {list_windows: () => env.wins};
    env.getActiveWorkspace = () => env.workspace;
    vm.createContext(env);
    vm.runInContext('let windowMoving = false, autoTiling = false, swapDrag = null, swapDragTimer = null, ' +
        'swapHighlight = null; const layoutState = new Map();', env);
    vm.runInContext(code, env);
    return env;
}
let seq = 0;
function win(env, cls, monitor = 0) {
    const w = {
        id: ++seq, cls, monitor, rect: {x: 0, y: 0, width: 100, height: 100}, minimized: false, resizeable: true,
        window_type: 0,
        get_stable_sequence() { return this.id; }, get_wm_class() { return this.cls; }, get_title() { return this.cls; },
        get_monitor() { return this.monitor; }, get_frame_rect() { return this.rect; },
        is_skip_taskbar: () => false, is_fullscreen: () => false, is_above: () => false,
        located_on_workspace: () => true,
    };
    env.wins.push(w);
    return w;
}
const center = r => [r.x + r.width / 2, r.y + r.height / 2];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const R = w => ({...w.rect});
const run = (env, s) => vm.runInContext(s, env);

// Drag `app` so it ends up centred on (px,py): begin -> move -> optional highlight tick.
function drag(env, app, px, py) {
    run(env, 'swapDrag = null');
    env.beginSwapDrag(app);
    const [cx, cy] = center(app.rect);
    app.rect = {...app.rect, x: app.rect.x + (px - cx), y: app.rect.y + (py - cy)};
    env.pointer = [px, py];
}

// ===== E. landscape, three windows =====
console.log('E. drag-to-swap, landscape 1920x1080, 3 windows');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const A = win(env, 'A'), B = win(env, 'B'), C = win(env, 'C');
    env.retileAll();
    const a0 = R(A), b0 = R(B), c0 = R(C);
    console.log('  initial  A=%j B=%j C=%j', [a0.x, a0.y, a0.width, a0.height], [b0.x, b0.y, b0.width, b0.height], [c0.x, c0.y, c0.width, c0.height]);
    ok(a0.x === b0.x && a0.y < b0.y && c0.x > a0.x, 'unexpected initial layout (A over B on the left, C on the right)');

    // give the layout a hand-resized weight so we can prove a swap does not reset it
    const st = run(env, "layoutState.get('0:0')");
    st.colWeights[0] = 3;
    const wBefore = JSON.stringify(st.colWeights);
    env.retileAll();
    const a1 = R(A), c1 = R(C);

    // drag A onto the middle of C
    const [pcx, pcy] = center(C.rect);
    drag(env, A, pcx, pcy);
    ok(run(env, 'swapHighlight') !== null, 'highlight actor was not created at drag start');
    env.updateSwapHighlight();
    const hl = run(env, 'swapHighlight');
    ok(hl.visible === true && hl.px === c1.x && hl.py === c1.y && hl.pw === c1.width && hl.ph === c1.height,
        `highlight should cover C ${JSON.stringify(c1)}, got ${hl.px},${hl.py} ${hl.pw}x${hl.ph} visible=${hl.visible}`);
    const swapped = env.endSwapDrag(A);
    ok(swapped === true, 'endSwapDrag should report a swap');
    ok(run(env, 'swapHighlight') === null && run(env, 'swapDrag') === null, 'drag state not cleaned up');
    ok(hl.destroyed === true, 'highlight actor not destroyed');
    ok(A.wintileOrder === C.id && C.wintileOrder === A.id && B.wintileOrder === undefined,
        `keys: A=${A.wintileOrder} B=${B.wintileOrder} C=${C.wintileOrder}`);

    env.retileAll();
    ok(same(R(A), c1), `A should now hold C's old slot ${JSON.stringify(c1)}, is ${JSON.stringify(R(A))}`);
    ok(same(R(C), a1), `C should now hold A's old slot ${JSON.stringify(a1)}, is ${JSON.stringify(R(C))}`);
    ok(JSON.stringify(run(env, "layoutState.get('0:0')").colWeights) === wBefore, 'hand-resized weights were reset by the swap');
    console.log('  A and C traded slots; B untouched; hand-resized weights %s kept', wBefore);

    // swapping back restores the original assignment: drag A (now in C's old slot) onto C (now in A's old slot)
    drag(env, A, ...center(C.rect));
    ok(env.endSwapDrag(A) === true, 'second swap should happen');
    env.retileAll();
    ok(same(R(A), a1) && same(R(C), c1), 'swapping twice should restore the layout');
    console.log('  swapping back restores the original layout');

    // a 4th window arrives: it goes last, swapped windows keep their slots
    const D = win(env, 'D');
    env.retileAll();
    ok(D.rect.width > 0, 'new window was not placed');
    console.log('  a new window D is placed without disturbing the swap');
}

// ===== F. drops that must NOT swap =====
console.log('F. drops that must not swap');
{
    const env = makeEnv([monInfo(0, 0, 1920, 1080), monInfo(1920, 0, 1920, 1080)]);
    const A = win(env, 'A'), B = win(env, 'B'), C = win(env, 'C');
    const X = win(env, 'X', 1);
    env.retileAll();
    const orderBefore = [A, B, C, X].map(w => w.wintileOrder);

    // 1. plain click on the title bar (no movement), pointer over B
    run(env, 'swapDrag = null'); env.beginSwapDrag(A); env.pointer = center(B.rect);
    ok(env.endSwapDrag(A) === false, 'a click without movement swapped');

    // 2. dropped over empty desktop
    drag(env, A, 5000, 5000);
    ok(env.endSwapDrag(A) === false, 'drop on empty desktop swapped');

    // 3. dialog stacked on top of B: pointer over the dialog -> no swap
    const dlg = win(env, 'dlg'); dlg.window_type = 1; dlg.rect = {...B.rect};
    drag(env, A, ...center(B.rect));
    ok(env.endSwapDrag(A) === false, 'drop on a dialog covering B swapped with B anyway');
    env.wins.splice(env.wins.indexOf(dlg), 1);

    // 4. floating target
    B.wintileFloat = true;
    drag(env, A, ...center(B.rect));
    ok(env.endSwapDrag(A) === false, 'swapped with a floating window');
    delete B.wintileFloat;

    // 5. dragged to the other monitor onto X
    drag(env, A, ...center(X.rect)); A.monitor = 1;
    ok(env.endSwapDrag(A) === false, 'cross-monitor drop swapped');
    A.monitor = 0;

    // 6. dragged window is itself floating -> no tracking at all
    A.wintileFloat = true;
    run(env, 'swapDrag = null'); env.beginSwapDrag(A);
    ok(run(env, 'swapDrag') === null && run(env, 'swapHighlight') === null, 'a floating window should not start a swap drag');
    delete A.wintileFloat;

    ok(same(orderBefore, [A, B, C, X].map(w => w.wintileOrder)), 'a non-swap changed some window order');
    console.log('  click, empty desktop, covering dialog, floating target, other monitor, floating dragger: all left alone');

    // 7. drop on the thin gap between two tiles still resolves to one of them
    const env2 = makeEnv([monInfo(0, 0, 1920, 1080)]);
    const P = win(env2, 'P'), Q = win(env2, 'Q');
    env2.retileAll();
    const gapX = P.rect.x + P.rect.width + 3;           // middle of the 6px gap
    drag(env2, P, gapX, P.rect.y + 200);
    const pId = P.id, qId = Q.id;   // ids come from a counter shared across scenarios
    const swappedInGap = env2.endSwapDrag(P);
    ok(swappedInGap === true, 'drop in the gap should swap with the nearer tile');
    ok(P.wintileOrder === qId && Q.wintileOrder === pId, `gap swap keys: P=${P.wintileOrder} (want ${qId}) Q=${Q.wintileOrder} (want ${pId})`);
    console.log('  a drop on the 6px gap between tiles still swaps');
}

// ===== G. portrait =====
console.log('G. drag-to-swap on a portrait monitor (top/bottom)');
{
    const env = makeEnv([monInfo(0, 0, 1080, 1920)]);
    const T = win(env, 'T'), U = win(env, 'U');
    env.retileAll();
    const t0 = R(T), u0 = R(U);
    ok(t0.y < u0.y && t0.x === u0.x, 'portrait pair should be stacked top/bottom');
    drag(env, T, ...center(U.rect));
    ok(env.endSwapDrag(T) === true, 'portrait swap did not happen');
    env.retileAll();
    ok(same(R(T), u0) && same(R(U), t0), 'portrait windows did not trade places');
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
        'stopSwapDrag (used by disable) must release the timer and highlight');
    console.log('  stopSwapDrag releases timer + highlight');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
