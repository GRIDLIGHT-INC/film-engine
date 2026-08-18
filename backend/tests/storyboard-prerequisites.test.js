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
        boilerplate: /reference sheet|T-pose|seamless background|white background/i,
    },
    {
        id: 'location',
        build: style => buildPlatePrompt('location',
            { name: 'SUBURBAN STREET', description: 'late-1970s cul-de-sac' }, style),
        boilerplate: /reference plate/i,
    },
    {
        id: 'prop',
        build: style => buildPlatePrompt('prop',
            { name: 'Grocery bag', description: 'brown paper bag' }, style),
        boilerplate: /reference plate/i,
    },
];

/** The fields a storyboard panel has to show to be a storyboard panel. */
const PANEL_FIELDS = [
    { id: 'shot_code', probe: /f\.shot_code/ },
    { id: 'description', probe: /f\.description/ },
    { id: 'dialogue', probe: /f\.dialogue/ },
    { id: 'camera', probe: /f\.camera/ },
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

test('every plate is rendered in the project look, not a stock asset style', () => {
    const broken = [];
    for (const b of PLATE_BUILDERS) {
        const prompt = b.build(STYLE);
        const stylePos = prompt.indexOf(STYLE.slice(0, 30));
        const boiler = prompt.match(b.boilerplate);
        if (stylePos < 0) { broken.push(`${b.id}: the style never reaches the prompt`); continue; }
        if (!boiler) continue;   // no boilerplate to outrank
        if (stylePos > boiler.index) {
            broken.push(`${b.id}: "${boiler[0]}" leads and the style trails at ${stylePos} — `
                + 'the medium is decided before the look is mentioned');
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a plate with no style still names its medium, so it cannot default to clip art', () => {
    const vague = PLATE_BUILDERS
        .filter(b => !/photoreal|photograph|cinematic|film still/i.test(b.build(null)))
        .map(b => b.id);
    assert.deepStrictEqual(vague, [],
        `these ask for an image without ever saying what kind: ${vague.join(', ')}`);
});

test('the storyboard panel shows what a storyboard panel is for', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    // The frame card, not the whole SPA: other pages also mention these names.
    const start = html.indexOf("const grid = document.getElementById('storyboardGrid')");
    assert.ok(start > 0, 'storyboard grid renderer not found');
    const card = html.slice(start, start + 4000);

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
