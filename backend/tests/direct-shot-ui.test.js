/**
 * Directing a shot is a creative act, not a control panel.
 *
 * The first version of this surface exposed every parameter the route accepts —
 * seed, ledger mode, negative prompt, style override, prompt override, and a
 * character-budget chart. All of that is the MACHINERY. A director opening a
 * frame that came back wrong does not want to tune a sampler; they want to say
 * who is in the shot, where the camera is, and what else should be true.
 *
 * The surface is now exactly what the work is:
 *
 *   description   what the SCREENPLAY says. Nothing else. Not composed, not
 *                 embellished — the writing is the source, and a board that
 *                 shows something else is showing you a paraphrase of your film.
 *   anchor        keep the previous shot as reference (unchanged)
 *   direct        WHO and WHAT is in it (blocking), then WHERE THE CAMERA IS
 *                 (cinematography), with anything unset falling through to the
 *                 mood board and the film's look
 *   refine        keep this frame, change one thing
 *   regen         make it again
 *   version       which attempt am I looking at
 *
 * Set-based over three registries — the reference kinds, the camera facets the
 * schema validates, and the mood-board specs — because a hand-listed subset is
 * how the last version came to offer four cinematography fields out of eight.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Run a panel builder out of the page, so ids built from `${p}x` are real. */
function runFn(name, ...args) {
    const start = HTML.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is not defined`);
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') depth++;
        else if (HTML[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    const src = HTML.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(`${src}; return ${name}(${args.map(a => JSON.stringify(a)).join(',')});`)();
}

// ── The three registries this surface must cover ────────────────────────

/** What a director PICKS for a shot: who is in it, where it is, what is in it. */
const BLOCKING_KINDS = (() => {
    const { KIND_RANK } = require('../lib/reference-images');
    // `anchor` has its own button by design and `style` is the film's look,
    // not a per-shot choice. Everything else is a thing you select for a shot.
    return Object.keys(KIND_RANK).filter(k => k !== 'anchor' && k !== 'style');
})();

/** Every camera facet the validator accepts — the cinematography set. */
const CAMERA_FACETS = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scene-card-schema.js'), 'utf8');
    return [...new Set([...src.matchAll(/card\.camera\.([a-z_]+)/g)].map(m => m[1]))];
})();

/** Specs a shot's cinematography can fall through to. */
const PREVIS_SPECS = (() => {
    const { SPEC_KINDS } = require('../lib/look-development');
    return Object.entries(SPEC_KINDS).filter(([, v]) => (v.target || v) === 'previs').map(([k]) => k);
})();

test('the set this surface must cover is derived, not guessed', () => {
    assert.ok(BLOCKING_KINDS.length >= 3, `blocking kinds: ${BLOCKING_KINDS.join(',')}`);
    assert.ok(CAMERA_FACETS.length >= 8, `camera facets: ${CAMERA_FACETS.join(',')}`);
    assert.ok(PREVIS_SPECS.length >= 3, `previs specs: ${PREVIS_SPECS.join(',')}`);
});

// ── 1. The description is the screenplay ────────────────────────────────

test('the shot description is the screenplay text, and direction is separate', () => {
    // A board showing a composed description is showing a paraphrase of the
    // film. The writing is the source; what a director adds is ADDITIVE and
    // lives in its own field, so the two can never be confused and the
    // screenplay half can always be re-derived.
    const schema = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scene-card-schema.js'), 'utf8');
    assert.ok(/card\.direction/.test(schema),
        'the scene card has no `direction` field, so a director has nowhere to add to the screenplay '
        + 'except by overwriting it');

    const shots = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shots.js'), 'utf8');
    assert.ok(/'direction'/.test(shots), 'direction cannot be saved through PUT /shots/:id');

    const prompt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storyboard-prompt.js'), 'utf8');
    assert.ok(/sceneCard\.direction/.test(prompt),
        'direction is stored and never reaches the prompt');
});

// ── 3. Blocking: pick who and what is in the shot ───────────────────────

/** The choices are rendered from project data, so the test supplies some. */
function renderChoices() {
    const start = HTML.indexOf('function renderBlockingChoices(');
    assert.ok(start > 0, 'renderBlockingChoices is not defined');
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') depth++;
        else if (HTML[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    const src = HTML.slice(start, end);
    let out = '';
    const doc = {
        getElementById: () => ({ set innerHTML(v) { out = v; }, get innerHTML() { return out; } }),
    };
    // eslint-disable-next-line no-new-func
    new Function('document', 'escapeHtml', `${src}; renderBlockingChoices('shotCard', {
        card: { characters: ['MAYA'], props: [] },
        characters: [{ name: 'MAYA', has_plate: true }, { name: 'DRAGON', has_plate: false }],
        props: [{ name: 'SEDAN', has_plate: true }],
        location: { name: 'SUBURBAN STREET', has_plate: true },
    });`)(doc, x => String(x));
    return out;
}

test('every blocking kind can be picked for a shot', () => {
    const rendered = renderChoices();
    for (const kind of BLOCKING_KINDS) {
        assert.ok(new RegExp(`id="shotCard${kind[0].toUpperCase()}${kind.slice(1)}`, 'i').test(rendered)
            || new RegExp(`data-blocking-kind="${kind}"`).test(rendered),
            `no way to choose which ${kind}(s) are in this shot`);
    }
});

test('blocking is a PICKER over what the project has, not free text', () => {
    // Typing "MAYA" and typing "Maya" produce a subject the plates know nothing
    // about. The project already knows its own cast; a director should choose
    // from it, and see what has no plate yet.
    const rendered = renderChoices();
    assert.ok(/no plate/.test(rendered),
        'the picker never says which subjects have no plate, which is the fact that decides '
        + 'whether a subject will be invented fresh in every frame');
    assert.ok(/type="checkbox"/.test(rendered),
        'blocking is still free text — a typo silently invents a subject with no plate');
});

test('the direction box adds to the screenplay rather than replacing it', () => {
    const rendered = runFn('blockingPanel', 'shotCard');
    assert.ok(/id="shotCardDirection"/.test(rendered), 'there is no direction box');
    assert.ok(/screenplay/i.test(rendered),
        'the panel never says the direction is on TOP of the screenplay, so it reads as a replacement');
});

test('the screenplay half is editable, and stays a separate half', () => {
    // Editable, because sometimes the script's account of a shot needs fixing
    // and going back to the screenplay to change one line is a long way round.
    // Still its own field: the two are kept apart so a revision can replace the
    // writing without discarding the direction.
    const rendered = runFn('blockingPanel', 'shotCard');
    assert.match(rendered, /<textarea[^>]*id="shotCardWritten"/,
        'the screenplay half cannot be edited');
    assert.ok(/id="shotCardDirection"/.test(rendered),
        'direction lost its own field, so the two halves have merged');

    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const read = html.slice(html.indexOf('function readBlockingPanel('),
        html.indexOf('function readBlockingPanel(') + 900);
    assert.ok(/description:/.test(read), 'the edited screenplay is never read back');

    // A blank one is omitted, not sent: the route merges, and sending '' would
    // erase the shot's own account of itself.
    const save = html.slice(html.indexOf('const blocking = readBlockingPanel('),
        html.indexOf('const blocking = readBlockingPanel(') + 700);
    assert.match(save, /if \(blocking\.description\)/,
        'a blank description is sent, which would erase what the screenplay said');
});

// ── 4. Cinematography, with the mood board underneath ───────────────────

test('every camera facet the schema validates has a control', () => {
    const rendered = runFn('directingPanel', 'shotCard');
    const missing = CAMERA_FACETS.filter(f => {
        const id = 'shotCard' + f.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('');
        return !rendered.includes(`id="${id}"`);
    });
    assert.deepStrictEqual(missing, [],
        `the schema validates these camera facets and the page cannot set them: ${missing.join(', ')}`);
});

test('an unset facet says what it will fall through to', () => {
    // "whatever options we don't add should take from either moodboard or
    // overall project look". A blank field that silently inherits is
    // indistinguishable from one that reaches nothing.
    const rendered = runFn('directingPanel', 'shotCard');
    assert.ok(/mood board|moodboard/i.test(rendered),
        'nothing on the cinematography panel says an unset value falls through to the mood board');
    assert.ok(/function directingFallbacks\(/.test(HTML),
        'no code resolves what an unset facet would inherit, so the hint cannot be real');
});

// ── 5. The frame card keeps the five controls that matter ───────────────

/*
 * The five controls a frame card carries, named as the code names them rather
 * than as prose describes them: an earlier draft of this test asked for
 * `anchorToggle`, which does not exist — the anchor is setAnchor/clearAnchor.
 * A test written in a vocabulary the code does not speak reports a working
 * surface as broken.
 */
const CARD_CONTROLS = ['setAnchor', 'directShot', 'refineFrame', 'regenerateStoryboard', 'openFrameVersions'];

test('the frame card offers exactly the controls the work needs', () => {
    for (const fn of CARD_CONTROLS) {
        assert.ok(HTML.includes(`${fn}(`), `the frame card lost its ${fn} control`);
    }
});

// ── The complexity is GONE, not merely collapsed ────────────────────────

const MACHINERY = ['directSeed', 'directLedgerMode', 'directNegative', 'directStyleOverride',
    'directPromptOverride', 'directRenderPreview'];

test('the machinery is not on the directing surface', () => {
    // Seed, sampler mode, negative prompts and a character-budget chart are
    // what the engine does, not what a director decides. Left on the creative
    // surface they crowd out the two questions that matter.
    const present = MACHINERY.filter(id => HTML.includes(id));
    assert.deepStrictEqual(present, [],
        `these belong to the machinery and are still on the directing surface: ${present.join(', ')}`);
});

// ── 6. Previs shows the current frame, and feeds directing ──────────────

test('previs shows the CURRENT frame, not a cached older one', () => {
    // The frame is overwritten at a fixed filename, so the URL never changes
    // and the browser serves whatever it cached. The board busts this with
    // ?v=asset_version; previs used the raw src and showed a stale picture.
    const previs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'previs.js'), 'utf8');
    assert.ok(/asset_version/.test(previs),
        'GET /shots/:id/previs does not return the frame version, so the client cannot bust the cache');
    const fn = HTML.slice(HTML.indexOf('function previsKeyframe('),
        HTML.indexOf('function previsKeyframe(') + 700);
    assert.ok(/\?v=|asset_version/.test(fn),
        'previs paints keyframe.src with no version key, so it shows the browser-cached older frame');
});

test('directing in previs writes back into the directing elements', () => {
    // "we should be able to manually direct the scene in previz and it adds
    // those details into our directing elements" — the stage is a way of
    // deciding the same facts, so what is decided there has to land where the
    // rest of the app reads them.
    const previs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'previs.js'), 'utf8');
    const at = previs.indexOf('function applyBlockingToCard(');
    assert.ok(at > 0, 'applyBlockingToCard is gone');
    const nextFn = previs.indexOf('\nfunction ', at + 10);
    const apply = previs.slice(at, nextFn === -1 ? previs.length : nextFn);
    for (const facet of ['shot_type', 'lens', 'movement', 'sensor', 'aperture', 'height_m']) {
        assert.ok(apply.includes(facet), `previs/apply does not write ${facet} back to the card`);
    }
    assert.ok(/card\.characters|card\.props/.test(apply),
        'staging a named subject in previs never reaches the shot\'s blocking, so the two disagree');
});

test('the plate badge agrees with what actually attaches', () => {
    /*
     * The picker invented three field names — plate_asset_id, has_plate,
     * refsheet_asset_id — and only the middle one exists, and only because it
     * was added afterwards. Every subject in every project reported "no plate",
     * which is the opposite of the truth and the direction that costs money: it
     * tells a director to go and generate plates that already exist.
     *
     * Derived over the three subject kinds, and against the GATHERER's own
     * query, because a badge that disagrees with what attaches is worse than no
     * badge.
     */
    const routes = {
        characters: fs.readFileSync(path.join(__dirname, '..', 'routes', 'characters.js'), 'utf8'),
        props: fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8'),
        locations: fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8'),
    };
    for (const [kind, src] of Object.entries(routes)) {
        assert.ok(/platedSubjects/.test(src),
            `the ${kind} list does not report which subjects have a plate`);
    }

    // One source of truth: the helper must run the gatherer's own asset types.
    const refs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'shot-references.js'), 'utf8');
    assert.ok(/function platedSubjects\(/.test(refs), 'platedSubjects is not defined beside the gatherer');
    const helper = refs.slice(refs.indexOf('const PLATE_TYPES'), refs.indexOf('function platedSubjects(') + 900);
    for (const t of ['character_sheet', 'reference_image']) {
        assert.ok(helper.includes(t), `platedSubjects ignores ${t}, which the gatherer attaches`);
    }

    // And the client must read the served field, not a guessed one.
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('const platedBy = rows =>'),
        html.indexOf('const platedBy = rows =>') + 400);
    assert.ok(/r\.has_plate/.test(fn), 'the picker does not read has_plate');
    for (const invented of ['plate_asset_id', 'refsheet_asset_id']) {
        assert.ok(!fn.includes(invented),
            `the picker still reads ${invented}, which no route returns`);
    }
});


test('camera mode is reachable from the board, and says when it cannot run', () => {
    /*
     * It was built, tested, and then removed from the page during the
     * simplification — leaving the single best tool for "put the camera on the
     * other side of the street" reachable only from an agent host. A capability
     * with no control is indistinguishable from one that does not exist.
     *
     * It belongs here as a DIRECTING choice — action or camera — not as a dial
     * on a control panel, which is what it was the first time.
     */
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/name="shotCardMode"/.test(html), 'there is no way to choose what you are directing');
    assert.ok(/value="camera"/.test(html) && /value="action"/.test(html),
        'both directing modes must be offered');
    assert.ok(/direction_mode/.test(html), 'the page never sends the chosen mode');

    // Refused without an anchor, so it has to say so where it is CHOSEN rather
    // than as a 409 after the form is filled in.
    assert.ok(/shotCardModeHint/.test(html), 'nothing says whether camera mode can actually run');
    assert.ok(/cameraRadio\.disabled/.test(html),
        'camera mode stays selectable with no anchor, so the only feedback is a refusal');
});
