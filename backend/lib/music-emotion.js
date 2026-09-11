/**
 * EMOTION PROPOSALS (MUS-010): THE MODEL PROPOSES, A PERSON ACCEPTS, AND
 * NOTHING PAID RESTS ON A PROPOSAL.
 *
 * The emotional arc of a picture is the judgement the whole score hangs on.
 * The connected agent IS the model here — that is what lets this pipeline
 * reach an LLM with no API key of its own — so there is no "run the
 * proposer" route that hands the brief to a server-side model
 * (tests/mcp-no-server-llm.test.js exists to refuse exactly that). The flow
 * is the screenplay analysis precedent, pointed at music:
 *
 *   `emotionBrief`  — FREE. The ScoreBrief (the shots with timings, the exact
 *                     screenplay passages, the cast, the look, the cues), the
 *                     arc a person has already accepted, the proposals still
 *                     waiting, the schema with the contract's own bounds, the
 *                     coverage rule, and what a proposal is for. Facts out.
 *   `propose`       — writes what the model decided as ranges that are
 *                     PROPOSED, never accepted: status `proposed`, source
 *                     `ai_proposal`, a rationale per range (a number with no
 *                     reason is one nobody can argue with), a confidence, and
 *                     one proposal id for the batch. Bounds and coverage are
 *                     validated with the field named; overlaps are refused;
 *                     a new proposal supersedes the last one's still-proposed
 *                     ranges and leaves accepted ones alone.
 *   `accept`        — the explicit act, per range, with edits: the only path
 *                     from proposed to accepted. Nothing accepts by default.
 *   `emotionForGeneration` — what a generator may read: the accepted arc,
 *                     or a refusal naming the proposals still pending.
 *
 * Proposals and the director's arc share one table and are kept apart by
 * status and source — the brief, the bounce and generation read
 * `status = 'accepted'` only, so a proposal cannot reach anything paid by
 * being in the wrong list; it can only reach it by being accepted.
 */

const { generateId } = require('../db/database');
const contracts = require('./music-session');
const { compileScoreContext } = require('./music-context');

const { VALIDATORS, RANGES, toRow, fromRow } = contracts;

const TABLE = 'film_music_emotion_ranges';
/** A proposal must cover at least this much of the picture, or it is not an arc. */
const COVERAGE_MIN = 0.8;
/** A gap narrower than this between two ranges is a seam, not a hole. */
const SEAM_MS = 50;

const INSTRUCTIONS =
    'You are the model here: read the brief and decide the emotional arc of this picture as time ranges that together cover it. ' +
    'For each range give a label a composer can act on, valence (−1 despair … +1 elation), arousal (0 still … 1 frantic), intensity ' +
    '(0 barely felt … 1 overwhelming), a confidence (0–1) and a RATIONALE naming what in the picture or the screenplay earns it — ' +
    'a range with no rationale is refused, because a number nobody can argue with is a number nobody should accept. ' +
    'Ranges must not overlap, must sit inside the picture, and must cover at least ' + Math.round(COVERAGE_MIN * 100) + '% of it. ' +
    'Everything you write stays PROPOSED until a person accepts it; nothing paid rests on a proposal.';

const SCHEMA = Object.freeze({
    fields: {
        start_ms: { type: 'integer', minimum: 0, required: true, what: 'where the range starts, in the session clock' },
        end_ms: { type: 'integer', minimum: 1, required: true, what: 'where it ends; after start_ms and inside the picture' },
        label: { type: 'string', required: true, what: 'the feeling, in a word or two a composer can act on' },
        valence: { type: 'number', minimum: RANGES[`${TABLE}.valence`].min, maximum: RANGES[`${TABLE}.valence`].max, required: true },
        arousal: { type: 'number', minimum: RANGES[`${TABLE}.arousal`].min, maximum: RANGES[`${TABLE}.arousal`].max, required: true },
        intensity: { type: 'number', minimum: RANGES[`${TABLE}.intensity`].min, maximum: RANGES[`${TABLE}.intensity`].max, required: true },
        confidence: { type: 'number', minimum: RANGES[`${TABLE}.confidence`].min, maximum: RANGES[`${TABLE}.confidence`].max, required: true },
        rationale: { type: 'string', required: true, what: 'what in the picture or the screenplay earns this range' },
    },
});

const sessionRow = (db, sessionId) => db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId) || null;
const rangeRows = (db, sessionId) => db.prepare(`SELECT * FROM ${TABLE} WHERE session_id = ? ORDER BY start_ms, id`).all(sessionId).map(r => fromRow(TABLE, r));

/** The picture's length: the brief's, else the session's own arrangement. */
function lengthOf(brief, db, sessionId) {
    const fromBrief = brief && brief.brief && brief.brief.length && Number(brief.brief.length.ms);
    if (fromBrief > 0) return fromBrief;
    const m = contracts.readScoreSession(db, sessionId);
    return Number(m && m.duration_ms) || 0;
}

// ── The brief ──────────────────────────────────────────────────────────────

function emotionBrief(db, sessionId) {
    const session = sessionRow(db, sessionId);
    if (!session) return { ok: false, status: 404, error: 'Score session not found' };
    const compiled = compileScoreContext(db, { sessionId });
    const all = rangeRows(db, sessionId);
    return {
        ok: true, session_id: sessionId,
        brief: compiled.brief || null, warnings: compiled.warnings || [],
        length_ms: lengthOf(compiled, db, sessionId),
        accepted: all.filter(r => r.status === 'accepted'),
        pending: all.filter(r => r.status === 'proposed'),
        schema: SCHEMA,
        rules: { coverage_min: COVERAGE_MIN, seam_ms: SEAM_MS, no_overlap: true, inside_picture: true },
        instructions: INSTRUCTIONS,
        spends: 'nothing',
    };
}

// ── Coverage ───────────────────────────────────────────────────────────────

/** Overlaps (refused), gaps (reported) and the covered fraction of the picture. */
function coverageOf(ranges, lengthMs) {
    const sorted = ranges.map((r, i) => ({ ...r, _i: i })).sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
    const overlaps = [], gaps = [];
    let covered = 0, cursor = 0;
    for (let k = 0; k < sorted.length; k++) {
        const r = sorted[k];
        const prev = sorted[k - 1];
        if (prev && r.start_ms < prev.end_ms) overlaps.push({ a: prev, b: r, by_ms: prev.end_ms - r.start_ms });
        if (r.start_ms - cursor > SEAM_MS) gaps.push({ start_ms: cursor, end_ms: r.start_ms });
        covered += Math.max(0, r.end_ms - Math.max(r.start_ms, cursor));
        cursor = Math.max(cursor, r.end_ms);
    }
    if (lengthMs > 0 && lengthMs - cursor > SEAM_MS) gaps.push({ start_ms: cursor, end_ms: lengthMs });
    const fraction = lengthMs > 0 ? Math.min(1, covered / lengthMs) : 0;
    return { fraction: Math.round(fraction * 1000) / 1000, gaps, overlaps };
}

// ── Proposing ──────────────────────────────────────────────────────────────

/** Validate one proposed range against the contract, the schema's required fields, and the picture. */
function validateProposed(input, index, lengthMs) {
    const errors = [];
    const i = input || {};
    for (const [field, spec] of Object.entries(SCHEMA.fields)) {
        if (spec.required && (i[field] === undefined || i[field] === null || i[field] === '')) errors.push({ field, index, message: `${field} is required on range ${index + 1}` });
    }
    const v = VALIDATORS[TABLE]({ ...i, source: 'ai_proposal', status: 'proposed' });
    for (const e of v.errors || []) errors.push({ field: e.field, index, message: `range ${index + 1}: ${e.message}` });
    if (v.ok && lengthMs > 0 && v.value.end_ms > lengthMs) errors.push({ field: 'end_ms', index, message: `range ${index + 1} ends at ${v.value.end_ms} ms, past the picture (${lengthMs} ms)` });
    return { errors, value: v.ok ? v.value : null };
}

/**
 * Store a proposal. Refuses with every error named, writes nothing on
 * refusal, and on success writes the ranges, retires the previous proposal's
 * still-proposed ranges, and records the operation.
 */
function propose(db, sessionId, input) {
    const o = input || {};
    const session = sessionRow(db, sessionId);
    if (!session) return { ok: false, status: 404, error: 'Score session not found' };
    const list = Array.isArray(o.ranges) ? o.ranges : [];
    if (!list.length) return { ok: false, status: 400, error: 'no ranges: a proposal is a list of time ranges with valence, arousal, intensity, a label and a rationale' };
    const compiled = compileScoreContext(db, { sessionId });
    const lengthMs = lengthOf(compiled, db, sessionId);

    const errors = [], values = [];
    list.forEach((r, k) => { const v = validateProposed(r, k, lengthMs); errors.push(...v.errors); if (v.value) values.push(v.value); });
    let coverage = null, warnings = [];
    if (!errors.length) {
        coverage = coverageOf(values, lengthMs);
        for (const ov of coverage.overlaps) errors.push({ field: 'ranges', message: `"${ov.a.label}" (${ov.a.start_ms}–${ov.a.end_ms}) and "${ov.b.label}" (${ov.b.start_ms}–${ov.b.end_ms}) overlap by ${ov.by_ms} ms` });
        if (lengthMs > 0 && coverage.fraction < COVERAGE_MIN) errors.push({ field: 'ranges', message: `the proposal covers ${Math.round(coverage.fraction * 100)}% of the picture; an arc covers at least ${Math.round(COVERAGE_MIN * 100)}%` });
        for (const g of coverage.gaps) warnings.push(`gap with no emotion from ${g.start_ms} to ${g.end_ms} ms`);
    }
    if (errors.length) return { ok: false, status: 400, error: `the proposal was refused: ${errors.map(e => e.message).join('; ')}`, errors, coverage };

    const proposalId = generateId();
    const operationId = generateId();
    const previous = db.prepare(`SELECT DISTINCT proposal_id FROM ${TABLE} WHERE session_id = ? AND source = 'ai_proposal' AND proposal_id <> '' AND status = 'proposed'`).all(sessionId).map(r => r.proposal_id);
    const written = [];
    db.transaction(() => {
        // The last proposal's ranges nobody accepted are retired, not deleted: the lineage stays readable.
        const superseded = db.prepare(`SELECT id FROM ${TABLE} WHERE session_id = ? AND source = 'ai_proposal' AND status = 'proposed'`).all(sessionId).map(r => r.id);
        if (superseded.length) db.prepare(`UPDATE ${TABLE} SET status = 'rejected', updated_at = datetime('now') WHERE id IN (${superseded.map(() => '?').join(',')})`).run(...superseded);
        const insert = db.prepare(`INSERT INTO ${TABLE} (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status, confidence, rationale, proposal_id)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai_proposal', 'proposed', ?, ?, ?)`);
        for (const v of values) {
            const id = generateId();
            insert.run(id, sessionId, v.start_ms, v.end_ms, v.label, v.valence, v.arousal, v.intensity, v.confidence, v.rationale, proposalId);
            written.push(id);
        }
        const opv = VALIDATORS.film_music_operations({ kind: 'edit', status: 'complete', provider: 'mcp-host', model: o.model ? String(o.model) : '',
            params: { kind: 'emotion_proposal', proposal_id: proposalId, model: o.model || null, ranges: written, supersedes: previous[0] || null, superseded_ranges: superseded, coverage, notes: o.notes || '' } });
        const row = toRow('film_music_operations', opv.value);
        db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, provider, model, params_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
            .run(operationId, sessionId, row.kind, row.status, row.provider, row.model, row.params_json);
        written.superseded = superseded;
    })();

    const ranges = rangeRows(db, sessionId).filter(r => r.proposal_id === proposalId);
    return { ok: true, proposal_id: proposalId, operation_id: operationId, ranges, coverage, warnings, superseded: written.superseded || [],
        note: 'proposed, not accepted: nothing paid rests on these until a person accepts them (music_emotion_accept)' };
}

// ── Accepting ──────────────────────────────────────────────────────────────

/**
 * The explicit act. `range_ids` names which of the proposal's ranges to
 * accept (all of its proposed ranges when omitted), `edits` corrects fields
 * on the way in, and `reject_rest` retires the ones not accepted. Nothing
 * is written when any edit is refused.
 */
function accept(db, sessionId, proposalId, input) {
    const o = input || {};
    const session = sessionRow(db, sessionId);
    if (!session) return { ok: false, status: 404, error: 'Score session not found' };
    const mine = rangeRows(db, sessionId).filter(r => r.proposal_id === proposalId);
    if (!mine.length) return { ok: false, status: 404, error: 'Proposal not found in this session' };
    const wanted = Array.isArray(o.range_ids) && o.range_ids.length ? o.range_ids : mine.filter(r => r.status === 'proposed').map(r => r.id);
    const unknown = wanted.filter(id => !mine.some(r => r.id === id));
    if (unknown.length) return { ok: false, status: 404, error: `these ranges are not part of proposal ${proposalId}: ${unknown.join(', ')}` };

    const errors = [], next = [];
    for (const id of wanted) {
        const row = mine.find(r => r.id === id);
        const edit = (o.edits && o.edits[id]) || {};
        const merged = { ...row, ...edit, source: row.source, status: 'accepted' };
        const v = VALIDATORS[TABLE](merged);
        for (const e of v.errors || []) errors.push({ field: e.field, range_id: id, message: e.message });
        if (v.ok) next.push({ id, value: { ...v.value, rationale: edit.rationale !== undefined ? String(edit.rationale) : row.rationale } });
    }
    if (errors.length) return { ok: false, status: 400, error: `the acceptance was refused: ${errors.map(e => e.message).join('; ')}`, errors };

    const rest = o.reject_rest ? mine.filter(r => r.status === 'proposed' && !wanted.includes(r.id)).map(r => r.id) : [];
    db.transaction(() => {
        const upd = db.prepare(`UPDATE ${TABLE} SET start_ms = ?, end_ms = ?, label = ?, valence = ?, arousal = ?, intensity = ?, confidence = ?, rationale = ?, status = 'accepted', updated_at = datetime('now') WHERE id = ?`);
        for (const n of next) upd.run(n.value.start_ms, n.value.end_ms, n.value.label, n.value.valence, n.value.arousal, n.value.intensity, n.value.confidence, n.value.rationale, n.id);
        if (rest.length) db.prepare(`UPDATE ${TABLE} SET status = 'rejected', updated_at = datetime('now') WHERE id IN (${rest.map(() => '?').join(',')})`).run(...rest);
        const opv = VALIDATORS.film_music_operations({ kind: 'approve', status: 'complete', params: { kind: 'emotion_accept', proposal_id: proposalId, accepted: next.map(n => n.id), rejected: rest, edited: Object.keys(o.edits || {}) } });
        const row = toRow('film_music_operations', opv.value);
        db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, params_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
            .run(generateId(), sessionId, row.kind, row.status, row.params_json);
    })();
    const after = rangeRows(db, sessionId);
    return { ok: true, proposal_id: proposalId, accepted: after.filter(r => next.some(n => n.id === r.id)), rejected: after.filter(r => rest.includes(r.id)) };
}

/** Every proposal of a session, newest first, with what became of its ranges. */
function listProposals(db, sessionId) {
    const all = rangeRows(db, sessionId).filter(r => r.proposal_id);
    const ops = db.prepare(`SELECT id, params_json, created_at, model FROM film_music_operations WHERE session_id = ? AND kind = 'edit' ORDER BY created_at DESC, id DESC`).all(sessionId)
        .map(r => { let p = {}; try { p = JSON.parse(r.params_json || '{}'); } catch (_) { p = {}; } return { ...r, params: p }; })
        .filter(r => r.params.kind === 'emotion_proposal');
    const list = ops.map(op => {
        const ranges = all.filter(r => r.proposal_id === op.params.proposal_id);
        const counts = { proposed: 0, accepted: 0, rejected: 0 };
        for (const r of ranges) counts[r.status] = (counts[r.status] || 0) + 1;
        return { proposal_id: op.params.proposal_id, operation_id: op.id, created_at: op.created_at, model: op.params.model || null, supersedes: op.params.supersedes || null,
            coverage: op.params.coverage || null, ranges, counts, current: false };
    });
    if (list[0]) list[0].current = true;
    return list;
}

/** What a generator may rest on: the accepted arc, or a refusal naming what is still only proposed. */
function emotionForGeneration(db, sessionId) {
    const all = rangeRows(db, sessionId);
    const accepted = all.filter(r => r.status === 'accepted');
    const pending = all.filter(r => r.status === 'proposed');
    if (!accepted.length) {
        return { ok: false, code: 'EMOTION_NOT_ACCEPTED', status: 409, accepted, pending,
            error: pending.length
                ? `${pending.length} emotion range(s) are proposed and none accepted; a person must accept them (music_emotion_accept) before anything is generated from the arc`
                : 'no emotional arc has been accepted for this session; propose one (music_emotion_brief → music_emotion_propose) and accept it before generating from it' };
    }
    return { ok: true, accepted, pending };
}

module.exports = { COVERAGE_MIN, SEAM_MS, SCHEMA, INSTRUCTIONS, emotionBrief, coverageOf, propose, accept, listProposals, emotionForGeneration };
