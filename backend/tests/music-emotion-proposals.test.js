const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * EMOTION PROPOSALS: THE MODEL PROPOSES, A PERSON ACCEPTS, NOTHING PAID
 * RESTS ON A PROPOSAL.
 *
 * MUS-010. The emotional arc of a picture is the judgement the whole score
 * hangs on, and the connected agent IS the model here — so there is no
 * "run the proposer" route that hands the brief to a server-side LLM
 * (tests/mcp-no-server-llm.test.js exists to refuse exactly that). The flow
 * is the analysis precedent: `music_emotion_brief` hands over the ScoreBrief,
 * the accepted arc, the pending proposals, the schema with its bounds and
 * the coverage rule for free; the model reasons; `music_emotion_propose`
 * writes what came back as ranges that are PROPOSED, never accepted, kept
 * apart from the director's arc by status and source; and
 * `music_emotion_accept` is the explicit act that moves them — with edits —
 * into the arc the brief, the bounce and generation read.
 *
 * Set-based over the contract's own RANGES (every bounded field is refused
 * out of bounds, naming the field), over the four tools, and over the
 * lifecycle in both directions: what a proposal must NOT reach, and what an
 * acceptance MUST reach.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-emo-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const emo = require('../lib/music-emotion');
const contracts = require('../lib/music-session');
const context = require('../lib/music-context');
const route = require('../routes/music-sessions');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function film(lengthMs) {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'E')").run(projectId);
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location, description) VALUES (?, ?, '1', 'DINER', 'A man waits.')").run(sceneId, projectId);
    const shotId = generateId();
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, '1A', '{\"description\":\"He waits\"}', ?, 0)").run(shotId, sceneId, lengthMs || 10000);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name) VALUES (?, ?, ?, 'S')").run(sessionId, projectId, sceneId);
    return { projectId, sceneId, shotId, sessionId };
}
const range = (start, end, o) => ({ start_ms: start, end_ms: end, label: 'dread', valence: -0.5, arousal: 0.6, intensity: 0.7, confidence: 0.8, rationale: 'the waiting is the threat', ...(o || {}) });
const rows = sid => db.prepare('SELECT * FROM film_music_emotion_ranges WHERE session_id = ? ORDER BY start_ms, id').all(sid);

// ── The brief ──────────────────────────────────────────────────────────────

test('the emotion brief is the ScoreBrief plus the accepted arc, the pending proposals, the schema with its bounds and the coverage rule — and it writes nothing', () => {
    const f = film(10000);
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 0, 4000, 'calm', 0.2, 0.2, 0.4, 'director', 'accepted')").run(generateId(), f.sessionId);
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 4000, 10000, 'guess', -0.2, 0.5, 0.5, 'ai_proposal', 'proposed')").run(generateId(), f.sessionId);
    const before = db.prepare('SELECT COUNT(*) n FROM film_music_operations').get().n;
    const out = emo.emotionBrief(db, f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    assert.ok(out.brief && out.brief.picture && out.brief.screenplay !== undefined, 'the ScoreBrief is not in the emotion brief');
    assert.deepStrictEqual(out.accepted.map(r => r.label), ['calm'], 'the accepted arc is not exactly the accepted ranges');
    assert.deepStrictEqual(out.pending.map(r => r.label), ['guess'], 'pending proposals are not listed');
    assert.strictEqual(out.length_ms, 10000);
    for (const [key, r] of Object.entries(contracts.RANGES)) {
        const [table, column] = key.split('.');
        if (table !== 'film_music_emotion_ranges') continue;
        assert.deepStrictEqual(out.schema.fields[column] && [out.schema.fields[column].minimum, out.schema.fields[column].maximum], [r.min, r.max], `${column}: the schema does not carry the contract's bounds`);
    }
    for (const field of ['start_ms', 'end_ms', 'label', 'rationale', 'confidence']) assert.ok(out.schema.fields[field], `the schema does not name ${field}`);
    assert.ok(out.rules && out.rules.coverage_min > 0 && out.rules.coverage_min <= 1, 'no coverage rule');
    assert.match(out.instructions, /you (are|decide)|the model/i, 'the brief does not say the reasoning is the model’s');
    assert.match(out.instructions, /rationale/i, 'the brief does not ask for a rationale');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_operations').get().n, before, 'the brief wrote an operation');
    assert.strictEqual(emo.emotionBrief(db, generateId()).ok, false);
});

// ── Proposing ──────────────────────────────────────────────────────────────

test('a proposal is stored as proposed ai_proposal ranges with rationale and confidence, grouped under one proposal id, recorded as an operation, and reaches neither the brief nor generation', () => {
    const f = film(10000);
    const out = emo.propose(db, f.sessionId, { ranges: [range(0, 5000), range(5000, 10000, { label: 'release', valence: 0.6, arousal: 0.3 })], model: 'claude-fable-5-1' });
    assert.strictEqual(out.ok, true, out.error);
    assert.ok(out.proposal_id, 'no proposal id');
    assert.strictEqual(out.ranges.length, 2);
    const stored = rows(f.sessionId);
    assert.deepStrictEqual(stored.map(r => [r.status, r.source, r.proposal_id === out.proposal_id, r.rationale.length > 5, r.confidence]), [['proposed', 'ai_proposal', true, true, 0.8], ['proposed', 'ai_proposal', true, true, 0.8]]);
    assert.deepStrictEqual(out.coverage.fraction, 1);
    assert.deepStrictEqual(out.coverage.gaps, []);
    const op = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(out.operation_id);
    assert.ok(op && op.status === 'complete', 'no complete operation for the proposal');
    const params = JSON.parse(op.params_json);
    assert.strictEqual(params.kind, 'emotion_proposal');
    assert.strictEqual(params.proposal_id, out.proposal_id);
    assert.strictEqual(params.model, 'claude-fable-5-1');
    assert.strictEqual(op.provider, 'mcp-host', 'the operation does not say the connected model did the reasoning');
    // Nothing rests on it: the brief's accepted arc is empty, generation refuses.
    const brief = context.compileScoreContext(db, { sessionId: f.sessionId });
    assert.deepStrictEqual(brief.brief.emotion, [], 'a proposal reached the brief’s accepted arc');
    const gen = emo.emotionForGeneration(db, f.sessionId);
    assert.strictEqual(gen.ok, false);
    assert.strictEqual(gen.code, 'EMOTION_NOT_ACCEPTED');
    assert.strictEqual(gen.pending.length, 2);
    assert.match(gen.error, /accept/i);
});

test('every bounded field is refused out of bounds naming the field; an inverted or out-of-picture range is refused', () => {
    const f = film(10000);
    for (const [key, r] of Object.entries(contracts.RANGES)) {
        const [table, column] = key.split('.');
        if (table !== 'film_music_emotion_ranges') continue;
        for (const bad of [r.min - 0.01, r.max + 0.01]) {
            const out = emo.propose(db, f.sessionId, { ranges: [range(0, 10000, { [column]: bad })] });
            assert.strictEqual(out.ok, false, `${column} = ${bad} was accepted`);
            assert.ok(out.errors.some(e => e.field === column), `${column} = ${bad}: the refusal does not name the field: ${JSON.stringify(out.errors)}`);
        }
    }
    const inverted = emo.propose(db, f.sessionId, { ranges: [range(6000, 4000)] });
    assert.strictEqual(inverted.ok, false); assert.ok(inverted.errors.some(e => e.field === 'end_ms'));
    const past = emo.propose(db, f.sessionId, { ranges: [range(0, 12000)] });
    assert.strictEqual(past.ok, false); assert.ok(past.errors.some(e => e.field === 'end_ms' && /10000/.test(e.message)), 'a range past the picture was not refused with the length named');
    const empty = emo.propose(db, f.sessionId, { ranges: [] });
    assert.strictEqual(empty.ok, false); assert.match(empty.error, /no ranges/i);
    const noRationale = emo.propose(db, f.sessionId, { ranges: [range(0, 10000, { rationale: '' })] });
    assert.strictEqual(noRationale.ok, false); assert.ok(noRationale.errors.some(e => e.field === 'rationale'), 'a proposal with no rationale was accepted');
    assert.strictEqual(rows(f.sessionId).length, 0, 'a refused proposal wrote rows');
});

test('coverage is validated: overlaps are refused naming both ranges, gaps are reported, and too little coverage is refused', () => {
    const f = film(10000);
    const overlap = emo.propose(db, f.sessionId, { ranges: [range(0, 6000, { label: 'a' }), range(5000, 10000, { label: 'b' })] });
    assert.strictEqual(overlap.ok, false);
    assert.ok(overlap.errors.some(e => e.field === 'ranges' && /a/.test(e.message) && /b/.test(e.message) && /overlap/i.test(e.message)), JSON.stringify(overlap.errors));
    const thin = emo.propose(db, f.sessionId, { ranges: [range(0, 3000)] });
    assert.strictEqual(thin.ok, false);
    assert.ok(thin.errors.some(e => e.field === 'ranges' && /cover/i.test(e.message) && /30%/.test(e.message)), JSON.stringify(thin.errors));
    const gappy = emo.propose(db, f.sessionId, { ranges: [range(0, 4800, { label: 'a' }), range(5200, 10000, { label: 'b' })] });
    assert.strictEqual(gappy.ok, true, JSON.stringify(gappy.errors || gappy.error));
    assert.deepStrictEqual(gappy.coverage.gaps, [{ start_ms: 4800, end_ms: 5200 }]);
    assert.ok(Math.abs(gappy.coverage.fraction - 0.96) < 0.001);
    assert.ok(gappy.warnings.some(w => /gap/i.test(w)), 'a gap was not warned about');
});

test('a new proposal supersedes the still-proposed ranges of the last one and leaves accepted ranges alone', () => {
    const f = film(10000);
    const first = emo.propose(db, f.sessionId, { ranges: [range(0, 5000, { label: 'p1' }), range(5000, 10000, { label: 'p2' })] });
    assert.strictEqual(first.ok, true);
    const p1 = rows(f.sessionId).find(r => r.label === 'p1');
    const acc = emo.accept(db, f.sessionId, first.proposal_id, { range_ids: [p1.id] });
    assert.strictEqual(acc.ok, true, acc.error);
    const second = emo.propose(db, f.sessionId, { ranges: [range(0, 10000, { label: 'q1' })] });
    assert.strictEqual(second.ok, true);
    const state = Object.fromEntries(rows(f.sessionId).map(r => [r.label, r.status]));
    assert.deepStrictEqual(state, { p1: 'accepted', p2: 'rejected', q1: 'proposed' });
    assert.strictEqual(second.superseded.length, 1);
    assert.strictEqual(JSON.parse(db.prepare('SELECT params_json FROM film_music_operations WHERE id = ?').get(second.operation_id).params_json).supersedes, first.proposal_id);
});

// ── Accepting ──────────────────────────────────────────────────────────────

test('acceptance is explicit, per range, with edits applied, the rest rejected on request, and only then does the arc reach the brief and generation', () => {
    const f = film(10000);
    const out = emo.propose(db, f.sessionId, { ranges: [range(0, 5000, { label: 'a' }), range(5000, 10000, { label: 'b' })] });
    const [a, b] = rows(f.sessionId);
    const acc = emo.accept(db, f.sessionId, out.proposal_id, { range_ids: [a.id], edits: { [a.id]: { label: 'unease', valence: -0.3 } }, reject_rest: true });
    assert.strictEqual(acc.ok, true, acc.error);
    assert.deepStrictEqual(acc.accepted.map(r => [r.id, r.label, r.valence, r.status]), [[a.id, 'unease', -0.3, 'accepted']]);
    assert.deepStrictEqual(acc.rejected.map(r => r.id), [b.id]);
    const after = Object.fromEntries(rows(f.sessionId).map(r => [r.id, r]));
    assert.strictEqual(after[a.id].source, 'ai_proposal', 'accepting rewrote the provenance');
    assert.strictEqual(after[a.id].rationale, a.rationale, 'accepting lost the rationale');
    assert.strictEqual(after[b.id].status, 'rejected');
    const brief = context.compileScoreContext(db, { sessionId: f.sessionId });
    assert.deepStrictEqual(brief.brief.emotion.map(e => e.label), ['unease']);
    const gen = emo.emotionForGeneration(db, f.sessionId);
    assert.strictEqual(gen.ok, true);
    assert.deepStrictEqual(gen.accepted.map(e => e.id), [a.id]);
    assert.deepStrictEqual(gen.pending, []);
    // An edit outside the bounds is refused with the field named, and nothing is accepted.
    const g = film(10000);
    const p = emo.propose(db, g.sessionId, { ranges: [range(0, 10000)] });
    const r = rows(g.sessionId)[0];
    const bad = emo.accept(db, g.sessionId, p.proposal_id, { range_ids: [r.id], edits: { [r.id]: { valence: 2 } } });
    assert.strictEqual(bad.ok, false); assert.ok(bad.errors.some(e => e.field === 'valence'));
    assert.strictEqual(rows(g.sessionId)[0].status, 'proposed');
    // Accepting a proposal that is not this session's is not found.
    assert.strictEqual(emo.accept(db, g.sessionId, out.proposal_id, {}).ok, false);
    // A generation with nothing at all is refused too, and says so.
    const h = film(10000);
    assert.strictEqual(emo.emotionForGeneration(db, h.sessionId).code, 'EMOTION_NOT_ACCEPTED');
});

test('the accepted arc lists a proposal only once it is accepted, and the operation lineage says which proposal it came from', () => {
    const f = film(10000);
    const out = emo.propose(db, f.sessionId, { ranges: [range(0, 10000)] });
    const list = emo.listProposals(db, f.sessionId);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].proposal_id, out.proposal_id);
    assert.deepStrictEqual(list[0].counts, { proposed: 1, accepted: 0, rejected: 0 });
    assert.strictEqual(list[0].current, true);
    emo.accept(db, f.sessionId, out.proposal_id, {});
    assert.deepStrictEqual(emo.listProposals(db, f.sessionId)[0].counts, { proposed: 0, accepted: 1, rejected: 0 });
});

// ── Served and reachable ───────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), {})).catch(reject);
    });
}

test('brief, propose, list and accept are served, and the four tools say what they are', async () => {
    const f = film(10000);
    const b = await call('GET', `/film/music-sessions/${f.sessionId}/emotion/brief`);
    assert.strictEqual(b.status, 200, JSON.stringify(b.body).slice(0, 200));
    assert.ok(b.body.schema && b.body.instructions);
    const p = await call('POST', `/film/music-sessions/${f.sessionId}/emotion/proposals`, { ranges: [range(0, 10000)] });
    assert.strictEqual(p.status, 201, JSON.stringify(p.body).slice(0, 200));
    const bad = await call('POST', `/film/music-sessions/${f.sessionId}/emotion/proposals`, { ranges: [range(0, 10000, { arousal: 5 })] });
    assert.strictEqual(bad.status, 400);
    const l = await call('GET', `/film/music-sessions/${f.sessionId}/emotion/proposals`);
    assert.strictEqual(l.status, 200); assert.strictEqual(l.body.proposals.length, 1);
    const a = await call('POST', `/film/music-sessions/${f.sessionId}/emotion/proposals/${p.body.proposal_id}/accept`, {});
    assert.strictEqual(a.status, 200, JSON.stringify(a.body).slice(0, 200));
    assert.strictEqual(a.body.accepted.length, 1);
    assert.strictEqual((await call('POST', `/film/music-sessions/${f.sessionId}/emotion/proposals/${generateId()}/accept`, {})).status, 404);

    const tools = Object.fromEntries(['music_emotion_brief', 'music_emotion_propose', 'music_emotion_proposals', 'music_emotion_accept'].map(n => [n, PRODUCTION_TOOLS.find(t => t.name === n)]));
    for (const [n, t] of Object.entries(tools)) assert.ok(t, `no ${n} tool`);
    assert.strictEqual(tools.music_emotion_brief.method, 'GET'); assert.match(tools.music_emotion_brief.description, /free|spends nothing/i);
    assert.match(tools.music_emotion_brief.description, /you (are|decide)|the model/i, 'the brief tool does not say the reasoning is the model’s');
    assert.strictEqual(tools.music_emotion_propose.method, 'POST');
    assert.match(tools.music_emotion_propose.description, /proposed|not accepted|never accepted/i, 'the propose tool does not say a proposal is not an acceptance');
    assert.match(tools.music_emotion_propose.description, /rationale/i);
    assert.strictEqual(tools.music_emotion_proposals.method, 'GET'); assert.match(tools.music_emotion_proposals.description, /free/i);
    assert.strictEqual(tools.music_emotion_accept.method, 'POST'); assert.match(tools.music_emotion_accept.description, /explicit|person|director/i);
    assert.strictEqual(tools.music_emotion_accept.path({ session_id: 'S', proposal_id: 'P' }), '/film/music-sessions/S/emotion/proposals/P/accept');
    // No tool here hands the reasoning to a server-side model.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'music-emotion.js'), 'utf8');
    assert.ok(!/llm-client|callProjectLLM|streamProjectLLM|providers\.resolve/.test(src), 'the proposal module reaches a server-side model');
});

test('the workstation shows a proposal’s rationale and the pending count, and a range still says it is a proposal', () => {
    assert.match(SPA, /data-mw="film_music_emotion_ranges:rationale"|c\('rationale'/, 'the rationale has no control on the page');
    const lane = SPA.slice(SPA.indexOf('function mwEmotionHtml'), SPA.indexOf('function mwEmotionHtml') + 3000);
    assert.match(lane, /proposed/, 'the lane does not distinguish a proposal');
    assert.match(lane, /rationale/, 'the lane does not carry the rationale');
    assert.match(lane, /pending|proposal/i, 'the lane does not say proposals are waiting');
});
