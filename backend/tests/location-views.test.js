/**
 * A location has views, and a shot picks one.
 *
 * A location had exactly ONE plate, selected with `ORDER BY version DESC LIMIT
 * 1`, with no record of which way it faced. On Wingfall that plate looks from
 * the entrance INTO the cul-de-sac — so 1A and 2A had a photograph, and 2B and
 * 2AA, which shoot back the other way, were handed a picture of what was BEHIND
 * the camera and invented the rest. Every wrong road, missing kerb and
 * misplaced car traces to that.
 *
 * Which view a shot needs is a property of the SHOT, not the location: the
 * location owns a growing set of views, and the card says which one it is
 * looking at.
 *
 * Set-based over the nine things a view must survive, because each is
 * independently silent. A view that generates but overwrites the last one loses
 * the set; one that stores but is not selectable is invisible; one that is
 * selected but not sent leaves the prompt naming a view the model never saw.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-views-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

// ── 1. Two views of one location can coexist ────────────────────────────

test('a second view does not overwrite the first', () => {
    /*
     * Plates are named `location_<name>.png`, one file per subject — so
     * generating a second view wrote over the first and the set could never
     * grow beyond one. The view has to be part of the identity.
     */
    const { plateFileName } = require('../lib/reference-plates');
    assert.ok(typeof plateFileName === 'function',
        'nothing derives a plate filename, so views cannot be told apart on disk');
    const a = plateFileName('location', 'SUBURBAN STREET', 'from the entrance looking in');
    const b = plateFileName('location', 'SUBURBAN STREET', 'from the far kerb looking back');
    assert.notStrictEqual(a, b, 'two views of one location resolve to the same file');
    assert.ok(/\.png$/.test(a) && !/[\\/]/.test(a), `unsafe filename: ${a}`);

    // The original, view-less plate keeps its name, or every existing project
    // loses the plate it already has.
    assert.strictEqual(plateFileName('location', 'SUBURBAN STREET', null),
        plateFileName('location', 'SUBURBAN STREET', undefined),
        'the default view is not stable');
});

// ── 2. The card carries which view this shot sees ───────────────────────

test('the scene card validates a location_view', () => {
    const { validateSceneCard } = require('../lib/scene-card-schema');
    assert.ok(validateSceneCard({ shot_code: '2B', description: 'x', location_view: 'from the far kerb' }).valid,
        'a card cannot say which view of its location the shot sees');
    assert.ok(!validateSceneCard({ shot_code: '2B', description: 'x', location_view: 42 }).valid,
        'a non-string view is accepted');
});

test('location_view can be saved through the shot route', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'shots.js'), 'utf8');
    assert.ok(/'location_view'/.test(src), 'PUT /shots/:id cannot set the view');
});

// ── 3. The gatherer sends the view the shot asked for ───────────────────

test('the gatherer selects a plate by view, not by "latest"', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'shot-references.js'), 'utf8');
    const at = src.indexOf('matchedLocation && matchedLocation.id');
    assert.ok(at > 0, 'the location branch is gone');
    const branch = src.slice(at, at + 900);
    assert.ok(/locationView|location_view/.test(branch),
        'the gatherer still takes whichever location plate is newest, so a shot cannot choose '
        + 'the view it is actually looking at');
});

test('selection is by view, with the default as a fallback', () => {
    /*
     * Behavioural, not a grep. The first version of this test looked for the
     * word "fallback" in the source and failed while the fallback was right
     * there as `|| all.find(...)` — a test reading source text is testing how
     * the code is phrased.
     */
    const { gatherShotReferences } = require('../lib/shot-references');
    const projectId = generateId(), locId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Views');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(locId, projectId, 'SUBURBAN STREET');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-'));
    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
    /*
     * Distinct BYTES per view. gatherShotReferences inlines each plate as a
     * data URI and drops file_path, so two identical fixture files come back
     * as the same string and the test cannot tell which was chosen — it would
     * pass whichever plate the code picked.
     */
    const add = (name, view) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, Buffer.concat([PNG, Buffer.from(name)]));
        db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, version, metadata)
                    VALUES (?, ?, ?, 'reference_image', ?, ?, 1, ?)`)
            .run(generateId(), projectId, locId, name, f,
                JSON.stringify(view ? { kind: 'location_plate', view } : { kind: 'location_plate' }));
        return f;
    };
    const dflt = add('location_S.png', null);
    const back = add('location_S__back.png', 'from the far kerb looking back');

    const loc = { id: locId, name: 'SUBURBAN STREET' };
    const uriOf = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    const pick = view => {
        const refs = gatherShotReferences(projectId, [], loc, [], null, { limit: 5, locationView: view });
        const r = refs.find(x => x.kind === 'location');
        return r && r.uri;
    };

    assert.strictEqual(pick('from the far kerb looking back'), uriOf(back),
        'the named view was not the one selected');
    assert.strictEqual(pick(''), uriOf(dflt), 'no view asked for did not fall back to the default plate');
    assert.strictEqual(pick('a view nobody ever made'), uriOf(dflt),
        'a card naming a view that does not exist got NO location plate — a silent gap is worse '
        + 'than the wrong reference');
});

// ── 4. Generating one, and listing them for the picker ──────────────────

test('views can be listed for a location', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'locations.js'), 'utf8');
    assert.ok(/plate\/views|\/views/.test(src),
        'nothing lists a location\'s views, so a dropdown has nothing to offer');
});

test('a new view is generated anchored on an existing one', () => {
    /*
     * Generated independently, four views produce four different cul-de-sacs.
     * Each new view has to be anchored on one that already exists, with the
     * move stated, or the set does not agree with itself — which is the whole
     * reason for having a set.
     */
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'reference-plates.js'), 'utf8');
    assert.ok(/same location as the reference image|Same houses|anchored/i.test(src),
        'a new view is generated from scratch, so the set will not agree with itself');
});

// ── 5. It is choosable and visible ──────────────────────────────────────

test('the Blocking panel offers the views as a dropdown', () => {
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    assert.ok(/LocationView/.test(html), 'there is no view selector');
    assert.ok(/<select[^>]*id="\$\{p\}LocationView"/.test(html),
        'the view is typed as prose rather than chosen from what exists');
    assert.ok(/generate a new view|new view/i.test(html),
        'a view can only be chosen, never created, so the set can never grow from the board');
});

test('the confirmation names the view that is travelling', () => {
    // "SUBURBAN STREET" is not enough once a location has four views: the whole
    // point is knowing WHICH half of the street the model was shown.
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    const at = html.indexOf('async function confirmGeneration(');
    let i = html.indexOf('{', at), d = 0, end = -1;
    for (let j = i; j < html.length; j++) {
        if (html[j] === '{') d++;
        else if (html[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
    }
    assert.ok(/r\.view/.test(html.slice(at, end)),
        'the confirmation shows the location name but not which view of it is being sent — once a '
        + 'location has several plates its name alone cannot say which half of the street travelled');
});

test('a new view leads with the camera move, and refuses the old angle', () => {
    /*
     * The first attempt at a far-kerb view came back as the ORIGINAL plate,
     * regraded: same houses in the same places, same basketball hoop, same
     * storm drain. The positive trailed "photographed from the far kerb" behind
     * "the same location as the reference image", and the cheapest way to
     * satisfy "same location" is to copy it.
     *
     * The shot anchor learned this exact lesson: "the same scene as this
     * picture" reads as "reproduce this picture" unless the change is stated
     * FIRST and plainly. So the move leads, continuity follows, and the
     * negative refuses sameness of angle outright.
     */
    const { buildPlatePrompt } = require('../lib/reference-plates');
    const subject = { name: 'SUBURBAN STREET', description: 'a cul-de-sac' };
    const p = buildPlatePrompt('location', subject, 'teal', 'from the far kerb looking back', true);

    const move = p.toLowerCase().indexOf('different camera position');
    const same = p.toLowerCase().indexOf('same buildings');
    assert.ok(move >= 0, 'the camera move is not stated as a move at all');
    assert.ok(move < same,
        'what stays the same is stated before the move, which is what produced a copy of the plate');
    assert.ok(move < 120,
        `the move starts ${move} characters in — whatever leads a prompt is what the image is of`);

    // Without an anchor there is nothing to differ FROM, so no move is claimed.
    const solo = buildPlatePrompt('location', subject, 'teal', 'from the far kerb looking back', false);
    assert.ok(!/different camera position/i.test(solo),
        'a first view claims to be a move from a reference that does not exist');

    const src = fs.readFileSync(path.join(ROOT, 'lib', 'reference-plates.js'), 'utf8');
    assert.ok(/VIEW_NEGATIVE/.test(src), 'nothing refuses the reference viewpoint');
    /*
     * Gated on whether the anchor was actually SENT, not on whether one
     * existed. An edit-mode provider now has its references dropped for a view
     * (see "an edit cannot move the camera"), and refusing "the same camera
     * position" when no picture is attached spends the negative on a risk that
     * is not present.
     */
    assert.ok(/anchored \? `\$\{NEGATIVE\}, \$\{VIEW_NEGATIVE\}`/.test(src),
        'the view negative is defined and never sent');
});

test('an explicitly chosen view survives an attached anchor', () => {
    /*
     * The anchor normally replaces the location plate — it IS that place,
     * rendered. But the views feature exists precisely for the case where the
     * anchor shows one side of the street and the shot points at the other: the
     * anchor carries the light, the dressing and where people stand, and the
     * view carries the half the anchor cannot see.
     *
     * Without this, setting a view on an anchored shot did nothing at all and
     * the picker was decorative — which is the state 2B and 2AA were in the
     * moment the feature shipped.
     */
    const { gatherShotReferences } = require('../lib/shot-references');
    const projectId = generateId(), locId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Anchored views');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(locId, projectId, 'STREET');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
    const write = (name, view) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, Buffer.concat([PNG, Buffer.from(name)]));
        db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, version, metadata)
                    VALUES (?, ?, ?, 'reference_image', ?, ?, 1, ?)`)
            .run(generateId(), projectId, locId, name, f,
                JSON.stringify(view ? { view } : {}));
        return f;
    };
    write('default.png', null);
    write('far.png', 'from the far kerb');

    const anchorFile = path.join(dir, 'anchor.png');
    fs.writeFileSync(anchorFile, Buffer.concat([PNG, Buffer.from('anchor')]));
    const anchor = { shot: { id: generateId(), shot_code: '2A' }, asset: { file_path: anchorFile },
        cross_scene: false };

    const loc = { id: locId, name: 'STREET' };
    const kinds = view => gatherShotReferences(projectId, [], loc, [], anchor,
        { limit: 5, locationView: view }).map(r => r.kind);

    assert.ok(!kinds('').includes('location'),
        'with no view chosen the anchor should still stand in for the location plate');
    assert.ok(kinds('from the far kerb').includes('location'),
        'a view was chosen deliberately and the anchor silently overrode it, so the picker does nothing');
    assert.ok(kinds('from the far kerb').includes('anchor'),
        'sending the view dropped the anchor, which carries the light and where people stand');
});

// ── A view IS a framing; it replaces the default, it does not queue behind it ──

/**
 * Every plate kind lets a view replace its default framing, and keeps its
 * invariants.
 *
 * `PLATE_KINDS` buries two different things in one `framing` string:
 *
 *   location: 'establishing wide shot of the location, no people, no
 *              characters, eye level, natural perspective'
 *   prop:     'single object product shot, centred, plain seamless background,
 *              no people'
 *
 * The first half of each is a DEFAULT FRAMING — what to shoot when nobody said.
 * The second half is an INVARIANT — what makes the result a plate rather than a
 * shot. Fused into one string, the default framing is appended to every plate
 * including one that was asked for a specific view, so "standing in the middle
 * of the bulb looking at MAYA's house" was still told, in the same prompt, to
 * produce an establishing wide of the whole location. It did, twice: the
 * boilerplate outranked the thing being asked for.
 *
 * Set-based over the registry rather than fixed for `location`, because a
 * kind-specific conditional is a special case waiting to rot — and `prop` has
 * exactly the same fusion with exactly the same consequence.
 */
test('a view replaces the default framing for every plate kind, anchored or not', () => {
    const { PLATE_KINDS, buildPlatePrompt } = require('../lib/reference-plates');
    const kinds = Object.keys(PLATE_KINDS);
    assert.ok(kinds.length >= 2, `expected the plate registry, found ${kinds.length}`);

    const SENTINEL = 'zzsentinelviewzz standing where nobody stands';

    /*
     * BOTH anchor modes, because the anchored one is the path that actually
     * runs. Creating an additional view of a location always attaches the
     * existing plate — so a test that only exercised `anchored=false` proved
     * nothing about the real feature, and passed while the view was being
     * stated TWICE (once in the leading camera-change clause, once in the later
     * "photographed <view>"). codex caught that on review; verified before
     * fixing: location 2, prop 2.
     *
     * Saying it twice is not harmless. The lead clause exists because whatever
     * leads a prompt is what the image is OF, and a second statement further
     * down competes with it for exactly the instruction the lead was placed
     * first to win.
     *
     * BOUNDARY, by derivation rather than deferral: the character reference
     * sheet is not a PLATE_KINDS consumer and is deliberately excluded. Its
     * front/side/back is SUBJECT ORIENTATION inside a fixed full-body identity
     * frame, not an environmental camera view — a different axis, which is why
     * it has its own builder and why widening this registry would not reach it.
     */
    for (const kind of kinds) {
        const spec = PLATE_KINDS[kind];
        assert.ok(typeof spec.framing === 'string' && spec.framing,
            `${kind} declares no default framing`);
        assert.ok(Array.isArray(spec.constraints) && spec.constraints.length,
            `${kind} declares no invariant constraints, so a view would strip what makes it a `
            + 'plate — a location reference with a stranger standing in it, or a prop shot in a room');

        const subject = { name: `THE ${kind.toUpperCase()}`, description: 'a thing' };

        for (const anchored of [false, true]) {
            const withView = buildPlatePrompt(kind, subject, 'a look', SENTINEL, anchored);
            const count = (withView.match(new RegExp(SENTINEL, 'g')) || []).length;

            assert.strictEqual(count, 1,
                `${kind} (anchored=${anchored}): the view is stated ${count} times. It must be `
                + 'stated exactly once — a second statement competes with the leading clause for '
                + 'the very instruction the lead was placed first to win');

            assert.ok(!withView.includes(spec.framing),
                `${kind} (anchored=${anchored}): the default framing is still in the prompt `
                + 'alongside the view, so the boilerplate can outrank what was asked for');

            for (const c of spec.constraints) {
                assert.ok(withView.includes(c),
                    `${kind} (anchored=${anchored}): the invariant "${c}" was dropped`);
            }

            // Where the single statement lives differs by mode, and that is the
            // point: anchored, the view IS the camera change and belongs in the
            // lead; unanchored there is nothing to change from, so it is simply
            // what was photographed.
            const leadIdx = withView.indexOf(SENTINEL);
            if (anchored) {
                assert.ok(leadIdx < 160,
                    `${kind}: anchored, the view starts ${leadIdx} chars in — it must lead, `
                    + 'because whatever leads a prompt is what the image is of');
                assert.ok(!/photographed zzsentinel/.test(withView),
                    `${kind}: anchored, the view is repeated in the "photographed" clause`);
            } else {
                assert.ok(/photographed zzsentinel/.test(withView),
                    `${kind}: unanchored, the view is not stated as what was photographed`);
                assert.ok(!/different camera position/i.test(withView),
                    `${kind}: unanchored, the prompt claims a move from a reference that does not exist`);
            }
        }

        // With no view, the default is exactly what you get.
        const noView = buildPlatePrompt(kind, subject, 'a look', null, false);
        assert.ok(noView.includes(spec.framing),
            `${kind}: asking for no particular view lost the default framing`);
        assert.ok(!noView.includes(SENTINEL), `${kind}: a view leaked into a plate that has none`);
    }
});

// ── Both surfaces pick a view; neither asks you to type one ────────────────

test('every surface that sets a location view offers the views that exist', () => {
    /*
     * A location owns a growing set of views and the card names which one the
     * shot is pointed at. On the board that is a dropdown of what has actually
     * been photographed, plus "+ photograph a new view…".
     *
     * In previs it was a free-text box. Typing a view that matches nothing does
     * not fail — the gatherer falls back to the DEFAULT plate, which on a
     * reverse angle is a photograph of what is behind the camera. That is the
     * exact failure the picker was built to prevent, still live on the surface
     * where a director is most likely to be pointing the camera somewhere new.
     *
     * fillLocationViews is keyed on a PREFIX and expects `<prefix>LocationView`
     * to be a select it can fill. Derived from that contract rather than from a
     * list of surfaces typed here, so a third surface is held to it too.
     */
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');

    const prefixes = [...new Set([...html.matchAll(/fillLocationViews\(\s*'([A-Za-z0-9_]+)'/g)]
        .map(m => m[1]))];
    // Both spellings: a literal id, and one built from a panel's prefix
    // (`id="${p}LocationView"`). Matching only the literal reported the shared
    // blocking panel as missing, which is the template-vs-literal trap.
    const declared = [...new Set([
        ...[...html.matchAll(/id="([A-Za-z0-9_]+)LocationView"/g)].map(m => m[1]),
        ...[...html.matchAll(/id="\$\{(\w+)\}LocationView"/g)].map(() => '__panel__'),
    ])];
    // One surface now: previs had the second until its old stage was removed.
    assert.ok(declared.length >= 1,
        `expected a surface with a location view control, found ${declared.join(', ') || 'none'}`);

    const broken = [];
    for (const prefix of declared) {
        // The control must be a select — an input silently swallows the
        // innerHTML of <option>s and goes on accepting free text.
        const idPattern = prefix === '__panel__' ? '\\$\\{\\w+\\}LocationView' : `${prefix}LocationView`;
        const tag = html.match(new RegExp(`<(\\w+)[^>]*id="${idPattern}"`));
        if (!tag || tag[1] !== 'select') {
            broken.push(`${prefix}: the view control is a <${tag ? tag[1] : 'missing'}>, so a typed `
                + 'view matching nothing falls back to the default plate and looks like it worked');
        }
        if (prefix === '__panel__') continue;   // the shared panel is filled by its caller
        if (!prefixes.includes(prefix)) {
            broken.push(`${prefix}: nothing ever calls fillLocationViews('${prefix}'), so the list `
                + 'of photographed views never reaches it');
        }
        if (!new RegExp(`locationViewChanged\\(\\s*'${prefix}'`).test(html)) {
            broken.push(`${prefix}: "+ photograph a new view…" is offered with no handler wired`);
        }
    }
    assert.deepStrictEqual(broken, [], 'a surface asks a director to type a view rather than pick one');
});

test('the location itself is where its pictures are managed', () => {
    /*
     * Views shipped with their only control inside a SHOT's blocking panel. So
     * the plates belonging to a location could be seen and added from anywhere
     * except the location — a director opening SUBURBAN STREET saw its fields,
     * one plate, and a Regenerate button that replaces the default.
     *
     * That is backwards. A location owns a growing set of views; the shot
     * merely points at one. The set belongs where the thing it belongs to is,
     * and burying it in a per-shot panel is why it read as unbuilt.
     *
     * GET /locations/:id/plate/views already returns every view with its
     * image_url, label and availability — the data was there the whole time and
     * nothing on the location page asked for it.
     */
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');

    const inspector = html.slice(html.indexOf('async function inspectEntity('),
        html.indexOf('async function regeneratePlate('));
    assert.ok(inspector.length, 'the entity inspector is gone');

    const missing = [];
    if (!/plate\/views/.test(inspector) && !/locationViewsSection|renderLocationViews/.test(inspector)) {
        missing.push('the location inspector never asks for the views that exist, so a location '
            + 'with three plates still shows one');
    }
    if (!/photograph|add.*view|newView/i.test(inspector)) {
        missing.push('the location inspector offers no way to add a view, so the only route to '
            + 'one is through a shot');
    }
    assert.deepStrictEqual(missing, [],
        'a location cannot manage its own pictures');
});

test('the entity modal renders before it asks whether the plate is stale', () => {
    /*
     * inspectEntity awaited the whole-project staleness report before writing
     * a single character of the body, so opening a location with a plate
     * showed a titled, empty box for as long as that report took — and that
     * report grows with every generated asset in the project.
     *
     * It read as "modals are slow when a picture is involved". The picture had
     * nothing to do with it. The banner is information ABOUT the plate, not a
     * gate on reading the record, so the body must not wait for it.
     */
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('async function inspectEntity('),
        html.indexOf('async function renderLocationViews('));
    assert.ok(fn.length, 'inspectEntity is gone');

    const renders = fn.indexOf('body.innerHTML = `');
    const asksStaleness = fn.indexOf('/staleness');
    assert.ok(renders > 0, 'the modal never renders a body');
    assert.ok(asksStaleness < 0 || renders < asksStaleness,
        'the staleness report is awaited before the body is written, so the modal stays '
        + 'empty until a whole-project report returns');
});

// ── 10. The compass sweep: one picture becomes four sides ───────────────
//
// Every view a director generated on the real production came back the same
// side of the street, so 2AA — which shoots back the other way — was blocked.
// The cause is the anchor: the plate contains no information about what is
// behind its own camera, so a model asked to turn round re-photographs what it
// can see. Refusing the old viewpoint is not enough; the prompt has to say
// where the old content WENT, and by how much the camera turned.
//
// Set-based over COMPASS_VIEWS, because the failure is per-bearing: a 90° turn
// is a plausible picture of the same street and passes any eyeball check, while
// the 180° — the one that unblocks 2AA — is the one that comes back identical.

test('every compass view has a bearing, a name and a file of its own', () => {
    const { COMPASS_VIEWS, plateFileName } = require('../lib/reference-plates');
    assert.ok(Array.isArray(COMPASS_VIEWS) && COMPASS_VIEWS.length === 4,
        'the compass is not a registry of four sides');

    const seen = new Set();
    for (const v of COMPASS_VIEWS) {
        assert.ok(v.name && typeof v.name === 'string', `compass view has no name: ${JSON.stringify(v)}`);
        assert.ok(Number.isInteger(v.bearing) && v.bearing % 90 === 0 && v.bearing < 360,
            `${v.name}: bearing must be a quarter turn, got ${v.bearing}`);
        const file = plateFileName('location', 'SUBURBAN STREET', v.name);
        assert.ok(!seen.has(file), `${v.name} shares a file with another side: ${file}`);
        seen.add(file);
    }
    // Exactly one is the side the others turn FROM — the plate the director
    // already has. Generating it again would buy a duplicate of a picture we
    // were handed for free.
    const anchors = COMPASS_VIEWS.filter(v => v.isAnchor);
    assert.strictEqual(anchors.length, 1, 'the compass must have exactly one anchor side');
    assert.strictEqual(anchors[0].bearing, 0, 'the anchor side is the one at bearing 0');
});

test('each generated side states the turn, the bearing, and that the reference is out of frame', () => {
    const { COMPASS_VIEWS, buildPlatePrompt } = require('../lib/reference-plates');
    const subject = { id: 'l1', name: 'SUBURBAN STREET', description: 'A quiet cul-de-sac.' };

    for (const v of COMPASS_VIEWS.filter(x => !x.isAnchor)) {
        const prompt = buildPlatePrompt('location', subject, 'photoreal, blue hour', v.name, true);
        const head = prompt.slice(0, 200).toLowerCase();

        // Whatever leads a prompt is what the image is OF. If continuity leads,
        // the model reproduces the reference — which is exactly what happened.
        assert.ok(/turn|round|opposite|face/.test(head),
            `${v.name}: the turn does not lead the prompt — got: ${prompt.slice(0, 120)}`);

        // A bearing is unambiguous where "looking back across the bulb" is not.
        assert.ok(prompt.includes(`${v.bearing}`),
            `${v.name}: the prompt never states the ${v.bearing}° turn`);

        // The sentence that was missing. Refusing the old viewpoint in the
        // negative told the model not to repeat a framing; nothing told it the
        // things in the reference are no longer in shot.
        assert.ok(/not in (this )?frame|out of frame|no longer in (this )?(frame|shot)/i.test(prompt),
            `${v.name}: the prompt never says the reference's content has left the frame`);

        // Continuity still has to survive, or four sides are four streets.
        assert.ok(/same (buildings|materials|ground|place|location)/i.test(prompt),
            `${v.name}: nothing holds the place continuous with the reference`);
    }
});

test('the sweep generates the sides that are missing and never the anchor', async () => {
    const { COMPASS_VIEWS } = require('../lib/reference-plates');
    const { planCompassSweep } = require('../lib/reference-plates');
    assert.ok(typeof planCompassSweep === 'function',
        'nothing plans a compass sweep, so the button has no behaviour to call');

    const anchor = COMPASS_VIEWS.find(v => v.isAnchor).name;
    const generated = COMPASS_VIEWS.filter(v => !v.isAnchor).map(v => v.name);

    // Nothing photographed yet but the default plate: the three others are due.
    const fresh = planCompassSweep({ existingViews: [''], overwrite: false });
    assert.deepStrictEqual(fresh.generate.map(v => v.name).sort(), [...generated].sort(),
        'a fresh sweep does not cover every side');
    assert.ok(!fresh.generate.some(v => v.name === anchor),
        `the sweep regenerates ${anchor}, which is the picture the director already gave us`);

    // A side already photographed is not bought twice.
    const partial = planCompassSweep({ existingViews: ['', generated[0]], overwrite: false });
    assert.ok(!partial.generate.some(v => v.name === generated[0]),
        'the sweep pays again for a side that already exists');
    assert.strictEqual(partial.skipped.length, 1, 'the sweep does not report what it skipped');

    // Overwrite is a deliberate act and must reach every generated side.
    const forced = planCompassSweep({ existingViews: ['', generated[0]], overwrite: true });
    assert.strictEqual(forced.generate.length, generated.length,
        'overwrite does not re-shoot every side');

    // Without the anchor plate there is nothing to keep continuous with, and
    // four independently generated views are four different streets. Refused
    // rather than attempted, because attempting it looks like it worked.
    const none = planCompassSweep({ existingViews: [], overwrite: false });
    assert.strictEqual(none.generate.length, 0, 'the sweep generates with no plate to turn from');
    assert.ok(none.refused && /plate/i.test(none.reason || ''),
        'the sweep does not say why it refused without a plate');
});

test('a shot can name any compass side and be handed that plate', () => {
    /*
     * Generated, stored, and unselectable is the same as not generated. This
     * runs the real selector against real rows rather than asserting the
     * picker's markup, because the picker showing a side proves nothing about
     * what the payload attaches.
     */
    const { COMPASS_VIEWS } = require('../lib/reference-plates');
    const { gatherShotReferences } = require('../lib/shot-references');

    const projectId = generateId();
    const locationId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Compass');
    db.prepare('INSERT INTO film_locations (id, project_id, name, description) VALUES (?, ?, ?, ?)')
        .run(locationId, projectId, 'SUBURBAN STREET', 'A quiet cul-de-sac.');

    const dir = path.join(process.env.FILM_DATA_DIR, 'refsheets', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154'
        + '789c6300010000050001',
        'hex');

    for (const v of COMPASS_VIEWS) {
        const file = `location_SUBURBAN_STREET__${v.name}.png`;
        const full = path.join(dir, file);
        // Distinct bytes per side, or "it picked the right one" cannot be told
        // from "it picked any one".
        fs.writeFileSync(full, Buffer.concat([png, Buffer.from(v.name)]));
        db.prepare(`INSERT INTO film_assets
            (id, project_id, location_id, asset_type, file_path, file_name, format, version, metadata)
            VALUES (?, ?, ?, 'reference_image', ?, ?, 'png', 1, ?)`)
            .run(generateId(), projectId, locationId, full, file, JSON.stringify({ view: v.name }));
    }

    for (const v of COMPASS_VIEWS) {
        const gathered = gatherShotReferences(
            projectId, [], { id: locationId, name: 'SUBURBAN STREET' }, [], null,
            { locationView: v.name });
        const list = Array.isArray(gathered) ? gathered
            : (gathered.candidates || gathered.references || []);
        const loc = list.find(c => c.kind === 'location');
        assert.ok(loc, `${v.name}: no location reference was gathered at all`);

        /*
         * Assert on the BYTES, not the label. The gatherer inlines the plate as
         * a data URI and reports the view alongside it, so checking `view`
         * alone would pass on a gather that labelled the side correctly and
         * attached a different picture — which is the failure this whole
         * feature exists to stop, one level up.
         */
        const sent = Buffer.from(String(loc.uri).split(',')[1] || '', 'base64').toString('latin1');
        assert.ok(sent.endsWith(v.name),
            `a shot looking ${v.name} was sent the ${sent.slice(-8)} plate`);
        assert.strictEqual(loc.view, v.name,
            `${v.name}: the gathered reference reports view '${loc.view}'`);
    }
});

// ── 11. A refused import says which file, why, and what to do ───────────
//
// "I tried uploading two models and they never showed." The importer is sound
// — a 4.4MB Meshy GLB round-trips through the real browser path and lists — so
// what the director met was a REFUSAL they never saw: one line on a status bar
// at the bottom of the screen, and then the file input was cleared.
//
// Set-based over the refusal reasons, because the useless one is per-reason: a
// Draco file died three functions deep on "accessor has no bufferView", which
// is true, unactionable, and identical to what a corrupt file produces.

test('every GLB refusal names a remedy, and reaches the page', () => {
    const { parseGlb } = require('../lib/glb-parser');
    const { validateBytes, MEDIA_IMPORTS } = require('../lib/media-imports');

    const glb = (json, binLen = 4) => {
        const text = JSON.stringify(json);
        const jb = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
        const total = 12 + 8 + jb.length + (binLen === null ? 0 : 8 + binLen);
        const b = Buffer.alloc(total);
        b.write('glTF', 0, 'ascii'); b.writeUInt32LE(2, 4); b.writeUInt32LE(total, 8);
        b.writeUInt32LE(jb.length, 12); b.write('JSON', 16, 'ascii'); jb.copy(b, 20);
        if (binLen !== null) {
            b.writeUInt32LE(binLen, 20 + jb.length); b.write('BIN\0', 24 + jb.length, 'ascii');
        }
        return b;
    };

    // The ways an export a director would plausibly hand us gets refused.
    const CASES = [
        { name: 'draco', bytes: glb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], meshes: [{ primitives: [] }] }) },
        { name: 'meshopt', bytes: glb({ asset: { version: '2.0' }, extensionsRequired: ['EXT_meshopt_compression'], meshes: [{ primitives: [] }] }) },
        { name: 'unknown required extension', bytes: glb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_materials_variants'], meshes: [{ primitives: [] }] }) },
        { name: 'external .bin', bytes: glb({ asset: { version: '2.0' }, meshes: [{ primitives: [] }] }, null) },
        { name: 'no meshes', bytes: glb({ asset: { version: '2.0' }, meshes: [] }) },
    ];

    for (const c of CASES) {
        let message = null;
        try { parseGlb(c.bytes); } catch (err) { message = err.message; }
        assert.ok(message, `${c.name}: parsed a file it cannot render, so the import succeeds and the stage stays empty`);

        // Actionable means it names the thing to change, not merely that
        // something is wrong. "invalid GLB" sends a director back to Meshy
        // with nothing to try.
        assert.ok(/re-export|not supported|cannot read|no meshes|turned off/i.test(message),
            `${c.name}: refusal names no remedy — "${message}"`);

        // And the import layer must carry that reason out rather than
        // flattening every cause into one string.
        let imported = null;
        try { validateBytes(MEDIA_IMPORTS['three-d-model'], 'model/gltf-binary', c.bytes); }
        catch (err) { imported = err.message; }
        assert.ok(imported, `${c.name}: validateBytes accepted a GLB the parser refuses`);
        assert.ok(!/^invalid GLB:?$/i.test(imported.trim()),
            `${c.name}: the import layer discards the reason`);
    }

    // The page has to show it. A refusal on the bottom status bar is what made
    // two failed imports read as "they never showed".
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    assert.ok(/function reportImportFailure\s*\(/.test(html),
        'nothing renders an import failure anywhere but the status bar');
    const importer = html.slice(html.indexOf('async function importThreeDModel('));
    const body = importer.slice(0, importer.indexOf('\n    function generateAllModels'));
    assert.ok(/catch\s*\(\s*err\s*\)\s*\{\s*reportImportFailure\(/.test(body),
        'the importer still swallows its failure into setStatus alone');
});

// ── 12. An edit cannot move the camera ──────────────────────────────────
//
// The reverse view came back as the establishing view with a colder grade —
// three times, on three differently-worded prompts, which is what proved the
// wording was never the problem. lib/providers/meshy.js routes ANY reference
// to /openapi/v1/image-to-image, and OpenAI's to /images/edits; both hand back
// a modified copy of the picture they were given. A new camera position is the
// one thing an edit cannot produce.
//
// Set-based over the image adapters in the registry, because the same code is
// correct on one of them and structurally incapable on the others — so an
// example test written against whichever provider is configured today passes
// while the feature cannot work at all on the provider actually running.

test('every image adapter says what attaching a reference MEANS', () => {
    const providers = require('../lib/providers');
    // Derived from the registry, never a typed list: the next image adapter
    // must declare this or arrive silently assumed to condition.
    const imageAdapters = providers.list()
        .filter(e => (e.capabilities || []).includes('image'));
    assert.ok(imageAdapters.length >= 3,
        `the image adapter set collapsed (${imageAdapters.length})`);

    for (const entry of imageAdapters) {
        const name = entry.id;
        const adapter = entry;
        assert.ok(adapter, `${name}: no adapter entry`);
        assert.ok(['condition', 'edit'].includes(adapter.referenceMode),
            `${name} declares referenceMode ${JSON.stringify(adapter.referenceMode)} — an adapter that `
            + 'does not say whether a reference is conditioned on or edited will be assumed to '
            + 'condition, which is how a request for the opposite side of a street came back as '
            + 'the same side');
    }
});

test('a view request drops its references on an edit-mode provider, and keeps them on a conditioning one', async () => {
    const { generatePlate, COMPASS_VIEWS } = require('../lib/reference-plates');

    const projectId = generateId();
    const locationId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Modes');
    db.prepare('INSERT INTO film_locations (id, project_id, name, description) VALUES (?, ?, ?, ?)')
        .run(locationId, projectId, 'STREET', 'A quiet cul-de-sac of seven houses.');

    const dir = path.join(process.env.FILM_DATA_DIR, 'refsheets', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const anchorPath = path.join(dir, 'anchor.png');
    fs.writeFileSync(anchorPath, Buffer.from('89504e470d0a1a0a', 'hex'));

    const spyFor = mode => {
        const seen = [];
        return {
            adapter: {
                id: `spy-${mode}`, referenceMode: mode,
                async generate(_cap, payload) {
                    seen.push(payload);
                    return { ok: false, error: 'spy: not generating' };
                },
            },
            seen,
        };
    };

    const side = COMPASS_VIEWS.find(v => !v.isAnchor).name;

    for (const mode of ['edit', 'condition']) {
        const spy = spyFor(mode);
        const res = await generatePlate({
            projectId, kind: 'location',
            subject: db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locationId),
            stylePreset: 'photoreal', provider: spy.adapter, view: side, anchorPath, db,
        });
        assert.strictEqual(spy.seen.length >= 1, true, `${mode}: the provider was never called`);
        const payload = spy.seen[0];
        const attached = (payload.reference_images || []).length;

        if (mode === 'edit') {
            assert.strictEqual(attached, 0,
                'an edit-mode provider was handed the existing plate for a NEW VIEW — it will return '
                + 'that plate with a different grade, which is the reported defect');
            assert.strictEqual(res.anchored, false, 'the result claims it was anchored when it was not');
            assert.ok(res.anchor_dropped && /description/i.test(res.anchor_dropped),
                'nothing tells the director the side was painted from the description instead');
            // The negative refuses the old viewpoint only when the old viewpoint
            // is present; with nothing attached there is nothing to repeat.
            assert.ok(!/same camera position/i.test(payload.negative_prompt || ''),
                'the negative still refuses a viewpoint that was never attached');
        } else {
            assert.ok(attached >= 1,
                'a conditioning provider lost its anchor — the four sides will not agree with each other');
            assert.strictEqual(res.anchored, true, 'a conditioned view does not report itself anchored');
        }
    }

    // A subject's FIRST plate has no view and no anchor, so nothing about it
    // changes on either kind of provider.
    for (const mode of ['edit', 'condition']) {
        const spy = spyFor(mode);
        await generatePlate({
            projectId, kind: 'location',
            subject: db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locationId),
            stylePreset: 'photoreal', provider: spy.adapter, db,
        });
        assert.ok(spy.seen.length, `${mode}: the first plate never reached the provider`);
    }
});

// ── 13. A view can be deleted ───────────────────────────────────────────
//
// Four views were generated and all four were the same side; removing the
// three duplicates had to be done by hand against the database, because the
// app can create a view and cannot remove one. A set that only grows is not a
// set a director can curate — and the compass sweep SKIPS a side that already
// exists, so a bad side is permanent until something can delete it.
//
// Set-based over what a delete must leave behind, because each is silently
// wrong on its own: a row removed with the file left behind leaks disk, a file
// removed with the row left behind lists a view whose picture is gone, and a
// delete that says nothing about the shots pointing at it repoints them
// silently to a picture of a different direction.

test('deleting a view removes the row, the file, and reports what pointed at it', async () => {
    const { handleLocations } = require('../routes/locations');
    const { COMPASS_VIEWS } = require('../lib/reference-plates');

    const projectId = generateId();
    const locationId = generateId();
    const sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Curate');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(locationId, projectId, 'STREET');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)')
        .run(sceneId, projectId, 1, 'STREET');

    const dir = path.join(process.env.FILM_DATA_DIR, 'refsheets', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');

    // The default plate plus every compass side, so the delete is exercised
    // over the whole vocabulary rather than one convenient example.
    const made = [];
    for (const v of ['', ...COMPASS_VIEWS.map(c => c.name)]) {
        const file = `location_STREET${v ? '__' + v : ''}.png`;
        const full = path.join(dir, file);
        fs.writeFileSync(full, png);
        const id = generateId();
        db.prepare(`INSERT INTO film_assets
            (id, project_id, location_id, asset_type, file_path, file_name, format, version, metadata)
            VALUES (?, ?, ?, 'reference_image', ?, ?, 'png', 1, ?)`)
            .run(id, projectId, locationId, full, file, JSON.stringify(v ? { view: v } : {}));
        made.push({ view: v, id, full });
    }

    // A shot pointed at one of them, so the delete has something to warn about.
    const targeted = COMPASS_VIEWS.find(c => !c.isAnchor).name;
    const shotId = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml)
        VALUES (?, ?, ?, ?)`)
        .run(shotId, sceneId, '1A', JSON.stringify({ shot_code: '1A', location_view: targeted }));

    const call = (method, url, body) => new Promise(resolve => {
        const chunks = [];
        const res = {
            writeHead(status) { this.statusCode = status; return this; },
            end(payload) { chunks.push(payload || ''); resolve({ status: this.statusCode || 200, body: JSON.parse(chunks.join('') || '{}') }); },
        };
        handleLocations({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean));
    });

    for (const m of made) {
        const before = (await call('GET', `/film/locations/${locationId}/plate/views`)).body.views;
        assert.ok(before.some(v => v.view === m.view),
            `${m.view || '(default)'}: not listed before deleting it`);

        const del = await call('DELETE',
            `/film/locations/${locationId}/plate/views/${encodeURIComponent(m.view || '__default__')}`);
        assert.strictEqual(del.status, 200,
            `${m.view || '(default)'}: delete returned ${del.status} — ${JSON.stringify(del.body)}`);

        assert.ok(!fs.existsSync(m.full), `${m.view || '(default)'}: the row went and the file stayed`);
        assert.ok(!db.prepare('SELECT id FROM film_assets WHERE id = ?').get(m.id),
            `${m.view || '(default)'}: the file went and the row stayed`);

        const after = (await call('GET', `/film/locations/${locationId}/plate/views`)).body.views;
        assert.ok(!after.some(v => v.view === m.view),
            `${m.view || '(default)'}: still listed after deleting it`);

        // A card naming a deleted view falls back silently to a picture of a
        // different direction, which is the exact defect views exist to stop.
        // The delete must SAY so; it must not quietly rewrite the card.
        if (m.view === targeted) {
            assert.ok(Array.isArray(del.body.shots_pointing_here)
                && del.body.shots_pointing_here.includes('1A'),
                'the delete never named the shot that was pointed at this view');
            const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?')
                .get(shotId).scene_card_yaml);
            assert.strictEqual(card.location_view, targeted,
                'deleting a view rewrote a scene card; which side a shot looks at is a director choice');
        }
        if (!m.view) {
            assert.strictEqual(del.body.was_default, true,
                'deleting the anchor plate is not reported as deleting the anchor plate');
        }
    }

    // Deleted, so the sweep offers it again rather than skipping it forever.
    const plan = (await call('GET', `/film/locations/${locationId}/plate/compass/plan`)).body;
    assert.ok(plan.refused, 'with every plate deleted the sweep still claims it can turn from one');

    const missing = await call('DELETE', `/film/locations/${locationId}/plate/views/nosuchview`);
    assert.strictEqual(missing.status, 404, 'deleting a view that does not exist reports success');
});
