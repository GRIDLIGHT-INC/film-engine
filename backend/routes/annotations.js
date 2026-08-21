/**
 * Markup on a storyboard frame.
 *
 *   GET    /film/shots/:id/annotations
 *   POST   /film/shots/:id/annotations
 *   DELETE /film/annotations/:id
 *
 * The fastest direction a director gives is an arrow. This stores it, and
 * stores it against the SHOT rather than the image — a note is about the shot,
 * and the PNG is one attempt at it. Keying markup to an asset would erase the
 * direction at the exact moment it was acted on.
 *
 * Whether this markup should FEED the next generation was Open Question 3 of
 * the parity epic. It is answered, and the answer is opt-in: a project sets
 * `annotation_feedback` and its marks reach the prompt; by default they do not
 * and this remains pure notation. See lib/annotation-prompt.js.
 *
 * The listing says which of these marks would reach a prompt and which would
 * not, because a mark with no note contributes nothing — geometry says where,
 * never what — and a director who cannot see that will re-draw arrows that were
 * never going to do anything.
 */

const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shapes worth having, and no more.
 *
 * Each earns its place by saying something the others cannot: an arrow points,
 * a line divides, a rect and an ellipse enclose, freehand traces a path a
 * shape cannot, and text is the note itself.
 */
const ANNOTATION_KINDS = ['arrow', 'line', 'rect', 'ellipse', 'freehand', 'text'];

/** How many points each kind means. Text is a single anchor. */
const POINT_COUNT = { arrow: 2, line: 2, rect: 2, ellipse: 2, text: 1 };

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parsePoints(json_) {
    try { const v = JSON.parse(json_ || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

/** Has this shot's project opted its markup into generation? */
function feedbackEnabled(shotId) {
    try {
        const row = db.prepare(
            `SELECT p.annotation_feedback AS on_ FROM film_shots s
               JOIN film_scenes sc ON sc.id = s.scene_id
               JOIN film_projects p ON p.id = sc.project_id
              WHERE s.id = ?`).get(shotId);
        return !!(row && row.on_);
    } catch (_) { return false; }
}

function listAnnotations(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const rows = db.prepare(
        'SELECT * FROM film_storyboard_annotations WHERE shot_id = ? ORDER BY created_at').all(shotId);
    const marks = rows.map(r => ({
        id: r.id, kind: r.kind, points: parsePoints(r.points_json),
        text: r.text, color: r.color, created_at: r.created_at,
    }));

    const { annotationDirectives } = require('../lib/annotation-prompt');
    const directives = annotationDirectives(marks);
    const enabled = feedbackEnabled(shotId);
    const feeds = directives.filter(d => d.feeds).length;

    return json(res, 200, {
        shot_id: shotId,
        annotations: marks.map((m, i) => ({
            ...m,
            // What this mark would contribute, and why it would not. Reported
            // per mark rather than as a total, because "2 of 5 marks fed the
            // prompt" does not say WHICH two.
            feeds: enabled && directives[i].feeds,
            place: directives[i].place,
            reason: directives[i].reason
                || (enabled ? null : 'this project has annotation_feedback off, so marks are notation only'),
        })),
        // A director is either looking at notation or at instructions. Which
        // one has to be on the screen showing the marks.
        feedback_enabled: enabled,
        would_feed: feeds,
        note: enabled
            ? 'These marks are applied to the next generation of this shot, and stay applied '
                + 'until deleted — a note is about the shot, not about one attempt at it.'
            : 'Markup is notation only. Set annotation_feedback on the project to have '
                + 'noted marks reach the prompt, or pass use_annotations on a single regenerate/refine.',
    });
}

function addAnnotation(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const body = req.body || {};
    const kind = String(body.kind || '').trim();
    if (!ANNOTATION_KINDS.includes(kind)) {
        return json(res, 400, { error: `kind must be one of: ${ANNOTATION_KINDS.join(', ')}` });
    }

    const points = Array.isArray(body.points) ? body.points : [];
    if (!points.length) return json(res, 400, { error: 'points is required' });

    // Normalised means 0..1. A pixel coordinate sent by mistake would land at
    // 640, store silently, and then draw nowhere — the failure that looks like
    // the feature not working rather than the caller being wrong.
    for (const p of points) {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
            return json(res, 400, {
                error: 'points must be [[x, y], ...] with x and y between 0 and 1',
                detail: 'Geometry is normalised to the frame so markup survives a regeneration at another resolution.',
                got: p,
            });
        }
    }
    const expected = POINT_COUNT[kind];
    if (expected && points.length !== expected) {
        return json(res, 400, { error: `${kind} needs exactly ${expected} point(s), got ${points.length}` });
    }
    if (kind === 'text' && !String(body.text || '').trim()) {
        return json(res, 400, { error: 'a text annotation needs text' });
    }

    const id = generateId();
    db.prepare(
        `INSERT INTO film_storyboard_annotations (id, shot_id, kind, points_json, text, color)
         VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, shotId, kind, JSON.stringify(points), String(body.text || ''), String(body.color || '#f59e0b'));

    const row = db.prepare('SELECT * FROM film_storyboard_annotations WHERE id = ?').get(id);
    return json(res, 201, {
        annotation: { id: row.id, kind: row.kind, points: parsePoints(row.points_json), text: row.text, color: row.color },
    });
}

function deleteAnnotation(req, res, id) {
    const row = db.prepare('SELECT id FROM film_storyboard_annotations WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Annotation not found' });
    db.prepare('DELETE FROM film_storyboard_annotations WHERE id = ?').run(id);
    return json(res, 200, { deleted: true, id });
}

function handleAnnotations(req, res, urlParts) {
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'annotations') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid shot ID' });
        if (req.method === 'GET') return listAnnotations(req, res, urlParts[2]);
        if (req.method === 'POST') return addAnnotation(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }
    if (urlParts[1] === 'annotations' && urlParts[2]) {
        if (req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
        return deleteAnnotation(req, res, urlParts[2]);
    }
    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleAnnotations, ANNOTATION_KINDS };
