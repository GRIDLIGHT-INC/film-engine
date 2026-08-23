/**
 * The six critique findings on the freed camera.
 *
 * Every one is a consequence of the camera gaining degrees of freedom it did
 * not have. Yaw was pinned to zero, so there was no ±180 seam to cross, no
 * camera-local direction to get backwards, no pose controls to leave out of the
 * staged binding, and no reason for a browser to sample a path at all. Opening
 * the camera opened all of them at once.
 *
 * Their shared shape is the one this codebase keeps paying for: TWO PLACES
 * DESCRIBE ONE THING and drift apart. A hand-written binding list beside the
 * reader it is supposed to mirror. A browser sampler beside the server's. A
 * unit label beside numbers in a different unit. None of it fails loudly; it
 * fails by quietly describing a different shot than the one on screen.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');

const {
    sampleCameraKeys, analyzePath, MOVEMENTS,
} = require('../lib/previs-blocking');

/** Lift one browser function out of the single-html SPA and run it in node. */
function runFn(name, ...args) {
    const start = HTML.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is not defined in the SPA`);
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') depth++;
        else if (HTML[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    const src = HTML.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(`${src}; return ${name}(${args.map(a => JSON.stringify(a)).join(',')});`)();
}

function stripComments(src) {
    let out = ''; let i = 0; let mode = null; let quote = '';
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (mode === null) {
            if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
            if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
            if (c === '"' || c === "'") { mode = 'str'; quote = c; out += c; i++; continue; }
            if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (mode === 'line') { if (c === '\n') { mode = null; out += c; } i++; continue; }
        if (mode === 'block') { if (c === '*' && d === '/') { mode = null; i += 2; } else i++; continue; }
        if (mode === 'str') { out += c; if (c === '\\') { out += d; i += 2; continue; } if (c === quote) mode = null; i++; continue; }
        out += c; if (c === '\\') { out += d; i += 2; continue; } if (c === '`') mode = null; i++;
    }
    return out;
}
const UI = stripComments(HTML.replace(/<!--[\s\S]*?-->/g, ''));

// ── #1 The picker must show what exists ────────────────────────────────────

test('#1 the model catalogue reaches the picker it was loaded for', () => {
    /*
     * loadPrevisPage calls previsLoadModels() without awaiting, and the loader
     * only assigns PREVIS.models — it re-renders nothing. So the first paint of
     * the object rows reads "No models generated yet" with models sitting in the
     * database, and stays wrong until some unrelated action rebuilds the DOM.
     *
     * "This way we can load them" is half the director's ask, and a picker that
     * shows nothing is indistinguishable from having generated nothing.
     */
    const page = UI.match(/async function loadPrevisPage\(\)[\s\S]*?\n    \}/);
    assert.ok(page, 'loadPrevisPage is gone');
    const loader = UI.match(/async function previsLoadModels\(\)[\s\S]*?\n    \}/);
    assert.ok(loader, 'previsLoadModels is gone');

    const awaited = /await\s+previsLoadModels\s*\(/.test(page[0]);
    const rerenders = /previsRenderObjects\s*\(|previsRefresh\s*\(/.test(loader[0]);
    assert.ok(awaited || rerenders,
        'previsLoadModels is neither awaited before the picker renders nor re-renders '
        + 'when it lands, so the catalogue arrives after the only paint that would show it');
});

// ── #2 Every control a director can touch marks the stage ──────────────────

test('#2 every camera control the inspector reads marks the stage staged', () => {
    /*
     * Staged-marking is bound from a hand-written array of element ids, and the
     * pose controls added with the freed camera are not in it. So a director can
     * change the camera numerically on an APPLIED shot and the badge goes on
     * reading applied — the 3b boundary from the previous confer, breached by
     * the first controls added after it.
     *
     * The list being hand-written IS the defect, so the expectation is derived
     * from previsReadInspector's own num()/value reads: anything the inspector
     * READS is something a director can change, and everything a director can
     * change must mark the stage. A control added next month is covered with
     * nothing to remember.
     */
    const reader = UI.match(/function previsReadInspector\(\)[\s\S]*?\n    \}/);
    assert.ok(reader, 'previsReadInspector is gone');

    const read = new Set();
    for (const m of reader[0].matchAll(/num\(\s*'([A-Za-z0-9_]+)'/g)) read.add(m[1]);
    for (const m of reader[0].matchAll(/getElementById\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) read.add(m[1]);
    assert.ok(read.size >= 10, `derived only ${read.size} inspector controls — the derivation is wrong`);

    // A control marks the stage either by being in the bound list or by calling
    // previsMarkStaged from its own markup.
    const bound = new Set();
    const list = UI.match(/\[\s*'previsShotType'[\s\S]{0,600}?\]\s*\.forEach/);
    if (list) for (const m of list[0].matchAll(/'([A-Za-z0-9_]+)'/g)) bound.add(m[1]);

    const inline = new Set();
    for (const m of HTML.matchAll(/id="([A-Za-z0-9_]+)"[^>]*previsMarkStaged/g)) inline.add(m[1]);
    for (const m of HTML.matchAll(/previsMarkStaged[^>]*id="([A-Za-z0-9_]+)"/g)) inline.add(m[1]);

    const silent = [...read].filter(id => !bound.has(id) && !inline.has(id));
    assert.deepStrictEqual(silent, [],
        'these controls change the staged camera without marking it staged, so an applied '
        + 'shot goes on reporting applied while the stage has moved underneath it');
});

// ── #3 The ±180 seam ───────────────────────────────────────────────────────
//
// Set-based over seam-crossing pairs, because they fail independently: a fix
// that wraps the sampler and not the analyzer leaves the prompt naming the
// opposite move, and a fix that wraps positive crossings and not negative ones
// passes half of these.

const SEAM_PAIRS = [
    { id: '350->10',    from: 350,  to: 10,    shortest: 20 },
    { id: '10->350',    from: 10,   to: 350,   shortest: -20 },
    { id: '170->-170',  from: 170,  to: -170,  shortest: 20 },
    { id: '-170->170',  from: -170, to: 170,   shortest: -20 },
    { id: '179->-179',  from: 179,  to: -179,  shortest: 2 },
];

const degKey = (t, yaw) => ({ t, position: [0, 1.6, 3], rotation: [yaw, 0, 0],
    focalMm: 50, rotationUnit: 'degrees' });

test('#3 yaw interpolation takes the short way across the seam', () => {
    const wrong = [];
    for (const pair of SEAM_PAIRS) {
        const sampled = sampleCameraKeys([degKey(0, pair.from), degKey(1, pair.to)], { frames: 9 });
        // Total swept angle, measured as the sum of shortest per-step deltas.
        let swept = 0;
        for (let i = 1; i < sampled.length; i++) {
            let d = sampled[i].rotation[0] - sampled[i - 1].rotation[0];
            while (d > 180) d -= 360;
            while (d < -180) d += 360;
            swept += d;
        }
        if (Math.abs(swept - pair.shortest) > 1) {
            wrong.push(`${pair.id}: swept ${swept.toFixed(1)}° where the short way is ${pair.shortest}°`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera spins the long way round the seam');
});

test('#3 a seam crossing is named as the move it actually is', () => {
    /*
     * The sampler and the analyzer must agree. Wrapping one and not the other
     * is worse than wrapping neither: the picture would move one way while the
     * prompt and camera_control.type describe the other.
     */
    const wrong = [];
    for (const pair of SEAM_PAIRS) {
        const named = analyzePath([degKey(0, pair.from), degKey(1, pair.to)]);
        const expected = pair.shortest > 0 ? 'pan-left' : 'pan-right';
        if (named.dominantMovement !== expected) {
            wrong.push(`${pair.id}: named '${named.dominantMovement}', short way is ${pair.shortest}° (${expected})`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'a seam crossing is described as the opposite move');
});

// ── #4 One sampling contract, not two ──────────────────────────────────────

const PARITY_SHAPES = [
    { id: 'endpoints',        keys: [degKey(0, 0), degKey(1, 40)] },
    { id: 'no-endpoints',     keys: [degKey(0.25, 0), degKey(0.75, 40)] },
    { id: 'duplicate-times',  keys: [degKey(0, 0), degKey(0.5, 20), degKey(0.5, 30), degKey(1, 40)] },
    { id: 'unsorted',         keys: [degKey(1, 40), degKey(0, 0)] },
    { id: 'seam-crossing',    keys: [degKey(0, 170), degKey(1, -170)] },
    { id: 'three-legs',       keys: [degKey(0, 0), degKey(0.5, 90), degKey(1, 0)] },
];

test('#4 the browser and the server sample the same keys the same way', () => {
    /*
     * previsSampleCameraKeys in the SPA is a SECOND IMPLEMENTATION of
     * sampleCameraKeys — the same loop and the same mix, one clamp apart. That
     * is the defect rather than the clamp: the seam fix has to land in both, and
     * whichever is fixed second is a window in which a director approves one
     * path and generation stores another.
     *
     * Held to one OUTCOME over a derived set of key shapes rather than to one
     * clamp, so any future divergence fails here whatever causes it.
     */
    const drift = [];
    for (const shape of PARITY_SHAPES) {
        const server = sampleCameraKeys(shape.keys, { frames: 7 });
        let client;
        try { client = runFn('previsSampleCameraKeys', shape.keys, 7); }
        catch (err) { drift.push(`${shape.id}: the browser sampler would not run (${err.message})`); continue; }

        if (!Array.isArray(client) || client.length !== server.length) {
            drift.push(`${shape.id}: ${server.length} server frames vs ${client && client.length} in the browser`);
            continue;
        }
        for (let i = 0; i < server.length; i++) {
            const s = server[i], c = client[i];
            const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
            const same = s.position.every((v, x) => near(v, c.position[x]))
                && s.rotation.every((v, x) => near(v, c.rotation[x]))
                && near(s.focalMm, c.focalMm);
            if (!same) {
                drift.push(`${shape.id} frame ${i}: server ${JSON.stringify(s.position)}/${JSON.stringify(s.rotation)}`
                    + ` vs browser ${JSON.stringify(c.position)}/${JSON.stringify(c.rotation)}`);
                break;
            }
        }
    }
    assert.deepStrictEqual(drift, [],
        'the path the director previews is not the path the server stores');
});

// ── #5 One unit, or a refusal ──────────────────────────────────────────────

test('#5 a mixed-unit key list is never blended into a fabricated move', () => {
    /*
     * 90 degrees and 1.5708 radians are THE SAME ANGLE, so a camera authored
     * with one key in each has not moved. sampleCameraKeys picks one label and
     * interpolates both numbers raw, producing 90 -> 45.785 -> 1.571 labelled
     * degrees: a ninety-degree sweep invented out of a stationary camera.
     *
     * rotationUnit exists precisely to remove the guess that three might mean
     * three degrees or three radians, and mixing is the case it does not cover.
     * It is reachable the moment a browser-authored key sits beside one derived
     * from a glTF. Normalising or refusing are both fine; blending is not.
     */
    const mixed = [
        { t: 0, position: [0, 1.6, 3], rotation: [90, 0, 0], focalMm: 50, rotationUnit: 'degrees' },
        { t: 1, position: [0, 1.6, 3], rotation: [Math.PI / 2, 0, 0], focalMm: 50, rotationUnit: 'radians' },
    ];

    let sampled = null;
    try { sampled = sampleCameraKeys(mixed, { frames: 5 }); }
    catch (_) { return; }   // refusing is a legitimate answer

    const unit = sampled[0] && sampled[0].rotationUnit;
    const toDeg = v => (unit === 'degrees' ? Number(v) : Number(v) * 180 / Math.PI);
    const spread = sampled.map(k => toDeg(k.rotation[0]));
    const swing = Math.max(...spread) - Math.min(...spread);
    assert.ok(swing < 1,
        `two keys describing the same angle in different units produced a ${swing.toFixed(1)}° `
        + `sweep (${spread.map(v => v.toFixed(1)).join(' -> ')}), labelled '${unit}'`);
});

// ── #6 A threshold a person could see ──────────────────────────────────────

test('#6 sub-perceptual rotation is not narrated as a camera move', () => {
    /*
     * analyzePath thresholds rotation at a tenth of a degree while translation
     * is a centimetre. A tenth of a degree is invisible, so noise on a dragged
     * camera can put "pan left while tilt up while roll clockwise" into a
     * prompt — and whatever is in the prompt is what the model tries to draw.
     * Half a degree is the agreed floor; a real half-degree-plus move must
     * still register, or the fix has traded one wrong answer for another.
     */
    const tiny = analyzePath([degKey(0, 0), degKey(1, 0.2)]);
    assert.strictEqual(tiny.dominantMovement, 'static',
        `a fifth of a degree was narrated as '${tiny.description}'`);

    const real = analyzePath([degKey(0, 0), degKey(1, 12)]);
    assert.strictEqual(real.dominantMovement, 'pan-left',
        `a twelve-degree pan was swallowed as '${real.dominantMovement}'`);
    assert.ok(MOVEMENTS[real.dominantMovement], 'the named move is not a real MOVEMENTS id');
});

// ── #4b Both samplers held to one recorded outcome ─────────────────────────

test('#4b neither sampler drifts from the corrected sampling contract', () => {
    /*
     * The parity test above holds the two samplers to EACH OTHER, which catches
     * one diverging and is blind to both moving together — a rewritten
     * interpolation, a changed rotation order, an easing applied in the shared
     * helper. Two implementations kept in step by a mutual test can still walk
     * off in the same direction.
     *
     * So the corrected behaviour is recorded. Deliberately NOT captured during
     * the critique round: at that point the sampler took the long way round the
     * seam, and freezing it would have made the bug the specification. It is
     * worth freezing now that seam-crossing frame 1 reads 173.33 (the short
     * way) and no-endpoints frame 0 reads 0 (clamped) — both of which are the
     * fixes, visible in the fixture.
     *
     * Same precedent and same rule as previs-preset-paths.json: if a sampled
     * value legitimately has to change, move it deliberately and say why.
     * Regenerating it to go green deletes the guarantee instead of checking it.
     */
    const golden = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures/previs-key-sampling.json'), 'utf8'));

    const shapes = Object.fromEntries(PARITY_SHAPES.map(s => [s.id, s.keys]));
    assert.deepStrictEqual(Object.keys(shapes).sort(), Object.keys(golden).sort(),
        'the parity shapes and the recorded fixture describe different sets');

    const round = frame => ({
        t: +Number(frame.t).toFixed(6),
        position: frame.position.map(v => +Number(v).toFixed(6)),
        rotation: frame.rotation.map(v => +Number(v).toFixed(6)),
        focalMm: +Number(frame.focalMm).toFixed(6),
    });

    const drifted = [];
    for (const [id, keys] of Object.entries(shapes)) {
        const server = sampleCameraKeys(keys, { frames: 7 }).map(round);
        if (JSON.stringify(server) !== JSON.stringify(golden[id])) drifted.push(`server:${id}`);

        let client;
        try { client = runFn('previsSampleCameraKeys', keys, 7).map(round); }
        catch (err) { drifted.push(`browser:${id} would not run (${err.message})`); continue; }
        if (JSON.stringify(client) !== JSON.stringify(golden[id])) drifted.push(`browser:${id}`);
    }
    assert.deepStrictEqual(drifted, [],
        'a sampler no longer produces the path recorded when the seam and clamp were fixed');
});
