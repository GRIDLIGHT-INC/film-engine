/**
 * FEM-001 (GRD-4565) — the self-hosted model catalog, as Film Engine reads it.
 *
 * AUTHORED ONCE, IN GRIDLIGHT. The catalog lives at
 * gl-dev-media/gateway/assets/model-catalog.json and is served by the gateway
 * at GET /media/catalog; the gateway's dispatch gate reads the same file before
 * a job is queued. Film Engine vendors it as model-catalog.snapshot.json beside
 * this module and never re-declares a licence or a region: a second copy typed
 * here would come to disagree with the one the gateway dispatches on.
 *
 * `admits` is the same rule on this side, and it fails CLOSED: an unknown
 * model, a catalog that does not validate, an expired or absent licence, a
 * region the licence does not allow, a production run on a model not permitted
 * commercially, and a cloned voice or likeness without recorded consent are all
 * refused, each with its own code and a sentence saying why.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CAPABILITIES } = require('./providers/base');

const SNAPSHOT_PATH = path.join(__dirname, 'model-catalog.snapshot.json');

/** Every field a model entry carries. A field is null exactly when `unknown` says why. */
const MODEL_FIELDS = [
    'id', 'capabilities', 'digest', 'worker_class', 'placement', 'allowed_regions',
    'licence', 'consent', 'cost', 'prompt_limit', 'max_reference_images', 'reference_mode',
    'max_keyframes', 'size_control', 'max_pixels', 'supports_seed', 'supports_negative_prompt',
    'reports_progress', 'cancel', 'duration', 'output_formats', 'controls', 'unknown',
];
/** Fields that may never be unknown: without them an entry cannot be named, routed or gated. */
const NEVER_UNKNOWN = ['id', 'capabilities', 'allowed_regions', 'consent', 'controls', 'unknown'];

const MUSIC_WORKFLOWS = ['compose', 'parts', 'separate', 'reference', 'picture', 'inpaint'];
/** Capabilities whose output has no length: a still or a mesh carries no duration entry. */
const TIMELESS = ['image', 'llm', 'model3d', 'world'];

/** The contract's vocabularies, by path within a model entry. */
const ENUMS = {
    'licence.commercial_use': ['permitted', 'restricted', 'not_permitted', 'unverified'],
    'consent.voice_clone': ['required', 'not_applicable'],
    'consent.likeness': ['required', 'not_applicable'],
    reference_mode: ['condition', 'edit'],
    size_control: ['exact', 'snapped', 'ratio-only'],
    reports_progress: ['percent', 'phase', 'none'],
    cancel: ['provider', 'stop_waiting'],
};
const WORKFLOW_STATUS = ['available', 'planned', 'unsupported'];
const REGION_RX = /^([a-z]{2}(-gov)?-[a-z]+-\d|\*)$/;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

const at = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

function validateModel(m, i) {
    const errs = [];
    const id = m && typeof m.id === 'string' && m.id ? m.id : `models[${i}]`;
    if (!m || typeof m !== 'object') return [`${id}: not an object`];
    const unknown = m.unknown && typeof m.unknown === 'object' && !Array.isArray(m.unknown) ? m.unknown : null;
    if (!unknown) errs.push(`${id}: unknown must be an object of field → reason`);

    for (const f of MODEL_FIELDS) {
        if (!(f in m)) { errs.push(`${id}: ${f} is missing`); continue; }
        if (m[f] === null) {
            if (NEVER_UNKNOWN.includes(f)) errs.push(`${id}: ${f} may not be null`);
            else if (!unknown || typeof unknown[f] !== 'string' || !unknown[f].trim()) errs.push(`${id}: ${f} is null with no reason in unknown`);
        }
    }
    // A key is a field, or a dotted path into one (`cost.instance_type`,
    // `duration.music.min_s`): the value there must be null, and the reason says why.
    for (const [f, why] of Object.entries(unknown || {})) {
        const root = f.split('.')[0];
        if (!MODEL_FIELDS.includes(root)) errs.push(`${id}: unknown names ${f}, which is not a catalog field or a path into one`);
        else if (at(m, f) !== null && at(m, f) !== undefined) errs.push(`${id}: unknown gives a reason for ${f}, which has a value`);
        else if (typeof why !== 'string' || !why.trim()) errs.push(`${id}: unknown.${f} has no reason`);
    }

    if (!Array.isArray(m.capabilities) || !m.capabilities.length) errs.push(`${id}: capabilities must be a non-empty array`);
    else for (const c of m.capabilities) if (!CAPABILITIES.includes(c)) errs.push(`${id}: capability ${c} is not one of Film Engine's (${CAPABILITIES.join(', ')})`);

    if (!Array.isArray(m.allowed_regions) || !m.allowed_regions.length) errs.push(`${id}: allowed_regions must be a non-empty array`);
    else for (const r of m.allowed_regions) if (!REGION_RX.test(String(r))) errs.push(`${id}: allowed_regions has ${r}, not an AWS region id or "*"`);

    for (const [p, vocab] of Object.entries(ENUMS)) {
        const v = at(m, p);
        if (v === null || v === undefined) continue;
        if (!vocab.includes(v)) errs.push(`${id}: ${p} is "${v}", not one of ${vocab.join(' | ')}`);
    }
    if (m.licence) {
        for (const k of ['id', 'commercial_use', 'source_url', 'verified_on']) if (!m.licence[k]) errs.push(`${id}: licence.${k} is missing`);
        if (!('expires_at' in m.licence)) errs.push(`${id}: licence.expires_at is missing (null means no expiry)`);
        else if (m.licence.expires_at !== null && !DATE_RX.test(String(m.licence.expires_at))) errs.push(`${id}: licence.expires_at is not an ISO date`);
        if (m.licence.verified_on && !DATE_RX.test(String(m.licence.verified_on))) errs.push(`${id}: licence.verified_on is not an ISO date`);
    }
    if (m.consent && typeof m.consent === 'object') {
        for (const k of ['voice_clone', 'likeness']) if (!(k in m.consent)) errs.push(`${id}: consent.${k} is missing`);
    }
    if (m.cost) {
        if (!m.cost.unit) errs.push(`${id}: cost.unit is missing`);
        if (m.cost.usd_per_unit == null && !m.cost.formula) errs.push(`${id}: cost needs usd_per_unit or a formula`);
        for (const k of ['source', 'checked_on']) if (!m.cost[k]) errs.push(`${id}: cost.${k} is missing`);
    }
    if (m.controls !== undefined && (m.controls === null || typeof m.controls !== 'object' || Array.isArray(m.controls))) errs.push(`${id}: controls must be a JSON schema object`);

    const serves = Array.isArray(m.capabilities) ? m.capabilities : [];
    for (const f of ['duration', 'output_formats']) {
        if (!m[f] || typeof m[f] !== 'object') continue;
        for (const c of serves) {
            if (f === 'duration' && TIMELESS.includes(c)) continue;
            if (!(c in m[f])) errs.push(`${id}: ${f} has no entry for ${c}`);
        }
    }
    if (serves.includes('music')) {
        const w = m.music_workflows;
        if (!w || typeof w !== 'object') errs.push(`${id}: a music model must answer music_workflows`);
        else for (const k of MUSIC_WORKFLOWS) {
            if (!w[k]) errs.push(`${id}: music_workflows.${k} is missing`);
            else if (!WORKFLOW_STATUS.includes(w[k].status)) errs.push(`${id}: music_workflows.${k}.status is "${w[k].status}"`);
            else if (!w[k].reason) errs.push(`${id}: music_workflows.${k} has no reason`);
        }
    } else if ('music_workflows' in m) {
        errs.push(`${id}: music_workflows on a model that serves no music`);
    }
    return errs;
}

/** Every reason this catalog would not be trusted; an empty list means it validates. */
function validateCatalog(cat) {
    if (!cat || typeof cat !== 'object') return ['catalog: not an object'];
    const errs = [];
    if (!Number.isInteger(cat.catalog_version) || cat.catalog_version < 1) errs.push('catalog_version must be a positive integer');
    if (!DATE_RX.test(String(cat.generated_on || ''))) errs.push('generated_on must be an ISO date');
    if (!Array.isArray(cat.models) || !cat.models.length) return errs.concat('models must be a non-empty array');
    cat.models.forEach((m, i) => errs.push(...validateModel(m, i)));
    const ids = cat.models.map(m => m && m.id);
    for (let i = 1; i < ids.length; i++) {
        if (ids[i] === ids[i - 1]) errs.push(`models: duplicate id ${ids[i]}`);
        else if (String(ids[i]) < String(ids[i - 1])) { errs.push('models must be ordered by id'); break; }
    }
    return errs;
}

// ── Which catalog is in force ──────────────────────────────────────────────
let override = null;
let cachedSnapshot;
/** Put a catalog in force for this process (tests, or a fresh GET /media/catalog). null restores the snapshot. */
function use(cat) { override = cat || null; }
function current() {
    if (override) return override;
    if (cachedSnapshot === undefined) {
        try { cachedSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')); }
        catch (_) { cachedSnapshot = null; }
    }
    return cachedSnapshot;
}
function findModel(cat, id) {
    return (cat && Array.isArray(cat.models) && cat.models.find(m => m && m.id === id)) || null;
}

/**
 * May this model run here, now, for this purpose? Fails closed.
 * ctx: { region, now, production, consents: ['voice_clone' | 'likeness'] }
 */
function admits(cat, modelId, ctx = {}) {
    const no = (code, reason) => ({ ok: false, code, reason, model: modelId });
    if (!cat) return no('NO_CATALOG', 'no model catalog is loaded, so nothing self-hosted may run');
    const errs = validateCatalog(cat);
    if (errs.length) return no('CATALOG_INVALID', `the model catalog does not validate: ${errs[0]}${errs.length > 1 ? ` (and ${errs.length - 1} more)` : ''}`);
    const m = findModel(cat, modelId);
    if (!m) return no('NOT_IN_CATALOG', `${modelId} is not in the model catalog (version ${cat.catalog_version})`);

    if (!m.licence) return no('UNLICENSED', `${m.id} has no licence record: ${m.unknown.licence}`);
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const today = now.toISOString().slice(0, 10);
    if (m.licence.expires_at && m.licence.expires_at < today) return no('LICENCE_EXPIRED', `${m.id}'s licence ${m.licence.id} expired on ${m.licence.expires_at}`);

    const regions = m.allowed_regions;
    if (!regions.includes('*')) {
        if (!ctx.region) return no('REGION_UNKNOWN', `the execution region is unknown, and ${m.id} may run only in ${regions.join(', ')}`);
        if (!regions.includes(ctx.region)) return no('REGION_NOT_ALLOWED', `${m.id} may run only in ${regions.join(', ')}, not ${ctx.region}`);
    }
    if (ctx.production && m.licence.commercial_use !== 'permitted') {
        return no('NOT_COMMERCIAL', `${m.id}'s licence ${m.licence.id} is "${m.licence.commercial_use}" for commercial use, so it cannot be enabled for production`);
    }
    const consents = new Set(ctx.consents || []);
    for (const k of ['voice_clone', 'likeness']) {
        if (m.consent[k] === 'required' && !consents.has(k)) return no('CONSENT_REQUIRED', `${m.id} processes a ${k.replace('_', ' ')}, which needs recorded consent (${k})`);
    }
    return { ok: true, model: modelId, catalog_version: cat.catalog_version };
}

// ── Auditable ──────────────────────────────────────────────────────────────
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
function fingerprint(cat) { return 'sha256:' + crypto.createHash('sha256').update(canonical(cat)).digest('hex'); }

/** Which model fields moved between two catalogs, including models added and removed. */
function diff(before, after) {
    const out = [];
    const a = new Map(((before && before.models) || []).map(m => [m.id, m]));
    const b = new Map(((after && after.models) || []).map(m => [m.id, m]));
    for (const [id, m] of b) {
        if (!a.has(id)) { out.push({ model: id, field: '(added)' }); continue; }
        const old = a.get(id);
        const fields = new Set([...Object.keys(old), ...Object.keys(m)]);
        for (const f of [...fields].sort()) if (canonical(old[f]) !== canonical(m[f])) out.push({ model: id, field: f });
    }
    for (const id of a.keys()) if (!b.has(id)) out.push({ model: id, field: '(removed)' });
    return out;
}

function refuse(code, message) { const e = new Error(message); e.code = code; return e; }

/**
 * Record a catalog as read. An unchanged catalog writes nothing; a changed one
 * writes the snapshot and one audit row naming every field that moved. A change
 * that keeps the same catalog_version is refused: the version is what the
 * gateway and this side agree on, and two catalogs under one number cannot both
 * be the one a dispatch was checked against.
 */
function recordCatalog(cat, { source = 'unknown' } = {}) {
    const errs = validateCatalog(cat);
    if (errs.length) throw refuse('CATALOG_INVALID', `refusing to record an invalid catalog: ${errs.join('; ')}`);
    const { db } = require('../db/database');
    const fp = fingerprint(cat);
    const last = db.prepare('SELECT * FROM film_model_catalogs ORDER BY catalog_version DESC LIMIT 1').get();
    if (last && last.fingerprint === fp) return { changed: false, catalog_version: cat.catalog_version, fingerprint: fp };
    const sameVersion = db.prepare('SELECT * FROM film_model_catalogs WHERE catalog_version = ?').get(cat.catalog_version);
    if (sameVersion && sameVersion.fingerprint !== fp) {
        throw refuse('VERSION_NOT_BUMPED', `catalog_version ${cat.catalog_version} was already recorded with different contents; a changed catalog must bump its version`);
    }
    if (last && cat.catalog_version < last.catalog_version) {
        throw refuse('VERSION_WENT_BACKWARDS', `catalog_version ${cat.catalog_version} is older than the recorded ${last.catalog_version}`);
    }
    const before = last ? JSON.parse(last.body_json) : null;
    const changes = diff(before, cat);
    db.transaction(() => {
        db.prepare('INSERT INTO film_model_catalogs (catalog_version, fingerprint, body_json, source) VALUES (?, ?, ?, ?)')
            .run(cat.catalog_version, fp, JSON.stringify(cat), source);
        db.prepare(`INSERT INTO film_model_catalog_audit
            (from_version, to_version, from_fingerprint, to_fingerprint, changes_json, source) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(last ? last.catalog_version : null, cat.catalog_version, last ? last.fingerprint : null, fp, JSON.stringify(changes), source);
    })();
    return { changed: true, catalog_version: cat.catalog_version, fingerprint: fp, changes };
}

function auditLog(limit = 50) {
    const { db } = require('../db/database');
    return db.prepare('SELECT * FROM film_model_catalog_audit ORDER BY id DESC LIMIT ?').all(limit)
        .map(r => ({ ...r, changes: JSON.parse(r.changes_json), changes_json: undefined }));
}

module.exports = {
    SNAPSHOT_PATH, MODEL_FIELDS, NEVER_UNKNOWN, ENUMS, MUSIC_WORKFLOWS, TIMELESS,
    validateCatalog, admits, use, current, findModel, fingerprint, diff, recordCatalog, auditLog,
};
