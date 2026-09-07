/**
 * Turn the captures stored against a location into a Marble input.
 *
 * `world-capture` (ICP-005) let a director store a panorama, an orbit clip or a
 * LiDAR scan of the real place. Nothing consumed it: the generate route took
 * `images` and `video` from the request body, so a caller had to re-send bytes
 * it had already uploaded — and someone standing in the room with a phone could
 * not build a world from what they shot.
 *
 * The three kinds do NOT map the same way, and that asymmetry is the whole
 * content of this module:
 *
 *   image  -> Marble, as a panorama or a still
 *   video  -> Marble, as a walkthrough
 *   model  -> NOT Marble. A GLB is already geometry; it belongs in the previs
 *             stage through glb-parser. Handing it to a reconstruction service
 *             asks a photogrammetry model to re-derive what it was just given.
 *
 * Nothing is ever silently dropped. A capture that is not sent appears in
 * `excluded` with a reason, because a scan that vanishes looks exactly like a
 * capture that failed to upload.
 */

const { checkCapture } = require('./capture-policy');

/** Why a GLB is not a reconstruction input. */
const SCAN_WHY = 'A LiDAR scan is already geometry, so it is not a reconstruction input — handing '
    + 'a GLB to a photogrammetry service asks it to re-derive what it was just given. A scan goes '
    + 'to the previs stage instead, through the GLB parser, where it is exact metric geometry '
    + 'rather than a statistical reconstruction.';

/**
 * Which stored captures become which Marble input.
 *
 * @param {Array} captures rows carrying { capture_kind, file_path, size_bytes, is_pano }
 */
function planFromCaptures(captures) {
    const rows = Array.isArray(captures) ? captures : [];
    const images = [];
    const excluded = [];
    let video = null;
    let isPano = 'auto';

    for (const c of rows) {
        const kind = c.capture_kind || 'image';
        const drop = why => excluded.push({ id: c.id, capture_kind: kind, file_name: c.file_name, why });

        if (!c.file_path) {
            drop('The file this capture points at is gone, so there is nothing to send. The row is '
                + 'kept — it cost something to make — but it cannot be used as an input.');
            continue;
        }
        if (kind === 'model') { drop(SCAN_WHY); continue; }

        const verdict = checkCapture({ kind, bytes: c.size_bytes });
        if (!verdict.ok) { drop(verdict.why); continue; }

        if (kind === 'video') {
            // The first clip wins; a second is excluded rather than silently
            // ignored, because Marble takes one walkthrough.
            if (video) { drop('A walkthrough is already going; Marble takes one.'); continue; }
            video = { id: c.id, file: c.file_path, extension: extOf(c.file_name) };
            continue;
        }
        images.push({
            id: c.id, capture_kind: kind, file: c.file_path,
            extension: extOf(c.file_name), view: c.view || '',
        });
        // Only a capture that SAYS it is a panorama makes it one. Guessing is
        // how a wide frame gets read as 360 and the world comes out warped.
        if (c.is_pano === true) isPano = true;
    }

    /*
     * Marble takes ONE prompt shape. A location with both a panorama and an
     * orbit clip has to resolve to one, and a walkthrough carries more spatial
     * information than a single frame — Marble's own timings treat video and
     * multi-image as the richer inputs. The stills are EXCLUDED rather than
     * dropped, so the choice is visible.
     */
    let why = '';
    if (video && images.length) {
        why = `A walkthrough and ${images.length} still${images.length > 1 ? 's' : ''} are both `
            + 'stored for this location. Marble takes one prompt shape, and the clip carries more '
            + 'spatial information than a single frame, so the clip is used.';
        while (images.length) {
            const i = images.pop();
            excluded.push({ id: i.id, capture_kind: i.capture_kind, why });
        }
        isPano = 'auto';
    }

    return {
        images, video, is_pano: isPano, excluded, why,
        empty: !video && images.length === 0 && excluded.length === 0,
    };
}

function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : 'png';
}

module.exports = { planFromCaptures, SCAN_WHY };
