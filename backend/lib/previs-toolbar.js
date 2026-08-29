/**
 * ── What all those buttons are ──────────────────────────────────────────────
 *
 * *"What are all the buttons on the top right… seems like we have a lot of
 * unused or overcomplicated buttons there."*
 *
 * Twelve controls on one row, and THREE OF THEM SAID SAVE about three different
 * things: Save blocking keeps the camera, Apply to card writes the camera onto
 * the scene card, Save frame writes a PNG to disk. Nothing on the page said
 * which one keeps a camera move, which is the question that was actually asked.
 *
 * The registry is the answer, and it is derived rather than typed beside the
 * toolbar: a control on the page that is not in here, or an entry here with no
 * control, fails the test. Grouped by THE JOB, because that is what makes a row
 * of twelve readable — a director is either staging a shot, looking at it,
 * committing it, or taking something out of the app.
 */

const PREVIS_GROUPS = Object.freeze([
    { id: 'stage', title: 'Stage', what: 'Put the camera where the shot is.' },
    { id: 'look', title: 'Look', what: 'See what this angle gives you. Free, except where it says otherwise.' },
    { id: 'commit', title: 'Commit', what: 'Keep it, and let the rest of the pipeline use it.' },
    { id: 'export', title: 'Export', what: 'Take something out of the app.' },
]);

/*
 * `saves` is filled in ONLY for the controls that persist something, and it
 * says WHAT — "the camera move" and "a PNG" being the same verb on the same row
 * is the whole confusion this was reported as.
 */
const PREVIS_CONTROLS = Object.freeze([
    {
        fn: 'previsFromCard', label: 'From card', group: 'stage', spends: false,
        what: 'Set the stage from what the scene card already says — framing, lens, movement.',
    },
    {
        fn: 'previsSolve', label: 'Solve framing', group: 'stage', spends: false,
        what: 'Turn a framing and a lens into a camera distance. Moves the camera; changes nothing else.',
    },
    {
        fn: 'previsPlay', label: 'Play move', group: 'look', spends: false,
        what: 'Play the move on the stage, at the duration it is set to. Nothing is written.',
    },
    {
        fn: 'previsPreviewFrame', label: 'Preview prompt', group: 'look', spends: false,
        what: 'The prompt this angle would generate, in full. Costs nothing, which is what makes trying three lenses free.',
    },
    {
        fn: 'previsSave', label: 'Save blocking', group: 'commit', spends: false,
        saves: 'the camera, the move and the staging, as this shot\'s blocking — staged, not yet on the scene card',
        what: 'Keep this angle. THIS is where a camera move is saved.',
    },
    {
        fn: 'previsApplyToCard', label: 'Apply to card', group: 'commit', spends: false,
        saves: 'the camera facets onto the scene card, so generation and the board read them',
        what: 'Write the angle onto the scene card. Until this, the blocking is an experiment.',
    },
    {
        fn: 'previsApprove', label: 'Approve', group: 'commit', spends: false,
        saves: 'a fingerprint of this stage, so restaging afterwards is caught',
        what: 'Sign off this angle. Restaging afterwards blocks generation until you re-approve.',
    },
    {
        fn: 'previsRenderShot', label: 'Render this angle', group: 'commit', spends: true,
        what: 'Save, apply, and regenerate the frame from this blocking. Costs credits.',
    },
    {
        fn: 'previsRecompose', label: 'New background…', group: 'commit', spends: true,
        what: 'Keep this shot\'s performance and framing, and put a different place behind it. Costs credits.',
    },
    {
        fn: 'previsExportFrame', label: 'Save frame', group: 'export', spends: false,
        saves: 'a PNG of the camera pane — a composition reference, never an init image',
        what: 'Write the camera view to disk as a picture.',
    },
    {
        fn: 'previsExportMove', label: 'Record move', group: 'export', spends: false,
        saves: 'a webm of the move playing, for showing someone',
        what: 'Record the stage playing the move. Not footage — the grey-box stage.',
    },
    {
        fn: 'importThreeDModel', label: 'Import GLB', group: 'stage', spends: false,
        what: 'Stand a generated or downloaded model on the stage as a silhouette.',
    },
]);

/** One line for the page, so "where is my move kept" is answerable in place. */
const SAVE_HELP =
    'A camera move is kept by Save blocking. Apply to card writes the angle onto the shot so '
    + 'generation uses it; Save frame and Record move write files and change nothing.';

module.exports = { PREVIS_GROUPS, PREVIS_CONTROLS, SAVE_HELP };
