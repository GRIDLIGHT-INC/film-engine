/**
 * A TURNAROUND WHOSE VIEWS DISAGREE — GRD-3661 / PCC-010.
 *
 * PCC-002 and PCC-003 hold exposure and colour across a turnaround; PCC-006
 * records what each plate was actually shot at. This is where that recording
 * earns its place: four views that disagree produce a character who changes
 * brightness or colour between the frames they condition, and the only previous
 * way to notice was to open all four and look.
 *
 * THREE THINGS DECIDE WHETHER A COMPARISON IS ANY GOOD, and each has an obvious
 * wrong version that produces a plausible answer:
 *
 *   EXPOSURE IS ISO x SHUTTER, NOT ISO AND SHUTTER. 1/60 at ISO 400 and 1/120
 *   at ISO 800 are the SAME exposure. A comparison that checks the fields
 *   separately flags an identical pair of plates and sends a director to
 *   re-shoot a turnaround that was correct.
 *
 *   WHITE BALANCE IS COMPARED IN MIRED, NOT KELVIN. The scale is reciprocal:
 *   200K at 3000K is a visible shift and 200K at 8000K is not. A comparison in
 *   Kelvin flags the second and misses nothing — but a tolerance loose enough
 *   to pass 8000K silently accepts a real shift down at tungsten, which is
 *   exactly where plates get shot.
 *
 *   A VIEW WITH NO SETTINGS IS UNCOMPARABLE, NOT AGREEING. Every plate shot
 *   before PCC-006 has none, and reporting "these agree" over an empty set is
 *   the most misleading answer available — it is the reassuring one.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-consist-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { CAPTURE_FIELDS } = require('../lib/capture-settings');
const { compareViews, TOLERANCES } = require('../lib/plate-consistency');

/** A view as the comparison receives it. */
const v = (view, capture) => ({ view, capture });

/*
 * SET-BASED over the WAYS A TURNAROUND CAN DISAGREE, derived from PCC-006's own
 * CAPTURE_FIELDS rather than from examples — a comparison that catches exposure
 * and ignores the lens passes any test built from one case.
 */
const CASES = [
    {
        name: 'four identical views',
        views: [v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
                v('side-left', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
                v('side-right', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
                v('back', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 })],
        agree: true, fields: [],
        why: 'a locked turnaround; the baseline this exists to confirm',
    },
    {
        name: 'SAME exposure by a different route',
        views: [v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
                v('back', { lens: '24mm', iso: 800, shutter_s: 1 / 120, white_balance_k: 5600 })],
        agree: true, fields: [],
        why: 'THE trap. Identical exposure; comparing ISO and shutter separately flags a correct '
           + 'turnaround and sends a director to re-shoot it',
    },
    {
        name: 'one view a full stop brighter',
        views: [v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
                v('back', { lens: '24mm', iso: 800, shutter_s: 1 / 60, white_balance_k: 5600 })],
        agree: false, fields: ['exposure'],
        why: 'a stop is plainly visible between two plates of one character',
    },
    {
        name: 'one view on a different lens',
        views: [v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
                v('back', { lens: '13mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 })],
        agree: false, fields: ['lens'],
        why: 'different perspective distortion; categorical, not a tolerance',
    },
    {
        name: '200K apart at TUNGSTEN',
        views: [v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 3000 }),
                v('back', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 3200 })],
        agree: false, fields: ['white_balance'],
        why: '20.8 mired apart — a visible warm/cool shift where plates are actually shot',
    },
    {
        name: '200K apart at DAYLIGHT-PLUS',
        views: [v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 8000 }),
                v('back', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 8200 })],
        agree: true, fields: [],
        why: 'THE mired test. The same 200K is 3.0 mired here and is not visible; a comparison in '
           + 'Kelvin cannot tell this from the tungsten pair',
    },
    {
        name: 'a third of a stop apart',
        views: [v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
                v('back', { lens: '24mm', iso: 500, shutter_s: 1 / 60, white_balance_k: 5600 })],
        agree: true, fields: [],
        why: 'within the tolerance; flagging a third of a stop makes the report noise',
    },
];

test('EVERY way a turnaround can disagree is reported, and agreement is not overclaimed', () => {
    const bad = [];
    for (const c of CASES) {
        const r = compareViews(c.views);
        if (r.agree !== c.agree) {
            bad.push(`${c.name}: reported agree=${r.agree}, expected ${c.agree} — ${c.why}`);
            continue;
        }
        const got = (r.disagreements || []).map(d => d.field).sort();
        if (got.join(',') !== [...c.fields].sort().join(',')) {
            bad.push(`${c.name}: flagged [${got}], expected [${c.fields}] — ${c.why}`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('EVERY field PCC-006 records is either compared or excluded WITH A REASON', () => {
    /*
     * Derived from CAPTURE_FIELDS, so a fifth setting added there cannot be
     * silently ignored here. `iso` and `shutter_s` are deliberately not
     * compared alone — they are compared as exposure — and that has to be
     * STATED, not left as an omission.
     */
    const { COMPARED, NOT_COMPARED } = require('../lib/plate-consistency');
    const covered = new Set([...Object.keys(COMPARED).flatMap(k => COMPARED[k].from),
                             ...Object.keys(NOT_COMPARED)]);
    const missing = Object.keys(CAPTURE_FIELDS).filter(f => !covered.has(f));
    assert.deepStrictEqual(missing, [],
        `these are recorded by PCC-006 and neither compared nor excluded: ${missing.join(', ')}`);
    for (const [f, why] of Object.entries(NOT_COMPARED)) {
        assert.ok(why && why.length > 30, `${f} is excluded with no real reason`);
    }
});

test('a view with NO settings is uncomparable, and is NAMED', () => {
    /*
     * Every plate shot before PCC-006 is in this state. Reporting "these agree"
     * over an empty set is the most misleading answer available, because it is
     * the reassuring one.
     */
    const only = compareViews([
        v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
        v('back', null),
    ]);
    assert.deepStrictEqual(only.uncomparable, ['back'],
        'a view with no recorded settings is not named as uncomparable');
    /*
     * NULL, not true. One comparable view has nothing to be compared against —
     * my first version of this asserted `true` here and contradicted the
     * single-view test three cases down. "These agree" over a set of one is the
     * same overclaim as agreeing over a set of none.
     */
    assert.strictEqual(only.agree, null,
        'one comparable view reported a verdict; there is nothing to compare it against');

    // And an uncomparable view must not poison a comparison that CAN be made.
    const some = compareViews([
        v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
        v('side-left', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
        v('back', null),
    ]);
    assert.strictEqual(some.agree, true,
        'two comparable views agree and a third with no settings suppressed the verdict');
    assert.deepStrictEqual(some.uncomparable, ['back'], 'the settingless view is not named');
    assert.deepStrictEqual(some.compared, ['front', 'side-left'],
        'the compared set does not name which views were actually looked at');
});

test('a turnaround with NOTHING recorded does not claim to agree', () => {
    const r = compareViews([v('front', null), v('back', null), v('side-left', {})]);
    assert.strictEqual(r.agree, null,
        `agree is ${r.agree}; with nothing to compare the honest answer is "cannot tell", not "yes"`);
    assert.strictEqual(r.uncomparable.length, 3, 'not every settingless view was named');
});

test('one view alone is not a disagreement', () => {
    const r = compareViews([v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60 })]);
    assert.strictEqual(r.agree, null,
        'a single view reported a verdict; there is nothing to compare it against');
});

test('a disagreement names the VIEWS and the amount, not just the field', () => {
    /*
     * "The exposure disagrees" sends a director to open all four. "back is 1.0
     * stops brighter than front" is something they can act on.
     */
    const r = compareViews(CASES[2].views);
    const d = r.disagreements[0];
    assert.strictEqual(d.field, 'exposure');
    assert.ok(Array.isArray(d.views) && d.views.length >= 2, 'the disagreeing views are not named');
    assert.ok(/stop/i.test(d.detail || ''), `the amount is not stated: ${d.detail}`);
    assert.match(d.detail, /back|front/, 'the detail does not name which view');
});

test('the tolerances are stated with their units and a reason', () => {
    for (const [name, t] of Object.entries(TOLERANCES)) {
        assert.ok(typeof t.value === 'number' && t.value > 0, `${name}: no usable tolerance`);
        assert.ok(t.unit, `${name}: no unit — a bare number cannot be checked`);
        assert.ok(t.why && t.why.length > 30, `${name}: no reason recorded`);
    }
    assert.strictEqual(TOLERANCES.white_balance.unit, 'mired',
        'white balance is compared in Kelvin; the scale is reciprocal, so one tolerance cannot '
        + 'serve both tungsten and daylight');
});

test('nonsense values are refused rather than compared', () => {
    /*
     * The settings come from an unauthenticated upload. A zero shutter makes
     * the exposure ratio infinite and log2 of it is Infinity, which would be
     * reported as a disagreement of Infinity stops.
     */
    /*
     * Each probe declares WHICH field it corrupts. The first version treated
     * every key as junk and expected `shutter_s: 1/60` — a perfectly good
     * value — to be reported unusable, which is the test being wrong rather
     * than the code.
     */
    const PROBES = [
        { capture: { iso: 0, shutter_s: 1 / 60 }, junk: ['iso'] },
        { capture: { iso: 400, shutter_s: 0 }, junk: ['shutter_s'] },
        { capture: { iso: -1, shutter_s: 1 / 60 }, junk: ['iso'] },
        { capture: { white_balance_k: 0 }, junk: ['white_balance_k'] },
        { capture: { iso: 0, shutter_s: 0 }, junk: ['iso', 'shutter_s'] },
    ];
    for (const probe of PROBES) {
        const bad = probe.capture;
        const r = compareViews([
            v('front', { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 }),
            v('back', { lens: '24mm', ...bad }),
        ]);
        for (const d of r.disagreements || []) {
            assert.ok(Number.isFinite(d.amount), `${JSON.stringify(bad)} produced ${d.amount}`);
        }
        /*
         * And NAMED. The first version of this checked only that the amount was
         * finite, and a mutation loosening the guard changed no answer — because
         * a junk value was silently dropped either way and the report said
         * nothing. A plate with a nonsense record read exactly like one that
         * agreed, which is the reassuring direction.
         */
        const named = (r.unusable || []).flatMap(u => u.fields);
        assert.deepStrictEqual(named.sort(), [...probe.junk].sort(),
            `${JSON.stringify(bad)}: reported unusable ${JSON.stringify(r.unusable)}; a junk `
            + 'setting must be named, not silently dropped');
    }
});

/* ── it is reachable ───────────────────────────────────────────────────── */

test('the report is served, and reads the plates a subject really has', () => {
    const { importMedia } = require('../lib/media-imports');
    const { handleCharacters } = require('../routes/characters');

    const projectId = generateId(), charId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'PCC-010');
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)')
        .run(charId, projectId, 'MAYA');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
        + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    importMedia('character-plate', { subjectId: charId, data: PNG, view: 'front',
        capture: { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 } });
    importMedia('character-plate', { subjectId: charId, data: PNG, view: 'back',
        capture: { lens: '24mm', iso: 1600, shutter_s: 1 / 60, white_balance_k: 5600 } });

    let body = null, status = 0;
    const res = {
        writeHead(c) { status = c; }, end(b) { body = JSON.parse(b || '{}'); },
        setHeader() {},
    };
    // urlParts as server.js splits it: ['film','characters',id,'refsheet','consistency'].
    const url = `/film/characters/${charId}/refsheet/consistency`;
    handleCharacters({ method: 'GET', url }, res, url.split('/').filter(Boolean), {});
    /*
     * On the STATUS, not on a return value. These handlers return whatever
     * res.end() returns — undefined — so a truthiness check reports a working
     * route as undispatched, and would equally pass a route that dispatched and
     * answered 500.
     */
    assert.strictEqual(status, 200,
        `the route answered ${status}; 0 means nothing was dispatched at all`);
    assert.strictEqual(body.agree, false,
        'two views two stops apart were reported as agreeing');
    assert.ok((body.disagreements || []).some(d => d.field === 'exposure'),
        `the exposure gap was not flagged: ${JSON.stringify(body.disagreements)}`);
});

test('an agent can ask, not only the page', () => {
    /*
     * The connected model IS the LLM here, and it is what drives a turnaround.
     * A check it cannot reach is one that only runs if a person remembers.
     */
    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    assert.ok(names.includes('plate_consistency'),
        'there is no plate_consistency tool; the check is page-only');
});
