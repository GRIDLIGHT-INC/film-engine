/**
 * The card got complicated for no reason.
 *
 * A character card carried EIGHT buttons — Regen Image, Orbit Sheet, Views,
 * Upload, Gallery, Voice, Edit, Delete — and clicking the card itself did
 * nothing. Every one of those is something you do WHILE LOOKING AT the
 * character, so they belong inside a view of them, not crowded onto a 260px
 * tile in a grid of twelve.
 *
 * Two buttons on the card. Clicking it opens the sheet. Everything else lives
 * in the sheet, where there is room to see what you are doing.
 *
 * Set-based over four registries, because each fails independently: a sheet
 * that renders the official views and silently drops the palette looks finished
 * from a screenshot, and a card with two buttons whose six removed actions have
 * no home is not a simplification, it is a capability loss.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CS = require('../lib/character-sheet');
const { VIEW_RANK } = require('../lib/plate-views');
const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

/** A named function's body, comments stripped so prose does not satisfy a check. */
function bodyOf(name, src = SPA) {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return '';
    let depth = 0, j = src.indexOf('{', i), end = j;
    for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    return src.slice(i, end)
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/* ── the card ──────────────────────────────────────────────────────────── */

test('a character card has exactly two buttons', () => {
    const body = bodyOf('loadCharacters');
    assert.ok(body, 'loadCharacters is gone');

    // The action row, not the whole card: the plate has its own click handler
    // and the "+ gender & age" hint is a link, and neither is an action button.
    const row = body.match(/<div class="card-actions">([\s\S]*?)<\/div>/);
    assert.ok(row, 'no card-actions row to count');
    const labels = [...row[1].matchAll(/>([A-Za-z][A-Za-z ]{2,20})<\/button>/g)].map(m => m[1].trim());
    assert.deepEqual(labels, ['Edit', 'Delete'],
        `the card carries ${labels.length} buttons (${labels.join(', ')}); it should carry Edit and Delete`);
});

test('clicking the card opens the sheet', () => {
    const body = bodyOf('loadCharacters');
    assert.ok(/onclick="openCharacterSheet\(/.test(body),
        'the card is not clickable into the sheet — the eight buttons were the only way in');
    assert.ok(/function openCharacterSheet\(/.test(SPA), 'openCharacterSheet does not exist');
});

test('every action removed from the card has a home in the sheet', () => {
    /*
     * Removing a button is only a simplification if the thing it did is still
     * reachable. Six actions came off the card; each must be callable from the
     * sheet, or this is a capability loss wearing the word "simpler".
     */
    const sheet = bodyOf('renderCharacterSheet') + bodyOf('openCharacterSheet')
        + bodyOf('characterSheetHtml');
    for (const action of CS.RELOCATED_ACTIONS) {
        assert.ok(sheet.includes(action.fn),
            `'${action.label}' was taken off the card and ${action.fn}() is not reachable from the sheet`);
    }
    assert.ok(CS.RELOCATED_ACTIONS.length >= 5,
        'the relocation list is too short to be the real set');
});

/* ── the four official views ───────────────────────────────────────────── */

test('the sheet names four official views, and the plate ranking knows them', () => {
    assert.deepEqual(CS.OFFICIAL_VIEWS.map(v => v.id),
        ['front', 'side-left', 'side-right', 'back'],
        'the official views are not the four the design names, in turnaround order');

    // Every one must be a view the plate system can select by, or a generated
    // plate lands somewhere headlinePlate cannot find.
    for (const v of CS.OFFICIAL_VIEWS) {
        assert.ok(v.id in VIEW_RANK,
            `'${v.id}' is not in VIEW_RANK, so a plate generated for it can never be selected`);
        assert.ok(v.label && v.caption, `${v.id}: no label or caption for the plate`);
        assert.equal(typeof v.degrees, 'number', `${v.id}: no orbit angle`);
    }
});

test('the legacy "side" plate is not orphaned by the rename', () => {
    /*
     * VIEW_RANK shipped with `side`, and real projects have plates stored under
     * it. Introducing side-left/side-right without a rule would leave those
     * plates ranked but unreachable from the sheet — a picture that cost money,
     * on disk, that the new UI cannot show.
     */
    assert.ok('side' in VIEW_RANK, 'the legacy view name was deleted from the ranking');
    assert.equal(CS.canonicalView('side'), 'side-left',
        'an existing `side` plate does not map onto one of the four official views');
    assert.equal(CS.canonicalView('front'), 'front');
    assert.equal(CS.canonicalView('unknown-view'), null,
        'an unrecognised view was silently claimed as official');
});

test('views can be generated one at a time or all four', () => {
    const one = CS.viewPlan(['front']);
    assert.deepEqual(one.views, ['front']);
    const all = CS.viewPlan(null);
    assert.deepEqual(all.views, CS.OFFICIAL_VIEWS.map(v => v.id),
        'asking for everything does not produce all four');
    assert.equal(all.count, 4);
    // A view nobody declared is refused rather than generated into a name the
    // plate system cannot select by.
    assert.throws(() => CS.viewPlan(['diagonal']), /diagonal/);
});

/* ── the reference band ────────────────────────────────────────────────── */

test('references are filed under four categories', () => {
    assert.deepEqual(CS.REFERENCE_CATEGORIES.map(c => c.id),
        ['sketch', 'costume', 'face', 'mood'],
        'the reference categories are not the four the design names');
    for (const c of CS.REFERENCE_CATEGORIES) {
        assert.ok(c.label, `${c.id}: no label`);
        assert.ok(c.what && c.what.length > 12, `${c.id}: no description of what belongs in it`);
    }
});

test('a category is orthogonal to the gallery role, not a replacement for it', () => {
    /*
     * The gallery already answers "does this condition a frame" with
     * reference | concept | inspiration. A category answers a different
     * question — what the picture SHOWS. Collapsing them would mean a costume
     * study could not be starred, or a starred plate could not be a face study.
     */
    const G = require('../lib/subject-gallery');
    for (const c of CS.REFERENCE_CATEGORIES) {
        assert.ok(!G.ROLE_IDS.includes(c.id),
            `'${c.id}' collides with a gallery role; the two axes would overwrite each other`);
    }
    const meta = CS.categoryMetadata('face', { plate_role: 'concept' });
    assert.equal(meta.plate_role, 'concept', 'filing a category destroyed the role');
    assert.equal(meta.ref_category, 'face');
    assert.equal(CS.categoryOf({ metadata: { ref_category: 'mood' } }), 'mood');
    assert.equal(CS.categoryOf({ metadata: {} }), null,
        'an unfiled reference was claimed for a category it was never put in');
});

/* ── the sheet's regions ───────────────────────────────────────────────── */

test('every region of the design is rendered', () => {
    // Set-based over the regions, because a sheet that renders the plates and
    // silently drops the palette looks finished in a screenshot.
    const sheet = bodyOf('characterSheetHtml') + bodyOf('renderCharacterSheet');
    assert.ok(sheet.length > 400, 'the sheet renderer is missing or trivial');
    for (const region of CS.SHEET_REGIONS) {
        assert.ok(sheet.includes(region.anchor),
            `the '${region.id}' region (${region.what}) is not rendered — its anchor `
            + `'${region.anchor}' appears nowhere in the sheet`);
    }
    assert.equal(CS.SHEET_REGIONS.length, 6, 'the design names six regions');
});

test('the two header actions exist and are bound', () => {
    for (const action of ['generateOfficialViews', 'exportCharacterSheet']) {
        assert.ok(new RegExp(`function ${action}\\(`).test(SPA), `${action} does not exist`);
        assert.ok(new RegExp(`onclick="[^"]*\\b${action}\\(`).test(SPA),
            `${action}() is defined and nothing calls it — a handler wired to nothing looks `
            + 'identical to a working page until clicked');
    }
});

test('generating views asks which, and costs are stated before spending', () => {
    const body = bodyOf('generateOfficialViews');
    assert.ok(/confirm\(|showModal\(/.test(body),
        'the generate button spends with no confirmation');
    // All four, or a named one — the design asks for both.
    assert.ok(/OFFICIAL_VIEWS|all/i.test(body), 'there is no "generate all" path');
});

test('the PDF export is styled, not a screenshot of the dark UI', () => {
    /*
     * A sheet printed on the app's own black background wastes a cartridge and
     * reads badly. The export builds its own print document, the way the
     * screenplay export already does.
     */
    const body = bodyOf('exportCharacterSheet');
    assert.ok(/print|@page|window\.open|iframe/i.test(body),
        'the export does not build a print document');
    assert.ok(/@media print|@page|background:\s*#fff|color:\s*#000|white/i.test(body),
        'the export carries no print styling — it would print the dark UI');
});
