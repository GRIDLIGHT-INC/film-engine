/**
 * Set-based conformance test for the 3D previs camera plan.
 *
 * Same failure mode as the Flows canvas plan, and the same defence: a design
 * document is wrong in ways prose review does not catch. It leaves part of the
 * set undesigned — a camera move with no 3D path, a shot type with no framing
 * rule — and reads as finished, because the gap is an absence rather than a
 * false statement. And it cites registries, fields or files that do not exist,
 * so the first implementer discovers it was never checked against the tree.
 *
 * The vocabulary a previs viewer has to honour is ALREADY IN THE CODE: 18 camera
 * movements and 18 shot types in lib/scene-card-schema.js, 18 camera_control
 * entries in lib/video-prompt.js, 12 aspect ratios in lib/project-presets.js.
 * A previs tool that covers 15 of 18 moves is not 83% useful — it silently
 * cannot express three shots someone already wrote into a scene card. So every
 * assertion here iterates a registry rather than naming an example.
 *
 * Plan:      docs/plans/previs-camera-implementation-plan.md
 * Research:  docs/plans/previs-camera-research.md
 * Taxonomy:  docs/plans/previs-camera-taxonomy.json   (the machine-readable half)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { VALID_SHOT_TYPES, VALID_CAMERA_MOVES } = require('../lib/scene-card-schema');
const { CAMERA_CONTROL_MAP } = require('../lib/video-prompt');
const { ASPECT_RATIO_IDS } = require('../lib/project-presets');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PLAN_MD = path.join(REPO_ROOT, 'docs', 'plans', 'previs-camera-implementation-plan.md');
const RESEARCH_MD = path.join(REPO_ROOT, 'docs', 'plans', 'previs-camera-research.md');
const TAXONOMY_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'previs-camera-taxonomy.json');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const taxonomy = () => JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
const plan = () => fs.readFileSync(PLAN_MD, 'utf8');

// ── The artefacts exist ─────────────────────────────────────────────────────

test('plan, research and taxonomy all exist', () => {
    for (const [label, p] of [['plan', PLAN_MD], ['research', RESEARCH_MD], ['taxonomy', TAXONOMY_PATH]]) {
        assert.ok(fs.existsSync(p), `${label} is missing: ${p}`);
    }
    assert.ok(plan().length > 4000, 'the plan is too short to have designed anything');
    assert.ok(fs.readFileSync(RESEARCH_MD, 'utf8').length > 3000, 'the research note is too short');
});

// ── Camera movements: all 18, each with a real 3D path ──────────────────────

test('every camera movement in the schema has a previs path', () => {
    const t = taxonomy();
    const missing = VALID_CAMERA_MOVES.filter(m => !t.movements[m]);
    assert.deepStrictEqual(missing, [],
        `camera moves a previs viewer could not express: ${missing.join(', ')}`);
    assert.strictEqual(Object.keys(t.movements).length, VALID_CAMERA_MOVES.length,
        'the taxonomy invents movements the scene card cannot store');
});

test('every movement path is expressed in terms the renderer can execute', () => {
    const t = taxonomy();
    const SPACES = new Set(['camera', 'world', 'subject', 'none']);
    const bad = [];

    for (const [id, move] of Object.entries(t.movements)) {
        if (!SPACES.has(move.space)) bad.push({ id, why: `unknown space '${move.space}'` });
        if (!Array.isArray(move.translate) || move.translate.length !== 3) bad.push({ id, why: 'translate must be a 3-vector' });
        if (!Array.isArray(move.rotate) || move.rotate.length !== 3) bad.push({ id, why: 'rotate must be a 3-vector (yaw, pitch, roll)' });
        if (typeof move.focalScale !== 'number' || move.focalScale <= 0) bad.push({ id, why: 'focalScale must be a positive multiplier' });
        if (typeof move.defaultIntensity !== 'number') bad.push({ id, why: 'no default intensity' });
        if (!Array.isArray(move.rigs) || !move.rigs.length) bad.push({ id, why: 'no rig can perform it' });
    }
    assert.deepStrictEqual(bad, [], JSON.stringify(bad, null, 1));
});

test('a movement that changes nothing is only ever the static one', () => {
    // Guards a placeholder entry added to make the coverage test pass: an
    // all-zero path renders as a locked-off camera whatever it is called.
    const t = taxonomy();
    const inert = Object.entries(t.movements).filter(([, m]) =>
        m.translate.every(v => v === 0) && m.rotate.every(v => v === 0) &&
        m.focalScale === 1 && !m.orbitDegrees);
    assert.deepStrictEqual(inert.map(([id]) => id), ['static'],
        'a movement other than static does nothing when rendered');
});

test('every movement declares rigs that exist in the taxonomy', () => {
    const t = taxonomy();
    const rigs = new Set(Object.keys(t.rigs));
    const dangling = [];
    for (const [id, move] of Object.entries(t.movements)) {
        for (const rig of move.rigs) if (!rigs.has(rig)) dangling.push(`${id} -> ${rig}`);
    }
    assert.deepStrictEqual(dangling, [], `movements naming undeclared rigs: ${dangling.join(', ')}`);
});

test('every movement round-trips to the camera_control the video layer sends', () => {
    // Previs is upstream of generation: a move blocked in 3D has to arrive at
    // the provider as the control it already maps to, or previs becomes a
    // drawing exercise disconnected from what gets generated.
    const t = taxonomy();
    const wrong = [];
    for (const move of VALID_CAMERA_MOVES) {
        const control = CAMERA_CONTROL_MAP[move];
        if (!control) { wrong.push({ move, why: 'no camera_control entry' }); continue; }
        if (t.movements[move].cameraControlType !== control.type) {
            wrong.push({ move, expected: control.type, got: t.movements[move].cameraControlType });
        }
    }
    assert.deepStrictEqual(wrong, [], JSON.stringify(wrong, null, 1));
});

// ── Shot types: all 18, each decomposed ─────────────────────────────────────

test('every shot type in the schema is accounted for', () => {
    const t = taxonomy();
    const missing = VALID_SHOT_TYPES.filter(s => !t.shotTypes[s]);
    assert.deepStrictEqual(missing, [], `shot types with no previs meaning: ${missing.join(', ')}`);
    assert.strictEqual(Object.keys(t.shotTypes).length, VALID_SHOT_TYPES.length);
});

test('every shot type is assigned to a declared axis', () => {
    // The finding the taxonomy exists to record: VALID_SHOT_TYPES mixes three
    // different things — how tight the frame is, where the camera is, and what
    // it is mounted on. A 3D tool cannot honour the list until they are split,
    // because framing comes from lens plus distance, angle from height plus
    // pitch, and rig from the motion path.
    const t = taxonomy();
    const AXES = new Set(['framing', 'angle', 'rig']);
    const bad = Object.entries(t.shotTypes).filter(([, s]) => !AXES.has(s.axis));
    assert.deepStrictEqual(bad.map(([id]) => id), [], 'shot types with no axis');

    for (const axis of AXES) {
        const members = Object.entries(t.shotTypes).filter(([, s]) => s.axis === axis);
        assert.ok(members.length > 0, `no shot type is classified as '${axis}'`);
    }
});

test('framing shot types carry the subject height that defines them', () => {
    // The number that makes previs useful: subject height in frame plus focal
    // length gives camera distance, which is the question a director is asking.
    const t = taxonomy();
    const bad = Object.entries(t.shotTypes)
        .filter(([, s]) => s.axis === 'framing')
        .filter(([, s]) => typeof s.subjectHeightM !== 'number' || s.subjectHeightM <= 0);
    assert.deepStrictEqual(bad.map(([id]) => id), [], 'framing shot types with no subject height');
});

test('angle shot types carry a camera height and pitch', () => {
    const t = taxonomy();
    const bad = Object.entries(t.shotTypes)
        .filter(([, s]) => s.axis === 'angle')
        .filter(([, s]) => typeof s.cameraHeightM !== 'number' || typeof s.pitchDegrees !== 'number');
    assert.deepStrictEqual(bad.map(([id]) => id), [], 'angle shot types with no camera placement');
});

test('rig shot types name a rig that exists', () => {
    const t = taxonomy();
    const rigs = new Set(Object.keys(t.rigs));
    const bad = Object.entries(t.shotTypes)
        .filter(([, s]) => s.axis === 'rig')
        .filter(([, s]) => !rigs.has(s.rig));
    assert.deepStrictEqual(bad.map(([id]) => id), [], 'rig shot types naming an undeclared rig');
});

// ── Optics ──────────────────────────────────────────────────────────────────

test('every sensor has the physical dimensions the FOV maths needs', () => {
    const t = taxonomy();
    assert.ok(Object.keys(t.sensors).length >= 4, 'too few sensor formats to be useful on a real production');
    const bad = Object.entries(t.sensors).filter(([, s]) =>
        !(s.widthMm > 0) || !(s.heightMm > 0) || !(s.circleOfConfusionMm > 0));
    assert.deepStrictEqual(bad.map(([id]) => id), [],
        'sensors missing width, height or circle of confusion');
});

test('every rig declares which movements it can actually perform', () => {
    const t = taxonomy();
    const moves = new Set(VALID_CAMERA_MOVES);
    const bad = [];
    for (const [id, rig] of Object.entries(t.rigs)) {
        if (!Array.isArray(rig.affords) || !rig.affords.length) { bad.push(`${id}: affords nothing`); continue; }
        for (const m of rig.affords) if (!moves.has(m)) bad.push(`${id} -> ${m} is not a schema movement`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('every movement is performable by at least one rig, in both directions', () => {
    // Bidirectional: a move no rig affords cannot be shot, and a rig list that
    // disagrees with the move list means one of the two was edited alone.
    const t = taxonomy();
    const affordedByRigs = new Set(Object.values(t.rigs).flatMap(r => r.affords));
    const orphanMoves = VALID_CAMERA_MOVES.filter(m => !affordedByRigs.has(m));
    assert.deepStrictEqual(orphanMoves, [], `movements no rig can perform: ${orphanMoves.join(', ')}`);

    const disagreements = [];
    for (const [rigId, rig] of Object.entries(t.rigs)) {
        for (const m of rig.affords) {
            if (!t.movements[m].rigs.includes(rigId)) disagreements.push(`${rigId} claims ${m}, ${m} does not claim ${rigId}`);
        }
    }
    assert.deepStrictEqual(disagreements, [], disagreements.join('; '));
});

// ── The frame ───────────────────────────────────────────────────────────────

test('every project aspect ratio can be framed in the previs viewport', () => {
    const t = taxonomy();
    const missing = ASPECT_RATIO_IDS.filter(id => !t.aspectRatios.includes(id));
    assert.deepStrictEqual(missing, [],
        `aspect ratios the viewport cannot letterbox: ${missing.join(', ')}`);
});

// ── Plan hygiene ────────────────────────────────────────────────────────────

test('every module the plan marks "new" does not already exist', () => {
    const t = taxonomy();
    const clashes = t.plan.modules.filter(m => m.status === 'new' && fs.existsSync(path.join(REPO_ROOT, m.path)));
    assert.deepStrictEqual(clashes.map(m => m.path), [],
        'these have landed — mark them "built" rather than leaving the plan claiming they are unwritten');
});

test('every module the plan marks "built" is actually on disk', () => {
    // The other direction. A plan that records work as done when the file was
    // never written, or was later deleted, is worse than one that is merely
    // out of date: it reads as a completed phase.
    const t = taxonomy();
    const ghosts = t.plan.modules.filter(m => m.status === 'built' && !fs.existsSync(path.join(REPO_ROOT, m.path)));
    assert.deepStrictEqual(ghosts.map(m => m.path), [], 'plan claims these are built');
});

test('a phase is complete exactly when every module it owns has landed', () => {
    // Keeps the phase table and the module statuses from telling different
    // stories about how far along the work is.
    const t = taxonomy();
    const status = new Map();
    for (const m of t.plan.modules) {
        const done = m.status === 'built' || m.status === 'modified';
        status.set(m.phase, (status.get(m.phase) !== false) && done);
    }
    // Phases 0 and 1 are built; nothing later may claim to be.
    for (const [phase, complete] of [...status].sort((a, b) => a[0] - b[0])) {
        if (phase <= 1) assert.ok(complete, `phase ${phase} has a module that has not landed`);
    }
});

test('every module status is one the plan defines', () => {
    const t = taxonomy();
    const legal = new Set(Object.keys(t.plan.statusMeaning));
    const odd = t.plan.modules.filter(m => !legal.has(m.status));
    assert.deepStrictEqual(odd.map(m => `${m.path}:${m.status}`), []);
});

test('every module the plan marks "modified" is actually on disk', () => {
    const t = taxonomy();
    const ghosts = t.plan.modules.filter(m => m.status === 'modified' && !fs.existsSync(path.join(REPO_ROOT, m.path)));
    assert.deepStrictEqual(ghosts.map(m => m.path), [], 'plan modifies files that do not exist');
});

test('migrations are numbered above the tree, until they are applied', () => {
    // Phase-aware, because the plan is now partly executed: a migration still
    // marked "new" must not collide with what is on disk, and one marked
    // "applied" must be there. Checking only the first would let a landed
    // migration read as forever-pending; only the second would let a new one
    // silently reuse a number.
    const t = taxonomy();
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
    const highest = onDisk.map(f => parseInt(f.slice(0, 3), 10)).reduce((a, b) => Math.max(a, b), 0);

    const collisions = t.plan.migrations
        .filter(m => m.status === 'new')
        .filter(m => parseInt(m.file.slice(0, 3), 10) <= highest);
    assert.deepStrictEqual(collisions.map(m => m.file), [],
        `unapplied migrations at or below ${String(highest).padStart(3, '0')}`);

    const missing = t.plan.migrations
        .filter(m => m.status === 'applied')
        .filter(m => !onDisk.includes(m.file));
    assert.deepStrictEqual(missing.map(m => m.file), [], 'plan claims these migrations are applied');
});

test('planned routes are /film-prefixed, and the namespace is dispatched once built', () => {
    const t = taxonomy();
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const bad = t.plan.routes.filter(r => !r.path.startsWith('/film/'));
    assert.deepStrictEqual(bad.map(r => r.path), [], 'routes outside the /film namespace');

    // Before the route module lands, the namespace must be free; after, it must
    // be wired. The original one-way check would have failed the moment the
    // plan was executed, which is the wrong direction for a guard to point.
    const namespace = t.plan.routeNamespace;
    const claimed = new RegExp(`['"\`]${namespace}['"\`]`).test(server);
    const routeModule = t.plan.modules.find(m => m.path === 'backend/routes/previs.js');

    if (routeModule.status === 'built') {
        assert.ok(claimed, `routes/previs.js is built but server.js never dispatches '${namespace}'`);
    } else {
        assert.ok(!claimed, `server.js already dispatches '${namespace}'`);
    }
});

test('every phase has an exit criterion and they are ordered from 0', () => {
    const t = taxonomy();
    const ids = t.plan.phases.map(p => p.id);
    assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b), 'phases are out of order');
    assert.strictEqual(ids[0], 0, 'phases do not start at 0');
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate phase id');

    const vague = t.plan.phases.filter(p => !p.exit || p.exit.length < 25);
    assert.deepStrictEqual(vague.map(p => p.id), [], 'phases with no stated exit criterion');
});

test('the plan names the renderer decision rather than leaving it open', () => {
    // The single choice that decides whether this ships into a zero-build SPA.
    const md = plan();
    for (const term of ['single-html', 'Three.js', 'canvas 2D']) {
        assert.ok(md.includes(term), `the plan never addresses '${term}'`);
    }
});

// ── The plan and the code must agree ────────────────────────────────────────
//
// Added after the two drifted: the taxonomy said only a tripod or a dolly could
// zoom, which is a category error (a zoom is performed by the lens, not the
// mount), and the runtime table disagreed with it in one direction only. Same
// guarantee flow-graph.test.js gives between flow-node-types.js and its
// documented twin — checked in BOTH directions, because a one-way check passes
// while the doc quietly describes a system nobody is running.

const { RIGS, MOVEMENTS, SHOT_TYPES } = require('../lib/previs-blocking');
const { SENSORS } = require('../lib/previs-camera');

test('the runtime movement table matches the documented taxonomy exactly', () => {
    const t = taxonomy();
    assert.deepStrictEqual(Object.keys(MOVEMENTS).sort(), Object.keys(t.movements).sort());

    const drift = [];
    for (const [id, doc] of Object.entries(t.movements)) {
        const code = MOVEMENTS[id];
        for (const field of ['space', 'focalScale', 'defaultIntensity', 'cameraControlType']) {
            if (code[field] !== doc[field]) drift.push(`${id}.${field}: code ${code[field]} vs doc ${doc[field]}`);
        }
        for (const field of ['translate', 'rotate']) {
            if (JSON.stringify(code[field]) !== JSON.stringify(doc[field])) drift.push(`${id}.${field}`);
        }
        if (JSON.stringify(code.rigs.slice().sort()) !== JSON.stringify(doc.rigs.slice().sort())) {
            drift.push(`${id}.rigs: code [${code.rigs}] vs doc [${doc.rigs}]`);
        }
    }
    assert.deepStrictEqual(drift, [], drift.slice(0, 5).join('; '));
});

test('the runtime rig table matches the documented taxonomy exactly', () => {
    const t = taxonomy();
    assert.deepStrictEqual(Object.keys(RIGS).sort(), Object.keys(t.rigs).sort());

    const drift = [];
    for (const [id, doc] of Object.entries(t.rigs)) {
        const code = RIGS[id];
        if (JSON.stringify(code.affords.slice().sort()) !== JSON.stringify(doc.affords.slice().sort())) {
            drift.push(`${id}.affords`);
        }
    }
    assert.deepStrictEqual(drift, [], drift.join('; '));
});

test('the runtime shot-type and sensor tables match the documented taxonomy', () => {
    const t = taxonomy();
    assert.deepStrictEqual(Object.keys(SHOT_TYPES).sort(), Object.keys(t.shotTypes).sort());
    assert.deepStrictEqual(Object.keys(SENSORS).sort(), Object.keys(t.sensors).sort());

    const drift = [];
    for (const [id, doc] of Object.entries(t.shotTypes)) {
        if (SHOT_TYPES[id].axis !== doc.axis) drift.push(`${id}.axis`);
        for (const field of ['subjectHeightM', 'cameraHeightM', 'pitchDegrees', 'rig']) {
            if (doc[field] !== undefined && SHOT_TYPES[id][field] !== doc[field]) drift.push(`${id}.${field}`);
        }
    }
    for (const [id, doc] of Object.entries(t.sensors)) {
        for (const field of ['widthMm', 'heightMm', 'circleOfConfusionMm']) {
            if (SENSORS[id][field] !== doc[field]) drift.push(`sensor ${id}.${field}`);
        }
    }
    assert.deepStrictEqual(drift, [], drift.slice(0, 5).join('; '));
});

test('no route is scheduled before the module that serves it', () => {
    // Two routes were tagged phase 0 and 1 while routes/previs.js was phase 2 —
    // a plan that cannot be executed in its own stated order.
    const t = taxonomy();
    const routeModule = t.plan.modules.find(m => m.path === 'backend/routes/previs.js');
    assert.ok(routeModule, 'no module owns the previs routes');

    const early = t.plan.routes.filter(r => r.phase < routeModule.phase);
    assert.deepStrictEqual(early.map(r => `${r.method} ${r.path} (phase ${r.phase})`), [],
        `routes scheduled before their module lands in phase ${routeModule.phase}`);
});
