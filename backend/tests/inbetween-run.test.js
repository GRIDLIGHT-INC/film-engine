/**
 * W2–W4 — generating, correcting and approving a strip
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Each station is generated FROM THE ONE BEFORE IT, through the existing refine
 * path — picture in, no scene card, one instruction. That is the decision the
 * plan records and it is the whole source of continuity: generating each
 * station independently from the shot's keyframe would give N independent rolls
 * of the dice and reinvent the drift the strip exists to remove.
 *
 * Set-based over the stations of a real strip rather than over one example,
 * because the failure is partial by nature: a runner that chains stations 1 and
 * 2 and then refines 3 off the keyframe produces a strip that looks right at
 * the front and comes apart at the back.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-ibrun-' + crypto.randomUUID().slice(0, 8));

const run = require('../lib/inbetween-run');
const { planStations } = require('../lib/inbetweens');
const { motionTrack } = require('../lib/shot-motion');

const SRC = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const shot = (code, ms) => ({ id: `sh-${code}`, shot_code: code, duration_ms: ms, keyframe: `/tmp/${code}.png` });
const strip = (ms = 5000) => planStations(shot('1A', ms),
    motionTrack({ card: { camera: { lens: '40mm', shot_type: 'medium', movement: 'dolly-in' } },
        durationMs: ms, aspect: 16 / 9 }), { cadenceSeconds: 1 });

/** A recorder standing in for the refine core, so nothing is generated. */
function recorder(failAt) {
    const calls = [];
    return {
        calls,
        refine: async ({ instruction, reference }) => {
            calls.push({ instruction, reference });
            if (failAt !== undefined && calls.length === failAt) {
                throw new Error('provider declined');
            }
            return { asset_id: `asset-${calls.length}`, image_path: `/tmp/station-${calls.length}.png` };
        },
    };
}

/* ── W2 ─────────────────────────────────────────────────────────────────── */

test('W2 · a strip issues exactly one generation per station after the first', async () => {
    const s = strip();
    const r = recorder();
    const out = await run.runStrip(s, { refine: r.refine, keyframePath: '/tmp/1A.png' });
    assert.equal(r.calls.length, s.generations,
        `a ${s.count}-station strip issued ${r.calls.length} refines, not ${s.generations}`);
    assert.equal(out.generated.length, s.generations);
    assert.equal(out.stopped_at, null);
});

test('W2 · station 0 is never generated — it is the approved frame', async () => {
    const s = strip();
    const r = recorder();
    const out = await run.runStrip(s, { refine: r.refine, keyframePath: '/tmp/1A.png' });
    assert.ok(!out.generated.some(g => g.index === 0),
        'station 0 was generated — a frame made from itself can only reproduce itself');
    // Explicitly asked for from the start: still refused, because station 0 is
    // the approved frame and not a station the chain may rewrite.
    const forced = await run.runStrip(s, { refine: recorder().refine, keyframePath: '/tmp/1A.png', fromIndex: 0 });
    assert.ok(!forced.generated.some(g => g.index === 0),
        'asking to run from 0 regenerated the approved keyframe');
    assert.deepEqual(out.generated.map(g => g.index),
        s.stations.slice(1).map(st => st.index));
});

test('W2 · each station refines from the PREVIOUS one, never from the keyframe', async () => {
    /*
     * The chain IS the feature. Set-based over every call: a runner that chains
     * the first two and then reverts to the keyframe produces a strip that
     * looks right at the front and comes apart at the back.
     */
    const s = strip();
    const r = recorder();
    await run.runStrip(s, { refine: r.refine, keyframePath: '/tmp/1A.png' });
    assert.equal(r.calls[0].reference, '/tmp/1A.png',
        'the first in-between must refine from the approved keyframe');
    for (let i = 1; i < r.calls.length; i++) {
        assert.equal(r.calls[i].reference, `/tmp/station-${i}.png`,
            `station ${i + 1} refined from ${r.calls[i].reference} rather than the frame before it`);
    }
});

test('W2 · every call carries the station\'s own instruction, and only that', async () => {
    const s = strip();
    const r = recorder();
    await run.runStrip(s, { refine: r.refine, keyframePath: '/tmp/1A.png' });
    r.calls.forEach((c, i) => {
        assert.ok(c.instruction && c.instruction.length > 3,
            `station ${i + 1} was refined with no instruction`);
        assert.equal(c.instruction, s.stations[i + 1].instruction);
    });
});

test('W2 · a refusal stops the walk and names what was not attempted', async () => {
    // generateSequence already sets this rule: do not buy the same failure N
    // times, and do not report a partial strip as a success.
    const s = strip();
    const r = recorder(2);
    const out = await run.runStrip(s, { refine: r.refine, keyframePath: '/tmp/1A.png' });
    assert.equal(r.calls.length, 2, 'the walk continued past a provider refusal');
    assert.equal(out.stopped_at, s.stations[2].index);
    assert.ok(out.not_attempted.length, 'the stations that were skipped are not named');
    assert.deepEqual(out.not_attempted, s.stations.slice(3).map(st => st.index));
    assert.match(out.error, /declined/);
});

test('W2 · re-running skips stations that already exist', async () => {
    const s = strip();
    const r = recorder();
    // The second station is already on disk from an earlier run.
    const have = { [s.stations[1].index]: { asset_id: 'old', image_path: '/tmp/old.png' } };
    await run.runStrip(s, { refine: r.refine, keyframePath: '/tmp/1A.png', existing: have });
    assert.equal(r.calls.length, s.generations - 1, 'an existing station was bought again');
    assert.equal(r.calls[0].reference, '/tmp/old.png',
        'the chain did not continue from the station that already existed');
});

test('W2 · a station records what it is, and creates no table to do it', () => {
    /*
     * The metadata lives in the ROUTE because the runner is deliberately free
     * of the database — `refine` arrives as a function so the chain is testable
     * without generating anything, the same split planStations makes with
     * `motionFor`.
     */
    const runner = SRC('lib/inbetween-run.js');
    assert.ok(!/require\('\.\.\/db/.test(runner), 'the runner reaches for the database');
    const src = SRC('routes/sequences.js');
    for (const field of ['sequence_id', 'shot_id', 'station_index', 'at_ms', 'instruction', 'refined_from', 'transform']) {
        assert.ok(src.includes(field), `a station asset records no ${field}`);
    }
    // A station must never land on the shot's own frame, or generating a strip
    // destroys the approved keyframe it was refined from.
    assert.ok(/function stationPath/.test(src), 'stations have no path of their own');
    assert.ok(/\.s\$\{index\}\.png|s\$\{station\.index\}/.test(src),
        'a station is written to the shot\'s own filename, which overwrites the keyframe');
    // No new table: this inherits the shot_frames archive for free.
    assert.ok(!/CREATE TABLE/i.test(src), 'the route creates a table; stations are film_assets rows');
    const mig = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
        .find(f => /inbetween/i.test(f));
    assert.ok(mig, 'there is no migration for the station indexes');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', mig), 'utf8');
    assert.ok(!/CREATE TABLE/i.test(sql), 'the migration creates a table; stations are film_assets rows');
    for (const key of ['sequence_id', 'station_index']) {
        assert.ok(sql.includes(key), `the migration does not index ${key}`);
    }
});

/* ── W3 ─────────────────────────────────────────────────────────────────── */

test('W3 · editing a station re-runs it and everything after it', async () => {
    /*
     * A chain re-inherits from the frame that changed, so stations before the
     * edit are untouched and stations after it MUST be redone — leaving them
     * would leave a strip whose second half descends from a frame that no
     * longer exists.
     */
    const s = strip();
    const r = recorder();
    const from = s.stations[2].index;
    const out = await run.runStrip(s, { refine: r.refine, keyframePath: '/tmp/1A.png', fromIndex: from });
    const expected = s.stations.filter(st => st.index >= from).map(st => st.index);
    assert.deepEqual(out.generated.map(g => g.index), expected,
        'editing a station did not re-run exactly it and the ones after it');
    assert.ok(!out.generated.some(g => g.index < from), 'a station before the edit was regenerated');
});

test('W3 · the route offers the edit and the delete, and an agent can reach them', () => {
    const src = SRC('routes/sequences.js');
    assert.ok(/stations/.test(src), 'the route has no station surface');
    assert.ok(/'PUT'/.test(src) && /'DELETE'/.test(src), 'a station cannot be changed or dropped');
    const tools = require('../lib/mcp-tools').listTools();
    for (const name of ['sequence_inbetweens', 'sequence_station_update', 'sequence_station_delete']) {
        assert.ok(tools.find(t => t.name === name), `there is no ${name} tool`);
    }
});

/* ── W4 ─────────────────────────────────────────────────────────────────── */

test('W4 · a strip fingerprints over its stations and their instructions', () => {
    const s = strip();
    const stations = s.stations.map((st, i) => ({ ...st, asset_id: `a${i}` }));
    const a = run.stripFingerprint(stations);
    assert.ok(a && a.length > 8, 'a strip has no fingerprint');
    // Regenerating one station changes it.
    const b = run.stripFingerprint(stations.map((st, i) => i === 2 ? { ...st, asset_id: 'different' } : st));
    assert.notEqual(a, b, 'replacing a station leaves the fingerprint unchanged');
    // So does rewording one.
    const c = run.stripFingerprint(stations.map((st, i) => i === 2 ? { ...st, instruction: 'other' } : st));
    assert.notEqual(a, c, 'rewording a station leaves the fingerprint unchanged');
    // And order matters: the strip is a sequence, not a set.
    assert.notEqual(a, run.stripFingerprint(stations.slice().reverse()),
        'the fingerprint ignores the order of the strip');
    // And the ORDER, not just the multiset: two stations swapped is a
    // different move, so their positions have to be part of the material.
    const swapped = stations.slice();
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    assert.notEqual(a, run.stripFingerprint(swapped), 'two stations swapped fingerprint the same');
});

test('W4 · video refuses when the strip is not the one that was approved', async () => {
    /*
     * Exercised through the real route, not grepped: the string
     * "STALE_APPROVAL" survives every mutation that disables the gate around
     * it, so a source check passes on a gate that never fires. This is the
     * whole contract — an approval means nothing if the thing it described can
     * change underneath it.
     */
    const { db } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { handleSequences } = require('../routes/sequences');
    const { generateId } = require('../db/database');

    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Strip gate');
    const sceneId = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(sceneId, projectId);
    const shotId = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, scene_card_yaml)
                VALUES (?, ?, '1A', 5000, ?)`)
        .run(shotId, sceneId, JSON.stringify({ shot_code: '1A', camera: { movement: 'dolly-in', lens: '40mm' } }));
    const seqId = generateId();
    db.prepare(`INSERT INTO film_sequences (id, project_id, name, shot_ids, description)
                VALUES (?, ?, 'strip', ?, 'a move')`).run(seqId, projectId, JSON.stringify([shotId]));

    const call = (method, parts, body, query) => new Promise(resolve => {
        const res = {
            writeHead(st) { this._s = st; },
            end(p) { resolve({ status: this._s, body: p ? JSON.parse(p) : null }); },
        };
        Promise.resolve(handleSequences({ method, body }, res, parts, query || {}));
    });

    // Nothing approved: the gate must not fire. Every sequence that exists
    // today is in this state.
    const open = await call('POST', ['film', 'sequences', seqId, 'generate'], {});
    // Asserted on the ERROR, not the status: this shot has no keyframe, so
    // planSequence refuses it by name with a 409 of its own — which is correct
    // and is a different refusal. Reading the status alone would confuse the
    // two and pass on a gate that fires when it should not.
    assert.notEqual(open.body && open.body.error, 'STALE_APPROVAL',
        'an unapproved sequence was refused by the approval gate');

    // Approve a fingerprint that does not describe this strip, then generate.
    db.prepare("UPDATE film_sequences SET strip_fingerprint = 'not-this-strip' WHERE id = ?").run(seqId);
    const stale = await call('POST', ['film', 'sequences', seqId, 'generate'], { expand: 'inbetweens' });
    assert.equal(stale.status, 409, 'a strip that changed after approval was generated anyway');
    assert.equal(stale.body.error, 'STALE_APPROVAL');
    assert.ok(stale.body.hint && /ignore_approval/.test(stale.body.hint),
        'the refusal does not say how to get past it — one you cannot pass is a reason never to approve');

    // And the deliberate way past works.
    const forced = await call('POST', ['film', 'sequences', seqId, 'generate'],
        { expand: 'inbetweens', ignore_approval: true });
    assert.notEqual(forced.body && forced.body.error, 'STALE_APPROVAL',
        'ignore_approval does not get past the gate');

    const tools = require('../lib/mcp-tools').listTools();
    assert.ok(tools.find(t => t.name === 'sequence_inbetweens_approve'),
        'a strip cannot be approved from an agent');
});

test('W4 · a sequence with no approved strip is unaffected', () => {
    // The safety property: every sequence that exists today keeps working.
    assert.equal(run.approvalState(null, []).stale, false);
    assert.equal(run.approvalState(null, []).approved, false);
    const stations = [{ index: 0, asset_id: 'a', instruction: null }];
    const fp = run.stripFingerprint(stations);
    assert.equal(run.approvalState(fp, stations).stale, false);
    assert.equal(run.approvalState(fp, stations).approved, true);
    assert.equal(run.approvalState('something-else', stations).stale, true);
});

test('W5 · bundle sends the strip as references; legs does not, and both say which', () => {
    /*
     * The shape was the half most likely to be declared and never consumed:
     * `?shape=bundle` parsed cleanly, and the planner then fell through to the
     * plain shot list, so a bundle was byte-identical to today's generation
     * with the strip reaching nothing. That reads as "the shape works".
     *
     * Read from the SOURCE of the generate path rather than by running a
     * provider, because what is being asserted is that the strip is put ON the
     * payload at all — a behavioural test with a stub provider passes just as
     * happily when reference_images is an empty array nobody built.
     */
    const src = SRC('routes/sequences.js');
    const gen = src.slice(src.indexOf('async function generateSequence'));

    assert.ok(/reference_images:\s*refs/.test(gen),
        'the bundle never puts the strip on the payload — the shape is parsed and consumed by nothing');
    // Bound to the ASSIGNMENT, not merely to the name appearing: `const picked =
    // { selected: refs } || selectReferences(...)` contains the call and never
    // runs it, and a bare /selectReferences\(/ passes on exactly that.
    assert.ok(/const picked = selectReferences\(/.test(gen),
        'the strip is attached without asking the model\'s contract whether it takes one');
    assert.ok(/role:\s*'inbetween'/.test(gen),
        'the strip travels with no role, so it cannot be ranked or refused by contract');

    // legs must NOT attach them: it is N-1 first/last generations, and a strip
    // sent as references beside its own endpoints asks the model which picture
    // is the truth.
    assert.ok(/shape_ === 'bundle' \? contractFor\(model\) : null/.test(gen),
        'the reference path is not gated on the bundle shape — legs would attach the strip too');

    // And what the model refused is named. A bundle silently degraded to a
    // plain generation looks exactly like one that worked.
    assert.ok(/strip_references_dropped/.test(gen), 'dropped strip references are not reported');
    assert.ok(/degraded/.test(gen),
        'a model that takes no in-between reference degrades the bundle in silence');

    // The registry is what decides, and it must still disagree between models —
    // otherwise the gate is vacuous.
    const { CONTRACTS } = require('../lib/video-reference');
    const takes = Object.entries(CONTRACTS).filter(([, c]) => c.roles.includes('inbetween')).map(([m]) => m);
    assert.ok(takes.length >= 1, 'no model declares the inbetween role — the bundle can never send one');
    assert.ok(takes.length < Object.keys(CONTRACTS).length,
        'every model declares the inbetween role — over-sending is a rejection that costs a generation');
});
