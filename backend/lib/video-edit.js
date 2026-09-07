/**
 * KEEP THE ACTOR, CHANGE THE BACKGROUND.
 *
 * Every generation path in this engine makes a NEW picture: a keyframe from a
 * card, a clip from a keyframe, a plate from a description. None of them can
 * take footage that already exists and change one thing about it — which is
 * the operation a director asks for after shooting a performance they like in
 * a place they do not.
 *
 * ICP-012 registered `aleph2`, the first video-to-video model here. This is
 * the road to it, and it is deliberately the SHAPE OF runRepair rather than a
 * new one: plan, budget, host, generate, register. Two of repair's stages are
 * absent because a background replacement is not a splice — the whole clip is
 * re-rendered, so there is nothing to extract and nothing to join back in.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER GENERATION HERE: Runway bills
 * this endpoint by the length of the clip handed IN, and there is no duration
 * field to carry it. So the source has to be MEASURED before it can be priced,
 * and a clip nobody measured is refused rather than guessed — ICP-013 records
 * what an invented length does to a budget gate.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { inspectMedia } = require('./ffmpeg');
const { mintHandle, revokeScope } = require('./frame-handles');
const { budgetStatus } = require('./flow-cost');
const { getFilePath, ensureDir } = require('./file-storage');
const { RUNWAY_VIDEO_MODELS, quoteVideo, checkBudget } = require('./providers/runway');

/** The only model here that can edit footage. Read, never retyped. */
const EDIT_MODEL = 'aleph2';

/**
 * The stages, in order, each saying why it is its own step.
 *
 * A registry rather than five inline returns, so a stage that can never fail —
 * whose error path has therefore never run — is visible as a gap. The lesson
 * REPAIR_STAGES already records: "the edit failed" sends a director to the
 * database to work out which part of it did.
 */
const EDIT_STAGES = Object.freeze([
    { id: 'plan', why: 'the source clip, its measured length, the model window and the price — '
        + 'decided before anything is exposed, spent or written' },
    { id: 'budget', why: 'the gate belongs with the thing that SPENDS; one consulted by the planner '
        + 'and not the executor is a gate anything holding a plan can walk past' },
    { id: 'host', why: 'the provider fetches over http(s) and caps a data URI at 5MB, which no clip '
        + 'of this length fits under, so the footage must be reachable before the request exists' },
    { id: 'generate', why: 'the only step that costs money, and the only one that can come back '
        + 'wrong while succeeding' },
    { id: 'register', why: 'a new version rather than an overwrite — the take being edited was paid '
        + 'for and must survive the attempt' },
]);

/**
 * THE PROMPT, AND WHY IT SAYS SO LITTLE.
 *
 * The performance is IN the footage. Describing the person again is how a
 * video-to-video edit re-renders them — the same reason a refine sends the
 * picture and one instruction rather than the scene card, and the reason the
 * recompose prompt names each reference by its job instead of restating what
 * is in it.
 *
 * The CHANGE LEADS. Three separate failures in one day had continuity language
 * outranking the change and the model returned the source unchanged every
 * time; whatever leads a prompt is what the result is of.
 *
 * The `opts` argument exists so a caller CAN hand over the scene card and have
 * it deliberately ignored. Taking no card at all would leave the omission
 * looking like something nobody thought about.
 */
function buildBackgroundPrompt(instruction, opts) {
    const policy = RUNWAY_VIDEO_MODELS[EDIT_MODEL] || {};
    const ceiling = policy.promptLimit || 1000;
    const KEEP = ' Keep everything else exactly as it is: the same people, the same faces and '
        + 'wardrobe, the same positions and movement, the same framing, lens and camera move.';
    const lead = `Replace the background: ${String(instruction || '').trim()}.`;
    /*
     * The INSTRUCTION is what gets cut, never the preservation clause. Losing
     * the tail to a ceiling would drop the only sentence holding the actor
     * still — the failure that made every video prompt trim its subject last.
     */
    if (lead.length + KEEP.length <= ceiling) return lead + KEEP;
    const room = ceiling - KEEP.length - 'Replace the background: .'.length;
    const cut = String(instruction || '').trim().slice(0, Math.max(0, room));
    return `Replace the background: ${cut}.${KEEP}`;
}

const refuse = (stage, reason, extra) => ({ refused: true, stage, reason, ...(extra || {}) });

/**
 * What this edit would do and what it would cost. FREE and side-effect-free:
 * nothing is exposed, generated or written, so it can be raised as often as a
 * director likes — which is what keeps trying three backgrounds from being a
 * budget decision.
 *
 * `inspect` is injectable for the same reason `runRepair` takes its generator:
 * the measurement is the one step that needs an encoder, and threading a
 * second reader for it is how two paths come to disagree about a clip's length.
 */
function planBackgroundEdit(input) {
    const o = input || {};
    const policy = RUNWAY_VIDEO_MODELS[EDIT_MODEL];
    const win = policy.duration || {};

    const instruction = String(o.instruction || '').trim();
    if (!instruction) {
        return refuse('plan',
            'Say what the new background should be. A background replacement with nothing said is '
            + 'a generation that spends and changes whatever the model feels like.');
    }

    if (!o.sourcePath) {
        return refuse('plan', 'This shot has no footage yet, so there is nothing to edit.');
    }

    const read = o.inspect || inspectMedia;
    const m = read(o.sourcePath);
    if (!m || !m.ok) {
        /*
         * REFUSED, NEVER GUESSED. This endpoint bills the clip handed in, so a
         * default length is a confident price that is wrong by however much the
         * real clip differs — and nobody would know it was invented.
         */
        return refuse('plan',
            `That clip could not be measured (${(m && m.reason) || 'no reason given'}), and this `
            + 'model bills by the length of the clip handed in. Until it is measured there is no '
            + 'honest price, so nothing is sent.');
    }

    const seconds = Number(m.durationSeconds);
    if (seconds > win.max) {
        return refuse('plan',
            `That clip is ${seconds.toFixed(1)}s and ${EDIT_MODEL} takes ${win.min}-${win.max}s. `
            + `It bills the length handed in, so trim the source to ${win.max}s or less and edit `
            + 'that — a longer clip is not merely refused, it would also be the most expensive '
            + 'thing you could send.');
    }
    if (seconds < win.min) {
        return refuse('plan',
            `That clip is ${seconds.toFixed(1)}s and ${EDIT_MODEL} needs at least ${win.min}s.`);
    }

    /*
     * The length rides NON-ENUMERABLY, the same trick `__project_id` uses on a
     * provider config. Nothing here reaches the wire, but this object is the
     * shape the request builder produces and a plain property is one copy away
     * from travelling to the provider as a field it does not recognise — which
     * is how every MuAPI reference image was silently discarded.
     */
    const priceable = { model: EDIT_MODEL };
    Object.defineProperty(priceable, '__sourceSeconds', { value: seconds, enumerable: false });

    return {
        model: EDIT_MODEL,
        prompt: buildBackgroundPrompt(instruction, o),
        instruction,
        source: { path: o.sourcePath, durationSeconds: seconds, width: m.width, height: m.height, fps: m.fps },
        window: { min: win.min, max: win.max },
        quote: quoteVideo(priceable),
        priceable,
    };
}

const failWith = (minted) => (stage, reason, extra) =>
    ({ ok: false, stage, reason, handles: minted.slice(), ...(extra || {}) });

/**
 * Run the edit. Never throws — every failure comes back naming its stage.
 *
 * `generate` and `inspect` are injectable. Not only for tests: generation is
 * the one place a different model would plug in, and threading a second runner
 * for it is how the two come to disagree about everything around it.
 */
async function runBackgroundEdit(input) {
    const o = input || {};
    const scope = o.scope || `bgedit-${crypto.randomBytes(8).toString('hex')}`;
    const minted = [];
    const fail = failWith(minted);

    try {
        /* 1 · plan — free, and it owns every rule about a clip against a model. */
        const plan = planBackgroundEdit(o);
        if (plan.refused) return fail('plan', plan.reason, { code: plan.code || 'refused' });

        /* 2 · budget — BEFORE the provider is reached, never after. */
        let remainingUsd = Number.isFinite(Number(o.remainingUsd)) ? Number(o.remainingUsd) : undefined;
        if (remainingUsd === undefined && !o.ignoreBudget && o.db && o.projectId) {
            try {
                const status = budgetStatus(o.db, o.projectId, plan.quote.usd || 0);
                if (Number.isFinite(status.remaining)) remainingUsd = status.remaining;
            } catch (_) { remainingUsd = undefined; }
        }
        if (!o.ignoreBudget) {
            /*
             * The adapter's own gate, which refuses what it CANNOT PRICE as
             * well as what it cannot afford. Built in ICP-013 and, until this,
             * consumed by nobody — the declared-and-unreachable shape this
             * codebase keeps paying for.
             */
            const gate = checkBudget(plan.priceable, { remainingUsd });
            if (!gate.ok) return fail('budget', gate.why, { code: 'over_budget', quote: plan.quote });
        }

        /* 3 · host — the provider cannot read our disk. */
        const h = mintHandle(plan.source.path, { scope, publicBase: o.publicBase });
        if (!h.ok) return fail('host', h.reason, { code: h.code });
        minted.push(h.id);

        /* 4 · generate — the only step that spends. */
        const gen = o.generate || backgroundGenerator;
        let made;
        try {
            made = await gen({
                videoUri: h.url, prompt: plan.prompt, model: plan.model,
                sourceSeconds: plan.source.durationSeconds,
                projectId: o.projectId, shotId: o.shotId, plan,
            });
        } catch (err) {
            return fail('generate', `the provider call failed: ${err.message}`, { quote: plan.quote });
        }
        if (!made || !made.ok || !made.path || !fs.existsSync(made.path)) {
            return fail('generate', (made && made.reason) || 'the provider returned no clip',
                { quote: plan.quote });
        }

        /* 5 · register — a NEW version. Nothing existing is touched. */
        if (o.db && o.projectId) {
            try {
                const row = o.db.prepare(
                    `SELECT COALESCE(MAX(version), 0) AS v FROM film_assets
                      WHERE shot_id = ? AND asset_type IN ('video_final','video_synced','video_raw')`)
                    .get(o.shotId);
                const version = Number((row && row.v) || 0) + 1;
                const name = path.basename(made.path);
                o.db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, shot_id, asset_type, file_path, file_name,
                        format, mime_type, duration_ms, version,
                        provider, provider_model, provider_job_id,
                        license_source, license_status, input_refs
                     ) VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, ?, 'runway', ?, ?,
                               'generated', 'generated', ?)`
                ).run(
                    crypto.randomUUID(), o.projectId, o.shotId, made.path, name,
                    Math.round(plan.source.durationSeconds * 1000), version,
                    plan.model, made.jobId || null,
                    JSON.stringify({ background_replaced_from: plan.source.path, instruction: plan.instruction }),
                );
                return { ok: true, output: made.path, version, scope, handles: minted,
                         stages: EDIT_STAGES.map(s => s.id), quote: plan.quote, prompt: plan.prompt };
            } catch (err) {
                // The generation SUCCEEDED and was billed; failing to record it
                // is a different problem and must say so, or the spend reads as
                // a refusal and gets repeated.
                return fail('register',
                    `the edited clip was produced at ${made.path} but could not be registered: ${err.message}`,
                    { output: made.path });
            }
        }

        return { ok: true, output: made.path, scope, handles: minted,
                 stages: EDIT_STAGES.map(s => s.id), quote: plan.quote, prompt: plan.prompt };
    } catch (err) {
        return fail('plan', `the background replacement could not be run: ${err.message}`);
    } finally {
        /*
         * THE FAILURE PATH IS THE ONE THAT GETS FORGOTTEN. A handle left live
         * after this ends is a piece of footage on the public internet nobody
         * is tracking, and the happy path is the one people remember to close.
         */
        try { revokeScope(scope); } catch (_) { /* a handle that cannot be revoked expires anyway */ }
    }
}

/**
 * The generator that makes this able to spend.
 *
 * Injected by default rather than inlined, for the reason `repairGenerator`
 * states: this is the one place a different model would plug in. The provider
 * is resolved from the project's own config so the account that gets billed is
 * the one the project names.
 */
async function backgroundGenerator(request) {
    const gen = request || {};
    let provider;
    try {
        const { resolve } = require('./providers');
        const { providerConfigOf } = require('./provider-config');
        provider = resolve('video', providerConfigOf(gen.projectId));
    } catch (err) {
        return { ok: false, reason: `no video provider could be resolved: ${err.message}` };
    }

    let result;
    try {
        result = await provider.generate('video', {
            model: gen.model,
            videoUri: gen.videoUri,
            promptText: gen.prompt,
            // Priced from the SOURCE, and carried so the adapter's own
            // estimator can see a length its request body has no field for.
            sourceSeconds: gen.sourceSeconds,
        }, { timeout: 900000 });
    } catch (err) {
        // A REASON, NEVER A THROW. The runner names the stage that failed, and
        // an exception escaping here surfaces from whichever stage is on the
        // stack rather than from this one.
        return { ok: false, reason: `the provider refused: ${err.message}` };
    }
    if (!result || result.ok === false) {
        return { ok: false, reason: (result && (result.reason || result.error)) || 'the provider returned nothing' };
    }

    try {
        const { persistProviderMedia } = require('./provider-media');
        if (gen.projectId) { try { ensureDir(gen.projectId, 'video'); } catch (_) { /* reported below */ } }
        const stored = await persistProviderMedia(gen.projectId, 'video',
            `background_${Date.now().toString(36)}.mp4`, result.data || result, { serveDir: 'videos' });
        return { ok: true, path: stored, jobId: result.jobId || result.id || null };
    } catch (err) {
        return { ok: false, reason: `the edit generated but could not be stored: ${err.message}` };
    }
}

module.exports = {
    EDIT_STAGES, EDIT_MODEL,
    planBackgroundEdit, runBackgroundEdit, buildBackgroundPrompt, backgroundGenerator,
};
