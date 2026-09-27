/**
 * A plate that is replaced is KEPT.
 *
 * Frames have been archived since the version store shipped, on the reasoning
 * that a generation is a coin flip you have already paid for. Plates were the
 * one paid artefact still being thrown away: regenerating one deleted the row
 * for that view and wrote the new picture over the same filename, inserting
 * the replacement at a hard-coded version 1. The column existed and never
 * moved.
 *
 * It matters more for a plate than for a frame. A frame is one shot; a plate
 * is what every frame of that subject is conditioned on.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reference-plates.js'), 'utf8');
/** The file with every comment removed, so a claim cannot be satisfied by prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('regenerating a plate no longer DELETES the row it replaces', () => {
    assert.ok(!/DELETE\s+FROM\s+film_assets/.test(CODE),
        'a plate generation still deletes the previous row — the attempt somebody paid for is gone '
        + 'from the ledger and the file is overwritten under it');
});

test('the archiver is real code, not a comment', () => {
    /*
     * Written after getting this exactly wrong: the function was inserted
     * inside an open comment block, `node --check` passed happily, and the
     * call would have thrown ReferenceError on the first plate anyone
     * generated. A syntax check cannot tell code from prose, so the test does.
     */
    assert.ok(/function supersedePlate\s*\(/.test(CODE), 'supersedePlate is not defined as code');
    assert.ok(/nextVersion\s*=\s*supersedePlate\s*\(/.test(CODE), 'nothing calls the archiver');
});

test('the incoming plate takes a NEW version, not a hard-coded 1', () => {
    // `version` existed on every plate row and was always 1, which is what
    // made "we have a versioning system" untrue for plates specifically.
    assert.ok(!/'png',\s*'image\/png',\s*1,/.test(CODE),
        'plates are still inserted at a hard-coded version 1');
    assert.ok(/nextVersion/.test(CODE), 'the insert does not carry a computed version');
});

test('a superseded plate can never be picked up as the reference', () => {
    /*
     * Keeping the row is only safe if it cannot be sent. `sendableSql()`
     * admits a row whose `plate_role` is null or 'reference'; an archived
     * plate is marked 'superseded', so the gather query cannot choose it —
     * which is what stops "the plate" quietly becoming two pictures.
     */
    const gallery = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subject-gallery.js'), 'utf8');
    assert.ok(/id:\s*'superseded'/.test(gallery), 'there is no superseded role to mark an old plate with');

    const { isSendable, ROLE_IDS } = require('../lib/subject-gallery');
    assert.ok(ROLE_IDS.includes('superseded'), 'the role is not declared');
    assert.strictEqual(
        isSendable({ metadata: JSON.stringify({ plate_role: 'superseded' }) }), false,
        'a superseded plate is still sendable, so an old look can condition a frame');
    assert.strictEqual(
        isSendable({ metadata: JSON.stringify({ plate_role: 'reference' }) }), true,
        'the approved plate stopped being sendable, which would strip conditioning from every frame');
});

test('the archive is best-effort and never fails a paid generation', () => {
    // The picture has already been generated and charged for by the time the
    // archiver runs. Losing it because a file copy failed would turn a
    // bookkeeping problem into a billing one.
    const fn = CODE.slice(CODE.indexOf('function supersedePlate'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body),
        'supersedePlate can throw, and it runs after the money is spent');
});

test('an exploration is not archived, because it replaces nothing', () => {
    // Explorations already keep every attempt — that is the point of them, and
    // why their filenames are unique. Running them through the archiver would
    // mark each new one as superseding the last.
    assert.ok(/if\s*\(!explore\)\s*\{[\s\S]{0,200}?supersedePlate/.test(CODE),
        'explorations are being put through the plate archiver');
});
