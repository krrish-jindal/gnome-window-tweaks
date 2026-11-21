// Loads the REAL layout functions out of two extension.js files and compares them.
//   node tests/orientation_test.js <old extension.js> <new extension.js>
const fs = require('fs');
const vm = require('vm');

function load(path, cfg) {
    const src = fs.readFileSync(path, 'utf8');
    const names = ['splitSpan', 'splitSpanWeighted', 'autoTileStructure', 'autoTileGap',
        'evenLayoutState', 'autoTileRects', 'shiftBoundary', 'applyManualResize', 'structureViolation'];
    const optional = ['structureViolation'];   // absent from the pre-orientation fixture
    let code = '';
    for (const n of names) {
        const m = new RegExp(`^function ${n}\\(`, 'm').exec(src);
        if (!m && optional.includes(n)) continue;
        if (!m) throw new Error(`${path}: function ${n} not found`);
        code += src.slice(m.index, src.indexOf('\n}\n', m.index) + 3) + '\n';
    }
    const ctx = {
        config: Object.assign({gap: 6}, cfg || {}), MIN_SLICE: 0.08, _log() {},
        layoutState: new Map(), retile: false, getMonitorInfo: null,
        scheduleRetile() { ctx.retile = true; },
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx;
}

// Same arithmetic as getMonitorInfo() (cols/rows swapped for portrait).
function mon(x, y, width, height, cols = 2, rows = 2) {
    const isPortrait = width < height;
    const [colCount, rowCount] = isPortrait ? [rows, cols] : [cols, rows];
    return {monitorIndex: 0, x, y, width, height, isPortrait, colCount, rowCount};
}

const [oldPath, newPath] = process.argv.slice(2);
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL:', msg); } return c; };

function layout(ctx, m, n, mins) {
    const st = ctx.autoTileStructure(m, n, mins);
    const state = ctx.evenLayoutState(st, 'p');
    return {st, state, rects: ctx.autoTileRects(m, st, state)};
}
const strip = r => r.map(({x, y, w, h}) => [x, y, w, h]);

// ---- A. landscape must be byte-for-byte what it was ----
console.log('A. landscape regression (old vs new)');
let aOk = true;
for (const cfg of [{gap: 6}, {gap: 0}, {gap: 10}]) {
    const O = load(oldPath, cfg), N = load(newPath, cfg);
    for (const [cols, rows] of [[2, 2], [3, 2], [4, 2]]) {
        for (const m of [mon(0, 27, 1920, 1053, cols, rows), mon(1920, 0, 2560, 1440, cols, rows)]) {
            for (let n = 1; n <= 9; n++) {
                const a = JSON.stringify(strip(layout(O, m, n).rects));
                const b = JSON.stringify(strip(layout(N, m, n).rects));
                if (a !== b) { aOk = false; console.log(`  DIFF gap=${cfg.gap} grid=${cols}x${rows} ${m.width}x${m.height} n=${n}`); }
            }
        }
    }
}
ok(aOk, 'landscape layouts changed'); if (aOk) console.log('  identical for gaps 0/6/10, grids 2x2/3x2/4x2, 2 monitors, n=1..9');

// ---- B. portrait geometry ----
console.log('B. portrait layouts (1080x1920 at x=1920)');
const NEW = load(newPath);
const pm = mon(1920, 0, 1080, 1920);
const G = 6;
function geometry(rects, m, label) {
    for (let i = 0; i < rects.length; i++) {
        const a = rects[i];
        ok(a.x >= m.x + G && a.y >= m.y + G && a.x + a.w <= m.x + m.width - G &&
           a.y + a.h <= m.y + m.height - G, `${label}: tile ${i} outside the gapped area`);
        for (let j = i + 1; j < rects.length; j++) {
            const b = rects[j];
            const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
            ok(!overlap, `${label}: tiles ${i} and ${j} overlap`);
        }
    }
    ok(Math.min(...rects.map(r => r.x)) === m.x + G, `${label}: left margin != gap`);
    ok(Math.min(...rects.map(r => r.y)) === m.y + G, `${label}: top margin != gap`);
    ok(Math.max(...rects.map(r => r.x + r.w)) === m.x + m.width - G, `${label}: right margin != gap`);
    ok(Math.max(...rects.map(r => r.y + r.h)) === m.y + m.height - G, `${label}: bottom margin != gap`);
}
for (let n = 1; n <= 7; n++) {
    const {st, rects} = layout(NEW, pm, n);
    geometry(rects, pm, `portrait n=${n}`);
    const desc = rects.map(r => `(${r.x - pm.x},${r.y} ${r.w}x${r.h})`).join(' ');
    console.log(`  n=${n} lanes=${st.columns} perLane=[${st.rowCounts}] portrait=${st.portrait}\n      ${desc}`);
}
let l = layout(NEW, pm, 2).rects;
ok(l[0].x === l[1].x && l[0].w === l[1].w && l[0].y < l[1].y, 'portrait n=2 is not a top/bottom stack');
// Portrait is a pure stack: every window gets its own full-width row, whatever the count.
for (let n = 1; n <= 7; n++) {
    l = layout(NEW, pm, n).rects;
    ok(l.every(r => r.x === l[0].x && r.w === l[0].w && r.w === pm.width - 2 * G),
        `portrait n=${n}: every window should be full width`);
    ok(l.every((r, i) => i === 0 || r.y > l[i - 1].y), `portrait n=${n}: rows should run top to bottom`);
}
console.log('  portrait n=1..7 is always a full-width stack (never side by side)');
const lm = mon(0, 0, 1920, 1080);
l = layout(NEW, lm, 2).rects;
ok(l[0].y === l[1].y && l[0].x < l[1].x && l[0].h === l[1].h, 'landscape n=2 is not a left/right split');
console.log('  landscape n=2 is left/right; portrait n=2 is top/bottom');

// ---- C. hand-resize follows the right axis in both orientations ----
console.log('C. hand-resize through the real applyManualResize()');
function resizeCase(label, m, n, idx, edit, check, mins) {
    const C = load(newPath);
    C.getMonitorInfo = () => m;
    const {st, state, rects} = layout(C, m, n, mins);
    C.layoutState.set('0:0', state);
    const r = rects[idx];
    const app = {wintileSlot: {key: '0:0', col: r.col, row: r.row}, get_monitor: () => 0, get_wm_class: () => 'test'};
    const before = {x: r.x, y: r.y, width: r.w, height: r.h};
    const after = Object.assign({}, before); edit(after);
    C.applyManualResize(app, before, after);
    const nr = C.autoTileRects(m, C.autoTileStructure(m, n, mins), C.layoutState.get('0:0'));
    check(app, r, nr[idx], nr, C);
    console.log(`  ran: ${label}`);
}
const lmon = mon(0, 0, 1920, 1080);
resizeCase('landscape n=2: drag shared (right) edge +100 -> left window 100px wider', lmon, 2, 0,
    a => { a.width += 100; },
    (app, o, nw, all, C) => { ok(Math.abs(nw.w - (o.w + 100)) <= 2, `landscape widened by ${nw.w - o.w}`); ok(C.retile, 'no retile'); ok(!app.wintileFloat, 'floated'); });
resizeCase('portrait n=2: drag shared (bottom) edge +100 -> top window 100px taller', pm, 2, 0,
    a => { a.height += 100; },
    (app, o, nw, all, C) => { ok(Math.abs(nw.h - (o.h + 100)) <= 2, `portrait grew by ${nw.h - o.h}`); ok(nw.w === o.w, 'width changed'); ok(C.retile, 'no retile'); ok(!app.wintileFloat, 'floated'); ok(all[1].y >= nw.y + nw.h + G, 'neighbour did not follow'); });
// 600px-tall minimums cannot fit 4 stacked rows on a 1920px screen, so the layout falls back to 3 rows
// ([2,1,1]) and the top row holds two windows side by side: the case that exercises the item axis.
const tall = Array.from({length: 4}, () => ({w: 0, h: 600}));
resizeCase('portrait n=4 forced to 3 rows by 600px-tall minimums: drag a top-row shared (right) edge +80 -> 80px wider', pm, 4, 0,
    a => { a.width += 80; },
    (app, o, nw, all, C) => {
        ok(C.autoTileStructure(pm, 4, tall).rowCounts.join() === '2,1,1', 'precondition: rows should be [2,1,1]');
        ok(Math.abs(nw.w - (o.w + 80)) <= 2, `portrait item widened by ${nw.w - o.w}`);
        ok(nw.h === o.h, 'height changed');
        ok(!app.wintileFloat, 'floated');
    }, tall);
resizeCase('portrait n=2: drag the TOP screen-border edge -> floats the window (as before)', pm, 2, 0,
    a => { a.y += 40; a.height -= 40; },
    (app) => { ok(app.wintileFloat === true, 'should have floated'); });
resizeCase('landscape n=2: drag the LEFT screen-border edge -> floats the window (as before)', lmon, 2, 0,
    a => { a.x += 40; a.width -= 40; },
    (app) => { ok(app.wintileFloat === true, 'should have floated'); });

// ---- D. rotating a monitor invalidates carried-over weights ----
console.log('D. orientation flip rebuilds the layout state');
{
    const C = load(newPath);
    const a = C.autoTileStructure(mon(0, 0, 1920, 1080), 2);
    const b = C.autoTileStructure(mon(0, 0, 1080, 1920), 2);
    ok(a.columns === b.columns && a.rowCounts.join() === b.rowCounts.join(), 'precondition: same counts');
    ok(a.portrait === false && b.portrait === true, 'portrait flag differs -> retileAll() resets weights');
    console.log('  2 windows: counts identical but portrait flag differs (landscape=%s, portrait=%s)', a.portrait, b.portrait);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
