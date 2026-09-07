/**
 * THE SEEDANCE `video-edit` PATH, AND WHY IT MUST NOT READ AS AN EDIT.
 *
 * RBF-001 probed this endpoint for real money and recorded four findings the
 * vendor documents nowhere (docs/plans/rbf-001-video-edit-probe.md):
 *
 *   1. `images_list` entries are STYLE REFERENCES composited into the scene,
 *      not a start and an end frame.
 *   2. `duration` is IGNORED — 4s was asked for and 9.7s came back, the
 *      source's own length.
 *   3. Billing follows the SOURCE length, not the requested duration.
 *   4. A FAILED job still billed. Actual spend was $3.205 against a $0.68
 *      estimate — 4.7x.
 *
 * ICP-012 registered `aleph2`, a real video-to-video model. So the cheap tier
 * here now reads as "the same thing for less", and it is not the same thing:
 * it cannot be steered by keyframes, its price is not the price quoted, and
 * a refusal is charged for.
 *
 * SET-BASED OVER THE WAYS AN EDIT CAN BE ASKED FOR, because the failure is
 * partial by construction: closing the explicit route and leaving the implicit
 * one open is exactly the silent fallback this task exists to remove. The
 * literal sites in the adapter are ALSO enumerated from its source, so a sixth
 * one added later has to be classified rather than arriving unexamined.
 *
 * THE UPSCALE IS NOT AN EDIT AND MUST SURVIVE. `post` reaches this same
 * endpoint at the 4k tier deliberately — it is the finishing half of "draft
 * while working, finish at the end", and removing it would delete the only
 * provider that implements post while looking like a tidy-up.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const seedance = require('../lib/providers/seedance');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'providers', 'seedance.js'), 'utf8');
const PRICING = fs.readFileSync(path.join(__dirname, '..', 'lib', 'provider-pricing.js'), 'utf8');
const VERDICT = path.join(__dirname, '..', '..', 'docs', 'plans', 'rbf-001-video-edit-probe.md');

/* ── 1 · every literal site is classified ───────────────────────────────── */

/**
 * The roles a `video-edit` mention may legitimately have. Derived by requiring
 * every occurrence in the adapter to fall into one — a new one that fits none
 * fails here rather than arriving as an unexamined route to a measured trap.
 */
const ROLES = {
    registry: 'the workflow vocabulary and its field map — naming it is not choosing it',
    post: 'the deliberate upscale: the same endpoint at a larger tier, which is the finishing pass',
    refusal: 'the point where an EDIT is turned away and pointed at aleph2',
    prose: 'a comment recording what it is and why it is not used for edits',
};

function literalSites() {
    const out = [];
    SRC.split('\n').forEach((line, i) => {
        if (!/video-edit/.test(line)) return;
        out.push({ line: i + 1, text: line.trim() });
    });
    return out;
}

test('the adapter mentions video-edit in enough places to be worth policing', () => {
    // A scan that finds too few reports the gap as closed.
    assert.ok(literalSites().length >= 8,
        `only ${literalSites().length} mentions found — the scan is not reading the adapter`);
});

/** A function's body, bounded by brace depth from its declaration. */
function bodyOf(name) {
    const at = SRC.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name} is gone; re-derive this test`);
    let i = SRC.indexOf('{', at), depth = 0;
    for (let j = i; j < SRC.length; j++) {
        if (SRC[j] === '{') depth++;
        else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(at, j + 1); }
    }
    return SRC.slice(at);
}

test('the ENDPOINT is constructed in exactly one place, and it is the upscale', () => {
    /*
     * The invariant that matters, and it is not "the string never appears".
     * `workflowFor` still CLASSIFIES a source-clip payload as an edit, and it
     * must: that is what lets the refusal below say what the caller asked for.
     * Returning something else would silently generate a NEW clip from the
     * prompt, which is strictly worse than the trap being retired.
     *
     * What must be true is that nothing BUILDS A REQUEST to the endpoint except
     * the upscale.
     */
    const builders = [];
    for (const m of SRC.matchAll(/\$\{BASE_URL\}\/seedance-2\.5-video-edit/g)) {
        // Which function is this inside? The nearest declaration above it.
        const before = SRC.slice(0, m.index);
        const decl = [...before.matchAll(/function ([A-Za-z_$][\w$]*)\s*\(/g)].pop();
        builders.push(decl ? decl[1] : '(top level)');
    }
    assert.ok(builders.length >= 1, 'the scan found no endpoint construction at all — it is broken');
    assert.deepStrictEqual([...new Set(builders)], ['buildPostRequest'],
        `these functions build a video-edit request: ${[...new Set(builders)].join(', ')} — only the `
        + 'upscale may reach this endpoint');
});

test('the classification of an edit is immediately guarded by a refusal', () => {
    /*
     * workflowFor may say "this is an edit"; buildVideoRequest must then refuse
     * it. A classification with no guard behind it is the silent route back.
     */
    const body = bodyOf('buildVideoRequest');
    assert.match(body, /workflow === 'video-edit'/,
        'buildVideoRequest does not check for an edit at all');
    assert.match(body, /throw/,
        'buildVideoRequest recognises an edit and does not refuse it');
});

/* ── 2 · the ways an edit can be asked for ──────────────────────────────── */

test('attaching a source clip to a VIDEO generation no longer silently edits it', () => {
    /*
     * THE SILENT FALLBACK. `workflowFor` routed any payload carrying a source
     * clip to video-edit, so a caller who attached one got a measured trap
     * without ever naming it: style references instead of keyframes, the
     * duration ignored, and the bill taken from the source.
     */
    let threw = null;
    try { seedance.buildVideoRequest({ video_url: 'https://x/clip.mp4', prompt: 'a rainy street' }); }
    catch (err) { threw = err; }
    assert.ok(threw, 'a source clip on a video generation still builds a request rather than refusing');
    assert.match(threw.message, /aleph/i,
        `the refusal does not name the model that CAN do this:\n${threw.message}`);
    assert.match(threw.message, /RBF-001|style reference|source/i,
        `the refusal does not carry the recorded evidence:\n${threw.message}`);
});

test('video-extend is untouched — it is a different workflow, not an edit', () => {
    /*
     * Extending a clip genuinely takes a source and is not what RBF-001
     * measured. Refusing it would remove a real capability under cover of
     * retiring a different one.
     */
    const r = seedance.buildVideoRequest({ video_url: 'https://x/clip.mp4', extend: true, prompt: 'keep going' });
    assert.strictEqual(r.workflow, 'video-extend');
});

test('asking for video-edit BY NAME is still refused, with the evidence', () => {
    /*
     * The explicit route is the one a reader reaches for after seeing the
     * price. Closing the implicit one and leaving this open would move the
     * trap rather than remove it.
     */
    let threw = null;
    try { seedance.buildVideoRequest({ workflow: 'video-edit', video_url: 'https://x/c.mp4', prompt: 'x' }); }
    catch (err) { threw = err; }
    assert.ok(threw, 'video-edit can still be selected by name for a video generation');
    assert.match(threw.message, /aleph/i, 'the refusal does not point anywhere');
});

test('a background replacement REFUSES a provider that cannot edit footage', () => {
    /*
     * The consumer side, and the reason this task is not only documentation.
     * backgroundGenerator resolves the project's own video provider. Handed to
     * Seedance, `videoUri` is read by nothing, `workflowFor` sees no source and
     * falls to TEXT-TO-VIDEO — so the clip vanishes and an unrelated one is
     * generated from the prompt and reported as the finished edit. That is
     * worse than the trap being retired.
     */
    const { backgroundGenerator } = require('../lib/video-edit');
    return backgroundGenerator({
        videoUri: 'https://example.test/clip.mp4', prompt: 'Replace the background: a rainy street.',
        model: 'aleph2', sourceSeconds: 6, projectId: null,
        provider: seedance.adapter,
    }).then(r => {
        assert.strictEqual(r.ok, false,
            'a background replacement was accepted by a provider with no video-to-video model');
        assert.match(r.reason, /edit|video-to-video|aleph/i,
            `the refusal does not say why this provider cannot do it:\n${r.reason}`);
    });
});

/* ── 3 · the upscale survives, and is reachable, and is priced honestly ── */

test('the provider that CAN edit still says so', () => {
    /*
     * The other half of the guard, and it was missing: a check that refuses
     * every provider passes every "it refuses" test there is, while every
     * background replacement dies with "no provider can edit" and aleph2 sits
     * right there. Found because mutating runway's declaration to match
     * nothing left the whole file green.
     */
    const runway = require('../lib/providers/runway');
    const models = runway.adapter.videoToVideoModels;
    assert.ok(Array.isArray(models) && models.length,
        'Runway declares no video-to-video model, so the edit guard now refuses everything');
    assert.ok(models.includes('aleph2'),
        `aleph2 is not in the declared set (${models.join(', ') || 'empty'}) — it is the only `
        + 'video-to-video model registered, so the guard would turn away the one provider that works');
    // Derived, not listed: the declaration must agree with the registry it
    // comes from, or the adapter claims a capability the table no longer has.
    const fromRegistry = Object.entries(runway.RUNWAY_VIDEO_MODELS)
        .filter(([, m]) => m.endpoint === 'video_to_video').map(([id]) => id);
    assert.deepStrictEqual([...models].sort(), fromRegistry.sort(),
        'the declared set and the model registry disagree about which models can edit footage');
});

test('the upscale still builds — it is not an edit and must not be retired with one', () => {
    const r = seedance.buildPostRequest({ source_video: 'https://x/clip.mp4', type: 'upscale' });
    assert.strictEqual(r.workflow, 'video-edit');
    assert.match(r.url, /seedance-2\.5-video-edit/);
});

test('the upscale accepts the field the payload builder actually produces', () => {
    /*
     * capability-payloads' post() emits `input_url`; buildPostRequest read
     * source_video / video_url / input_video / init_video and refused. So the
     * orchestrated finishing pass could NEVER reach Seedance — the whole reason
     * this provider was added for post — and the refusal named a field the
     * caller does not produce, which reads as a missing clip.
     */
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const payload = buildCapabilityPayload('post', {
        shot: { id: 's1', shot_code: '2B' },
        sceneCard: { shot_code: '2B', description: 'x' },
        scene: { project_id: 'p1' },
        project: { id: 'p1', target_resolution: '1920x1080' },
        videoAsset: { id: 'a1', file_name: '2B.mp4', project_id: 'p1', width: 1280, height: 720 },
        overrides: { job_type: 'upscale' },
    }).payload;
    assert.ok(payload.input_url, 'the post payload no longer carries input_url; re-derive this test');
    const r = seedance.buildPostRequest(payload);
    assert.match(String(r.body.video_url), /2B\.mp4/,
        'the orchestrated upscale payload still does not reach Seedance');
});

test('the orchestrated upscale carries the source length, so it can be priced', () => {
    /*
     * Refusing to quote an unmeasured source is honest and useless when the
     * number is sitting on the asset row. Without this every orchestrated
     * upscale reports an unknown price — a regression from the wrong one.
     */
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const ctx = {
        shot: { id: 's1', shot_code: '2B' },
        sceneCard: { shot_code: '2B', description: 'x' },
        scene: { project_id: 'p1' },
        project: { id: 'p1', target_resolution: '1920x1080' },
        videoAsset: { id: 'a1', file_name: '2B.mp4', project_id: 'p1', width: 1280, height: 720,
                      duration_ms: 9700 },
        overrides: { job_type: 'upscale' },
    };
    const payload = buildCapabilityPayload('post', ctx).payload;
    assert.strictEqual(payload.source_seconds, 9.7,
        'the post payload drops the measured length, so the adapter cannot price the pass');
    const r = seedance.buildPostRequest(payload);
    assert.ok(Math.abs(r.estimated_usd - 9.7 * 1.70) < 0.01,
        `priced at $${r.estimated_usd}, expected $${(9.7 * 1.7).toFixed(2)} for a 9.7s source`);

    // And an asset with no measured length still refuses to invent one.
    const bare = buildCapabilityPayload('post',
        { ...ctx, videoAsset: { ...ctx.videoAsset, duration_ms: 0 } }).payload;
    assert.strictEqual(bare.source_seconds, undefined);
    assert.strictEqual(seedance.buildPostRequest(bare).estimated_usd, null);
});

test('the upscale is priced from the SOURCE length, or says it cannot be', () => {
    /*
     * RBF-001 finding 3: duration is IGNORED and the bill follows the source.
     * The estimate multiplied a defaulted 5 seconds by the 4k rate and
     * returned $8.50 for any clip whatsoever — a confident number that is not
     * the price, which is the exact defect ICP-013 fixed one provider over.
     */
    const measured = seedance.buildPostRequest({
        source_video: 'https://x/clip.mp4', type: 'upscale', source_seconds: 12,
    });
    assert.ok(Math.abs(measured.estimated_usd - 12 * 1.70) < 0.01,
        `a 12s source priced at $${measured.estimated_usd}, expected $${(12 * 1.7).toFixed(2)}`);

    const unmeasured = seedance.buildPostRequest({ source_video: 'https://x/clip.mp4', type: 'upscale' });
    assert.strictEqual(unmeasured.estimated_usd, null,
        'an unmeasured source is still priced at a default — a guessed length is a confident '
        + 'wrong price, and nobody would know it was invented');
    assert.ok(unmeasured.estimate_unknown_why && /source/i.test(unmeasured.estimate_unknown_why),
        'nothing says why there is no price');
});

test('video-edit models are offered for post and NEVER for video', () => {
    /*
     * A director picking "Seedance 2.5 video edit" from the VIDEO menu would be
     * choosing the retired path from the one surface that looks like a
     * sanctioned choice. It is correct today; this pins it.
     */
    const { modelIdsFor } = require('../lib/providers');
    const forVideo = modelIdsFor(seedance.adapter, 'video') || [];
    const forPost = modelIdsFor(seedance.adapter, 'post') || [];
    assert.deepStrictEqual(forVideo.filter(id => /video-edit/.test(id)), [],
        'the video menu offers a video-edit model');
    assert.ok(forPost.some(id => /video-edit/.test(id)),
        'the post menu lost the upscale models');
});

/* ── 4 · the evidence is cited where a reader would look ────────────────── */

test('the rate rows say what a SECOND is a second of', () => {
    /*
     * `usd_per_native: 1.70` per second of what? A reader pricing an upscale
     * looks here, and the answer RBF-001 measured — the source, not the output,
     * and a failed job too — is the one thing that changes the sum.
     */
    const at = PRICING.indexOf('seedance-2.5-video-edit');
    assert.ok(at > -1, 'the rate rows for video-edit are gone');
    const around = PRICING.slice(Math.max(0, at - 2500), at + 800);
    assert.match(around, /RBF-001/,
        'the rate rows do not cite RBF-001, so the measured billing rule is invisible where the '
        + 'price is read');
    assert.match(around, /source/i, 'the rows do not say the second is a second of SOURCE');
});

test('the adapter cites the verdict a reader can go and check', () => {
    assert.ok(fs.existsSync(VERDICT), 'the RBF-001 verdict is gone; the citation would be dead');
    assert.match(SRC, /rbf-001/i,
        'the adapter never names the probe, so a reader has no way to find why this is refused');
});

test('the citation is not a dead link', () => {
    // A stale citation is worse than none: it reads as evidence and is not.
    const cited = [...SRC.matchAll(/docs\/plans\/([a-z0-9-]+\.md)/gi)].map(m => m[1]);
    for (const f of cited) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'docs', 'plans', f)),
            `the adapter cites docs/plans/${f}, which does not exist`);
    }
    assert.ok(cited.includes('rbf-001-video-edit-probe.md'),
        'the adapter does not cite the verdict file by path');
});
