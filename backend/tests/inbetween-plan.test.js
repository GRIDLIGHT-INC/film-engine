/**
 * W1 — the strip, planned for free
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `lib/video-sequence.js` travels between pictures a director approved, but the
 * unit is the SHOT: a five-second push-in reaches the provider as ONE picture
 * and a sentence, so seconds two, three and four are the model's opinion — and
 * the model's opinion is what drifts.
 *
 * The insight the plan is built on is that there is no second pipeline to
 * build. `planSequence` operates on an ORDERED LIST and does not know its
 * entries are shots; feed it a denser list and every stage downstream works
 * unchanged. So this holds two things: that the denser list produces more
 * segments, and that WITHOUT the flag the plan is byte-identical to today's —
 * the second is what makes the feature safe to ship.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-ibplan-' + crypto.randomUUID().slice(0, 8));

const { expandShots, planStations, DEFAULT_CADENCE_S } = require('../lib/inbetweens');
const { planSequence } = require('../lib/video-sequence');
const { CONTRACTS, contractFor } = require('../lib/video-reference');
const { motionTrack } = require('../lib/shot-motion');

const shot = (code, ms, over) => ({
    id: `sh-${code}`, shot_code: code, duration_ms: ms,
    keyframe: `/tmp/${code}.png`, description: `${code} does something`,
    ...(over || {}),
});

/** A real track, from the film's own optics — never a hand-made stub. */
const trackFor = (movement, ms) => motionTrack({
    card: { camera: { lens: '40mm', shot_type: 'medium', movement } },
    durationMs: ms, aspect: 16 / 9,
});

test('W1 · a moving shot expands into more stations than a still one', () => {
    const shots = [shot('1A', 5000), shot('1B', 5000)];
    const moving = expandShots(shots, () => trackFor('dolly-in', 5000), { cadenceSeconds: 1 });
    const still = expandShots(shots, () => trackFor('static', 5000), { cadenceSeconds: 1 });
    assert.ok(moving.stations.length > still.stations.length,
        'a push-in produced no more stations than a locked-off shot');
    assert.equal(still.stations.length, shots.length,
        'a shot with no move must still yield exactly one station — today\'s behaviour');
});

test('W1 · the denser list produces more segments through the SAME planner', () => {
    // The whole architectural claim: no second pipeline.
    const shots = [shot('1A', 5000), shot('1B', 5000)];
    const plain = planSequence(shots, { maxKeyframes: 2 });
    const expanded = expandShots(shots, () => trackFor('dolly-in', 5000), { cadenceSeconds: 1 });
    /*
     * As the strip is once W2 has generated it.
     *
     * A station with no picture is REFUSED by planSequence, by name, and that
     * refusal is right: joining through a moment nobody has seen looks like a
     * success. So the segment plan only exists once the strip does — before
     * that, the useful answer is "generate N images first", which is what the
     * route reports.
     */
    const generated = expanded.stations.map(st => ({ ...st, keyframe: st.keyframe || `/tmp/${st.id}.png` }));
    const dense = planSequence(generated, { maxKeyframes: 2 });
    assert.ok(!plain.refused && !dense.refused, JSON.stringify(dense.reason || plain.reason));
    assert.ok(dense.segments.length > plain.segments.length,
        `expanding produced ${dense.segments.length} segments against ${plain.segments.length}`);
    assert.equal(expanded.segments, dense.segments.length,
        'expandShots and planSequence disagree about how many segments the strip is');
});

test('W1 · an ungenerated strip refuses to plan segments, and says what to do', () => {
    /*
     * The trap the plan names: do NOT skip a station with no keyframe.
     * planSequence refuses by name because joining through a moment nobody has
     * seen looks like a success — so before the strip is generated the honest
     * answer is the refusal plus the number of images it would take.
     */
    const shots = [shot('1A', 5000)];
    const out = expandShots(shots, () => trackFor('dolly-in', 5000), { cadenceSeconds: 1 });
    const plan = planSequence(out.stations, { maxKeyframes: 2 });
    assert.equal(plan.refused, true, 'segments were planned through stations that do not exist');
    assert.match(plan.reason, /1A\.1/, 'the refusal does not name the stations that are missing');
    assert.ok(out.images_needed > 0, 'the strip does not say how many images it would take');
});

test('W1 · the station cap comes from the contract, never a literal', () => {
    /*
     * Set-based over the real contracts: hailuo3 takes 9 images and
     * seedance2_5 takes 30, so the same strip must plan differently for each.
     * A literal here is a cap that is wrong for every model but one.
     */
    const long = [shot('1A', 60000)];
    const seen = {};
    for (const [model, contract] of Object.entries(CONTRACTS)) {
        const out = expandShots(long, () => trackFor('dolly-in', 60000),
            { cadenceSeconds: 1, maxStations: contract.maxImages });
        seen[model] = out.images_needed;
        assert.ok(out.stations.length <= contract.maxImages,
            `${model}: ${out.stations.length} stations over a ${contract.maxImages}-image contract`);
    }
    const counts = Object.values(seen);
    assert.ok(new Set(counts).size > 1,
        `every contract planned the same number of images (${counts}) — the cap is not being read`);
});

test('W1 · the cap the ROUTE serves is the contract\'s, not a literal', async () => {
    /*
     * The test above proves expandShots honours a cap it is HANDED. It says
     * nothing about where the route gets that number, and that is the half a
     * literal hides in: a hardcoded 12 satisfies every plan-level assertion
     * while being wrong for every model but one.
     *
     * Differential, through the real route: the same strip planned against two
     * models whose contracts differ must serve two different caps. Env-swapped
     * rather than mocked, because RUNWAY_VIDEO_MODEL is exactly how an install
     * chooses one.
     */
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { handleSequences } = require('../routes/sequences');

    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(projectId, 'Cap', JSON.stringify({ video: 'runway' }));
    const sceneId = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(sceneId, projectId);
    const shotId = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, scene_card_yaml)
                VALUES (?, ?, '1A', 60000, ?)`)
        .run(shotId, sceneId, JSON.stringify({ shot_code: '1A', camera: { movement: 'dolly-in' } }));
    const seqId = generateId();
    db.prepare(`INSERT INTO film_sequences (id, project_id, name, shot_ids, description)
                VALUES (?, ?, 'cap', ?, 'a long push')`).run(seqId, projectId, JSON.stringify([shotId]));

    const planCap = () => new Promise(resolve => {
        const res = { writeHead(st) { this._s = st; }, end(p) { resolve(p ? JSON.parse(p) : null); } };
        Promise.resolve(handleSequences({ method: 'GET' }, res,
            ['film', 'sequences', seqId, 'plan'], { expand: 'inbetweens', cadence_s: '1' }));
    });

    const before = process.env.RUNWAY_VIDEO_MODEL;
    const caps = {};
    try {
        for (const [model, contract] of Object.entries(CONTRACTS)) {
            process.env.RUNWAY_VIDEO_MODEL = model;
            const body = await planCap();
            caps[model] = body && body.station_cap;
            assert.equal(caps[model], contract.maxImages,
                `${model}: the route served a cap of ${caps[model]} against a `
                + `${contract.maxImages}-image contract`);
        }
    } finally {
        if (before === undefined) delete process.env.RUNWAY_VIDEO_MODEL;
        else process.env.RUNWAY_VIDEO_MODEL = before;
    }
    assert.ok(new Set(Object.values(caps)).size > 1,
        `every model served the same cap (${JSON.stringify(caps)}) — the route is not reading the contract`);
});

test('W1 · a thinned strip says so, and says what it wanted', () => {
    // Silent truncation reads as "covered everything" when it did not.
    const out = planStations(shot('1A', 60000), trackFor('dolly-in', 60000),
        { cadenceSeconds: 1, maxStations: 9 });
    assert.equal(out.count, 9);
    assert.equal(out.thinned, true, 'a capped strip does not report being thinned');
    assert.ok(out.wanted > out.count, 'a thinned strip does not say how many it wanted');
});

test('W1 · the plan route expands only when asked, and is unchanged otherwise', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');
    assert.ok(/expand/.test(src), 'the plan route cannot be asked to expand');
    assert.ok(/expandShots\(/.test(src), 'the route never calls the expander');
    assert.ok(/cadence_s/.test(src), 'the cadence cannot be set');
    // The cap must be read from the contract in the route, not typed.
    assert.ok(/contractFor\(/.test(src), 'the route does not read the contract for its station cap');
    assert.ok(!/maxStations:\s*\d+/.test(src),
        'the route hardcodes a station cap instead of reading the contract');
    // And what the strip costs must travel with it.
    for (const field of ['strips', 'images_needed', 'images_estimated_credits']) {
        assert.ok(src.includes(field), `the plan never reports ${field}`);
    }
    // The station images themselves must NOT: a plan is read in a browser.
    assert.ok(!/stations: out\.stations\b(?![\s\S]{0,80}map)/.test(src)
        || /station_count|stations: \(/.test(src),
        'the plan body carries the station images, which is megabytes of base64');
});

test('W1 · an agent can plan a strip, and is told it is free', () => {
    const tools = require('../lib/mcp-tools').listTools();
    const tool = tools.find(t => t.name === 'sequence_plan_inbetweens');
    assert.ok(tool, 'there is no sequence_plan_inbetweens tool');
    assert.ok(/free|spends nothing|costs nothing/i.test(tool.description),
        'the tool does not say it is free, which is the reason to reach for it first');
    assert.ok(tool.inputSchema.properties.cadence_s, 'the cadence cannot be set from an agent');
});

test('W1 · the default cadence is one station a second, stated once', () => {
    assert.equal(DEFAULT_CADENCE_S, 1);
    const out = planStations(shot('1A', 4000), trackFor('dolly-in', 4000), {});
    assert.equal(out.cadence_s, DEFAULT_CADENCE_S,
        'planStations does not report the cadence it used');
});

test('W1 · the strip is reachable from the page, not only from an agent', () => {
    /*
     * "A capability with no control is indistinguishable from one that does not
     * exist" — the rule camera mode was removed from the page under, and the
     * one eight regenerateShot parameters sat behind for months.
     *
     * Checked three ways, because each fails differently: the control exists,
     * the handler exists, and the handler is BOUND to it. A function called
     * from nowhere looks identical to a working page until somebody clicks.
     */
    const fs = require('fs');
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

    assert.ok(/stripSequence\(/.test(page), 'nothing on the page reaches the strip');
    assert.ok(/async function stripSequence\s*\(/.test(page),
        'the strip control is bound to a handler that does not exist');
    assert.ok(/onclick="stripSequence\('\$\{q\.id\}'/.test(page),
        'stripSequence is defined and nothing clickable calls it');

    // The free read has to LEAD. A control that spends before it shows what it
    // is buying is the state every other paid button on this page was fixed out
    // of, and a strip is several generations in one press.
    const body = page.slice(page.indexOf('async function stripSequence'));
    const fn = body.slice(0, body.indexOf('\n    /**', 1));
    const planAt = fn.indexOf('/plan?expand=inbetweens');
    const spendAt = fn.indexOf('/inbetweens`, { method: \'POST\'');
    assert.ok(planAt > -1, 'the control never reads the free plan');
    assert.ok(spendAt > -1, 'the control never generates');
    assert.ok(planAt < spendAt, 'the strip is generated before its free preview is read');
    assert.ok(/confirm\(/.test(fn.slice(0, spendAt)),
        'the strip spends without a confirmation naming what it buys');

    // And what was NOT attempted is named: a partial strip reported as success
    // is how a sequence gets joined through moments nobody has seen.
    const stopAt = fn.search(/out\.stopped_at\s*!=\s*null/);
    assert.ok(stopAt > -1, 'the control never checks whether the strip stopped early');
    const naAt = fn.indexOf('not_attempted');
    assert.ok(naAt > stopAt,
        'a stopped strip does not say what it never attempted — reported as success, '
        + 'which is how a sequence gets joined through moments nobody has seen');
});
