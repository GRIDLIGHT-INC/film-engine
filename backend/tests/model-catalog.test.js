/**
 * FEM-001 (GRD-4565) — the self-hosted model catalog, as Film Engine reads it.
 *
 * The catalog is AUTHORED ONCE, in gridlight (gateway/src/model-catalog.json,
 * served at GET /media/catalog). Film Engine vendors it as
 * lib/model-catalog.snapshot.json and never re-declares a licence or a region:
 * a second copy typed here would drift from the one the gateway dispatches on.
 *
 * Held here, set-based over the six models and over every enum the contract
 * names:
 *   - the contract is validated field by field, and a field is null EXACTLY
 *     when `unknown` gives its reason — an unexplained null is a guess;
 *   - `admits` fails CLOSED: an unknown model, an expired licence, a region the
 *     licence does not allow (H3 outside ca-central-1), a production run on a
 *     model not permitted commercially, a clone or likeness without consent;
 *   - every model resolves through the provider registry under Film Engine's
 *     existing capability names, and no existing provider changes;
 *   - every catalog change is audited, and a change without a version bump is
 *     refused;
 *   - a model's control schema is served to the Production client and to an
 *     agent;
 *   - the vendored snapshot equals gridlight's file when that root is present.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-model-catalog-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();
const { db } = require('../db/database');

const catalog = require('../lib/model-catalog');
const providers = require('../lib/providers');
const { CAPABILITIES } = require('../lib/providers/base');

const GL_CATALOG = '/Users/mannyhenri/code/gl-dev-media/gateway/src/model-catalog.json';

// ── A catalog in the agreed shape. Six models, as GRD-4565 names them. ──────
const MUSIC_WORKFLOWS = ['compose', 'parts', 'separate', 'reference', 'picture', 'inpaint'];
function model(id, capabilities, over = {}) {
    const music = capabilities.includes('music');
    const m = {
        id,
        name: id.toUpperCase(),
        hf_repo: `vendor/${id}`,
        aliases: [id.replace(/[-.]/g, '_')],
        capabilities,
        digest: 'sha256:' + crypto.createHash('sha256').update(id).digest('hex'),
        worker_class: 'gpu-l4',
        placement: 'batch',
        allowed_regions: ['us-east-2', 'ca-central-1'],
        licence: { id: 'test-licence', commercial_use: 'permitted', expires_at: null, source_url: 'https://example.test/licence', verified_on: '2026-09-28' },
        consent: { voice_clone: 'not_applicable', likeness: 'not_applicable' },
        cost: { unit: 'gpu_second', usd_per_unit: 0.0002, formula: null, instance_type: 'g6.xlarge', source: 'https://aws.amazon.com/ec2/pricing/', checked_on: '2026-09-28' },
        prompt_limit: 2000,
        max_reference_images: 0,
        reference_mode: null,
        max_keyframes: 0,
        size_control: null,
        max_pixels: null,
        supports_seed: true,
        supports_negative_prompt: false,
        reports_progress: 'phase',
        cancel: 'stop_waiting',
        duration: Object.fromEntries(capabilities.map(c => [c, { min_s: 1, max_s: 30 }])),
        output_formats: Object.fromEntries(capabilities.map(c => [c, ['wav']])),
        controls: { type: 'object', properties: { seed: { type: 'integer' } }, additionalProperties: false },
        unknown: { reference_mode: 'takes no reference', size_control: 'audio has no raster', max_pixels: 'audio has no raster' },
    };
    if (music) m.music_workflows = Object.fromEntries(MUSIC_WORKFLOWS.map(w => [w, { status: w === 'compose' ? 'available' : 'unsupported', reason: 'test' }]));
    return Object.assign(m, over);
}
function sixModels() {
    return {
        catalog_version: 1,
        generated_on: '2026-09-28',
        models: [
            model('fish-s2-pro', ['voice'], { consent: { voice_clone: 'required', likeness: 'not_applicable' } }),
            model('flux2-dev', ['image'], {
                licence: { id: 'flux-dev-nc', commercial_use: 'not_permitted', expires_at: null, source_url: 'https://example.test/flux', verified_on: '2026-09-28' },
                reference_mode: 'condition', size_control: 'exact', max_pixels: 2048 * 2048, max_reference_images: 4,
                unknown: {},
            }),
            model('latentsync-1.6', ['lipsync'], { consent: { voice_clone: 'not_applicable', likeness: 'required' } }),
            model('minimax-h3', ['video'], {
                allowed_regions: ['ca-central-1'],
                reference_mode: 'condition', size_control: 'snapped', max_pixels: 1920 * 1080, max_keyframes: 2,
                unknown: {},
            }),
            model('stable-audio-3-medium', ['music', 'ambient']),
            model('stable-audio-3-small-sfx', ['sfx']),
        ],
    };
}
const clone = o => JSON.parse(JSON.stringify(o));

// ── The contract ────────────────────────────────────────────────────────────
test('a well-formed six-model catalog validates', () => {
    assert.deepEqual(catalog.validateCatalog(sixModels()), []);
});

test('every field the contract names is required on every model', () => {
    assert.ok(catalog.MODEL_FIELDS.length >= 20, `only ${catalog.MODEL_FIELDS.length} fields`);
    for (const f of catalog.MODEL_FIELDS) {
        const c = sixModels();
        delete c.models[1][f];
        const errs = catalog.validateCatalog(c);
        // Dropping `id` leaves only the entry's position to name it by.
        assert.ok(errs.some(e => (e.includes('flux2-dev') || e.includes('models[1]')) && e.includes(f)), `dropping ${f} was not refused: ${errs.join('; ')}`);
    }
});

test('a field is null exactly when `unknown` gives its reason', () => {
    const c = sixModels();
    c.models[3].digest = null;                                  // null, no reason
    let errs = catalog.validateCatalog(c);
    assert.ok(errs.some(e => /minimax-h3.*digest.*no reason/.test(e)), errs.join('; '));
    c.models[3].unknown.digest = 'weights not downloaded';
    assert.deepEqual(catalog.validateCatalog(c), []);
    c.models[3].unknown.prompt_limit = 'a reason for a field that has a value';
    errs = catalog.validateCatalog(c);
    assert.ok(errs.some(e => /minimax-h3.*prompt_limit.*has a value/.test(e)), errs.join('; '));
});

test('an unknown may name a path into a field, and the value there must be null', () => {
    const c = sixModels();
    const sfx = c.models[5];
    sfx.cost.instance_type = null;
    sfx.unknown['cost.instance_type'] = 'priced per call, not per GPU second';
    assert.deepEqual(catalog.validateCatalog(c), []);
    sfx.unknown['cost.unit'] = 'a reason for a nested field that has a value';
    assert.ok(catalog.validateCatalog(c).some(e => /stable-audio-3-small-sfx.*cost\.unit.*has a value/.test(e)));
    delete sfx.unknown['cost.unit'];
    sfx.unknown['pricing.anything'] = 'not a catalog field';
    assert.ok(catalog.validateCatalog(c).some(e => /pricing\.anything.*not a catalog field/.test(e)));
});

test('a still has no duration; everything that plays for a time does', () => {
    const c = sixModels();
    const flux = c.models.find(m => m.id === 'flux2-dev');
    delete flux.duration.image;
    assert.deepEqual(catalog.validateCatalog(c), [], 'an image model was asked for a duration');
    for (const m of c.models.filter(x => !x.capabilities.every(k => catalog.TIMELESS.includes(k)))) {
        const d = sixModels(); const dm = d.models.find(x => x.id === m.id);
        delete dm.duration[dm.capabilities[0]];
        assert.ok(catalog.validateCatalog(d).some(e => e.includes(`${m.id}: duration has no entry`)), `${m.id} lost its duration unnoticed`);
    }
});

test('a model is found by its id, its repository or any alias, as the gateway finds it', () => {
    const c = sixModels();
    for (const m of c.models) {
        for (const key of [m.id, m.hf_repo, ...m.aliases]) {
            assert.equal(catalog.findModel(c, key)?.id, m.id, `${key} did not find ${m.id}`);
            const r = catalog.admits(c, key, { region: m.allowed_regions[0], now: NOW, consents: ['voice_clone', 'likeness'] });
            assert.equal(r.ok, true, `${key}: ${r.code}`);
        }
    }
    assert.equal(catalog.admits(c, 'vendor/minimax-h3', { region: 'us-east-2', now: NOW }).code, 'REGION_NOT_ALLOWED', 'H3 escaped its region by its repository name');
    const dup = sixModels(); dup.models[5].aliases = ['minimax_h3'];
    assert.ok(catalog.validateCatalog(dup).some(e => /minimax_h3.*more than one model/.test(e)));
});

test('the optional fields are named, and a field outside the contract is refused', () => {
    assert.deepEqual([...catalog.OPTIONAL_FIELDS].sort(), ['aliases', 'hf_repo', 'music_workflows', 'name'].sort());
    const c = sixModels();
    for (const f of ['name', 'hf_repo', 'aliases']) delete c.models[0][f];
    assert.deepEqual(catalog.validateCatalog(c), [], 'an optional field was required');
    const d = sixModels(); d.models[0].pricing = {};
    assert.ok(catalog.validateCatalog(d).some(e => /pricing.*not a catalog field/.test(e)));
});

test('validation is cached by content, so a changed catalog is re-checked', () => {
    const c = sixModels();
    assert.equal(catalog.admits(c, 'minimax-h3', { region: 'ca-central-1', now: NOW }).ok, true);
    delete c.models[3].licence;                                  // same object, new content
    assert.equal(catalog.admits(c, 'minimax-h3', { region: 'ca-central-1', now: NOW }).code, 'CATALOG_INVALID');
});

test('every enum is held to its own vocabulary', () => {
    const ENUM_PATHS = Object.keys(catalog.ENUMS);
    assert.ok(ENUM_PATHS.length >= 7, `only ${ENUM_PATHS.length} enums`);
    for (const p of ENUM_PATHS) {
        const c = sixModels();
        const m = c.models[3];                                  // minimax-h3: every enum non-null
        const keys = p.split('.');
        let o = m; for (const k of keys.slice(0, -1)) o = o[k];
        o[keys[keys.length - 1]] = 'not-a-value';
        const errs = catalog.validateCatalog(c);
        assert.ok(errs.some(e => e.includes(p)), `${p} accepted a value outside its vocabulary`);
    }
});

test('capabilities must be Film Engine\'s own names', () => {
    const c = sixModels();
    c.models[1].capabilities = ['picture'];
    assert.ok(catalog.validateCatalog(c).some(e => /flux2-dev.*picture/.test(e)));
});

test('a music model answers for all six workflows, and only a music model carries them', () => {
    const c = sixModels();
    delete c.models[4].music_workflows.inpaint;
    assert.ok(catalog.validateCatalog(c).some(e => /stable-audio-3-medium.*inpaint/.test(e)));
    const d = sixModels();
    d.models[1].music_workflows = sixModels().models[4].music_workflows;
    assert.ok(catalog.validateCatalog(d).some(e => /flux2-dev.*music_workflows/.test(e)));
});

test('the top level is versioned, dated, and ordered by id', () => {
    const a = sixModels(); a.catalog_version = '1';
    assert.ok(catalog.validateCatalog(a).some(e => /catalog_version/.test(e)));
    const b = sixModels(); b.models.reverse();
    assert.ok(catalog.validateCatalog(b).some(e => /ordered by id/.test(e)));
    const c = sixModels(); c.models.push(clone(c.models[1]));
    assert.ok(catalog.validateCatalog(c).some(e => /duplicate|ordered/.test(e)));
});

// ── Fail closed ─────────────────────────────────────────────────────────────
const NOW = new Date('2026-09-28T12:00:00Z');

test('every model is admitted in an allowed region with everything in order', () => {
    const c = sixModels();
    for (const m of c.models) {
        const r = catalog.admits(c, m.id, {
            region: m.allowed_regions[0], now: NOW, production: false,
            consents: ['voice_clone', 'likeness'],
        });
        assert.equal(r.ok, true, `${m.id}: ${r.code} ${r.reason}`);
    }
});

test('H3 outside ca-central-1 is refused, and so is every model outside its own regions', () => {
    const c = sixModels();
    const h3 = catalog.admits(c, 'minimax-h3', { region: 'us-east-2', now: NOW });
    assert.equal(h3.ok, false);
    assert.equal(h3.code, 'REGION_NOT_ALLOWED');
    assert.match(h3.reason, /ca-central-1/);
    for (const m of c.models) {
        const r = catalog.admits(c, m.id, { region: 'eu-west-1', now: NOW, consents: ['voice_clone', 'likeness'] });
        assert.equal(r.code, 'REGION_NOT_ALLOWED', `${m.id} ran in eu-west-1`);
    }
});

test('an unknown region fails closed unless the model allows every region', () => {
    const c = sixModels();
    assert.equal(catalog.admits(c, 'minimax-h3', { region: null, now: NOW }).code, 'REGION_UNKNOWN');
    c.models[5].allowed_regions = ['*'];
    assert.equal(catalog.admits(c, 'stable-audio-3-small-sfx', { region: null, now: NOW }).ok, true);
});

test('an unknown model, an expired licence and an unlicensed model are refused', () => {
    const c = sixModels();
    assert.equal(catalog.admits(c, 'wan-9', { region: 'us-east-2', now: NOW }).code, 'NOT_IN_CATALOG');
    c.models[5].licence.expires_at = '2026-09-01';
    assert.equal(catalog.admits(c, 'stable-audio-3-small-sfx', { region: 'us-east-2', now: NOW }).code, 'LICENCE_EXPIRED');
    c.models[5].licence = null; c.models[5].unknown.licence = 'terms not read';
    assert.equal(catalog.admits(c, 'stable-audio-3-small-sfx', { region: 'us-east-2', now: NOW }).code, 'UNLICENSED');
});

test('production needs commercial use permitted, or an unexpired licence grant for that model', () => {
    const c = sixModels();
    const flux = c.models.find(m => m.id === 'flux2-dev');
    const run = (grants, now = NOW) => catalog.admits(c, 'flux2-dev', { region: 'us-east-2', now, production: true, grants });
    const grant = over => ({ model_id: 'flux2-dev', licence_ref: 'BFL-COMMERCIAL-123', granted_on: '2026-09-01', expires_at: null, revoked_at: null, ...over });
    for (const state of ['not_permitted', 'restricted', 'unverified']) {
        flux.licence.commercial_use = state;
        assert.equal(run([]).code, 'NOT_COMMERCIAL', `production allowed at ${state} with no grant`);
        assert.equal(catalog.admits(c, 'flux2-dev', { region: 'us-east-2', now: NOW, production: false }).ok, true, `${state} blocked a non-production run`);
        assert.equal(run([grant()]).ok, true, `a grant did not enable production at ${state}`);
        assert.equal(run([grant({ expires_at: '2026-09-27' })]).code, 'NOT_COMMERCIAL', `an expired grant enabled production at ${state}`);
        assert.equal(run([grant({ revoked_at: '2026-09-20 10:00:00' })]).code, 'NOT_COMMERCIAL', `a revoked grant enabled production at ${state}`);
        assert.equal(run([grant({ model_id: 'minimax-h3' })]).code, 'NOT_COMMERCIAL', `another model's grant enabled production at ${state}`);
        assert.equal(run([grant({ granted_on: '2026-10-01' })]).code, 'NOT_COMMERCIAL', `a grant that starts in the future enabled production at ${state}`);
    }
    flux.licence.commercial_use = 'permitted';
    assert.equal(run([]).ok, true, 'permitted needed a grant');
});

test('a licence grant is recorded, listed, revoked, and never deleted', () => {
    db.prepare('DELETE FROM film_model_licence_grants').run();
    catalog.use(sixModels());
    try {
        assert.throws(() => catalog.recordGrant({ model_id: 'wan-9', licence_ref: 'X', granted_by: 'me' }), e => e.code === 'NOT_IN_CATALOG');
        for (const k of ['licence_ref', 'granted_by']) {
            const body = { model_id: 'flux2-dev', licence_ref: 'BFL-1', granted_by: 'Manny' };
            delete body[k];
            assert.throws(() => catalog.recordGrant(body), e => e.code === 'INVALID_GRANT', `a grant with no ${k} was recorded`);
        }
        assert.throws(() => catalog.recordGrant({ model_id: 'flux2-dev', licence_ref: 'BFL-1', granted_by: 'M', expires_at: 'next year' }), e => e.code === 'INVALID_GRANT');
        const g = catalog.recordGrant({ model_id: 'hf:vendor/flux2-dev'.slice(3), licence_ref: 'BFL-1', scope: 'all projects', granted_by: 'Manny', granted_on: '2026-09-01' });
        assert.equal(g.model_id, 'flux2-dev', 'a grant made by repo name was not stored under the catalog id');
        assert.equal(catalog.grantsFor('flux2-dev').length, 1);
        catalog.revokeGrant(g.id, { revoked_by: 'Manny' });
        const rows = db.prepare('SELECT * FROM film_model_licence_grants').all();
        assert.equal(rows.length, 1, 'revoking deleted the record');
        assert.ok(rows[0].revoked_at);
        assert.throws(() => catalog.revokeGrant(g.id, { revoked_by: 'Manny' }), e => e.code === 'ALREADY_REVOKED');
    } finally { catalog.use(null); }
});

test('consent is asked for only when the request carries a voice or a face', () => {
    const c = sixModels();
    const h3 = c.models.find(m => m.id === 'minimax-h3');
    h3.consent = { voice_clone: 'required', likeness: 'required' };
    const at = (inputs, consents) => catalog.admits(c, 'minimax-h3', { region: 'ca-central-1', now: NOW, inputs, consents });
    assert.equal(at([], []).ok, true, 'text-to-video with no reference asked for consent');
    assert.equal(at(['prompt'], undefined).ok, true);
    for (const [kind, inputs] of Object.entries(catalog.CONSENT_INPUTS)) {
        for (const input of inputs) {
            const r = at([input], []);
            assert.equal(r.code, 'CONSENT_REQUIRED', `${input} ran without ${kind} consent`);
            assert.match(r.reason, new RegExp(kind));
            assert.equal(at([input], [kind]).ok, true, `${input} refused with ${kind} consent recorded`);
        }
    }
    // A model whose consent is not_applicable never asks, whatever it is sent.
    assert.equal(catalog.admits(c, 'stable-audio-3-small-sfx', { region: 'us-east-2', now: NOW, inputs: ['reference_audio'] }).ok, true);
});

test('an invalid catalog admits nothing', () => {
    const c = sixModels(); delete c.models[3].licence;
    const r = catalog.admits(c, 'minimax-h3', { region: 'ca-central-1', now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CATALOG_INVALID');
});

// ── Through the provider registry ───────────────────────────────────────────
test('every model resolves through the provider registry under its own capabilities', () => {
    const c = sixModels();
    const before = providers.list().map(a => a.id).sort();
    const beforeModels = Object.fromEntries(before.map(id => [id, CAPABILITIES.map(cap => JSON.stringify(providers.modelIdsFor(id, cap)))]));
    catalog.use(c);
    try {
        for (const m of c.models) {
            for (const cap of m.capabilities) {
                assert.ok(CAPABILITIES.includes(cap), `${cap} is not a Film Engine capability`);
                const r = providers.resolveCatalogModel(cap, m.id);
                assert.ok(r, `${m.id} does not resolve for ${cap}`);
                assert.equal(r.model.id, m.id);
                assert.ok(providers.catalogModelIds(cap).includes(m.id));
            }
            for (const cap of CAPABILITIES.filter(x => !m.capabilities.includes(x))) {
                assert.equal(providers.resolveCatalogModel(cap, m.id), null, `${m.id} resolved for ${cap}, which it does not serve`);
            }
        }
        const after = providers.list().map(a => a.id).sort();
        assert.deepEqual(after, before, 'the catalog changed the set of providers');
        for (const id of after) {
            assert.deepEqual(CAPABILITIES.map(cap => JSON.stringify(providers.modelIdsFor(id, cap))), beforeModels[id], `${id}'s models changed`);
        }
    } finally { catalog.use(null); }
});

// ── Auditable ───────────────────────────────────────────────────────────────
test('every catalog change is audited, and a change without a version bump is refused', () => {
    db.prepare('DELETE FROM film_model_catalog_audit').run();
    db.prepare('DELETE FROM film_model_catalogs').run();
    const c1 = sixModels();
    const r1 = catalog.recordCatalog(c1, { source: 'test' });
    assert.equal(r1.changed, true);
    assert.equal(catalog.recordCatalog(c1, { source: 'test' }).changed, false, 'an unchanged catalog wrote an audit row');

    const same = sixModels(); same.models[3].allowed_regions = ['ca-central-1', 'us-east-2'];
    assert.throws(() => catalog.recordCatalog(same, { source: 'test' }), e => e.code === 'VERSION_NOT_BUMPED');

    const c2 = sixModels(); c2.catalog_version = 2; c2.models[3].allowed_regions = ['ca-central-1', 'us-east-2'];
    const r2 = catalog.recordCatalog(c2, { source: 'test' });
    assert.equal(r2.changed, true);
    const rows = db.prepare('SELECT * FROM film_model_catalog_audit ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].from_version, 1);
    assert.equal(rows[1].to_version, 2);
    const changes = JSON.parse(rows[1].changes_json);
    assert.deepEqual(changes, [{ model: 'minimax-h3', field: 'allowed_regions' }]);

    const bad = sixModels(); bad.catalog_version = 3; delete bad.models[1].licence;
    assert.throws(() => catalog.recordCatalog(bad, { source: 'test' }), e => e.code === 'CATALOG_INVALID');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM film_model_catalog_audit').get().n, 2);
});

// ── Served to Production and to an agent ────────────────────────────────────
function call(method, url) {
    const { handleModelCatalog } = require('../routes/model-catalog');
    return new Promise(resolve => {
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.setHeader = () => {};
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.on('finish', () => {
            let body = Buffer.concat(chunks).toString();
            try { body = JSON.parse(body); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body });
        });
        const parts = url.split('?')[0].split('/').filter(Boolean);
        handleModelCatalog({ method, url, headers: {} }, res, parts);
    });
}

test('the catalog and each model\'s control schema are served; an unknown model is a 404', async () => {
    const c = sixModels();
    catalog.use(c);
    try {
        const all = await call('GET', '/film/model-catalog');
        assert.equal(all.status, 200);
        assert.equal(all.body.catalog_version, 1);
        assert.deepEqual(all.body.models.map(m => m.id), c.models.map(m => m.id));
        for (const m of c.models) {
            const r = await call('GET', `/film/model-catalog/${m.id}/controls`);
            assert.equal(r.status, 200, m.id);
            assert.deepEqual(r.body.controls, m.controls);
            assert.deepEqual(r.body.capabilities, m.capabilities);
        }
        assert.equal((await call('GET', '/film/model-catalog/wan-9/controls')).status, 404);
        assert.equal((await call('POST', '/film/model-catalog')).status, 405);
    } finally { catalog.use(null); }
});

test('a licence grant is recorded and revoked over HTTP, and refused with its reason', async () => {
    db.prepare('DELETE FROM film_model_licence_grants').run();
    catalog.use(sixModels());
    try {
        const post = (url, body) => new Promise(resolve => {
            const { handleModelCatalog } = require('../routes/model-catalog');
            const chunks = [];
            const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
            res.statusCode = 200;
            res.writeHead = function (code) { this.statusCode = code; return this; };
            res.on('finish', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
            handleModelCatalog({ method: 'POST', url, headers: {}, body }, res, url.split('/').filter(Boolean));
        });
        const ok = await post('/film/model-catalog/grants', { model_id: 'flux2-dev', licence_ref: 'BFL-9', granted_by: 'Manny' });
        assert.equal(ok.status, 201);
        assert.equal((await post('/film/model-catalog/grants', { model_id: 'wan-9', licence_ref: 'X', granted_by: 'M' })).status, 404);
        assert.equal((await post('/film/model-catalog/grants', { model_id: 'flux2-dev', granted_by: 'M' })).status, 400);
        assert.equal((await post(`/film/model-catalog/grants/${ok.body.grant.id}/revoke`, { revoked_by: 'Manny' })).status, 200);
        assert.equal((await post(`/film/model-catalog/grants/${ok.body.grant.id}/revoke`, { revoked_by: 'Manny' })).status, 409);
        assert.equal(catalog.admitsHere('flux2-dev', { region: 'us-east-2', production: true }).code, 'NOT_COMMERCIAL', 'a revoked grant still enabled production');
        await post('/film/model-catalog/grants', { model_id: 'flux2-dev', licence_ref: 'BFL-10', granted_by: 'Manny' });
        assert.equal(catalog.admitsHere('flux2-dev', { region: 'us-east-2', production: true }).ok, true, 'a recorded grant did not enable production');
    } finally { catalog.use(null); }
});

test('an agent can read the catalog and a model\'s controls', () => {
    const names = require('../lib/mcp-tools').listTools().map(t => t.name);
    for (const t of ['model_catalog', 'model_controls', 'model_catalog_audit', 'model_licence_grants', 'model_licence_grant', 'model_licence_revoke']) assert.ok(names.includes(t), `no ${t} tool`);
});

// ── The vendored copy is gridlight's file, byte for byte ────────────────────
test('the vendored snapshot validates, and registers exactly the six models', () => {
    assert.ok(fs.existsSync(catalog.SNAPSHOT_PATH), 'no vendored catalog at lib/model-catalog.snapshot.json');
    const snap = JSON.parse(fs.readFileSync(catalog.SNAPSHOT_PATH, 'utf8'));
    assert.deepEqual(catalog.validateCatalog(snap), [], 'the vendored catalog does not validate');
    assert.deepEqual(snap.models.map(m => m.id),
        ['fish-s2-pro', 'flux2-dev', 'latentsync-1.6', 'minimax-h3', 'stable-audio-3-medium', 'stable-audio-3-small-sfx'],
        'the catalog does not register exactly the six models GRD-4565 names');
    const h3 = catalog.admits(snap, 'minimax-h3', { region: 'us-east-2', now: NOW });
    assert.equal(h3.code, 'REGION_NOT_ALLOWED', 'the shipped catalog lets H3 run outside ca-central-1');
});

test('the vendored snapshot is gridlight\'s catalog, byte for byte', t => {
    if (!fs.existsSync(GL_CATALOG)) { t.skip(`gridlight catalog ${GL_CATALOG} absent`); return; }
    assert.equal(fs.readFileSync(catalog.SNAPSHOT_PATH, 'utf8'), fs.readFileSync(GL_CATALOG, 'utf8'));
});

test('the server records the vendored catalog when it starts', async () => {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-catalog-boot-'));
    // A port the OS says is free, rather than a random range another test file could draw from.
    const port = await new Promise(r => { const srv = require('net').createServer(); srv.listen(0, () => { const p = srv.address().port; srv.close(() => r(p)); }); });
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
        { env: { ...process.env, FILM_DATA_DIR: dir, PORT: String(port) }, stdio: 'ignore' });
    try {
        const deadline = Date.now() + 20000;
        let up = false;
        while (!up && Date.now() < deadline) {
            up = await new Promise(r => require('http').get(`http://127.0.0.1:${port}/api/health`, res => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
            if (!up) await new Promise(r => setTimeout(r, 200));
        }
        assert.ok(up, 'the server did not start');
        const Database = require('better-sqlite3');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
        assert.ok(files.length, 'no database was created');
        const d = new Database(path.join(dir, files[0]), { readonly: true });
        const snap = JSON.parse(fs.readFileSync(catalog.SNAPSHOT_PATH, 'utf8'));
        const row = d.prepare('SELECT * FROM film_model_catalogs WHERE catalog_version = ?').get(snap.catalog_version);
        const audits = d.prepare('SELECT COUNT(*) n FROM film_model_catalog_audit').get().n;
        d.close();
        assert.ok(row, 'starting the server did not record the vendored catalog');
        assert.equal(audits, 1, 'starting the server did not write the first audit row');
    } finally { child.kill(); }
});
