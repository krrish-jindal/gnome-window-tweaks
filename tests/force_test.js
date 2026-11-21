// Force-resize: windows are tiled below the minimum size their application declares, by lowering the
// WM_NORMAL_HINTS minimum (wintile@nowsci.com/force-size.py). Runs the REAL retileAll / verifyTiles /
// relaxMinimums from extension.js against fake windows and a fake helper process.
//   node tests/force_test.js <extension.js>
//
// Two kinds of fake application, both seen on a real desktop:
//   soft      accepts a lowered minimum (Brave app windows, terminals)
//   stubborn  puts its own minimum back or resizes itself back (normal Chrome windows)
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const names = ['splitSpan', 'splitSpanWeighted', 'autoTileStructure', 'preferredRowCounts', 'structureViolation', 'fitWeights',
    'minsKeyOf', 'autoTileGap', 'evenLayoutState', 'autoTileRects', 'isTileCandidate', 'isBlacklisted', 'retileAll', 'autoTileKey',
    'reconcileRows', 'rowsFeasible', 'scheduleVerify', 'verifyTiles', 'forcing', 'layoutMin', 'xidOf', 'relaxMinimums',
    'stopForcingSizes'];
let code = '';
for (const n of names) {
    const m = new RegExp(`^function ${n}\\(`, 'm').exec(src);
    if (!m) throw new Error(`function ${n} not found`);
    code += src.slice(m.index, src.indexOf('\n}\n', m.index) + 3) + '\n';
}
const floor = /const FORCE_MIN = \{w: (\d+), h: (\d+)\}/.exec(src);
if (!floor) throw new Error('FORCE_MIN not found');

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL:', msg); } return c; };
const G = 6, SHADOW_W = 38, SHADOW_H = 49;

function monInfo(x, y, width, height) {
    return {monitorIndex: 0, x, y, width, height, isPortrait: width < height, colCount: 2, rowCount: 2};
}
function makeEnv(monitors, opts = {}) {
    const env = {
        wins: [], monitors, retileScheduled: 0, grabOp: 0, procs: [], spawned: [], helperFails: opts.helperFails === true,
        config: {gap: G, autoTile: true, autoTileBlacklist: [], forceResize: opts.force !== false},
        Meta: {WindowType: {NORMAL: 0}, GrabOp: {NONE: 0}, WindowClientType: {X11: 0, WAYLAND: 1}},
        Main: {notify() {}},
        _log() {},
        GLib: {SOURCE_REMOVE: false, SOURCE_CONTINUE: true, timeout_add: () => 7, source_remove() {},
            build_filenamev: parts => parts.join('/')},
        Gio: {
            SubprocessFlags: {STDOUT_SILENCE: 1, STDERR_SILENCE: 2},
            Subprocess: {
                new(argv) {
                    if (opts.helperMissing)
                        throw new Error('python3: not found');
                    const proc = {argv, cb: null,
                        wait_async(_c, cb) { proc.cb = cb; },
                        wait_finish() {},
                        get_successful: () => opts.helperFails !== true};
                    env.procs.push(proc);
                    env.spawned.push(argv.slice());
                    return proc;
                },
            },
        },
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
        get_window_actors: () => env.wins.map(w => ({meta_window: w})),
    };
    env.workspace = {list_windows: () => env.wins};
    env.getActiveWorkspace = () => env.workspace;
    vm.createContext(env);
    vm.runInContext('let windowMoving = false, autoTiling = false, verifyTimer = null; ' +
        `const FORCE_MIN = {w: ${floor[1]}, h: ${floor[2]}}; const wintile = {extdatadir: '/ext'}; ` +
        'const layoutState = new Map(); const arrangement = new Map();', env);
    vm.runInContext(code, env);
    return env;
}
let seq = 0;
function win(env, cls, hardMin, kind = 'soft', monitor = 0, client = 0) {
    const w = {
        id: ++seq, cls, monitor, hardMin, kind, client, rect: {x: 0, y: 0, width: 100, height: 100}, minimized: false,
        resizeable: true, window_type: 0, maximized_horizontally: false, maximized_vertically: false,
        get_stable_sequence() { return this.id; }, get_wm_class() { return this.cls; }, get_title() { return this.cls; },
        get_monitor() { return this.monitor; }, get_frame_rect() { return this.rect; },
        get_buffer_rect() { return {x: 0, y: 0, width: this.rect.width + SHADOW_W, height: this.rect.height + SHADOW_H}; },
        get_client_type() { return this.client; },
        get_description() { return `0x${(0x4000000 + this.id).toString(16)} (${this.cls})`; },
        is_skip_taskbar: () => false, is_fullscreen: () => false, is_above: () => false,
    };
    env.wins.push(w);
    return w;
}
const overlaps = (a, b) => a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width &&
    a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height;
const anyOverlap = ws => ws.some((a, i) => ws.slice(i + 1).some(b => overlaps(a, b)));

// Finish the helper processes that are running: soft windows take the lowered hint, stubborn ones do not.
function runHelpers(env) {
    const done = env.procs.splice(0);
    for (const p of done) {
        const args = p.argv.slice(3);
        if (p.argv[2] === 'set' && !env.helperFails) {
            for (let i = 0; i < args.length; i += 3) {
                const w = env.wins.find(x => `0x${(0x4000000 + x.id).toString(16)}` === args[i]);
                if (!w || (w.kind !== 'soft' && w.kind !== 'slow'))
                    continue;
                // 'slow': the first rewrite of its hint is lost (the application sets its own again, or the
                // window manager has not read it yet) -- only a retry gets through
                if (w.kind === 'slow' && !w.sawHelper) {
                    w.sawHelper = true;
                    continue;
                }
                w.hardMin = {w: Math.min(w.hardMin.w, +args[i + 1] - SHADOW_W), h: Math.min(w.hardMin.h, +args[i + 2] - SHADOW_H)};
            }
        }
        p.cb(p, 'res');
    }
    return done.length;
}
// What the extension does on its own: lay out, let helpers finish, verify, repeat until quiet.
function settle(env, maxRounds = 20) {
    let rounds = 0;
    for (; rounds < maxRounds; rounds++) {
        env.retileAll();
        const helpers = runHelpers(env);
        // the helper finishing asks for a relayout (scheduleRetile(0)), which runs before the next verify
        if (env.retileScheduled > 0)
            env.retileAll();
        env.retileScheduled = 0;
        const before = JSON.stringify(env.wins.map(w => w.wintileMin || 0));
        env.verifyTiles();
        const helpers2 = runHelpers(env);
        if (helpers2 && env.retileScheduled > 0)
            env.retileAll();
        if (!helpers && !helpers2 && env.retileScheduled === 0 && before === JSON.stringify(env.wins.map(w => w.wintileMin || 0)))
            break;
    }
    env.retileAll();
    return rounds;
}

const PORT = () => monInfo(1920, 0, 1080, 1920);

console.log('1. force-resize on: four windows that could never pair (578-640px minimums) become a 2x2 grid');
{
    const env = makeEnv([PORT()]);
    const A = win(env, 'chrome', {w: 638, h: 101}), B = win(env, 'brave', {w: 578, h: 61});
    const C = win(env, 'brave', {w: 578, h: 61}), D = win(env, 'term', {w: 283, h: 87});
    const rounds = settle(env);
    ok(!anyOverlap([A, B, C, D]), 'no overlap');
    ok([A, B, C, D].every(w => w.rect.width <= 535), `all four should be squeezed into ~531px tiles: ${[A, B, C, D].map(w => w.rect.width)}`);
    ok(A.rect.y === B.rect.y && C.rect.y === D.rect.y && A.rect.x < B.rect.x && C.rect.x < D.rect.x, 'two rows of two, left/right');
    ok(env.spawned.length === 1 && env.spawned[0][2] === 'set', `one helper call lowers all four at once: ${env.spawned.length}`);
    const args = env.spawned[0].slice(3);
    ok(args.length === 12 && args[1] === String(+floor[1] + SHADOW_W) && args[2] === String(+floor[2] + SHADOW_H),
        `the hint is the floor plus the window shadow: ${args.slice(0, 3)}`);
    ok(rounds <= 3, `settles quickly, took ${rounds} round(s)`);
    // stable: another layout pass must not call the helper again
    const calls = env.spawned.length; env.retileAll(); env.verifyTiles(); runHelpers(env);
    ok(env.spawned.length === calls, 'a window that was lowered once is not lowered again');
    console.log(`  squeezed to ${A.rect.width}px, settled in ${rounds} round(s), helper called once`);
}

console.log('2. a stubborn window (Chrome) keeps its own minimum; the soft ones around it give way');
{
    const env = makeEnv([PORT()]);
    const chrome = win(env, 'chrome', {w: 638, h: 101}, 'stubborn');
    const yt = win(env, 'brave', {w: 578, h: 61}), music = win(env, 'brave', {w: 578, h: 61}), term = win(env, 'term', {w: 283, h: 87});
    settle(env);
    ok(!anyOverlap([chrome, yt, music, term]), 'no overlap even though Chrome would not shrink');
    ok(chrome.wintileMin && chrome.wintileMin.w === 638, `Chrome's real minimum is learned: ${JSON.stringify(chrome.wintileMin)}`);
    ok(chrome.wintileRelaxed === 'refused', `and it is left to its own minimum: ${chrome.wintileRelaxed}`);
    ok(chrome.rect.y === yt.rect.y && chrome.rect.x < yt.rect.x, 'Chrome still sits beside a Brave window, left/right');
    ok(chrome.rect.width >= 638 && yt.rect.width < 578 && yt.rect.width >= 400,
        `Chrome keeps its width, the Brave window is squeezed to the rest: ${chrome.rect.width} | ${yt.rect.width}`);
    console.log(`  Chrome ${chrome.rect.width}px | Brave ${yt.rect.width}px share a row`);
}

console.log('2b. a window whose first lowering is lost is retried, not written off');
{
    const env = makeEnv([PORT()]);
    const a = win(env, 'brave', {w: 578, h: 61}, 'slow'), b = win(env, 'brave', {w: 578, h: 61});
    const c = win(env, 'term', {w: 283, h: 87}), d = win(env, 'term', {w: 283, h: 87});
    settle(env);
    ok(!anyOverlap([a, b, c, d]), 'no overlap');
    ok(a.rect.width < 578 && a.wintileRelaxed === 'done', `squeezed after the retry: ${a.rect.width}px, ${a.wintileRelaxed}`);
    ok(a.wintileMin === undefined || a.wintileMin.w < 578, `a real minimum is not "learned" from the lost write: ${JSON.stringify(a.wintileMin)}`);
    ok(env.spawned.length === 2, `exactly one retry: ${env.spawned.length} helper calls`);
    console.log(`  squeezed to ${a.rect.width}px after one retry`);
}

console.log('3. two stubborn windows cannot share a row, and nothing overlaps or loops');
{
    const env = makeEnv([PORT()]);
    const a = win(env, 'chrome', {w: 638, h: 101}, 'stubborn'), b = win(env, 'chrome', {w: 638, h: 101}, 'stubborn');
    const c = win(env, 'term', {w: 283, h: 87});
    const rounds = settle(env);
    ok(!anyOverlap([a, b, c]), 'no overlap');
    ok(a.rect.y !== b.rect.y, 'the two Chromes get a row each');
    ok(rounds < 20, `it gives up instead of looping (${rounds} rounds)`);
    console.log(`  stacked, settled in ${rounds} round(s)`);
}

console.log('4. force-resize off: the old behaviour, the helper is never run');
{
    const env = makeEnv([PORT()], {force: false});
    const A = win(env, 'brave', {w: 578, h: 61}), B = win(env, 'brave', {w: 578, h: 61}), C = win(env, 'term', {w: 283, h: 87});
    settle(env);
    ok(env.spawned.length === 0, 'no helper process');
    ok(!anyOverlap([A, B, C]) && A.rect.width >= 578 && B.rect.width >= 578, 'each window keeps its own minimum, no overlap');
    ok(A.wintileRelaxed === undefined, 'windows are not marked');
    console.log('  stacked at full width, as before');
}

console.log('5. the helper cannot run (no python3) or fails: fall back to learned minimums');
for (const [label, opts] of [['cannot start', {helperMissing: true}], ['exits with an error', {helperFails: true}]]) {
    const env = makeEnv([PORT()], opts);
    // four windows, so the unaware layout pairs them and the two wide ones overflow their tiles
    const A = win(env, 'brave', {w: 578, h: 61}), B = win(env, 'brave', {w: 578, h: 61});
    const C = win(env, 'term', {w: 283, h: 87}), D = win(env, 'term', {w: 283, h: 87});
    settle(env);
    ok(!anyOverlap([A, B, C, D]), `${label}: no overlap`);
    ok(A.wintileRelaxed === 'failed' && A.wintileMin && A.wintileMin.w === 578, `${label}: marked failed, minimum learned`);
    console.log(`  helper ${label}: stacked without overlap`);
}

console.log('6. windows that are not X11 are left alone');
{
    const env = makeEnv([PORT()]);
    const A = win(env, 'wl', {w: 578, h: 61}, 'soft', 0, 1), B = win(env, 'wl', {w: 578, h: 61}, 'soft', 0, 1);
    settle(env);
    ok(env.spawned.length === 0 && A.wintileRelaxed === 'unavailable', 'no helper, marked unavailable');
    ok(!anyOverlap([A, B]), 'no overlap');
}

console.log('7. layoutMin');
{
    const env = makeEnv([PORT()]);
    const w = win(env, 'x', {w: 700, h: 300});
    const lm = () => vm.runInContext('layoutMin', env)(w);
    ok(JSON.stringify(lm()) === JSON.stringify({w: +floor[1], h: +floor[2]}), 'unknown minimum while forcing -> the floor');
    w.wintileMin = {w: 700, h: 300};
    ok(lm().w === +floor[1] && lm().h === +floor[2], 'a learned minimum above the floor is capped to it');
    w.wintileMin = {w: 283, h: 87};
    ok(lm().w === 283 && lm().h === 87, 'a minimum below the floor stays');
    w.wintileMin = {w: 700, h: 300}; w.wintileRelaxed = 'refused';
    ok(lm().w === 700, 'a refusing window keeps what it was measured at');
    env.config.forceResize = false; delete w.wintileRelaxed;
    ok(lm().w === 700, 'force-resize off: the learned value as is');
}

console.log('8. switching force-resize off restores the original hints and forgets the marks');
{
    const env = makeEnv([PORT()]);
    const A = win(env, 'brave', {w: 578, h: 61});
    settle(env);
    ok(A.wintileRelaxed === 'done', 'precondition: lowered');
    env.spawned.length = 0;
    env.stopForcingSizes();
    ok(env.spawned.length === 1 && env.spawned[0].slice(2).join(' ') === 'restore --all', `asks the helper to restore: ${env.spawned[0]}`);
    ok(A.wintileRelaxed === undefined && A.wintileForceTries === undefined, 'marks cleared');
}

if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
