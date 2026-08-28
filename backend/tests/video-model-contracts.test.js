/**
 * What a video model costs, what references it will take, and which tier picks it.
 *
 * The registry described Seedance 2.0 under a name the whole discussion was
 * reading as 2.5, and Runway exposes BOTH as distinct models. It also had no
 * hailuo3 — which matters more than a missing id, because H3 charges 2 credits
 * per reference IMAGE, making a nine-reference package cost $0.18 and the whole
 * shot cheaper than Gen-4.5 with no references at all.
 *
 * Set-based over the model registry, because the failure is per model: billing
 * metadata present on eight of eleven reads as complete and silently prices the
 * other three at zero.
 *
 * The load-bearing invariant is at the bottom: Gen-4.5 keeps its keyframe-only
 * payload byte-for-byte. Sending plates to an image-to-video model was removed
 * deliberately — the keyframe was already generated FROM them — and adding a
 * reference contract must not quietly revert that.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const runway = require('../lib/providers/runway');
const videoRef = () => require('../lib/video-reference');
const tiers = () => require('../lib/video-tiers');
const cost = () => require('../lib/video-cost');
const MODELS = runway.RUNWAY_VIDEO_MODELS;

/* ── A. every model declares complete billing metadata ───────────────── */

/** What a model must say about money before anything may be estimated from it. */
const BILLING_FIELDS = ['creditsPerSecond', 'imageReferenceCredits',
    'videoReferenceCreditsPerSecond', 'audioReferenceCredits', 'minimumCredits'];

test('the registry carries both Seedance generations and hailuo3', () => {
    // Runway exposes Seedance 2.0 and 2.5 as separate models with different
    // rates. Renaming 2.0 would have silently repriced every existing estimate.
    for (const id of ['seedance2', 'seedance2_5', 'hailuo3'])
        assert.ok(MODELS[id], `${id} is not in RUNWAY_VIDEO_MODELS`);
    assert.strictEqual(MODELS.seedance2.creditsPerSecond, 36,
        'Seedance 2.0 was repriced — its published rate is 36 cr/s at 480/720p');
});

test('every video model declares every billing field', () => {
    const ids = Object.keys(MODELS);
    assert.ok(ids.length >= 11, `expected the registry to have grown, got ${ids.length}`);
    for (const id of ids) {
        for (const field of BILLING_FIELDS) {
            assert.strictEqual(typeof MODELS[id][field], 'number',
                `${id} does not declare ${field} — it would be priced as free`);
            assert.ok(MODELS[id][field] >= 0, `${id}.${field} is negative`);
        }
        assert.ok(MODELS[id].source, `${id} has no source URL — an unre-checkable rate decays into a lie`);
    }
});

test('a model priced per resolution says so, and every tier has a rate', () => {
    for (const [id, m] of Object.entries(MODELS)) {
        if (!m.resolutions) continue;
        for (const [label, rate] of Object.entries(m.resolutions)) {
            assert.strictEqual(typeof rate.creditsPerSecond, 'number',
                `${id} resolution ${label} has no rate`);
        }
    }
    // The two that Runway documents per resolution.
    assert.ok(MODELS.hailuo3.resolutions, 'hailuo3 is priced per resolution (768P / 2K)');
    assert.ok(MODELS.seedance2_5.resolutions, 'seedance2_5 is priced per resolution');
});

/* ── B. every model declares what references it will take ────────────── */


test('every model has a reference contract naming its roles and limits', () => {
    for (const id of Object.keys(MODELS)) {
        const c = videoRef().contractFor(id);
        assert.ok(c, `${id} has no reference contract`);
        assert.ok(Array.isArray(c.roles), `${id} contract declares no roles`);
        for (const cap of ['maxImages', 'maxVideos', 'maxAudio'])
            assert.strictEqual(typeof c[cap], 'number', `${id} contract has no ${cap}`);
        assert.ok(c.why, `${id} contract states no reason — an undocumented limit is a guess`);
    }
});

test('Gen-4.5 stays keyframe-only, which is the decision being protected', () => {
    const c = videoRef().contractFor('gen4.5');
    assert.deepStrictEqual(c.roles, ['keyframe'],
        'Gen-4.5 gained reference roles — the keyframe was already generated FROM the plates, '
        + 'and re-sending them asks the model which picture is the truth');
    assert.strictEqual(c.maxImages, 1);
});

test('hailuo3 and seedance2_5 take role-addressed packages', () => {
    const h3 = videoRef().contractFor('hailuo3');
    assert.ok(h3.maxImages >= 9, `hailuo3 should take a real package, got ${h3.maxImages}`);
    assert.ok(h3.roles.includes('character') && h3.roles.includes('location'));
    const sd = videoRef().contractFor('seedance2_5');
    assert.ok(sd.maxImages >= 30, `seedance 2.5 documents 30 images, contract says ${sd.maxImages}`);
    assert.ok(sd.maxVideos >= 10 && sd.maxAudio >= 10);
});

test('a reference is semantic, and unknown roles are refused not silently dropped', () => {
    assert.ok(videoRef().ROLES.length >= 7, 'the role vocabulary is too small to describe a shot');
    for (const role of ['keyframe', 'character', 'creature', 'prop', 'location', 'style', 'motion', 'audio'])
        assert.ok(videoRef().ROLES.includes(role), `role ${role} is missing`);
    const out = videoRef().selectReferences([
        { assetId: 'a', role: 'character', subject: 'MAYA', sourceType: 'image' },
        { assetId: 'b', role: 'nonsense', sourceType: 'image' },
    ], videoRef().contractFor('hailuo3'));
    assert.strictEqual(out.selected.length, 1);
    assert.ok(out.dropped.some(d => /nonsense/.test(d.reason || d.role || '')),
        'an unusable reference must be reported, not dropped in silence');
});

test('selection trims to the contract and reports what did not fit', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
        ({ assetId: 'x' + i, role: 'character', subject: 'S' + i, sourceType: 'image' }));
    const out = videoRef().selectReferences(many, videoRef().contractFor('hailuo3'));
    assert.ok(out.selected.length <= videoRef().contractFor('hailuo3').maxImages);
    assert.ok(out.dropped.length > 0, 'over-budget references vanished without a word');
});

/* ── C. tiers are policy, not model aliases ──────────────────────────── */


test('every tier is a policy and resolves to a known model or an explicit null', () => {
    const ids = Object.keys(tiers().VIDEO_TIERS);
    assert.deepStrictEqual(ids, ['draft', 'production', 'hero']);
    for (const id of ids) {
        const t = tiers().VIDEO_TIERS[id];
        assert.ok(t.label && t.why, `tier ${id} has no label/why`);
        assert.strictEqual(typeof t.maxAttempts, 'number', `tier ${id} sets no attempt ceiling`);
        assert.ok('preferredModel' in t, `tier ${id} does not state a preferred model (null is allowed)`);
        if (t.preferredModel !== null)
            assert.ok(MODELS[t.preferredModel], `tier ${id} prefers unknown model ${t.preferredModel}`);
    }
    assert.strictEqual(tiers().VIDEO_TIERS.draft.preferredModel, 'gen4_turbo',
        'the cheap blocking pass should be Gen-4 Turbo at 5 cr/s');
    assert.strictEqual(tiers().VIDEO_TIERS.production.preferredModel, 'hailuo3');
    assert.strictEqual(tiers().VIDEO_TIERS.hero.preferredModel, null,
        'hero must stay a router/user decision rather than a hardcoded model');
});

/* ── D. the estimate, computed locally and matching the published rates ─ */


test('the estimator prices every model in the registry', () => {
    for (const id of Object.keys(MODELS)) {
        const e = cost().estimateVideoCost({ model: id, durationSeconds: 5 });
        assert.ok(Number.isFinite(e.credits) && e.credits > 0, `${id} priced at ${e.credits}`);
        assert.ok(Number.isFinite(e.usd) && e.usd > 0, `${id} has no dollar figure`);
        assert.ok(Array.isArray(e.lines) && e.lines.length,
            `${id} produced no breakdown — a total with no lines cannot be checked`);
    }
});

test('the published arithmetic comes out exactly', () => {
    // Runway: credits are $0.01. Gen-4 Turbo 5 cr/s; hailuo3 768P 10 cr/s
    // +2 cr per reference image; Gen-4.5 12 cr/s.
    const draft = cost().estimateVideoCost({ model: 'gen4_turbo', durationSeconds: 5 });
    assert.strictEqual(draft.credits, 25);
    assert.strictEqual(Number(draft.usd.toFixed(2)), 0.25);

    const h3 = cost().estimateVideoCost({
        model: 'hailuo3', durationSeconds: 10, resolution: '768P', imageReferences: 9,
    });
    assert.strictEqual(h3.credits, 118, '10s at 10 cr/s plus 9 images at 2 cr should be 118');
    assert.strictEqual(Number(h3.usd.toFixed(2)), 1.18);

    const g45 = cost().estimateVideoCost({ model: 'gen4.5', durationSeconds: 10 });
    assert.strictEqual(g45.credits, 120);
    assert.ok(h3.credits < g45.credits,
        'H3 with nine references should undercut Gen-4.5 with none — that is the whole argument');
});

test('a minimum charge is applied, and named in the breakdown', () => {
    // Seedance 2.5 has an 80-credit minimum, so a short clip bills as longer.
    const short = cost().estimateVideoCost({ model: 'seedance2_5', durationSeconds: 2, resolution: '720p' });
    assert.ok(short.credits >= 80, `a 2s Seedance 2.5 clip billed ${short.credits}, below its 80 minimum`);
    assert.ok(short.lines.some(l => /minimum/i.test(l.label)),
        'the minimum was applied without saying so');
});

test('reference VIDEO is billed per second and reference images are not', () => {
    const base = cost().estimateVideoCost({ model: 'seedance2_5', durationSeconds: 10, resolution: '720p' });
    const withStills = cost().estimateVideoCost({
        model: 'seedance2_5', durationSeconds: 10, resolution: '720p', imageReferences: 20,
    });
    const withClip = cost().estimateVideoCost({
        model: 'seedance2_5', durationSeconds: 10, resolution: '720p', videoReferenceSeconds: 10,
    });
    assert.strictEqual(withStills.credits, base.credits,
        'Seedance 2.5 image references are free and were charged for');
    assert.ok(withClip.credits > base.credits,
        'a reference VIDEO is billed at half the output rate and was charged as free — '
        + 'the trap that makes reference-heavy estimates low by a multiple');
});

/* ── E. the model can see a picture ──────────────────────────────────── */

test('an MCP tool result can carry images, not only text', () => {
    const server = require('../mcp-server.js');
    assert.strictEqual(typeof server.toolResult, 'function',
        'mcp-server should expose how it builds a tool result, so it can be tested');
    const out = server.toolResult({
        _status: 200,
        body: { note: 'two frames', images: [
            { data_uri: 'data:image/png;base64,iVBORw0KGgo=', label: 'storyboard' },
        ] },
    });
    const kinds = out.content.map(c => c.type);
    assert.ok(kinds.includes('image'),
        'a result carrying images produced text only — the model cannot see the shot it made');
    const img = out.content.find(c => c.type === 'image');
    assert.strictEqual(img.mimeType, 'image/png');
    assert.ok(!/^data:/.test(img.data), 'the base64 must be bare, not a data: URI');
    assert.ok(kinds.includes('text'), 'the text body must survive alongside the pictures');
});

test('a result with no images is byte-identical to before', () => {
    const server = require('../mcp-server.js');
    const out = server.toolResult({ _status: 200, body: { ok: true } });
    assert.deepStrictEqual(out.content.map(c => c.type), ['text']);
});

test('there is a tool that hands over the frames to compare', () => {
    const { listTools } = require('../lib/mcp-tools');
    // Named for the job, not the data: `shot_frames` already exists and lists
    // version METADATA. This one hands over the pictures.
    const t = listTools().find(x => x.name === 'shot_review');
    assert.ok(t, 'no shot_review tool — validation has nothing to look at');
    assert.ok(listTools().find(x => x.name === 'shot_frames'),
        'the existing version-listing tool was renamed away');
    assert.match(String(t.description), /storyboard|frame/i);
});

/* ── F. every attempt is recorded, or the router never gets its data ──── */

test('a generation attempt records what the router will need', () => {
    const migrations = fs.readdirSync(path.join(__dirname, '../db/migrations'));
    const file = migrations.find(f => /video_attempt/.test(f));
    assert.ok(file, 'no migration creates the attempts table');
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8');
    for (const col of ['shot_id', 'provider', 'model', 'tier', 'duration', 'resolution',
        'reference_images', 'reference_videos', 'estimated_credits', 'actual_credits',
        'attempt_number', 'accepted', 'rejection_reason', 'validation_score'])
        assert.match(sql, new RegExp(`\\b${col}\\b`), `the attempts table has no ${col}`);
});
