/**
 * THE TEN RECOMMENDATIONS FROM THE RUNWAY READINESS VERDICT, AS A SET.
 *
 * The verdict listed ten changes to make before production spending. Five
 * hand-written tests already cover most of it — and five tests over ten
 * recommendations means a recommendation can be uncovered with nothing saying
 * so, which is the exact shape of failure the verdict itself is about: a
 * surface that looks complete while part of it reaches nothing.
 *
 * So the denominator is declared here, all ten, and each carries a probe that
 * asserts BEHAVIOUR rather than presence. "Declared but never consumed" is the
 * defect this codebase has now shipped four times — a preference table read by
 * nobody, mood-board specs stored and unused, a quality tier that could not
 * apply because a default already named a model. A catalogue of per-model rules
 * that nothing enforces would be the fifth.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-verdict-' + crypto.randomUUID().slice(0, 8));

const runway = require('../lib/providers/runway');
// ALL_ROUTE_TOOLS, not listTools(): the MCP-facing shape is {name, description,
// inputSchema} and carries no route, so asking it where a tool dispatches
// reports every route tool as broken.
const { listTools, ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');

const MODELS = runway.RUNWAY_VIDEO_MODELS;
const build = runway.buildVideoRequest || (runway._internal && runway._internal.buildVideoRequest);
const describe_ = runway.describeVideoRequest;

/** A payload shaped like the one a blocked, boarded shot really produces. */
function blockedShotPayload(over) {
    return {
        prompt: 'MAYA turns as the shadow crosses the road',
        init_image: 'data:image/png;base64,AAAA',
        duration_s: 5,
        target_resolution: '1920x1080',
        camera_control: {
            type: 'dolly-in',
            intensity: 0.5,
            path: [
                { position: [0, 1.6, 6], rotation: [0, 0, 0], focalMm: 35 },
                { position: [0, 1.6, 3], rotation: [0, 12, 0], focalMm: 35 },
            ],
        },
        ...(over || {}),
    };
}

/*
 * The ten, verbatim in intent, each with a probe that must actually run.
 *
 * `probe` returns null when satisfied, or a string saying what is wrong. A
 * recommendation with no probe is a hole and fails as one.
 */
const RECOMMENDATIONS = [
    {
        n: 1,
        what: 'storyboard_upload in MCP, so approved frames can be installed directly',
        probe() {
            const names = new Set(listTools().map(t => t.name));
            if (!names.has('storyboard_upload')) return 'no storyboard_upload tool';
            const tool = ALL_ROUTE_TOOLS.find(t => t.name === 'storyboard_upload');
            if (!tool || !tool.path) return 'storyboard_upload cannot dispatch — it declares no route';
            const p = tool.path({ shot_id: 'S', image: 'data:image/png;base64,AA' });
            if (!/\/storyboard\/import$/.test(p)) return `dispatches to ${p}, not the import route`;
            // It must carry the picture, or the tool is a route with no payload.
            const body = tool.body({ shot_id: 'S', image: 'data:image/png;base64,AA' });
            if (!body || !body.data) return 'the tool sends no image data';
            return null;
        },
    },
    {
        n: 2,
        what: 'the free preview shows the EXACT post-adapter Runway request and credits',
        probe() {
            /*
             * TWO keyframes, deliberately.
             *
             * With a single frame an understated count is invisible — count:1
             * is correct either way — so a probe built on one frame passes
             * while a preview that always claims one keyframe ships. Mutation
             * testing found exactly that hole in this check.
             */
            const payload = blockedShotPayload({
                keyframes: [
                    { uri: 'data:image/png;base64,AAAA', position: 'first' },
                    { uri: 'data:image/png;base64,BBBB', position: 'last' },
                ],
            });
            const built = build(payload);
            const desc = describe_(payload);
            if (!desc.outbound) return 'the preview exposes no outbound body';

            const sentKeys = Object.keys(built.body).sort();
            const shownKeys = Object.keys(desc.outbound).sort();
            if (sentKeys.join(',') !== shownKeys.join(',')) {
                return `field sets differ — sent [${sentKeys}], shown [${shownKeys}]`;
            }

            /*
             * IMAGE BYTES ARE REDACTED ON PURPOSE, and that redaction has to be
             * checked rather than exempted. A preview that printed the picture
             * would be megabytes of base64; one that describes it inaccurately
             * is worse than one that hides it, because "2 keyframes, first and
             * last" while a single frame travels is exactly the kind of quiet
             * overstatement this whole verdict is about.
             */
            for (const k of sentKeys) {
                const sent = built.body[k], shown = desc.outbound[k];
                if (k === 'promptImage') {
                    const frames = Array.isArray(sent) ? sent : [sent];
                    if (!shown || shown.kind !== 'image') return 'the image is neither sent nor described';
                    if (shown.count !== frames.length) {
                        return `preview claims ${shown.count} keyframe(s); ${frames.length} travel`;
                    }
                    const realPositions = frames.map(f => (f && f.position) || 'first');
                    if (JSON.stringify(shown.positions) !== JSON.stringify(realPositions)) {
                        return `preview claims positions ${JSON.stringify(shown.positions)}, `
                            + `actual ${JSON.stringify(realPositions)}`;
                    }
                    if (JSON.stringify(shown).includes('base64')) return 'image bytes leaked into the preview';
                    continue;
                }
                if (JSON.stringify(sent) !== JSON.stringify(shown)) {
                    return `${k} differs — sent ${JSON.stringify(sent)}, shown ${JSON.stringify(shown)}`;
                }
            }
            if (!(desc.estimated_credits > 0)) return 'no credit estimate';
            return null;
        },
    },
    {
        n: 3,
        what: 'no claim that the structured previs camera path is sent to Runway',
        probe() {
            const desc = describe_(blockedShotPayload());
            if ('camera_control' in (desc.outbound || {})) {
                return 'camera_control is in the outbound body Runway is told it receives';
            }
            const notes = (desc.notes || []).join(' ');
            if (!/prompt text|translated|does not receive/i.test(notes)) {
                return 'the preview never says the path is translated rather than sent';
            }
            return null;
        },
    },
    {
        n: 4,
        what: 'the approved path becomes natural-language camera choreography',
        probe() {
            const withPath = build(blockedShotPayload()).body.promptText;
            const without = build(blockedShotPayload({ camera_control: undefined })).body.promptText;
            if (withPath === without) return 'a camera path changes nothing about what is sent';
            if (!/camera|dolly|push|move|arc|pan|tilt/i.test(withPath)) {
                return `the path produced no camera language: ${withPath.slice(0, 120)}`;
            }
            return null;
        },
    },
    {
        n: 5,
        what: 'a Runway-specific motion prompt builder, not the storyboard prompt forwarded',
        probe() {
            if (typeof runway.buildRunwayMotionPrompt !== 'function') return 'no motion prompt builder';
            const motion = runway.buildRunwayMotionPrompt(blockedShotPayload());
            if (!motion || motion.length < 10) return 'the motion builder produced nothing';
            // It must not be the image prompt: an image prompt leads with the look.
            if (/\b(lens|mm|aperture|f\/|photoreal|cinematic still)\b/i.test(motion)) {
                return `motion prompt is redescribing the frame: ${motion.slice(0, 120)}`;
            }
            return null;
        },
    },
    {
        n: 6,
        what: 'per-model parameter validation, not one generic duration/ratio policy',
        probe() {
            // BEHAVIOURAL: two models with different documented windows must
            // clamp the same request differently, or the table is decoration.
            // Runway's schema: gen4.5 takes 2-10, veo3.1 only 4, 6 or 8.
            const gen45 = build(blockedShotPayload({ model: 'gen4.5', duration_s: 3 })).body;
            const veo31 = build(blockedShotPayload({ model: 'veo3.1', duration_s: 3 })).body;
            if (gen45.duration === veo31.duration) {
                return `gen4.5 allows 2-10 and veo3.1 only 4, 6 or 8, but 3s became `
                    + `${gen45.duration}s on both — one policy is being applied to every model`;
            }
            // And a ratio a model does not document must not be sent to it.
            const veo = build(blockedShotPayload({ model: 'veo3.1', aspect_ratio: '1104:832' })).body;
            if (!MODELS['veo3.1'].ratios.includes(veo.ratio)) {
                return `veo3.1 was sent ${veo.ratio}, which it does not document`;
            }
            return null;
        },
    },
    {
        n: 7,
        what: 'the model catalogue is current and every entry states its status and source',
        probe() {
            const gaps = [];
            for (const [id, m] of Object.entries(MODELS)) {
                if (!m.status) gaps.push(`${id}: no status`);
                if (!m.source) gaps.push(`${id}: no source`);
                if (!m.duration || !(m.duration.max > 0)) gaps.push(`${id}: no duration window`);
                /*
                 * A model must state what shapes it can produce — but not
                 * necessarily in `ratios`. On video_to_video Runway DEPRECATES
                 * `ratio` in favour of a `targetAspectRatio` enum, so demanding
                 * a ratios list there would force a second copy of a field the
                 * provider is retiring. Either list satisfies the intent; an
                 * entry with neither does not.
                 */
                const shapes = (Array.isArray(m.ratios) && m.ratios.length)
                    || (Array.isArray(m.targetAspectRatios) && m.targetAspectRatios.length)
                    // Sized by its resolution field: the shape follows the picture.
                    || (m.sizedBy === 'resolution' && m.resolutions && Object.keys(m.resolutions).length);
                if (!shapes) gaps.push(`${id}: no ratio or targetAspectRatio list`);
                if (!(m.creditsPerSecond > 0)) gaps.push(`${id}: no credit rate`);
            }
            // The ids the live API documents for image-to-video.
            for (const id of ['gen4.5', 'veo3.1', 'seedance2', 'gemini_omni_flash']) {
                if (!MODELS[id]) gaps.push(`${id} is documented by Runway and absent here`);
            }
            return gaps.length ? gaps.join('; ') : null;
        },
    },
    {
        n: 8,
        what: 'sequence leg duration comes from shot timing, not a hardcoded five seconds',
        probe() {
            const { planSequence } = require('../lib/video-sequence');
            const shots = [
                { shot_code: '3A', duration_ms: 2000, keyframe: 'a.png' },
                { shot_code: '3B', duration_ms: 8000, keyframe: 'b.png' },
                { shot_code: '3C', duration_ms: 8000, keyframe: 'c.png' },
            ];
            const plan = planSequence(shots, { maxKeyframes: 2, description: 'a continuous move' });
            const segs = plan.segments || [];
            if (segs.length !== 2) return `expected 2 segments from 3 shots, got ${segs.length}`;
            const durations = segs.map(s => s.duration_s);
            if (durations.every(d => d === durations[0])) {
                return `both legs are ${durations[0]}s despite the shots being 2s and 8s — `
                    + 'the leg length is not coming from the director’s timing';
            }
            return null;
        },
    },
    {
        n: 9,
        what: 'legs can be approved and purchased one at a time',
        probe() {
            const src = require('fs').readFileSync(
                path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');
            // A staged buy needs a way to name WHICH leg. Without it the only
            // option is the whole sequence, which is the thing being avoided.
            if (!/segment_index|leg_index|\bonly\b.*segment|segments?\s*:\s*\[/i.test(src)) {
                return 'no way to generate a single leg — the route buys the whole sequence or nothing';
            }
            return null;
        },
    },
    {
        n: 10,
        what: 'native multi-shot is a separate mode, not a replacement for per-shot rendering',
        probe() {
            const src = require('fs').readFileSync(
                path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');
            if (!/multi_shot_video/.test(src)) return 'the native recipe is not wired at all';
            if (!/generate-native/.test(src)) return 'no separate route — it would have to replace the deterministic path';
            /*
             * And it must not have taken over the ordinary path.
             *
             * Anchored on the FUNCTION, not on the dispatch line: `sub ===
             * 'generate'` is a prefix of `sub === 'generate-native'`, so
             * indexOf lands on whichever appears first and the check silently
             * examined the wrong branch. Mutation testing caught that — the
             * probe could not be made to fail.
             */
            const at = src.indexOf('function generateSequence(');
            if (at < 0) return 'the deterministic per-shot sequence generator is gone';
            /*
             * Bounded by the NEXT function, not by the native one: the native
             * generator is defined ABOVE this one in the file, so slicing
             * between them ran backwards and produced an empty string — the
             * probe could not fail whatever the code said. Mutation testing is
             * the only thing that finds a check like that.
             */
            const rest = src.slice(at + 20);
            const nextFn = rest.search(/\n(?:async )?function /);
            const ordinary = nextFn > 0 ? rest.slice(0, nextFn) : rest;
            if (/multi_shot_video/.test(ordinary)) {
                return 'the ordinary generate route now runs the native recipe, so per-shot determinism is gone';
            }
            return null;
        },
    },
];

test('every recommendation in the Runway readiness verdict is closed', () => {
    assert.strictEqual(RECOMMENDATIONS.length, 10,
        `the verdict listed ten recommendations; this set has ${RECOMMENDATIONS.length}`);

    const open = [];
    for (const rec of RECOMMENDATIONS) {
        assert.strictEqual(typeof rec.probe, 'function',
            `#${rec.n} has no probe, so it is uncovered rather than done`);
        let verdict;
        try { verdict = rec.probe(); }
        catch (err) { verdict = `probe threw: ${err.message}`; }
        if (verdict) open.push(`#${rec.n} ${rec.what}\n      ${verdict}`);
    }
    assert.deepStrictEqual(open, [],
        `${open.length} of ${RECOMMENDATIONS.length} recommendations are still open:\n  ${open.join('\n  ')}`);
});
