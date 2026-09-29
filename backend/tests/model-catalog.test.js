/**
 * FEM-001 (GRD-4565) — the self-hosted model catalog, as Film Engine reads it.
 *
 * The catalog is AUTHORED ONCE, in gridlight (gateway/assets/model-catalog.json,
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

const GL_CATALOG = '/Users/mannyhenri/code/gl-dev-media/gateway/assets/model-catalog.json';

// ── A catalog in the agreed shape. Six models, as GRD-4565 names them. ──────
const MUSIC_WORKFLOWS = ['compose', 'parts', 'separate', 'reference', 'picture', 'inpaint'];
function model(id, capabilities, over = {}) {
    const music = capabilities.includes('music');
    const m = {
        id,
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

test('production is impossible without commercial use permitted', () => {
    const c = sixModels();
    for (const state of ['not_permitted', 'restricted', 'unverified']) {
        c.models[1].licence.commercial_use = state;
        const r = catalog.admits(c, 'flux2-dev', { region: 'us-east-2', now: NOW, production: true });
        assert.equal(r.code, 'NOT_COMMERCIAL', `production allowed at ${state}`);
        assert.equal(catalog.admits(c, 'flux2-dev', { region: 'us-east-2', now: NOW, production: false }).ok, true, `${state} blocked a non-production run`);
    }
    c.models[1].licence.commercial_use = 'permitted';
    assert.equal(catalog.admits(c, 'flux2-dev', { region: 'us-east-2', now: NOW, production: true }).ok, true);
});

test('a cloned voice or a likeness needs its recorded consent', () => {
    const c = sixModels();
    const fish = catalog.admits(c, 'fish-s2-pro', { region: 'us-east-2', now: NOW });
    assert.equal(fish.code, 'CONSENT_REQUIRED');
    assert.match(fish.reason, /voice_clone/);
    assert.equal(catalog.admits(c, 'fish-s2-pro', { region: 'us-east-2', now: NOW, consents: ['voice_clone'] }).ok, true);
    assert.equal(catalog.admits(c, 'latentsync-1.6', { region: 'us-east-2', now: NOW, consents: ['voice_clone'] }).code, 'CONSENT_REQUIRED');
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

test('an agent can read the catalog and a model\'s controls', () => {
    const names = require('../lib/mcp-tools').listTools().map(t => t.name);
    for (const t of ['model_catalog', 'model_controls', 'model_catalog_audit']) assert.ok(names.includes(t), `no ${t} tool`);
});

// ── The vendored copy is gridlight's file, byte for byte ────────────────────
test('the vendored snapshot equals gridlight\'s catalog', t => {
    if (!fs.existsSync(GL_CATALOG)) { t.skip(`gridlight catalog ${GL_CATALOG} absent`); return; }
    assert.ok(fs.existsSync(catalog.SNAPSHOT_PATH), 'gridlight has a catalog and Film Engine has not vendored it');
    assert.deepEqual(JSON.parse(fs.readFileSync(catalog.SNAPSHOT_PATH, 'utf8')), JSON.parse(fs.readFileSync(GL_CATALOG, 'utf8')));
    const snap = JSON.parse(fs.readFileSync(catalog.SNAPSHOT_PATH, 'utf8'));
    assert.deepEqual(catalog.validateCatalog(snap), [], 'the vendored catalog does not validate');
    assert.deepEqual(snap.models.map(m => m.id).sort(),
        ['fish-s2-pro', 'flux2-dev', 'latentsync-1.6', 'minimax-h3', 'stable-audio-3-medium', 'stable-audio-3-small-sfx'].sort(),
        'the catalog does not register exactly the six models GRD-4565 names');
});
