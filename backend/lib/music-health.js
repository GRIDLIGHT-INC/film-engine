/**
 * WHAT THE WORKSTATION IS DOING, AND WHAT IS STUCK, WITHOUT A SECRET OR A PATH.
 *
 * MUS-023. One free report over every score operation, grouped into the areas
 * a person recovers differently — a render is re-bounced, a job is retried, a
 * DAW push is re-planned — plus the two dependencies those areas stand on: the
 * encoder and each DAW adapter.
 *
 * AREAS ARE CLAIMS OVER THE SCHEMA'S OWN VOCABULARY. An operation is claimed
 * by `kind:params.kind` first and `kind:*` second, so a package (a push whose
 * params say `package`) and a DAW push (params say `daw`) land in different
 * areas although the column holds the same word. An operation no area claims
 * is reported as `unclassified`, never dropped: a row that vanishes from a
 * health report is the one nobody goes looking for.
 *
 * STALLED IS A FACT, NOT A GUESS. A generation or separation is a job this
 * process registers while it runs (lib/music-jobs.js), so a running job that
 * is not live is stalled however recent it is. Everything else runs inside
 * the request that started it, under a ceiling far below STALL_AFTER_MS, so a
 * row still `running` past that has lost its process.
 *
 * NOTHING LEAVES WITH A SECRET OR A PATH IN IT. A health report is what gets
 * pasted into a ticket. Error text is kept — it is the only thing that says
 * what went wrong — with every absolute path cut to its file name and every
 * credential the environment holds removed. The encoder reports where it came
 * from, never its path; a DAW adapter reports whether it is configured and
 * why not, never its token.
 */

const path = require('path');
const { VOCABULARY } = require('./music-session');
const musicJobs = require('./music-jobs');
const { resolveFfmpeg } = require('./ffmpeg');
const dawRegistry = require('./daw-registry');
const dawDriver = require('./daw-adapter');

const STALL_AFTER_MS = 30 * 60 * 1000;
const RECENT = 10;
const STATUSES = VOCABULARY['film_music_operations.status'];

const HEALTH_AREAS = Object.freeze({
    render: {
        what: 'Bounces: the deterministic render of a session into a 48 kHz master and delivery stems.',
        claims: ['bounce:*'], job: false,
        recovery: 'Read GET /film/music-sessions/:id/bounce/plan, fix what it names, and bounce again (POST …/bounce with force: true when nothing changed). A failed render registered nothing.',
    },
    generation: {
        what: 'Generation jobs: compose, parts, reference, picture and inpaint, each a parent with ordered children.',
        claims: ['generate:*'], job: true,
        recovery: 'POST /film/music-sessions/:id/jobs/:opId/poll to settle an interrupted job, then …/jobs/:opId/retry (spends) to run it again as the next attempt.',
    },
    separation: {
        what: 'Separations: a recording split into two or six stems by the provider.',
        claims: ['separate:*'], job: true,
        recovery: 'POST /film/music-sessions/:id/separations/:opId/retry (spends). A failed separation registered no stems and left the source untouched.',
    },
    package: {
        what: 'Portable score packages: built from a session (push:package) and imported back (import:package_import).',
        claims: ['push:package', 'import:package_import'], job: false,
        recovery: 'Rebuild with POST /film/music-sessions/:id/package; validate an arriving package with validate_only before importing it. A refused import wrote nothing.',
    },
    daw: {
        what: 'DAW pushes and pulls through an adapter, acknowledged, idempotent and audited.',
        claims: ['push:daw', 'pull:daw'], job: false,
        recovery: 'Check the adapter below, read GET /film/music-sessions/:id/daw/:adapter/audit, re-plan (…/push/plan) and push with the same idempotency key — a retry after a timeout cannot apply twice. See docs/ableton-sidecar.md.',
    },
    import: {
        what: 'Aligned stem imports: originals stored byte-identical, one operation and one transaction per batch.',
        claims: ['import:*'], job: false,
        recovery: 'Import the batch again; a refused batch wrote no rows and left no files, and names the file that refused it.',
    },
    record: {
        what: 'Records with no work behind them: edits, rebases, approvals and emotion proposals and acceptances.',
        claims: ['edit:*', 'rebase:*', 'approve:*'], job: false,
        recovery: 'Nothing runs here; a record cannot stall. Read the session to see what it holds.',
    },
});

const CLAIMS = new Map();
for (const [id, a] of Object.entries(HEALTH_AREAS)) for (const c of a.claims) {
    if (CLAIMS.has(c)) throw new Error(`music health: ${c} is claimed by both ${CLAIMS.get(c)} and ${id}`);
    CLAIMS.set(c, id);
}

/** Which area an operation belongs to: `kind:params.kind`, then `kind:*`, else `unclassified`. */
function areaOf(op) {
    const params = op.params || (op.params_json ? safeParse(op.params_json) : {}) || {};
    return CLAIMS.get(`${op.kind}:${params.kind || ''}`) || CLAIMS.get(`${op.kind}:*`) || 'unclassified';
}

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

/** Values in the environment that are credentials: anything named like one, long enough to be one. */
function secretsOf(env) {
    return Object.entries(env || {})
        .filter(([k, v]) => /TOKEN|SECRET|PASSWORD|API_KEY|_KEY$|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length >= 8)
        .map(([, v]) => v).sort((a, b) => b.length - a.length);
}

/**
 * Text with every credential the environment holds removed and every absolute
 * path cut to its file name. A path is only one that starts a token — so a
 * URL's own path and a relative doc reference survive — and has at least two
 * segments.
 */
function redact(text, env) {
    let s = String(text == null ? '' : text);
    for (const v of secretsOf(env || process.env)) s = s.split(v).join('[redacted]');
    s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
    s = s.replace(/(^|[\s'"`(=[,;])((?:\/[^\s'"`:,;()<>[\]/\\]+){2,}\/?)/g, (m, lead, p) => `${lead}…/${path.posix.basename(p)}`);
    s = s.replace(/(^|[\s'"`(=[,;])[A-Za-z]:\\(?:[^\s'"`\\]+\\)*([^\s'"`\\]*)/g, (m, lead, base) => `${lead}…\\${base}`);
    return s;
}

/** Every string inside a value, redacted. */
function redactDeep(v, env) {
    if (typeof v === 'string') return redact(v, env);
    if (Array.isArray(v)) return v.map(x => redactDeep(x, env));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, env)]));
    return v;
}

const ageMs = row => {
    const t = Date.parse(String(row.started_at || row.created_at || '').replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? Date.now() - t : null;
};

function describe(row, area, env) {
    const p = safeParse(row.params_json);
    return {
        id: row.id, session_id: row.session_id, project_id: row.project_id, kind: row.kind,
        sub_kind: p.kind || null, status: row.status, provider: row.provider || null,
        adapter: p.adapter_id || null, attempt: row.attempt || 1,
        started_at: row.started_at || row.created_at, completed_at: row.completed_at || null,
        age_ms: ageMs(row), error: row.error_message ? redact(row.error_message, env) : null,
        recovery: HEALTH_AREAS[area] ? HEALTH_AREAS[area].recovery : 'No area claims this operation; read it with GET /film/music-sessions/:id.',
    };
}

function isStalled(row, area) {
    if (row.status !== 'running') return false;
    if (HEALTH_AREAS[area] && HEALTH_AREAS[area].job && !row.group_id) return !musicJobs.isLive(row.id);
    const age = ageMs(row);
    return age != null && age > STALL_AFTER_MS;
}

function encoderHealth(env) {
    const f = resolveFfmpeg();
    return { available: !!f.available, source: f.source || null, reason: f.available ? null : redact(f.reason || 'no encoder was found', env),
        needed_by: ['render', 'package', 'import (the 48 kHz working copy and the measurements)', 'the conformed master'] };
}

async function dawHealth(env, probe) {
    const out = {};
    for (const [id, spec] of Object.entries(dawRegistry.ADAPTERS)) {
        const c = spec.configure(env);
        const entry = { label: spec.label, guide: spec.guide, configured: !!c.ok, reason: c.ok ? null : redact(c.error, env), status: null };
        if (c.ok && probe) {
            const got = dawRegistry.adapterFor(id, env);
            if (got.ok) {
                entry.status = redactDeep(await dawDriver.status(got.adapter, { timeouts: { status: 2000 } }), env);
            }
        }
        out[id] = entry;
    }
    return out;
}

/**
 * The report. Scoped to a project or a session when asked; spends nothing and
 * writes nothing. `probe: true` also asks each configured DAW whether it is
 * reachable — a network call with the adapter's own short ceiling.
 */
async function musicHealth(db, opts) {
    const o = opts || {};
    const env = o.env || process.env;
    const where = []; const args = [];
    if (o.session_id) { where.push('o.session_id = ?'); args.push(o.session_id); }
    if (o.project_id) { where.push('s.project_id = ?'); args.push(o.project_id); }
    const rows = db.prepare(`SELECT o.*, s.project_id FROM film_music_operations o JOIN film_music_sessions s ON s.id = o.session_id
                             ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC, o.rowid DESC`).all(...args);
    const areas = {};
    const blank = id => ({ what: HEALTH_AREAS[id] ? HEALTH_AREAS[id].what : 'Operations no health area claims.',
        recovery: HEALTH_AREAS[id] ? HEALTH_AREAS[id].recovery : null,
        counts: Object.fromEntries(STATUSES.map(s => [s, 0])), running: [], stalled: [], recent_failures: [] });
    for (const id of Object.keys(HEALTH_AREAS)) areas[id] = blank(id);
    for (const r of rows) {
        const area = areaOf(r);
        if (!areas[area]) areas[area] = blank(area);
        const a = areas[area];
        a.counts[r.status] = (a.counts[r.status] || 0) + 1;
        if (r.status === 'running') (isStalled(r, area) ? a.stalled : a.running).push(describe(r, area, env));
        if (r.status === 'failed' && a.recent_failures.length < RECENT) a.recent_failures.push(describe(r, area, env));
    }
    const encoder = encoderHealth(env);
    const daw = await dawHealth(env, !!o.probe);
    const attention = Object.values(areas).reduce((n, a) => n + a.stalled.length + a.recent_failures.length, 0)
        + (encoder.available ? 0 : 1);
    return {
        ok: attention === 0, attention, scope: { project_id: o.project_id || null, session_id: o.session_id || null },
        generated_at: new Date().toISOString(), stall_after_ms: STALL_AFTER_MS, operations: rows.length,
        encoder, daw, areas,
    };
}

module.exports = { HEALTH_AREAS, STALL_AFTER_MS, areaOf, redact, musicHealth };
