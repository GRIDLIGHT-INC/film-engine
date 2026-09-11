/**
 * THE DAW ADAPTER CONTRACT, AND THE DRIVER THAT HOLDS EVERY ADAPTER TO IT.
 *
 * MUS-016. A DAW is an editor Film Engine talks to, never the place the
 * score lives ("Film Engine is authoritative"). Every integration — the
 * AbletonOSC sidecar next (MUS-017), a Pro Tools PTSL adapter or the beta
 * Ableton SDK later — implements the same six methods, and the engine-side
 * driver below turns them into the seven operations of `DAW_OPERATIONS`,
 * enforcing the same rules whatever the transport:
 *
 * ACKNOWLEDGED. A mutation is confirmed only by an acknowledgement that
 * echoes the request id; anything else — no answer, a wrong id, `accepted:
 * false` — is a failure, and nothing is recorded as done.
 *
 * IDEMPOTENT. A push is keyed by the adapter and the plan it carries out; a
 * pull by the adapter and the hash of what it brings back. The same key asked
 * again returns the recorded result without reaching the DAW, and the key is
 * sent to the adapter too, so a retry after a timeout cannot apply twice.
 *
 * STABLE EXTERNAL IDS. `film_music_daw_links` maps each Film Engine key to one
 * DAW item per adapter (migration 108). The second push updates what the
 * first created; the links are written only from an acknowledged write.
 *
 * CONFLICTS ARE REPORTED, NOT RESOLVED. A Film Engine track whose DAW
 * revision moved since the last acknowledged write was edited in the DAW. The
 * plan names it, and the push refuses (CONFLICTS) until each is decided —
 * `overwrite` or `keep_daw`. A plan is fingerprinted; a push against a plan
 * the session or the DAW has moved past is refused (STALE_PLAN).
 *
 * BOUNDED. Only Film Engine-owned tracks may change. A plan never names
 * another, a Film Engine track the DAW no longer attributes to Film Engine is
 * a conflict, and an acknowledgement claiming a change to a track Film Engine
 * does not own fails the push as a boundary violation.
 *
 * TIMED AND AUDITED. Every operation has a ceiling. A mutation that times out
 * is recorded as failed with an unknown outcome and the key to retry it by.
 * Every mutation — push, pull, transport — is an operation row (kind push or
 * pull, `params.kind: 'daw'`) naming the adapter, the operation, the request
 * id, the idempotency key, the outcome and how long it took. Reads are free
 * and leave no record: a status poll is not an event.
 *
 * SUPERVISED TRANSPORT. Play, stop and locate, and only those, and only when
 * the caller says a person asked for it.
 */

const crypto = require('crypto');
const fs = require('fs');

const { generateId } = require('../db/database');
const { VALIDATORS, toRow } = require('./music-session');
const musicPackage = require('./music-package');

/** The six methods an adapter implements. */
const ADAPTER_METHODS = Object.freeze(['status', 'sessionRead', 'push', 'pullAvailable', 'pull', 'transport']);

/** The seven operations of the contract, as the driver exposes them. */
const DAW_OPERATIONS = Object.freeze({
    status: { what: 'Is the DAW reachable, which version is it, and is that a version this adapter supports.', adapter_method: 'status', mutates: false, timeout_ms: 3000 },
    session_read: { what: 'The DAW session as it is: every track with its owner, group and revision — read, never changed.', adapter_method: 'sessionRead', mutates: false, timeout_ms: 10000 },
    push_plan: { what: 'Free: what a push would create and update, what it leaves alone, and every conflict, fingerprinted.', adapter_method: 'sessionRead', mutates: false, timeout_ms: 20000 },
    push: { what: 'Carry out a push plan: the score package into Film Engine’s own group, acknowledged per track.', adapter_method: 'push', mutates: true, ack: true, audited: true, idempotent: true, timeout_ms: 120000 },
    pull_plan: { what: 'Free: what the DAW has rendered that could come back, with hashes, and what already has.', adapter_method: 'pullAvailable', mutates: false, timeout_ms: 10000 },
    pull: { what: 'Bring a DAW render back as an immutable package, validated by hash and alignment, as candidate takes.', adapter_method: 'pull', mutates: true, ack: true, audited: true, idempotent: true, timeout_ms: 180000 },
    transport: { what: 'Play, stop or locate the DAW’s transport — only when a person asked for it.', adapter_method: 'transport', mutates: true, ack: true, audited: true, supervised: true, timeout_ms: 3000 },
});

const TRANSPORT_COMMANDS = Object.freeze(['play', 'stop', 'locate']);
const RESOLUTIONS = Object.freeze(['overwrite', 'keep_daw']);
const OWNER = 'film-engine';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

/** Hold an adapter to the contract: an id, a version, and every method. */
function validateAdapter(adapter) {
    const errors = [];
    if (!adapter || typeof adapter !== 'object') return { ok: false, errors: ['no adapter'] };
    if (!adapter.id || typeof adapter.id !== 'string') errors.push('the adapter has no id');
    if (!adapter.version) errors.push(`${adapter.id || 'the adapter'} declares no version`);
    for (const m of ADAPTER_METHODS) if (typeof adapter[m] !== 'function') errors.push(`${adapter.id || 'the adapter'} does not implement ${m}()`);
    return { ok: errors.length === 0, errors };
}

/** Race a call against its ceiling. */
async function timed(op, fn, opts) {
    const ms = (opts && opts.timeouts && opts.timeouts[op]) || DAW_OPERATIONS[op].timeout_ms;
    let timer;
    const ceiling = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(`${op} timed out after ${ms} ms`); e.code = 'DAW_TIMEOUT'; reject(e); }, ms); });
    try { return await Promise.race([Promise.resolve().then(fn), ceiling]); }
    finally { clearTimeout(timer); }
}

function guard(adapter) {
    const v = validateAdapter(adapter);
    return v.ok ? null : { ok: false, status: 400, code: 'BAD_ADAPTER', error: `the adapter does not satisfy the DAW contract: ${v.errors.join('; ')}` };
}

// ── Audit ──────────────────────────────────────────────────────────────────

function recordStart(db, sessionId, kind, fields) {
    const v = VALIDATORS.film_music_operations({ kind, status: 'running', provider: fields.adapter_id, params: { kind: 'daw', ...fields } });
    const r = toRow('film_music_operations', v.value);
    const id = generateId();
    db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, provider, params_json, started_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(id, sessionId, r.kind, r.status, r.provider, r.params_json);
    return id;
}
function recordEnd(db, opId, status, patch) {
    const row = db.prepare('SELECT params_json FROM film_music_operations WHERE id = ?').get(opId);
    let p = {}; try { p = JSON.parse(row.params_json || '{}'); } catch (_) { p = {}; }
    Object.assign(p, patch.params || {});
    db.prepare(`UPDATE film_music_operations SET status = ?, error_message = ?, params_json = ?, completed_at = datetime('now') WHERE id = ?`)
        .run(status, patch.error || '', JSON.stringify(p), opId);
}
function priorByKey(db, sessionId, op, key) {
    return db.prepare(`SELECT * FROM film_music_operations WHERE session_id = ? AND kind IN ('push', 'pull') AND status = 'complete'
                       AND json_extract(params_json, '$.kind') = 'daw' AND json_extract(params_json, '$.op') = ? AND json_extract(params_json, '$.idempotency_key') = ?
                       ORDER BY created_at DESC LIMIT 1`).get(sessionId, op, key) || null;
}

/** Every DAW mutation on a session, newest first. */
function listAudit(db, sessionId) {
    return db.prepare(`SELECT * FROM film_music_operations WHERE session_id = ? AND kind IN ('push', 'pull') AND json_extract(params_json, '$.kind') = 'daw' ORDER BY created_at DESC, rowid DESC`)
        .all(sessionId).map(r => {
            let p = {}; try { p = JSON.parse(r.params_json || '{}'); } catch (_) { p = {}; }
            return { operation_id: r.id, op: p.op, adapter_id: p.adapter_id, request_id: p.request_id, idempotency_key: p.idempotency_key, status: r.status,
                error: r.error_message || '', duration_ms: p.duration_ms, applied: p.applied || null, started_at: r.started_at, completed_at: r.completed_at };
        });
}

function ackError(op, ack, requestId) {
    if (!ack || typeof ack !== 'object') return `${op} came back with no acknowledgement; nothing is recorded as done`;
    if (ack.request_id !== requestId) return `${op} was acknowledged for request ${ack.request_id || '(none)'}, not ${requestId}; an acknowledgement for another request confirms nothing`;
    if (ack.accepted === false) return `${op} was refused by the DAW: ${ack.error || 'no reason given'}`;
    return null;
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function status(adapter, opts) {
    const bad = guard(adapter); if (bad) return bad;
    try { const s = await timed('status', () => adapter.status(), opts); return { ok: true, adapter_id: adapter.id, ...s }; }
    catch (e) { return { ok: false, adapter_id: adapter.id, connected: false, code: e.code || 'DAW_ERROR', error: e.message }; }
}

async function readSession(adapter, opts) {
    const bad = guard(adapter); if (bad) return bad;
    try { const s = await timed('session_read', () => adapter.sessionRead(), opts); return { ok: true, adapter_id: adapter.id, ...s }; }
    catch (e) { return { ok: false, adapter_id: adapter.id, code: e.code || 'DAW_ERROR', error: e.message }; }
}

// ── Push ───────────────────────────────────────────────────────────────────

function linksOf(db, sessionId, adapterId) {
    return db.prepare('SELECT * FROM film_music_daw_links WHERE session_id = ? AND adapter_id = ?').all(sessionId, adapterId);
}

/**
 * What a push would do, free: build (or reuse) the package, read the DAW,
 * and diff them. Never names a track Film Engine does not own.
 */
async function planPush(db, sessionId, adapter, opts) {
    const bad = guard(adapter); if (bad) return bad;
    const built = await musicPackage.buildPackage(db, sessionId, { include_picture: false });
    if (!built.ok) return built;
    const read = await readSession(adapter, { timeouts: { session_read: ((opts && opts.timeouts) || {}).push_plan } });
    if (!read.ok) return { ok: false, status: 502, code: read.code, error: `the DAW session could not be read: ${read.error}` };
    const m = built.manifest;
    const links = linksOf(db, sessionId, adapter.id).filter(l => l.kind === 'track');
    const byExt = new Map((read.tracks || []).map(t => [t.external_id, t]));
    const instructions = [], conflicts = [], notes = [];
    for (const st of m.stems) {
        const link = links.find(l => l.fe_key === st.key);
        const ext = link ? byExt.get(link.external_id) : null;
        const base = { fe_key: st.key, name: st.name, stem_path: st.path, stem_sha256: st.sha256 };
        if (!link) { instructions.push({ ...base, action: 'create' }); continue; }
        if (!ext) { instructions.push({ ...base, action: 'create' }); notes.push(`${st.name}: its DAW track ${link.external_id} is gone; it will be created again`); continue; }
        if (ext.owner !== OWNER) { conflicts.push({ fe_key: st.key, external_id: ext.external_id, name: st.name, reason: `the DAW no longer attributes ${ext.external_id} to Film Engine (owner ${ext.owner || 'unknown'}); Film Engine will not change it` }); continue; }
        if (link.revision && ext.revision !== link.revision) {
            conflicts.push({ fe_key: st.key, external_id: ext.external_id, name: st.name, reason: `changed in the DAW since Film Engine last wrote it (revision ${link.revision} → ${ext.revision})`, choices: RESOLUTIONS });
            continue;
        }
        instructions.push({ ...base, action: 'update', external_id: ext.external_id });
    }
    const feKeys = new Set(m.stems.map(s => s.key));
    const orphans = (read.tracks || []).filter(t => t.owner === OWNER && !links.some(l => l.external_id === t.external_id && feKeys.has(l.fe_key)))
        .map(t => ({ external_id: t.external_id, name: t.name, reason: 'a Film Engine track in the DAW with no track in the session any more; left in place, never deleted' }));
    const untouched = (read.tracks || []).filter(t => t.owner !== OWNER).map(t => ({ external_id: t.external_id, name: t.name, owner: t.owner || 'unknown' }));
    const planFingerprint = sha(JSON.stringify({ adapter: adapter.id, package: m.package.id, daw: (read.tracks || []).map(t => [t.external_id, t.owner, t.revision]).sort(),
        links: links.map(l => [l.fe_key, l.external_id, l.revision]).sort() }));
    return { ok: true, free: true, adapter_id: adapter.id, package_id: m.package.id, package_asset_id: built.asset_id, plan_fingerprint: planFingerprint,
        instructions, conflicts, orphans, untouched, notes, group: read.group || null,
        effect: `creates ${instructions.filter(i => i.action === 'create').length} and updates ${instructions.filter(i => i.action === 'update').length} Film Engine track(s) in the DAW; leaves ${untouched.length} track(s) that are not Film Engine's alone` };
}

/** Carry out a push plan. Refuses a stale plan and undecided conflicts; writes links only from an acknowledged write. */
async function push(db, sessionId, adapter, opts) {
    const o = opts || {};
    const bad = guard(adapter); if (bad) return bad;
    if (!o.plan_fingerprint) return { ok: false, status: 400, error: 'plan_fingerprint is required: read the push plan first, then push the plan you read' };
    const key = o.idempotency_key || sha(`${adapter.id}:push:${o.plan_fingerprint}`);
    const prior = priorByKey(db, sessionId, 'push', key);
    if (prior) { const p = JSON.parse(prior.params_json); return { ok: true, replayed: true, operation_id: prior.id, applied: p.applied || [], idempotency_key: key }; }

    const plan = await planPush(db, sessionId, adapter, o);
    if (!plan.ok) return plan;
    if (plan.plan_fingerprint !== o.plan_fingerprint) return { ok: false, status: 409, code: 'STALE_PLAN', error: 'the session or the DAW changed since this plan was read; read the push plan again', plan };
    const resolutions = o.resolutions || {};
    const undecided = plan.conflicts.filter(c => !RESOLUTIONS.includes(resolutions[c.fe_key]) || (resolutions[c.fe_key] === 'overwrite' && !c.choices));
    if (undecided.length) {
        return { ok: false, status: 409, code: 'CONFLICTS', conflicts: plan.conflicts,
            error: `decide each conflict before pushing (overwrite or keep_daw): ${undecided.map(c => `${c.fe_key} — ${c.reason}`).join('; ')}` };
    }
    const instructions = [...plan.instructions,
        ...plan.conflicts.filter(c => resolutions[c.fe_key] === 'overwrite').map(c => ({ fe_key: c.fe_key, name: c.name, action: 'update', external_id: c.external_id,
            stem_path: (plan.instructions.find(i => i.fe_key === c.fe_key) || {}).stem_path }))];
    const read = await readSession(adapter, o);
    const foreign = new Set((read.tracks || []).filter(t => t.owner !== OWNER).map(t => t.external_id));

    const requestId = generateId();
    const started = now();
    const opId = recordStart(db, sessionId, 'push', { op: 'push', adapter_id: adapter.id, request_id: requestId, idempotency_key: key, package_id: plan.package_id,
        plan_fingerprint: plan.plan_fingerprint, instructions: instructions.map(i => ({ fe_key: i.fe_key, action: i.action, external_id: i.external_id || null })), resolutions });
    const fail = (error) => { recordEnd(db, opId, 'failed', { error, params: { duration_ms: now() - started } }); return { ok: false, status: 502, operation_id: opId, error, idempotency_key: key }; };

    const pkgFile = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(plan.package_asset_id);
    const bytes = fs.readFileSync(require('./data-paths').resolveStored(pkgFile.file_path));
    let ack;
    try { ack = await timed('push', () => adapter.push({ request_id: requestId, idempotency_key: key, package: bytes, instructions }), o); }
    catch (e) {
        if (e.code === 'DAW_TIMEOUT') return fail(`${e.message}: the outcome is unknown — the DAW may have applied part of it. Read the session, then retry with the same idempotency key (${key}); it cannot apply twice.`);
        return fail(`push failed: ${e.message}`);
    }
    const ae = ackError('push', ack, requestId);
    if (ae) return fail(ae);
    const applied = Array.isArray(ack.applied) ? ack.applied : [];
    const trespass = applied.filter(a => foreign.has(a.external_id) || !instructions.some(i => i.fe_key === a.fe_key));
    if (trespass.length) return fail(`boundary violation: the DAW reported changing ${trespass.map(a => a.external_id).join(', ')}, which Film Engine does not own or did not ask to change; nothing is recorded`);
    const missing = instructions.filter(i => !applied.some(a => a.fe_key === i.fe_key));
    if (missing.length) return fail(`the acknowledgement does not confirm ${missing.map(i => i.fe_key).join(', ')}; a push is recorded only when every instruction is confirmed`);

    const upsert = db.prepare(`INSERT INTO film_music_daw_links (id, session_id, adapter_id, fe_key, kind, external_id, revision) VALUES (?, ?, ?, ?, 'track', ?, ?)
                               ON CONFLICT(session_id, adapter_id, fe_key) DO UPDATE SET external_id = excluded.external_id, revision = excluded.revision, updated_at = datetime('now')`);
    db.transaction(() => {
        for (const a of applied) {
            db.prepare('DELETE FROM film_music_daw_links WHERE session_id = ? AND adapter_id = ? AND external_id = ? AND fe_key != ?').run(sessionId, adapter.id, a.external_id, a.fe_key);
            upsert.run(generateId(), sessionId, adapter.id, a.fe_key, a.external_id, String(a.revision || ''));
        }
        recordEnd(db, opId, 'complete', { params: { duration_ms: now() - started, applied } });
    })();
    return { ok: true, replayed: false, operation_id: opId, request_id: requestId, idempotency_key: key, applied, package_id: plan.package_id };
}

// ── Pull ───────────────────────────────────────────────────────────────────

async function planPull(db, sessionId, adapter, opts) {
    const bad = guard(adapter); if (bad) return bad;
    let items;
    try { items = await timed('pull_plan', () => adapter.pullAvailable(), opts); }
    catch (e) { return { ok: false, status: 502, code: e.code || 'DAW_ERROR', error: `the DAW could not say what it has rendered: ${e.message}` }; }
    const list = (Array.isArray(items) ? items : []).map(it => ({ ...it, already_pulled: !!priorByKey(db, sessionId, 'pull', sha(`${adapter.id}:pull:${it.sha256}`)) }));
    return { ok: true, free: true, adapter_id: adapter.id, items: list,
        effect: 'each item comes back as an immutable package: validated by hash and alignment, landing as candidate takes beside what the session holds' };
}

async function pull(db, sessionId, adapter, opts) {
    const o = opts || {};
    const bad = guard(adapter); if (bad) return bad;
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!session) return { ok: false, status: 404, error: 'Score session not found' };
    const plan = await planPull(db, sessionId, adapter, o);
    if (!plan.ok) return plan;
    const item = plan.items.find(i => i.item_id === o.item_id);
    if (!item) return { ok: false, status: 404, error: `the DAW has no render ${o.item_id}; read the pull plan` };
    const key = o.idempotency_key || sha(`${adapter.id}:pull:${item.sha256}`);
    const prior = priorByKey(db, sessionId, 'pull', key);
    if (prior) { const p = JSON.parse(prior.params_json); return { ok: true, replayed: true, operation_id: prior.id, imported: p.imported || null, idempotency_key: key }; }

    const requestId = generateId();
    const started = now();
    const opId = recordStart(db, sessionId, 'pull', { op: 'pull', adapter_id: adapter.id, request_id: requestId, idempotency_key: key, item_id: item.item_id, item_sha256: item.sha256 });
    const fail = (error) => { recordEnd(db, opId, 'failed', { error, params: { duration_ms: now() - started } }); return { ok: false, status: 502, operation_id: opId, error, idempotency_key: key }; };
    let ack;
    try { ack = await timed('pull', () => adapter.pull({ request_id: requestId, idempotency_key: key, item_id: item.item_id }), o); }
    catch (e) {
        if (e.code === 'DAW_TIMEOUT') return fail(`${e.message}: nothing was imported; the DAW may still be rendering — retry with the same idempotency key (${key})`);
        return fail(`pull failed: ${e.message}`);
    }
    const ae = ackError('pull', ack, requestId);
    if (ae) return fail(ae);
    const bytes = Buffer.isBuffer(ack.package) ? ack.package : Buffer.from(ack.package || []);
    if (sha(bytes) !== item.sha256) return fail(`the DAW returned bytes whose sha256 hash does not match the render it advertised (${item.sha256.slice(0, 12)}…); nothing was imported`);
    const imported = musicPackage.importPackage(db, session.project_id, bytes, { session_id: sessionId });
    if (!imported.ok) return fail(`the returned package was refused: ${imported.error}`);
    recordEnd(db, opId, 'complete', { params: { duration_ms: now() - started, imported: { operation_id: imported.operation_id, matched: imported.matched, created: imported.created, package_id: imported.package_id } } });
    return { ok: true, replayed: false, operation_id: opId, request_id: requestId, idempotency_key: key, imported };
}

// ── Transport ──────────────────────────────────────────────────────────────

async function transport(db, sessionId, adapter, opts) {
    const o = opts || {};
    const bad = guard(adapter); if (bad) return bad;
    if (o.supervised !== true) return { ok: false, status: 403, error: 'transport is supervised: a person must ask for it (supervised: true); an agent does not start or move a DAW on its own' };
    if (!TRANSPORT_COMMANDS.includes(o.command)) return { ok: false, status: 400, error: `transport takes ${TRANSPORT_COMMANDS.join(', ')} and nothing else; '${o.command}' is not allowed` };
    if (o.command === 'locate' && !(Number.isInteger(o.position_ms) && o.position_ms >= 0)) return { ok: false, status: 400, error: 'locate needs position_ms, a whole number of milliseconds from 0' };
    const requestId = generateId();
    const key = o.idempotency_key || requestId;
    const started = now();
    const opId = recordStart(db, sessionId, 'push', { op: 'transport', adapter_id: adapter.id, request_id: requestId, idempotency_key: key, command: o.command, position_ms: o.position_ms == null ? null : o.position_ms });
    const fail = (error) => { recordEnd(db, opId, 'failed', { error, params: { duration_ms: now() - started } }); return { ok: false, status: 502, operation_id: opId, error }; };
    let ack;
    try { ack = await timed('transport', () => adapter.transport({ request_id: requestId, command: o.command, position_ms: o.position_ms }), o); }
    catch (e) { return fail(e.code === 'DAW_TIMEOUT' ? `${e.message}; the DAW did not confirm the command` : `transport failed: ${e.message}`); }
    const ae = ackError('transport', ack, requestId);
    if (ae) return fail(ae);
    recordEnd(db, opId, 'complete', { params: { duration_ms: now() - started, playhead_ms: ack.playhead_ms == null ? null : ack.playhead_ms } });
    return { ok: true, operation_id: opId, request_id: requestId, playhead_ms: ack.playhead_ms, playing: ack.playing };
}

module.exports = {
    ADAPTER_METHODS, DAW_OPERATIONS, TRANSPORT_COMMANDS, RESOLUTIONS, OWNER,
    validateAdapter, status, readSession, planPush, push, planPull, pull, transport, listAudit,
};
