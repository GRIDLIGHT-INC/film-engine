/**
 * RIGHTS FOLLOW THE MUSIC: ORIGINS, DERIVATIVES, ONE LINEAGE, ONE POLICY.
 *
 * MUS-022. Four things, each stated once.
 *
 * ORIGINS. What a piece of source material IS: the director's own
 * (`original`), made by a provider (`generated`), bought or licensed
 * (`licensed`), out of copyright (`public_domain`), or not known (`unknown`).
 * An origin is a DECLARATION — a person says it at import or in the rights
 * register — or a FACT the engine witnessed (a provider made it). Nothing is
 * inferred: a generated file is `generated` with status `unknown`, never
 * cleared, because a provider's terms are not a clearance anyone here read.
 *
 * DERIVATIVES. A take generated over a source, a separated stem, a bounce,
 * and a stem returned from a DAW or a package are all MADE FROM something.
 * `recordDerivative` is called by every writer (`DERIVATIVE_WRITERS`): it
 * links the sources and records the most encumbered of their statuses. The
 * record is a snapshot; the lineage is computed LIVE from the sources, so a
 * source cleared or blocked later reaches every derivative at once without
 * re-rendering anything.
 *
 * LINEAGE. `assetLineage` walks one file to its sources; `scoreLineage`
 * walks every clip of a session and its mix, with origin, status, owner,
 * provider, model, operation and hash at every node, and names every issue.
 *
 * POLICY. What each rights status does at each gate — approval of a mix,
 * and final export (the conformed master and the NLE handover): `allow`,
 * `warn` or `block`. The default below is a STATED default, pending the
 * epic's Open Question 3, and the `music_rights_policy` setting replaces any
 * part of it. A block can be passed with `ignore_rights`, which is recorded,
 * on the rule every gate here follows: a refusal nobody can get past is a
 * reason never to turn the gate on.
 */

const { generateId } = require('../db/database');

const ORIGINS = Object.freeze(['original', 'generated', 'licensed', 'public_domain', 'unknown']);
/** Most encumbered first: a derivative carries the first of these any source has. */
const STATUS_ORDER = Object.freeze(['blocked', 'expired', 'restricted', 'unknown', 'cleared']);
const STATUSES = Object.freeze(['cleared', 'unknown', 'restricted', 'expired', 'blocked']);
const GATES = Object.freeze(['approval', 'final_export']);
const ACTIONS = Object.freeze(['allow', 'warn', 'block']);

const DERIVATIVE_WRITERS = Object.freeze([
    { kind: 'generated_from_source', file: 'lib/music-generation.js', what: 'A take generated over a clip, a reference or the picture carries its source’s rights on top of being generated.' },
    { kind: 'separated', file: 'lib/music-separation.js', what: 'A separated stem is the recording it came from.' },
    { kind: 'bounced', file: 'lib/music-renderer.js', what: 'A master or delivery stem is every clip it mixed.' },
    { kind: 'daw_returned', file: 'lib/music-package.js', what: 'A stem back from a DAW or a package carries the rights its manifest declared and the sources it names.' },
]);

const DEFAULT_POLICY = Object.freeze({
    approval: Object.freeze({ cleared: 'allow', unknown: 'warn', restricted: 'warn', expired: 'warn', blocked: 'block' }),
    final_export: Object.freeze({ cleared: 'allow', unknown: 'warn', restricted: 'warn', expired: 'block', blocked: 'block' }),
});
const POLICY_NOTE = 'The default policy: unknown and restricted material warns at approval and at final export; expired material warns at approval and blocks final export; material a person marked blocked blocks both. It is a stated default pending the epic’s Open Question 3, and the music_rights_policy setting replaces any part of it. ignore_rights passes a block and is recorded.';

const mostEncumbered = statuses => STATUS_ORDER.find(s => statuses.includes(s)) || 'unknown';
const parse = t => { try { return JSON.parse(t || '{}') || {}; } catch (_) { return {}; } };

/** Validate a policy (or part of one); returns the errors, naming the setting. */
function validatePolicy(value) {
    const errors = [];
    let v = value;
    if (typeof v === 'string') { if (!v.trim()) return []; try { v = JSON.parse(v); } catch (_) { return ['music_rights_policy must be JSON: { "approval": { "unknown": "warn" }, "final_export": { ... } }']; } }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return ['music_rights_policy must be an object keyed by gate'];
    for (const [gate, table] of Object.entries(v)) {
        if (!GATES.includes(gate)) { errors.push(`music_rights_policy: '${gate}' is not a gate (${GATES.join(', ')})`); continue; }
        for (const [status, act] of Object.entries(table || {})) {
            if (!STATUSES.includes(status)) errors.push(`music_rights_policy.${gate}: '${status}' is not a rights status (${STATUSES.join(', ')})`);
            else if (!ACTIONS.includes(act)) errors.push(`music_rights_policy.${gate}.${status}: '${act}' is not ${ACTIONS.join(', ')}`);
        }
    }
    return errors;
}

/** The policy in force: the stated default, with the setting laid over it. */
function rightsPolicy(db) {
    const out = { approval: { ...DEFAULT_POLICY.approval }, final_export: { ...DEFAULT_POLICY.final_export } };
    let raw = '';
    try { raw = (db.prepare("SELECT value FROM film_app_settings WHERE key = 'music_rights_policy'").get() || {}).value || ''; } catch (_) { raw = ''; }
    if (raw && !validatePolicy(raw).length) {
        const v = JSON.parse(raw);
        for (const gate of GATES) Object.assign(out[gate], v[gate] || {});
    }
    return { policy: out, customised: !!raw, note: POLICY_NOTE };
}

/** The rights a PERSON recorded for an asset — never the row a derivative wrote for itself. */
function personRow(db, assetId) {
    return db.prepare("SELECT * FROM film_rights WHERE entity_id = ? AND COALESCE(origin, 'unknown') != 'derived' ORDER BY updated_at DESC, created_at DESC LIMIT 1").get(assetId) || null;
}

function sourcesOf(db, asset, meta) {
    const ids = [];
    const add = v => { for (const x of [].concat(v || [])) if (typeof x === 'string' && x && x !== asset.id && !ids.includes(x)) ids.push(x); };
    add(meta.rights_sources); add(meta.sources); add(meta.derived_from);
    return ids.filter(id => db.prepare('SELECT 1 FROM film_assets WHERE id = ?').get(id));
}

/** One file, walked to its sources. */
function assetLineage(db, assetId, seen) {
    const trail = seen || new Set();
    const a = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    if (!a) return { asset_id: assetId, missing: true, origin: 'unknown', status: 'unknown', derived_from: [] };
    if (trail.has(assetId)) return { asset_id: assetId, name: a.file_name, cycle: true, origin: 'unknown', status: 'unknown', derived_from: [] };
    trail.add(assetId);
    const meta = parse(a.metadata);
    const row = personRow(db, assetId);
    const generated = a.license_source === 'generated';
    const derived_from = sourcesOf(db, a, meta).map(id => assetLineage(db, id, new Set(trail)));
    let origin, status;
    if (derived_from.length) {
        origin = 'derived';
        const own = row && STATUSES.includes(row.status) ? [row.status] : (generated ? ['unknown'] : []);
        status = mostEncumbered([...derived_from.map(d => d.status), ...own]);
    } else {
        origin = row && ORIGINS.includes(row.origin) && row.origin !== 'unknown' ? row.origin : (generated ? 'generated' : 'unknown');
        status = row && STATUSES.includes(row.status) ? row.status : (STATUSES.includes(a.license_status) ? a.license_status : 'unknown');
    }
    return {
        asset_id: a.id, name: a.file_name, kind: meta.kind || a.asset_type, origin, generated, status,
        owner: (row && row.owner) || '', license_url: (row && row.license_url) || '', restrictions: (row && row.restrictions) || '', expires_on: (row && row.expires_on) || '',
        provider: a.provider || meta.provider || '', model: meta.model || '', operation_id: meta.operation_id || null,
        hash: meta.hash || null, recorded_status: a.license_status || '', derived_from,
    };
}

/** Every node of a lineage, flattened, once each. */
function flatten(node, out) {
    const list = out || new Map();
    if (!node || list.has(node.asset_id)) return list;
    list.set(node.asset_id, node);
    for (const d of node.derived_from || []) flatten(d, list);
    return list;
}

/** The problems in a lineage: every leaf, or person-marked file, that is not cleared. */
function issuesOf(nodes) {
    const out = [];
    for (const n of nodes.values()) {
        const leaf = !(n.derived_from || []).length;
        if (n.status === 'cleared' || (!leaf && n.status === mostEncumbered((n.derived_from || []).map(d => d.status)))) continue;
        out.push({ asset_id: n.asset_id, name: n.name, origin: n.origin, status: n.status,
            reason: n.status === 'unknown' ? `${n.origin === 'generated' ? 'generated by a provider' : 'rights'} unknown: nobody has recorded a clearance` : `rights ${n.status}${n.restrictions ? ` (${n.restrictions})` : ''}${n.expires_on ? ` — expires ${n.expires_on}` : ''}` });
    }
    return out;
}

/** A whole session: every clip, the mix, a summary and the issues. */
function scoreLineage(db, sessionId) {
    const s = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!s) return { ok: false, status: 404, error: 'Score session not found' };
    const clips = db.prepare(`SELECT c.id, c.name, c.asset_id, c.take_status, t.name AS track FROM film_music_clips c
                              JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ? ORDER BY t.sort_order, c.start_ms`).all(sessionId)
        .map(c => ({ clip_id: c.id, name: c.name, track: c.track, take_status: c.take_status, asset: assetLineage(db, c.asset_id) }));
    let mixId = s.status === 'approved' ? s.approved_mix_asset_id : null;
    if (!mixId) {
        try { const b = require('./music-renderer').listBounces(db, sessionId).find(x => x.current); mixId = b && b.master ? b.master.asset_id : null; } catch (_) { mixId = null; }
    }
    const mix = mixId ? assetLineage(db, mixId) : null;
    const nodes = new Map();
    for (const c of clips) flatten(c.asset, nodes);
    if (mix) flatten(mix, nodes);
    const leaves = [...nodes.values()].filter(n => !(n.derived_from || []).length);
    const count = (list, key) => list.reduce((o, n) => { o[n[key]] = (o[n[key]] || 0) + 1; return o; }, {});
    return {
        ok: true, session_id: sessionId, clips, mix, mix_is: s.status === 'approved' && s.approved_mix_asset_id ? 'approved' : (mix ? 'current bounce' : null),
        summary: { origins: count(leaves, 'origin'), statuses: count(leaves, 'status'), files: nodes.size },
        effective_status: mix ? mix.status : mostEncumbered(clips.map(c => c.asset.status)),
        issues: issuesOf(nodes), policy: rightsPolicy(db),
    };
}

/** What a gate does with some files: each item that is not cleared, and whether anything blocks. */
function evaluate(db, assetIds, gate) {
    const { policy, note, customised } = rightsPolicy(db);
    const nodes = new Map();
    for (const id of assetIds || []) flatten(assetLineage(db, id), nodes);
    const items = issuesOf(nodes).map(i => ({ ...i, action: policy[gate][i.status] || 'warn' }));
    const blocked = items.filter(i => i.action === 'block');
    const warned = items.filter(i => i.action === 'warn');
    return { gate, ok: blocked.length === 0, blocked, warned, items, policy: policy[gate], customised, note };
}

/** Final export: the approved score mixes the film consumes, through the policy. */
function evaluateProject(db, projectId, gate) {
    const ids = require('./music-approval').approvedScores(db, projectId).scores.map(s => s.asset_id);
    return evaluate(db, ids, gate || 'final_export');
}

/**
 * Called by every derivative writer: link the sources and record the most
 * encumbered status among them (and the file's own claim, when it carries
 * one — a generated take, or a status its manifest declared).
 */
function recordDerivative(db, assetId, sourceIds, how, opts) {
    const o = opts || {};
    const a = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    if (!a) return null;
    const sources = [...new Set((sourceIds || []).filter(Boolean))].filter(id => id !== assetId && db.prepare('SELECT 1 FROM film_assets WHERE id = ?').get(id));
    const meta = parse(a.metadata);
    meta.rights_sources = sources;
    const statuses = sources.map(id => assetLineage(db, id).status);
    if (o.own_status && STATUSES.includes(o.own_status)) statuses.push(o.own_status);
    if (a.license_source === 'generated') statuses.push('unknown');
    const status = statuses.length ? mostEncumbered(statuses) : 'unknown';
    const names = sources.map(id => (db.prepare('SELECT file_name FROM film_assets WHERE id = ?').get(id) || {}).file_name || id);
    const notes = `derived: ${how}${names.length ? ` from ${names.join(', ')}` : ''}; carries the most encumbered status of what it was made from (${status})`;
    db.prepare('UPDATE film_assets SET metadata = ?, license_status = ? WHERE id = ?').run(JSON.stringify(meta), status, assetId);
    const existing = db.prepare("SELECT id FROM film_rights WHERE entity_id = ? AND origin = 'derived'").get(assetId);
    if (existing) db.prepare("UPDATE film_rights SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(status, notes, existing.id);
    else {
        db.prepare(`INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status, origin, notes)
                    VALUES (?, ?, 'music', ?, ?, 'music_license', ?, 'derived', ?)`).run(generateId(), a.project_id, assetId, a.file_name || assetId, status, notes);
    }
    return { asset_id: assetId, status, sources };
}

/** A generated file with no source: recorded as generated, status unknown — never cleared. */
function recordGenerated(db, assetId, provider) {
    const a = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    if (!a) return null;
    db.prepare(`INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status, origin, source, notes)
                VALUES (?, ?, 'music', ?, ?, 'music_license', 'unknown', 'generated', ?, ?)`)
        .run(generateId(), a.project_id, assetId, a.file_name || assetId, provider || '', `generated by ${provider || 'a provider'}; its terms are not a clearance — record one here once they are read`);
    return { asset_id: assetId, status: 'unknown', origin: 'generated' };
}

module.exports = {    ORIGINS, STATUSES, GATES, ACTIONS, DERIVATIVE_WRITERS, DEFAULT_POLICY, POLICY_NOTE,
    validatePolicy, assetLineage, scoreLineage, evaluate, evaluateProject, recordDerivative, recordGenerated,};
