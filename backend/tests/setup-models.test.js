/**
 * Choosing a model in Setup, for every capability, and the Setup page on one
 * screen.
 *
 * "It allows me to select the provider but then how do I select the model?"
 *
 * Set-based over CAPABILITIES crossed with every provider's own model list:
 *   - every capability whose providers offer models takes a pinned
 *     `<capability>_model`, checked against the provider that would run it; a
 *     model that provider does not offer is refused, naming what it does offer;
 *   - a pin reaches the request at the one funnel (resolve), for every
 *     capability, only when the adapter offers it, and never overwrites a
 *     model the caller named;
 *   - for video, the pin outranks the quality tier's preference and loses to a
 *     per-generation choice;
 *   - the LLM takes no pin: the connected agent is the model;
 * and the page: every capability row has a provider menu and a model menu
 * that follows it, the choice is saved, and the Setup cards sit in one
 * full-width grid with no fixed card widths.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-sm-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const providers = require('../lib/providers');
const { CAPABILITIES } = require('../lib/providers/base');
const { handleProviders } = require('../routes/providers');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Every (capability, provider, models) where a provider offers a model choice. */
const OFFERS = [];
for (const cap of CAPABILITIES) {
    if (cap === 'llm') continue;
    for (const a of providers.list()) {
        if (!(a.capabilities || []).includes(cap)) continue;
        const ids = providers.modelIdsFor(a, cap);
        if (ids && ids.length) OFFERS.push({ cap, provider: a.id, models: ids });
    }
}

function call(method, parts, body) {
    return new Promise(resolve => {
        const res = { code: 0, writeHead(c) { this.code = c; }, setHeader() {},
            end(b) { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ code: this.code, json: j }); } };
        handleProviders({ method, headers: {}, body: body || {} }, res, parts, {});
    });
}

test('the scan found model choices across several capabilities', () => {
    const caps = new Set(OFFERS.map(o => o.cap));
    for (const c of ['image', 'video', 'post', 'model3d']) assert.ok(caps.has(c), `no provider offers a ${c} model`);
});

test('every capability takes a pinned model its provider offers, and refuses one it does not', async () => {
    for (const o of OFFERS) {
        const pid = generateId();
        db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Pins')").run(pid);
        const model = o.models[o.models.length - 1];
        const ok = await call('PUT', ['film', 'projects', pid, 'providers'], { config: { [o.cap]: o.provider, [`${o.cap}_model`]: model } });
        assert.equal(ok.code, 200, `${o.cap}/${o.provider}/${model}: ${JSON.stringify(ok.json)}`);
        const stored = JSON.parse(db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(pid).provider_config);
        assert.equal(stored[`${o.cap}_model`], model, `${o.cap}: the pin is stored`);
        const bad = await call('PUT', ['film', 'projects', pid, 'providers'], { config: { [`${o.cap}_model`]: 'no-such-model-xyz' } });
        assert.equal(bad.code, 400, `${o.cap}/${o.provider}: an unknown model is refused`);
        assert.deepEqual(bad.json.available_models, o.models, `${o.cap}: the refusal lists what ${o.provider} offers`);
        // Blank stops pinning.
        const clear = await call('PUT', ['film', 'projects', pid, 'providers'], { config: { [`${o.cap}_model`]: '' } });
        assert.equal(clear.code, 200);
        assert.equal(JSON.parse(db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(pid).provider_config)[`${o.cap}_model`], undefined);
    }
});

test('the LLM takes no pin: the connected agent is the model', async () => {
    const pid = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'LLM')").run(pid);
    await call('PUT', ['film', 'projects', pid, 'providers'], { config: { llm_model: 'gpt-4.1' } });
    const stored = JSON.parse(db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(pid).provider_config || '{}');
    assert.equal(stored.llm_model, undefined);
});

test('a pin reaches the request at the funnel, only where offered, and never overwrites a named model', async () => {
    for (const o of OFFERS) {
        const adapter = providers.get(o.provider);
        const seen = [];
        const fake = Object.assign(Object.create(adapter), { id: adapter.id, capabilities: adapter.capabilities, asyncGeneration: false,
            generate: async (cap, payload) => { seen.push(payload.model); return { ok: false, status: 400, error: 'stub' }; } });
        const model = o.models[0];
        const cfg = { [o.cap]: o.provider, [`${o.cap}_model`]: model };
        const w = providers.withJobRecording(fake, o.cap, cfg);
        await w.generate(o.cap, { prompt: 'x' });
        await w.generate(o.cap, { prompt: 'x', model: 'named-by-caller' });
        const wrong = providers.withJobRecording(fake, o.cap, { [o.cap]: o.provider, [`${o.cap}_model`]: 'not-offered-here' });
        await wrong.generate(o.cap, { prompt: 'x' });
        assert.deepEqual(seen, [model, 'named-by-caller', undefined], `${o.cap}/${o.provider}: pinned, respected, ignored when not offered`);
    }
});

test('for video, the pin outranks the tier and loses to a per-generation choice', () => {
    const { applyTier } = require('../routes/video-gen');
    const tier = { id: 'draft', preferredModel: 'gen4_turbo' };
    assert.equal(applyTier(tier, { body: {} }, null, 'gen4.5').model, 'gen4.5', 'the pin beats the tier');
    assert.equal(applyTier(tier, { body: { model: 'veo3.1' } }, null, 'gen4.5').model, 'veo3.1', 'a choice for this clip beats the pin');
    assert.equal(applyTier(tier, { body: {} }, null, null).model, 'gen4_turbo', 'no pin, the tier');
    const { videoPinFor } = require('../routes/video-gen');
    const pid = generateId(), sc = generateId(), sh = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, 'V', ?)").run(pid, JSON.stringify({ video: 'runway', video_model: 'gen4.5' }));
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(sc, pid);
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(sh, sc);
    assert.equal(videoPinFor(sh, null), 'gen4.5');
    assert.equal(videoPinFor(sh, { video: 'seedance' }), null, 'a Runway model is not carried to Seedance');
});

/* ── the page ──────────────────────────────────────────────────────────── */

function fn(name) {
    let at = SPA.indexOf(`    function ${name}(`);
    if (at < 0) at = SPA.indexOf(`    async function ${name}(`);
    assert.ok(at >= 0, `${name} is missing`);
    return SPA.slice(at, SPA.indexOf('\n    }\n', at) + 6);
}

test('the model menu follows the provider picked beside it', () => {
    // A minimal DOM for two selects.
    const make = (id, value, data) => ({ id, value, dataset: { ...(data || {}) }, innerHTML: '', disabled: false, title: '' });
    const prov = make('provcap-video', 'runway');
    const model = make('provmodel-video', '', { pinned: 'gen4.5', effective: 'seedance' });
    const doc = { getElementById: id => ({ 'provcap-video': prov, 'provmodel-video': model })[id] || null };
    const esc = x => String(x);
    const menus = { video: { runway: { models: [{ id: 'gen4.5', label: 'Gen-4.5' }, { id: 'gen4_turbo', label: 'Gen-4 Turbo' }] },
        seedance: { models: [{ id: 'seedance-2.5-1080p', label: '1080p' }] } } };
    // eslint-disable-next-line no-new-func
    const refresh = new Function('document', 'esc', '_providerModelMenus', fn('refreshModelMenu') + '\nreturn refreshModelMenu;')(doc, esc, menus);
    refresh('video');
    assert.match(model.innerHTML, /gen4\.5"\s*selected/, 'the saved pin is selected');
    assert.match(model.innerHTML, /gen4_turbo/);
    assert.doesNotMatch(model.innerHTML, /seedance-2\.5/, 'not the other provider\'s models');
    prov.value = ''; model.value = 'gen4.5';
    refresh('video');
    assert.match(model.innerHTML, /seedance-2\.5-1080p/, 'on Automatic, the models of the provider in use');
    assert.doesNotMatch(model.innerHTML, /selected>gen4/, 'a model the new provider does not offer is not kept');
});

test('every capability row has a provider menu and a model menu, and saving sends the models', () => {
    const load = fn('loadProviders');
    assert.match(load, /id="provcap-\$\{esc\(cap\)\}"/);
    assert.match(load, /id="provmodel-\$\{esc\(cap\)\}"/);
    assert.match(load, /refreshModelMenu\('\$\{esc\(cap\)\}'\)/, 'changing the provider redraws the models');
    assert.match(fn('saveProviderConfig'), /config\[cap \+ '_model'\] = ms\.value\.trim\(\)/);
});

test('Setup is one full-width grid: providers across the top, the rest in columns, no fixed card widths', () => {
    const at = SPA.indexOf('<div class="page" id="page-settings">');
    const page = SPA.slice(at, SPA.indexOf('<!-- ==== CODEX:START ops-compliance-pages ==== -->'));
    const cards = [...page.matchAll(/<div class="card[^"]*"[^>]*>/g)].map(m => m[0]);
    assert.ok(cards.length >= 10, `only ${cards.length} cards`);
    for (const c of cards) {
        assert.match(c, /set-card/, `a card outside the grid: ${c}`);
        assert.doesNotMatch(c, /max-width/, `a card with a fixed width: ${c}`);
    }
    assert.ok(page.indexOf('id="settingsProvidersCard"') < page.indexOf('class="set-cols"'), 'providers lead, above the columns');
    assert.match(SPA, /#page-settings \.set-cols \{ column-width: 380px;/, 'the other cards pack into columns');
    assert.match(SPA, /#page-settings \.set-card \{ margin:0 !important; max-width:none !important;/);
});
