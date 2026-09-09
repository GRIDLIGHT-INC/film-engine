/**
 * RETIRE THE SYSTEM CAMERA — GRD-3808 / FCC-012.
 *
 * "Replace `shootControl()` so a camera target gets the controlled camera. One
 * function, so no surface is left behind — and the targets are derived from the
 * rule in Constraints, not listed twice."
 *
 * WHAT SHOOT DOES TODAY, ON A PHONE RUNNING THE APP. `shootControl` renders
 * `<input type="file" capture="environment">` — the SYSTEM camera. It takes one
 * photograph with no exposure lock, no focus lock, no white balance held across
 * a turnaround, no level, no peaking, no zebras, no format, and no budget. Nine
 * tasks of this epic built a camera that does all of that, and the plates reach
 * it only because `uploadControl` writes its own `nativeCamera()` branch. Every
 * OTHER surface — the world capture, and every capability control — still opens
 * the OS picker, because the branch was written at ONE call site rather than in
 * the builder they all share.
 *
 * That is the failure this codebase has paid for under other names: a rule
 * written at a call site is a rule the next call site does not get. `Regen`
 * versus `Generate All`; the ambient bed that reached two of three surfaces;
 * `AUDIO_LANES` laid out four elements in one exporter and three in the other.
 * The fix is never "add the branch to the second site" — it is to put the
 * decision in the one function every site already calls.
 *
 * THE RULE IS DECLARED ONCE, IN THE REGISTRY. The epic's Constraints answer the
 * surface question with a rule rather than a list — "a target gets the camera if
 * what it holds is PHOTOGRAPHED IN THE WORLD" — and names the eight that qualify
 * so a marginal call can be OVERRULED rather than discovered later. A second
 * list in the page would be the third statement of one rule, and the one that
 * goes stale. So `MEDIA_IMPORTS` carries it, the page mirrors it, and this file
 * holds all three to each other: the registry, the epic, and the page.
 *
 * SET-BASED OVER TWO REGISTRIES AND EVERY BUILDER:
 *
 *   1. `MEDIA_IMPORTS` — 18 targets. Every one must SAY whether what it holds is
 *      photographed, and a target that says no must say what it holds instead.
 *      A rule that covers seventeen is indistinguishable from one that works.
 *   2. The builders that render a shoot — `uploadControl`, `mediaUploadControl`,
 *      `captureUploadControl`. Each is EXECUTED rather than grepped, twice: once
 *      in the app and once in a browser. Their markup is built from template
 *      strings, so a grep reports a working control as broken and a broken one
 *      as working — and a branch that exists in the source says nothing about
 *      which arm a given target takes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const EPIC = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'fcc-parity-epic.md'), 'utf8');
const SWIFT = fs.readFileSync(path.join(ROOT, 'ios', 'FilmEngine', 'PlateCamera.swift'), 'utf8');

const { MEDIA_IMPORTS, shootsWithCamera } = require('../lib/media-imports');
const { MEDIA_KINDS } = require('../lib/media-kinds');

/** Pull a function out of the page by BRACE DEPTH — never a character window. */
function fnSource(name) {
    const at = UI.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} is not in the page`);
    let d = 0;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') d++;
        else if (UI[i] === '}' && --d === 0) return UI.slice(at, i + 1);
    }
    throw new Error(`${name} does not close`);
}

/** A `const NAME = ...;` declaration from the page, by name. */
function constSource(name) {
    const re = new RegExp(`\\n\\s*const ${name}\\s*=`);
    const m = re.exec(UI);
    assert.ok(m, `the page declares no ${name}`);
    const at = m.index + m[0].length - `const ${name} =`.length;
    // To the first semicolon at depth zero — these are object/array literals.
    let d = 0;
    for (let i = at; i < UI.length; i++) {
        const c = UI[i];
        if ('{[('.includes(c)) d++;
        else if ('}])'.includes(c)) d--;
        else if (c === ';' && d === 0) return UI.slice(at, i + 1);
    }
    throw new Error(`${name} does not terminate`);
}

/**
 * Run the page's control builders in isolation, with a chosen environment.
 *
 * `inApp` decides whether `window.webkit.messageHandlers.plateCamera` exists,
 * which is the ONE thing that separates the controlled camera from the system
 * one. Both are exercised: the browser has no better camera to offer and must
 * keep the one it has, so removing the system fallback would be a regression on
 * every desktop and every phone browser.
 *
 * THE CONSTANTS ARE INJECTED TOO, and that is not tidiness. `nativeCamera()`
 * reads a `const` for the bridge name inside its own try/catch, so a harness
 * that extracts only functions gets a ReferenceError SWALLOWED and is told
 * there is no bridge — every app assertion then passes over the browser arm
 * while reporting on the app. The first version of this file did exactly that,
 * which is why `bridgeSeen` is returned and asserted before anything else.
 */
function builders(inApp) {
    const need = new Set([
        'esc', 'jsAttr', 'captureFor', 'shootControl', 'uploadControl',
        'mediaUploadControl', 'captureUploadControl', 'plateShootButton', 'plateViewsFor',
        'nativeCamera', 'shootsWithCamera',
    ]);
    const fns = () => [...need]
        .map((n) => (UI.includes(`function ${n}(`) ? fnSource(n) : ''))
        .filter(Boolean).join('\n');

    /*
     * Every SHOUTING constant those functions mention that the page declares at
     * top level. Derived rather than listed: a hand-written list is correct
     * until the page reaches for one more, and then the whole harness goes
     * quiet in the direction that passes.
     */
    const consts = () => {
        const body = fns();
        const out = [];
        for (const id of new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]))) {
            if (new RegExp(`\\n\\s*const ${id}\\s*=`).test(UI)) out.push(constSource(id));
        }
        return out.join('\n');
    };

    let src = `${consts()}\n${fns()}`;
    for (let i = 0; i < 40; i++) {
        try {
            // eslint-disable-next-line no-new-func
            new Function('window', `${src}\nreturn uploadControl('character-plate', '/x', {});`)({});
            break;
        } catch (err) {
            const m = /(\w+) is not defined/.exec(err.message);
            if (m && UI.includes(`function ${m[1]}(`) && !need.has(m[1])) {
                need.add(m[1]);
                src = `${consts()}\n${fns()}`;
                continue;
            }
            break;   // not a missing helper; let the real assertion report it
        }
    }

    const win = inApp
        ? { webkit: { messageHandlers: { plateCamera: { postMessage() {} } } } }
        : {};
    // eslint-disable-next-line no-new-func
    return new Function('window', `${src}
        return {
            bridgeSeen: typeof nativeCamera === 'function' ? !!nativeCamera() : null,
            uploadControl: typeof uploadControl === 'function' ? uploadControl : null,
            mediaUploadControl: typeof mediaUploadControl === 'function' ? mediaUploadControl : null,
            captureUploadControl: typeof captureUploadControl === 'function' ? captureUploadControl : null,
            shootsWithCamera: typeof shootsWithCamera === 'function' ? shootsWithCamera : null,
        };`)(win);
}

/**
 * Every `<input>` in a rendered control, as {tag, hasCapture}.
 *
 * The ATTRIBUTE, never the word. `\bcapture` also matches inside
 * `data-import-target="world-capture"`, which reported that control's plain
 * upload as armed and the whole control as having no library option — two
 * confident failures against markup that was correct. A check that cries wolf
 * is one nobody runs twice.
 */
function inputsOf(html) {
    return [...String(html).matchAll(/<input\b[^>]*>/g)].map((m) => ({
        tag: m[0],
        hasCapture: /\scapture(?:\s*=|[\s>/])/.test(m[0]),
    }));
}

/** Does this rendered control reach the CONTROLLED camera? */
const opensControlledCamera = (html) => /shootPlate\(/.test(String(html));

/*
 * Render every surface that can offer a shoot, keyed by the import target it
 * writes to. Derived from the builders rather than typed: `mediaUploadControl`
 * is keyed by CAPABILITY and writes `<capability>-media`, which is the same
 * mapping `media-imports` itself uses.
 */
function surfacesFor(b) {
    const out = {};
    for (const [target, spec] of Object.entries(MEDIA_IMPORTS)) {
        if (target === 'world-capture') {
            out[target] = () => b.captureUploadControl('loc-1', {});
        } else if (/-media$/.test(target)) {
            const cap = target.replace(/-media$/, '');
            const media = (MEDIA_KINDS[cap] || {}).media || (MEDIA_KINDS[cap] || {}).kind;
            if (media) out[target] = () => b.mediaUploadControl(cap, media, 'shot', 'shot-1', {});
        } else if (spec.kind === 'image') {
            out[target] = () => b.uploadControl(target, '/x', {});
        }
        // `three-d-model` has no picture control at all — a mesh is not shot.
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * SET 1 — the rule, declared once and agreed by three documents       *
 * ------------------------------------------------------------------ */

test('EVERY import target says whether what it holds is photographed in the world', () => {
    const ids = Object.keys(MEDIA_IMPORTS);
    assert.ok(ids.length >= 18, `only ${ids.length} import targets; the registry read is broken`);

    const wrong = [];
    for (const [id, spec] of Object.entries(MEDIA_IMPORTS)) {
        if (typeof spec.photographed !== 'boolean') {
            wrong.push(`${id}: does not say whether it is photographed, so the one function has `
                + 'nothing to derive from and the decision goes back to the call sites');
            continue;
        }
        if (!spec.photographed && (!spec.photographed_why || spec.photographed_why.length < 20)) {
            wrong.push(`${id}: is excluded from the camera and does not say what it holds instead. `
                + 'An exclusion that is stated is a decision; a silent one is a gap');
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('the registry agrees with the EPIC about which targets photograph the world', () => {
    /*
     * The epic names the qualifying set so a marginal call can be overruled
     * rather than discovered later — `storyboard-image` and `mood-board-image`
     * are called out there by name. Holding the two together is what makes
     * overruling one a deliberate edit in both places rather than a drift.
     */
    const yes = /(\d+) of \d+ targets qualify \(([^)]*)\)/.exec(EPIC);
    const no = /(\d+) do not \(([^)]*)\)/.exec(EPIC);
    assert.ok(yes, 'the epic no longer names the qualifying set, so there is nothing to agree with');
    assert.ok(no, 'the epic no longer names the excluded set');

    const ticked = (s) => [...s.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    const plates = Object.keys(MEDIA_IMPORTS).filter((k) => /-plate$/.test(k));
    // "the three plates" is prose for exactly these, and the count is checked.
    const claimed = new Set(ticked(yes[2]));
    if (/the three\s+plates/.test(yes[2])) {
        assert.strictEqual(plates.length, 3, `the registry holds ${plates.length} plate targets, `
            + 'and the epic says three — one of them has been added or removed');
        for (const p of plates) claimed.add(p);
    }
    assert.strictEqual(claimed.size, Number(yes[1]),
        `the epic says ${yes[1]} targets qualify and names ${claimed.size}`);

    const declared = new Set(Object.entries(MEDIA_IMPORTS)
        .filter(([, s]) => s.photographed).map(([k]) => k));
    assert.deepStrictEqual([...declared].sort(), [...claimed].sort(),
        'the registry and the epic disagree about which targets photograph the world. Whichever '
        + 'is right, both have to say it — the epic names these so a call can be overruled');

    for (const id of ticked(no[2])) {
        assert.ok(MEDIA_IMPORTS[id], `the epic excludes ${id}, which is not a target`);
        assert.strictEqual(MEDIA_IMPORTS[id].photographed, false,
            `the epic excludes ${id} and the registry gives it the camera`);
    }
});

test('the page carries the SAME rule, over every target the registry declares', () => {
    /*
     * The page cannot require a node module (build.target: single-html), so the
     * rule exists twice — the arrangement `body-limit.js`, `screenplay-blocks.js`
     * and `shot-motion.js` already have, and for the same reason: two rules that
     * disagree is how a fix survives in the tests and not on the screen.
     *
     * ASKED, never read. Comparing a literal in the page against a literal in
     * the registry proves the two lists match and says nothing about what the
     * page's own predicate answers — and the predicate is what decides which
     * camera opens.
     */
    const b = builders(true);
    assert.strictEqual(typeof b.shootsWithCamera, 'function', 'the page has no such rule');
    const wrong = [];
    for (const target of Object.keys(MEDIA_IMPORTS)) {
        const page = b.shootsWithCamera(target);
        const server = shootsWithCamera(target);
        if (page !== server) {
            wrong.push(`${target}: the page says ${page} and the registry says ${server}, so a `
                + 'control opens a different camera than the server thinks it does');
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 2 — every surface, in the app                                   *
 * ------------------------------------------------------------------ */

test('the surfaces are real, or every assertion below passes over nothing', () => {
    const b = builders(true);
    /*
     * THE PRECONDITION EVERY APP ASSERTION RESTS ON. `nativeCamera()` swallows
     * its own errors, so a harness that cannot see the bridge is told there
     * isn't one — and then reports the browser arm as though it were the app's.
     */
    assert.strictEqual(b.bridgeSeen, true,
        'the harness cannot see the native bridge it just installed, so every "in the app" '
        + 'assertion below would be measuring the browser arm and passing');
    assert.strictEqual(builders(false).bridgeSeen, false,
        'the harness sees a bridge with none installed, so the browser assertions are measuring '
        + 'the app arm');
    assert.ok(b.uploadControl, 'uploadControl did not survive extraction');
    assert.ok(b.mediaUploadControl, 'mediaUploadControl did not survive extraction');
    assert.ok(b.captureUploadControl, 'captureUploadControl did not survive extraction');
    const s = surfacesFor(b);
    assert.ok(Object.keys(s).length >= 12,
        `only ${Object.keys(s).length} surfaces rendered; the mapping is broken`);
});

test('EVERY photographed target opens the CONTROLLED camera in the app', () => {
    /*
     * The headline. Nine tasks built a camera with exposure and focus locks,
     * white balance held across a turnaround, a level, peaking, zebras, a format
     * picker and a duration budget — and every surface but the plates opened the
     * OS picker instead, which has none of it.
     */
    const b = builders(true);
    const surfaces = surfacesFor(b);
    const wrong = [];
    for (const [target, spec] of Object.entries(MEDIA_IMPORTS)) {
        if (!shootsWithCamera(target) || !surfaces[target]) continue;
        const html = surfaces[target]();
        if (!opensControlledCamera(html)) {
            wrong.push(`${target}: still opens the system camera — one photograph, no locks, no `
                + 'budget, and nothing on screen saying what is being shot');
        }
        if (inputsOf(html).some((i) => i.hasCapture)) {
            wrong.push(`${target}: still renders a \`capture\` input in the app, so the OS picker `
                + 'is one tap away from the controlled camera and they disagree');
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('a target that does NOT photograph the world is not given the camera', () => {
    /*
     * The derivation has to be able to say no, or "derived" means "always yes".
     * A previs image and a post-production master are GENERATED, and an
     * orientation plan and a poster are AUTHORED — opening a camera on any of
     * them offers to photograph a thing that has no physical existence.
     */
    const b = builders(true);
    const surfaces = surfacesFor(b);
    const wrong = [];
    for (const [target, spec] of Object.entries(MEDIA_IMPORTS)) {
        if (shootsWithCamera(target) || spec.camera_pending || !surfaces[target]) continue;
        if (opensControlledCamera(surfaces[target]())) {
            wrong.push(`${target}: opens the controlled camera and holds ${spec.photographed_why}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('the plain upload survives on EVERY surface, in both environments', () => {
    /*
     * The regression this whole affordance was built to avoid, restated one
     * level up: picking a render made outside Film Engine is the PRIMARY use of
     * these controls, and a change that routes Shoot better must not cost it.
     */
    const wrong = [];
    for (const inApp of [true, false]) {
        const b = builders(inApp);
        const surfaces = surfacesFor(b);
        for (const [target, render] of Object.entries(surfaces)) {
            const plain = inputsOf(render()).filter((i) => !i.hasCapture);
            if (!plain.length) {
                wrong.push(`${target} (${inApp ? 'app' : 'browser'}): the plain upload is GONE — `
                    + 'the library is unreachable');
            }
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 3 — the browser keeps what it has                               *
 * ------------------------------------------------------------------ */

test('in a BROWSER a photographed target still gets the system camera', () => {
    /*
     * There is no controlled camera to route to on a desktop or in mobile
     * Safari, and `capture` is the only camera a browser offers. Removing it
     * because the app has something better would take the affordance away from
     * every surface that is not the app — retiring the system camera means
     * replacing it where there IS a replacement, not deleting it everywhere.
     */
    const b = builders(false);
    const surfaces = surfacesFor(b);
    const wrong = [];
    for (const [target, spec] of Object.entries(MEDIA_IMPORTS)) {
        if (!shootsWithCamera(target) || !surfaces[target]) continue;
        const html = surfaces[target]();
        if (opensControlledCamera(html)) {
            wrong.push(`${target}: reaches for the native bridge in a browser, where there is none`);
        }
        if (!inputsOf(html).some((i) => i.hasCapture)) {
            wrong.push(`${target}: a browser is offered no camera at all`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 4 — one function, and it is the one they all call               *
 * ------------------------------------------------------------------ */

test('exactly ONE function decides which camera a target gets', () => {
    /*
     * The defect itself, refused structurally. The bridge branch lived inside
     * `uploadControl`, so the plates got the controlled camera and every other
     * surface silently did not. A second copy anywhere is the same bug waiting
     * for the next surface.
     */
    const owners = [];
    for (const m of UI.matchAll(/function (\w+)\(/g)) {
        const name = m[1];
        const body = fnSource(name);
        /*
         * The DECISION is the PAIR: asking whether a bridge exists AND handing
         * the surface to it. `shootPlate` mentions the bridge to guard against
         * being called without one, which is a guard rather than a choice — a
         * detector that counted mentions would report it and cry wolf.
         */
        if (/nativeCamera\(\)/.test(body) && /plateShootButton\(/.test(body)) owners.push(name);
    }
    assert.deepStrictEqual(owners, ['shootControl'],
        `the choice between the controlled camera and the system one is made in [${owners}]. It `
        + 'must be made in exactly one function, or a surface added later gets whichever branch '
        + 'its author happened to copy');
});

test('no builder renders a shoot without going through that function', () => {
    const wrong = [];
    for (const name of ['uploadControl', 'mediaUploadControl', 'captureUploadControl']) {
        const body = fnSource(name);
        if (!/shootControl\(/.test(body)) {
            wrong.push(`${name}: does not call shootControl, so it decides the camera itself`);
        }
        if (/plateShootButton\(/.test(body)) {
            wrong.push(`${name}: reaches the native button directly, bypassing the one function`);
        }
        if (/capture="/.test(body)) {
            wrong.push(`${name}: writes a \`capture\` attribute itself — the same per-call-site `
                + 'rule that left every surface but the plates on the system camera');
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('shootControl is asked about a TARGET, not only about an accept string', () => {
    /*
     * An accept type cannot answer this. `image/png` is what a previs image and
     * a location plate both accept, and one is generated while the other is
     * photographed — so a builder keyed on accept alone must guess, and guessing
     * is what put the OS camera on surfaces that had a better one.
     */
    const b = builders(true);
    assert.strictEqual(typeof b.shootsWithCamera, 'function',
        'nothing derives, from a target, whether the controlled camera applies');
    assert.strictEqual(b.shootsWithCamera('location-plate'), true);
    assert.strictEqual(b.shootsWithCamera('previs-image'), false,
        'a previs image is generated, and it accepts exactly what a plate accepts — deriving from '
        + 'the accept type cannot tell them apart');
    assert.strictEqual(b.shootsWithCamera('nonsense-target'), false,
        'an unknown target is given the camera, so a typo silently opens one');
});

/* ------------------------------------------------------------------ *
 * SET 5 — the camera is told what it is being opened for              *
 * ------------------------------------------------------------------ */

/*
 * THE PENDING TEST THAT USED TO SIT HERE IS GONE, AND THAT IS THE POINT.
 *
 * FCC-012 left `video-media` on the system camera because the controlled one
 * recorded a take and nothing delivered it, and pinned that gap with a test
 * whose own failure message said: "If FCC-014 has landed, that target belongs
 * in the camera set and this test should be deleted rather than left passing."
 *
 * FCC-014 (GRD-3810) landed. The marker is gone from the registry, footage is
 * in the camera set above — where `EVERY photographed target opens the
 * CONTROLLED camera in the app` now covers it — and its delivery is pinned by
 * `fcc-footage-to-shot.test.js`. A check that REQUIRES a gap to exist is one
 * that blocks the gap being closed, which is why it was written to be removed
 * rather than relaxed.
 */

test('the iOS bundle is re-synced, or the phone runs a page without the change', () => {
    const bundled = fs.readFileSync(path.join(ROOT, 'ios/FilmEngine/Web/index.html'), 'utf8');
    assert.strictEqual(bundled, UI,
        'ios/FilmEngine/Web/index.html has drifted from src/index.html — '
        + '`cp src/index.html ios/FilmEngine/Web/index.html`');
});
