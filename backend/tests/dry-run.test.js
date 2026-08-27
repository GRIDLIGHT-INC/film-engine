/**
 * A DRY RUN THAT DESCRIBES THE REQUEST THAT WOULD REALLY GO.
 *
 * "I want a test run for all services without sending the call — this process
 *  uses these services and this is what the prompt would be built from."
 *
 * The value of a report like this rests entirely on it being derived. A report
 * that assembled its own idea of each request would drift from the ones that
 * are sent — which is the fault the refine preview shipped once, showing a
 * ~3,800-character regeneration prompt for an operation that sends 165
 * characters and one picture.
 *
 * Set-based over the CAPABILITIES registry, because the failure would be
 * partial: describing image and video correctly while voice silently reports a
 * builder crash reads as a working report.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-dryrun-' + crypto.randomUUID().slice(0, 8));

const { describeCapability, sanitize } = require('../lib/dry-run');
const providers = require('../lib/providers');

/*
 * A temp database has no credentials, so every capability resolves to nothing
 * and the report correctly says so — which would make these assertions pass
 * for the wrong reason. Seeding makes them about the description rather than
 * about an empty machine.
 */
require('../db/schema').ensureSchema();
(function seed() {
    const { db } = require('../db/database');
    for (const a of providers.list()) {
        if (!a.requiresKey) continue;
        db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta) VALUES (?, 'k', '{}')
                    ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`).run(a.id);
    }
})();

test('every capability is described, or says why it cannot be', () => {
    /*
     * "Cannot be described" is a legitimate answer — nothing serves it, the
     * shot has no dialogue — but it has to be SAID. An entry with neither a
     * request nor a reason is a hole the reader cannot tell from a working one.
     */
    const silent = [];
    for (const cap of providers.CAPABILITIES) {
        if (cap === 'stock') continue;          // no adapter ships for it
        const r = describeCapability(cap, { project: { id: 'p', style_preset: 'noir' } }, {});
        const described = !!(r.outbound || r.payload);
        if (!described && !r.notes.length) silent.push(cap);
    }
    assert.deepStrictEqual(silent, [],
        `these produced neither a request nor a reason: ${silent.join(', ')}`);
});

test('nothing in the report is a credential or a picture', () => {
    /*
     * The report is meant to be read and pasted. A key in it is a key in a chat
     * log; a reference image is megabytes of base64 that makes the whole thing
     * unreadable, and an unreadable report is one nobody checks.
     */
    const dirty = {
        api_key: 'sk-live-must-never-appear',
        Authorization: 'Bearer nope',
        promptImage: 'data:image/png;base64,' + 'A'.repeat(4000),
        bare: 'B'.repeat(3000),
        nested: { secret_token: 'also-no', buf: Buffer.alloc(64) },
    };
    const clean = JSON.stringify(sanitize(dirty));
    for (const leak of ['sk-live-must-never-appear', 'Bearer nope', 'also-no']) {
        assert.ok(!clean.includes(leak), `a credential reached the report: ${leak}`);
    }
    assert.ok(!/A{600}/.test(clean), 'a data-URI image was printed in full');
    assert.ok(!/B{600}/.test(clean), 'a bare base64 image was printed in full');
    assert.ok(/KB inline/.test(clean), 'the image is not described at all, so its size is invisible');
});

test('the outbound body comes from the adapter, not from a second description', () => {
    /*
     * The point of the report. Built independently it would drift from what is
     * sent, and a preview that is confidently wrong is worse than none.
     */
    const runway = require('../lib/providers/runway');
    const payload = {
        prompt: 'the shadow crosses the road',
        init_image: 'data:image/png;base64,AAAA',
        duration_s: 5,
        target_resolution: '1920x1080',
    };
    const real = runway.buildVideoRequest(payload).body;
    const shown = sanitize(real);

    // Same fields, same values — only the picture is described.
    assert.deepStrictEqual(Object.keys(shown).sort(), Object.keys(real).sort(),
        'the report shows a different set of fields from the request');
    for (const k of Object.keys(real)) {
        if (k === 'promptImage') continue;
        assert.deepStrictEqual(shown[k], real[k], `${k} differs between the report and the request`);
    }
    assert.match(String(shown.promptImage), /KB inline/, 'the picture was printed rather than described');
});

test('a capability with nothing to send says so instead of erroring', () => {
    /*
     * voice and sfx are one-context-to-MANY: a shot with no dialogue produces
     * NO request. Reported as an empty list this surfaced as "cannot read
     * properties of undefined", which is a fault in the report rather than a
     * fact about the shot — and it is the fact that matters.
     */
    const r = describeCapability('voice', {
        project: { id: 'p' }, shot: { id: 's', shot_code: '1A' },
        sceneCard: { shot_code: '1A', description: 'no one speaks', dialogue: [] },
    }, {});
    assert.ok(r.notes.some(n => /no dialogue|NO voice request/i.test(n)),
        `an empty voice run reported: ${JSON.stringify(r.notes)}`);
    assert.ok(!r.notes.some(n => /cannot read propert/i.test(n)),
        'the empty case still surfaces as a crash');
});

test('the LLM is reported as the subscription it is, not a missing builder', () => {
    // Reasoning runs in the connected MCP host. Reporting "no payload builder"
    // reads as something broken rather than as the architecture.
    const r = describeCapability('llm', { project: { id: 'p' } }, {});
    assert.ok(r.notes.some(n => /MCP host|subscription/i.test(n)),
        `the llm row said: ${JSON.stringify(r.notes)}`);
    assert.ok(!r.notes.some(n => /no payload builder/i.test(n)));
});
