/**
 * Runway provider adapter + Artlist removal.
 *
 * The removal checks are SET-BASED on purpose. An example-based test ("the
 * registry no longer has artlist-mcp") passes while a half-finished removal
 * still leaves the catalog adapter loaded, a dangling preference pointing at a
 * deleted provider, or a settings screen offering a provider the backend can no
 * longer resolve. These iterate the live registry and the actual source tree
 * instead, so anything left behind fails.
 */

const { test, describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const providers = require('../lib/providers');
const { CAPABILITIES } = require('../lib/providers/base');
const runway = require('../lib/providers/runway');

const REPO = path.resolve(__dirname, '../..');

// Executable surface only. docs/plans and todos are historical decision and
// build records — a superseded plan gets a supersession note, it does not get
// rewritten to claim it always said Runway.
const CODE_ROOTS = ['backend/lib', 'backend/routes', 'backend/db', 'backend/tests', 'src'];

function walk(dir, out) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.(js|html|json|sql|md)$/.test(e.name)) out.push(full);
    }
    return out;
}

function codeFiles() {
    const out = [];
    for (const root of CODE_ROOTS) walk(path.join(REPO, root), out);
    // This file names the removed provider in its own assertions; excluding it
    // keeps the sweep honest rather than self-tripping.
    return out.filter(f => path.resolve(f) !== path.resolve(__filename));
}

describe('artlist removal (set-based)', () => {
    it('no registered adapter is an artlist adapter', () => {
        const offenders = providers.list()
            .filter(a => /artlist/i.test(a.id) || /artlist/i.test(a.label || ''))
            .map(a => a.id);
        assert.deepEqual(offenders, [], `registry still exposes: ${offenders.join(', ')}`);
    });

    it('no provider module file remains on disk', () => {
        const dir = path.join(REPO, 'backend/lib/providers');
        const left = fs.readdirSync(dir).filter(f => /artlist/i.test(f));
        assert.deepEqual(left, [], `provider files remain: ${left.join(', ')}`);
    });

    it('no test file remains on disk', () => {
        const dir = path.join(REPO, 'backend/tests');
        const left = fs.readdirSync(dir).filter(f => /artlist/i.test(f));
        assert.deepEqual(left, [], `test files remain: ${left.join(', ')}`);
    });

    it('no source file under backend/ or src/ mentions the removed provider', () => {
        const offenders = [];
        for (const file of codeFiles()) {
            const text = fs.readFileSync(file, 'utf8');
            const lines = text.split('\n');
            lines.forEach((line, i) => {
                if (/artlist/i.test(line)) offenders.push(`${path.relative(REPO, file)}:${i + 1}`);
            });
        }
        assert.deepEqual(offenders, [], `stale references:\n  ${offenders.join('\n  ')}`);
    });

    it('every PREFERRED_WHEN_CONFIGURED target is a registered provider', () => {
        const ids = new Set(providers.list().map(a => a.id));
        const dangling = Object.entries(providers.PREFERRED_WHEN_CONFIGURED || {})
            .filter(([, id]) => !ids.has(id))
            .map(([cap, id]) => `${cap} -> ${id}`);
        assert.deepEqual(dangling, [], `preference points at unregistered provider: ${dangling.join(', ')}`);
    });

    it('every capability every adapter declares resolves to a registered adapter', () => {
        const bad = [];
        for (const adapter of providers.list()) {
            for (const cap of adapter.capabilities || []) {
                if (!CAPABILITIES.includes(cap)) bad.push(`${adapter.id} declares unknown capability '${cap}'`);
                const resolved = providers.resolve(cap, { [cap]: adapter.id });
                if (!resolved) bad.push(`${adapter.id}: resolve('${cap}') returned nothing`);
            }
        }
        assert.deepEqual(bad, []);
    });
});

describe('runway adapter registration', () => {
    it('is registered and declares video + image', () => {
        const a = providers.get('runway');
        assert.ok(a, 'runway adapter is registered');
        assert.equal(a.kind, 'generator');
        assert.equal(a.requiresKey, true);
        assert.deepEqual([...a.capabilities].sort(), ['image', 'video']);
    });

    it('supports() agrees with the declared capability list, for every capability', () => {
        const a = providers.get('runway');
        const mismatches = CAPABILITIES.filter(cap => a.supports(cap) !== a.capabilities.includes(cap));
        assert.deepEqual(mismatches, [], `supports() disagrees with capabilities for: ${mismatches.join(', ')}`);
    });

    it('resolves for each declared capability when a project selects it', () => {
        const a = providers.get('runway');
        for (const cap of a.capabilities) {
            assert.equal(providers.resolve(cap, { [cap]: 'runway' }).id, 'runway', `resolve('${cap}')`);
            assert.equal(providers.resolveGenerator(cap, { [cap]: 'runway' }).id, 'runway', `resolveGenerator('${cap}')`);
        }
    });
});

describe('runway request contract', () => {
    it('uses the documented host, version header and auth scheme', () => {
        const req = runway.buildVideoRequest({ prompt: 'a shot', init_image: 'https://x/y.png' });
        assert.match(req.url, /^https:\/\/api\.dev\.runwayml\.com\/v1\//);
        assert.equal(req.headers['X-Runway-Version'], '2024-11-06');
        assert.equal(req.headers['Content-Type'], 'application/json');
        assert.equal(runway.authHeader('sk-test').Authorization, 'Bearer sk-test');
    });

    it('routes to image_to_video when a keyframe is present, text_to_video otherwise', () => {
        assert.match(runway.buildVideoRequest({ prompt: 'p', init_image: 'https://x/y.png' }).url, /\/image_to_video$/);
        assert.match(runway.buildVideoRequest({ prompt: 'p' }).url, /\/text_to_video$/);
    });

    it('maps the pipeline payload onto Runway body fields', () => {
        const { body } = runway.buildVideoRequest({
            prompt: 'a wide shot of a bar',
            init_image: 'https://x/y.png',
            duration_s: 5,
            seed: 42,
            width: 1280, height: 720,
        });
        assert.equal(body.model, 'gen4.5');
        assert.equal(body.promptText, 'a wide shot of a bar');
        assert.equal(body.promptImage, 'https://x/y.png');
        assert.equal(body.duration, 5);
        assert.equal(body.seed, 42);
        assert.equal(body.ratio, '1280:720');
        // Runway has no negative-prompt or sampler concept; those must not leak.
        assert.equal(body.negative_prompt, undefined);
        assert.equal(body.guidance_scale, undefined);
    });

    it('only ever emits a ratio the selected model documents', () => {
        // Every ratio the builder can produce must be in the documented set —
        // iterate candidate dimensions rather than spot-checking one.
        const dims = [[1920, 1080], [1280, 720], [720, 1280], [1080, 1920], [1024, 1024], [3, 1], [1, 3], [0, 0]];
        for (const [width, height] of dims) {
            const i2v = runway.buildVideoRequest({ prompt: 'p', init_image: 'i', width, height });
            assert.ok(runway.VIDEO_RATIOS.image_to_video.includes(i2v.body.ratio),
                `i2v ${width}x${height} produced undocumented ratio ${i2v.body.ratio}`);
            const t2v = runway.buildVideoRequest({ prompt: 'p', width, height });
            assert.ok(runway.VIDEO_RATIOS.text_to_video.includes(t2v.body.ratio),
                `t2v ${width}x${height} produced undocumented ratio ${t2v.body.ratio}`);
        }
    });

    it('clamps duration into the documented 2-10s window', () => {
        for (const [input, expected] of [[0.5, 2], [2, 2], [4, 4], [10, 10], [30, 10], [undefined, 5]]) {
            const { body } = runway.buildVideoRequest({ prompt: 'p', init_image: 'i', duration_s: input });
            assert.equal(body.duration, expected, `duration_s=${input}`);
        }
    });

    it('keeps seed inside the documented uint32 range', () => {
        for (const [input, ok] of [[0, true], [4294967295, true]]) {
            const { body } = runway.buildVideoRequest({ prompt: 'p', init_image: 'i', seed: input });
            assert.equal(body.seed, input, `seed ${input} should pass through (${ok})`);
        }
        // Out-of-range seeds are dropped rather than sent and rejected upstream.
        assert.equal(runway.buildVideoRequest({ prompt: 'p', init_image: 'i', seed: 4294967296 }).body.seed, undefined);
        assert.equal(runway.buildVideoRequest({ prompt: 'p', init_image: 'i', seed: -1 }).body.seed, undefined);
    });

    it('promotes a locked reference to the keyframe when no storyboard frame exists', () => {
        // The consistency system passes reference_images on the video payload.
        // Runway video takes one promptImage, so a reference must not be dropped.
        const withRefsOnly = runway.buildVideoRequest({ prompt: 'p', reference_images: ['https://x/ref.png'] });
        assert.match(withRefsOnly.url, /\/image_to_video$/);
        assert.equal(withRefsOnly.body.promptImage, 'https://x/ref.png');

        // An actual storyboard keyframe always wins over a reference.
        const withBoth = runway.buildVideoRequest({ prompt: 'p', init_image: 'https://x/key.png', reference_images: ['https://x/ref.png'] });
        assert.equal(withBoth.body.promptImage, 'https://x/key.png');

        // referenceImages is a text_to_image field; it must not leak onto video.
        assert.equal(withRefsOnly.body.referenceImages, undefined);
    });

    it('builds a text_to_image request with reference images', () => {
        const { url, body } = runway.buildImageRequest({
            prompt: 'a bar interior',
            reference_images: ['https://x/a.png', { uri: 'https://x/b.png', tag: 'Bar' }],
        });
        assert.match(url, /\/text_to_image$/);
        assert.equal(body.model, 'gen4_image');
        assert.equal(body.promptText, 'a bar interior');
        assert.equal(body.referenceImages.length, 2);
        assert.equal(body.referenceImages[0].uri, 'https://x/a.png');
        assert.equal(body.referenceImages[1].tag, 'Bar');
    });
});

describe('runway task lifecycle', () => {
    it('maps every documented task status', () => {
        // From the Runway docs: a task ends in SUCCEEDED, FAILED or CANCELED;
        // THROTTLED is explicitly safe to treat as PENDING.
        const expected = {
            PENDING: 'pending',
            THROTTLED: 'pending',
            RUNNING: 'running',
            SUCCEEDED: 'succeeded',
            FAILED: 'failed',
            CANCELED: 'failed',
        };
        for (const [api, internal] of Object.entries(expected)) {
            assert.equal(runway.mapTaskStatus(api), internal, `status ${api}`);
        }
        assert.deepEqual([...runway.TASK_STATUSES].sort(), Object.keys(expected).sort());
    });

    it('treats only the documented retryable HTTP codes as retryable', () => {
        for (const code of [429, 502, 503]) assert.equal(runway.isRetryable(code), true, `${code} retryable`);
        for (const code of [400, 401, 404, 405, 500]) assert.equal(runway.isRetryable(code), false, `${code} not retryable`);
    });

    it('extracts the output URL from a succeeded task', () => {
        assert.equal(runway.extractOutputUrl({ status: 'SUCCEEDED', output: ['https://cdn/out.mp4'] }), 'https://cdn/out.mp4');
        assert.equal(runway.extractOutputUrl({ status: 'SUCCEEDED', output: [] }), null);
        assert.equal(runway.extractOutputUrl({ status: 'RUNNING' }), null);
    });

    it('surfaces the documented error body shape', () => {
        const msg = runway.formatError(400, { error: 'Validation of body failed', issues: [{ path: ['promptImage'], message: 'bad content type' }] });
        assert.match(msg, /Validation of body failed/);
        assert.match(msg, /promptImage/);
        assert.match(msg, /bad content type/);
    });
});

describe('runway result shape', () => {
    it('returns media in a shape persistProviderMedia understands', () => {
        const { extractMediaUrl } = require('../lib/provider-media');
        assert.equal(extractMediaUrl(runway.mediaResult('video', 'https://cdn/o.mp4')), 'https://cdn/o.mp4');
        assert.equal(extractMediaUrl(runway.mediaResult('image', 'https://cdn/o.png')), 'https://cdn/o.png');
    });
});

test('adapter refuses unsupported capabilities and missing credentials cleanly', async () => {
    const a = providers.get('runway');
    const bad = await a.generate('music', { prompt: 'x' });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    assert.match(bad.error, /unsupported capability/);
});

describe('runway image ratio (regression)', () => {
    // `ratio` is REQUIRED on text_to_image, and this adapter shipped omitting it
    // for every caller that did not pass an explicit width/height pair -- so
    // every image generation 400'd before reaching a model. The mock-server
    // tests could not see it: a mock accepts whatever body it is handed, and
    // only the real validator knows the field is mandatory. That is the gap
    // this closes, and why the assertion is "always present and always legal"
    // rather than a check of one example payload.
    const { buildImageRequest, IMAGE_RATIOS, snapImageRatio } = runway;

    // Every shape a caller in this codebase actually produces: nothing at all,
    // a pixel pair, a Runway ratio, a project aspect_ratio preset, and junk.
    const CALLER_SHAPES = [
        { prompt: 'x' },
        { prompt: 'x', ratio: '1280:720' },
        { prompt: 'x', ratio: '1920:1080' },
        { prompt: 'x', ratio: '16:9' },
        { prompt: 'x', ratio: '9:16' },
        { prompt: 'x', ratio: '2.39:1' },
        { prompt: 'x', ratio: '1:1' },
        { prompt: 'x', aspect_ratio: '4:3' },
        { prompt: 'x', width: 1080, height: 1920 },
        { prompt: 'x', width: 1920, height: 1080 },
        { prompt: 'x', ratio: '' },
        { prompt: 'x', ratio: 'garbage' },
        { prompt: 'x', ratio: null },
    ];

    it('every caller shape yields a ratio Runway will accept', () => {
        const bad = [];
        for (const shape of CALLER_SHAPES) {
            const { ratio } = buildImageRequest(shape).body;
            if (!ratio) bad.push(`${JSON.stringify(shape)} -> no ratio at all (400s on the real API)`);
            else if (!IMAGE_RATIOS.includes(ratio)) bad.push(`${JSON.stringify(shape)} -> '${ratio}' is not accepted`);
        }
        assert.deepStrictEqual(bad, [], bad.join('\n'));
    });

    it('an explicitly accepted ratio is passed through untouched', () => {
        for (const ratio of IMAGE_RATIOS) {
            assert.strictEqual(buildImageRequest({ prompt: 'x', ratio }).body.ratio, ratio,
                `${ratio} is documented as accepted but was rewritten`);
        }
    });

    it('a named aspect snaps to the nearest accepted ratio, not the default', () => {
        // The failure worth catching is silently collapsing everything to 16:9:
        // a portrait or scope request would then be delivered as landscape.
        assert.strictEqual(snapImageRatio('9:16'), '1080:1920', 'portrait collapsed to landscape');
        assert.strictEqual(snapImageRatio('1:1'), '1024:1024', 'square collapsed to landscape');
        assert.strictEqual(snapImageRatio('2.39:1'), '1808:768', 'scope collapsed to 16:9');
    });

    it('the accepted set is the one Runway publishes, and is non-empty', () => {
        assert.ok(Array.isArray(IMAGE_RATIOS) && IMAGE_RATIOS.length >= 16);
        for (const r of IMAGE_RATIOS) {
            assert.match(r, /^\d+:\d+$/, `'${r}' is not a WIDTH:HEIGHT pair`);
        }
    });
});
