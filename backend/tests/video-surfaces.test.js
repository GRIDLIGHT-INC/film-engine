/**
 * A capability with no control is indistinguishable from one that does not exist.
 *
 * The video rate cards, reference contracts, tiers and estimator shipped as
 * LIBRARIES: nothing wrote to film_video_attempts, nothing read VIDEO_TIERS,
 * the estimator had no route, and the reference contract never reached a
 * payload. All of it was correct and all of it was unreachable — the exact
 * failure this codebase has paid for under other names (camera mode built then
 * removed from the page; eight regenerateShot parameters reachable only from
 * curl; previs/apply with no button).
 *
 * Set-based over the capabilities themselves, because the failure is partial:
 * wiring the tier and forgetting the estimate leaves a director choosing
 * "Hero" with no idea what it costs.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(__dirname, '../routes/video-gen.js'), 'utf8');
const PAYLOADS = fs.readFileSync(path.join(__dirname, '../lib/capability-payloads.js'), 'utf8');
const { VIDEO_TIERS } = require('../lib/video-tiers');
const { listTools } = require('../lib/mcp-tools');

/* ── the reference contract has to reach a real request ──────────────── */

function payloadFor(model) {
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const ctx = {
        shot: { id: 's1', shot_code: '2B' },
        sceneCard: { shot_code: '2B', description: 'MAYA beside the sedan', camera: { shot_type: 'wide' } },
        characters: [], location: null, props: [],
        project: { id: 'p1', style_preset: '', target_resolution: '1920x1080' },
        initImage: 'data:image/png;base64,AAAA',
        references: [
            { kind: 'character', name: 'MAYA', uri: 'data:image/png;base64,BBBB', id: 'r1' },
            { kind: 'location', name: 'STREET', uri: 'data:image/png;base64,CCCC', id: 'r2' },
        ],
        overrides: { model },
    };
    return buildCapabilityPayload('video', ctx).payload;
}

test('a reference-taking model actually receives the package, and Gen-4.5 does not', () => {
    // Behavioural, not a grep: the previous version matched on identifier names
    // that survive in comments, so deleting the wiring left it green.
    const h3 = payloadFor('hailuo3');
    assert.ok(Array.isArray(h3.video_references) && h3.video_references.length >= 3,
        'H3 received no reference package — the whole point of adding it');
    assert.ok(h3.video_references.some(r => r.role === 'character' && r.subject === 'MAYA'));

    const g45 = payloadFor('gen4.5');
    assert.strictEqual(g45.video_references, undefined,
        'Gen-4.5 gained references — the keyframe was already generated FROM them');
});

test('Gen-4.5 still sends exactly what it sent before', () => {
    // The golden fixture guards the bytes; this guards the REASON, so nobody
    // later "fixes" the contract by giving Gen-4.5 roles it must not have.
    const ref = require('../lib/video-reference');
    const out = ref.selectReferences([
        { assetId: 'k', role: 'keyframe', sourceType: 'image' },
        { assetId: 'c', role: 'character', subject: 'MAYA', sourceType: 'image' },
        { assetId: 'l', role: 'location', sourceType: 'image' },
    ], ref.contractFor('gen4.5'));
    assert.strictEqual(out.selected.length, 1);
    assert.strictEqual(out.selected[0].role, 'keyframe');
    assert.strictEqual(out.dropped.length, 2, 'what was not sent must be reported');
});

test('a model that takes references actually receives them', () => {
    const ref = require('../lib/video-reference');
    const pack = [
        { assetId: 'k', role: 'keyframe', sourceType: 'image' },
        ...['DRAGON', 'DRAGON', 'DRAGON'].map((s, i) => ({ assetId: 'd' + i, role: 'creature', subject: s, sourceType: 'image' })),
        ...['MAYA', 'MAYA'].map((s, i) => ({ assetId: 'm' + i, role: 'character', subject: s, sourceType: 'image' })),
        { assetId: 'p', role: 'prop', subject: 'SEDAN', sourceType: 'image' },
        ...[0, 1].map(i => ({ assetId: 'loc' + i, role: 'location', sourceType: 'image' })),
    ];
    const out = ref.selectReferences(pack, ref.contractFor('hailuo3'));
    assert.strictEqual(out.selected.length, 9, 'the nine-picture package did not survive selection');
    assert.strictEqual(out.dropped.length, 0);
});

/* ── tiers: selectable from both surfaces ────────────────────────────── */

test('every tier can be chosen from the route and from the page', () => {
    assert.match(ROUTE, /\btier\b/, 'the video route accepts no tier');
    assert.match(ROUTE, /require\('\.\.\/lib\/video-tiers'\)/,
        'the route never loads the tier registry');
    assert.match(ROUTE, /(?:^|[^\w])videoTierOf\s*\(/m,
        'nothing calls the tier resolver on the generation path');
    for (const id of Object.keys(VIDEO_TIERS)) {
        assert.ok(SPA.includes(`"${id}"`) || SPA.includes(`'${id}'`) || SPA.includes(`>${id}<`),
            `tier "${id}" cannot be chosen anywhere on the page`);
    }
    // Bounded to generateVideoFor's own body: the helper existing says nothing
    // about whether the video confirmation actually shows it.
    const i = SPA.indexOf('async function generateVideoFor');
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    assert.match(SPA.slice(i, end), /videoTiers:\s*true/,
        'the video confirmation does not opt into the tier row');
    assert.match(SPA, /data-video-tier=/, 'no control on the page carries a video tier');
});

test('an unknown tier falls back rather than failing a paid action', () => {
    const { resolveVideoTier } = require('../lib/video-tiers');
    assert.strictEqual(resolveVideoTier('nonsense').id, 'production');
    assert.strictEqual(resolveVideoTier(undefined).id, 'production');
});

/* ── the estimate: free, before the money ────────────────────────────── */

test('the free preview carries the cost estimate', () => {
    // Bounded to previewVideo's own body: the generation path also requires the
    // estimator, so a file-wide match stays green when the PREVIEW loses it —
    // and the preview is the half that is free and therefore the half a
    // director actually reads before spending.
    const i = ROUTE.indexOf('async function previewVideo');
    assert.ok(i > 0, 'previewVideo not found');
    let depth = 0, j = ROUTE.indexOf('{', i), end = j;
    for (; j < ROUTE.length; j++) {
        if (ROUTE[j] === '{') depth++;
        else if (ROUTE[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const preview = ROUTE.slice(i, end);
    assert.match(preview, /estimateVideoCost\s*\(/,
        'the free preview does not compute a cost — the director cannot see what the button spends');
    // ...and it must LOAD what it calls: a body that calls an undefined symbol
    // is broken at runtime while every name-match still passes.
    assert.match(preview, /require\('\.\.\/lib\/video-cost'\)/,
        'previewVideo calls estimateVideoCost without loading it');
    assert.match(ROUTE, /\n\s+estimate,/,
        'the estimate is computed and never put on the response');
});

test('the page shows the estimate where the money is spent', () => {
    const i = SPA.indexOf('async function generateVideoFor');
    assert.ok(i > 0, 'generateVideoFor not found');
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const body = SPA.slice(i, end);
    assert.match(body, /estimate|credits|\$/i,
        'the video confirmation never mentions what it costs');
});

test('the estimate is reachable from an agent too', () => {
    const preview = listTools().find(t => t.name === 'video_preview');
    assert.ok(preview, 'video_preview is missing');
    assert.match(String(preview.description), /cost|credit|\$|estimat/i,
        'the agent-facing preview does not say it reports the cost');
});

/* ── every attempt is recorded, or the benchmark never happens ────────── */

test('generating a video records the attempt', () => {
    // The recorder lives in a lib, correctly — so this checks the generation
    // path CALLS it, not that the table name appears in the route.
    assert.match(ROUTE, /(?:^|[^\w])recordVideoAttempt\s*\(/m,
        'nothing records the attempt — the table exists and the router it was built for '
        + 'will have no data to learn from');
});

test('the attempt records the tier, the model, the estimate and the shot shape', () => {
    const lib = fs.readFileSync(path.join(__dirname, '../lib/video-attempt.js'), 'utf8');
    for (const field of ['model', 'tier', 'estimated_credits', 'reference_images',
        'attempt_number', 'shot_type', 'camera_movement'])
        assert.ok(lib.includes(field), `the recorded attempt omits ${field}`);
    // And the call site must actually pass the shape, not just the ids.
    const i = ROUTE.indexOf('recordVideoAttempt');
    const near = ROUTE.slice(i, i + 1200);
    for (const arg of ['tier', 'sceneCard', 'estimatedCredits', 'referenceImages'])
        assert.ok(near.includes(arg), `the call site does not pass ${arg}`);
});

test('recording never throws, because the money is already spent', () => {
    const { recordVideoAttempt } = require('../lib/video-attempt');
    // A broken handle must not turn a paid, successful generation into a failure.
    assert.doesNotThrow(() => recordVideoAttempt(null, { shotId: 'x' }));
    assert.doesNotThrow(() => recordVideoAttempt({ prepare() { throw new Error('boom'); } }, {}));
});

/* ── and the shot can be looked at ───────────────────────────────────── */

test('an agent can see the shot it generated', () => {
    const t = listTools().find(x => x.name === 'shot_review');
    assert.ok(t, 'shot_review is missing');
});
