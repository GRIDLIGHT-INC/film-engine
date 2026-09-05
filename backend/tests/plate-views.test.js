/**
 * A turnaround is three pictures, and the app used the wrong one.
 *
 * "We just generated plates for a character with front, side, back — but have
 * no place to put them."
 *
 * They were stored correctly: three files, three asset rows, each carrying its
 * view in metadata. Two things were wrong with what happened next.
 *
 * WHICH ONE ATTACHES. Both places that pick "the plate" ordered by
 * `created_at DESC LIMIT 1`, and a turnaround is generated front, side, back —
 * so the newest row is always the BACK. Every frame a character appeared in
 * was conditioned on the back of their head, and the character card showed the
 * same. Generating three views cost three times as much as one and made the
 * result worse than not bothering, while the symptom — a plausible stranger in
 * the frame — reads as conditioning being weak rather than as the wrong
 * picture being sent.
 *
 * WHERE TO SEE THEM. Locations have had `plate/views` since the compass work.
 * Characters, which are the subject a turnaround is FOR, had nothing: no way
 * to look at the three, and no way to tell which one was doing the work.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-views-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();

const { VIEW_RANK, viewRank, orderByViewSql } = require('../lib/plate-views');
const { handleCharacters } = require('../routes/characters');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** The views a character reference sheet is actually generated in. */
function generatedViews() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'characters.js'), 'utf8');
    const m = /const REFSHEET_VIEWS = \[([^\]]*)\]/.exec(src);
    assert.ok(m, 'REFSHEET_VIEWS is gone — the denominator cannot be derived');
    return [...m[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]);
}

test('every view the generator produces has a rank', () => {
    // Derived from the generator, so a fourth view added later either gets a
    // rank or fails here — rather than silently ranking last and, on a project
    // where it happens to be newest, becoming the identity plate.
    for (const view of generatedViews()) {
        assert.ok(Object.prototype.hasOwnProperty.call(VIEW_RANK, view),
            `the generator produces a "${view}" view that plate-views does not rank`);
    }
});

test('the front outranks every other view', () => {
    for (const view of generatedViews()) {
        if (view === 'front') continue;
        assert.ok(viewRank('front') < viewRank(view),
            `${view} outranks front — a face is what identity is carried by`);
    }
    // An unknown view is still usable, just last: a subject whose only plate
    // is unlabelled must still get a picture rather than none.
    assert.ok(viewRank('front') < viewRank('something-new'));
    assert.ok(Number.isFinite(viewRank('something-new')));
});

test('the ordering is applied where a plate is actually chosen', () => {
    /*
     * Both consumers, and checked INSIDE the ORDER BY rather than anywhere in
     * the file. The first version grepped each module for `orderByViewSql` —
     * which the import line alone satisfies — so removing it from the query
     * left the test green while every frame went back to being conditioned on
     * the back of the character's head. A mutation caught it.
     */
    const sources = {
        'shot-references': fs.readFileSync(path.join(__dirname, '..', 'lib', 'shot-references.js'), 'utf8'),
        'characters route': fs.readFileSync(path.join(__dirname, '..', 'routes', 'characters.js'), 'utf8'),
    };
    for (const [name, src] of Object.entries(sources)) {
        const plateQueries = (src.match(/ORDER BY[^`'"]*/g) || [])
            .filter(q => !/scene|shot_code|created_at ASC/.test(q));
        assert.ok(plateQueries.length, `${name} has no plate ordering at all`);
        const ranked = plateQueries.filter(q => /orderByViewSql|CASE json_extract/.test(q));
        assert.ok(ranked.length,
            `${name} picks a plate without ranking the view — the newest row wins again, `
            + `and a turnaround is written front, side, back`);
    }
    assert.match(orderByViewSql(), /WHEN 'front' THEN 0/);
});

test('the front is chosen even when the back is newest', () => {
    /*
     * Behavioural, against a real database, in the exact order the generator
     * writes: front, then side, then back. A test that inserted them in any
     * other order would pass against the bug.
     */
    const project = 'c0000000-0000-4000-8000-00000000000f';
    const character = 'c0000000-0000-4000-8000-0000000000ff';
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'p', datetime('now'), datetime('now'))`).run(project);
    db.prepare(`INSERT INTO film_characters (id, project_id, name, created_at, updated_at)
                VALUES (?, ?, 'RAY', datetime('now'), datetime('now'))`).run(character, project);

    /*
     * Real files, because "which view attaches" and "is the picture actually
     * there" are separate questions and the route answers both — a fixture
     * pointing at paths that do not exist would report every view unusable and
     * the identity plate as none.
     */
    const dir = path.join(process.env.FILM_DATA_DIR, 'refsheets', project);
    fs.mkdirSync(dir, { recursive: true });
    generatedViews().forEach((view, i) => {
        const file = path.join(dir, `RAY_${view}.png`);
        fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
        db.prepare(`INSERT INTO film_assets
              (id, project_id, character_id, asset_type, file_name, file_path,
               mime_type, version, metadata, created_at)
            VALUES (?, ?, ?, 'character_sheet', ?, ?, 'image/png', 1, ?, datetime('now', ?))`)
            .run(crypto.randomUUID(), project, character,
                `RAY_${view}.png`, file,
                JSON.stringify({ character_id: character, view }), `+${i} seconds`);
    });

    const chosen = db.prepare(
        `SELECT file_name FROM film_assets
          WHERE project_id = ? AND character_id = ?
            AND asset_type IN ('character_sheet', 'reference_image')
          ORDER BY ${orderByViewSql()}, version DESC, created_at DESC LIMIT 1`).get(project, character);

    assert.strictEqual(chosen.file_name, 'RAY_front.png',
        'the newest plate won again — every frame is conditioned on the back of the head');
});

test('the views are listed, and the one that reaches a prompt is named', () => {
    const character = 'c0000000-0000-4000-8000-0000000000ff';
    return new Promise(resolve => {
        const res = { writeHead() {}, end(payload) {
            const j = JSON.parse(payload);
            assert.strictEqual(j.views.length, generatedViews().length,
                'not every stored view is listed');
            assert.deepStrictEqual(j.views.map(v => v.view), generatedViews(),
                'views are not listed in turnaround order');

            // Which one is doing the work has to be visible: three plates
            // exist and exactly one is attached, so the other two look like
            // they are working when they are not.
            const flagged = j.views.filter(v => v.is_identity_plate);
            assert.strictEqual(flagged.length, 1, 'exactly one view can be the identity plate');
            assert.match(j.note, /conditioned on the front view/);
            resolve();
        } };
        handleCharacters({ method: 'GET' }, res,
            ['film', 'characters', character, 'refsheet', 'views'], {});
    });
});

test('a view whose file is gone is offered as unavailable, never as a picture', () => {
    /*
     * The mistake location views made once already: manufacturing an image_url
     * unconditionally, so a row whose file was gone was offered as a normal
     * choice and a picker filtering on "has a url" filtered on something
     * always truthy.
     *
     * Its own subject, with a row pointing at a file that was never written —
     * reusing the turnaround fixture would test the opposite case.
     */
    const project = 'c0000000-0000-4000-8000-00000000000f';
    const ghost = 'c0000000-0000-4000-8000-0000000000ee';
    db.prepare(`INSERT INTO film_characters (id, project_id, name, created_at, updated_at)
                VALUES (?, ?, 'GHOST', datetime('now'), datetime('now'))`).run(ghost, project);
    db.prepare(`INSERT INTO film_assets
          (id, project_id, character_id, asset_type, file_name, file_path,
           mime_type, version, metadata, created_at)
        VALUES (?, ?, ?, 'character_sheet', 'GHOST_front.png', ?, 'image/png', 1, ?, datetime('now'))`)
        .run(crypto.randomUUID(), project, ghost,
            path.join(process.env.FILM_DATA_DIR, 'refsheets', project, 'GHOST_front.png'),
            JSON.stringify({ character_id: ghost, view: 'front' }));

    return new Promise(resolve => {
        const res = { writeHead() {}, end(payload) {
            const j = JSON.parse(payload);
            assert.strictEqual(j.views.length, 1);
            const v = j.views[0];
            assert.strictEqual(v.available, false);
            assert.strictEqual(v.image_url, null,
                'a missing picture was given a URL, which renders as a broken image');
            assert.ok(v.unavailable_reason, 'unavailable without saying why');
            assert.strictEqual(j.identity_plate, null,
                'an unusable plate was named as the one conditioning every frame');
            assert.match(j.note, /invent this character/,
                'a subject with no usable plate must say what that costs');
            resolve();
        } };
        handleCharacters({ method: 'GET' }, res,
            ['film', 'characters', ghost, 'refsheet', 'views'], {});
    });
});

test('the page can reach the turnaround, and prefixes the API origin', () => {
    // A capability with no control is indistinguishable from one that does not
    // exist — and a picture URL served from a different port is a perfectly
    // good string that 404s, which is how this was caught the first time.
    assert.match(SPA, /function showCharacterViews/, 'no viewer');
    assert.match(SPA, /showCharacterViews\('\$\{c\.id\}'\)/, 'no control on the character card');
    assert.match(SPA, /refsheet\/views/, 'the page never calls the views route');

    // The markup lives in the shared renderer, not in either caller.
    const at = SPA.indexOf('function characterViewsHtml');
    assert.notStrictEqual(at, -1, 'the shared turnaround renderer is gone');
    const body = SPA.slice(at, at + 2200);
    assert.match(body, /\$\{API_BASE\}\$\{esc\(v\.image_url\)\}/,
        'the picture src omits API_BASE, so every view 404s against the page origin');
});

/**
 * A subject plate is the subject and nothing else.
 *
 * A character or prop plate conditions every frame that subject appears in, so
 * anything else in the picture travels with it — a kitchen behind a character
 * is pulled into the street he is supposed to be standing in.
 *
 * Both builders already asked for a "plain seamless backdrop" and both came
 * back with full rooms. The instruction was not missing, it was OUTRANKED: a
 * real style preset is largely a description of a SCENE ("hard low-sun key
 * raking through glass", "practical tungsten warmth blooming in frame"), it
 * LEADS the prompt deliberately, and three trailing words lost to four hundred
 * leading ones. The negative said "background clutter", which asks for a tidy
 * room rather than for no room.
 */
const { ISOLATED_KINDS, ISOLATION_CLAUSE } = require('../lib/plate-isolation');
const { buildRefSheetPrompt, REFSHEET_NEGATIVE } = require('../routes/characters');
const { buildPlatePrompt } = require('../lib/reference-plates');

/** A real style preset: mostly a description of a place, as they all are. */
const SCENE_STYLE = 'amber and chrome, hard low-sun key raking through glass, practical tungsten '
    + 'warmth blooming in frame, light visible as shafts in heavy haze, 40mm anamorphic';

test('a subject plate opens with the empty frame, before any look is applied', () => {
    /*
     * POSITION, measured against the whole prompt. An earlier version checked
     * only that the clause preceded the subject description, and passed while
     * 276 characters of "hard low-sun key raking through glass … shafts in
     * heavy haze … practical tungsten warmth blooming in frame" sat in front
     * of it. Every one of those is a room with a window, asserted first and at
     * length, and whatever leads a prompt is what the image is of.
     */
    const prompts = {
        character: buildRefSheetPrompt({ name: 'RAY', appearance_prompt: 'mid-40s man' }, 'front', SCENE_STYLE),
        prop: buildPlatePrompt('prop', { name: 'SALT SHAKER', visual_prompt: 'chrome shaker' }, SCENE_STYLE, null, false),
    };
    for (const kind of ISOLATED_KINDS) {
        const prompt = String(prompts[kind]);
        assert.ok(prompt.includes(ISOLATION_CLAUSE), `the ${kind} plate does not ask for an empty frame`);
        const at = prompt.indexOf(ISOLATION_CLAUSE);
        assert.ok(at < 110,
            `the ${kind} plate says the frame is empty ${at} characters in, which is not the opening`);
    }
});

test('NO scene description reaches a character or prop plate', () => {
    /*
     * The rule, stated as the thing that must not happen. A style preset
     * describes finished FRAMES — light through windows, practicals in shot —
     * so on a plate it asks for the room the plate exists to exclude.
     *
     * Scoping it with "read this as look only" was an earlier attempt and it
     * is a hedge: it hands the model the rooms and asks it not to build them.
     * The plate takes the MEDIUM instead, and the scene description stays
     * where it belongs — on the frames.
     */
    const SCENE_WORDS = ['raking through glass', 'shafts in heavy haze', 'tungsten', 'blooming in frame',
                         'negative space', 'moving camera'];
    const prompts = {
        character: buildRefSheetPrompt({ name: 'RAY', appearance_prompt: 'mid-40s man' }, 'front', SCENE_STYLE),
        prop: buildPlatePrompt('prop', { name: 'SHAKER', visual_prompt: 'chrome' }, SCENE_STYLE, null, false),
    };
    for (const kind of ISOLATED_KINDS) {
        const prompt = String(prompts[kind]).toLowerCase();
        for (const word of SCENE_WORDS) {
            assert.ok(!prompt.includes(word.toLowerCase()),
                `the ${kind} plate carries "${word}" from the style preset — that is a scene`);
        }
        assert.ok(!prompt.includes(SCENE_STYLE.toLowerCase().slice(0, 40)),
            `the ${kind} plate carries the style preset verbatim`);
    }
});

test('the medium comes from the mood board, and is never left unsaid', () => {
    /*
     * `medium` is the first entry in the board's KIND_ORDER precisely because
     * it decides what kind of picture this is — photoreal, 3D render, cel
     * animation. That is the one thing a plate needs from the look, and the
     * one thing that has to match across a production.
     *
     * Never left unsaid: an unstated medium is what a model fills in with clip
     * art, which is the defect the whole style-leads ordering was built
     * against.
     */
    const { projectMedium, DEFAULT_MEDIUM } = require('../lib/plate-isolation');

    const pid = 'c0000000-0000-4000-8000-0000000000aa';
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'm', datetime('now'), datetime('now'))`).run(pid);

    // No board entry: photoreal, not nothing.
    assert.strictEqual(projectMedium(pid), DEFAULT_MEDIUM);
    assert.ok(DEFAULT_MEDIUM.length > 0, 'the default medium is empty, which is what invites clip art');

    db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note, sort_order, created_at)
                VALUES (?, ?, 'medium', 'stylised 3D animation', 0, datetime('now'))`)
        .run(crypto.randomUUID(), pid);
    assert.strictEqual(projectMedium(pid), 'stylised 3D animation');

    // It reaches the plate, and the framing noun does not contradict it.
    const prompt = buildRefSheetPrompt({ name: 'RAY', appearance_prompt: 'x' }, 'front', SCENE_STYLE, pid);
    assert.ok(prompt.startsWith('stylised 3D animation'),
        'the board medium does not lead the plate prompt');
    assert.ok(!/photograph/i.test(prompt.slice(0, 120)),
        'the opening says "photograph" for a 3D-animated production — two incompatible mediums in one clause');

    // An unreadable board must never stop a plate being generated.
    assert.strictEqual(projectMedium(null), DEFAULT_MEDIUM);
    assert.strictEqual(projectMedium('no-such-project'), DEFAULT_MEDIUM);
});

test('a location plate is exempt, and stays an environment', () => {
    // Applying isolation here would ask for a picture of a place with no place
    // in it. Its own constraint is the opposite one.
    const prompt = String(buildPlatePrompt('location',
        { name: 'DINER', description: 'a harbour diner' }, SCENE_STYLE, null, false));
    assert.ok(!prompt.includes(ISOLATION_CLAUSE),
        'a location plate is being asked for no scenery');
    assert.match(prompt, /no people/, 'a location plate must still exclude figures');
    assert.ok(!ISOLATED_KINDS.includes('location'));
});

test('the negative refuses a background outright, not merely clutter', () => {
    /*
     * "background clutter" reads as an instruction to TIDY the room. The
     * negative is what actually holds once the style has spent four hundred
     * characters describing a place, so it names concrete nouns a model can
     * act on.
     */
    for (const word of ['background', 'room', 'interior', 'furniture', 'scenery']) {
        assert.match(REFSHEET_NEGATIVE, new RegExp(`\\b${word}\\b`),
            `the character plate negative does not refuse "${word}"`);
    }
    assert.ok(!/background clutter/.test(REFSHEET_NEGATIVE),
        '"background clutter" asks for a tidy room rather than no room');
});

test('both builders share one isolation clause', () => {
    // Two literals is how the two came to ask for isolation with different
    // force — one said "plain seamless backdrop", the other "plain seamless
    // background", and neither held.
    for (const [name, file] of [['characters route', 'routes/characters.js'],
                                ['reference-plates', 'lib/reference-plates.js']]) {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        // They share the whole OPENING now, not merely the clause: the medium,
        // the framing noun and the empty frame are one construction, and a
        // builder assembling its own would be free to reorder them.
        assert.match(src, /subjectPlateOpening\(/,
            `${name} writes its own plate opening instead of sharing one`);
        assert.ok(!/plain seamless backdrop'|plain seamless background'/.test(src),
            `${name} still carries a private isolation literal`);
    }
});

test('regenerating a view replaces its row rather than adding one', () => {
    /*
     * The file is written to the same per-view name and overwrites, so a second
     * generation produced a NEW asset row pointing at the same picture. Ray was
     * regenerated once through MCP and the views list showed SIX entries for
     * three files; every regeneration after that adds three more, forever.
     *
     * Not merely cosmetic: two rows for one view means "the plate" is whichever
     * the query happens to return, the fingerprint is stamped on one of them,
     * and accepting staleness on the visible row leaves the other still
     * reported as behind.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'characters.js'), 'utf8');

    const insertAt = src.indexOf("VALUES (?, ?, ?, 'character_sheet'");
    assert.notStrictEqual(insertAt, -1, 'the character sheet insert is gone');

    // The delete must be in the same block, BEFORE the insert — scoped to the
    // subject and the view, not to the filename.
    const before = src.slice(Math.max(0, insertAt - 2500), insertAt);
    assert.match(before, /DELETE FROM film_assets/,
        'a regenerated view is inserted without removing the row it replaces');
    assert.match(before, /json_extract\(metadata, '\$\.view'\) = \?/,
        'the replacement is not scoped to the view, so it would drop the whole turnaround');
    assert.match(before, /character_id = \?/,
        'the replacement is not scoped to the character');

    /*
     * The PLATE FILE must survive. Bound to the destination path, not to any
     * unlink at all: the decline branch legitimately removes its own scratch
     * cut, and forbidding every unlink reported that correct cleanup as the
     * bug. What must never happen is unlinking `filePath` — the per-view name
     * the approved plate already occupies.
     */
    const deleteBlock = before.slice(before.indexOf('const stale'));
    assert.ok(!/unlinkSync\(\s*filePath\s*\)/.test(deleteBlock),
        'the replacement deletes the plate file at the per-view path');

    /*
     * And the cut must not land on the plate's own name before the decision is
     * made. ffmpeg -y over `filePath` destroys an approved plate's pixels
     * BEFORE mayOverwrite() is consulted, so declining to replace it was the
     * one operation that reliably destroyed it.
     */
    /*
     * Bound to the DESTINATION, not to the call shape. This matched the literal
     * `execFileSync(... '-frames:v', '1', '-q:v', '2', <var>]` and went stale
     * the day the cut improved: RBF-003 routed it through the shared
     * `extractFrame`, and the scan then reported the safety it was protecting
     * as GONE while it was intact. The invariant is where the frame lands, so
     * either form is accepted and the destination is what is checked.
     */
    const cutBlock = src.slice(Math.max(0, insertAt - 4000), insertAt);
    const cut = /extractFrame\([\s\S]{0,300}?\bout:\s*(\w+)/.exec(cutBlock)
        || /execFileSync\([\s\S]{0,400}?'-frames:v', '1', '-q:v', '2', (\w+)\]/.exec(cutBlock);
    assert.ok(cut, 'the orbit frame cut is gone — the scan is broken');
    assert.notStrictEqual(cut[1], 'filePath',
        'the orbit cuts straight over the per-view plate, before deciding whether it may replace it');
});

test('clicking a character shows the whole turnaround, not one picture', () => {
    /*
     * The Views button existed and this panel still showed ONE image — so two
     * of the three plates a director had just paid for were invisible unless
     * they found a separate control. A capability behind a button nobody
     * presses is indistinguishable from one that is missing.
     */
    /*
     * Bounded by the NEXT function, not by a fixed offset.
     *
     * This sliced 5000 characters and broke the moment the panel grew — the
     * plate images gained a click handler and the views call fell outside the
     * window, reporting a working panel as unwired. A fixed window over a
     * renderer is the same brittleness `panelSource` already documents.
     */
    const at = SPA.indexOf('async function inspectEntity');
    assert.notStrictEqual(at, -1, 'the detail panel is gone');
    const nextFn = SPA.indexOf('\n    function ', at + 40);
    const fn = SPA.slice(at, nextFn > at ? nextFn : at + 9000);

    assert.match(fn, /characterViewsSection/,
        'the character detail panel has no place to put the other views');
    assert.match(fn, /renderCharacterViewsInto\('characterViewsSection'/,
        'the views section is created and never filled');

    // One renderer for both surfaces: two copies is how the board and the
    // viewer came to disagree about their own markup tools.
    assert.match(SPA, /function characterViewsHtml/, 'no shared renderer');
    const uses = (SPA.match(/characterViewsHtml\(/g) || []).length;
    assert.ok(uses >= 3,
        `the turnaround markup is not shared between the detail panel and the Views button (${uses} uses)`);
});
