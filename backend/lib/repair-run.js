/**
 * RUN THE PLAN.
 *
 * Everything this composes already exists and is tested on its own: extraction
 * (RBF-003), the splice (RBF-004), inspection (RBF-005), the plan (RBF-006),
 * the fetchable handle (RBF-011). What is new here is the ORDER, what happens
 * when one step fails, and what is left behind afterwards.
 *
 * A REPAIR IS AN ATTEMPT, AND THE PREVIOUS TAKE MUST SURVIVE IT. Video is
 * written to `{shot_code}.mp4` — a fixed name — so a repair that wrote there
 * would destroy footage that was paid for, in order to improve it. The result
 * is a NEW file and a NEW version row; nothing existing is touched.
 *
 * EVERY FAILURE NAMES ITS STAGE. Six things happen in order and any of them can
 * fail; "the repair failed" sends a director to the database to work out which.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { planRepair } = require('./repair-plan');
const { extractFrame, spliceClip, inspectMedia, resolveFfmpeg, probe } = require('./ffmpeg');
const { mintHandle, revokeScope } = require('./frame-handles');
const { budgetStatus } = require('./flow-cost');
const { getFilePath, ensureDir } = require('./file-storage');

/**
 * The stages, in order, each saying why it is its own step.
 *
 * A registry rather than six inline returns, so a stage that can never fail —
 * whose error path has therefore never run — is visible as a gap.
 */
const REPAIR_STAGES = Object.freeze([
    { id: 'plan', why: 'the geometry, the floor and the cost, decided before anything is spent or written' },
    { id: 'budget', why: 'the gate belongs with the thing that SPENDS; one consulted by the planner and '
        + 'not the executor is a gate anything holding a plan can walk past' },
    { id: 'extract', why: 'the two frames the generation travels between, taken from the real footage' },
    { id: 'host', why: 'the provider fetches over http(s) and refuses data URIs, so the frames must be '
        + 'exposed at an address it can reach before the request can be made at all' },
    { id: 'generate', why: 'the only step that costs money, and the only one that can come back wrong '
        + 'while succeeding' },
    { id: 'splice', why: 'head + new + tail, back into one clip, at the source\'s own rate' },
    { id: 'register', why: 'a new version rather than an overwrite — the take being repaired was paid '
        + 'for and must survive the attempt' },
]);

/*
 * A FAILURE REPORTS WHAT IT EXPOSED. The handles are revoked either way, but a
 * caller that only learns which frames were put on the internet when the repair
 * SUCCEEDS is told nothing on the path that matters more.
 */
const failWith = (minted) => (stage, reason, extra) =>
    ({ ok: false, stage, reason, handles: minted.slice(), ...(extra || {}) });

/**
 * Execute a repair. Never throws — every failure comes back naming its stage.
 *
 * `generate` and `extractFrame` are injectable. That is not only for tests:
 * the generation step is the one place a different model would plug in, and
 * threading a second runner for that is how the two come to disagree about
 * everything around it.
 */
async function runRepair(input) {
    const o = input || {};
    const scope = o.scope || `repair-${crypto.randomBytes(8).toString('hex')}`;
    const minted = [];
    const scratch = [];       // frames written into the data tree, removed below
    let work = null;
    const fail = failWith(minted);

    try {
        /* 1 · plan — free, and it owns every rule about a range against a clip. */
        const plan = planRepair({
            sourcePath: o.sourcePath,
            startSec: o.startSec,
            endSec: o.endSec,
            ...(o.resolution ? { resolution: o.resolution } : {}),
        });
        if (plan.refused) return fail('plan', plan.reason, { code: plan.code });

        /* 2 · budget — BEFORE the generator is reached, never after. */
        if (!o.ignoreBudget && o.db && o.projectId) {
            let status = null;
            try { status = budgetStatus(o.db, o.projectId, plan.cost.usd); } catch (_) { status = null; }
            if (status && status.wouldExceed) {
                return fail('budget',
                    `This repair projects $${plan.cost.usd.toFixed(2)} and the project has `
                    + `$${status.remaining.toFixed(2)} of its $${status.limit.toFixed(2)} budget left. `
                    + 'Raise the budget, mark a shorter range, or pass ignore_budget.',
                    { code: 'over_budget', budget: status });
            }
        }

        /*
         * FRAMES ARE WRITTEN INSIDE THE DATA TREE, not to a temp directory, and
         * that is forced by RBF-011 rather than chosen: only media this engine
         * already stores can be minted into a fetchable handle. A frame in
         * /tmp is refused — correctly — so extracting somewhere the provider
         * can never be pointed at would be work thrown away one stage later.
         *
         * They are still SCRATCH: named per run and removed in the finally
         * below, whichever way this ends.
         */
        if (o.projectId) { try { ensureDir(o.projectId, 'repairs'); } catch (_) { /* reported at extract */ } }
        work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fe-repair-'));

        /* 3 · extract — the two frames, ORDERED: [0] starts, [1] arrives. */
        const cut = o.extractFrame || extractFrame;
        const frames = [];
        for (const [i, f] of plan.extract.entries()) {
            const out = o.projectId
                ? getFilePath(o.projectId, 'repairs', `${scope}-${f.role}.png`)
                : path.join(work, `${f.role}.png`);
            const got = cut(o.sourcePath, { atSeconds: f.atSeconds, out });
            if (!got.ok) {
                return fail('extract',
                    `the ${f.role} frame at ${f.atSeconds}s could not be taken: ${got.reason}`);
            }
            /*
             * A fallback here is a REFUSAL, not a warning. extractFrame hands
             * back frame zero when a seek runs past the end, which is right for
             * sampling and wrong here: generating between the wrong two
             * pictures produces a repair that looks fine and is of somewhere
             * else, and it costs money to find out.
             */
            if (got.fellBack) {
                return fail('extract',
                    `the ${f.role} frame at ${f.atSeconds}s is past the end of the clip, so the frame `
                    + 'taken would be the start of it. Mark the range again against this clip\'s real length.');
            }
            frames.push({ role: f.role, path: got.path, index: i });
            scratch.push(got.path);
        }

        at = 'host';
        /* 4 · host — the provider cannot read our disk. */
        const urls = [];
        for (const f of frames) {
            const h = mintHandle(f.path, { scope, publicBase: o.publicBase });
            if (!h.ok) return fail('host', h.reason, { code: h.code });
            minted.push(h.id);
            urls.push(h.url);
        }

        at = 'generate';
        /* 5 · generate — the only step that spends. */
        const gen = o.generate;
        if (typeof gen !== 'function') {
            return fail('generate', 'no generator was supplied to run this repair');
        }
        let made;
        try {
            made = await gen({ images: urls, plan, scope, shotId: o.shotId, projectId: o.projectId });
        } catch (err) {
            return fail('generate', `the provider call failed: ${err.message}`);
        }
        if (!made || !made.ok || !made.path || !fs.existsSync(made.path)) {
            return fail('generate', (made && made.reason) || 'the provider returned no clip');
        }

        /* 6 · splice — head + new + tail, at the source's own rate. */
        const outName = `${o.shotCode || 'shot'}_repair_${Date.now().toString(36)}.mp4`;
        const outPath = o.projectId
            ? (ensureDir(o.projectId, 'video'), getFilePath(o.projectId, 'video', outName))
            : path.join(work, outName);
        const joined = await spliceClip({
            sourcePath: o.sourcePath,
            replacementPath: made.path,
            startSec: o.startSec,
            endSec: o.endSec,
            outputPath: outPath,
        });
        if (!joined.ok) {
            return fail('splice', joined.error || joined.reason || 'the repaired section could not be joined back in');
        }

        /* 7 · register — a NEW version. Nothing existing is touched. */
        if (o.db && o.projectId) {
            try {
                const row = o.db.prepare(
                    `SELECT COALESCE(MAX(version), 0) AS v FROM film_assets
                      WHERE shot_id = ? AND asset_type IN ('video_final','video_synced','video_raw')`).get(o.shotId);
                const version = Number((row && row.v) || 0) + 1;
                o.db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, shot_id, asset_type, file_path, file_name,
                        format, mime_type, duration_ms, version,
                        provider, provider_model, provider_job_id, license_source, license_status, input_refs
                     ) VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, ?, ?, ?, ?, 'generated', 'generated', ?)`
                ).run(
                    crypto.randomUUID(), o.projectId, o.shotId, outPath, outName,
                    Math.round((plan.source.durationSeconds || 0) * 1000), version,
                    o.providerId || null, o.providerModel || null, made.jobId || null,
                    JSON.stringify({ repaired_from: o.sourcePath, range: [o.startSec, o.endSec] }),
                );
                return {
                    ok: true, output: outPath, version, scope, handles: minted,
                    stages: REPAIR_STAGES.map(s => s.id), cost: plan.cost, shape: joined.shape,
                };
            } catch (err) {
                return fail('register',
                    `the repaired clip was produced at ${outPath} but could not be registered: ${err.message}`,
                    { output: outPath });
            }
        }

        return { ok: true, output: outPath, scope, handles: minted,
                 stages: REPAIR_STAGES.map(s => s.id), cost: plan.cost, shape: joined.shape };
    } catch (err) {
        // A stage that threw is still a stage; reporting "unknown" is what this
        // whole registry exists to avoid, so the last one attempted is named.
        return fail('plan', `the repair could not be run: ${err.message}`);
    } finally {
        /*
         * THE FAILURE PATH IS THE ONE THAT GETS FORGOTTEN. A handle left live
         * after a repair ends is a file on the public internet nobody is
         * tracking, and the happy path is the one people remember to close.
         */
        try { revokeScope(scope); } catch (_) { /* a handle that cannot be revoked expires anyway */ }
        if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* temp */ } }
        // The extracted frames had to live in the data tree to be mintable;
        // they are scratch all the same, and a repair that left two PNGs per
        // run behind would fill it silently.
        for (const p2 of scratch) { try { fs.unlinkSync(p2); } catch (_) { /* already gone */ } }
    }
}

/**
 * THE GENERATOR THAT MAKES A REPAIR ABLE TO SPEND.
 *
 * `runRepair` takes this injected, and until something supplied a real one no
 * path in this codebase could actually generate a repair — `repair_run` would
 * have been listed, callable, and incapable of the one thing it names. That is
 * the `plate_generate` failure: in the registry, described, schema'd, and dead.
 *
 * `first-last-frame` is the workflow, because a repair travels between two
 * pictures the director has already approved. The frames go as ORDERED
 * keyframes — [0] the frame it starts on, [1] the frame it ends on — and the
 * order IS the meaning: reversed, the move runs backwards and reads as a model
 * fault rather than a field-order one.
 *
 * `provider` and `persist` are injectable so this can be exercised without
 * spending. Everything else about the call is the same shape the per-shot video
 * road already uses, deliberately: a second way of asking for a clip is how the
 * two come to disagree about what they asked for.
 */
async function repairGenerator(request, opts) {
    const o = opts || {};
    const gen = request || {};
    const spec = (gen.plan && gen.plan.generate) || {};
    const images = Array.isArray(gen.images) ? gen.images : [];
    if (images.length !== 2) {
        return { ok: false, reason: `a repair travels between exactly two frames; ${images.length} were given` };
    }

    let provider = o.provider;
    if (!provider) {
        try {
            const { resolve } = require('./providers');
            /*
             * `providerConfigOf`, NOT `parseProjectConfig`. The latter is a
             * stale name that survives only in a COMMENT in usage-meter.js, and
             * I copied it from there — so this threw on every real call and the
             * runner reported "no video provider could be resolved", which
             * reads as a configuration problem rather than a typo. The unit
             * test injected a provider and never walked this path; only running
             * it against a real project found it.
             */
            const { providerConfigOf } = require('./provider-config');
            provider = resolve('video', providerConfigOf(gen.projectId));
        } catch (err) {
            return { ok: false, reason: `no video provider could be resolved: ${err.message}` };
        }
    }

    const payload = {
        workflow: 'first-last-frame',
        // Ordered. [0] starts, [1] arrives.
        keyframes: images.map((uri, i) => ({ uri, position: i === 0 ? 'first' : 'last' })),
        duration: spec.durationSeconds,
        resolution: spec.resolution,
        ...(spec.width ? { width: spec.width, height: spec.height } : {}),
        prompt: gen.prompt || 'Continue the action between these two frames, matching the surrounding shot.',
    };

    let result;
    try {
        result = await provider.generate('video', payload, { timeout: 900000 });
    } catch (err) {
        /*
         * A REASON, NEVER A THROW. The runner names the stage that failed, and
         * a provider exception escaping here would surface as a generic error
         * from whichever stage happened to be on the stack.
         */
        return { ok: false, reason: `the provider refused: ${err.message}` };
    }
    if (!result || (result.ok === false)) {
        return { ok: false, reason: (result && (result.reason || result.error)) || 'the provider returned nothing' };
    }

    try {
        const persist = o.persist || (async (data) => {
            const { persistProviderMedia } = require('./provider-media');
            return persistProviderMedia(gen.projectId, 'video',
                `repair_${Date.now().toString(36)}.mp4`, data, { serveDir: 'videos' });
        });
        const stored = await persist(result.data || result, result);
        return { ok: true, path: stored, jobId: result.jobId || result.id || null };
    } catch (err) {
        // The generation SUCCEEDED and was billed; failing to store it is a
        // different problem and must say so, or the spend looks like a refusal.
        return { ok: false, reason: `the repair generated but could not be stored: ${err.message}` };
    }
}

/**
 * RUN A BRIDGE ACROSS A CUT.
 *
 * Deliberately NOT runRepair with a flag. The two produce different artefacts:
 * a repair rewrites one shot, a bridge produces a piece of footage that sits
 * BETWEEN two and rewrites neither. Threading a boolean through the splice
 * runner is exactly how "Bridge this cut" came to run a within-clip repair —
 * it succeeded, returned a version, spliced into the first shot, and told
 * nobody it had done the wrong operation.
 *
 * THE BRIDGE IS NOT SHOT FOOTAGE. It is registered as `other` with
 * `metadata.kind = 'bridge'`, the same shape the 3D work uses, and that is
 * load-bearing rather than tidy: `video_raw`/`video_final` are what the
 * timeline, the conform and all three NLE exporters select on, so a bridge
 * filed as one would appear in the cut IN ADDITION to the two shots it is
 * meant to replace part of. `other` is in the asset_type CHECK; a value the
 * CHECK refuses turns a paid generation into a failed step.
 *
 * NEITHER SOURCE IS TOUCHED. What comes back is the bridge plus two trim
 * points — where to cut each shot — because deciding which of the two shots to
 * absorb it into is a claim about which one was at fault, and the premise is
 * that neither was.
 */
const BRIDGE_STAGES = Object.freeze([
    { id: 'plan', why: 'the geometry, the floor and the cost, before anything is spent' },
    { id: 'budget', why: 'the gate belongs with the thing that spends' },
    { id: 'extract', why: 'one frame from EACH shot — the only stage that reads two different files' },
    { id: 'host', why: 'the provider fetches over http(s) and refuses data URIs' },
    { id: 'generate', why: 'the only step that costs money' },
    { id: 'deliver', why: 'conform the result to the shots it sits between, and say where to cut them' },
]);

async function runBridge(input) {
    const o = input || {};
    const scope = o.scope || `bridge-${crypto.randomBytes(8).toString('hex')}`;
    const minted = [];
    const scratch = [];
    /*
     * The stage currently running, so a THROWN error names where it happened.
     * Reporting everything as 'plan' would break the one promise this runner
     * makes — that a failure tells you which of six steps went wrong — and it
     * did: an undefined import in `deliver` came back as a plan failure.
     */
    let at = 'plan';
    const fail = (stage, reason, extra) =>
        ({ ok: false, stage, reason, handles: minted.slice(), ...(extra || {}) });

    try {
        /* 1 · plan — owns every rule about a span across a cut. */
        const { planBridge } = require('./repair-bridge');
        const plan = planBridge({ spans: o.spans, resolution: o.resolution, fps: o.fps });
        if (plan.refused) return fail('plan', plan.reason, { code: plan.code });

        at = 'budget';
        /* 2 · budget — BEFORE the generator, never after. */
        if (!o.ignoreBudget && o.db && o.projectId) {
            let status = null;
            try { status = budgetStatus(o.db, o.projectId, plan.cost.usd); } catch (_) { status = null; }
            if (status && status.wouldExceed) {
                return fail('budget',
                    `This bridge projects $${plan.cost.usd.toFixed(2)} and the project has `
                    + `$${status.remaining.toFixed(2)} left. Raise the budget, mark closer to the cut, `
                    + 'or pass ignore_budget.', { code: 'over_budget', budget: status });
            }
        }

        const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fe-bridge-'));

        at = 'extract';
        /* 3 · extract — ONE FRAME FROM EACH SHOT. The only stage that reads two files. */
        const cut = o.extractFrame || extractFrame;
        const frames = [];
        for (const f of plan.extract) {
            const out = o.projectId
                ? (ensureDir(o.projectId, 'repairs'),
                   getFilePath(o.projectId, 'repairs', `${scope}-${f.role}.png`))
                : path.join(work, `${f.role}.png`);
            const got = cut(f.sourcePath, { atSeconds: f.atSeconds, out });
            if (!got.ok) {
                return fail('extract',
                    `the ${f.role} frame of ${f.shot_code} at ${f.atSeconds}s could not be taken: ${got.reason}`);
            }
            if (got.fellBack) {
                return fail('extract',
                    `the ${f.role} frame of ${f.shot_code} at ${f.atSeconds}s is past the end of that `
                    + 'clip, so the frame taken would be its start. Re-mark against its real length.');
            }
            frames.push(got.path);
            scratch.push(got.path);
        }

        /* 4 · host — the provider cannot read our disk. */
        const urls = [];
        for (const p2 of frames) {
            const h = mintHandle(p2, { scope, publicBase: o.publicBase });
            if (!h.ok) return fail('host', h.reason, { code: h.code });
            minted.push(h.id);
            urls.push(h.url);
        }

        /* 5 · generate — the only step that spends. */
        if (typeof o.generate !== 'function') return fail('generate', 'no generator was supplied');
        let made;
        try {
            made = await o.generate({ images: urls, plan, scope, projectId: o.projectId });
        } catch (err) { return fail('generate', `the provider call failed: ${err.message}`); }
        if (!made || !made.ok || !made.path || !fs.existsSync(made.path)) {
            return fail('generate', (made && made.reason) || 'the provider returned no clip');
        }

        at = 'deliver';
        /* 6 · deliver — conform to the shots it sits between; rewrite neither. */
        const first = (o.spans && o.spans[0]) || {};
        const srcInfo = inspectMedia(first.sourcePath || '');
        const name = `bridge_${(first.shotCode || first.shot_code || 'cut')}_${Date.now().toString(36)}.mp4`;
        const outPath = o.projectId
            ? (ensureDir(o.projectId, 'video'), getFilePath(o.projectId, 'video', name))
            : path.join(o.outputDir || work, name);

        const found = resolveFfmpeg();
        if (!found.available) return fail('deliver', found.reason);
        const repInfo = inspectMedia(made.path);
        if (srcInfo.ok && repInfo.ok
            && (repInfo.width !== srcInfo.width || repInfo.height !== srcInfo.height)) {
            // Same reason the splice conforms: the provider is free to ignore
            // the raster we asked for, and a bridge that does not match the
            // shots either side is a seam you cannot cut around.
            const vf = `scale=${srcInfo.width}:${srcInfo.height}:force_original_aspect_ratio=decrease,`
                + `pad=${srcInfo.width}:${srcInfo.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
            const run = await probe(found.bin, ['-y', '-loglevel', 'error', '-i', made.path,
                '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
                '-r', String(plan.fps), outPath], { timeoutMs: 10 * 60 * 1000 });
            if (run.code !== 0 || !fs.existsSync(outPath)) {
                return fail('deliver', `the bridge could not be conformed to ${srcInfo.width}x${srcInfo.height}`);
            }
        } else {
            fs.copyFileSync(made.path, outPath);
        }

        if (o.db && o.projectId) {
            try {
                o.db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, asset_type, file_path, file_name, format, mime_type,
                        duration_ms, version, license_source, license_status, metadata
                     ) VALUES (?, ?, 'other', ?, ?, 'mp4', 'video/mp4', ?, 1, 'generated', 'generated', ?)`
                ).run(crypto.randomUUID(), o.projectId, outPath, name,
                    Math.round(plan.cost.seconds * 1000),
                    JSON.stringify({ kind: 'bridge', between: plan.delivery.between,
                        trim: plan.delivery.trim, scope }));
            } catch (err) {
                return fail('deliver', `the bridge was produced at ${outPath} but could not be `
                    + `registered: ${err.message}`, { output: outPath });
            }
        }

        return {
            ok: true, output: outPath, scope, handles: minted,
            assetType: 'other', kind: 'bridge',
            between: plan.delivery.between,
            trim: plan.delivery.trim,
            note: plan.delivery.note,
            cost: plan.cost,
            stages: BRIDGE_STAGES.map(s2 => s2.id),
        };
    } catch (err) {
        /*
         * DEFENCE IN DEPTH, and stated as such because mutation proved it: every
         * stage that can fail in a foreseeable way returns fail(<its own stage>)
         * explicitly and is covered, so this catch only ever sees an UNEXPECTED
         * throw. Removing the `at` tracking changes nothing any test can see —
         * which is exactly the kind of thing that gets quietly dressed up as
         * coverage. It is kept because it already earned its place once: an
         * undefined import in the delivery stage came back reported as a
         * PLANNING failure, sending a reader to the marks instead of the code.
         */
        return fail(at, `the bridge could not be run: ${err.message}`);
    } finally {
        try { revokeScope(scope); } catch (_) { /* expires anyway */ }
        for (const p2 of scratch) { try { fs.unlinkSync(p2); } catch (_) { /* already gone */ } }
    }
}

module.exports = { runRepair, REPAIR_STAGES, repairGenerator, runBridge, BRIDGE_STAGES };
