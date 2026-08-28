/**
 * An image handed to a provider must be in a form the provider accepts.
 *
 * `promptImage: Invalid input` has blocked EVERY second of footage in this
 * project — zero video usage events, and the two clips that exist were made on
 * Runway's website by hand. The cause is one line:
 *
 *     lib/reference-images.js:97   `data:${mime};base64,${...toString('base64')}`   ✅ plates
 *     lib/capability-payloads.js   initImage = fs.readFileSync(p).toString('base64') ❌ keyframe
 *
 * A bare base64 blob is not a URL, not a data URI and not a `runway://` URI, so
 * the API rejects it. The plates were always correct; the keyframe — the one
 * thing every image-to-video call depends on — never was.
 *
 * NOT the 5MB data-URI cap, which is where the reasoning naturally goes: a real
 * keyframe is 1.51MB, about 2.01MB encoded, comfortably inside it. The bytes
 * were fine and the envelope was missing.
 *
 * Set-based over every site that inlines image bytes, derived from the source,
 * because the failure is per-site: one correct and one wrong is exactly the
 * state that shipped.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '../lib');

/** Every place we turn a file into base64 for a provider. */
function inlineSites() {
    const out = [];
    const walk = dir => {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            if (!name.endsWith('.js')) continue;
            const src = fs.readFileSync(p, 'utf8');
            src.split('\n').forEach((line, i) => {
                if (/\.toString\('base64'\)/.test(line)) {
                    out.push({ file: path.relative(LIB, p), line: i + 1, text: line.trim() });
                }
            });
        }
    };
    walk(LIB);
    return out;
}

test('there are several places that inline image bytes', () => {
    const sites = inlineSites();
    assert.ok(sites.length >= 2,
        `expected more than one base64 inline site, found ${sites.length}`);
});

/**
 * Not every base64 is an image. Exempt BY FILE with the reason, never by
 * pattern — a pattern would excuse the next image site that gets this wrong.
 */
const NOT_AN_IMAGE = Object.freeze({
    'providers/oauth.js': 'base64url for a PKCE verifier — never sent as media',
});

test('the exemptions are real and reasoned', () => {
    for (const [file, why] of Object.entries(NOT_AN_IMAGE)) {
        assert.ok(fs.existsSync(path.join(LIB, file)), `${file} is exempted and does not exist`);
        assert.ok(why.length > 10, `${file} is exempted without a reason`);
    }
});

test('every inlined image is wrapped in a data: URI', () => {
    // The envelope, not the bytes. A provider takes an https URL, a data: URI
    // or a provider-specific handle — never a naked base64 string.
    const bad = inlineSites()
        .filter(s => !NOT_AN_IMAGE[s.file])
        .filter(s => !/data:/.test(s.text));
    assert.deepStrictEqual(bad.map(s => `${s.file}:${s.line}`), [],
        'these hand a provider a bare base64 blob, which it rejects as invalid input: '
        + bad.map(s => `${s.file}:${s.line} — ${s.text}`).join(' | '));
});

test('a real keyframe reaches the payload as a data: URI', () => {
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const payload = buildCapabilityPayload('video', {
        shot: { id: 's', shot_code: '1A' },
        sceneCard: { shot_code: '1A', description: 'a street', camera: {} },
        characters: [], location: null, props: [],
        project: { id: 'p', target_resolution: '1920x1080' },
        initImage: `data:image/png;base64,${png}`,
        overrides: {},
    }).payload;
    assert.match(String(payload.init_image), /^data:image\/\w+;base64,/,
        'the keyframe is not a data URI by the time it reaches the provider');
});

test('the loader builds that data URI, rather than leaving it to a caller', () => {
    // It was the LOADER that stripped the envelope, so the fix belongs there —
    // patching it at one call site would leave the orchestrator and the flow
    // canvas still sending a bare blob.
    const src = fs.readFileSync(path.join(LIB, 'capability-payloads.js'), 'utf8');
    const i = src.indexOf('initImage =');
    assert.ok(i > 0, 'the keyframe is no longer loaded here');
    const near = src.slice(Math.max(0, i - 400), i + 400);
    assert.match(near, /data:/, 'loadShotContext still produces a bare base64 keyframe');
});

test('an image too large for a data URI is refused, with the remedy named', () => {
    // Runway caps a data URI at 5MB encoded. Above that the documented path is
    // the ephemeral upload endpoint. Sending anyway buys a rejection that reads
    // like a credential problem.
    const { DATA_URI_LIMIT, tooLargeForDataUri } = require('../lib/provider-media');
    assert.strictEqual(typeof DATA_URI_LIMIT, 'number');
    assert.ok(DATA_URI_LIMIT >= 4 * 1024 * 1024 && DATA_URI_LIMIT <= 5 * 1024 * 1024,
        `the cap should be about 5MB encoded, got ${DATA_URI_LIMIT}`);
    assert.strictEqual(tooLargeForDataUri('data:image/png;base64,' + 'A'.repeat(10)), false);
    assert.strictEqual(tooLargeForDataUri('data:image/png;base64,' + 'A'.repeat(DATA_URI_LIMIT + 1)), true);
});

test('the adapter says what it would do about an oversize frame', () => {
    const src = fs.readFileSync(path.join(LIB, 'providers/runway.js'), 'utf8');
    assert.match(src, /uploads|ephemeral|too large|DATA_URI_LIMIT/i,
        'the adapter neither uploads a large frame nor says it cannot — it just sends '
        + 'something the API will reject');
});
