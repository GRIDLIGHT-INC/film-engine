/**
 * Grouping a board for reading, and grouping shots for working.
 *
 * Two questions that look alike and are not.
 *
 * PANEL GROUPING is for reading. A flat grid of two hundred frames is a contact
 * sheet; a director reads a board scene by scene, or by location when deciding
 * what a day covers.
 *
 * SETUP GROUPING is for working, and this is where the set metaphor has to be
 * translated rather than copied. On a set, a camera setup is a lighting and
 * camera position you shoot several shots from before moving, and you group by
 * it because MOVING is what costs. Here nothing moves. The cost is conditioning:
 * shots that share a location plate, a framing and a lens reuse the same
 * references and the same look, so grouping them is what makes a run cheap and
 * a look consistent. Same word, different expense — copying the literal meaning
 * would produce grouping that saves nothing.
 *
 * Reads only.
 */

const { db } = require('../db/database');

/** The axes a board can be read along. */
const GROUP_AXES = ['scene', 'location', 'time_of_day'];

function parseCard(yaml) {
    try { return JSON.parse(yaml || '{}'); } catch (_) { return {}; }
}

function framesOf(projectId) {
    return db.prepare(
        `SELECT sh.id AS shot_id, sh.shot_code, sh.scene_card_yaml,
                s.id AS scene_id, s.scene_number, s.location, s.time_of_day
           FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ?
          ORDER BY CAST(s.scene_number AS INTEGER), s.scene_number, sh.shot_code`).all(projectId);
}

/**
 * Group the board along one axis.
 *
 * Every frame lands in exactly one group, including frames whose axis value is
 * missing — those collect under an explicit "(unset)" rather than vanishing,
 * because a frame that disappears from the board when you change how you read
 * it looks like data loss.
 */
function groupFrames(projectId, axis) {
    const useAxis = GROUP_AXES.includes(axis) ? axis : 'scene';
    const rows = framesOf(projectId);

    const keyOf = row => {
        if (useAxis === 'scene') return `Scene ${row.scene_number}`;
        if (useAxis === 'location') return String(row.location || '').trim() || '(no location)';
        return String(row.time_of_day || '').trim() || '(no time of day)';
    };

    const groups = new Map();
    for (const row of rows) {
        const label = keyOf(row);
        if (!groups.has(label)) groups.set(label, { axis: useAxis, label, frames: [] });
        groups.get(label).frames.push({
            shot_id: row.shot_id,
            shot_code: row.shot_code,
            scene: String(row.scene_number),
            location: row.location || '',
        });
    }
    return [...groups.values()];
}

/**
 * Group shots into setups: same place, same optics, same look.
 *
 * The key is deliberately narrow. Widening it (dropping the lens, say) would
 * merge shots whose frames genuinely differ and claim a reuse that does not
 * exist — and the number this produces is meant to be trusted by a run plan.
 */
function buildSetups(projectId) {
    const rows = framesOf(projectId);
    const setups = new Map();

    for (const row of rows) {
        const card = parseCard(row.scene_card_yaml);
        const camera = card.camera || {};
        const shared = {
            location: String(row.location || '').trim() || '(no location)',
            shot_type: String(camera.shot_type || '').trim() || '(unset)',
            lens: String(camera.lens || '').trim() || '(unset)',
        };
        // Location leads because it is the plate, and a plate is the most
        // expensive thing to be wrong about — a shot reusing another's optics
        // in a different place shares nothing that matters.
        const key = `${shared.location}|${shared.shot_type}|${shared.lens}`;
        if (!setups.has(key)) {
            setups.set(key, {
                id: `setup-${setups.size + 1}`,
                shared,
                label: `${shared.location} · ${shared.shot_type} · ${shared.lens}`,
                shots: [],
            });
        }
        setups.get(key).shots.push({ shot_id: row.shot_id, shot_code: row.shot_code, scene: String(row.scene_number) });
    }

    const list = [...setups.values()];
    // Biggest first: the setups worth grouping are the ones covering several
    // shots, and a list led by singletons buries them.
    list.sort((a, b) => b.shots.length - a.shots.length || a.label.localeCompare(b.label));
    return list;
}

module.exports = { groupFrames, buildSetups, GROUP_AXES };
