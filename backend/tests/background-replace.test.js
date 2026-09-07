/**
 * KEEP THE ACTOR, CHANGE THE BACKGROUND.
 *
 * The whole reason ICP-012 registered a video-to-video model: every other
 * entry in the Runway registry is image_to_video or text_to_video, so "keep
 * the performance and put it somewhere else" had no provider path at all — and
 * the operation a director actually asks for after shooting on an iPhone in a
 * kitchen is exactly that one.
 *
 * SET-BASED OVER TWO DENOMINATORS, because the failure is partial in two
 * independent directions:
 *
 *   1. THE STAGES. Five things happen in order and any of them can fail. A
 *      runner that reports "the edit failed" sends a director to the database
 *      to work out which — the lesson REPAIR_STAGES already records, and the
 *      reason that registry exists rather than five inline returns.
 *
 *   2. THE ENTRY POINTS. A page button, an HTTP route and an MCP tool. Wiring
 *      hosting into two of the three leaves the third sending a path on this
 *      machine to a provider that cannot read our disk — and it fails with a
 *      message that reads like a credential problem. Every path must reach the
 *      SAME runner, which is the rule repair-dispatch.test.js already holds.
 *
 * Nothing here spends: the inspector and the generator are injected, exactly
 * as runRepair takes its generator, so the ordering and the refusals can be
 * exercised without a provider or an encoder.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/*
 * FILM_DATA_DIR IS SET BEFORE ANYTHING IS REQUIRED. `file-storage` captures
 * DATA_DIR at import time, so setting it in a hook would leave the modules
 * pointed at the real install — and this test WRITES CLIPS.
 *
 * It also has to be set at all: mintHandle refuses any path outside the data
 * tree, correctly, so a fixture in os.tmpdir() is refused at the host stage
 * and every later stage looks broken. Only media this engine already stores
 * may be handed to a provider.
 */
process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bgedit-data-'));

const {
    EDIT_STAGES, planBackgroundEdit, runBackgroundEdit, buildBackgroundPrompt,
} = require('../lib/video-edit');
const { listTools } = require('../lib/mcp-tools');

const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'video-gen.js'), 'utf8');

/** A clip the inspector will report as `seconds` long, without an encoder. */
const measured = (seconds) => () => ({ ok: true, durationSeconds: seconds, width: 1920, height: 1080, fps: 24 });

/** A clip inside the data tree, which is the only kind that can be hosted. */
function tempClip() {
    const { DATA_DIR } = require('../lib/file-storage');
    const dir = path.join(DATA_DIR, 'video', '__bgedit_test__');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `clip-${crypto.randomBytes(6).toString('hex')}.mp4`);
    fs.writeFileSync(p, Buffer.alloc(64, 7));
    return p;
}

/* ── 1 · the stages ─────────────────────────────────────────────────────── */

test('every stage states why it is its own step, and the order is the order', () => {
    assert.ok(EDIT_STAGES.length >= 5, 'fewer than five stages — the runner is not staged at all');
    for (const s of EDIT_STAGES) {
        assert.ok(s.id && /^[a-z]+$/.test(s.id), `${JSON.stringify(s)} has no usable id`);
        assert.ok(s.why && s.why.length > 25,
            `stage "${s.id}" states no real reason for being its own step, so a stage that can `
            + 'never fail is invisible as a gap');
    }
    // Ordering is load-bearing: hosting before pricing puts a file on the
    // internet to answer a question that could have been answered for free.
    const ids = EDIT_STAGES.map(s => s.id);
    assert.ok(ids.indexOf('plan') < ids.indexOf('host'),
        'the plan must come before hosting — a clip is exposed publicly only once we know we will use it');
    assert.ok(ids.indexOf('budget') < ids.indexOf('generate'),
        'the gate must come before the only step that spends');
    assert.ok(ids.indexOf('generate') < ids.indexOf('register'));
});

test('EVERY stage names ITSELF when it is the one that fails', async () => {
    /*
     * The point of the registry. A runner whose every failure says "plan" is
     * indistinguishable from one that is staged, until somebody has to work
     * out why a paid edit produced nothing.
     */
    const clip = tempClip();
    const base = {
        sourcePath: clip, instruction: 'a rain-soaked street at night',
        inspect: measured(6), publicBase: 'https://example.test',
    };
    const seen = new Map();

    // plan — nothing to edit
    seen.set('plan', await runBackgroundEdit({ ...base, sourcePath: '/nope/missing.mp4',
        inspect: () => ({ ok: false, reason: 'there is no file there' }) }));
    // budget — priced, and the project cannot afford it
    seen.set('budget', await runBackgroundEdit({ ...base, remainingUsd: 0.01 }));
    // host — no public address, so there is no URL to hand a provider
    seen.set('host', await runBackgroundEdit({ ...base, publicBase: '' }));
    // generate — the provider refused
    // A real generator's reason, not a stub word: this stage passes the
    // provider's own sentence through, so a two-word fixture would be judging
    // the fixture rather than the runner.
    seen.set('generate', await runBackgroundEdit({ ...base,
        generate: async () => ({ ok: false, reason: 'the provider refused: content moderation' }) }));
    // register — a clip was produced and the row could not be written
    seen.set('register', await runBackgroundEdit({ ...base,
        generate: async () => ({ ok: true, path: clip }),
        db: { prepare() { throw new Error('no such table'); } },
        projectId: 'p1', shotId: 's1' }));

    for (const [want, got] of seen) {
        assert.strictEqual(got.ok, false, `the ${want} case did not fail, so it proves nothing`);
        assert.strictEqual(got.stage, want,
            `a ${want} failure reported stage "${got.stage}" — "${got.reason}"`);
        assert.ok(got.reason && got.reason.length > 20, `${want}: the reason is not a sentence`);
    }
});

/* ── 2 · the plan: free, and it refuses rather than guessing ────────────── */

test('a measured clip is priced from the SOURCE length, at the aleph rate', () => {
    const p = planBackgroundEdit({ sourcePath: tempClip(), instruction: 'a rainy street', inspect: measured(10) });
    assert.strictEqual(p.refused, undefined, p.reason);
    assert.strictEqual(p.source.durationSeconds, 10);
    // 10s x 28 credits, and Runway bills credits at $0.01.
    assert.strictEqual(p.quote.known, true, 'a measured clip must be priceable');
    assert.strictEqual(p.quote.credits, 280);
    assert.ok(Math.abs(p.quote.usd - 2.80) < 1e-9, `priced at $${p.quote.usd}, expected $2.80`);
});

test('the minimum charge applies to a short clip', () => {
    const p = planBackgroundEdit({ sourcePath: tempClip(), instruction: 'a rainy street', inspect: measured(2) });
    // 2s x 28 = 56, which IS the minimum; a 2s clip must never price under it.
    assert.strictEqual(p.quote.credits, 56);
});

test('a clip nobody could measure is REFUSED, never priced at a default', () => {
    /*
     * The defect ICP-013 measured one level down: an absent length multiplied
     * by the rate is NaN, and NaN passes every budget comparison because every
     * comparison against it is false. Guessing a length here would put that
     * back with a plausible number instead of NaN, which is worse — nobody
     * would know it was invented.
     */
    const p = planBackgroundEdit({ sourcePath: tempClip(), instruction: 'a rainy street',
        inspect: () => ({ ok: false, reason: 'no encoder is available on this machine' }) });
    assert.strictEqual(p.refused, true);
    assert.strictEqual(p.stage, 'plan');
    assert.match(p.reason, /encoder|measure/i, `the refusal does not say why: ${p.reason}`);
});

test('a clip outside the model\'s own window is refused with the remedy named', () => {
    const long = planBackgroundEdit({ sourcePath: tempClip(), instruction: 'a rainy street', inspect: measured(45) });
    assert.strictEqual(long.refused, true);
    assert.match(long.reason, /30/, 'the ceiling is not named');
    assert.match(long.reason, /trim/i,
        'a 45s clip is refused with no remedy — trimming is the only way through, and a refusal '
        + 'that names none reads as the feature being broken');

    const brief = planBackgroundEdit({ sourcePath: tempClip(), instruction: 'a rainy street', inspect: measured(0.8) });
    assert.strictEqual(brief.refused, true);
    // `\b2\b` cannot match "2s" — the digit is followed by a word character —
    // and it also matches the "2" in "aleph2", so it was wrong twice.
    assert.match(brief.reason, /least 2s|2 seconds/, `the floor is not named: ${brief.reason}`);
});

test('an empty instruction is refused before anything is priced', () => {
    const p = planBackgroundEdit({ sourcePath: tempClip(), instruction: '   ', inspect: measured(6) });
    assert.strictEqual(p.refused, true);
    assert.match(p.reason, /describe|instruction|what/i);
});

/* ── 3 · the prompt: the change leads, and the actor is not re-described ── */

test('the CHANGE leads and what is preserved follows', () => {
    const prompt = buildBackgroundPrompt('a rain-soaked street at night');
    /*
     * Whatever leads a prompt is what the image is OF — the rule this codebase
     * learned expensively on recompose, where continuity language outranking
     * the change returned the source unchanged three times in one day.
     */
    const change = prompt.indexOf('rain-soaked street at night');
    assert.ok(change > -1, 'the instruction is not in the prompt at all');
    const keep = prompt.search(/keep|preserv|unchanged/i);
    assert.ok(keep > -1, 'nothing in the prompt says what must survive');
    assert.ok(change < keep,
        'the preservation clause leads the change, which is the ordering that returns the source '
        + `unchanged:\n${prompt}`);
});

test('the prompt does NOT re-describe the actor', () => {
    /*
     * "The actor is preserved by the model rather than by a matte." Describing
     * the person is how a video-to-video edit re-renders them: the subject is
     * IN the footage, and saying it again in words pulls the result toward a
     * fresh generation — the same reason a refine sends no scene card.
     */
    const prompt = buildBackgroundPrompt('a rain-soaked street at night', {
        sceneCard: { description: 'MAYA, 30s, red coat, crosses toward the sedan', characters: ['MAYA'] },
    });
    // Positively first: an EMPTY prompt contains no subject either, and an
    // absence-only assertion is satisfied by a builder that emits nothing.
    assert.ok(prompt.includes('a rain-soaked street at night'),
        'the instruction is not in the prompt, so this proves nothing about what was left out');
    assert.ok(!/MAYA/.test(prompt),
        `the scene card's subject reached the edit prompt:\n${prompt}`);
    assert.ok(!/red coat/.test(prompt), 'the wardrobe description reached the edit prompt');
});

test('the prompt stays inside the model\'s own ceiling', () => {
    const prompt = buildBackgroundPrompt('x'.repeat(4000));
    // Under the ceiling AND actually built: `''` is under every ceiling there
    // is, so a length-only check passes against a builder that emits nothing.
    assert.ok(prompt.length > 800,
        `only ${prompt.length} characters survived a 4000-character instruction — the trim is `
        + 'eating the request rather than fitting it');
    assert.ok(prompt.length <= 1000,
        `${prompt.length} characters against aleph2's 1000 — over-sending is a rejection that `
        + 'costs a generation');
});

/* ── 4 · the result is a NEW version, and the old take survives ─────────── */

test('a successful edit registers a NEW version and touches nothing existing', async () => {
    const clip = tempClip();
    const made = tempClip();
    const rows = [];
    let maxVersion = 3;
    const db = {
        prepare(sql) {
            if (/COALESCE\(MAX\(version\)/.test(sql)) return { get: () => ({ v: maxVersion }) };
            if (/^\s*INSERT INTO film_assets/i.test(sql)) return { run: (...a) => rows.push({ sql, args: a }) };
            if (/UPDATE|DELETE/i.test(sql)) {
                throw new Error('a background replacement must not rewrite or remove an existing row');
            }
            return { get: () => null, run: () => {}, all: () => [] };
        },
    };
    const out = await runBackgroundEdit({
        sourcePath: clip, instruction: 'a rain-soaked street at night',
        inspect: measured(6), publicBase: 'https://example.test',
        db, projectId: 'p1', shotId: 's1', shotCode: '2B',
        generate: async () => ({ ok: true, path: made, jobId: 'job-1' }),
    });
    assert.strictEqual(out.ok, true, out.reason);
    assert.strictEqual(out.version, 4, 'the result did not land as the next version');
    assert.strictEqual(rows.length, 1, 'exactly one asset row should be written');
    assert.ok(fs.existsSync(clip), 'the take being edited was destroyed');
    assert.ok(!/UPDATE|DELETE/i.test(rows[0].sql));
});

test('a handle is revoked whether the edit succeeds or fails', async () => {
    /*
     * The failure path is the one that gets forgotten. A handle left live is a
     * file on the public internet nobody is tracking, and the happy path is
     * the one people remember to close.
     */
    const clip = tempClip();
    const { resolveHandle } = require('../lib/frame-handles');
    for (const gen of [
        async () => ({ ok: true, path: clip }),
        async () => ({ ok: false, reason: 'the provider refused' }),
    ]) {
        const out = await runBackgroundEdit({
            sourcePath: clip, instruction: 'a rainy street', inspect: measured(6),
            publicBase: 'https://example.test', generate: gen,
        });
        for (const id of (out.handles || [])) {
            assert.strictEqual(resolveHandle(id).ok, false,
                `handle ${id} is still live after the edit ${out.ok ? 'succeeded' : 'failed'}`);
        }
        assert.ok((out.handles || []).length >= 1, 'no handle was minted, so the clip was never hosted');
    }
});

test('the generator receives a FETCHABLE url, never a path on this machine', async () => {
    const clip = tempClip();
    let saw = null;
    await runBackgroundEdit({
        sourcePath: clip, instruction: 'a rainy street', inspect: measured(6),
        publicBase: 'https://example.test',
        generate: async (req) => { saw = req; return { ok: true, path: clip }; },
    });
    assert.ok(saw, 'the generator was never reached');
    assert.match(String(saw.videoUri), /^https?:\/\//,
        `the generator was handed "${saw.videoUri}" — Runway cannot read our disk, and the `
        + 'refusal that produces reads like a credential problem');
    assert.ok(!String(saw.videoUri).includes(clip), 'the local path leaked into the request');
});

/* ── 5 · the entry points ───────────────────────────────────────────────── */

test('the route dispatches both the free preview and the paid generate', () => {
    assert.match(ROUTE, /'background'/,
        'routes/video-gen.js does not dispatch a background sub-path at all');
    // Free and paid are DIFFERENT verbs on different sub-paths: a preview that
    // could spend is not a preview.
    assert.match(ROUTE, /background[\s\S]{0,400}?preview/,
        'there is no free background preview for the confirmation to read');
    assert.match(ROUTE, /background[\s\S]{0,400}?generate/,
        'there is no background generate');
});

test('an MCP tool can do it — a FREE preview and a spending replace', () => {
    /*
     * The connected model IS the LLM here, so a capability it cannot reach is
     * one that has to be done by hand. Both halves, because a spending tool
     * with no free preview beside it means the only way to learn the cost is
     * to pay it.
     */
    const tools = listTools();
    const props = t => ((t.inputSchema && t.inputSchema.properties) || {});

    const preview = tools.find(x => x.name === 'video_background_preview');
    assert.ok(preview, 'there is no free background preview tool');
    assert.match(preview.description, /SPENDS NOTHING|FREE/,
        'the preview does not say it is free, so a model will avoid raising it');
    assert.ok(props(preview).instruction,
        'the preview takes no instruction, so it cannot price the edit being considered');

    const spend = tools.find(x => x.name === 'video_background_replace');
    assert.ok(spend, 'no MCP tool performs a background replacement');
    assert.match(spend.description, /SPENDS CREDITS/,
        'the spending tool does not say it spends money');
    assert.ok(props(spend).instruction, 'there is nothing to say about the new background');
    assert.ok((spend.inputSchema.required || []).includes('instruction'),
        'the instruction is optional, so this can be called with nothing said and spend anyway');
    assert.match(spend.description, /NEW VERSION|new version/,
        'it does not say the previous take survives');
    assert.match(spend.description, /stage/i, 'it does not say failures name their stage');
});

test('EVERY entry point reaches the ONE runner', () => {
    /*
     * Derived, not listed. A second implementation is how hosting gets wired
     * into the route and not the tool, and the tool then sends a local path.
     */
    const dir = path.join(__dirname, '..', 'routes');
    const starters = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
        .map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')])
        .filter(([, src]) => /background/i.test(src) && /video_to_video|aleph|runBackgroundEdit/.test(src));

    assert.ok(starters.length >= 1, 'no route starts a background replacement');
    for (const [f, src] of starters) {
        assert.match(src, /runBackgroundEdit/,
            `${f} starts a background replacement without going through runBackgroundEdit`);
        assert.ok(!/mintHandle/.test(src),
            `${f} mints its own handle — hosting belongs in the runner, or one entry point gets `
            + 'the fix and the other keeps sending a local path');
    }
});

test('the page offers it on the shot, gated, and shows the control working', () => {
    /*
     * every-generate-button.test.js discovers this function on its own and
     * holds it to the gate and to a busy state. What IT cannot see is that the
     * button exists on the card at all — a gated function nothing calls looks
     * identical to a working page.
     */
    assert.match(UI, /onclick="replaceBackground\(/,
        'no control on the Video Shots card calls replaceBackground');
    const at = UI.indexOf('async function replaceBackground(');
    assert.ok(at > -1, 'replaceBackground is not defined, so the button calls nothing');
    let i = UI.indexOf('{', at), depth = 0, end = -1;
    for (let j = i; j < UI.length; j++) {
        if (UI[j] === '{') depth++;
        else if (UI[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
    }
    const body = UI.slice(at, end);
    assert.match(body, /confirmPaidImage\s*\(/,
        'it spends without the shared confirmation, so the prompt, provider, model and cost '
        + 'cannot be read before the money goes');
    assert.match(body, /background\/preview/,
        'the confirmation is handed no preview URL for THIS operation, so it would show the cost '
        + 'of a different generation');
    assert.match(body, /background\/generate/, 'it does not post to the background generate route');
});

test('the button is only offered where there is footage to edit', () => {
    /*
     * A background replacement of nothing is a paid refusal. The card already
     * knows: `proActions` is the block gated on a clip existing.
     */
    const at = UI.indexOf('const proActions');
    assert.ok(at > -1, 'proActions is gone — the gate this relies on no longer exists');
    const block = UI.slice(at, at + 1400);
    assert.match(block, /replaceBackground/,
        'the control sits outside the block that requires a clip, so it is offered on a shot with '
        + 'no footage');
});
