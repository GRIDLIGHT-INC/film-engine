/**
 * The material a production is written from.
 *
 * A bible is prose and no prose reaches an image model. Four fields do — a
 * character's `appearance_prompt`, a location's `description`, a prop's
 * `visual_prompt`, and the project's `style_preset` — and everything else is
 * decoration as far as a generated frame is concerned. Storing a bible without
 * saying that would repeat the mood board's first mistake, which was collecting
 * writing nobody read and calling it a feature.
 *
 * What makes it worth keeping is the link back. An entity records which section
 * its description was written from, so revising that section flags the entity —
 * and the plate generated from it — as worth re-reading. Same shape as
 * screenplay drift, one layer up: the screenplay tells you what happens, the
 * bible tells you what things ARE, and both go stale silently.
 *
 * Sectioned rather than one document, because the flagging has to be precise.
 * One fingerprint over the whole bible would mark every character in the film
 * as behind the moment someone fixed a typo in the world rules.
 */

const crypto = require('crypto');

function database() {
    return require('../db/database').db;
}

function hash(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

/** The entity kinds that can be written from a bible section. */
const SUBJECTS = [
    { kind: 'character', table: 'film_characters', field: 'appearance_prompt' },
    { kind: 'location', table: 'film_locations', field: 'description' },
    { kind: 'prop', table: 'film_props', field: 'visual_prompt' },
];

function listSections(projectId) {
    const db = database();
    return db.prepare(
        'SELECT id, section, body, fingerprint, updated_at FROM film_story_bible WHERE project_id = ? ORDER BY section')
        .all(projectId);
}

/**
 * Write sections. Merge, never replace.
 *
 * A caller fixing one section must not have to resend the rest — that is how a
 * bible loses a chapter to a retry.
 */
function writeSections(projectId, sections) {
    const db = database();
    const upsert = db.prepare(
        `INSERT INTO film_story_bible (id, project_id, section, body, fingerprint, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(project_id, section) DO UPDATE
           SET body = excluded.body, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`);

    const written = [];
    for (const [section, body] of Object.entries(sections || {})) {
        const name = String(section || '').trim();
        if (!name) continue;
        upsert.run(require('../db/database').generateId(), projectId, name, String(body || ''), hash(body));
        written.push(name);
    }
    return written;
}

/** Record that an entity's description was written from a section as it stands. */
function stampSubject(kind, id, section) {
    const spec = SUBJECTS.find(s => s.kind === kind);
    if (!spec || !section) return null;
    try {
        const db = database();
        const row = db.prepare(`SELECT project_id FROM ${spec.table} WHERE id = ?`).get(id);
        if (!row) return null;
        const sec = db.prepare('SELECT fingerprint FROM film_story_bible WHERE project_id = ? AND section = ?')
            .get(row.project_id, section);
        if (!sec) return null;      // a link to a section that does not exist is not a link
        db.prepare(`UPDATE ${spec.table} SET bible_section = ?, bible_fingerprint = ? WHERE id = ?`)
            .run(section, sec.fingerprint, id);
        return sec.fingerprint;
    } catch (_) { return null; }
}

/**
 * Entities whose bible section has moved since their description was written.
 *
 * Reports the entity and what has been generated from it, because "MAYA's
 * section changed" and "and her plate and eight frames were built on the old
 * one" are different sizes of problem.
 */
function drift(projectId) {
    const db = database();
    const sections = new Map(
        listSections(projectId).map(s => [s.section, s]));

    const out = [];
    for (const spec of SUBJECTS) {
        let rows = [];
        try {
            rows = db.prepare(
                `SELECT id, name, bible_section, bible_fingerprint FROM ${spec.table}
                  WHERE project_id = ? AND bible_fingerprint IS NOT NULL`).all(projectId);
        } catch (_) { continue; }

        for (const row of rows) {
            const sec = sections.get(row.bible_section);
            if (!sec) {
                out.push({
                    kind: spec.kind, id: row.id, name: row.name, section: row.bible_section,
                    reason: 'the section it was written from has been deleted',
                    plated: hasPlate(db, spec.kind, row.id),
                });
                continue;
            }
            if (sec.fingerprint === row.bible_fingerprint) continue;
            out.push({
                kind: spec.kind, id: row.id, name: row.name, section: row.bible_section,
                reason: 'that section changed after this was written',
                changed_at: sec.updated_at,
                plated: hasPlate(db, spec.kind, row.id),
                field: spec.field,
            });
        }
    }
    return out;
}

/** Whether a plate has been generated for this subject, so the cost is visible. */
function hasPlate(db, kind, id) {
    const column = kind === 'character' ? 'character_id' : kind === 'location' ? 'location_id' : 'prop_id';
    try {
        return !!db.prepare(
            `SELECT 1 FROM film_assets WHERE ${column} = ? LIMIT 1`).get(id);
    } catch (_) { return false; }
}

module.exports = { SUBJECTS, listSections, writeSections, stampSubject, drift, hash };
