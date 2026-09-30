/**
 * A key is entered once, for the machine — not once per film.
 *
 * "Setup should be global, so if I enter a key it works across all projects."
 *
 * It always was: `film_provider_credentials` is keyed by provider and has no
 * project column. The belief that it might not be came from the page — API
 * keys and per-project provider CHOICES sat under one heading, and the lower
 * half needs a project open, so the whole panel read as project-scoped.
 *
 * Two different things share that card and must not be confused:
 *   credentials     — global. Who you are to a vendor.
 *   provider_config — per project. Which vendor THIS film generates with.
 *
 * And separately: six providers were stored holding the single character `k`,
 * which reported as configured everywhere and failed as a 401 mid-generation.
 * Those rows are gone; this stops them coming back.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-creds-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();

const { handleProviders } = require('../routes/providers');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function put(provider, body) {
    return new Promise(resolve => {
        const res = {
            writeHead(status) { this._status = status; },
            end(payload) { resolve({ status: this._status, body: JSON.parse(payload) }); },
        };
        handleProviders({ method: 'PUT', body }, res,
            ['film', 'providers', provider, 'credentials'], {});
    });
}

test('the credential store has no project column', () => {
    /*
     * Structural, not behavioural, because this is the guarantee: a key cannot
     * be scoped to a film if there is nowhere to record which film. If a
     * project column is ever added, every "enter it once" claim on the page
     * becomes false at the same moment.
     */
    const columns = db.prepare('PRAGMA table_info(film_provider_credentials)').all().map(c => c.name);
    assert.ok(columns.includes('provider'), 'keyed by provider');
    assert.deepStrictEqual(columns.filter(c => /project/i.test(c)), [],
        'credentials have acquired a project column — they are no longer global');

    const pk = db.prepare('PRAGMA table_info(film_provider_credentials)').all().filter(c => c.pk);
    assert.deepStrictEqual(pk.map(c => c.name), ['provider'],
        'one row per provider is what makes a key shared by every project');
});

test('no route scopes a credential read or write to a project', () => {
    // Derived from the source rather than assumed: a per-project read added
    // later would silently make keys look project-specific again.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'providers.js'), 'utf8');
    for (const stmt of src.match(/film_provider_credentials[^;]*/g) || []) {
        assert.doesNotMatch(stmt, /project_id/,
            `a credential statement mentions project_id: ${stmt.slice(0, 90)}`);
    }
    const creds = fs.readFileSync(path.join(__dirname, '..', 'lib', 'providers', 'credentials.js'), 'utf8');
    assert.doesNotMatch(creds, /project_id/,
        'the credential reader adapters use takes a project into account');
});

test('a key stored once is visible to every project', async () => {
    const key = 'msy_' + 'a'.repeat(36);
    await put('meshy', { api_key: key });

    // Two projects, neither of which was involved in storing the key.
    const { getCredential } = require('../lib/providers/credentials');
    assert.strictEqual(getCredential('meshy').apiKey, key);

    for (const id of ['f0000000-0000-4000-8000-000000000001',
                      'f0000000-0000-4000-8000-000000000002']) {
        db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                    VALUES (?, 'p', datetime('now'), datetime('now'))`).run(id);
        assert.strictEqual(getCredential('meshy').apiKey, key,
            `project ${id} sees a different credential — the store is not global`);
    }
});

test('a placeholder cannot be stored as a credential', async () => {
    /*
     * `k` was stored for six providers. Nothing downstream could tell it from
     * a real key: isProviderConfigured asks only whether the string is
     * non-empty, so the panel, the readiness check and the resolver all
     * reported green and the first sign was a 401 on a paid job.
     *
     * Refused at the write. No real key is under eight characters — the
     * shortest here is an ElevenLabs `sk_` plus 48 — so this cannot reject
     * something legitimate.
     */
    for (const bad of ['k', 'abc', '1234567']) {
        const r = await put('openai', { api_key: bad });
        assert.strictEqual(r.status, 400, `"${bad}" was accepted as an API key`);
        assert.match(r.body.error, /does not look like an API key/);
    }
    const stored = db.prepare("SELECT api_key FROM film_provider_credentials WHERE provider = 'openai'").get();
    assert.ok(!stored, 'a refused key was written anyway');
});

test('a short key already stored is flagged, not disguised', () => {
    // Rows written before the check existed. Reported rather than treated as
    // unset: the value IS there, and "not set" to someone looking straight at
    // it is its own confusion.
    db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at)
                VALUES ('openai', 'k', '{}', datetime('now'))
                ON CONFLICT(provider) DO UPDATE SET api_key = 'k'`).run();

    return new Promise(resolve => {
        const res = { writeHead() {}, end(payload) {
            const j = JSON.parse(payload);
            const openai = (j.providers || []).find(p => p.id === 'openai');
            assert.ok(openai, 'openai missing from the provider list');
            assert.strictEqual(openai.credentials.suspect, true,
                'a one-character key is reported as a normal, working credential');
            resolve();
        } };
        handleProviders({ method: 'GET' }, res, ['film', 'providers'], {});
    });
});

test('the page says which half is global and which is per project', () => {
    // The confusion was real and cost an afternoon of re-entering keys, so the
    // distinction is stated on the card rather than left to be inferred.
    const at = SPA.indexOf('id="settingsProvidersCard"');
    assert.notStrictEqual(at, -1, 'the providers card is gone');
    const card = SPA.slice(at, at + 2600);
    assert.match(card, /shared by every project/i,
        'the API keys heading does not say the keys are shared');
    assert.match(card, /this project only/i,
        'the capability map does not say it is per project');
});
