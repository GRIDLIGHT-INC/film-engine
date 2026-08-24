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

function importForCapability(req, res, scopeKind, ownerId, capability) {
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
        return json(res, 201, imported);
    } catch (err) {
        // The reason survives. "Invalid file" sends a director back to their NLE
        // with nothing to change; "this is an audio file, not a video" does not.
        return json(res, /not found/i.test(err.message) ? 404 : 400, { error: err.message });
    }
}

function handleMediaImport(req, res, urlParts) {
    if (urlParts[1] === 'media-kinds' && req.method === 'GET') return listMediaKinds(res);

    const scope = urlParts[1] === 'shots' ? 'shot' : urlParts[1] === 'scenes' ? 'scene' : null;
    if (scope && urlParts[2] && urlParts[3] === 'media' && urlParts[4] && urlParts[5] === 'import') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: `Invalid ${scope} ID` });
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
        return importForCapability(req, res, scope, urlParts[2], urlParts[4]);
    }
    return false;
}

module.exports = { handleMediaImport, listMediaKinds };
