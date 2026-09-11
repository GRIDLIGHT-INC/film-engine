/**
 * FILM-090-093: Music & Sound Design Pipeline
 *
 * POST /film/scenes/:id/music/generate          - Generate score for a scene
 * POST /film/scenes/:id/music/generate/stream    - SSE streaming
 * POST /film/shots/:id/sfx/generate             - Generate SFX for a shot
 * POST /film/scenes/:id/ambient/generate        - Generate ambient for a scene
 * POST /film/projects/:id/music/batch           - Batch all music/SFX/ambient
 * POST /film/projects/:id/music/batch/stream    - SSE batch
 * GET  /film/projects/:id/music/jobs            - List all music jobs
 * GET  /film/music/:projectId/:filename         - Serve music files
 */

const { db, generateId } = require('../db/database');
const { callGridlight, serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir, serveFile } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { buildMusicPrompt, buildSFXPrompts, buildAmbientPrompt } = require('../lib/music-prompt');
const { buildMixPayload, calculateDucking, buildStemExport, generateSRT } = require('../lib/audio-mixer');
const { resolve, get } = require('../lib/providers');
const { providerConfigFor, spendContext } = require('../lib/provider-config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUSIC_ENDPOINT = '/music';
const MIX_ENDPOINT = '/audio/mix';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// One implementation, in lib/provider-config.js — it also tags the config
// with the project id so spend can be attributed. See that file for why.
const parseProjectConfig = providerConfigFor;

function resultModel(result, payload) {
    return (result && result.provider_model) || (payload && payload.model) || '';
}

function resultJobId(result) {
    return (result && result.provider_job_id) || '';
}


/**
 * What a director chose for THIS cue, as a provider-config overlay.
 *
 * Music, ambient and SFX read NO override at all: their confirmations showed a
 * prompt and offered no choice of generator whatever, while the image and
 * video paths had both. `spendContext` has always taken an overrides argument
 * -- nothing here ever passed one.
 */
function cueOverride(req, capability) {
    const { generationOverride } = require('../lib/generation-override');
    const src = { ...((req && req.query) || {}), ...((req && req.body) || {}) };
    return generationOverride(capability, src);
}

function resolveGenerator(capability, projectConfig) {
    const adapter = resolve(capability, projectConfig);
    if (adapter && typeof adapter.generate === 'function') return adapter;
    return get('gridlight');
}

function formatForResult(result) {
    const format = result && result.meta && result.meta.format ? result.meta.format : '';
    if (format) return format;
    const contentType = result && result.contentType ? result.contentType : '';
    if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
    return 'wav';
}

function mimeForResult(result) {
    return (result && result.contentType) || (formatForResult(result) === 'mp3' ? 'audio/mpeg' : 'audio/wav');
}

function filenameForResult(baseFilename, result) {
    const format = formatForResult(result);
    if (format === 'mp3') return baseFilename.replace(/\.[^.]+$/, '.mp3');
    return baseFilename.replace(/\.[^.]+$/, '.wav');
}

// -- Route Handler -------------------------------------------------------


/**
 * Generate the cue somebody WROTE, named directly.
 *
 * The gap this closes: `music_cue_create`, `_update`, `_list` and `music_brief`
 * all existed, and then there was nothing to generate with. So the only
 * generation surface an agent could see was `node_gen_music`, which derives its
 * own prompt from the scene and never reads the cue at all -- and reaching for
 * it produced a scene-derived bed instead of the orchestral score that had been
 * written out in full. Cue-authoring no tool can act on is the "capability with
 * no control" case, pointed the other way.
 *
 * ADDRESSED BY CUE, NOT BY SCENE, and that is the point. A scene holds several
 * cues at once; a scene-addressed route has to guess which one is meant, which
 * is the defect above one level up. Naming the cue removes the guess.
 *
 * It routes on the cue's OWN kind and goes through the SAME builders the briefs
 * and the scene routes use, so a cue previewed for free and a cue generated
 * cannot describe different music.
 */
async function generateFromCue(req, res, cueId) {
    const cue = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(cueId);
    if (!cue) return json(res, 404, { error: `No music cue ${cueId}` });
    if (!cue.scene_id) {
        return json(res, 400, {
            error: 'This cue is not attached to a scene, so there is no length or context to score it against.',
        });
    }
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(cue.scene_id);
    if (!scene) return json(res, 404, { error: 'The scene this cue belongs to is gone' });
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    /*
     * An SFX cue is refused rather than attempted. Sound effects are built from
     * the shot's own scene card by `buildSFXPrompts`, which takes a card and not
     * a cue -- there is no builder that could honour this row. Named, with the
     * route that does the job, because a refusal that does not say where to go
     * is indistinguishable from the feature being broken.
     */
    /*
     * SFX FROM THE CUE THAT WAS WRITTEN.
     *
     * This used to refuse, pointing at the shot route, and the reasoning was
     * sound as far as it went: effects are normally read from a shot's scene
     * card, and no builder took a cue. But a director who writes "a screen door
     * two streets over" on a cue wants THAT sound, and being sent to a different
     * route to describe it again is the feature not existing.
     *
     * It reuses `buildSFXPrompts` rather than growing a second prompt path — the
     * cue becomes a one-entry card, so a cue-written effect and a card-written
     * one cannot describe different sounds.
     */
    if (cue.cue_type === 'sfx') {
        const text = String(cue.description || cue.title || '').trim();
        if (!text) {
            return json(res, 400, {
                error: 'This sound effect cue has no description, so there is nothing to generate.',
                hint: 'Write what the sound is on the cue, then generate it.',
            });
        }
        const payloads = buildSFXPrompts({ sfx_cues: [{ description: text }] }, scene);
        if (!payloads.length) {
            return json(res, 400, { error: 'The cue produced no sound-effect payload.' });
        }
        const provider = resolveGenerator('sfx',
            spendContext({ id: scene.project_id }, null, scene, cueOverride(req, 'sfx')));
        return runCueGeneration(res, {
            cue, scene, provider, payload: payloads[0], genType: 'sfx',
            assetType: 'audio_sfx', suffix: 'sfx',
            durationMs: (payloads[0].duration_s || 0) * 1000,
        });
    }

    const { cueSeconds } = require('../lib/scene-score');
    const context = sceneScoreContext(scene);
    const length = cueSeconds({
        cue_ms: cue.duration_ms, cut_ms: context.cut_ms,
        dialogue_ms: context.dialogue_ms, explain: true,
    });

    // ---- Ambient ---------------------------------------------------------
    if (cue.cue_type === CUE_KIND_FOR.ambient) {
        const location = scene.location_id
            ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id)
            : null;
        const provider = resolveGenerator('ambient',
            spendContext({ id: scene.project_id }, null, scene, cueOverride(req, 'ambient')));
        // Through ambientOptions like every other bed, with the cue named.
        const payload = buildAmbientPrompt(scene, location, ambientOptions(scene, req.body, cue));
        return runCueGeneration(res, {
            cue, scene, provider, payload, genType: 'ambient',
            assetType: 'audio_ambient', suffix: 'ambient',
            durationMs: (payload.duration_s || 0) * 1000,
        });
    }

    // ---- Score, and the two music kinds beside it ------------------------
    let sections = [];
    try { sections = JSON.parse(cue.sections_json || '[]') || []; } catch (_) { sections = []; }
    const scored = {
        cue: { ...cue, sections: Array.isArray(sections) ? sections : [] },
        context, length, derived: false,
    };
    const built = musicPayloadFor(scored, scene, project);
    if (built.errors.length) return sectionRefusal(res, built.errors);

    const provider = resolveGenerator('music',
        spendContext({ id: scene.project_id }, null, scene, cueOverride(req, 'music')));
    return runCueGeneration(res, {
        cue, scene, provider, payload: built.payload, genType: 'score',
        assetType: 'audio_music', suffix: 'score',
        durationMs: (length.seconds || 0) * 1000,
    });
}

/**
 * Generate, store, register and LINK.
 *
 * The link is the part that was missing everywhere: `generated_asset_id` has
 * been on this table since migration 016 and was written by nothing, so a scene
 * could hold a cue and an audio file with no connection between them and "has
 * this cue been generated" had no answer.
 */
async function runCueGeneration(res, o) {
    const { cue, scene, provider, payload, genType, assetType, suffix, durationMs } = o;

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, gen_type, status, prompt, model, duration_ms)
         VALUES (?, ?, ?, ?, 'generating', ?, ?, ?)`
    ).run(jobId, scene.project_id, scene.id, genType, payload.prompt, payload.model, durationMs || null);

    try {
        const result = await provider.generate(genType === 'ambient' ? 'ambient' : 'music', payload, { timeout: 300000 });
        if (!result.ok) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', result.error, jobId);
            return json(res, result.status || 500, { error: result.error, cue_id: cue.id });
        }

        const filename = filenameForResult(`${scene.scene_number || scene.id}_${suffix}_${cue.id.slice(0, 8)}.wav`, result);
        ensureDir(scene.project_id, 'music');

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
        } catch (err) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', err.message, jobId);
            return json(res, 502, { error: `generated but could not be stored: ${err.message}`, cue_id: cue.id });
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, scene_id, asset_type, file_path, file_name,
                format, mime_type, duration_ms, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
        ).run(assetId, scene.project_id, scene.id, assetType, filePath, filename,
              formatForResult(result), mimeForResult(result), durationMs || null,
              provider.id, resultModel(result, payload), resultJobId(result));

        linkCueAsset(cue.id, assetId);
        db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?')
            .run('complete', filePath, jobId);

        return json(res, 200, {
            cue_id: cue.id, cue_type: cue.cue_type, cue_title: cue.title || null,
            scene_id: scene.id, job_id: jobId, status: 'complete',
            asset_id: assetId,
            generated_asset_id: assetId,
            url: getFileUrl('music', scene.project_id, filename),
            duration_s: durationMs ? Math.round(durationMs / 1000) : null,
            provider: provider.id,
            prompt: payload.prompt,
        });
    } catch (err) {
        db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
            .run('failed', err.message, jobId);
        return json(res, 500, { error: err.message, cue_id: cue.id });
    }
}

function handleMusicGen(req, res, urlParts, query) {
    // /film/music/:projectId/:filename
    if (urlParts[1] === 'music' && urlParts[2] && urlParts[3] && !['projects', 'scenes', 'shots'].includes(urlParts[1])) {
        return serveFile(res, urlParts[2], 'music', urlParts[3]);
    }

    // /film/music-cues/:id/generate — the cue somebody wrote, generated.
    if (urlParts[1] === 'music-cues' && urlParts[2] && urlParts[3] === 'generate') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
        return generateFromCue(req, res, urlParts[2]);
    }

    // /film/scenes/:id/music/generate[/stream]
    if (urlParts[1] === 'scenes' && urlParts[2] && urlParts[3] === 'music') {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) return json(res, 400, { error: 'Invalid scene ID' });

        // The brief is a SIBLING of generate, not a child of it: nested inside
        // the POST branch a GET could never reach it.
        if (urlParts[4] === 'brief' && req.method === 'GET') return musicBrief(req, res, sceneId);
        if (urlParts[4] === 'generate' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return generateMusicStream(req, res, sceneId);
            return generateMusic(req, res, sceneId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/scenes/:id/ambient/generate
    if (urlParts[1] === 'scenes' && urlParts[2] && urlParts[3] === 'ambient') {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) return json(res, 400, { error: 'Invalid scene ID' });

        if (urlParts[4] === 'generate' && req.method === 'POST') {
            return generateAmbient(req, res, sceneId);
        }
        // FREE: the bed this scene would be given, before it is bought.
        if (urlParts[4] === 'brief' && req.method === 'GET') {
            return ambientBrief(res, sceneId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/shots/:id/audio/mix  (FILM-093)
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'audio') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        if (urlParts[4] === 'mix' && req.method === 'POST') return mixShotAudio(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/shots/:id/sfx/generate
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'sfx') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        if (urlParts[4] === 'generate' && req.method === 'POST') {
            return generateSFX(req, res, shotId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/music[/batch[/stream] | /jobs]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'music') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'batch' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return batchMusicStream(req, res, projectId);
            return batchMusic(req, res, projectId);
        }
        if (sub === 'jobs' && req.method === 'GET') return listMusicJobs(req, res, projectId, query);
        if (sub === 'capabilities' && req.method === 'GET') {
            // Free. What this project's music provider can and cannot do, per
            // workflow, with limits, cost hints and the reason for every "no".
            const project = db.prepare('SELECT id, provider_config FROM film_projects WHERE id = ?').get(projectId);
            if (!project) return json(res, 404, { error: 'Project not found' });
            const { discoverMusicCapabilities } = require('../lib/music-capabilities');
            const { providerConfigOf } = require('../lib/provider-config');
            return json(res, 200, { project_id: projectId, ...discoverMusicCapabilities(providerConfigOf(project)) });
        }
        if (sub === 'mix' && req.method === 'POST') return mixProjectAudio(req, res, projectId);
        if (sub === 'stems' && req.method === 'POST') return exportStems(req, res, projectId);
        if (sub === 'srt' && req.method === 'GET') return exportSRT(req, res, projectId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Generate Music Score for a Scene ------------------------------------

/**
 * Everything the engine knows about a scene, for a score.
 *
 * Gathered here rather than at each call site, because three of them build a
 * music payload and only one of them getting the scene is how a batch comes
 * back as wallpaper while a single generation sounds right.
 */
function sceneScoreContext(scene) {
    const { sceneCutLength } = require('../lib/clip-coverage');
    const shots = db.prepare('SELECT id, scene_card_yaml FROM film_shots WHERE scene_id = ?').all(scene.id);

    let dialogueLines = 0;
    const cast = new Set();
    for (const shot of shots) {
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}') || {}; } catch (_) { card = {}; }
        for (const d of (card.dialogue || [])) {
            dialogueLines++;
            if (d.character) cast.add(String(d.character).toUpperCase());
        }
        for (const c of (card.characters || [])) {
            cast.add(String(typeof c === 'string' ? c : (c && c.name) || '').toUpperCase());
        }
    }
    cast.delete('');

    /*
     * A dialogue-only scene has a length too.
     *
     * sceneCutLength reads measured CLIPS, so a scene with no footage returns
     * null and the cue falls to thirty seconds. The Glass Harbour diner scene
     * has no clips and 216 seconds of measured dialogue — scoring it at 30
     * writes a cue for a scene that does not exist.
     */
    const dialogueMs = db.prepare(
        `SELECT COALESCE(SUM(a.duration_ms), 0) AS ms FROM film_assets a
           JOIN film_shots sh ON sh.id = a.shot_id
          WHERE sh.scene_id = ? AND a.asset_type = 'audio_dialogue'`).get(scene.id).ms || 0;

    return {
        characters: [...cast],
        dialogue_lines: dialogueLines,
        shot_count: shots.length,
        cut_ms: sceneCutLength(db, scene.id),
        dialogue_ms: dialogueMs,
    };
}

/**
 * WHICH KIND OF CUE A CAPABILITY GENERATES FROM.
 *
 * The score path selected its cue with `ORDER BY start_ms LIMIT 1` and NO KIND
 * FILTER. Every cue on a scene legitimately starts at 0 -- a score, a room tone
 * and a stinger all begin when the scene does -- so that is not a tie-break, it
 * is a coin toss: SQLite may return any row when the sort key is equal. On a
 * real scene carrying an ambient bed called "Lot Air" (crickets and highway)
 * beside an orchestral score, the crickets were used AS the score. Nothing
 * errored, the file played, and the only signal was a director listening to it.
 *
 * Stated once and read by every path, because the ambient lookups already
 * filtered correctly in TWO separate literals -- which is how the third one came
 * to have no filter at all and how a fourth would drift again.
 *
 * `source` and `transition` are deliberately NOT part of the score. Diegetic
 * music from a radio in shot, and a stinger across a cut, are different pieces
 * of music with different lengths and different jobs; folding them into "the
 * score" is the same conflation being fixed here, one step milder. They are
 * reported as declined rather than silently ignored.
 */
const CUE_KIND_FOR = Object.freeze({
    music: 'score',
    ambient: 'ambient',
    sfx: 'sfx',
});

/**
 * The one cue of a given kind, and everything on the scene that was NOT chosen.
 *
 * The second half matters as much as the first: deriving a score while an
 * ambient cue sits unused is CORRECT, and doing it silently is exactly what
 * made the original defect invisible. A caller that is told "there is a cue
 * here and it is not the kind I generate from" can act; one told nothing
 * assumes their direction was read.
 */
/**
 * Every cue of a kind on a scene, in the order they play.
 *
 * A scene is a CUE SHEET. `LIMIT 1` made it one sound per kind: a director who
 * wrote three effects, or a second score for the back half of a scene, got one
 * and was told nothing. The rows were always there — nothing selected them.
 */
function cuesOfKind(sceneId, kind) {
    return db.prepare(
        'SELECT * FROM film_music_cues WHERE scene_id = ? AND cue_type = ? ORDER BY start_ms, created_at, id'
    ).all(sceneId, kind);
}

/**
 * The cue a SCENE-LEVEL generate acts on, plus the ones it declined.
 *
 * Still one, and deliberately: "score this scene" is a single action and has to
 * pick. What changed is that the others are no longer invisible — `all` carries
 * the whole sheet, so a caller that wants every sound can have it.
 */
function cueOfKind(sceneId, kind) {
    const all = cuesOfKind(sceneId, kind);
    const chosen = all[0] || null;
    const others = db.prepare(
        'SELECT id, cue_type, title FROM film_music_cues WHERE scene_id = ? AND cue_type != ? ORDER BY start_ms'
    ).all(sceneId, kind);
    return { chosen, others, all };
}

/**
 * Record which asset a cue produced.
 *
 * `generated_asset_id` has been on film_music_cues since migration 016 and was
 * written by NOTHING -- so a scene could hold a cue and an audio file with no
 * link between them, and "has this cue been generated" had no answer at all.
 * Never throws: by the time this runs the audio exists and has been paid for,
 * and failing the request over the bookkeeping is the worst trade available.
 */
function linkCueAsset(cueId, assetId) {
    try {
        if (!cueId || !assetId) return false;
        db.prepare('UPDATE film_music_cues SET generated_asset_id = ? WHERE id = ?').run(assetId, cueId);
        return true;
    } catch (_) { return false; }
}

/**
 * The cue this scene is scored from.
 *
 * A cue somebody WROTE always wins — it is the musical direction, and deriving
 * over it would overrule the director. With no cue, the scene's own facts are
 * used rather than the defaults, which is the whole fix: the old fallback was
 * `mood: calm, genre: ambient` for every scene in every film.
 */
function cueForScene(scene, project, body) {
    const { scoreBrief, cueFromBrief, cueSeconds } = require('../lib/scene-score');
    const picked = cueOfKind(scene.id, CUE_KIND_FOR.music);
    const written = picked.chosen;
    const context = sceneScoreContext(scene);

    const length = cueSeconds({
        cue_ms: written && written.duration_ms,
        cut_ms: context.cut_ms,
        dialogue_ms: context.dialogue_ms,
        explain: true,
    });

    if (written) {
        // Sections come out of the row as JSON. Parsed here rather than at each
        // reader, so the brief, the preview and the generation cannot disagree
        // about the shape of the same cue.
        let sections = [];
        try { sections = JSON.parse(written.sections_json || '[]') || []; } catch (_) { sections = []; }
        return {
            cue: { ...written, sections: Array.isArray(sections) ? sections : [] },
            context, length, derived: false,
            other_cues: picked.others,
            brief: scoreBrief(scene, context, project),
        };
    }

    const brief = scoreBrief(scene, context, project);
    const derived = cueFromBrief(brief);
    // A body may still steer it: mood and genre are judgements, and a caller
    // saying "make it tense" must beat a derivation that had no opinion.
    if (body && body.mood) derived.mood = body.mood;
    if (body && body.genre) derived.genre = body.genre;
    if (body && body.description) derived.description = body.description;
    if (length.seconds) derived.duration_ms = length.seconds * 1000;

    return { cue: derived, context, length, derived: true, other_cues: picked.others, brief };
}

/**
 * A cue's payload, with its composition plan attached if it has sections.
 *
 * ONE builder for the free brief and for all three paid paths. Three sites built
 * this independently and the batch one did not even go through cueForScene — so
 * a scene generated from the Music page got the measured length and the same
 * scene generated from the batch got a thirty-second default. A preview built
 * differently from its purchase is worse than no preview, and this codebase has
 * paid for that once already on the refine path.
 */
function musicPayloadFor(scored, scene, project) {
    const { buildMusicPrompt } = require('../lib/music-prompt');
    const { validateSections, compositionPlan, sectionFit } = require('../lib/music-sections');

    const payload = buildMusicPrompt(scored.cue, scene, project);
    if (scored.length && scored.length.seconds) {
        payload.duration_s = scored.length.seconds;
        payload.duration_source = scored.length.source;
    }

    const raw = Array.isArray(scored.cue.sections) ? scored.cue.sections : [];
    if (!raw.length) return { payload, plan: null, fit: null, errors: [] };

    const checked = validateSections(raw);
    if (!checked.valid) return { payload, plan: null, fit: null, errors: checked.errors };

    payload.composition_plan = compositionPlan(
        payload.prompt_parts, checked.sections, payload.negative_prompt);
    // The plan carries the length: the provider refuses music_length_ms
    // alongside one, and the sections' own durations are what it honours.
    payload.duration_s = checked.total_ms / 1000;
    payload.duration_source = 'sections';
    return {
        payload, plan: payload.composition_plan,
        /*
         * Measured against the length this cue WOULD have had — the walk
         * cue → footage → dialogue → nothing — not against footage alone.
         * A dialogue scene with nothing shot yet has cut_ms 0, so comparing
         * against that reports "no difference" for a cue 162 seconds short of
         * its scene, which is worse than reporting nothing.
         */
        fit: {
            ...sectionFit(checked.sections, (scored.length && scored.length.seconds || 0) * 1000),
            cut_source: (scored.length && scored.length.source) || null,
        },
        errors: [],
    };
}

/**
 * A refusal that costs nothing, in the shape every paid path uses.
 */
function sectionRefusal(res, errors) {
    return json(res, 400, {
        error: "The cue's sections cannot be generated as written",
        errors,
        hint: 'Nothing was generated and nothing was charged. Fix the sections and try again.',
    });
}

/**
 * What this scene is, for somebody deciding what it should sound like.
 *
 * FREE, and it returns no conclusion. What a scene should sound like is a
 * judgement and the connected agent is the model here, so the engine assembles
 * the facts and validates the answer rather than asking a second LLM what the
 * music is. Write the answer back with music_cue_create.
 */
function musicBrief(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    const scored = cueForScene(scene, project, null);
    const sectionLimits = require('../lib/music-sections');
    const built = musicPayloadFor(scored, scene, project);
    const wouldSend = built.payload;

    return json(res, 200, {
        free: true,
        scene_id: sceneId,
        scene: {
            number: scene.scene_number,
            heading: `${scene.int_ext || ''} ${scene.location || ''} - ${scene.time_of_day || ''}`.trim(),
            description: scene.description || null,
        },
        facts: scored.brief.facts,
        length: scored.length,
        // What a cue somebody already wrote says, or null — so a model knows
        // whether it is writing the direction or reading it.
        existing_cue: scored.derived ? null : {
            mood: scored.cue.mood, genre: scored.cue.genre,
            description: scored.cue.description,
            reference_track: scored.cue.reference_track || null,
        },
        derived_description: scored.brief.description,
        would_send: {
            // A plan REPLACES the prompt at the provider — the two are mutually
            // exclusive — so showing both would describe a request that cannot
            // be made.
            prompt: built.plan ? null : wouldSend.prompt,
            duration_s: wouldSend.duration_s,
            duration_source: wouldSend.duration_source || null,
            composition_plan: built.plan,
        },
        sections: {
            limits: {
                min_section_ms: sectionLimits.SECTION_MIN_MS,
                max_section_ms: sectionLimits.SECTION_MAX_MS,
                max_cue_ms: sectionLimits.CUE_MAX_MS,
            },
            written: scored.cue.sections || [],
            fit: built.fit,
            errors: built.errors,
            // A structural split for a cue too long to be one section. It says
            // nothing about what any part should SOUND like — that is the
            // judgement this hands to whoever is directing.
            suggested: (scored.cue.sections || []).length ? null
                : sectionLimits.splitToFit((scored.length.seconds || 0) * 1000, scored.brief.description),
        },
        guidance: 'Decide the mood, the genre, the instruments and a reference track, then store '
            + 'them with music_cue_create. A cue you write always beats the derivation. Note the '
            + 'dialogue count: a wall-to-wall dialogue scene wants sparse underscore that never '
            + 'becomes melodic, because a melody there fights the words. '
            + 'To shape the cue OVER TIME — sparse under the argument, opening out at the reveal '
            + '— write `sections`: each needs a name, a direction and a length between 3s and '
            + '120s, and the generator honours those lengths. A cue with no sections sends one '
            + 'prompt for its whole length, exactly as before.',
    });
}

async function generateMusic(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    const musicProvider = resolveGenerator('music', spendContext({ id: scene.project_id }, null, scene, cueOverride(req, 'music')));

    // Find music cues for this scene, or create from request body
    const scored = cueForScene(scene, project, req.body);
    let musicCue = scored.cue;

    // The same builder the free brief showed — the measured length, and the
    // composition plan when the cue has sections.
    const built = musicPayloadFor(scored, scene, project);
    if (built.errors.length) return sectionRefusal(res, built.errors);
    const payload = built.payload;

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, music_cue_id, gen_type, status, prompt, model, duration_ms, tempo_bpm)
         VALUES (?, ?, ?, ?, 'score', 'generating', ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, sceneId, musicCue && musicCue.id ? musicCue.id : null,
        payload.prompt, payload.model, payload.duration_s * 1000, payload.tempo_bpm);

    try {
        const result = await musicProvider.generate('music', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (musicProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = filenameForResult(`${scene.scene_number || sceneId}_score.wav`, result);
        ensureDir(scene.project_id, 'music');

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
        } catch (err) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            return json(res, 502, { error: `music generated but could not be stored: ${err.message}` });
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, scene_id, asset_type, file_path, file_name,
                format, mime_type, duration_ms, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'audio_music', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, sceneId, filePath, filename, formatForResult(result), mimeForResult(result), payload.duration_s * 1000,
            musicProvider.id, resultModel(result, payload), resultJobId(result)
        );

        // The cue this was generated FROM, so the row and its audio are connected.
        // A derived score has no cue row to link, and linkCueAsset ignores a null.
        linkCueAsset(scored.derived ? null : scored.cue.id, assetId);

        // Note: scene-level music is not a shot render, and render_ledger.shot_id
        // is NOT NULL + FK to film_shots — so we track it in film_music_jobs only.
        db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            scene_id: sceneId, job_id: jobId, status: 'complete',
            music_url: getFileUrl('music', scene.project_id, filename),
            duration_s: payload.duration_s, mood: payload.mood, genre: payload.genre,
        });
    } catch (err) {
        db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (musicProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
        json(res, 500, { error: err.message });
    }
}

// -- SSE Streaming Music Generation --------------------------------------

async function generateMusicStream(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    const musicProvider = resolveGenerator('music', spendContext({ id: scene.project_id }, null, scene, cueOverride(req, 'music')));
    const scored = cueForScene(scene, project, req.body);
    let musicCue = scored.cue;
    // The same builder the free brief showed — the measured length, and the
    // composition plan when the cue has sections.
    const built = musicPayloadFor(scored, scene, project);
    if (built.errors.length) return sectionRefusal(res, built.errors);
    const payload = built.payload;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };
    sendEvent({ type: 'status', phase: 'starting', scene_id: sceneId, mood: payload.mood });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, gen_type, status, prompt, model)
         VALUES (?, ?, ?, 'score', 'generating', ?, ?)`
    ).run(jobId, scene.project_id, sceneId, payload.prompt, payload.model);

    try {
        // The SSE relay calls onComplete synchronously, so the download happens
        // after the stream resolves; otherwise the asset keeps an empty
        // file_path and never reaches the timeline as real media.
        let streamedAsset = null;

        const { ok, error } = await musicProvider.generateStream('music', payload, res, {
            onComplete: (data) => {
                const filename = filenameForResult(`${scene.scene_number || sceneId}_score.wav`, data);
                ensureDir(scene.project_id, 'music');

                const assetId = generateId();
                streamedAsset = { assetId, filename, data };
                db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, scene_id, asset_type, file_name, format, mime_type, version,
                        provider, provider_model, provider_job_id, license_source, license_status
                     )
                     VALUES (?, ?, ?, 'audio_music', ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
                ).run(
                    assetId, scene.project_id, sceneId, filename, formatForResult(data), mimeForResult(data),
                    musicProvider.id, resultModel(data, payload), resultJobId(data)
                );
                linkCueAsset(scored.derived ? null : musicCue.id, assetId);

                db.prepare('UPDATE film_music_jobs SET status = ? WHERE id = ?').run('complete', jobId);
            },
            onError: (data) => {
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', data.error || 'Unknown', jobId);
            },
        });

        if (!ok) {
            sendEvent({ type: 'error', error: error || 'Music generation failed' });
        } else if (streamedAsset) {
            try {
                const filePath = await persistProviderMedia(
                    scene.project_id, 'music', streamedAsset.filename, streamedAsset.data, { serveDir: 'music' }
                );
                db.prepare('UPDATE film_assets SET file_path = ? WHERE id = ?').run(filePath, streamedAsset.assetId);
            } catch (err) {
                db.prepare('DELETE FROM film_assets WHERE id = ?').run(streamedAsset.assetId);
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', `media not stored: ${err.message}`, jobId);
                sendEvent({ type: 'error', error: `music generated but could not be stored: ${err.message}` });
            }
        }
    } catch (err) {
        sendEvent({ type: 'error', error: err.message });
    }

    sendEvent({ type: 'done' });
    res.end();
}

// -- Generate SFX for a Shot ---------------------------------------------

async function generateSFX(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const sfxProvider = resolveGenerator('sfx', spendContext({ id: scene.project_id }, shot, scene, cueOverride(req, 'sfx')));

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    const sfxPayloads = buildSFXPrompts(sceneCard, scene);
    if (sfxPayloads.length === 0) {
        return json(res, 200, { shot_id: shotId, message: 'No SFX cues found in scene card', sfx_files: [] });
    }

    ensureDir(scene.project_id, 'music');
    const results = [];

    for (let i = 0; i < sfxPayloads.length; i++) {
        const payload = sfxPayloads[i];
        const jobId = generateId();

        db.prepare(
            `INSERT INTO film_music_jobs (id, project_id, shot_id, gen_type, status, prompt, model, duration_ms)
             VALUES (?, ?, ?, 'sfx', 'generating', ?, ?, ?)`
        ).run(jobId, scene.project_id, shotId, payload.prompt, payload.model, payload.duration_s * 1000);

        try {
            const result = await sfxProvider.generate('sfx', payload, { timeout: 300000 });
            if (!result.ok) {
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
                results.push({ index: i, status: 'failed', error: result.error });
                continue;
            }

            const filename = filenameForResult(`${shot.shot_code}_sfx_${i}.wav`, result);
            let filePath;
            try {
                filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
            } catch (err) {
                results.push({ index: i, status: 'failed', error: `sfx generated but could not be stored: ${err.message}` });
                continue;
            }

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'audio_sfx', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, scene.project_id, shotId, filePath, filename, formatForResult(result), mimeForResult(result),
                sfxProvider.id, resultModel(result, payload), resultJobId(result)
            );

            db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);
            results.push({ index: i, status: 'complete', sfx_url: getFileUrl('music', scene.project_id, filename) });
        } catch (err) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            results.push({ index: i, status: 'failed', error: err.message });
        }
    }

    json(res, 200, { shot_id: shotId, sfx_count: sfxPayloads.length, sfx_files: results });
}

// -- Generate Ambient for a Scene ----------------------------------------

/**
 * What a director has said about how this scene SOUNDS.
 *
 * An ambient cue is an ordinary row in film_music_cues with cue_type 'ambient'
 * — a table that already carries a description, a negative, a level and fades,
 * and which music_cue_create already manages. A second table for "the same
 * thing but for room tone" is how one of them acquires a fix the other does not.
 *
 * The length is the measured cut, through the same walk the score uses:
 * scene.estimated_duration is 0 on every scene in every real project, and 0 is
 * falsy, so the bed fell to a thirty-second default whatever the scene was.
 */
function ambientOptions(scene, body, namedCue) {
    const { cueSeconds } = require('../lib/scene-score');
    /*
     * A cue may be NAMED by the caller -- `music_cue_generate` addresses one
     * directly. It still comes through here rather than being assembled at the
     * call site: the length walk, the body-beats-the-cue rule and the declined
     * list are one reading, and a second literal is how the ambient lookups
     * came to exist twice in the first place.
     */
    const picked = namedCue
        ? { chosen: namedCue, others: cueOfKind(scene.id, namedCue.cue_type).others }
        : cueOfKind(scene.id, CUE_KIND_FOR.ambient);
    const cue = picked.chosen;
    const context = sceneScoreContext(scene);
    const length = cueSeconds({
        cue_ms: cue && cue.duration_ms,
        cut_ms: context.cut_ms,
        dialogue_ms: context.dialogue_ms,
        explain: true,
    });
    return {
        cue: cue || null,
        other_cues: picked.others,
        // A body beats the stored cue: a caller asking for something specific
        // on this run must not be overruled by a note written last week.
        direction: String((body && body.direction) || (cue && cue.description) || '').trim(),
        negative_prompt: String((body && body.negative_prompt) || (cue && cue.negative_prompt) || '').trim(),
        bed_ms: (length.seconds || 0) * 1000,
        bed_source: length.source,
    };
}

/**
 * What the ambient bed would be asked for, spending nothing.
 *
 * Built through the SAME `buildAmbientPrompt` the generation uses — a brief
 * assembled separately would be a description of the request rather than the
 * request, which is the refine-preview defect this codebase has paid for once.
 *
 * It also makes visible the two fields that were stored for years and reached
 * nothing: the scene's own ambient direction, and the location's sound notes.
 * An empty direction means the bed is assembled from the location name and the
 * hour and nothing else, which is worth seeing before paying for it.
 */
function ambientBrief(res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const location = scene.location_id
        ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id)
        : null;

    const cue = cueOfKind(sceneId, CUE_KIND_FOR.ambient).chosen || {};
    const payload = buildAmbientPrompt(scene, location, ambientOptions(scene, {}));

    const providers = require('../lib/providers');
    const { providerConfigOf } = require('../lib/provider-config');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    const provider = providers.resolveId('ambient', providerConfigOf(project || {}));

    const notes = [];
    if (!String(scene.delivery_direction || '').trim() && !String(cue.description || '').trim()) {
        notes.push('No ambient direction is written for this scene, so the bed is assembled from the '
            + "location name and the hour and nothing else. The Music page's ambient box is where a "
            + 'direction goes.');
    }
    if (location && !String(location.sound_notes || '').trim()) {
        notes.push(`${location.name || 'This location'} has no sound notes — the field whose whole `
            + 'purpose is describing how a place sounds is empty.');
    }

    return json(res, 200, {
        scene_id: sceneId,
        provider,
        prompt: payload.prompt || '',
        negative_prompt: payload.negative_prompt || '',
        payload,
        notes,
        free: true,
    });
}

async function generateAmbient(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const location = scene.location_id
        ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id)
        : null;
    const ambientProvider = resolveGenerator('ambient', spendContext({ id: scene.project_id }, null, scene, cueOverride(req, 'ambient')));

    const ambient = ambientOptions(scene, req.body);
    const payload = buildAmbientPrompt(scene, location, ambient);

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, gen_type, status, prompt, model, duration_ms)
         VALUES (?, ?, ?, 'ambient', 'generating', ?, ?, ?)`
    ).run(jobId, scene.project_id, sceneId, payload.prompt, payload.model, payload.duration_s * 1000);

    try {
        const result = await ambientProvider.generate('ambient', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (ambientProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = filenameForResult(`${scene.scene_number || sceneId}_ambient.wav`, result);
        ensureDir(scene.project_id, 'music');

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
        } catch (err) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            return json(res, 502, { error: `ambient generated but could not be stored: ${err.message}` });
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, scene_id, asset_type, file_path, file_name,
                format, mime_type, duration_ms, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'audio_ambient', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, sceneId, filePath, filename, formatForResult(result), mimeForResult(result), payload.duration_s * 1000,
            ambientProvider.id, resultModel(result, payload), resultJobId(result)
        );
        linkCueAsset(ambient.cue && ambient.cue.id, assetId);

        db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            scene_id: sceneId, job_id: jobId, status: 'complete',
            ambient_url: getFileUrl('music', scene.project_id, filename), duration_s: payload.duration_s,
        });
    } catch (err) {
        db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (ambientProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
        json(res, 500, { error: err.message });
    }
}

// -- Batch Music/SFX/Ambient ---------------------------------------------

async function batchMusicStream(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const providerConfig = parseProjectConfig(projectId);
    const musicProvider = resolveGenerator('music', providerConfig);
    const ambientProvider = resolveGenerator('ambient', providerConfig);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };

    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);
    sendEvent({ type: 'status', phase: 'starting', total_scenes: scenes.length, project_id: projectId });

    let completed = 0, failed = 0;

    for (const scene of scenes) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop remaining scenes
        // Music score
        sendEvent({ type: 'scene_start', scene_id: scene.id, scene_number: scene.scene_number, phase: 'music' });
        // Through cueForScene like every other path. This read the row
        // directly, so a scene generated from the batch got a thirty-second
        // default where the same scene generated from the Music page got its
        // measured length — and would have silently skipped the sections too.
        const musicScored = cueForScene(scene, project, null);
        const musicCue = musicScored.cue;
        const musicBuilt = musicPayloadFor(musicScored, scene, project);
        const musicPayload = musicBuilt.payload;
        if (musicBuilt.errors.length) {
            sendEvent({ type: 'scene_error', scene_id: scene.id, phase: 'music',
                error: `sections: ${musicBuilt.errors.join('; ')}` });
            failed++;
            continue;
        }

        try {
            const result = await musicProvider.generate('music', musicPayload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = filenameForResult(`${scene.scene_number || scene.id}_score.wav`, result);
            ensureDir(projectId, 'music');
            const filePath = await persistProviderMedia(projectId, 'music', filename, result.data, { serveDir: 'music' });

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, scene_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'audio_music', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, projectId, scene.id, filePath, filename, formatForResult(result), mimeForResult(result),
                musicProvider.id, resultModel(result, musicPayload), resultJobId(result)
            );
            linkCueAsset(musicScored.derived ? null : musicCue.id, assetId);

            sendEvent({ type: 'music_complete', scene_number: scene.scene_number, music_url: getFileUrl('music', projectId, filename) });
            completed++;
        } catch (err) {
            sendEvent({ type: 'music_failed', scene_number: scene.scene_number, error: err.message });
            failed++;
        }

        // Ambient
        if (clientGone || res.writableEnded) break; // client left mid-scene — skip ambient
        const location = scene.location_id ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id) : null;
        // Through the same reading as the single route: a bed generated from
        // the batch used to ignore the location's sound notes, the scene's own
        // direction and the measured length, all three of which the Music page
        // honoured.
        const ambient = ambientOptions(scene, null);
        const ambientPayload = buildAmbientPrompt(scene, location, ambient);

        try {
            const result = await ambientProvider.generate('ambient', ambientPayload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = filenameForResult(`${scene.scene_number || scene.id}_ambient.wav`, result);
            const filePath = await persistProviderMedia(projectId, 'music', filename, result.data, { serveDir: 'music' });

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, scene_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'audio_ambient', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, projectId, scene.id, filePath, filename, formatForResult(result), mimeForResult(result),
                ambientProvider.id, resultModel(result, ambientPayload), resultJobId(result)
            );
            linkCueAsset(ambient.cue && ambient.cue.id, assetId);

            sendEvent({ type: 'ambient_complete', scene_number: scene.scene_number });
            completed++;
        } catch (err) {
            sendEvent({ type: 'ambient_failed', scene_number: scene.scene_number, error: err.message });
            failed++;
        }
    }

    sendEvent({ type: 'result', project_id: projectId, items_completed: completed, items_failed: failed });
    sendEvent({ type: 'done' });
    res.end();
}

async function batchMusic(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);

    json(res, 200, {
        project_id: projectId, total_scenes: scenes.length,
        scenes: scenes.map(s => ({ scene_id: s.id, scene_number: s.scene_number, location: s.location })),
        hint: 'Use POST /film/projects/:id/music/batch/stream for actual generation with progress',
    });
}

// -- List Music Jobs -----------------------------------------------------

function listMusicJobs(req, res, projectId, query) {
    const genType = query.type || null;
    const status = query.status || null;

    let sql = 'SELECT * FROM film_music_jobs WHERE project_id = ?';
    const params = [projectId];

    if (genType) { sql += ' AND gen_type = ?'; params.push(genType); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';

    const jobs = db.prepare(sql).all(...params);
    // Imported beds have no generation job by design. Return the durable asset
    // slots beside jobs so Music & Sound can show and play either provenance.
    const assets = db.prepare(`SELECT * FROM film_assets
        WHERE project_id = ? AND asset_type IN ('audio_music','audio_ambient')
        ORDER BY created_at DESC`).all(projectId).map(a => ({
        ...a,
        url: a.file_name ? getFileUrl('music', a.project_id, a.file_name) : null,
    }));
    json(res, 200, { project_id: projectId, total: jobs.length, jobs, assets });
}

// -- FILM-093: Per-Shot Audio Mix -----------------------------------------

function collectShotAudioTracks(shotId, scene, shot) {
    const tracks = [];

    // How long the mix runs, and therefore how long a looping bed has to cover.
    // Prefer the shot's own duration; fall back to the longest asset we collect
    // so a shot with no recorded duration still gets a bed that reaches the end.
    const shotDurationMs = (shot && shot.duration_ms) || 0;

    // Dialogue
    const dialogueAssets = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'audio_dialogue' ORDER BY created_at DESC"
    ).all(shotId);
    for (const a of dialogueAssets) {
        tracks.push({
            type: 'dialogue', url: a.file_path || getFileUrl('audio', a.project_id, a.file_name),
            start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: 0,
        });
    }

    // SFX
    const sfxAssets = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'audio_sfx' ORDER BY created_at DESC"
    ).all(shotId);
    for (const a of sfxAssets) {
        tracks.push({
            type: 'sfx', url: a.file_path || getFileUrl('music', a.project_id, a.file_name),
            start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: -3,
        });
    }

    /*
     * An approved score over this scene (MUS-020) IS the music: the shot takes
     * its slice of the approved mix — from where this shot starts within the
     * score's picture — and the scene's legacy music is not laid under it.
     */
    const scoreSlice = scene ? approvedScoreSlice(scene.project_id, shotId) : null;
    if (scoreSlice) tracks.push(scoreSlice);

    // Scene-level music
    if (scene && !scoreSlice && !require('../lib/music-approval').coveredScenes(db, scene.project_id).has(scene.id)) {
        const musicAssets = db.prepare(
            "SELECT * FROM film_assets WHERE scene_id = ? AND asset_type = 'audio_music' ORDER BY created_at DESC LIMIT 1"
        ).all(scene.id);
        for (const a of musicAssets) {
            tracks.push({
                type: 'music', url: a.file_path || getFileUrl('music', a.project_id, a.file_name),
                start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: -6,
            });
        }
    }

    // Scene-level ambient — ambience is not music, so an approved score leaves it alone.
    if (scene) {
        const ambientAssets = db.prepare(
            "SELECT * FROM film_assets WHERE scene_id = ? AND asset_type = 'audio_ambient' ORDER BY created_at DESC LIMIT 1"
        ).all(scene.id);
        for (const a of ambientAssets) {
            // The bed is generated as a short seamless loop (see
            // buildAmbientPrompt), so it has to be tiled across the shot or it
            // stops early and the rest plays dry.
            //
            // Most accurate first: the shot's own duration, then the furthest
            // any other track reaches, then the scene estimate. A shot whose
            // only track is the bed has no other track to measure against, so
            // without the scene fallback it would get no loop target at all and
            // the loop would silently not apply.
            const longestOther = tracks.reduce((max, t) => Math.max(max, (t.start_ms || 0) + (t.duration_ms || 0)), 0);
            const loopUntilMs = shotDurationMs || longestOther || (scene && scene.estimated_duration) || 0;
            tracks.push({
                type: 'ambient', url: a.file_path || getFileUrl('music', a.project_id, a.file_name),
                start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: -12,
                loop: true,
                loop_until_ms: loopUntilMs,
                crossfade_ms: 5000,
            });
        }
    }

    return tracks;
}

/** This shot's slice of an approved score, when one covers it: the mix, from where the shot starts within the score. */
function approvedScoreSlice(projectId, shotId) {
    const score = require('../lib/music-approval').approvedScores(db, projectId).scores.find(sc => sc.shot_ids.includes(shotId));
    if (!score) return null;
    const tl = require('./timeline').loadTimeline(projectId);
    const code = (db.prepare('SELECT shot_code FROM film_shots WHERE id = ?').get(shotId) || {}).shot_code;
    const entry = tl.entries.find(e => e.shot_id === shotId || (e.covers || []).includes(code));
    const placement = (tl.score.placements || []).find(p => p.session_id === score.session_id);
    if (!entry || !placement) return null;
    return { type: 'music', url: placement.file_path, start_ms: 0, duration_ms: entry.duration_ms,
        // Where in the approved mix this shot's music begins. A mix service that
        // ignores it plays the score from its top under every shot.
        source_offset_ms: entry.start_ms - placement.offset_ms, gain_db: 0, score_session_id: placement.session_id };
}

async function mixShotAudio(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const tracks = collectShotAudioTracks(shotId, scene, shot);

    if (tracks.length === 0) {
        return json(res, 200, { shot_id: shotId, message: 'No audio tracks found for this shot', tracks: [] });
    }

    // Build ducking from dialogue regions
    const dialogueRegions = tracks
        .filter(t => t.type === 'dialogue')
        .map(t => ({ start_ms: t.start_ms, end_ms: t.start_ms + (t.duration_ms || 3000) }));
    const ducking = calculateDucking(dialogueRegions);

    const payload = buildMixPayload(tracks, {
        ...(req.body || {}),
        output_filename: `${shot.shot_code}_mix.wav`,
    });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_audio_mix_jobs (id, project_id, shot_id, status, track_count, lufs_target, ducking_enabled, params)
         VALUES (?, ?, ?, 'processing', ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, shotId, tracks.length,
        payload.master.lufs_target, payload.ducking.enabled ? 1 : 0, JSON.stringify(payload));

    try {
        const result = await callGridlight(MIX_ENDPOINT, payload);

        if (!result.ok) {
            db.prepare('UPDATE film_audio_mix_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (result.status === 503) return json(res, 503, serviceUnavailableError(MIX_ENDPOINT, 'audio mix'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${shot.shot_code}_mix.wav`;
        ensureDir(scene.project_id, 'music');

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
        } catch (err) {
            db.prepare('UPDATE film_audio_mix_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            return json(res, 502, { error: `audio mix generated but could not be stored: ${err.message}` });
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, version)
             VALUES (?, ?, ?, 'audio_mix', ?, ?, 'wav', 'audio/wav', 1)`
        ).run(assetId, scene.project_id, shotId, filePath, filename);

        db.prepare('UPDATE film_audio_mix_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            mix_url: getFileUrl('music', scene.project_id, filename),
            track_count: tracks.length, ducking_events: ducking.length,
        });
    } catch (err) {
        db.prepare('UPDATE film_audio_mix_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MIX_ENDPOINT, 'audio mix'));
        json(res, 500, { error: err.message });
    }
}

// -- FILM-063: Audio Deliverables Packaging + SRT -------------------------

async function mixProjectAudio(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_id FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const eligible = [];
    for (const shot of shots) {
        const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
        const tracks = collectShotAudioTracks(shot.shot_id, scene, shot);
        if (tracks.length > 0) {
            eligible.push({ shot_id: shot.shot_id, shot_code: shot.shot_code, track_count: tracks.length });
        }
    }

    // The approved score (MUS-020): laid once at its offset, the scene music under it dropped.
    const tl = require('./timeline').loadTimeline(projectId);
    json(res, 200, {
        project_id: projectId, eligible_shots: eligible.length, shots: eligible,
        score: tl.score,
        hint: 'POST /film/shots/:id/audio/mix for per-shot mixing, or POST /film/projects/:id/music/stems for stem export.',
    });
}

async function exportStems(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    // Collect all audio assets across the project
    const allTracks = [];
    const assets = db.prepare(
        "SELECT * FROM film_assets WHERE project_id = ? AND asset_type LIKE 'audio_%' ORDER BY created_at"
    ).all(projectId);

    for (const a of assets) {
        const typeMap = { audio_dialogue: 'dialogue', audio_music: 'music', audio_sfx: 'sfx', audio_ambient: 'ambient', audio_mix: 'mix' };
        allTracks.push({
            type: typeMap[a.asset_type] || 'other',
            url: a.file_path || a.file_name,
            start_ms: 0, duration_ms: a.duration_ms || 0,
        });
    }

    const stemPayload = buildStemExport(allTracks, req.body);

    json(res, 200, {
        project_id: projectId, total_tracks: allTracks.length,
        stems: stemPayload.stems.map(s => ({ name: s.stem_name, track_count: s.tracks.length })),
        payload: stemPayload,
        hint: 'Stem export payload ready. Send to audio processing endpoint for rendering.',
    });
}

function exportSRT(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    // Collect all dialogue from scene cards
    const shots = db.prepare(
        `SELECT s.id, s.shot_code, s.scene_card_yaml, s.duration_ms, sc.scene_number
         FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? AND sc.status != 'removed'
         ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const dialogueLines = [];
    let cumulativeMs = 0;

    for (const shot of shots) {
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}
        const dialogue = card.dialogue || [];
        const shotDur = shot.duration_ms || 4000;
        const lineInterval = dialogue.length > 0 ? shotDur / dialogue.length : shotDur;

        for (let i = 0; i < dialogue.length; i++) {
            if (!dialogue[i].line) continue;
            dialogueLines.push({
                character: dialogue[i].character || '',
                line: dialogue[i].line,
                start_ms: cumulativeMs + Math.round(i * lineInterval),
                end_ms: cumulativeMs + Math.round((i + 1) * lineInterval),
            });
        }
        cumulativeMs += shotDur;
    }

    const includeChar = !req.query || req.query.include_character !== 'false';
    const srt = generateSRT(dialogueLines, { include_character: includeChar });

    const safeTitle = (project.title || 'subtitles').replace(/[^a-zA-Z0-9_-]/g, '_');

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeTitle}.srt"`,
    });
    res.end(srt);
}

module.exports = {
    handleMusicGen,
    /*
     * Exposed for tests. Which cue a path selects is the defect this module
     * has already shipped once, and it cannot be checked from the outside:
     * generating to find out costs money, and the wrong cue produces a
     * perfectly good file.
     */
    _internal: { cueForScene, ambientOptions, cueOfKind, linkCueAsset, CUE_KIND_FOR, generateFromCue },
    collectShotAudioTracks,
};
