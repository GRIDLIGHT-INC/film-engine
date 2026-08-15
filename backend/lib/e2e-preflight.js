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

    if (!isProviderConfigured(effective)) {
        out.verdict = 'blocked';
        out.reasons.push(`'${effective}' has no credential`);
        out.fixes.push(`set ${effective.toUpperCase()}_API_KEY, or store the key in Provider Settings`);
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

module.exports = { preflight, stages, checkCapability, reachable, HANDOFF, LOCAL_STAGES, HEAD_STAGES, TAIL_STAGES, GRIDLIGHT_URL };
