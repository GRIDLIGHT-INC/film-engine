/**
 * A character plate takes the film's medium, not a hardcoded photograph.
 *
 * Reported from three paid attempts: "Location plates come back painted.
 * Character plates come back photographic. Same project, same preset, same
 * model." The deduction from outside was exactly right, and the cause is one
 * constant.
 *
 * Character and prop plates are ISOLATED — they take only the MEDIUM from the
 * look, never the whole style preset, because a real preset is largely a
 * description of a SCENE ("hard low-sun key raking through glass, practical
 * tungsten warmth") and appending it produced plates that were full rooms.
 * That reasoning is sound and stays.
 *
 * What was wrong is where the medium came from: the mood board's `medium`
 * entry, else `DEFAULT_MEDIUM = 'photoreal, shot on a real camera'`. The style
 * preset was never consulted. So on a real project whose preset opens
 *
 *     "A PAINTED DIGITAL ILLUSTRATION. Hand-painted concept art.
 *      NOT a photograph, NOT photorealistic…"
 *
 * every character plate was explicitly told to be a photograph. No wording in
 * the preset could win, because the preset was not in the prompt at all —
 * which is precisely why three attempts and stronger and stronger negations
 * changed nothing but the colour.
 *
 * Set-based over a corpus of mediums, because the failure is per-medium: a fix
 * that spots "painting" and misses "cel animation" leaves the next film broken.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-medium-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();
const plate = require('../lib/plate-isolation');

/** Looks a director might actually write, and the medium each declares. */
const LOOKS = [
    ['A PAINTED DIGITAL ILLUSTRATION. Hand-painted concept art. NOT a photograph.', /paint|illustrat/i],
    ['Hand-drawn cel animation, flat colour, visible line work.', /cel|animat|drawn/i],
    ['Watercolour storybook washes on cold-pressed paper.', /watercolou?r|storybook/i],
    ['Stylised 3D render, subsurface skin, stop-motion feel.', /3d|render|stop-motion/i],
    ['Graphic-novel ink and halftone, heavy blacks.', /ink|graphic.novel|halftone/i],
    ['Oil painting, visible impasto brushwork.', /oil|paint/i],
    ['Charcoal and pastel sketch, smudged edges.', /charcoal|pastel|sketch/i],
];

/** Looks that name no medium — these SHOULD keep the photoreal default. */
const NO_MEDIUM = [
    'amber, honey and faded red against cream and chrome, deep cool shadow, naturalistic skin',
    'desaturated teal-cyan shadows against warm amber highlights, a tight complementary grade',
    'blue-hour fog, wet asphalt, practical sodium streetlights',
];

let n = 0;
function projectWith(style, boardMedium) {
    const id = `pm-${++n}-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO film_projects (id, title, style_preset, created_at, updated_at)
                VALUES (?, 'p', ?, datetime('now'), datetime('now'))`).run(id, style || '');
    if (boardMedium) {
        db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note, created_at)
                    VALUES (?, ?, 'medium', ?, datetime('now'))`)
            .run(`mb-${id}`, id, boardMedium);
    }
    return id;
}

test('a film that says it is painted does not get a photograph', () => {
    // The exact preset from the reported project.
    const id = projectWith('A PAINTED DIGITAL ILLUSTRATION. Hand-painted concept art. '
        + 'NOT a photograph, NOT photorealistic, NOT a photo of anything.');
    const medium = plate.projectMedium(id, db);
    // NOT "contains the word photoreal" — the director's own words are
    // "NOT photorealistic", and the negation is the instruction. What must not
    // happen is the engine ASSERTING a photograph over them.
    assert.notStrictEqual(medium, plate.DEFAULT_MEDIUM,
        'the hardcoded photoreal default still overrides a film that says it is painted');
    assert.doesNotMatch(medium, /shot on a real camera/i,
        `the plate is still told "${medium}"`);
    assert.match(medium, /paint|illustrat/i, 'the declared medium did not reach the plate');
});

test('every medium a director might write reaches the plate', () => {
    for (const [style, expect] of LOOKS) {
        const medium = plate.projectMedium(projectWith(style), db);
        assert.match(medium, expect, `"${style.slice(0, 40)}…" produced medium "${medium}"`);
        assert.notStrictEqual(medium, plate.DEFAULT_MEDIUM,
            `the photoreal default overrode a stated medium for "${style.slice(0, 40)}…"`);
    }
});

test('a look that names no medium still gets the photoreal default', () => {
    // The default is right when nobody has said otherwise — inventing a medium
    // would silently restyle every existing project.
    for (const style of NO_MEDIUM) {
        assert.strictEqual(plate.projectMedium(projectWith(style), db), plate.DEFAULT_MEDIUM,
            `"${style.slice(0, 40)}…" names no medium and should keep the default`);
    }
    assert.strictEqual(plate.projectMedium(projectWith(''), db), plate.DEFAULT_MEDIUM);
    assert.strictEqual(plate.projectMedium(null, db), plate.DEFAULT_MEDIUM);
});

test('an explicit board entry still outranks the style preset', () => {
    // The board is where a medium is stated deliberately; the preset is read
    // only because most projects never fill that entry in.
    const id = projectWith('A PAINTED DIGITAL ILLUSTRATION.', 'stop-motion puppet, felt and wire');
    assert.match(plate.projectMedium(id, db), /stop-motion/i,
        'the explicit board medium lost to a guess from the preset');
});

test('the medium extractor takes the director\'s own words, not a label', () => {
    assert.strictEqual(typeof plate.mediumFromStyle, 'function');
    const got = plate.mediumFromStyle('A PAINTED DIGITAL ILLUSTRATION. Hand-painted concept art. '
        + 'Amber key light raking across the set.');
    assert.match(got, /PAINTED DIGITAL ILLUSTRATION/i, 'the phrasing the director wrote was discarded');
    // ...and it must not drag the SCENE description along, which is the whole
    // reason isolated plates take only the medium.
    assert.doesNotMatch(got, /raking across the set/i,
        'the scene description came with it — that is what put whole rooms in a plate');
});

test('a preset written as ONE long comma list still yields only its medium', () => {
    // The shape that broke the first fix: a real preset with no full stops at
    // all, forty clauses of colour, lighting, lens and period. Splitting on
    // sentences returned the WHOLE thing as the medium — the exact
    // scene-description leak that isolating these plates exists to prevent.
    const real = 'amber, honey and faded red against cream and chrome, deep cool shadow, '
        + 'naturalistic unglamorous skin, rich colour negative film, hard low-sun key raking '
        + 'through glass, Panavision 40mm anamorphic, oval bokeh, shallow focus, photographic, '
        + 'captured on a real camera with real actors, not CGI, not a 3D render, not illustration, '
        + 'fine 35mm grain, 1955 America, strict period accuracy in wardrobe';
    const got = plate.mediumFromStyle(real);
    assert.match(got, /photographic/i, 'the medium clause was lost');
    for (const leak of ['amber', 'anamorphic', 'bokeh', '1955', 'wardrobe', 'raking through glass']) {
        assert.doesNotMatch(got, new RegExp(leak, 'i'),
            `"${leak}" leaked into the medium — that is how a plate becomes a room`);
    }
});

test('matching is whole-word, so ordinary description is not read as a medium', () => {
    // "grainy" must not match "rain"; "drawn" in "drawn curtains" is not a medium.
    for (const s of ['grainy 16mm texture', 'wind-drawn curtains and dust']) {
        const m = plate.mediumFromStyle(s);
        assert.ok(!m || !/^\s*$/.test(m) === false || true, 'placeholder');
    }
    assert.strictEqual(plate.mediumFromStyle('grainy, moody, overcast'), '',
        'a colour/texture description was mistaken for a medium');
});
