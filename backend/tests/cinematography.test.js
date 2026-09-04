/**
 * World Engine — Phase 3 (MVP 3): directing.
 *
 * Implements test-spec §5, WE-3.1 through WE-3.12.
 *
 * THE RULE THIS PHASE EXISTS TO HOLD: the engine computes FACTS and VALIDATES
 * results. It never decides what the shot should be, and it never calls a
 * language model to decide for it. The connected agent host IS the model here —
 * that is what lets this pipeline reach an LLM with no API key of its own — so
 * a route that reached for a server-side one would ask the user to hold a second
 * key for a question the attached model has already read, and fail with a
 * billing error the model cannot act on.
 *
 * So: `cinematography_brief` hands over the geometry and returns NO conclusion,
 * the model proposes, and `camera_propose` refuses anything the world will not
 * physically accept. Same shape as analysis_brief/analysis_write and
 * music_brief/music_cue_create, which this codebase already runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cine = require('../lib/cinematography');
const cam = require('../lib/camera-validate');

const ROOT = path.join(__dirname, '..', '..');

// ── fixtures ────────────────────────────────────────────────────────────────

/** A world 40 x 9 x 48, floor at y=0 — the extent the real spike measured. */
const WORLD = {
    bounds: { min: [-13, -0.2, -28], max: [27, 9, 20] },
    scale_factor: 0.8227,
};

/** Two subjects and a camera looking down -Z at them, the engine's convention. */
const BLOCKING = {
    camera: { position: [0, 1.6, 8], rotation: [0, 0, 0], focalMm: 35,
              sensorId: 'super35', fStop: 2.8, focusDistanceM: 8 },
    subjects: [
        { name: 'MAYA', position: [0, 0, 0], size: [0.5, 1.68, 0.3], isTarget: true },
        { name: 'DRAGON', position: [4, 0, -6], size: [3, 4, 11] },
    ],
};

const AXIS = { a: [0, 0, 0], b: [4, 0, -6] };   // MAYA ↔ DRAGON

// ══ WE-3.1 · the brief ══════════════════════════════════════════════════════

test('WE-3.1 every intent produces a brief, and none of them decides anything', () => {
    assert.strictEqual(cine.INTENTS.length, 7, `the intent vocabulary is ${cine.INTENTS.length}, not 7`);

    for (const intent of cine.INTENTS) {
        const brief = cine.buildBrief({ world: WORLD, blocking: BLOCKING, axis: AXIS, intent });
        assert.strictEqual(brief.intent, intent);
        assert.ok(brief.bias && brief.bias.length > 20,
            `${intent}: no bias description — the model is given a word and no meaning`);
        assert.ok(brief.facts && brief.facts.camera, `${intent}: the brief carries no camera facts`);
    }
});

test('WE-D5.2 the brief carries facts and NO proposed camera', () => {
    /*
     * The comfortable failure: an engine that quietly decides, hands the model
     * its own answer, and reads back as collaboration. A brief with a `changes`
     * block is the engine directing.
     */
    const brief = cine.buildBrief({ world: WORLD, blocking: BLOCKING, axis: AXIS, intent: 'heroic' });
    const flat = JSON.stringify(brief);
    for (const forbidden of ['changes', 'proposal', 'proposed', 'recommendation', 'suggested']) {
        assert.ok(!new RegExp(`"${forbidden}"`).test(flat),
            `the brief contains "${forbidden}" — the engine is making the judgement`);
    }
    // It must still be USEFUL: the facts a director's model needs to reason.
    for (const key of ['camera', 'subjects', 'world', 'axis']) {
        assert.ok(brief.facts[key] !== undefined, `the brief omits ${key}`);
    }
});

// ══ WE-3.2 / 3.3 · validation ═══════════════════════════════════════════════

test('WE-3.2 every declared check rejects a candidate crafted to break it', () => {
    assert.strictEqual(cam.CHECKS.length, 6, `there are ${cam.CHECKS.length} checks, not 6`);

    /*
     * One deliberately invalid camera per check. Set-based because the failure
     * is partial by nature: a validator catching five of six is indistinguishable
     * from one that works, and the sixth ships a camera inside a wall.
     */
    const BREAKS = {
        // Under the floor, inside the reconstruction.
        inside_geometry: { position: [0, -3, 8], rotation: [0, 0, 0] },
        // Turned around: the subject is behind the lens.
        subject_behind_camera: { position: [0, 1.6, 8], rotation: [180, 0, 0] },
        // Closer than the near plane.
        clipping: { position: [0, 1.6, 0.02], rotation: [0, 0, 0] },
        // A focus distance that cannot be set.
        focus_impossible: { position: [0, 1.6, 8], rotation: [0, 0, 0], focusDistanceM: 0 },
        // The dragon standing between the camera and MAYA.
        occluded: { position: [8, 1.6, -12], rotation: [180, 0, 0] },
        // The far side of the MAYA↔DRAGON axis from where we established.
        line_crossed: { position: [-9, 1.6, -14], rotation: [150, 0, 0] },
    };

    const missed = [];
    for (const check of cam.CHECKS) {
        const camera = Object.assign({}, BLOCKING.camera, BREAKS[check]);
        const out = cam.validateCamera(camera, WORLD,
            Object.assign({}, BLOCKING, { camera }),
            { axis: AXIS, establishedSide: 'A' });
        if (out.ok || !out.failures.some(f => f.check === check)) {
            missed.push(`${check} (reported: ${out.failures.map(f => f.check).join(',') || 'nothing'})`);
        }
    }
    assert.deepStrictEqual(missed, [], `checks that did not catch their own defect:\n  ${missed.join('\n  ')}`);
});

test('WE-3.3 a valid camera passes all six', () => {
    const out = cam.validateCamera(BLOCKING.camera, WORLD, BLOCKING,
        { axis: AXIS, establishedSide: 'A' });
    assert.ok(out.ok, `a legitimate camera was refused: ${out.failures.map(f => f.check + ' — ' + f.detail).join('; ')}`);
    assert.deepStrictEqual(out.failures, []);
});

// ══ WE-3.4 / 3.5 · the proposal contract ════════════════════════════════════

test('WE-3.4 only the declared fields are accepted, and the rest are refused BY NAME', () => {
    assert.strictEqual(cine.PROPOSAL_FIELDS.length, 11,
        `the proposal contract has ${cine.PROPOSAL_FIELDS.length} fields, not 11`);

    const brief = cine.buildBrief({ world: WORLD, blocking: BLOCKING, axis: AXIS, intent: 'heroic' });

    // Every declared field is accepted on its own.
    const sample = {
        focalLengthMm: 21, cameraHeightM: 0.42, dollyM: -1, truckM: 0.5, pedestalM: -0.3,
        panDeg: 4, tiltDeg: 17, rollDeg: -4, targetOccupancy: { DRAGON: 0.58 },
        framingTarget: 'DRAGON', rig: 'dolly',
    };
    for (const f of cine.PROPOSAL_FIELDS) {
        const out = cine.validateProposal({ rationale: 'x', changes: { [f]: sample[f] } }, brief);
        assert.ok(out.ok, `${f} is declared but refused: ${out.errors.join('; ')}`);
    }

    /*
     * And spec §32: the AI may move the camera. It may NOT silently restage the
     * world, the blocking or who is in the shot.
     */
    for (const forbidden of ['worldGeometry', 'blocking', 'wardrobe', 'subjects', 'style_preset']) {
        const out = cine.validateProposal(
            { rationale: 'x', changes: { focalLengthMm: 21, [forbidden]: 'anything' } }, brief);
        assert.ok(!out.ok, `${forbidden} was accepted — the AI can change what it must not`);
        assert.ok(out.errors.join(' ').includes(forbidden),
            `${forbidden} was refused without being named, so nobody can tell what was wrong`);
    }
});

test('WE-3.5 applying a proposal returns a new camera and never mutates the old one', () => {
    const before = JSON.parse(JSON.stringify(BLOCKING.camera));
    const next = cine.applyProposal(BLOCKING.camera,
        { changes: { focalLengthMm: 21, cameraHeightM: 0.42, tiltDeg: 17, dollyM: -2 } });

    assert.deepStrictEqual(BLOCKING.camera, before, 'the original camera was mutated — undo is now impossible');
    assert.notStrictEqual(next, BLOCKING.camera);
    assert.strictEqual(next.focalMm, 21);
    assert.strictEqual(next.position[1], 0.42, 'the height was not applied');
    assert.ok(Math.abs(next.rotation[1] - (before.rotation[1] + 17)) < 1e-9, 'tilt is not relative');
    assert.ok(next.position[2] < before.position[2], 'a negative dolly did not move the camera forward');
});

// ══ WE-3.6 · explore ════════════════════════════════════════════════════════

test('WE-3.6 explore briefs six categories, and a shortfall is NAMED not padded', () => {
    const brief = cine.exploreBrief({ world: WORLD, blocking: BLOCKING, axis: AXIS });
    assert.strictEqual(brief.categories.length, 6,
        `explore offers ${brief.categories.length} categories, the design draws 6`);
    for (const c of brief.categories) {
        assert.ok(c.key && c.name && c.intent, `a category is missing its key/name/intent: ${JSON.stringify(c)}`);
    }
    /*
     * Again: facts, no cameras. Bound to a PROPOSED VALUE, not to the field
     * name — the brief legitimately lists what a proposal may change, and the
     * first version of this check read that contract as a proposal.
     */
    assert.ok(!brief.changes && !brief.proposal, 'the explore brief proposes a camera');
    for (const c of brief.categories) {
        assert.strictEqual(c.focalLengthMm, undefined,
            `category ${c.key} carries a lens — choosing it is the model's job`);
        assert.strictEqual(c.cameraHeightM, undefined, `category ${c.key} carries a height`);
    }

    // Candidates the model returns are validated, and the invalid are dropped
    // with their reason rather than shown as if they could be shot.
    const proposed = [
        { key: 'A', changes: { focalLengthMm: 24, cameraHeightM: 1.55 } },
        { key: 'B', changes: { focalLengthMm: 18, cameraHeightM: -3 } },   // under the floor
    ];
    const out = cine.acceptCandidates(proposed, { world: WORLD, blocking: BLOCKING, axis: AXIS });
    assert.strictEqual(out.accepted.length, 1, 'an unshootable camera was accepted');
    assert.strictEqual(out.rejected.length, 1);
    assert.ok(out.rejected[0].failures.length > 0, 'a rejection carries no reason');
    assert.ok(out.shortfall > 0, 'a short set is not reported as short');
});

// ══ WE-3.7 / 3.8 / 3.9 · continuity ═════════════════════════════════════════

test('WE-3.7 sideOfAxis answers three ways, and ON_AXIS is not guessed', () => {
    /*
     * Which side is called A is arbitrary; that the two sides DIFFER and that
     * the convention is stable is not. Pinned to the implementation's own rule
     * — side A is the positive cross product — so a sign flip fails here rather
     * than silently reversing every continuity warning in the film.
     */
    const left = cam.sideOfAxis([-5, 0, 5], AXIS);
    const right = cam.sideOfAxis([9, 0, 5], AXIS);
    assert.notStrictEqual(left, right, 'points either side of the axis got the same answer');
    assert.strictEqual(right, 'A');
    assert.strictEqual(left, 'B');
    // Exactly on the line: neither side, and it must NOT be assigned one.
    assert.strictEqual(cam.sideOfAxis([2, 0, -3], AXIS), 'ON_AXIS');
    assert.strictEqual(cam.sideOfAxis(AXIS.a, AXIS), 'ON_AXIS');
});

test('WE-3.8 crossing the line WARNS and does not block', () => {
    const crossed = Object.assign({}, BLOCKING.camera, { position: [-9, 1.6, -14], rotation: [150, 0, 0] });
    const soft = cam.validateCamera(crossed, WORLD, Object.assign({}, BLOCKING, { camera: crossed }),
        { axis: AXIS, establishedSide: 'A' });
    assert.ok(soft.failures.some(f => f.check === 'line_crossed'));
    assert.strictEqual(soft.blocking, false,
        'crossing the line blocked the save — a hard block on a legitimate creative choice '
        + 'is how the whole continuity system gets switched off');

    // Strict mode is opt-in, and then it does block.
    const hard = cam.validateCamera(crossed, WORLD, Object.assign({}, BLOCKING, { camera: crossed }),
        { axis: AXIS, establishedSide: 'A', strict: true });
    assert.strictEqual(hard.blocking, true, 'strict mode did not block');
});

test('WE-3.9 a screen-direction reversal names the shot it reversed', () => {
    // DRAGON sits camera-right in this blocking; 2A established it camera-left.
    const rev = cine.screenDirectionWarning(
        { camera: BLOCKING.camera, subjects: BLOCKING.subjects },
        { shot_code: '2A', subject: 'DRAGON', direction: 'left' });
    assert.ok(rev, 'no warning for a reversed subject');
    assert.match(rev.message, /2A/, 'the warning does not name the shot — a count sends you to the database');
    assert.match(rev.message, /DRAGON/i, 'the warning does not name the subject');

    // A subject that has NOT reversed must stay quiet, or the warning is noise.
    assert.strictEqual(cine.screenDirectionWarning(
        { camera: BLOCKING.camera, subjects: BLOCKING.subjects },
        { shot_code: '2A', subject: 'DRAGON', direction: 'right' }), null,
        'a subject on its established side still warned');

    // And a subject dead centre has no direction to reverse.
    assert.strictEqual(cine.screenDirectionWarning(
        { camera: BLOCKING.camera, subjects: BLOCKING.subjects },
        { shot_code: '2A', subject: 'MAYA', direction: 'left' }), null,
        'a centred subject was reported as reversed');
});

// ══ WE-3.10 · compare ═══════════════════════════════════════════════════════

test('WE-3.10 comparing two cameras reports the same axes for both', () => {
    const b = cine.applyProposal(BLOCKING.camera, { changes: { focalLengthMm: 85, cameraHeightM: 1.72 } });
    const cmp = cine.compareCameras(
        { camera: BLOCKING.camera, blocking: BLOCKING },
        { camera: b, blocking: Object.assign({}, BLOCKING, { camera: b }) });

    assert.strictEqual(cmp.axes.length, 5, `compare reports ${cmp.axes.length} axes, not 5`);
    for (const axis of cmp.axes) {
        assert.ok(axis.a !== undefined && axis.b !== undefined,
            `${axis.label}: one column is missing — a comparison with a gap reads as the cameras differing`);
        assert.ok(axis.label, 'an axis has no label');
    }
});

// ══ WE-3.11 / 3.12 · the rabbit hole, and the surface ═══════════════════════

test('WE-3.11 no module in this phase reaches a server-side LLM', () => {
    /*
     * THE GOAL'S STATED RABBIT HOLE. The connected model is the model; a route
     * that calls one server-side asks for a second API key to answer a question
     * the attached model has already read, and fails with a billing error it
     * cannot act on.
     *
     * Derived by following one call level, the rule mcp-no-server-llm already
     * uses — a module that requires a module that requires the client is just
     * as guilty.
     */
    const MODULES = ['lib/cinematography.js', 'lib/camera-validate.js', 'routes/worlds.js'];
    const guilty = [];
    for (const rel of MODULES) {
        const src = fs.readFileSync(path.join(ROOT, 'backend', rel), 'utf8');
        if (/require\(['"][^'"]*llm-client['"]\)/.test(src)) guilty.push(rel);
        for (const m of src.matchAll(/require\(['"]\.\.?\/([a-z-/]+)['"]\)/g)) {
            const dep = path.join(ROOT, 'backend', rel.startsWith('routes') ? '' : '', m[1] + '.js');
            const p2 = fs.existsSync(dep) ? dep : path.join(ROOT, 'backend', 'lib', m[1] + '.js');
            if (!fs.existsSync(p2)) continue;
            if (/require\(['"][^'"]*llm-client['"]\)/.test(fs.readFileSync(p2, 'utf8'))) {
                guilty.push(`${rel} → ${m[1]}`);
            }
        }
    }
    assert.deepStrictEqual(guilty, [], `these reach a server-side LLM: ${guilty.join(', ')}`);
});

test('WE-3.3b a check that could not run is NAMED, not counted as a pass', () => {
    /*
     * With no world pinned and nothing staged, a camera forty metres under the
     * floor came back clean — because `inside_geometry` has no bounds to test
     * against and simply did not fire. A green tick against a rule that was
     * never applied is worse than silence.
     */
    const bare = cam.validateCamera({ position: [0, -40, 0], rotation: [0, 0, 0] },
        { bounds: null }, { camera: {}, subjects: [] }, {});
    assert.ok(bare.skipped.length > 0, 'nothing was reported as unrunnable');
    const names = bare.skipped.map(s => s.check);
    for (const c of ['inside_geometry', 'subject_behind_camera', 'clipping', 'occluded', 'line_crossed']) {
        assert.ok(names.includes(c), `${c} silently did not run and was not reported`);
    }
    for (const s of bare.skipped) assert.ok(s.why && s.why.length > 15, `${s.check} was skipped with no reason`);
    assert.deepStrictEqual(bare.checked, ['focus_impossible'],
        `checked reports ${bare.checked.join(',')} — only focus can be judged without a world`);

    // With a world and subjects, nothing is skipped.
    const full = cam.validateCamera(BLOCKING.camera, WORLD, BLOCKING, { axis: AXIS, establishedSide: 'A' });
    assert.deepStrictEqual(full.skipped, [], `checks were skipped on a complete shot: ${full.skipped.map(s => s.check)}`);
    assert.strictEqual(full.checked.length, cam.CHECKS.length);
});

test('WE-3.12c a shot with no director intent still briefs', () => {
    /*
     * The commonest state by far: no axis, no established side, no staged
     * subjects. It threw, because JSON.parse('null') SUCCEEDS and returns null
     * — so a try/catch fallback never fired, and `director_json` is null on
     * every shot nobody has directed yet.
     */
    const bare = cine.buildBrief({ world: { bounds: null, scale_factor: null },
                                   blocking: { camera: {}, subjects: [] } });
    assert.ok(bare.facts, 'a bare shot produced no brief');
    assert.strictEqual(bare.facts.axis, null);
    assert.strictEqual(bare.facts.world.scale_factor, null);
    assert.match(bare.facts.world.scale_state, /APPROXIMATE/);
    assert.deepStrictEqual(bare.facts.subjects, []);

    // And the route's own parser must coalesce a null, not merely catch a throw.
    const route = fs.readFileSync(path.join(ROOT, 'backend', 'routes', 'worlds.js'), 'utf8');
    const at = route.indexOf('const parse = ');
    assert.notStrictEqual(at, -1, 'the context parser is gone');
    assert.match(route.slice(at, route.indexOf(';', route.indexOf('catch', at))),
        /out == null \? d/, 'JSON null is not coalesced — a shot with no intent throws');
});

test('WE-3.12b every directing route is actually dispatched', () => {
    /*
     * The route existed and server.js matched `parts[3] === 'world'`, so
     * /film/shots/:id/direct fell through to another handler and answered
     * "Method not allowed". A handler that exists and is never reached looks
     * exactly like a missing feature — the /film/locations/:id trap, walked
     * into again by the very module whose header warns about it.
     */
    const server = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
    const at = server.indexOf('handleWorlds(req, res, parts, query)');
    assert.notStrictEqual(at, -1, 'server.js never dispatches to handleWorlds');
    const guard = server.slice(server.lastIndexOf('if (', at), at);
    assert.match(guard, /'direct'/,
        'the world dispatch does not match /film/shots/:id/direct — the directing routes are unreachable');
    assert.match(guard, /'world'/, 'the world pin route is no longer matched');
});

test('WE-3.12 the brief/propose pair is on the MCP surface, and neither spends', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    const PAIR = ['cinematography_brief', 'camera_propose', 'camera_explore_brief'];
    const missing = PAIR.filter(n => !names.includes(n));
    assert.deepStrictEqual(missing, [], `missing from the agent surface: ${missing.join(', ')}`);

    const guide = fs.readFileSync(path.join(ROOT, 'docs', 'claude-desktop-guide.md'), 'utf8');
    const cost = guide.slice(guide.indexOf('## What costs money'));
    for (const n of PAIR) {
        assert.ok(!cost.split('\n\n')[1].includes(n), `${n} is listed as spending money`);
    }

    // The brief must SAY it returns no conclusion, or a model will look for one.
    const brief = listTools().find(t => t.name === 'cinematography_brief');
    assert.match(brief.description, /no conclusion|does not decide|facts/i,
        'the brief tool does not say it returns facts rather than an answer');
});
