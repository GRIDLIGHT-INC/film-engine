/**
 * The sidebar, ordered the way this director works.
 *
 * This used to be DERIVED from PROJECT_PHASES — nine groups, matching the
 * status machine a project advances through — on the reasoning that the menu
 * and the phase a project reports itself in must not drift apart. That
 * derivation is deliberately given up here, and the reason is worth recording
 * rather than discovering later from the diff.
 *
 * The four groups asked for CUT ACROSS the phases: Consistency is
 * pre-production and belongs under Plan; Milestones and Budget are production
 * and belong under Plan; Assets is an export surface and belongs under Post
 * beside the job queue. No merge of the nine produces these four. Keeping the
 * derivation would have meant bending either the menu or the status machine to
 * fit the other, and the menu is what a person uses every day.
 *
 * What is NOT given up is the invariant that was doing the real work: every
 * page in the build sits in exactly one group, and no group names a page that
 * does not exist. An orphaned page — still in the build, unreachable from the
 * menu — looks exactly like a deleted feature until somebody asks where it
 * went. `tests/nav-reorg.test.js` holds both.
 *
 * Served over GET /film/nav-flow and applied by MOVING the existing sidebar
 * buttons, so every tooltip, icon and handler in the markup survives and only
 * the grouping and order come from here.
 */

/**
 * Pages that belong to no group.
 *
 * A home page and a settings screen are needed in all four, so filing them
 * under one would put them in the wrong place three times out of four. The
 * style book is the DIRECTOR's rather than a project's — it accumulates across
 * films — so a library that outlives every project does not belong inside the
 * workflow of one.
 */
/*
 * `brand` sits here for the reason the style book does: a brand kit accumulates
 * across films. One client buys many spots, and a kit scoped to a project is
 * one that is re-uploaded every time that client comes back.
 */
const ALWAYS_AVAILABLE = ['dashboard', 'settings', 'stylebook', 'brand'];

/**
 * Group -> the pages it holds, in the order they are worked in.
 *
 * Ordered as a film is made: write it, plan it, shoot it, finish it.
 */
const NAV_FLOW = {
    write: {
        label: 'Write & Design',
        pages: ['screenplay', 'scenes', 'notes', 'moodboard',
            'characters', 'locations', 'props', 'threed'],
    },

    plan: {
        label: 'Plan',
        /*
         * `deliverables` leads the group. On a commercial the output list is
         * decided BEFORE anything is boarded, because it is what says which
         * shots must be shot vertical rather than cropped later — and a crop to
         * 9:16 keeps a third of the frame. A film simply never opens it.
         */
        pages: ['deliverables', 'storyboard', 'previs', 'consistency', 'milestones', 'budget'],
    },

    production: {
        label: 'Production',
        // musiccues sits beside music because it is where a cue's DIRECTION is
        // written — the description that reaches the generator — and the two
        // pages are one job. It was not in the requested list and dropping it
        // would have removed the only surface where music direction can be
        // written, which is a capability loss rather than a tidy-up.
        // `productiongraph` is the node graph that replaces the eight below it. The
        // `production_graph` setting decides which the menu shows; every one
        // stays in the build and reachable by URL until the graph has parity.
        pages: ['productiongraph', 'shotboard', 'videoshots', 'music', 'musiccues', 'musicws', 'playback',
            'pipeline', 'flows'],
    },

    post: {
        label: 'Post',
        // `titles` and `subtitles` are delivery surfaces: what the film says
        // over its own head and at its end, and what it says for anyone who
        // cannot hear it. Both routes shipped with the delivery work and
        // neither had a page, so every field they accept could only be written
        // by curl or by an agent.
        // `edits` leads: the cut comes back from the editor before anything is
        // delivered, and a score is written against it.
        pages: ['edits', 'exportpage', 'titles', 'subtitles', 'rights', 'marketing', 'assets',
            'jobsqueue', 'renderhistory'],
    },
};

/** The order the groups are shown in — declaration order, which is work order. */
const GROUP_ORDER = ['write', 'plan', 'production', 'post'];

/** Which group owns this page, or null when it is always available. */
function phaseOf(page) {
    for (const id of GROUP_ORDER) {
        if (NAV_FLOW[id] && NAV_FLOW[id].pages.includes(page)) return id;
    }
    return null;
}

/**
 * The groups that have anything in them, in work order.
 *
 * Still called `orderedPhases` because the SPA and GET /film/nav-flow read that
 * name and the shape is unchanged; renaming it would be a second edit in the
 * page for no behavioural gain.
 */
function orderedPhases() {
    return GROUP_ORDER
        .filter(id => NAV_FLOW[id] && NAV_FLOW[id].pages.length)
        .map(id => ({ id, label: NAV_FLOW[id].label, pages: NAV_FLOW[id].pages }));
}

module.exports = { NAV_FLOW, ALWAYS_AVAILABLE, GROUP_ORDER, phaseOf, orderedPhases };
