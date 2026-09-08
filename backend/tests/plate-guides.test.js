/**
 * LEVEL, GRID AND ASPECT GUIDE — GRD-3656 / PCC-005.
 *
 * A crooked location plate is re-photographed from in every shot of that scene,
 * and a plate framed for 16:9 is the wrong shape for a 9:16 deliverable. Three
 * guides, none of which touches a capture API — the first task in this epic
 * with no lens-change interaction, because none of it lives on the device.
 *
 * TWO PIECES OF REAL ARITHMETIC, and both have a failure that looks like
 * success:
 *
 *   THE ASPECT GUIDE inverts. Letterbox and pillarbox are the same computation
 *   with the comparison the other way round, so a guide that is wrong is still
 *   a neat centred rectangle — it just marks the wrong crop, and a director
 *   frames to it.
 *
 *   THE LEVEL IS UNDEFINED WHERE IT IS MOST USED. Roll comes from the gravity
 *   vector, and when the phone points straight down — photographing a prop on a
 *   table, which is an ordinary plate shot — the horizontal component vanishes
 *   and roll is mathematically meaningless. `atan2(0, 0)` is 0 in Swift, so the
 *   naive implementation reports "level" with total confidence at exactly the
 *   moment it knows nothing.
 *
 * As in the three tasks before it, the arithmetic is extracted from the
 * shipping source and EXECUTED rather than read.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const SPA = path.join(__dirname, '..', '..', 'src', 'index.html');
const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use; that has cost eight false passes here. */
const code = () => src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH — never by a character window. */
function extract(header) {
    const s = src();
    const at = s.indexOf(header);
    assert.notStrictEqual(at, -1,
        `PlateCamera.swift declares no '${header}'. If it was renamed this test cannot see the `
        + 'arithmetic it exists to check, and would pass by finding nothing');
    const open = s.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) break;
    }
    return s.slice(at, i + 1);
}

let COMPILED = null;
/** Compile PlateGuides once and drive it with whatever expressions are asked for. */
function run(exprs, printer) {
    const body = extract('enum PlateGuides');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-guides-'));
    const file = path.join(dir, 'main.swift');
    fs.writeFileSync(file, `import Foundation
${body}
let out = [
  ${exprs.join(',\n  ')}
]
print(out.map { ${printer} }.joined(separator: ";"))
`);
    const bin = path.join(dir, `probe${Math.random().toString(36).slice(2)}`);
    execFileSync('swiftc', ['-O', '-o', bin, file], { stdio: 'pipe' });
    return execFileSync(bin, { encoding: 'utf8' }).trim().split(';');
}

const rects = (cases) => run(
    cases.map(c => `PlateGuides.deliveryRect(delivery: ${c.d}, sensor: ${c.s})`),
    '"\\($0.x),\\($0.y),\\($0.width),\\($0.height)"'
).map(r => {
    const [x, y, width, height] = r.split(',').map(Number);
    return { x, y, width, height };
});

const levels = (cases) => run(
    cases.map(c => `PlateGuides.level(gx: ${c.gx}, gy: ${c.gy}, gz: ${c.gz})`),
    '"\\($0.rollDegrees),\\($0.pitchDegrees),\\($0.rollIsMeaningful)"'
).map(r => {
    const [roll, pitch, meaningful] = r.split(',');
    return { roll: Number(roll), pitch: Number(pitch), rollIsMeaningful: meaningful === 'true' };
});

/* ── the aspect guide ───────────────────────────────────────────────────── */

/**
 * SET-BASED over both directions plus the equal case, because letterbox and
 * pillarbox are one computation with the comparison flipped: an implementation
 * that gets one right and the other inverted still draws a tidy centred
 * rectangle, and a director frames to it.
 */
const RECTS = [
    { name: '16:9 in a 4:3 sensor (letterbox)', d: 16 / 9, s: 4 / 3, wide: true },
    { name: '9:16 in a 4:3 sensor (pillarbox)', d: 9 / 16, s: 4 / 3, wide: false },
    { name: '2.39:1 in a 4:3 sensor',            d: 2.39,   s: 4 / 3, wide: true },
    { name: '1:1 in a 4:3 sensor',               d: 1,      s: 4 / 3, wide: false },
    { name: '4:3 in a 4:3 sensor (exact)',       d: 4 / 3,  s: 4 / 3, wide: null },
];

test('EVERY delivery aspect is inscribed in the sensor, centred, and never overflows', () => {
    const got = rects(RECTS);
    const bad = [];
    RECTS.forEach((c, i) => {
        const r = got[i];
        if (r.width > 1 + 1e-9 || r.height > 1 + 1e-9 || r.x < -1e-9 || r.y < -1e-9) {
            bad.push(`${c.name}: ${JSON.stringify(r)} overflows the sensor`);
        }
        if (Math.abs(r.x * 2 + r.width - 1) > 1e-6 || Math.abs(r.y * 2 + r.height - 1) > 1e-6) {
            bad.push(`${c.name}: not centred — ${JSON.stringify(r)}`);
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('the guide has the aspect it was ASKED for, not merely a plausible shape', () => {
    /*
     * The check that catches an inversion. A flipped comparison still produces
     * a centred rect that fits; what it does not produce is the requested
     * ratio, once the sensor ratio is divided back out.
     */
    const got = rects(RECTS);
    const bad = RECTS.map((c, i) => {
        const r = got[i];
        const drawn = (r.width / r.height) * c.s;   // back into real-world aspect
        return Math.abs(drawn - c.d) > 1e-4
            ? `${c.name}: drew ${drawn.toFixed(4)} where ${c.d.toFixed(4)} was asked for`
            : null;
    }).filter(Boolean);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a wider delivery uses the FULL WIDTH and a narrower one the FULL HEIGHT', () => {
    // States the inversion directly, in the words a person would use.
    const got = rects(RECTS);
    const bad = [];
    RECTS.forEach((c, i) => {
        const r = got[i];
        if (c.wide === true && Math.abs(r.width - 1) > 1e-6) {
            bad.push(`${c.name} is wider than the sensor and does not fill its width (${r.width})`);
        }
        if (c.wide === false && Math.abs(r.height - 1) > 1e-6) {
            bad.push(`${c.name} is narrower and does not fill its height (${r.height})`);
        }
        if (c.wide === null && (Math.abs(r.width - 1) > 1e-6 || Math.abs(r.height - 1) > 1e-6)) {
            bad.push(`${c.name} matches the sensor and should be the whole frame`);
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a degenerate aspect draws the whole frame rather than nothing or NaN', () => {
    /*
     * A project with no aspect recorded, or a malformed one, must not produce a
     * zero-area guide — an invisible guide reads as the feature being broken,
     * and a NaN rect is undefined behaviour in CoreGraphics.
     */
    const got = rects([
        { d: 0, s: 4 / 3 }, { d: -2, s: 4 / 3 }, { d: 'Double.nan', s: 4 / 3 },
        { d: 16 / 9, s: 0 }, { d: 16 / 9, s: 'Double.infinity' },
    ]);
    for (const r of got) {
        for (const v of [r.x, r.y, r.width, r.height]) {
            assert.ok(Number.isFinite(v), `degenerate input produced ${v}`);
        }
        assert.ok(r.width > 0 && r.height > 0, `degenerate input produced a zero-area guide: ${JSON.stringify(r)}`);
    }
});

/* ── the level ──────────────────────────────────────────────────────────── */

/**
 * Orientations expressed as gravity vectors, in iOS device coordinates: x
 * right, y up, z out of the screen. Gravity points DOWN, so an upright phone
 * reads (0, -1, 0).
 */
const LEVELS = [
    { name: 'upright, pointing at the horizon', gx: 0,  gy: -1, gz: 0,  roll: 0,   pitch: 0,   meaningful: true },
    { name: 'rolled a quarter turn left',       gx: -1, gy: 0,  gz: 0,  roll: -90, pitch: 0,   meaningful: true },
    { name: 'rolled a quarter turn right',      gx: 1,  gy: 0,  gz: 0,  roll: 90,  pitch: 0,   meaningful: true },
    { name: 'pointing straight down at a table', gx: 0, gy: 0,  gz: -1, roll: null, pitch: -90, meaningful: false },
    { name: 'pointing straight up',             gx: 0,  gy: 0,  gz: 1,  roll: null, pitch: 90,  meaningful: false },
];

test('EVERY orientation reports the roll and pitch a person would name', () => {
    const got = levels(LEVELS);
    const bad = [];
    LEVELS.forEach((c, i) => {
        const g = got[i];
        if (c.roll !== null && Math.abs(g.roll - c.roll) > 0.5) {
            bad.push(`${c.name}: roll ${g.roll.toFixed(1)}°, expected ${c.roll}°`);
        }
        if (Math.abs(g.pitch - c.pitch) > 0.5) {
            bad.push(`${c.name}: pitch ${g.pitch.toFixed(1)}°, expected ${c.pitch}°`);
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('roll is reported as MEANINGLESS where it is mathematically undefined', () => {
    /*
     * The failure this exists to catch, and it fires on an ordinary shot: a prop
     * photographed on a table points the phone straight down, the horizontal
     * component of gravity vanishes, and roll has no value. atan2(0, 0) is 0 in
     * Swift, so the naive version says "0° — level" with total confidence at
     * exactly the moment it knows nothing. A confident wrong level is worse than
     * no level, because a director trusts it and shoots crooked.
     */
    const got = levels(LEVELS);
    const bad = LEVELS.map((c, i) => got[i].rollIsMeaningful !== c.meaningful
        ? `${c.name}: rollIsMeaningful is ${got[i].rollIsMeaningful}, expected ${c.meaningful}`
        : null).filter(Boolean);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a zero or non-finite gravity vector does not trap', () => {
    const got = levels([
        { gx: 0, gy: 0, gz: 0 },
        { gx: 'Double.nan', gy: -1, gz: 0 },
    ]);
    for (const g of got) {
        assert.ok(Number.isFinite(g.roll) && Number.isFinite(g.pitch),
            `produced roll ${g.roll} pitch ${g.pitch}`);
        assert.strictEqual(g.rollIsMeaningful, false,
            'a gravity vector that says nothing must not report a meaningful roll');
    }
});

test('the guide maths is pure — it cannot reach AVFoundation, CoreMotion or a device', () => {
    const body = extract('enum PlateGuides')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const forbidden of ['AVCapture', 'CMMotion', 'session', 'device.']) {
        assert.ok(!body.includes(forbidden),
            `PlateGuides touches ${forbidden}; it must be arithmetic, or it cannot be tested here`);
    }
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

test('the delivery aspect comes from the PROJECT, not a constant', () => {
    /*
     * The whole point: a 9:16 deliverable must guide 9:16. The page already
     * knows the project's ratio and already parses it in one place, so the
     * camera is TOLD rather than guessing.
     */
    const s = code();
    assert.match(s, /aspect/i, 'the request carries no aspect at all');
    const req = s.slice(s.indexOf('struct PlateCaptureRequest'), s.indexOf('struct PlateCaptureResult'));
    assert.match(req, /aspect/i,
        'PlateCaptureRequest does not carry the delivery aspect, so the camera cannot know it');

    /*
     * Comments stripped. The first version matched `previsAspect()` inside the
     * COMMENT explaining why it is reused, and survived replacing the call with
     * a hardcoded 16/9 — the tenth mention-for-use false pass in this session.
     */
    const page = fs.readFileSync(SPA, 'utf8')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const shoot = page.slice(page.indexOf('function shootPlate'), page.indexOf('window.plateCameraDone'));
    assert.match(shoot, /aspect/i,
        'shootPlate never sends the aspect, so the request field is never filled');
    assert.match(shoot, /previsAspect\(\)/,
        'the page parses the ratio a second time instead of reusing previsAspect(), which is how '
        + 'two readings of one project setting come to disagree');
});

test('the capture-space rect is converted by the LAYER, not by hand', () => {
    /*
     * The preview is .resizeAspectFill, so it CROPS: the visible picture is not
     * the whole sensor. `layerRectConverted(fromMetadataOutputRect:)` knows the
     * gravity and the orientation, exactly as captureDevicePointConverted did
     * for PCC-004. Hand-rolling it draws the guide in the wrong place and does
     * so silently.
     */
    assert.match(code(), /layerRectConverted\(fromMetadataOutputRect:/,
        'the guide rect is placed by hand rather than by the preview layer, which is the only '
        + 'thing that knows how the picture is cropped on screen');
});

test('EVERY guide can be turned off independently', () => {
    /*
     * Three guides, three switches. A single toggle means a director who wants
     * the level must accept a grid over the subject they are judging.
     */
    /*
     * Bound to the row of toggles. A file-wide search for `showGrid` is
     * satisfied by the @State declaration and by the closure that reads it, so
     * it survived deleting the CONTROL — a guide with no way to turn it off.
     */
    const s = code();
    const at = s.indexOf('guideToggle(');
    assert.notStrictEqual(at, -1, 'there is no guideToggle; re-derive this check');
    const row = s.slice(s.lastIndexOf('HStack', at), s.indexOf('}', s.lastIndexOf('.padding', s.indexOf('\n', at + 400))));
    const missing = ['level', 'grid', 'aspect'].filter(g => !row.includes(`"${g}"`));
    assert.deepStrictEqual(missing, [],
        `these guides have no control a person can press: ${missing.join(', ')}`);
});

test('the guides are drawn, and the level says when it cannot be trusted', () => {
    const s = code();
    const overlay = s.slice(s.indexOf('private var overlay: some View'), s.indexOf('private func take'));
    assert.match(s, /GuideOverlay|guideOverlay/,
        'nothing draws the guides');
    /*
     * Bound to draw(). A file-wide match is satisfied by the model's own
     * property and by the label beneath the switches, and survived making the
     * DRAWN horizon ignore it — which is the confident lie this exists to stop.
     */
    const dAt = s.indexOf('override func draw(');
    assert.notStrictEqual(dAt, -1, 'GuideOverlay has no draw(); re-derive this check');
    let dp = 0, dEnd = s.indexOf('{', dAt);
    for (let i = dEnd; i < s.length; i++) {
        if (s[i] === '{') dp++; else if (s[i] === '}' && --dp === 0) { dEnd = i; break; }
    }
    assert.match(s.slice(dAt, dEnd), /tilt\.rollIsMeaningful/,
        'the DRAWN horizon ignores rollIsMeaningful, so a phone pointing straight down draws a '
        + 'confident level line that means nothing');
    assert.ok(overlay.length > 0, 'the overlay could not be located; re-derive this check');
});

test('withBase carries EVERY field of the request', () => {
    /*
     * Found by the compiler while adding `aspect`: withBase RECONSTRUCTS a
     * PlateCaptureRequest, so a field it forgets is silently dropped on every
     * request the page makes. Giving `aspect` a default of nil would have made
     * that compile and shipped a guide that never appeared.
     *
     * SET-BASED over the struct's own stored properties, so the next field
     * added is covered with nothing to remember.
     */
    const s = src();
    const req = s.slice(s.indexOf('struct PlateCaptureRequest'), s.indexOf('struct PlateCaptureResult'));
    const fields = [...req.matchAll(/^\s{4}let ([a-zA-Z]+):/gm)].map(m => m[1]);
    assert.ok(fields.length >= 4,
        `only ${fields.length} fields parsed from PlateCaptureRequest; the scan is broken and `
        + 'would report a dropped field as carried');

    const cv = fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'ContentView.swift'), 'utf8');
    const at = cv.indexOf('func withBase');
    assert.notStrictEqual(at, -1, 'withBase is gone; re-derive this check');
    const body = cv.slice(at, cv.indexOf('\n    }', at));
    /*
     * `aspect: aspect`, not merely `aspect:`. The first version matched the
     * LABEL, so `aspect: nil` — which drops it on every request — passed.
     */
    /*
     * `apiBase` is exempt BY NAME with a reason: replacing it is the entire
     * purpose of withBase, so it is the one field that must NOT be passed to
     * itself. Exempting by pattern would quietly excuse the next dropped field.
     */
    const REPLACED = { apiBase: 'withBase exists to substitute it' };
    const dropped = fields.filter(f => !REPLACED[f] && !new RegExp(`${f}:\\s*${f}\\b`).test(body));
    for (const f of Object.keys(REPLACED)) {
        assert.ok(fields.includes(f), `${f} is exempted and no longer exists; the exemption is stale`);
        assert.match(body, new RegExp(`${f}:\\s*base\\b`),
            `${f} is exempted as "substituted" and is not actually substituted`);
    }
    assert.deepStrictEqual(dropped, [],
        `withBase drops these fields, so they never reach the camera: ${dropped.join(', ')}`);
});
