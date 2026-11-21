// Extension lifecycle: auto-tile must re-attach its listeners after the extension is disabled and
// enabled again. GNOME does exactly that on every screen lock and unlock (wintile does not declare
// the unlock-dialog session mode), and the module -- including the remembered `config.autoTile` --
// survives it. Comparing "setting changed?" instead of "listeners attached?" left auto-tiling dead.
//   node tests/lifecycle_test.js <extension.js>
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const m = /^function updateSettings\(/m.exec(src);
if (!m) throw new Error('function updateSettings not found');
const code = src.slice(m.index, src.indexOf('\n}\n', m.index) + 3);

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL:', msg); } return c; };

function makeEnv(settings) {
    const env = {
        calls: [],
        config: {cols: 2, rows: 2, ultrawideOnly: false, nonUltraCols: 2, nonUltraRows: 2, useMaximize: true,
            useMinimize: true, preview: {enabled: true, doubleWidth: true, distance: 75, delay: 500},
            gap: 0, autoTile: false, autoTileBlacklist: [], forceResize: true, debug: false},
        _log() {},
        // one entry per attached listener, like autoTileSignals in the extension
        autoTileConnect() { env.calls.push('connect'); vm.runInContext('autoTileSignals = [1, 2, 3]', env); },
        autoTileDisconnect() { env.calls.push('disconnect'); vm.runInContext('autoTileSignals = []', env); },
        scheduleRetile() { env.calls.push('relayout'); },
        stopForcingSizes() { env.calls.push('restore-hints'); },
        gsettings: {
            // like a real compiled schema: asking for a key it lacks must never happen
            get_value: key => {
                if (!(key in env.settings)) throw new Error(`schema has no key '${key}'`);
                return {deep_unpack: () => env.settings[key]};
            },
            settings_schema: {has_key: key => key in env.settings},
        },
        settings: Object.assign({cols: 2, rows: 2, 'double-width': true, 'ultrawide-only': false, 'non-ultra-cols': 2,
            'non-ultra-rows': 2, 'use-maximize': true, 'use-minimize': true, preview: true, distance: 25, delay: 500,
            gap: 6, debug: false, 'auto-tile': true, 'auto-tile-blacklist': []}, settings || {}),
    };
    vm.createContext(env);
    vm.runInContext('let autoTileSignals = [];', env);
    vm.runInContext(code, env);
    return env;
}
const last = env => env.calls[env.calls.length - 1];
const attached = env => vm.runInContext('autoTileSignals.length', env) > 0;

console.log('1. first enable with auto-tile on');
{
    const env = makeEnv();
    env.updateSettings();
    ok(env.calls.join() === 'connect' && attached(env), `should attach once, did: ${env.calls}`);
}

console.log('2. screen lock then unlock (disable + enable) keeps auto-tile alive');
{
    const env = makeEnv();
    env.updateSettings();                      // enable
    env.autoTileDisconnect();                  // disable(): detaches the listeners, config.autoTile stays true
    ok(env.config.autoTile === true && !attached(env), 'precondition: remembered ON, listeners gone');
    env.calls.length = 0;
    env.updateSettings();                      // enable again after unlock
    ok(env.calls.join() === 'connect' && attached(env), `should re-attach after unlock, did: ${env.calls}`);
    for (let i = 0; i < 3; i++) { env.autoTileDisconnect(); env.updateSettings(); }
    ok(attached(env), 'still attached after several lock/unlock cycles');
    console.log('  re-attached after unlock, and after repeated lock/unlock cycles');
}

console.log('3. a settings change while attached relayouts instead of re-attaching');
{
    const env = makeEnv();
    env.updateSettings(); env.calls.length = 0;
    env.updateSettings();
    ok(env.calls.join() === 'relayout', `should only relayout, did: ${env.calls}`);
}

console.log('4. turning auto-tile off');
{
    const env = makeEnv();
    env.updateSettings(); env.calls.length = 0;
    env.settings['auto-tile'] = false;
    env.updateSettings();
    ok(env.calls.join() === 'disconnect' && !attached(env), `should detach, did: ${env.calls}`);
    env.calls.length = 0;
    env.updateSettings();                      // off and already detached: nothing to do
    ok(env.calls.length === 0, `off and detached should do nothing, did: ${env.calls}`);
    env.settings['auto-tile'] = true;
    env.updateSettings();
    ok(last(env) === 'connect' && attached(env), 'turning it back on attaches again');
}

console.log('5. force-resize: switching it off restores the windows\' own minimums, once');
{
    const env = makeEnv({'force-resize': true});
    env.updateSettings();
    ok(env.config.forceResize === true && !env.calls.includes('restore-hints'), 'on: nothing to restore');
    env.settings['force-resize'] = false;
    env.calls.length = 0;
    env.updateSettings();
    ok(env.config.forceResize === false && env.calls.filter(c => c === 'restore-hints').length === 1,
        `off: hints restored once, did: ${env.calls}`);
    env.calls.length = 0;
    env.updateSettings();
    ok(!env.calls.includes('restore-hints'), 'still off: not restored again');
    env.settings['force-resize'] = true;
    env.updateSettings();
    ok(env.config.forceResize === true, 'back on');
}

console.log('6. an older compiled schema without the force-resize key must not crash the shell');
{
    const env = makeEnv();
    delete env.settings['force-resize'];
    let threw = null;
    try { env.updateSettings(); } catch (e) { threw = e; }
    ok(!threw, `updateSettings threw: ${threw}`);
    ok(env.config.forceResize === true, 'keeps the default (on)');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
