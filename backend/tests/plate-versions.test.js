/**
 * A plate that is replaced is KEPT — and what is kept is the OLD PICTURE.
 *
 * Frames have been archived since the version store shipped, on the reasoning
 * that a generation is a coin flip you have already paid for. Plates were the
 * one paid artefact still being thrown away: regenerating one deleted the row
 * for that view and wrote the new picture over the same filename, inserting
 * the replacement at a hard-coded version 1.
 *
 * The first attempt at fixing that kept the row and archived the file — but it
 * archived AFTER the replacement had already been written over the name, so
 * every `versions/{name}_v{n}.png` it produced was a second copy of the new
 * picture. A version store that keeps the ledger and loses the bytes is worse
 * than none, because it reports success. Hence the split: `stashPriorPlate`
 * runs before the write and touches only the disk, `commitPriorPlate` runs
 * after and touches only the ledger.
 *
 * It matters more for a plate than for a frame. A frame is one shot; a plate
 * is what every frame of that subject is conditioned on.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'reference-plates.js');
const SRC = fs.readFileSync(LIB, 'utf8');
/** The file with every comment removed, so a claim cannot be satisfied by prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const plates = require('../lib/reference-plates');
const { stashPriorPlate, commitPriorPlate } = plates;

/* ── the shape of the fix ─────────────────────────────────────────────── */

test('regenerating a plate no longer DELETES the row it replaces', () => {
    assert.ok(!/DELETE\s+FROM\s+film_assets/.test(CODE),
        'a plate generation still deletes the previous row — the attempt somebody paid for is gone '
        + 'from the ledger and the file is overwritten under it');
});

test('both halves of the archiver are real code, not comments', () => {
    assert.ok(/function stashPriorPlate\s*\(/.test(CODE), 'stashPriorPlate is not defined as code');
    assert.ok(/function commitPriorPlate\s*\(/.test(CODE), 'commitPriorPlate is not defined as code');
    assert.equal(typeof stashPriorPlate, 'function', 'stashPriorPlate is not exported');
    assert.equal(typeof commitPriorPlate, 'function', 'commitPriorPlate is not exported');
});

test('THE ORDERING: the stash happens before the file is written, the commit after', () => {
    // Inside generatePlate only: supersedePlate's one-call wrapper mentions
    // both halves too, and it sits above this in the file.
    const BODY = CODE.slice(CODE.indexOf('async function generatePlate'));
    const stash = BODY.indexOf('stashPriorPlate(projectId, subject, spec, fileName)');
    const write = BODY.indexOf('await persistProviderMedia(projectId, spec.subdir, fileName');
    const commit = BODY.indexOf('nextVersion = commitPriorPlate(stash)');
    assert.ok(stash > 0 && write > 0 && commit > 0, 'one of the three steps is missing from generatePlate');
    assert.ok(stash < write,
        'the plate is archived AFTER the replacement is written over it, so the archived copy is the '
        + 'new picture and the old one is gone');
    assert.ok(write < commit,
        'the ledger is moved before the replacement is known to exist — a failed generation would leave '
        + 'every plate marked superseded with nothing standing in for them');
});

test('the incoming plate takes a NEW version, not a hard-coded 1', () => {
    assert.ok(!/'png',\s*'image\/png',\s*1,/.test(CODE),
        'the plate insert still hard-codes version 1');
    assert.ok(/nextVersion/.test(CODE), 'the insert does not carry a computed version');
});

test('a superseded plate can never be picked up as the reference', () => {
    const gallery = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subject-gallery.js'), 'utf8');
    assert.ok(/id:\s*'superseded'/.test(gallery), 'there is no superseded role to mark an old plate with');
    const role = gallery.slice(gallery.indexOf("id: 'superseded'"));
    assert.ok(/reaches_generation:\s*false/.test(role.slice(0, 600)),
        'a superseded plate still reaches generation');
});

test('neither half fails a paid generation', () => {
    for (const name of ['stashPriorPlate', 'commitPriorPlate']) {
        const body = CODE.slice(CODE.indexOf(`function ${name}`));
        const fn = body.slice(0, body.indexOf('\nfunction '));
        assert.ok(/try\s*\{/.test(fn) && /catch/.test(fn),
            `${name} can throw, and it runs around money that is already spent`);
    }
});

test('an exploration is not archived, because it replaces nothing', () => {
    assert.ok(/explore\s*\?\s*null\s*:\s*stashPriorPlate/.test(CODE),
        'an exploration stashes a plate it is not replacing');
});

/* ── what it actually does to the bytes ───────────────────────────────── */

test('the archived copy is the OLD picture, not the one that replaced it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-ver-'));
    const fileName = 'character_MANNY_front.png';
    const live = path.join(dir, fileName);
    fs.writeFileSync(live, 'THE OLD PLATE');

    // The row as the ledger holds it, handed in directly so the test needs no
    // database — the same door the orbit turnaround uses.
    const rows = [{ id: 'row-1', version: 1, file_path: live, file_name: fileName, metadata: '{}' }];
    const stash = stashPriorPlate('proj', { id: 'subj' },
        { fkColumn: 'character_id', assetType: 'character_sheet' }, fileName, { rows });

    // Now the replacement lands on the same name, exactly as the real write does.
    fs.writeFileSync(live, 'THE NEW PLATE');

    assert.ok(stash, 'nothing was stashed');
    assert.equal(stash.moved.length, 1, 'the live plate was not copied aside');
    const archived = stash.moved[0].dest;
    assert.equal(path.basename(archived), 'character_MANNY_front_v1.png');
    assert.equal(fs.readFileSync(archived, 'utf8'), 'THE OLD PLATE',
        'the archived version is a copy of the picture that REPLACED it — the old one is gone');
    assert.equal(fs.readFileSync(live, 'utf8'), 'THE NEW PLATE',
        'the live filename no longer holds the new plate');
    assert.equal(stash.version, 2, 'the incoming plate does not take the next version');
});

test('a second regeneration keeps both earlier attempts under their own names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-ver-'));
    const fileName = 'location_DINER.png';
    const live = path.join(dir, fileName);

    fs.writeFileSync(live, 'v1');
    const first = stashPriorPlate('p', { id: 's' }, { fkColumn: 'location_id', assetType: 'reference_image' },
        fileName, { rows: [{ id: 'a', version: 1, file_path: live, file_name: fileName, metadata: '{}' }] });
    fs.writeFileSync(live, 'v2');

    // The v1 row now points at its archived copy and is marked superseded, so
    // the next stash sees it as already archived and leaves it alone.
    const second = stashPriorPlate('p', { id: 's' }, { fkColumn: 'location_id', assetType: 'reference_image' },
        fileName, { rows: [
            { id: 'a', version: 1, file_path: first.moved[0].dest, file_name: first.moved[0].file_name,
                metadata: JSON.stringify({ plate_role: 'superseded' }) },
            { id: 'b', version: 2, file_path: live, file_name: fileName, metadata: '{}' },
        ] });
    fs.writeFileSync(live, 'v3');

    assert.equal(fs.readFileSync(first.moved[0].dest, 'utf8'), 'v1', 'v1 was overwritten by a later archive');
    assert.equal(second.moved.length, 1, 'the already-archived version was copied a second time');
    assert.equal(fs.readFileSync(second.moved[0].dest, 'utf8'), 'v2');
    assert.equal(second.version, 3);
    assert.equal(fs.readFileSync(live, 'utf8'), 'v3');
});

test('a stash of nothing is not an error', () => {
    assert.equal(stashPriorPlate('p', { id: 's' },
        { fkColumn: 'location_id', assetType: 'reference_image' }, 'nope.png', { rows: [] }), null);
    assert.equal(commitPriorPlate(null), 1, 'a first plate must take version 1');
});

/* ── the paths that used to be outside the version store ──────────────── */

test('the orbit turnaround supersedes its plates instead of deleting them', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'characters.js'), 'utf8');
    const orbit = src.slice(src.indexOf('const scratchPath = filePath'));
    const block = orbit.slice(0, orbit.indexOf('return json(res, 200, {'));
    assert.ok(!/DELETE FROM film_assets/.test(block.replace(/\/\*[\s\S]*?\*\//g, '')),
        'the turnaround still deletes the plate it replaces — this is the path the MANNY plates came through');
    assert.ok(/stashPriorPlate\(/.test(block) && /commitPriorPlate\(/.test(block),
        'the turnaround does not archive the plate it replaces');
    assert.ok(block.indexOf('stashPriorPlate(') < block.indexOf('renameSync(scratchPath, filePath)'),
        'the cut is moved into place before the plate under it is rescued');
});

test('a refine supersedes the plate it sharpens', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8');
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const refine = bare.slice(bare.indexOf('const saved = await persistProviderMedia(project.id, spec.subdir'));
    const block = refine.slice(0, 900);
    assert.ok(!/DELETE FROM film_assets WHERE id = \?'\)\.run\(existing\.id\)/.test(bare),
        'a refine still deletes the plate it was asked to improve');
    assert.ok(/commitPriorPlate\(stash\)/.test(block), 'a refine does not archive the plate it replaces');
    assert.ok(bare.indexOf('stashPriorPlate(project.id, subject, spec, fileName)')
        < bare.indexOf('const saved = await persistProviderMedia(project.id, spec.subdir'),
        'the refine writes over the plate before rescuing it');
});

test('deleting a plate view keeps the bytes, on every subject kind', () => {
    for (const file of ['characters.js', 'locations.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
        assert.ok(/'deleted'\)/.test(src) || /'deleted'\s*\)/.test(src),
            `${file} deletes a plate's file outright instead of moving it aside`);
        assert.ok(!/fs\.unlinkSync\(r\.file_path\)/.test(src),
            `${file} still unlinks a deleted plate`);
    }
});
