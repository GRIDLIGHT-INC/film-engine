/**
 * World Engine — Phase 2 (MVP 2): the console.
 *
 * Implements test-spec §4, WE-2.1 through WE-2.10.
 *
 * Denominators come from the DESIGN HANDOFF's own tables — the overlay list,
 * the lens row, the demo data — not from a list typed here. The design is the
 * specification for this screen, so if it changes the test changes with it and
 * no reading of mine sits in between.
 *
 * Assertions EXECUTE the page's builders wherever the markup is produced at
 * runtime. A grep reports a working console as broken and a broken one as
 * working: the ids are built from template strings and appear nowhere in the
 * source as literals.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const DESIGN = fs.readFileSync(
    path.join(ROOT, 'design_handoff_world_engine_previz', 'README.md'), 'utf8');

// ── denominators, read from the design ──────────────────────────────────────

/** The eleven composition overlays, from the design's own table. */
function designOverlays() {
    const tbl = DESIGN.slice(DESIGN.indexOf('| Overlay | Default | Rendering |'));
    const rows = tbl.slice(0, tbl.indexOf('\n\n')).split('\n')
        .filter(l => l.startsWith('| ') && !/^\| Overlay|^\|---/.test(l));
    assert.ok(rows.length >= 10, `the overlay table scan found ${rows.length} rows — it is broken`);
    return rows.map(l => {
        const cells = l.split('|').map(c => c.trim());
        return { name: cells[1], on: /\*\*on\*\*/i.test(cells[2]) };
    });
}

/** The twelve lens buttons, from the design's own row. */
function designLenses() {
    const m = /`12 14 18 21 24 28 35 40 50 65 85 135` mm/.exec(DESIGN);
    assert.ok(m, 'the lens row is gone from the design');
    return '12 14 18 21 24 28 35 40 50 65 85 135'.split(' ').map(Number);
}

/** Extract one function's body from the page by brace depth — never a window. */
function fn(name) {
    const at = UI.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} is not in the page`);
    let depth = 0;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') depth++;
        else if (UI[i] === '}' && --depth === 0) return UI.slice(at, i + 1);
    }
    throw new Error(`${name} does not close`);
}

/**
 * Run one of the page's pure builders in isolation.
 *
 * The named dependencies are a STARTING POINT; anything else the builder
 * reaches for is resolved by following the ReferenceError, through the same
 * declaration reader the placement and flag tests use. A hand-written list was
 * the original shape here and it broke the moment the console gained one more
 * helper — reporting a working console as broken, which is the failure mode a
 * bounded scan always has.
 */
const { declSource } = require('./console-render');

function build(names, call, preamble) {
    const need = new Set(names);
    for (let i = 0; i < 60; i++) {
        const src = [...need].map(n => declSource(n) || fn(n)).filter(Boolean).join('\n');
        try {
            return new Function(`${preamble || ''}\n${src}\nreturn (${call});`)();
        } catch (err) {
            const m = /(\w+) is not defined/.exec(err.message);
            if (m && declSource(m[1]) && !need.has(m[1])) { need.add(m[1]); continue; }
            throw err;
        }
    }
    throw new Error('more than 60 dependencies; the resolver gave up');
}

// ══ WE-2.1 · overlays ═══════════════════════════════════════════════════════

test('WE-2.1 all eleven overlays exist, with the design defaults', () => {
    const want = designOverlays();
    const OVERLAYS = build(['worldOverlays'], 'worldOverlays()');

    assert.strictEqual(OVERLAYS.length, want.length,
        `the console offers ${OVERLAYS.length} overlays, the design draws ${want.length}`);

    // Every overlay in the design has an entry, matched on its own label.
    const missing = want.filter(w =>
        !OVERLAYS.some(o => o.label.toLowerCase().startsWith(w.name.toLowerCase().slice(0, 6))));
    assert.deepStrictEqual(missing.map(m => m.name), [],
        `overlays the design draws and the console does not offer: ${missing.map(m => m.name).join(', ')}`);

    // Thirds and Horizon default on; the other nine off. An overlay that
    // defaults on when the design says off is a frame nobody asked to have
    // drawn over.
    for (const w of want) {
        const o = OVERLAYS.find(x => x.label.toLowerCase().startsWith(w.name.toLowerCase().slice(0, 6)));
        assert.strictEqual(!!o.on, w.on, `${w.name}: default should be ${w.on ? 'on' : 'off'}`);
    }
    assert.strictEqual(OVERLAYS.filter(o => o.on).length, 2, 'exactly two overlays default on');
});

test('WE-2.1b each overlay toggles independently and the count follows', () => {
    const OVERLAYS = build(['worldOverlays'], 'worldOverlays()');
    const toggle = build(['worldOverlays', 'worldToggleOverlay'],
        'worldToggleOverlay', 'const WORLD = { overlays: null };');

    // A toggle that flips the wrong entry, or all of them, is the failure here.
    const state = {};
    for (const o of OVERLAYS) state[o.id] = !!o.on;
    for (const o of OVERLAYS) {
        const before = { ...state };
        state[o.id] = !state[o.id];
        const changed = Object.keys(state).filter(k => state[k] !== before[k]);
        assert.deepStrictEqual(changed, [o.id], `toggling ${o.id} changed ${changed.join(', ')}`);
    }
    assert.strictEqual(typeof toggle, 'function', 'there is no toggle');
});

// ══ WE-2.2 · lenses ═════════════════════════════════════════════════════════

test('WE-2.2 all twelve lens buttons are offered, and FOV is derived not looked up', () => {
    const want = designLenses();
    const LENSES = build(['worldLenses'], 'worldLenses()');
    assert.deepStrictEqual(LENSES, want,
        `the console offers ${LENSES.join(',')} — the design draws ${want.join(',')}`);

    /*
     * The angle must be COMPUTED from the sensor, not read from a table. A
     * lookup agrees with previs-camera today and drifts the first time a sensor
     * is added — and the console would then disagree with the stage about what
     * the same lens sees.
     */
    const src = fn('worldSetLens') + fn('worldFovFor');
    assert.match(src, /Math\.atan|previsFov/,
        'the console looks the angle up instead of deriving it from the sensor');

    // Held to the server's own optics, which is the one statement of the rule.
    const { fieldOfView, sensorFor, SENSORS } = require('../lib/previs-camera');
    const s35 = sensorFor('super35');
    const fov = build(['worldFovFor'], 'worldFovFor');
    for (const mm of want) {
        const mine = fov(mm, s35.widthMm, s35.heightMm);
        const theirs = fieldOfView(mm, s35);
        assert.ok(Math.abs(mine.hDeg - theirs.hDeg) < 0.01,
            `${mm}mm: console says ${mine.hDeg.toFixed(2)}°, previs-camera says ${theirs.hDeg.toFixed(2)}°`);
    }
});

// ══ WE-2.3 · the framing modes ══════════════════════════════════════════════

test('WE-2.3 Keep Position and Maintain Size behave oppositely', () => {
    const apply = build(['worldApplyLens'], 'worldApplyLens');

    // Keep position: the camera holds, and the subject's size follows the lens.
    const keep = apply({ mode: 'keep', focalMm: 18, distanceM: 10, occupancy: 0.5 }, 36);
    assert.strictEqual(keep.distanceM, 10, 'keep-position moved the camera');
    assert.ok(keep.occupancy > 0.5, 'keep-position did not grow the subject on a longer lens');

    // Maintain size: occupancy is PINNED at what it was when the mode engaged,
    // and the camera dollies instead.
    const hold = apply({ mode: 'maintain', focalMm: 18, distanceM: 10, occupancy: 0.5, pinned: 0.5 }, 36);
    assert.ok(Math.abs(hold.occupancy - 0.5) < 1e-9,
        `maintain-size let occupancy move to ${hold.occupancy}`);
    assert.ok(hold.distanceM > 10, 'maintain-size did not dolly the camera');

    // Doubling the lens doubles the distance — the relation is the optics, not a fudge.
    assert.ok(Math.abs(hold.distanceM - 20) < 0.01,
        `36mm on a 10m 18mm setup should sit at 20m, got ${hold.distanceM}`);

    /*
     * And the BUTTON has to follow the mode. It was rendered with `active`
     * hardcoded on Keep Position, so the console showed Keep highlighted while
     * the hint underneath said the camera was dollying — the panel disagreeing
     * with itself about which mode is engaged.
     */
    const html = (mode) => build(['worldConsoleHtml', 'worldFrameRatio', 'worldMeasurements',
                                  'worldLenses', 'worldOverlays', 'worldOverlayMenuHtml',
                                  'worldTimelineHtml', 'worldEases'],
        'worldConsoleHtml({}, null, null)',
        `const PREVIS = { taxonomy: null };\n`
        + `const WORLD = { lens: 35, overlays: null, mode: '${mode}', moves: [], keys: [], t: 0, ease: 'ease-out', durationMs: 4000 };\n`
        + 'const esc = (v) => String(v == null ? "" : v);');
    assert.match(html('keep'), /we-mode active" data-mode="keep"/, 'Keep Position is not shown as active in keep mode');
    assert.match(html('maintain'), /we-mode active" data-mode="maintain"/, 'Maintain Size is not shown as active in maintain mode');
    assert.ok(!/we-mode active" data-mode="keep"/.test(html('maintain')),
        'both modes read as active — the panel disagrees with itself');
});

// ══ WE-2.4 · occupancy ══════════════════════════════════════════════════════

test('WE-2.4 occupancy is projected geometry, not the design demo formula', () => {
    const occ = build(['worldOccupancy'], 'worldOccupancy');

    // A subject twice as tall fills more of the frame at the same distance.
    const small = occ({ w: 100, h: 100 }, { x: 10, y: 10, w: 20, h: 20 });
    const big = occ({ w: 100, h: 100 }, { x: 10, y: 10, w: 40, h: 40 });
    assert.ok(big.area > small.area, 'a larger projected box did not read as more of the frame');
    assert.ok(Math.abs(small.width - 0.20) < 1e-9, `width fraction was ${small.width}`);
    assert.ok(Math.abs(small.area - 0.04) < 1e-9, `area fraction was ${small.area}`);

    // Clamped to the frame: a subject overflowing the gate is 100%, not 400%.
    const over = occ({ w: 100, h: 100 }, { x: -50, y: -50, w: 200, h: 200 });
    assert.ok(over.area <= 1, `an overflowing subject reported ${over.area} of the frame`);

    /*
     * The design's `58 x lens / 18` is DEMO DATA. It is a plausible-looking
     * number that describes nothing, and shipping it would give the console
     * confident occupancy figures for a subject it never measured.
     */
    const src = fn('worldOccupancy');
    assert.ok(!/58\s*\*|\*\s*58|\/\s*18\b/.test(src),
        'the design\'s demo occupancy formula reached the shipped calculation');
});

// ══ WE-2.5 · no demo data ═══════════════════════════════════════════════════

test('WE-2.5 no demo string from the design ships in the page', () => {
    /*
     * The design is full of one film's content — Maple Street, Maya, the
     * Dragon, WLD-031. A console wired to those renders perfectly in a
     * screenshot and describes nothing, which is how a home page once got half
     * built and read as finished.
     */
    const DEMO = ['Maple Street', 'WLD-031', 'SEQ 02 / DRAGON ATTACK', 'HEROIC LOW',
                  'span 11.2m', '25.7m', 'dp-agent v4', 'COOKE S4'];
    const console_ = UI.slice(UI.indexOf('function worldConsoleHtml'));
    const leaked = DEMO.filter(d => console_.includes(d));
    assert.deepStrictEqual(leaked, [],
        `demo data from the design shipped in the console: ${leaked.join(', ')}`);
});

// ══ WE-2.6 / 2.7 · the frame ════════════════════════════════════════════════

test('WE-2.6 the frame follows the project aspect, not a constant', () => {
    const ratio = build(['worldFrameRatio'], 'worldFrameRatio');
    const CASES = [['2.39:1', 2.39], ['1.85:1', 1.85], ['16:9', 16 / 9], ['4:3', 4 / 3]];
    for (const [label, expected] of CASES) {
        const got = ratio({ aspect_ratio: label });
        assert.ok(Math.abs(got - expected) < 0.01, `${label} produced ${got}`);
    }
    // A project that states nothing gets the engine's own default, not 2.39.
    assert.ok(Math.abs(ratio({}) - 16 / 9) < 0.01, 'an unset aspect did not fall back to 16:9');

    /*
     * And the frame must KEEP that shape when it is capped for height. A
     * `max-height` on a full-width box clamps the height and the element stops
     * conforming to its aspect-ratio — measured in a browser at 2.28 on a 16:9
     * project. The cap has to be applied to the width, derived from the ratio.
     */
    const html = build(['worldConsoleHtml', 'worldFrameRatio', 'worldMeasurements',
                        'worldLenses', 'worldOverlays', 'worldOverlayMenuHtml',
                        'worldTimelineHtml', 'worldEases'],
        "worldConsoleHtml({ aspect_ratio: '2.39:1' }, null, null)",
        'const PREVIS = { taxonomy: null };\n'
        + 'const WORLD = { lens: 35, overlays: null, moves: [], keys: [], t: 0, '
        + 'ease: "ease-out", durationMs: 4000 };\n'
        + 'const esc = (v) => String(v == null ? "" : v);');
    assert.match(html, /aspect-ratio:\s*2\.39/, 'the frame does not carry the project ratio');
    assert.match(html, /max-width:\s*min\(100%,\s*calc\(52vh \* 2\.39\)\)/,
        'the height cap is not derived from the ratio, so the frame loses its shape');
    assert.ok(!/\.we-frame[^}]*max-height/.test(UI),
        'a max-height on the frame clamps the height and breaks the aspect ratio');
});

test('WE-2.7 the frame says it is a geometric plate', () => {
    const html = UI.slice(UI.indexOf('function worldConsoleHtml'));
    assert.match(html, /GEOMETRIC PLATE — NOT FINAL/,
        'the frame does not say it is framing truth rather than beauty — a director '
        + 'reads a deliberately ugly render as a failed final image');
});

// ══ WE-2.8 · modals ═════════════════════════════════════════════════════════

test('WE-2.8 both console modals are opened through the stacking helper', () => {
    for (const opener of ['worldOpenCreate', 'worldOpenMatchReference']) {
        const src = fn(opener);
        assert.match(src, /showModal\(/,
            `${opener} does not go through showModal — it would paint behind the console, `
            + 'the confirmation-behind-the-sheet bug on the two modals that gate spending');
        assert.ok(!/classList\.add\('open'\)/.test(src),
            `${opener} adds the class directly, bypassing the depth the stack assigns`);
    }
});

// ══ WE-2.9 · measurements ═══════════════════════════════════════════════════

test('WE-2.9 measurements come from the world, and say when they cannot', () => {
    const measure = build(['worldMeasurements'], 'worldMeasurements');

    // Calibrated: real metres.
    const known = measure({ scale_factor: 0.8227 }, [{ name: 'MAYA', distance: 31.2 }]);
    assert.match(known.state, /CALIBRATED/i);
    assert.ok(Math.abs(known.subjects[0].metres - 31.2 * 0.8227) < 1e-6,
        'the scale factor was not applied to the distance');

    // Uncalibrated: NOT a number dressed as metres.
    const unknown = measure({ scale_factor: null }, [{ name: 'MAYA', distance: 31.2 }]);
    assert.match(unknown.state, /APPROXIMATE/i);
    assert.strictEqual(unknown.subjects[0].metres, null,
        'an uncalibrated world reported a distance in metres — a confident wrong number');
});

// ══ WE-2.10 · the flag ══════════════════════════════════════════════════════

test('WE-2.10 with the flag off the console builds nothing', () => {
    const render = fn('worldConsoleRender');
    assert.match(render, /worldEngineOn\(\)|FLAGS\.world_engine|flagOn\('world_engine'\)/,
        'the console renders without consulting the flag');

    /*
     * And it is INJECTED, not hidden. A console that ships as markup and is
     * merely display:none still changes the page every existing previs test
     * reads, and "byte-identical with the flag off" stops being true.
     */
    assert.ok(!/id="worldConsole"/.test(UI.slice(0, UI.indexOf('function worldConsoleHtml'))),
        'the console container is static markup — it must be built at runtime');

    // CALL it, do not merely fetch it: the first version compared the function
    // object against undefined and passed whatever the body did.
    let built = 0;
    /*
     * And it must be CALLED. Declaring a renderer and invoking it from nowhere
     * looks identical to a working console until somebody opens the page —
     * which is exactly how this shipped the first time.
     */
    const loader = fn('loadPrevisPage');
    assert.match(loader, /worldLoadFlags\(\)/, 'the page never reads the flags');
    assert.match(loader, /worldConsoleRender\(\)/, 'loadPrevisPage never builds the console');

    const off = build(['worldConsoleRender'],
        'worldConsoleRender()',
        'function worldEngineOn() { return false; }\n'
        + 'const document = { getElementById: () => { throw new Error("touched the page"); } };');
    assert.strictEqual(off, undefined, 'the console returned something with the flag off');
    assert.strictEqual(built, 0);
});

test('WE-2.10c a flag turned OFF reads as off, whatever the store did to it', () => {
    /*
     * film_app_settings stores TEXT. A boolean written as `false` came back as
     * the STRING "false" — which is truthy — so the console rendered with the
     * switch off. Measured in a browser: world_engine = false, console still
     * injected. A switch you flip and watch do nothing.
     *
     * Set-based over every way "off" can arrive, because the string is only one
     * of them and a guard that catches `false` and not `'false'` is the bug.
     */
    const flagOn = build(['worldFlagOn'], 'worldFlagOn', 'let WORLD_FLAGS = {};');
    const OFF = [false, 'false', 'False', '0', '', '  ', 'off', null, undefined];
    const ON = [true, 'true', '1', 'on', 'yes'];

    const wrongOff = OFF.filter(v => {
        const f = build(['worldFlagOn'], 'worldFlagOn', `let WORLD_FLAGS = { x: ${JSON.stringify(v)} };`);
        return f('x') === true;
    });
    assert.deepStrictEqual(wrongOff, [], `these read as ON when they mean off: ${wrongOff.map(v => JSON.stringify(v)).join(', ')}`);

    const wrongOn = ON.filter(v => {
        const f = build(['worldFlagOn'], 'worldFlagOn', `let WORLD_FLAGS = { x: ${JSON.stringify(v)} };`);
        return f('x') !== true;
    });
    assert.deepStrictEqual(wrongOn, [], `these read as OFF when they mean on: ${wrongOn.join(', ')}`);
    assert.strictEqual(typeof flagOn, 'function');
});

test('WE-2.10d a boolean setting round-trips its own type', () => {
    // The root cause, fixed at the store: the default declares the type, so a
    // boolean is stored and returned as a boolean rather than as "false".
    const src = fs.readFileSync(path.join(ROOT, 'backend', 'routes', 'app-settings.js'), 'utf8');
    assert.match(src, /function serialiseLike/, 'writes do not respect the declared type');
    assert.match(src, /function castLike/, 'reads do not respect the declared type');
    assert.ok(!/upsert\.run\(key, String\(body\[key\]\)\)/.test(src),
        'a boolean is still stringified on write — false becomes "false", which is truthy');
});

test('WE-2.10b the classic previs stage is removed, and the console loads its own shots', () => {
    // The old stage was removed (it was the second section under the console).
    // With it gone the console must stand alone: its shot rail loads itself,
    // and picking a shot loads that shot's world.
    const page = UI.slice(UI.indexOf('<div class="page" id="page-previs">'), UI.indexOf('<div class="page" id="page-pipeline">'));
    assert.ok(!/previs-workspace|previsShotSelect/.test(page), 'the classic stage is still on the page');
    const loader = UI.slice(UI.indexOf('async function loadPrevisPage()'), UI.indexOf('async function loadPrevisPage()') + 2000);
    assert.match(loader, /worldLoadShots\(/, 'the console never loads its own shots, so its rail is empty');
    assert.match(loader, /worldRailSelect\(/, 'no shot is opened');
    const select = UI.slice(UI.indexOf('async function worldRailSelect('), UI.indexOf('async function worldRailSelect(') + 1200);
    assert.match(select, /worldLoadForShot\(/, 'picking a shot does not load its world');
});
