/**
 * Footage and sound made outside Film Engine.
 *
 * ONE route for every orchestrated media capability rather than an import
 * endpoint bolted onto each of video-gen, voice, lipsync, music-gen and
 * post-production. Five copies of one behaviour is how four of them end up with
 * the format sniffing and the fifth silently accepts anything — the same
 * reasoning that put plate generation in one shared implementation and the
 * reference gather in one module for four paths.
 *
 *   POST /film/shots/:id/media/:capability/import     (video, voice, lipsync, sfx, post)
 *   POST /film/scenes/:id/media/:capability/import    (music, ambient)
 *   GET  /film/media-kinds                            what can be uploaded, and where
 *
 * Which of the two a capability uses is not a choice made here: it comes from
 * MEDIA_KINDS, which takes it from PIPELINE_STEPS. A music bed is scene-wide
 * and a clip belongs to one shot, and an importer with its own opinion would
 * eventually disagree with the generator.
 */

const { MEDIA_KINDS } = require('../lib/media-kinds');
const { importMedia } = require('../lib/media-imports');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** Everything that can be uploaded, so a UI can never offer what the server refuses. */
function listMediaKinds(res) {
    return json(res, 200, {
        kinds: Object.values(MEDIA_KINDS)
            .filter(k => k.media !== 'image')
            .map(k => ({
                capability: k.capability,
                media: k.media,
                scope: k.scope,
                asset_type: k.assetType,
                accepts: k.media === 'video'
                    ? ['.mp4', '.mov', '.webm', '.mkv']
                    : ['.wav', '.mp3', '.m4a', '.flac', '.ogg'],
                endpoint: k.scope === 'scene'
                    ? `/film/scenes/:scene_id/media/${k.capability}/import`
                    : `/film/shots/:shot_id/media/${k.capability}/import`,
            })),
        // Stated rather than discovered at the ceiling: uploads travel as
        // base64, which is a third larger than the file, so the 150MB body
        // limit is about 112MB of actual media.
        max_file_mb: 112,
        note: 'An uploaded file is stored exactly where a generated one goes and is picked up by the '
            + 'timeline, the conform and the export unchanged. It is not tracked against the scene '
            + 'card, so editing that card will never tell you to regenerate over footage you supplied.',
    });
}

function importForCapability(req, res, scopeKind, ownerId, capability, opts = {}) {
    const spec = MEDIA_KINDS[capability];
    if (!spec || spec.media === 'image') {
        return json(res, 404, {
            error: `nothing called '${capability}' can be uploaded`,
            uploadable: Object.values(MEDIA_KINDS).filter(k => k.media !== 'image').map(k => k.capability),
        });
    }
    // A scene bed posted at a shot would attach a whole scene's music to one
    // shot and read as working. Refused, with where it should have gone.
    if (spec.scope !== scopeKind) {
        return json(res, 400, {
            error: `${capability} is ${spec.scope}-scoped`,
            expected: `/film/${spec.scope}s/:id/media/${capability}/import`,
        });
    }
    const body = req.body || {};
    if (!body.data) return json(res, 400, { error: 'no file supplied' });

    try {
        const imported = importMedia(`${capability}-media`, {
            ...(scopeKind === 'scene' ? { sceneId: ownerId } : { shotId: ownerId }),
            data: body.data, name: body.name,
        });

        /*
         * Which OTHER shots this one clip also contains.
         *
         * "I generated a video that includes 1A-B-C." Without this the shots
         * inside the clip keep their own slot and show their storyboard frames
         * after the viewer has just watched them, and the conform reports them
         * as missing footage.
         *
         * Refused rather than repaired if the run is not consecutive or crosses
         * projects — see lib/clip-coverage.js. The upload itself has already
         * succeeded, so a bad coverage is reported ALONGSIDE it rather than
         * failing the whole request and losing a file the director just waited
         * to send.
         */
        let coverage = null, coverageError = null;
        if (Array.isArray(body.covers) && body.covers.length) {
            try {
                const { setCoverage } = require('../lib/clip-coverage');
                const ids = [...new Set([ownerId, ...body.covers.filter(x => typeof x === 'string')])];
                coverage = setCoverage(require('../db/database').db, imported.asset_id, ids);
            } catch (err) { coverageError = err.message; }
        }

        // A caller that owns the row this file belongs to gets to record the
        // link before the response leaves, so an upload cannot be reported as
        // attached while the row still points at nothing.
        let attached = null;
        if (typeof opts.onImported === 'function') {
            try { attached = opts.onImported(imported); } catch (_) { attached = null; }
        }

        return json(res, 201, {
            ...imported,
            ...(attached ? { attached } : {}),
            ...(coverage ? { covers: coverage.covers } : {}),
            ...(coverageError ? { coverage_error: coverageError } : {}),
            ...(coverageError ? {
                coverage_note: 'The clip was uploaded and is on its shot. Only the coverage was '
                    + 'refused, so the other shots still play their own frames.',
            } : {}),
        });
    } catch (err) {
        // The reason survives. "Invalid file" sends a director back to their NLE
        // with nothing to change; "this is an audio file, not a video" does not.
        return json(res, /not found/i.test(err.message) ? 404 : 400, { error: err.message });
    }
}

/**
 * Say which shots a clip contains, AFTER it is safely uploaded.
 *
 * The question used to be asked with a native prompt() before the file was
 * sent, and cancelling it abandoned the upload with nothing said — so pressing
 * Escape on an unexpected dialog silently discarded the clip, and the reported
 * symptom was "playback doesn't include the video" for a file that had never
 * reached the server.
 *
 * Asking afterwards is a better shape regardless: a director watching the clip
 * back is far better placed to say what is in it than one who has not yet seen
 * it upload. An empty list clears the coverage, because a director who marked
 * it wrong must be able to say so without deleting the footage.
 */
function setClipCoverage(req, res, assetId) {
    const { setCoverage } = require('../lib/clip-coverage');
    const { db } = require('../db/database');
    const body = req.body || {};
    if (!Array.isArray(body.shot_ids)) {
        return json(res, 400, { error: 'shot_ids must be an array (empty clears the coverage)' });
    }
    try {
        const result = setCoverage(db, assetId, body.shot_ids);
        return json(res, 200, {
            ...result,
            note: result.covers.length
                ? `This clip now plays for ${result.covers.join(', ')}. Those shots no longer hold `
                  + 'their own frames in playback, and are no longer reported as missing footage.'
                : 'Coverage cleared. Each shot plays on its own again.',
        });
    } catch (err) {
        // The reason survives: "consecutive" and "already belongs to another
        // clip" are different problems with different fixes.
        return json(res, /not found/i.test(err.message) ? 404 : 400, { error: err.message });
    }
}

/** Which uploadable kind a cue's audio is, from the cue's own type. */
const CUE_CAPABILITY = Object.freeze({
    score: 'music', source: 'music', transition: 'music',
    ambient: 'ambient', sfx: 'sfx',
});

function handleMediaImport(req, res, urlParts) {
    if (urlParts[1] === 'media-kinds' && req.method === 'GET') return listMediaKinds(res);

    // Which shots a clip contains, set after the fact.
    if (urlParts[1] === 'assets' && urlParts[2] && urlParts[3] === 'coverage' && req.method === 'PUT') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid asset ID' });
        return setClipCoverage(req, res, urlParts[2]);
    }

    /*
     * A SOUND A DIRECTOR ALREADY HAS, attached to the cue that describes it.
     *
     * media_upload has always landed audio as an ASSET. An asset is not a cue:
     * it carries no level, no fades, no offset and no place on the sheet, so an
     * uploaded bed never reached the mix, the playback or the export. "Add
     * manually" produced a file nobody heard.
     *
     * The capability is derived from the cue's own type rather than asked for,
     * because a cue that says it is ambient and stores its audio as music is a
     * row that disagrees with itself, and nothing downstream could tell which
     * half to believe.
     */
    if (urlParts[1] === 'music-cues' && urlParts[2] && urlParts[3] === 'audio' && req.method === 'POST') {
        const { db } = require('../db/database');
        const cue = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(urlParts[2]);
        if (!cue) return json(res, 404, { error: `No music cue ${urlParts[2]}` });
        if (!cue.scene_id) {
            return json(res, 400, {
                error: 'This cue is not attached to a scene, so its audio has nowhere to play.',
            });
        }
        const capability = CUE_CAPABILITY[cue.cue_type] || 'music';
        return importForCapability(req, res, 'scene', cue.scene_id, capability, {
            onImported: (imported) => {
                db.prepare('UPDATE film_music_cues SET generated_asset_id = ? WHERE id = ?')
                    .run(imported.asset_id, cue.id);
                return { cue_id: cue.id, cue_type: cue.cue_type, capability };
            },
        });
    }

    const scope = urlParts[1] === 'shots' ? 'shot' : urlParts[1] === 'scenes' ? 'scene' : null;
    if (scope && urlParts[2] && urlParts[3] === 'media' && urlParts[4] && urlParts[5] === 'import') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: `Invalid ${scope} ID` });
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
        return importForCapability(req, res, scope, urlParts[2], urlParts[4]);
    }
    return false;
}

module.exports = { handleMediaImport, listMediaKinds };
