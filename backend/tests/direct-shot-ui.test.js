/**
 * Every dial the route accepts is reachable from the page.
 *
 * `regenerateShot` accepts eight parameters — direction_mode, mode,
 * negative_prompt, prompt_override, seed, style_override, use_anchor,
 * use_annotations — and the SPA posted an EMPTY BODY. Every one of them was
 * reachable only from an agent host or from curl, which is the literal content
 * of "it does a lot without my control in the background": the controls
 * existed, on the far side of the app.
 *
 * DERIVED from the route rather than listed here, because a hand-written list
 * is only ever as complete as whoever wrote it was that afternoon — and the
 * next parameter added to the route would silently be unreachable again, with
 * nothing failing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

/** The body params a named route function actually reads. */
function paramsOf(fnName) {
    const start = ROUTES.indexOf(`async function ${fnName}(`);
    assert.ok(start > 0, `${fnName} not found`);
    // To the next top-level function declaration.
    const next = ROUTES.indexOf('\nasync function ', start + 10);
    const body = ROUTES.slice(start, next === -1 ? ROUTES.length : next);
    const direct = [...body.matchAll(/body\.([a-z_]+)/g)].map(m => m[1]);
    // Params read through the shared helpers this function calls.
    const viaHelpers = [];
    if (/activeAnchorFor_\(/.test(body)) viaHelpers.push('use_anchor');
    if (/annotationsFor\(/.test(body)) viaHelpers.push('use_annotations');
    return [...new Set([...direct, ...viaHelpers])];
}

test('every regenerate parameter has a control on the page', () => {
    const params = paramsOf('regenerateShot');
    assert.ok(params.length >= 6, `only found ${params.length} params — the detector is broken`);

    // The generator must send each one. Read from directGenerate, which is the
    // single place the page builds that request.
    const gen = HTML.slice(HTML.indexOf('async function directGenerate('),
        HTML.indexOf('async function directGenerate(') + 2200);
    assert.ok(gen.length > 100, 'directGenerate is not defined');

    const unreachable = params.filter(p => !gen.includes(p));
    assert.deepStrictEqual(unreachable, [],
        'the regenerate route accepts these and the page can never send them, '
        + `so they are reachable only from an agent host or curl: ${unreachable.join(', ')}`);
});

test('every parameter the page sends has a control a person can operate', () => {
    // Sending a hardcoded value is not the same as offering control over it.
    const gen = HTML.slice(HTML.indexOf('async function directGenerate('),
        HTML.indexOf('async function directGenerate(') + 2200);
    const controls = {
        direction_mode: 'directModeChoices',
        prompt_override: 'directPromptOverride',
        negative_prompt: 'directNegative',
        seed: 'directSeed',
        style_override: 'directStyleOverride',
        mode: 'directLedgerMode',
        use_anchor: 'directUseAnchor',
        use_annotations: 'directUseAnnotations',
    };
    for (const [param, id] of Object.entries(controls)) {
        assert.ok(gen.includes(param), `directGenerate never sends ${param}`);
        assert.ok(HTML.includes(`id="${id}"`), `${param} is sent but has no control: #${id}`);
    }
});

test('the free preview leads, and is genuinely free', () => {
    // The whole point is seeing what a generation would send BEFORE paying, and
    // the mode that costs money to try is the one worth looking at first.
    assert.ok(/function directRefresh\(/.test(HTML), 'there is no preview');
    assert.ok(/\/prompt\$\{q\}|\/prompt`/.test(HTML) || /prompt\$\{q\}/.test(HTML),
        'the preview does not call the free prompt route');
    const refresh = HTML.slice(HTML.indexOf('async function directRefresh('),
        HTML.indexOf('async function directRefresh(') + 1200);
    assert.ok(/direction_mode=/.test(refresh),
        'the preview cannot show the mode being chosen, which is the one worth previewing');
    assert.ok(!/regenerate/.test(refresh), 'the preview calls a route that spends money');
});

test('the modal is reachable from the surfaces a frame is judged on', () => {
    // A control nobody can find is the same as no control. Both surfaces,
    // because a 260px card is not where you decide a shot is wrong.
    const opens = (HTML.match(/directShot\('/g) || []).length;
    assert.ok(opens >= 2,
        `Direct opens from ${opens} place(s) — the grid and the full-screen viewer both need it`);
});

test('a mode that cannot run says so before the click, not after', () => {
    // Camera mode is refused with a 409 when no anchor is attached. Meeting
    // that after paying attention to a form is worse than being told while
    // choosing.
    assert.ok(/direction_mode_blocked/.test(HTML),
        'the page never reads the blocked reason, so an unrunnable mode looks available');
});
