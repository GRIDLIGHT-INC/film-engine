/**
 * End-to-end preflight: can a screenplay actually reach a finished shot right now?
 *
 * Every stage between "paste a screenplay" and "watch the shot" either runs
 * locally or resolves a provider, and a provider is only real if it exists in
 * the registry, holds a credential, and answers. Discovering which one of those
 * is false at the moment you need it is the expensive way to find out, so this
 * checks all of them before anything is spent.
 *
 * The generation stages are DERIVED from PIPELINE_STEPS and STEP_CAPABILITY
 * rather than listed here: a tenth pipeline step must not be able to appear
 * without this preflight noticing it. The five non-generative stages are
 * declared, because they have no registry to iterate.
 *
 * Nothing here generates. It reads configuration and opens sockets.
 */

const { PIPELINE_STEPS } = require('./pipeline-engine');
const { STEP_CAPABILITY } = require('../routes/pipeline');
const { resolveId, resolveGenerator, isProviderConfigured, get: getAdapter } = require('./providers');

const GRIDLIGHT_URL = process.env.GRIDLIGHT_URL || 'http://localhost:8080';

/**
 * Stages finished outside the engine.
 *
 * Lip-sync, grade and mix are done in Premiere against the exported lanes
 * rather than generated here — a deliberate division of labour, not a gap, so
 * reporting them as blocked would be noise. The honesty condition is that the
 * export must actually carry the material: `lib/nle-export.js` lays every
 * element on its own lane, and tests/nle-export.test.js iterates AUDIO_LANES to
 * prove each one arrives in both FCPXML and Premiere XML. Without that, this
 * map would just be a way of not counting the failures.
 *
 * Pass `inEngine: true` to demand these run here instead.
 */
const HANDOFF = {
    lipsync: 'performed in the NLE or by a third-party lip-sync provider',
    post: 'graded and finished in the NLE',
    mix: 'mixed in the NLE from the exported dialogue/music/SFX/ambient lanes',
};

/** Stages that run in this process. They fail on bugs, never on configuration. */
const LOCAL_STAGES = [
    { id: 'project', name: 'Create project', after: null },
    { id: 'script', name: 'Upload + parse screenplay (Fountain)', after: 'project' },
    { id: 'shots', name: 'Scenes + shots + scene cards', after: 'breakdown' },
];

/** Stages after the pipeline that still have to work for "final" to mean anything. */
const TAIL_STAGES = [
    // assembly is local (routes/pipeline.js:180 handles it in-process), but the
    // mix is not: it POSTs /audio/mix to Gridlight like any generator.
    { id: 'mix', name: 'Audio mix (dialogue/music/sfx/ambient + ducking)', service: 'gridlight', endpoint: '/audio/mix' },
    { id: 'export', name: 'NLE export (FCPXML / EDL / Premiere)', local: true },
];

/** The breakdown is a generation stage even though it makes no media. */
const HEAD_STAGES = [
    { id: 'breakdown', name: 'AI screenplay breakdown', capability: 'llm', after: 'script' },
];

/** External runtime dependencies for otherwise-local pipeline steps. */
const STEP_EXTERNAL_DEPENDENCY = {
    assembly: 'ffmpeg',
};

/**
 * How each declared dependency is checked, and how its presence is resolved.
 *
 * A dependency declared above and absent here must read as BLOCKED, never as
 * ready: the preflight used to key its one dependency branch on the literal
 * 'ffmpeg', so a second declared dependency would have fallen through to the
 * default verdict of 'go' with nothing to say otherwise. `resolve` is what a
 * test swaps to make the encoder disappear on a machine that has one — the
 * probe caches an available answer for the life of the process, so there is
 * no other way to exercise the blocked path.
 */
const DEPENDENCY_CHECKS = {
    /*
     * Not a STEP dependency: the music step needs it only on a project whose
     * music resolves to the local renderer (GRD-3995), so it is consulted from
     * checkCapability through ADAPTER_DEPENDENCY rather than declared on the
     * step, where it would block every project's music stage.
     */
    fluidsynth: {
        what: 'a MIDI renderer, a SoundFont whose licence is known, and an encoder, to play a cue\u2019s notes through instruments',
        resolve: () => require('./instrument-render').availability(),
        check: resolve => checkInstrumentDependency(resolve),
    },
    ffmpeg: {
        what: 'an encoder to join the shot masters into one film',
        resolve: () => require('./ffmpeg').resolveFfmpeg(),
        check: resolve => checkConformDependency(resolve),
    },
};

/** Which provider runs on something this machine must have installed. */
const ADAPTER_DEPENDENCY = { fluidsynth: 'fluidsynth' };

/** The local renderer's verdict, in the shape checkConformDependency returns. */
function checkInstrumentDependency(resolve = () => require('./instrument-render').availability()) {
    let av;
    try { av = resolve(); } catch (err) {
        return { verdict: 'blocked', reasons: [`instrument probe failed: ${err.message}`], fixes: ['reinstall FluidSynth and check FILM_SOUNDFONT'] };
    }
    if (!av || !av.ok) {
        return { verdict: 'blocked', reasons: (av && av.reasons) || ['the instrument renderer is not available'], fixes: (av && av.fixes) || [] };
    }
    return { verdict: 'go', reasons: [`FluidSynth is available with ${av.soundfont.library} (${av.soundfont.license}).`], fixes: [] };
}

/** The verdict for one declared dependency. Never throws. */
function checkDependency(dependency, resolvers) {
    const entry = DEPENDENCY_CHECKS[dependency];
    if (!entry) {
        return {
            dependency, verdict: 'blocked',
            reasons: [`'${dependency}' is declared as a runtime dependency and nothing knows how to check it`],
            fixes: [`register a checker for '${dependency}' in lib/e2e-preflight.js DEPENDENCY_CHECKS`],
        };
    }
    const resolve = (resolvers && resolvers[dependency]) || entry.resolve;
    return { dependency, ...entry.check(resolve) };
}

/** The verdict for a stage's declared dependency, or null when it has none. */
function checkStageDependency(stageId, resolvers) {
    const dependency = STEP_EXTERNAL_DEPENDENCY[stageId];
    return dependency ? checkDependency(dependency, resolvers) : null;
}

/**
 * The complete ordered stage list.
 *
 * @param {object} projectConfig  the project's provider_config
 */
function stages() {
    const generation = PIPELINE_STEPS.map(step => ({
        id: step.id,
        name: step.name,
        capability: STEP_CAPABILITY[step.id] || null,   // assembly has none — local
        externalDependency: STEP_EXTERNAL_DEPENDENCY[step.id] || null,
        scope: step.scope,
        depends: step.depends,
    }));

    return [
        LOCAL_STAGES[0],
        LOCAL_STAGES[1],
        HEAD_STAGES[0],
        LOCAL_STAGES[2],
        ...generation,
        ...TAIL_STAGES,
    ];
}

/** Probe the exact encoder resolver used by conform execution. Never throws. */
function checkConformDependency(resolve = () => require('./ffmpeg').resolveFfmpeg()) {
    let encoder;
    try {
        encoder = resolve();
    } catch (err) {
        return {
            verdict: 'blocked',
            reasons: [`FFmpeg probe failed: ${err.message}`],
            fixes: ['Set FFMPEG_PATH, install FFmpeg on the system PATH, or reinstall ffmpeg-static.'],
        };
    }

    if (!encoder || !encoder.available) {
        return {
            verdict: 'blocked',
            reasons: [(encoder && encoder.reason) || 'No encoder available.'],
            fixes: ['Set FFMPEG_PATH, install FFmpeg on the system PATH, or reinstall ffmpeg-static.'],
        };
    }

    const where = encoder.source === 'env' ? 'FFMPEG_PATH'
        : encoder.source === 'bundled' ? 'the bundled ffmpeg-static binary'
            : 'the system PATH';
    return {
        verdict: 'go',
        reasons: [`FFmpeg is available from ${where}.`],
        fixes: [],
    };
}

/** Can we open a TCP connection and get an HTTP answer, any answer? */
function reachable(url, timeoutMs = 2500) {
    return new Promise(resolve => {
        let settled = false;
        const done = v => { if (!settled) { settled = true; resolve(v); } };

        let lib, target;
        try {
            target = new URL(url);
            lib = target.protocol === 'https:' ? require('https') : require('http');
        } catch (err) {
            return done({ ok: false, reason: `invalid URL: ${url}` });
        }

        const req = lib.request(
            { method: 'GET', hostname: target.hostname, port: target.port, path: target.pathname || '/', timeout: timeoutMs },
            res => { res.resume(); done({ ok: true, status: res.statusCode }); }
        );
        req.on('timeout', () => { req.destroy(); done({ ok: false, reason: `no answer within ${timeoutMs}ms` }); });
        req.on('error', err => done({ ok: false, reason: err.code || err.message }));
        req.end();
    });
}

/**
 * Resolve one capability all the way to a verdict.
 *
 * The subtlety worth catching: resolve() falls back to the default provider
 * when the configured one is unknown, so a project pointing at a DELETED
 * provider looks healthy from the outside — it silently becomes Gridlight. That
 * fallback is right at runtime and wrong to stay quiet about here.
 */
async function checkCapability(capability, projectConfig, cache) {
    const requested = (projectConfig || {})[capability] || null;
    const requestedExists = requested ? !!getAdapter(requested) : true;

    // resolveId reports what the CONFIG asks for, which for a deleted provider
    // is a name nothing answers to. resolveGenerator reports what would really
    // run, after the fallback. The gap between the two is the whole finding.
    const configured = resolveId(capability, projectConfig || {});
    const adapter = resolveGenerator(capability, projectConfig || {});
    const effective = adapter ? adapter.id : configured;

    const out = { capability, requested, configured, effective, verdict: 'go', reasons: [], fixes: [] };

    // A provider that exists but does not serve this capability falls back just
    // as silently as a deleted one -- and is harder to spot, because the
    // fallback target may itself be perfectly healthy. Checking only the
    // EFFECTIVE adapter (below) misses it entirely: point video at meshy and
    // the report reads 'go' as long as gridlight happens to be up.
    const requestedAdapter = requested ? getAdapter(requested) : null;
    const requestedServes = !requestedAdapter
        || (requestedAdapter.supports && requestedAdapter.supports(capability));

    if (requested && requestedExists && !requestedServes) {
        out.verdict = 'blocked';
        out.reasons.push(`provider '${requested}' is configured for '${capability}' but does not serve it; requests silently fall back to '${effective}'`);
        out.fixes.push(`repoint ${capability} at a provider that serves it`);
    }

    if (requested && !requestedExists) {
        out.verdict = 'blocked';
        out.reasons.push(`provider '${requested}' is configured but is not registered; requests silently fall back to '${effective}'`);
        out.fixes.push(`repoint ${capability} away from '${requested}' (registered: ${require('./providers').list().map(a => a.id).join(', ')})`);
    }

    if (!adapter) {
        out.verdict = 'blocked';
        out.reasons.push(`no adapter registered for '${configured}', and no fallback available`);
        return out;
    }

    if (!adapter.supports || !adapter.supports(capability)) {
        out.verdict = 'blocked';
        out.reasons.push(`'${effective}' does not serve the '${capability}' capability`);
        out.fixes.push(`point ${capability} at a provider that serves it`);
    }

    /*
     * NOTHING serves it.
     *
     * resolveId answers null once the local gateway is off and no hosted
     * adapter is credentialed. That is a different report from "the provider
     * has no key": there is no provider to give a key to.
     */
    if (!effective) {
        out.verdict = 'blocked';
        out.reasons.push(`nothing is configured to generate '${capability}'`);
        out.fixes.push(`add a key for a provider that serves ${capability}, `
            + 'or switch on the local Gridlight endpoints in Settings');
        return out;
    }

    /*
     * A local renderer has no credential to be missing. What it can lack is the
     * software it runs on, and saying "has no credential" sends someone looking
     * for a key that does not exist.
     */
    if (ADAPTER_DEPENDENCY[effective]) {
        const dep = checkDependency(ADAPTER_DEPENDENCY[effective], cache && cache.resolvers);
        if (dep.verdict !== 'go') {
            out.verdict = 'blocked';
            out.reasons.push(...dep.reasons);
            out.fixes.push(...dep.fixes);
        }
        return out;
    }

    if (!isProviderConfigured(effective)) {
        out.verdict = 'blocked';
        // A keyless local service is not missing a credential — it is switched
        // off, and telling someone to set GRIDLIGHT_API_KEY sends them looking
        // for a key that does not exist.
        if (effective === 'gridlight') {
            out.reasons.push('the local Gridlight endpoints are switched off');
            out.fixes.push('turn them on in Settings, or point '
                + `${capability} at a hosted provider`);
        } else {
            out.reasons.push(`'${effective}' has no credential`);
            out.fixes.push(`set ${effective.toUpperCase()}_API_KEY, or store the key in Provider Settings`);
        }
    }

    // Gridlight is a local service rather than a hosted API: having no key is
    // normal, being switched off is not.
    if (effective === 'gridlight') {
        if (!cache.gridlight) cache.gridlight = await reachable(GRIDLIGHT_URL);
        if (!cache.gridlight.ok) {
            out.verdict = 'blocked';
            out.reasons.push(`Gridlight at ${GRIDLIGHT_URL} is not answering (${cache.gridlight.reason})`);
            out.fixes.push(`start Gridlight, or point ${capability} at a hosted provider`);
        }
    }

    return out;
}

/**
 * Run the whole preflight.
 *
 * @param {object} opts
 * @param {object} opts.projectConfig  parsed film_projects.provider_config
 * @param {boolean} opts.hasDialogue   whether the test screenplay has dialogue;
 *                                     without it voice+lipsync auto-skip and
 *                                     stop being blockers
 * @param {object}  [opts.resolvers]   per-dependency resolver overrides, so the
 *                                     blocked path can be exercised on a machine
 *                                     that has the dependency
 * @returns {{ ready: boolean, stages: object[], blocked: object[], summary: object }}
 */
async function preflight(opts) {
    const options = opts || {};
    const projectConfig = options.projectConfig || {};
    const hasDialogue = options.hasDialogue !== false;
    const inEngine = options.inEngine === true;
    const cache = {};

    const results = [];
    for (const stage of stages()) {
        const row = { id: stage.id, name: stage.name, verdict: 'go', reasons: [], fixes: [], capability: stage.capability || null };

        if (!inEngine && HANDOFF[stage.id]) {
            row.verdict = 'handoff';
            row.reasons.push(HANDOFF[stage.id]);
        } else if (stage.capability) {
            const cap = await checkCapability(stage.capability, projectConfig, cache);
            Object.assign(row, {
                verdict: cap.verdict, reasons: cap.reasons, fixes: cap.fixes,
                requested: cap.requested, effective: cap.effective,
            });

            // A shot with no dialogue skips voice and lipsync by design
            // (pipeline-engine.js:autoSkipSteps), so a blocked provider there is
            // not a blocker for THIS run — but saying "go" would be a lie.
            if (!hasDialogue && (stage.id === 'voice' || stage.id === 'lipsync') && row.verdict === 'blocked') {
                row.verdict = 'skipped';
                row.reasons.unshift('auto-skipped: the screenplay has no dialogue');
            }
        } else if (stage.service === 'gridlight') {
            if (!cache.gridlight) cache.gridlight = await reachable(GRIDLIGHT_URL);
            if (!cache.gridlight.ok) {
                row.verdict = 'blocked';
                row.reasons.push(`${stage.endpoint} is served by Gridlight at ${GRIDLIGHT_URL}, which is not answering (${cache.gridlight.reason})`);
                row.fixes.push('start Gridlight');
            }
        } else if (stage.externalDependency) {
            const dependency = checkDependency(stage.externalDependency, options.resolvers);
            row.verdict = dependency.verdict;
            row.dependency = dependency.dependency;
            row.reasons.push(...dependency.reasons);
            row.fixes.push(...dependency.fixes);
        }

        results.push(row);
    }

    const blocked = results.filter(r => r.verdict === 'blocked');
    return {
        ready: blocked.length === 0,
        stages: results,
        blocked,
        summary: {
            total: results.length,
            go: results.filter(r => r.verdict === 'go').length,
            skipped: results.filter(r => r.verdict === 'skipped').length,
            handoff: results.filter(r => r.verdict === 'handoff').length,
            blocked: blocked.length,
        },
    };
}

module.exports = {
    preflight, stages, checkCapability, checkConformDependency, checkInstrumentDependency, ADAPTER_DEPENDENCY, checkDependency, checkStageDependency, reachable,
    HANDOFF, LOCAL_STAGES, HEAD_STAGES, TAIL_STAGES, STEP_EXTERNAL_DEPENDENCY, DEPENDENCY_CHECKS,
    GRIDLIGHT_URL,
};
