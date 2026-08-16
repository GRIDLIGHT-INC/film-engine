/**
 * The sidebar, ordered the way a film is actually made.
 *
 * The app grew to 34 pages and grouped them by what they ARE — production,
 * elements, media, workflow — rather than by when a filmmaker needs them. So
 * Previs, a pre-production tool, sat below Export; and Storyboard sat three
 * groups from the Shot Board it feeds. The nav described the software's
 * contents instead of answering "what do I do next".
 *
 * The order is NOT invented here. routes/production-status.js already declares
 * it in PROJECT_PHASES, and the status machine advances a project through
 * exactly those nine. Deriving the sidebar from that constant means the menu
 * and the phase a project reports itself to be in cannot drift apart.
 *
 * Served over GET /film/nav-flow and applied to the existing sidebar buttons by
 * the SPA, rather than being a second copy of the nav: every tooltip, icon and
 * handler already in the markup is preserved, and only the grouping and order
 * come from here.
 */

const { PROJECT_PHASES } = require('../routes/production-status');

/**
 * Pages that belong to no phase.
 *
 * A dashboard and a settings screen are needed in all nine, so forcing them
 * into one would put them in the wrong place eight times out of nine. They are
 * pinned above the phase groups instead.
 */
const ALWAYS_AVAILABLE = ['dashboard', 'settings', 'jobsqueue'];

/**
 * Phase -> the pages that serve it.
 *
 * `concept` and `complete` carry no pages: nothing in the app is only usable
 * before a script exists or only after delivery. They are left declared and
 * empty rather than deleted, so the map stays comparable to PROJECT_PHASES.
 */
const NAV_FLOW = {
    'concept': { label: 'Concept', pages: [] },

    'script': { label: 'Script', pages: ['screenplay', 'scenes', 'acts'] },

    'pre-production': {
        label: 'Pre-Production',
        // Everything decided before a frame is generated: who and where, what
        // they look like from shot to shot, where the camera goes, and what it
        // will cost.
        pages: ['characters', 'locations', 'props', 'previs', 'consistency', 'continuity', 'threed', 'budget', 'milestones'],
    },

    'storyboard': { label: 'Storyboard', pages: ['storyboard', 'shotboard'] },

    'production': {
        label: 'Production',
        // Generating picture and sound.
        pages: ['videoshots', 'music', 'pipeline', 'flows'],
    },

    'post-production': {
        label: 'Post-Production',
        pages: ['colorgrading', 'colorpipeline', 'musiccues', 'dubbing'],
    },

    'review': {
        label: 'Review',
        // Watching it back and deciding what is good.
        pages: ['playback', 'selects', 'notes', 'broadcastqc', 'renderhistory'],
    },

    'export': {
        label: 'Delivery',
        pages: ['exportpage', 'assets', 'rights', 'provenance'],
    },

    'complete': { label: 'Complete', pages: [] },
};

/** Which phase owns this page, or null when it is always available. */
function phaseOf(page) {
    for (const [id, phase] of Object.entries(NAV_FLOW)) {
        if (phase.pages.includes(page)) return id;
    }
    return null;
}

/** The phases that have anything in them, in production order. */
function orderedPhases() {
    return PROJECT_PHASES
        .filter(id => NAV_FLOW[id] && NAV_FLOW[id].pages.length)
        .map(id => ({ id, label: NAV_FLOW[id].label, pages: NAV_FLOW[id].pages }));
}

module.exports = { NAV_FLOW, ALWAYS_AVAILABLE, phaseOf, orderedPhases, PROJECT_PHASES };
