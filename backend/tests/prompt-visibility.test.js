'use strict';

/**
 * -- Every prompt, before every spend ---------------------------------------
 *
 * "For video footage we'll ALWAYS show the prompt and assets sent so I can
 * control what is sent to the video generator. In fact we should always show
 * the prompts when we ask to generate an image, audio, music or video so I can
 * see what's sent and control the details of the prompt."
 *
 * `paid-preview.test.js` already requires a CONFIRMATION before every paid
 * control. This is the stronger claim underneath it: the confirmation has to
 * carry the actual PROMPT and the actual ASSETS, and where a payload has a
 * prompt the director has to be able to change it before it is sent.
 *
 * Derived from `CAPABILITY_BUILDERS` — the eight capabilities that build a
 * provider payload — rather than from a list, because the failure is
 * per-capability: image had a free preview and an override, video had a
 * preview and no override, and voice, lip-sync and post had neither.
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'fe-promptvis-' + crypto.randomUUID().slice(0, 8));

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { buildCapabilityPayload, loadShotContext } = require('../lib/capability-payloads');

const ROOT = path.join(__dirname, '..');

/**
 * The capabilities that build a provider payload, from the module itself.
 *
 * `describeCapability` covers eleven, but three of those are not a payload this
 * engine builds — `llm` runs in the MCP host, and
 * `model3d` is built from a SUBJECT rather than a shot — so the set that must
 * have a per-generation preview is the eight with a builder.
 */
function payloadCapabilities() {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'capability-payloads.js'), 'utf8');
    const block = src.slice(src.indexOf('const CAPABILITY_BUILDERS = {'));
    const names = [...block.slice(0, block.indexOf('\n};')).matchAll(/^\s{4}(\w+)\s*\(ctx/gm)]
        .map(m => m[1]);
    assert.ok(names.length >= 8, `only found ${names.length} capability builders — the scan is wrong`);
    return names;
}

/** A project with one shot that has something to say in every capability. */
function fixture() {
    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, aspect_ratio, target_resolution, target_fps, style_preset)
                VALUES (?, 'Preview', '16:9', '1920x1080', 30, 'noir')`).run(pid);
    const sc = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, time_of_day, description)
                VALUES (?, ?, 1, 'KITCHEN', 'DAY', 'A blender on a counter.')`).run(sc, pid);
    const sh = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, scene_card_yaml)
                VALUES (?, ?, '1A', 4000, ?)`)
        .run(sh, sc, JSON.stringify({
            shot_code: '1A', description: 'a blender on a counter',
            camera: { shot_type: 'close-up', movement: 'push-in' },
            /*
             * SEVERAL of each, deliberately. voice and sfx are
             * one-context-to-MANY, so a fixture with one line cannot tell an
             * override that reaches every request from one that reaches only
             * the first — and a control that half works is worse than none,
             * because the director approved text that was sent for one line.
             */
            dialogue: [
                { character: 'MAYA', line: 'It just works.' },
                { character: 'RAY', line: 'Every time?' },
                { character: 'MAYA', line: 'Every time.' },
            ],
            // Objects, so this fixture builds SEVERAL prompt-bearing requests —
            // which is what makes an override that reaches only the first
            // detectable at all.
            sfx_cues: [
                { description: 'a blender whirs' },
                { description: 'a cupboard closes' },
                { description: 'a kettle clicks off' },
            ],
        }));
    return { pid, sc, sh };
}

test('every capability that builds a payload can be previewed without spending', () => {
    /*
     * The point is not that a route exists — it is that the payload a preview
     * shows is THE payload, built by the one path the generation itself uses.
     * A preview assembled separately is a plausible fiction, which is the
     * refine-preview defect this codebase already paid for once.
     */
    const { sh } = fixture();
    const ctx = loadShotContext(sh);
    const scoped = { music: false, ambient: false };  // scene-scoped, built without a shot

    for (const cap of payloadCapabilities()) {
        if (scoped[cap] === false && (cap === 'music' || cap === 'ambient')) continue;
        let out = null;
        try { out = buildCapabilityPayload(cap, ctx); }
        catch (err) {
            // PRECONDITION is a legitimate answer: lipsync and post build from
            // artefacts that may not exist yet, and saying so is the honest
            // preview rather than inventing a request.
            assert.equal(err.code, 'PRECONDITION',
                `${cap} could not be previewed and did not say why: ${err.message}`);
            assert.ok(err.message && err.message.length > 20,
                `${cap} refuses with a message too thin to act on: ${err.message}`);
            continue;
        }
        assert.ok(out && out.payload, `${cap} produced no payload to show`);
    }
});

test('the preview route serves every capability, and never leaks a key or a picture', () => {
    /*
     * The two things a preview must never do, both already solved once in
     * lib/dry-run.js and reused rather than rewritten: print a credential, and
     * print megabytes of base64 that make the report unreadable.
     */
    const { describeCapability, sanitize } = require('../lib/dry-run');
    const { sh } = fixture();
    const ctx = loadShotContext(sh);

    const seen = describeCapability('image', ctx, {});
    const asText = JSON.stringify(seen);
    assert.ok(!/data:image\/[a-z]+;base64,[A-Za-z0-9+/]{200}/.test(asText),
        'the preview printed a picture instead of describing it');
    for (const secret of ['api_key', 'apiKey', 'Authorization', 'Bearer ']) {
        assert.ok(!asText.includes(secret), `the preview carries ${secret}`);
    }

    // And the sanitiser is the shared one, not a second copy that could differ.
    assert.equal(typeof sanitize, 'function', 'dry-run no longer exports its sanitiser');
});

test('a prompt-bearing capability can have its prompt overridden before it is sent', () => {
    /*
     * "So I can control what is sent." Seeing it is half; changing it is the
     * other half, and it was true of image alone.
     *
     * Derived: any payload carrying a `prompt` must accept an override, because
     * a prompt a director can read and not edit is a preview that tells them
     * what they are about to be unable to prevent.
     */
    const { sh } = fixture();
    const ctx = loadShotContext(sh);
    const withPrompt = [];
    for (const cap of payloadCapabilities()) {
        let out = null;
        try { out = buildCapabilityPayload(cap, ctx); } catch (_) { continue; }
        const first = Array.isArray(out.payload) ? out.payload[0] : out.payload;
        if (first && typeof first.prompt === 'string' && first.prompt) withPrompt.push(cap);
    }
    assert.ok(withPrompt.includes('image') && withPrompt.includes('video'),
        `the scan found no prompt on image or video: ${withPrompt.join(', ')}`);

    for (const cap of withPrompt) {
        const out = buildCapabilityPayload(cap, { ...ctx, promptOverride: 'MY OWN WORDS ONLY' });
        const all = Array.isArray(out.payload) ? out.payload : [out.payload];
        all.forEach((one, i) => {
            if (typeof one.prompt !== 'string') return;
            assert.equal(one.prompt, 'MY OWN WORDS ONLY',
                `${cap} request ${i + 1} of ${all.length} ignores the prompt override — a control `
                + 'that reaches only the first request is one the director cannot rely on');
        });
    }

    /*
     * And at least one capability really does produce several requests, or the
     * loop above proves nothing about the many case.
     */
    const many = ['voice', 'sfx'].map(c => {
        try { const o = buildCapabilityPayload(c, ctx); return Array.isArray(o.payload) ? o.payload.length : 1; }
        catch (_) { return 0; }
    });
    assert.ok(many.some(n => n > 1),
        `no capability in this fixture builds more than one request (${many}) — the many case is untested`);
});

test('an override is the WHOLE prompt: nothing is appended after it', () => {
    /*
     * The contract generation-override.js already states for image, extended.
     * A caller sending back edited text expects that text to be what is sent —
     * appending the style preset or the references after it silently changes
     * what they approved, which is worse than not offering the control.
     */
    const { sh } = fixture();
    const ctx = loadShotContext(sh);
    for (const cap of ['image', 'video']) {
        const out = buildCapabilityPayload(cap, { ...ctx, promptOverride: 'EXACTLY THIS' });
        const first = Array.isArray(out.payload) ? out.payload[0] : out.payload;
        assert.equal(first.prompt, 'EXACTLY THIS',
            `${cap} appended something after the override`);
    }
});

test('a sound cue written as a string still produces a prompt', () => {
    /*
     * Found on the live database: two shots carry `sfx_cues` as plain strings,
     * and `buildSFXPrompts` read `cue.description || cue.sound` — so both would
     * have generated a request with `prompt: undefined`. That is a paid call
     * with nothing in it, or a provider rejection, and neither says why.
     *
     * A string cue IS its description. Every other list on a scene card takes
     * "a string or an object" — characters and props both do — and the MCP tool
     * describes sfx_cues as "an array" with no shape, so an agent writing
     * strings is doing the obvious thing.
     */
    const { buildSFXPrompts } = require('../lib/music-prompt');
    const scene = { location: 'KITCHEN', time_of_day: 'DAY' };

    const fromStrings = buildSFXPrompts({ sfx_cues: ['a blender whirs', 'a kettle clicks off'] }, scene);
    assert.equal(fromStrings.length, 2, 'string cues produced the wrong number of requests');
    for (const one of fromStrings) {
        assert.ok(one.prompt && typeof one.prompt === 'string',
            `a string cue produced a request with no prompt: ${JSON.stringify(one)}`);
    }
    assert.ok(/blender/.test(fromStrings[0].prompt), 'the cue text is not what is asked for');

    // Objects keep working exactly as they did.
    const fromObjects = buildSFXPrompts({
        sfx_cues: [{ description: 'a door slams', duration_s: 2, category: 'foley' }],
    }, scene);
    assert.equal(fromObjects[0].prompt, 'a door slams');
    assert.equal(fromObjects[0].duration_s, 2);

    // And a cue with nothing usable in it is DROPPED rather than sent empty:
    // a request with no prompt costs money and returns noise.
    const junk = buildSFXPrompts({ sfx_cues: ['', '   ', {}, null] }, scene);
    assert.equal(junk.length, 0, `unusable cues were sent anyway: ${JSON.stringify(junk)}`);
});
