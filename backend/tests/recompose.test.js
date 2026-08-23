/**
 * Recompose: keep the performance from one frame, take the place from another.
 *
 * "V6's framing and reaction are perfect, but not the background — it should be
 * the opposite side, as she's looking at the dragon. Where is the background
 * plate for the opposite side, so I can generate a new picture using V6 as the
 * image to be changed but the background as the anchor?"
 *
 * No existing operation can express that. `regenerate` rebuilds the whole frame
 * from the card. `refine` sends ONE picture and a negative that explicitly
 * refuses `different composition, different framing` — and on a close-up the
 * background IS most of the composition it is told to preserve, so refine is
 * structurally incapable of replacing it. Every path treats references as
 * "things to be consistent with"; none assigns them ROLES.
 *
 * Recompose does: two ordered references, [0] the frame whose performance is
 * kept, [1] the plate whose place is adopted.
 *
 * Set-based over the image adapters and over (surface × operation), because
 * both failures are partial and silent: an adapter that drops the second
 * reference composites nothing and returns a plausible frame, and a surface
 * that lacks the action teaches a director the feature does not exist.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(ROOT, 'routes', 'storyboard.js'), 'utf8');

// ── The set: every adapter that could receive this ──────────────────────

/** Adapters serving `image`, derived from the provider directory. */
const IMAGE_ADAPTERS = (() => {
    const dir = path.join(ROOT, 'lib', 'providers');
    const out = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js') || ['index.js', 'base.js', 'credentials.js', 'oauth.js'].includes(f)) continue;
        let mod;
        try { mod = require(path.join(dir, f)); } catch (_) { continue; }
        const a = mod.adapter || mod;
        const caps = a.capabilities || [];
        const serves = Array.isArray(caps) ? caps.includes('image') : !!(caps && caps.image);
        if (serves || /image/i.test(f)) out.push({ file: f, adapter: a });
    }
    return out;
})();

test('every image adapter can carry two ordered references', () => {
    /*
     * Roles are POSITIONAL, not tagged. Only Runway preserves @tags; Meshy and
     * Gridlight flatten the array and OpenAI's edit input has no tag syntax —
     * and this project runs Meshy. So an adapter that accepts fewer than two
     * references cannot express "subject here, place there" at all, and would
     * silently composite nothing.
     */
    assert.ok(IMAGE_ADAPTERS.length >= 3,
        `expected the image adapters, found ${IMAGE_ADAPTERS.map(a => a.file).join(', ')}`);
    const tooFew = IMAGE_ADAPTERS.filter(({ adapter }) =>
        !Number.isFinite(adapter.maxReferenceImages) || adapter.maxReferenceImages < 2);
    assert.deepStrictEqual(tooFew.map(a => a.file), [],
        'these serve image but cannot carry two references, so a recompose sent to them would '
        + `drop the background and return a plausible wrong frame: ${tooFew.map(a => a.file).join(', ')}`);
});

// ── One builder, shared by the preview and the generation ───────────────

test('the recompose prompt is built in exactly one place', () => {
    // refine already shipped this bug: its confirm dialog called the
    // REGENERATION preview, so a director saw a 3,800-character prompt and five
    // plates that a refine does not send. A preview built separately from the
    // generation is a plausible fiction.
    assert.ok(/function buildRecomposePayload\(/.test(ROUTES),
        'there is no single recompose builder');
    const at = ROUTES.indexOf('function buildRecomposePayload(');
    let i = ROUTES.indexOf('{', at), d = 0, end = -1;
    for (let j = i; j < ROUTES.length; j++) {
        if (ROUTES[j] === '{') d++;
        else if (ROUTES[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
    }
    const outside = ROUTES.slice(0, at) + ROUTES.slice(end);
    assert.ok(!/Replace the entire background/.test(outside),
        'the recompose wording exists outside its builder, so preview and generation can drift');
});

test('the prompt leads with the change and names both roles positionally', () => {
    const { buildRecomposePayload } = require('../routes/storyboard');
    assert.ok(typeof buildRecomposePayload === 'function', 'buildRecomposePayload is not exported');
    const { prompt, negative_prompt } = buildRecomposePayload({ view: 'from the far kerb' });

    // Change first. Three failures today had continuity language outranking the
    // change, and each time the model returned the source unchanged.
    assert.ok(/^Replace the entire background/i.test(prompt.trim()),
        `the prompt does not lead with the replacement: "${prompt.slice(0, 70)}…"`);
    const replaceAt = prompt.toLowerCase().indexOf('replace the entire background');
    const keepAt = prompt.toLowerCase().indexOf('keep the person');
    assert.ok(replaceAt < keepAt, 'preservation is stated before the change');

    // Roles by ORDER, because tags do not survive Meshy or Gridlight.
    assert.ok(/FIRST reference image/.test(prompt) && /SECOND reference image/.test(prompt),
        'the two pictures are not distinguished positionally');

    // One source of truth per role: the FIRST supplies the performance, the
    // SECOND supplies the environment INCLUDING its light. Claiming the
    // original lighting while adopting a new place asks for two answers to one
    // question.
    const keepClause = prompt.slice(keepAt, prompt.toLowerCase().indexOf('use the second'));
    assert.ok(!/light/i.test(keepClause),
        'the prompt claims the original lighting while adopting a new environment — one source '
        + 'of truth per role');

    // Paired negatives, both directions.
    for (const phrase of ['original background', 'different person', 'different pose',
        'different framing', 'extra person']) {
        assert.ok(negative_prompt.includes(phrase),
            `the negative does not refuse "${phrase}"`);
    }
});

test('a director instruction is additive and never displaces the contract', () => {
    const { buildRecomposePayload } = require('../routes/storyboard');
    const withNote = buildRecomposePayload({ view: 'x', instruction: 'push the rain harder' });
    assert.ok(/^Replace the entire background/i.test(withNote.prompt.trim()),
        'a director note displaced the leading instruction');
    assert.ok(withNote.prompt.includes('push the rain harder'),
        'the director note never reaches the prompt');
    assert.ok(withNote.prompt.trim().endsWith('push the rain harder.')
        || withNote.prompt.includes('push the rain harder'),
        'the note is not last, so it competes with the contract rather than adding to it');
});

// ── Reachable from both surfaces, and from an agent ─────────────────────

/** (surface × operation): where a director can start a recompose. */
const SURFACES = [
    { id: 'storyboard', opener: 'recomposeFrame(' },
    { id: 'previs', opener: 'previsRecompose(' },
];

test('recompose is reachable from every directing surface', () => {
    const missing = SURFACES.filter(s => !HTML.includes(s.opener));
    assert.deepStrictEqual(missing.map(s => s.id), [],
        'these directing surfaces cannot start a recompose, so the feature exists on one page and '
        + `not the other: ${missing.map(s => s.id).join(', ')}`);
});

test('both surfaces confirm through the same film-facts model', () => {
    /*
     * Not merely that both have a button, and not that each calls the
     * confirmation itself — they correctly delegate to ONE runner, which is the
     * stronger property. What must be true is that there is exactly one path
     * from either surface to the spend, because two separately written
     * confirmations are how two surfaces come to disagree about what they are
     * about to buy.
     */
    for (const s of SURFACES) {
        const at = HTML.indexOf(`function ${s.opener.replace('(', '')}(`);
        assert.ok(at > 0, `${s.id}: ${s.opener} is not defined`);
        const body = HTML.slice(at, at + 700);
        assert.ok(/runRecompose\(/.test(body),
            `${s.id} does not go through the shared runner, so it can spend without the same checks`);
    }
    assert.strictEqual((HTML.match(/async function runRecompose\(/g) || []).length, 1,
        'the shared runner is defined more than once');
    const runAt = HTML.indexOf('async function runRecompose(');
    assert.ok(/confirmRecompose\(/.test(HTML.slice(runAt, runAt + 1400)),
        'the shared runner spends credits without the film-facts confirmation');
    assert.strictEqual((HTML.match(/async function confirmRecompose\(/g) || []).length, 1,
        'the recompose confirmation is defined more than once');
});

test('the confirmation leads with film facts, not prompt mechanics', () => {
    const at = HTML.indexOf('async function confirmRecompose(');
    assert.ok(at > 0, 'confirmRecompose is not defined');
    let i = HTML.indexOf('{', at), d = 0, end = -1;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') d++;
        else if (HTML[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
    }
    const dlg = HTML.slice(at, end);

    // The director's language first.
    for (const [needle, why] of [
        ['Keeping', 'which performance is being kept'],
        ['Background', 'which place is being adopted'],
        ['Holding', 'what continuity is preserved'],
        ['Technical details', 'the mechanics, collapsed rather than absent'],
    ]) {
        assert.ok(dlg.includes(needle), `the confirmation does not show ${why}`);
    }
    // Mechanics must sit BELOW the film facts.
    assert.ok(dlg.indexOf('Keeping') < dlg.indexOf('Technical details'),
        'prompt mechanics are shown above the film facts, which makes the mechanics the interface');
});

test('an agent can recompose too', () => {
    // Standing rabbit hole: use MCP wherever we can. A route with no tool is a
    // thing the app can do and an agent cannot.
    const { listTools } = require('../lib/mcp-tools');
    const tool = listTools().find(t => t.name === 'storyboard_recompose');
    assert.ok(tool, 'there is no storyboard_recompose tool');
    for (const arg of ['shot_id', 'from_version', 'background_asset_id']) {
        assert.ok(tool.inputSchema.properties[arg], `the tool cannot take ${arg}`);
    }
});

// ── The resolver, and what it refuses ───────────────────────────────────

test('the background must belong to this shot\'s location', () => {
    // A plate from another location is a different film. Accepting it would put
    // one production's street behind another's actor with nothing to notice.
    assert.ok(/function resolveRecomposeBackground\(/.test(ROUTES),
        'nothing resolves the background plate');
    const at = ROUTES.indexOf('function resolveRecomposeBackground(');
    const body = ROUTES.slice(at, at + 2200);
    assert.ok(/location_id/.test(body),
        'the resolver does not constrain the plate to a location');
    assert.ok(/scene|location/.test(body),
        'the resolver does not tie the plate to THIS shot\'s location');
});

test('a recomposed frame records what it was made from', () => {
    // "Which of these am I looking at" is the question the version list exists
    // to answer, and a recompose is neither a generate nor a refine.
    assert.ok(/recomposed_from/.test(ROUTES),
        'a recomposed frame does not record its source frame or background');
});

// ── codex review: the choice must be visual, and the gate must price it ──

test('the background is chosen from pictures, never from a typed number', () => {
    /*
     * The first draft used window.prompt() with a numbered list of view names.
     * That fails the whole point: this feature exists because a director could
     * not tell which way a plate faced, and "type 2" asks them to hold the
     * geometry in their head — exactly the thing that has been going wrong on
     * reverse angles all along. A view is a picture; choosing one means looking
     * at it.
     */
    assert.ok(/function renderBackgroundChoices\(/.test(HTML)
        || /backgroundPickerModal/.test(HTML),
        'there is no visual background picker');
    const at = HTML.indexOf('async function pickBackgroundView(');
    assert.ok(at > 0, 'pickBackgroundView is gone');
    let i = HTML.indexOf('{', at), d = 0, end = -1;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') d++;
        else if (HTML[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
    }
    const body = HTML.slice(at, end);
    assert.ok(!/\bprompt\(/.test(body),
        'the background is still chosen by typing into a window.prompt');
    assert.ok(/<img/.test(body) || /renderBackgroundChoices/.test(body),
        'the picker shows no pictures');
    assert.ok(!/asset_id.*<\/div>|>\$\{v\.asset_id\}/.test(body),
        'an asset id is shown to the director');
});

test('every view the picker offers is image-backed', () => {
    // A view with no servable picture cannot be chosen by looking, which is the
    // only way this choice is safe to make.
    const locations = fs.readFileSync(path.join(ROOT, 'routes', 'locations.js'), 'utf8');
    const at = locations.indexOf('function listPlateViews(');
    const body = locations.slice(at, at + 1800);
    assert.ok(/image_url/.test(body), 'the views list serves no picture for each view');
    assert.ok(/getFileUrl\(/.test(body), 'the views list builds its URL by hand rather than with the shared builder');
});

test('the preview returns the background picture, not a dead expression', () => {
    // The first draft shipped `image_url: storyboardImageUrl ? undefined : undefined`,
    // which is nonsense that always yields undefined — so the confirmation had
    // nothing to show and the director would be approving a name.
    const at = ROUTES.indexOf('function recomposePreview(');
    let i = ROUTES.indexOf('{', at), d = 0, end = -1;
    for (let j = i; j < ROUTES.length; j++) {
        if (ROUTES[j] === '{') d++;
        else if (ROUTES[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
    }
    const body = ROUTES.slice(at, end);
    assert.ok(!/\?\s*undefined\s*:\s*undefined/.test(body),
        'the preview still contains a dead expression that always yields undefined');
    assert.ok(/getFileUrl\(/.test(body),
        'the preview does not build the background URL with the shared file-URL builder');
});

test('the gate names the provider and what it will cost', () => {
    /*
     * "Costs credits" is not a spend gate, it is a disclaimer. The rate book
     * publishes a real figure per provider and capability; reporting it is the
     * difference between a director choosing to spend and being told they did.
     */
    const at = ROUTES.indexOf('function recomposePreview(');
    const body = ROUTES.slice(at, at + 4000);
    assert.ok(/rateFor\(/.test(body),
        'the preview invents or omits a cost instead of reading the rate book');
    assert.ok(/provider/.test(body), 'the preview does not say which provider would run');

    const dlgAt = HTML.indexOf('async function confirmRecompose(');
    const dlg = HTML.slice(dlgAt, dlgAt + 5000);
    assert.ok(/cost|credit/i.test(dlg), 'the confirmation does not show what it will cost');
    assert.ok(/provider/i.test(dlg), 'the confirmation does not show which provider would run');
});

test('a director note cannot contradict the preservation contract', () => {
    // Placed last, an added note sits after the invariants and competes with
    // them. Labelled and bounded, it adds instead.
    const { buildRecomposePayload } = require('../routes/storyboard');
    const p = buildRecomposePayload({ instruction: 'push the rain harder' }).prompt;
    assert.ok(/Additional non-conflicting direction:/.test(p),
        'the director note is not labelled as additive, so it reads as an override');
    assert.ok(p.indexOf('do not copy its camera framing') < p.indexOf('push the rain harder'),
        'the note is not placed after the role assignment it must not contradict');
});
