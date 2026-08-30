/**
 * What has to be true before a storyboard is worth generating — and what a
 * director needs in order to keep working on it afterwards.
 *
 * Three failures from one production, each a different shape of the same
 * mistake: the pipeline can DO the thing, and the path to it is missing.
 *
 *   PLATES    Every plate builder appends the project's style LAST, behind its
 *             own boilerplate: "character reference sheet, front view, full
 *             body, T-pose, plain seamless background" leads, and a stock
 *             asset-library render is what that phrasing asks for. The result
 *             was a flat vector cutout of MAYA with a shrug emoji beside her
 *             head, which then dragged every shot that referenced her into
 *             cartoon while the location plate — same bug, weaker boilerplate —
 *             came out photoreal and held perfectly. A style that arrives after
 *             the medium has been decided is decoration.
 *
 *   PANEL     The storyboard API returns `description` and `dialogue` per
 *             frame. The viewer renders the description truncated to 80
 *             characters and drops the dialogue entirely, so the one thing a
 *             storyboard panel is FOR — knowing what happens and who says what
 *             — is the thing it does not show.
 *
 *   PREVIS    routes/previs.js has seven director-facing operations and the MCP
 *             surface exposes none of them. The whole point of blocking a shot
 *             is exploring angles until you are happy, and the agent host that
 *             drives this pipeline cannot reach a single one.
 *
 * Set-based per group, because each failed partially: locations produced a good
 * plate while characters produced clip art, description reached the panel while
 * dialogue did not. An example passes on the half that works.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildPlatePrompt } = require('../lib/reference-plates');
const { buildRefSheetPrompt } = require('../routes/characters');
const mcp = require('../lib/mcp-tools');

const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');
const PREVIS_ROUTE = path.join(__dirname, '..', 'routes', 'previs.js');

const STYLE = 'Guillermo del Toro gothic: teal and amber palette, wet streets, anamorphic, 35mm film grain';

/**
 * Everything that produces a reference plate. A plate defines a subject's
 * medium for every frame that references it, so the look has to govern it.
 */
const PLATE_BUILDERS = [
    {
        id: 'character',
        build: style => buildRefSheetPrompt(
            { name: 'MAYA', appearance_prompt: 'mid-30s woman, rust cardigan' }, 'front', style),
        // The phrase that asks for a stock asset render.
        boilerplate: /reference sheet|T-pose|white background/i,
        /*
         * A SUBJECT plate takes the MEDIUM, not the style preset.
         *
         * The original rule here — the style must reach every plate and lead
         * it — was written against a plate that came back as a flat vector
         * cutout, and it fixed that. It also carried the style's SCENE
         * description onto plates that exist to have no scene: a real preset
         * put 276 characters of "hard low-sun key raking through glass …
         * practical tungsten warmth blooming in frame" on a picture whose
         * whole job is an empty frame.
         *
         * The guarantee is unchanged — a plate must never leave its medium
         * unsaid — and it is now carried by the mood board's `medium` rather
         * than by the whole preset.
         */
        takesStyle: false,
    },
    {
        id: 'location',
        build: style => buildPlatePrompt('location',
            { name: 'SUBURBAN STREET', description: 'late-1970s cul-de-sac' }, style),
        boilerplate: /reference plate/i,
        // A location plate IS an environment; its style legitimately
        // describes the place, and there is nothing to exclude.
        takesStyle: true,
    },
    {
        id: 'prop',
        build: style => buildPlatePrompt('prop',
            { name: 'Grocery bag', description: 'brown paper bag' }, style),
        boilerplate: /reference plate/i,
        takesStyle: false,
    },
];

/** The fields a storyboard panel has to show to be a storyboard panel. */
const PANEL_FIELDS = [
    { id: 'shot_code', probe: /f\.shot_code/ },
    { id: 'description', probe: /f\.description/ },
    { id: 'dialogue', probe: /f\.dialogue/ },
    // The effective camera, which on a blocked shot is not the card's — the
    // board used to show the one set of values generation was going to ignore.
    { id: 'camera', probe: /f\.camera|f\.effective/ },
    { id: 'duration', probe: /f\.duration_ms/ },
];

/**
 * The previs operations a director drives while exploring a shot. Derived from
 * the route's own dispatch rather than a wish list.
 */
const PREVIS_OPS = [
    { id: 'blocking_get', tool: 'previs_get' },
    { id: 'blocking_put', tool: 'previs_set' },
    { id: 'solve', tool: 'previs_solve' },
    { id: 'from_card', tool: 'previs_from_card' },
    { id: 'to_storyboard', tool: 'previs_to_storyboard' },
    { id: 'apply', tool: 'previs_apply' },
    { id: 'approve', tool: 'previs_approve' },
];

test('the previs op list matches what the route actually dispatches', () => {
    // Guards the registry against drifting from the code it describes.
    const src = fs.readFileSync(PREVIS_ROUTE, 'utf8');
    for (const op of ['from-card', 'approve', 'apply', 'to-storyboard', 'solve']) {
        assert.ok(src.includes(`'${op}'`), `routes/previs.js no longer dispatches ${op}`);
    }
});

test('every plate states what kind of picture it is, before any boilerplate', () => {
    /*
     * The guarantee is that a plate never lets boilerplate decide its medium —
     * that is what produced a flat vector cutout with a shrug emoji. WHICH
     * statement carries the medium now differs by kind: a location takes the
     * project style, and a character or prop takes the mood board's `medium`,
     * because a style preset describes finished frames and a subject plate
     * exists to have no frame around it.
     */
    const broken = [];
    for (const b of PLATE_BUILDERS) {
        const prompt = b.build(STYLE);
        const boiler = prompt.match(b.boilerplate);

        const mediumPos = b.takesStyle
            ? prompt.indexOf(STYLE.slice(0, 30))
            : (/^(photoreal|[a-z0-9 ,'-]*?(animation|render|photoreal|illustration))/i.exec(prompt) ? 0 : -1);

        if (mediumPos < 0) {
            broken.push(b.takesStyle
                ? `${b.id}: the style never reaches the prompt`
                : `${b.id}: the prompt does not open by saying what kind of picture it is`);
            continue;
        }
        if (!boiler) continue;   // no boilerplate to outrank
        if (mediumPos > boiler.index) {
            broken.push(`${b.id}: "${boiler[0]}" leads and the medium trails at ${mediumPos} — `
                + 'the kind of picture is decided before it is stated');
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a subject plate does not carry the style preset at all', () => {
    // The rule stated negatively, beside the one above: whatever the style
    // says about places must not reach a picture that has no place in it.
    for (const b of PLATE_BUILDERS.filter(x => !x.takesStyle)) {
        const prompt = b.build(STYLE);
        assert.ok(!prompt.includes(STYLE.slice(0, 30)),
            `${b.id} carries the style preset, which describes a scene`);
    }
    // And the one that legitimately does still does.
    for (const b of PLATE_BUILDERS.filter(x => x.takesStyle)) {
        assert.ok(b.build(STYLE).includes(STYLE.slice(0, 30)),
            `${b.id} lost the style preset, which describes the place it is a plate of`);
    }
});

test('a plate with no style still names its medium, so it cannot default to clip art', () => {
    const vague = PLATE_BUILDERS
        .filter(b => !/photoreal|photograph|cinematic|film still/i.test(b.build(null)))
        .map(b => b.id);
    assert.deepStrictEqual(vague, [],
        `these ask for an image without ever saying what kind: ${vague.join(', ')}`);
});

/**
 * The frame card, plus the helper it delegates its facets to.
 *
 * A fixed window over the renderer stopped working the moment the tags moved
 * into a function of their own — which is the right move (the board now shows
 * the EFFECTIVE camera, not the card's, and that needs more than a ternary) and
 * would have read here as the panel having lost its camera entirely.
 */
function panelSource(html) {
    const start = html.indexOf("const grid = document.getElementById('storyboardGrid')");
    assert.ok(start > 0, 'storyboard grid renderer not found');
    const tags = html.indexOf('function storyboardFacetTags(');
    assert.ok(tags > 0, 'the frame card renders no facets at all');

    /*
     * Bounded by the TEMPLATE, not by a character count. A fixed 4000-character
     * window stopped containing `description` and `dialogue` the moment a
     * protect overlay and a per-shot ratio picker were added to the tile — and
     * it read here as the panel having lost the two fields a storyboard exists
     * to carry, which is the opposite of what happened.
     *
     * The card template ends where the map that builds it is joined.
     */
    const end = html.indexOf(".join('');", start);
    assert.ok(end > start, 'the frame card template does not end where it is joined');
    return html.slice(start, end) + html.slice(tags, tags + 3000);
}

test('the storyboard panel shows what a storyboard panel is for', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const card = panelSource(html);

    const missing = PANEL_FIELDS.filter(f => !f.probe.test(card)).map(f => f.id);
    assert.deepStrictEqual(missing, [],
        `the panel never renders: ${missing.join(', ')} — a storyboard without them is a contact sheet`);
});

test('the frame description is not truncated to a fragment', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const start = html.indexOf("const grid = document.getElementById('storyboardGrid')");
    const card = html.slice(start, start + 4000);
    const cut = card.match(/f\.description\.slice\(0,\s*(\d+)\)/);
    assert.ok(!cut || Number(cut[1]) >= 200,
        `the action is cut to ${cut && cut[1]} characters, which loses the shot it describes`);
});

test('every previs operation is reachable over MCP, so angles can be explored from an agent', () => {
    const tools = new Set(mcp.listTools().map(t => t.name));
    const missing = PREVIS_OPS.filter(op => !tools.has(op.tool)).map(op => op.tool);
    assert.deepStrictEqual(missing, [],
        `blocking a shot is unreachable from an agent host: ${missing.join(', ')}`);
});
