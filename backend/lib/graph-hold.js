/**
 * Hold a node (PGN-016).
 *
 * A held shot, sequence or cue is left alone by every batch run and stays in
 * the film — conform and export never read the hold, so holding something can
 * never quietly remove it from the cut. It is set and released through each
 * node's EXISTING update route and MCP update tool, so the page, an agent and
 * curl cannot come to disagree about what "held" means.
 *
 * HOLDABLE is the one statement of which nodes can be held; the routes, the
 * tools, the graph and the page are all held to it by test.
 */

const HOLDABLE = Object.freeze([
    { node: 'shot', key_prefix: 'shot', table: 'film_shots', tool: 'shot_update',
        route_module: 'shots', handler: 'handleShots', path: id => `/film/shots/${id}` },
    { node: 'sequence', key_prefix: 'seq', table: 'film_sequences', tool: 'sequence_update',
        route_module: 'sequences', handler: 'handleSequences', path: id => `/film/sequences/${id}` },
    { node: 'sound', key_prefix: 'sound', table: 'film_music_cues', tool: 'music_cue_update',
        route_module: 'assets', handler: 'handleAssets', path: id => `/film/music-cues/${id}` },
]);

/**
 * `held` read strictly. true holds, false or null releases; a string "true"
 * or a 1 is refused, because a value read loosely is how "false" comes to hold.
 */
function readHeld(value) {
    if (value === true) return { hold: true };
    if (value === false || value === null) return { hold: false };
    return { error: 'held must be true (hold: batch runs skip it, the film keeps it) or false (release)' };
}

/** The SQL value for held_at: now when holding, NULL when releasing. */
function heldAtSql(hold) { return hold ? "datetime('now')" : 'NULL'; }

module.exports = { HOLDABLE, readHeld, heldAtSql };
