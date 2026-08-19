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
    // Ordered the way a shoot actually runs, not the way the tables were
    // written. The previous grouping put nine unrelated pages under
    // "pre-production" — previs beside budget beside 3D — while "concept" held
    // nothing at all, which is a bucket rather than a progression.
    concept: { label: 'Concept', pages: ['moodboard'] },

    script: { label: 'Script', pages: ['screenplay', 'scenes'] },

    // Breaking a script down is its own act of work and was buried in the
    // pre-production bucket.
    'pre-production': {
        label: 'Breakdown & Design',
        pages: ['characters', 'locations', 'props', 'consistency', 'continuity', 'threed'],
    },

    storyboard: { label: 'Board & Block', pages: ['storyboard', 'shotboard', 'previs'] },

    // One page for the ten read-only surfaces built in phases 2 and 3. They
    // are all project-level reads — run plan, sides, DOOD, elements, setups,
    // staleness — and ten sidebar entries for ten panels is how a sidebar
    // becomes unusable.
    production: {
        label: 'Plan & Shoot',
        pages: ['production', 'videoshots', 'music', 'pipeline', 'flows', 'budget', 'milestones'],
    },

    'post-production': {
        label: 'Post',
        pages: ['colorgrading', 'colorpipeline', 'musiccues', 'dubbing'],
    },

    review: { label: 'Review', pages: ['playback', 'selects', 'notes', 'broadcastqc', 'renderhistory'] },

    export: { label: 'Deliver', pages: ['exportpage', 'assets', 'rights', 'provenance'] },

    complete: { label: 'Complete', pages: [] },
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
