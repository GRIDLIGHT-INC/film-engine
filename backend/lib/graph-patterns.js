/**
 * Coverage patterns (PGN-020): the handful of shot shapes a director reaches
 * for again and again, laid down in one step on the production graph.
 *
 * A pattern is shots and joins, nothing else. Its preview is FREE and writes
 * nothing; creating it inserts the shots after the anchor — numbered as a
 * script supervisor numbers inserts (2AA, 2AB, 2AC), through the same insert
 * the route uses — and makes one sequence of them with its joins. Nothing is
 * generated: frames and clips are made afterwards, through the confirmation,
 * like any other shot's.
 *
 * Every shot type is one the scene-card schema accepts and every join one the
 * sequence planner knows, held by tests/graph-patterns.test.js.
 */

const { insertShotsAfter, insertCodes } = require('./shot-insert-code');

const PATTERNS = Object.freeze([
    {
        id: 'shot_reverse', label: 'Shot / reverse shot',
        why: 'a two-hander played across the eyeline: over one shoulder, then the reverse over the other',
        shots: [
            { role: 'shot', shot_type: 'over-the-shoulder', note: 'over the listener’s shoulder, on the speaker' },
            { role: 'reverse', shot_type: 'over-the-shoulder', note: 'the reverse: over the speaker’s shoulder, on the listener' },
        ],
        joins: ['cut'],
    },
    {
        id: 'insert_reaction', label: 'Insert then reaction',
        why: 'show the thing that matters, then the face that sees it — the detail earns the reaction',
        shots: [
            { role: 'insert', shot_type: 'insert', note: 'the detail: what is being looked at' },
            { role: 'reaction', shot_type: 'close-up', note: 'the reaction to it' },
        ],
        joins: ['cut'],
    },
    {
        id: 'wide_medium_close', label: 'Wide, medium, close',
        why: 'the classic walk in: where we are, who is there, what they feel',
        shots: [
            { role: 'wide', shot_type: 'wide', note: 'the whole space: where we are' },
            { role: 'medium', shot_type: 'medium', note: 'the people in it: who is there' },
            { role: 'close', shot_type: 'close-up', note: 'the face: what they feel' },
        ],
        joins: ['cut', 'cut'],
    },
]);

const parse = t => { try { return t ? JSON.parse(t) : {}; } catch (_) { return {}; } };

/** The anchor, checked to be a shot of this project. */
function anchorOf(db, projectId, afterShotId) {
    const row = afterShotId ? db.prepare(`SELECT sh.*, sc.project_id FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
        WHERE sh.id = ?`).get(afterShotId) : null;
    if (!row || row.project_id !== projectId) return null;
    return row;
}

/** The cards a pattern would write after this anchor: its cast and props carried, where it came from said. */
function cardsFor(pattern, anchor) {
    const base = parse(anchor.scene_card_yaml);
    const what = String(base.description || base.action || '').trim();
    return pattern.shots.map(s => {
        const card = {
            description: `${pattern.label} — ${s.role} (${s.note}), after ${anchor.shot_code}${what ? ': ' + what.slice(0, 240) : ''}`,
            camera: { shot_type: s.shot_type },
        };
        if (Array.isArray(base.characters) && base.characters.length) card.characters = [...base.characters];
        if (Array.isArray(base.props) && base.props.length) card.props = [...base.props];
        return card;
    });
}

/**
 * The free preview: the shots (with the codes they will get), the sequence
 * and its joins. Writes nothing and resolves no provider.
 */
function planPattern(db, projectId, patternId, afterShotId) {
    const pattern = PATTERNS.find(p => p.id === patternId);
    if (!pattern) return { status: 404, error: `No pattern "${patternId}". Patterns: ${PATTERNS.map(p => p.id).join(', ')}` };
    const anchor = anchorOf(db, projectId, afterShotId);
    if (!anchor) return { status: 404, error: 'That shot is not in this project' };
    const used = db.prepare('SELECT shot_code FROM film_shots WHERE scene_id = ?').all(anchor.scene_id).map(r => r.shot_code);
    const codes = insertCodes(anchor.shot_code, used, pattern.shots.length);
    if (!codes) return { status: 409, error: `There is no room for ${pattern.shots.length} more inserts after ${anchor.shot_code}.` };
    const cards = cardsFor(pattern, anchor);
    return {
        pattern: pattern.id, label: pattern.label, why: pattern.why,
        after: { shot_id: anchor.id, shot_code: anchor.shot_code },
        shots: cards.map((card, i) => ({ code: codes[i], role: pattern.shots[i].role, shot_type: pattern.shots[i].shot_type,
            description: card.description, characters: card.characters || [], card: { ...card, shot_code: codes[i] } })),
        sequence: { name: `${pattern.label} · ${codes[0]}–${codes[codes.length - 1]}`, shot_codes: codes },
        joins: pattern.joins.map((type, i) => ({ type, between: [codes[i], codes[i + 1]] })),
        cost: 0, generates: false,
        note: 'Creating this adds the shots and the sequence and generates nothing; make their frames and clips afterwards, through the confirmation.',
    };
}

/** Create it: the shots through the one insert, then one sequence of them with its joins. Generates nothing. */
function createPattern(db, projectId, patternId, afterShotId) {
    const plan = planPattern(db, projectId, patternId, afterShotId);
    if (plan.error) return plan;
    const pattern = PATTERNS.find(p => p.id === patternId);
    const anchor = anchorOf(db, projectId, afterShotId);
    const made = insertShotsAfter(db, afterShotId, cardsFor(pattern, anchor), { projectId });
    if (made.error) return made;
    const { generateId } = require('../db/database');
    const sequenceId = generateId();
    db.prepare(`INSERT INTO film_sequences (id, project_id, name, shot_ids, description, joins_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(sequenceId, projectId, plan.sequence.name, JSON.stringify(made.ids),
        pattern.why, JSON.stringify(pattern.joins.map(type => ({ type, prompt: '' }))));
    return { pattern: pattern.id, shot_ids: made.ids, codes: made.codes, sequence_id: sequenceId, generated: 0 };
}

module.exports = { PATTERNS, planPattern, createPattern };
