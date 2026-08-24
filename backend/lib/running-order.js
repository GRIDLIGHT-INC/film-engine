/**
 * THE ORDER THE FILM PLAYS IN, said once.
 *
 * There were three of them, and they disagreed:
 *
 *   lib/timeline.js orderShots   scene_number, then sort_order, then shot_code
 *   lib/conform.js planConform   sort_order, then scene_number, then shot_code
 *   routes/shots.js (the list)   sort_order, then scene_number, then shot_code
 *
 * `sort_order` is PER SCENE and resets to 0 for each one, so putting it first
 * interleaves the scenes. On a real eight-shot project that produced
 *
 *   playback : 1A 1B 1BA 1C 2A 2AA 2B 2C 3A 3B 3C 3D
 *   conform  : 1A 1B 2A 3A 3B 3C 3D 2AA 1BA 2B 1C 2C   ← and all three exports
 *
 * — so the master file and every NLE export were assembling the film in a
 * scrambled order while playback showed it correctly. Nothing failed: the
 * exports opened and played, in the wrong sequence, which is the kind of defect
 * only an editor discovers and only after they have started cutting.
 *
 * A film plays scene by scene, and within a scene in the order the shots were
 * put in. So scene leads, and this is the one place that says so.
 */

/** Comparator for shot rows carrying scene_number, sort_order and shot_code. */
function compareShots(a, b) {
    const sceneA = Number(a && a.scene_number) || 0;
    const sceneB = Number(b && b.scene_number) || 0;
    if (sceneA !== sceneB) return sceneA - sceneB;
    const orderA = Number(a && a.sort_order) || 0;
    const orderB = Number(b && b.sort_order) || 0;
    if (orderA !== orderB) return orderA - orderB;
    /*
     * shot_code last, and it is what makes an inserted shot land where a
     * director expects: 2AA sorts between 2A and 2B by ordinary string
     * comparison, which is precisely why inserts are additive rather than a
     * renumber.
     */
    return String((a && a.shot_code) || '').localeCompare(String((b && b.shot_code) || ''));
}

/**
 * The same rule for the surfaces that order in SQL.
 *
 * Takes the ALIASES rather than assuming them. conform.js aliases shots `sh`
 * and scenes `s`; routes/nle-export.js does the exact opposite, `s` for shots
 * and `sc` for scenes. A fixed string plus a regex rewrite at the call site
 * silently produced `s.scene_number` there — a column that does not exist, and
 * a 500 on every export. Stating the aliases makes that unsayable.
 *
 * CAST because film_scenes.scene_number has INTEGER affinity and returns '2A'
 * for a scene numbered 2A — one column, two types, which an ordering has to
 * absorb rather than pass on.
 */
function orderBySql(aliases) {
    const a = aliases || {};
    const shots = a.shots || 'sh';
    const scenes = a.scenes || 's';
    return `CAST(${scenes}.scene_number AS INTEGER), ${shots}.sort_order, ${shots}.shot_code`;
}

/** The common aliasing: shots `sh`, scenes `s`. */
const ORDER_BY_SQL = orderBySql();

/** Shots in the order the film plays. */
function orderShots(shots = []) {
    return [...shots].sort(compareShots);
}

module.exports = { compareShots, orderBySql, ORDER_BY_SQL, orderShots };
