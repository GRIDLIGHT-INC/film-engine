const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const rm = require('../lib/reference-match');
const complexity = require('../lib/shot-complexity');
const wexport = require('../lib/world-export');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

// ══ WE-6.1 · manual assist, and it claims nothing more ═══════════════════════

/*
 * The strongest form of "no automatic detection" is not a promise — it is that
 * the module never receives an image. Spec §30 puts detection in V2 and solving
 * against the reconstruction in V3; V1 takes marks. If a pixel buffer ever
 * reaches this module, the claim has quietly become a lie.
 */
test('WE-6.1 the solver takes marks and never an image', () => {
    /*
     * COMMENTS ARE STRIPPED FIRST.
     *
     * The module's own docstring says it never takes pixels, and the first
     * version of this scan matched that sentence and reported the module for
     * saying what it does. A check that cries wolf on its own documentation is
     * one nobody runs twice. Line-based, because every comment in that file is
     * a whole-line one and a block-comment regex eats a `/*` inside a string.
     */
    const src = SRC('lib/reference-match.js')
        .split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    assert.ok(src.length > 2000,
        'comment stripping removed almost the whole module — this scan is reading nothing');

    const forbidden = [
        /\bpixels?\b/i, /\bcanvas\b/i, /getImageData/, /\bdata:image/,
        /base64/i, /sharp|jimp|opencv|tensorflow/i, /decodeImage|readImage/i,
    ];
    for (const re of forbidden) {
        assert.ok(!re.test(src),
            `reference-match must never take image data — found ${re} in the code`);
    }
    // And the signature takes marks, not a frame.
    assert.match(src, /function solveMatch\(input, opts\)/,
        'the solver signature changed — check it still takes marks rather than a frame');
    // And nothing that would do the detecting.
    assert.ok(!/require\(['"](?!\.\/|node:)/.test(src.replace(/require\('\.\//g, '')),
        'reference-match must have no third-party dependency');
});

test('WE-6.1 an estimate whose marks were not made is NULL and names them', () => {
    // Nothing marked at all: every estimate must be blocked, none guessed.
    const empty = rm.solveMatch({});
    assert.strictEqual(empty.marks_used.length, 0);
    for (const est of rm.ESTIMATES) {
        const got = empty.estimates[est.id];
        assert.strictEqual(got.value, null, `${est.id} produced a value from no marks at all`);
        assert.deepStrictEqual(got.blocked_by.sort(), est.needs.slice().sort(),
            `${est.id} does not name the marks it is missing`);
    }
});

/* Set-based over the nine estimates: each must be produced when — and only
 * when — its declared marks are present. An estimate that appears without its
 * inputs is the failure this whole feature is written against. */
test('WE-6.1 every declared estimate is produced exactly when its marks are', () => {
    const ALL = {
        horizon: { a: [0, 0.45], b: [1, 0.47] },
        subject_box: { x: 0.3, y: 0.25, w: 0.2, h: 0.6 },
        subject_height_m: 1.8,
        vanishing_lines: [{ a: [0.1, 0.9], b: [0.5, 0.5] }, { a: [0.9, 0.9], b: [0.5, 0.5] }],
        focal_mm: 35,
    };
    assert.strictEqual(Object.keys(ALL).length, rm.MARKS.length,
        'this test does not cover every mark the module declares');

    for (const est of rm.ESTIMATES) {
        // With everything marked, it must resolve.
        const full = rm.solveMatch(ALL).estimates[est.id];
        assert.notStrictEqual(full.value, null, `${est.id} did not resolve with every mark present`);

        // Remove ONE mark it needs; it must go back to null naming that mark.
        for (const need of est.needs) {
            const partial = Object.assign({}, ALL);
            delete partial[need];
            const got = rm.solveMatch(partial).estimates[est.id];
            assert.strictEqual(got.value, null,
                `${est.id} still produced a value with '${need}' unmarked`);
            assert.ok(got.blocked_by.includes(need),
                `${est.id} did not name '${need}' as missing`);
        }
    }
});

// ══ WE-6.2 · confidence, always, and derived ════════════════════════════════

test('WE-6.2 every solve carries a confidence', () => {
    for (const marks of [{}, { horizon: { a: [0, 0.5], b: [1, 0.5] } },
                         { subject_box: { x: 0, y: 0, w: 1, h: 1 } }]) {
        const s = rm.solveMatch(marks);
        assert.strictEqual(typeof s.confidence, 'number', 'a solve came back with no confidence');
        assert.ok(s.confidence >= 0 && s.confidence <= 1, `confidence out of range: ${s.confidence}`);
    }
});

/*
 * Derived from the evidence, not asserted. An empty solve must be ZERO — a
 * floor would make a solve from no marks look plausible, which is precisely
 * "a confidence attached to a computation that never ran".
 */
test('WE-6.2 confidence rises with each mark and is 0 with none', () => {
    assert.strictEqual(rm.solveMatch({}).confidence, 0, 'a solve with no marks claimed confidence');
    let last = 0;
    const marks = {};
    for (const spec of rm.MARKS) {
        marks[spec.id] = spec.id === 'horizon' ? { a: [0, 0.45], b: [1, 0.47] }
            : spec.id === 'subject_box' ? { x: 0.3, y: 0.25, w: 0.2, h: 0.6 }
            : spec.id === 'subject_height_m' ? 1.8
            : spec.id === 'focal_mm' ? 35
            : [{ a: [0.1, 0.9], b: [0.5, 0.5] }, { a: [0.9, 0.9], b: [0.5, 0.5] }];
        const c = rm.solveMatch(marks).confidence;
        assert.ok(c > last, `marking ${spec.id} did not raise confidence (${last} -> ${c})`);
        last = c;
    }
});

test('WE-6.2 the solve says it is an approximation, in the payload', () => {
    const s = rm.solveMatch({ horizon: { a: [0, 0.5], b: [1, 0.5] } });
    assert.match(s.note, /approximation/i, 'the solve does not say it is an approximation');
    assert.strictEqual(s.method, 'manual-assist');
});

test('WE-6.2 applying is separate from solving', () => {
    const page = PAGE;
    // Solve and apply are two controls, and apply is disarmed until a solve
    // succeeds — a gate that stays armed across a failed inspection teaches
    // people the inspection happened.
    assert.match(page, /onclick="wmSolve\(\)"/, 'no solve control');
    assert.match(page, /onclick="wmApply\(\)"/, 'no apply control');
    const solve = page.slice(page.indexOf('async function wmSolve'), page.indexOf('function wmReportHtml'));
    assert.match(solve, /btn\.disabled = true/, 'wmSolve does not disarm apply before the request');
});

// ══ WE-6.3 · apply writes camera fields, and nothing else ═══════════════════

test('WE-6.3 the applied set is exactly the camera, declared', () => {
    assert.ok(rm.APPLIES.length >= 6, 'the applied set is suspiciously small');
    for (const f of rm.NEVER_APPLIES) {
        assert.ok(!rm.APPLIES.includes(f), `${f} is in both APPLIES and NEVER_APPLIES`);
    }
});

/*
 * Behavioural, not a declaration: build a proposal from a maximal solve and
 * assert it carries nothing outside the camera. A registry naming the rule
 * while the code writes more is the `NEVER_WRITES` failure.
 */
test('WE-6.3 a proposal carries no blocking, subject or world field', () => {
    const solved = rm.solveMatch({
        horizon: { a: [0, 0.45], b: [1, 0.47] },
        subject_box: { x: 0.3, y: 0.25, w: 0.2, h: 0.6 },
        subject_height_m: 1.8,
        vanishing_lines: [{ a: [0.1, 0.9], b: [0.5, 0.5] }, { a: [0.9, 0.9], b: [0.5, 0.5] }],
        focal_mm: 35,
    });
    const p = rm.proposalFrom(solved, { pinOccupancy: true });
    const cine = require('../lib/cinematography');
    for (const key of Object.keys(p.changes)) {
        assert.ok(cine.PROPOSAL_FIELDS.includes(key),
            `"${key}" is not a camera field the proposal validator accepts`);
    }
    for (const forbidden of rm.NEVER_APPLIES) {
        assert.ok(!(forbidden in p.changes), `a match proposed to change ${forbidden}`);
    }
    assert.ok(p.rationale && /confidence/i.test(p.rationale),
        'the rationale does not carry the confidence');
});

test('WE-6.3 a match goes through the same validator as any other camera', () => {
    const route = SRC('routes/worlds.js');
    const block = route.slice(route.indexOf("urlParts[3] === 'match-reference'"),
                              route.indexOf("urlParts[3] === 'complexity'"));
    assert.match(block, /cine\.validateProposal/, 'the match apply path skips the proposal validator');
    assert.match(block, /validateCam\.validateCamera/, 'the match apply path skips the camera checks');
    assert.match(block, /worlds\.saveCamera/, 'the match apply path never writes a camera');
    // And nothing else is written.
    for (const w of ['saveBlocking', 'ingestWorld', 'pinShot', 'newVersion']) {
        assert.ok(!block.includes(w), `the match apply path calls ${w}`);
    }
});

// ══ WE-6.4 · shot complexity ════════════════════════════════════════════════

test('WE-6.4 the grade is one of three, and only three', () => {
    assert.deepStrictEqual(complexity.GRADES.slice(), ['LOW', 'MEDIUM', 'HIGH']);
    const seen = new Set();
    for (let n = 0; n <= 24; n++) {
        // Drive the score with one input we know is monotone.
        seen.add(complexity.scoreShot({ subjects: n, distinct_actions: n, duration_s: n }).grade);
    }
    assert.deepStrictEqual([...seen].sort(), ['HIGH', 'LOW', 'MEDIUM'],
        'the scorer never reaches all three grades');
});

/*
 * SET-BASED OVER THE SEVEN INPUTS, and this is the assertion that matters: an
 * input declared to matter that moves nothing is a score nobody should act on.
 * Each is driven alone, from a shot that is otherwise LOW.
 */
test('WE-6.4 every declared input can change the grade on its own', () => {
    assert.strictEqual(complexity.INPUTS.length, 7, 'spec §49 names seven inputs');
    const base = complexity.scoreShot({});
    assert.strictEqual(base.grade, 'LOW', 'an empty shot should be LOW');

    for (const spec of complexity.INPUTS) {
        const worst = complexity.scoreShot({ [spec.id]: spec.worst });
        assert.notStrictEqual(worst.grade, base.grade,
            `${spec.id} at its worst (${spec.worst}) leaves the grade at ${base.grade} — it changes nothing`);
        assert.ok(worst.score > base.score, `${spec.id} contributed no points`);
    }
});

test('WE-6.4 HIGH carries a split suggestion and LOW does not', () => {
    const high = complexity.scoreShot({
        subjects: 4, moving_subjects: 4, camera_movement: 3,
        environment_interactions: 4, occlusion: 0.8, duration_s: 12, distinct_actions: 4,
    });
    assert.strictEqual(high.grade, 'HIGH');
    assert.ok(high.suggestion, 'a HIGH shot carries no suggestion');
    assert.ok(high.suggestion.split_into >= 2, 'the suggestion does not say how many shots');
    assert.ok(high.suggestion.cut_on.length, 'the suggestion does not say what to cut on');
    assert.match(high.suggestion.text, /split/i);

    assert.strictEqual(complexity.scoreShot({}).suggestion, null,
        'a LOW shot was told to split — the fastest way to have the warning switched off');
});

test('WE-6.4 the grade comes with its breakdown', () => {
    const r = complexity.scoreShot({ subjects: 3, duration_s: 8 });
    assert.strictEqual(r.inputs.length, 7, 'not every input is reported');
    for (const l of r.inputs) assert.ok(l.why, `${l.id} does not say why it matters`);
    assert.ok(r.drivers.every((d, i, a) => i === 0 || a[i - 1].points >= d.points),
        'drivers are not ordered worst-first');
});

/*
 * The four inputs the engine cannot read are DECLARED as asks rather than
 * silently scored as zero. A zero presented as a measurement is the same
 * confident-guess failure the match solve refuses.
 */
test('WE-6.4 inputs the engine cannot derive are marked as asks', () => {
    const route = SRC('routes/worlds.js');
    const fn = route.slice(route.indexOf('function complexityInputs'),
                           route.indexOf('function exportAssets'));
    const asks = (fn.match(/'ask —/g) || []).length;
    assert.ok(asks >= 4, `only ${asks} inputs are marked as asks; the engine cannot honestly derive four of them`);
    for (const id of complexity.INPUTS.map(i => i.id)) {
        assert.ok(fn.includes(id), `complexityInputs does not account for '${id}'`);
    }
});

// ══ WE-6.5 · export ═════════════════════════════════════════════════════════

test('WE-6.5 seven outputs, as spec §50 names them', () => {
    assert.strictEqual(wexport.EXPORT_OUTPUTS.length, 7, 'spec §50 lists seven initial exports');
    const kinds = new Set(wexport.EXPORT_OUTPUTS.map(o => o.kind));
    assert.ok(kinds.has('json') && kinds.has('file') && kinds.has('reference'),
        'the three output kinds are not all represented — a splat recorded as a file is a broken path');
});

/* THE RULE: every output names the world version it came from. */
test('WE-6.5 every output carries its world version, produced or not', () => {
    const world = { id: 'w1', name: 'Diner' };
    const version = { id: 'v9', version: 3, scale_factor: 1.75 };
    for (const assets of [
        {},                                                     // nothing produced
        { collider: { file_path: '/x.glb' }, splat_full: { url: 'https://x' },
          plate_image: { file_path: '/p.png' }, plate_depth: { file_path: '/d.png' },
          storyboard: { file_path: '/t.png' } },                // everything produced
    ]) {
        const m = wexport.buildExport({ world, version, shot: { shot_code: '1A' }, assets });
        assert.strictEqual(m.outputs.length, 7);
        for (const o of m.outputs) {
            assert.strictEqual(o.provenance.world_version_id, 'v9',
                `${o.id} does not name the world version it came from`);
            assert.strictEqual(o.provenance.world_version, 3);
            assert.strictEqual(o.provenance.world_id, 'w1');
            // An unavailable output is NAMED, never silently dropped.
            if (!o.available) assert.ok(o.reason, `${o.id} is missing with no reason given`);
        }
    }
});

test('WE-6.5 a missing output is reported, not omitted', () => {
    const m = wexport.buildExport({
        world: { id: 'w', name: 'n' }, version: { id: 'v', version: 1 }, assets: {},
    });
    assert.strictEqual(m.complete, false);
    assert.ok(m.missing.length >= 5, 'a package with nothing produced reported as nearly complete');
    for (const id of m.missing) {
        assert.ok(m.outputs.find(o => o.id === id).reason, `${id} is missing with no reason`);
    }
});

/*
 * An uncalibrated world must SAY its numbers are not metres. A camera JSON
 * whose coordinates are in arbitrary units, handed over without that sentence,
 * is placed wrong by whoever receives it.
 */
test('WE-6.5 an uncalibrated export says its distances are not metres', () => {
    const m = wexport.buildExport({
        world: { id: 'w', name: 'n' }, version: { id: 'v', version: 1, scale_factor: null },
        blocking: { camera: { position: [1, 2, 3] } }, assets: {},
    });
    assert.strictEqual(m.provenance.scale_state, 'APPROXIMATE SCALE');
    const wdoc = m.outputs.find(o => o.id === 'world_metadata_json').body;
    assert.match(wdoc.note, /NO SCALE|arbitrary units/i,
        'an uncalibrated export does not warn that its distances are not metres');
    const cam = m.outputs.find(o => o.id === 'camera_json').body;
    assert.strictEqual(cam.position_m, null,
        'an uncalibrated camera reported a metre position — a NULL factor is not 1.0');
});

test('WE-6.5 a calibrated export gives the metre twin as well', () => {
    const m = wexport.buildExport({
        world: { id: 'w', name: 'n' }, version: { id: 'v', version: 1, scale_factor: 2 },
        blocking: { camera: { position: [1, 2, 3] } }, assets: {},
    });
    const cam = m.outputs.find(o => o.id === 'camera_json').body;
    assert.deepStrictEqual(cam.position_m, [2, 4, 6]);
    assert.match(cam.units, /world units/i, 'the camera JSON does not say what units it is in');
});

// ══ reachability — the trap this phase hit ══════════════════════════════════

/*
 * server.js used to hold a HAND-WRITTEN list of the shot tails that reach this
 * module, so a route added here answered 405 — a handler that exists and is
 * never reached looks exactly like a missing feature, and all three phase-6
 * routes shipped that way for an hour. The list is derived now, and this is
 * what keeps it derived.
 */
test('every shot route this module answers is reachable through server.js', () => {
    const { SHOT_TAILS } = require('../routes/worlds');
    const route = SRC('routes/worlds.js');
    const declared = new Set(SHOT_TAILS);

    const dispatched = new Set();
    for (const m of route.matchAll(/urlParts\[1\] === 'shots' && urlParts\[3\] === '([a-z-]+)'/g)) {
        dispatched.add(m[1]);
    }
    assert.ok(dispatched.size >= 5, `only found ${dispatched.size} shot routes; this scan is not reading them`);
    for (const tail of dispatched) {
        assert.ok(declared.has(tail),
            `/film/shots/:id/${tail} is handled here and absent from SHOT_TAILS, so server.js never routes to it`);
    }

    const server = SRC('server.js');
    assert.match(server, /WORLD_SHOT_TAILS\.includes\(parts\[3\]\)/,
        'server.js does not derive the shot tails from the route module');
});

test('the three phase-6 capabilities are on the MCP surface', () => {
    const { buildTools } = require('../lib/mcp-tools');
    const names = new Set(buildTools().map(t => t.name));
    for (const n of ['match_reference', 'shot_complexity', 'world_export']) {
        assert.ok(names.has(n), `${n} has no MCP tool — an agent cannot reach it`);
    }
});

/*
 * A class used in the console markup and defined in no stylesheet renders
 * unstyled — visible, wrong, and silent. `we-card` shipped that way for
 * exactly one build.
 */
test('every we-* class the console renders has a rule', () => {
    const used = new Set();
    for (const m of PAGE.matchAll(/class="(we-[a-z-]+)"/g)) used.add(m[1]);
    assert.ok(used.size >= 6, `only found ${used.size} we-* classes; this scan is not reading the markup`);
    for (const cls of used) {
        assert.ok(new RegExp(`\\.${cls}\\b[^{]*\\{`).test(PAGE),
            `.${cls} is used in the console and defined in no stylesheet`);
    }
});
