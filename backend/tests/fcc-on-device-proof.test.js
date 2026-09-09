/**
 * PROVE IT ON THE PHONE — GRD-3812 / FCC-016.
 *
 * "Shoot in each format, on the real device, with every control exercised.
 * Record device, iOS version, formats, file sizes and how each travelled. A
 * simulator cannot do this."
 *
 * THIS IS THE ONE TASK IN THE EPIC AN AGENT CANNOT FINISH, and saying so is the
 * task rather than an excuse: a simulator has no camera, no motion hardware and
 * delivers no frames. What CAN be done from here is everything that makes the
 * session succeed first time instead of discovering a blocker on location —
 * which is exactly what `plate-camera-on-device-proof.md` did for the previous
 * epic's PCC-012.
 *
 * WHAT MEASURING THE MACHINE FOUND, AND IT CHANGES THE BRIEF'S CONCLUSION. The
 * paired phone is an **iPhone 17 Pro on iOS 26.6.1**, signing is configured and
 * valid, and the only thing between the build and the device is that the phone
 * is LOCKED. The brief still says "this project's device is a 15 Pro Max" and
 * names the hardware tier as one of the two things that genuinely BLOCK parity
 * — and a test asserts that phrase, so the document is pinned to a fact that is
 * no longer true. ProRes RAW, Apple Log 2 and open gate are reachable on this
 * hardware. A record whose subject changed is the same failure FCC-015 spent a
 * task removing, and it lands squarely inside this one's sentence: "Record
 * device, iOS version".
 *
 * SET-BASED OVER THE REGISTRIES THE SHOOT MUST COVER, because a proof sheet
 * with a hole in it produces a shoot with a hole in it — and the whole cost of
 * this task is a person standing somewhere with a phone:
 *
 *   1. `MODES` — 10. A format missing from the sheet is one nobody shoots, and
 *      nobody finds out until the epic is called done.
 *   2. `CAPABILITIES` — 3. This is the first hardware that can exercise all
 *      three, so leaving one out wastes the only opportunity.
 *   3. `TRANSPORTS` — 2. "How each travelled" is half the evidence asked for.
 *
 * AND THE SHEET MAY NOT CLAIM THE SHOOT HAPPENED. Every row starts as not-yet-
 * shot, and a document that reads as complete while nothing was recorded is
 * worse than no document: it is the acceptance evidence for an epic, and
 * somebody will believe it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHEET = path.join(ROOT, 'docs', 'plans', 'fcc-camera-on-device-proof.md');
const BRIEF = path.join(ROOT, 'docs', 'plans', 'final-cut-camera-parity-brief.md');

const policy = require('../lib/capture-policy');
const { MODES, CAPABILITIES, TRANSPORTS } = policy;

const sheet = () => fs.readFileSync(SHEET, 'utf8');

/* ------------------------------------------------------------------ *
 * SET 1 — nothing to shoot is missing from the sheet                  *
 * ------------------------------------------------------------------ */

test('the registries are real, or every assertion below passes over nothing', () => {
    assert.ok(Object.keys(MODES).length >= 10, `only ${Object.keys(MODES).length} modes`);
    assert.ok(Object.keys(CAPABILITIES).length >= 3, `only ${Object.keys(CAPABILITIES).length} capabilities`);
    assert.ok(Object.keys(TRANSPORTS).length >= 2, `only ${Object.keys(TRANSPORTS).length} transports`);
    assert.ok(fs.existsSync(SHEET),
        'there is no on-device proof sheet, so the one task an agent cannot finish has nothing '
        + 'prepared and the session discovers its blockers on location');
});

test('EVERY format the camera can record is in the shoot list', () => {
    /*
     * Derived from the registry rather than typed, so a mode added later is in
     * the list with nothing to remember. The whole cost of this task is a
     * person standing somewhere with a phone; a format missing from the sheet
     * is a second trip.
     */
    const d = sheet();
    const missing = Object.keys(MODES).filter((id) => !d.includes(id));
    assert.deepStrictEqual(missing, [],
        `the sheet does not name these formats, so nobody shoots them: ${missing.join(', ')}`);
});

test('EVERY format states what it costs and how it would travel', () => {
    /*
     * "Formats, file sizes and how each travelled" is the evidence the task
     * asks for. A list of names is a list; the numbers are what makes a
     * measured file size checkable against what the engine predicted.
     */
    const d = sheet();
    const wrong = [];
    for (const [id, m] of Object.entries(MODES)) {
        const perMin = Math.round(m.bytes_per_second * 60 / 1048576);
        if (!d.includes(String(perMin))) {
            wrong.push(`${id}: the sheet does not state its ${perMin}MB/min, so a measured file `
                + 'size cannot be checked against what the budget predicted');
        }
        const transport = (m.transports || [])[0];
        if (transport && !d.includes(transport)) wrong.push(`${id}: does not say it travels by ${transport}`);
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('EVERY hardware capability is in the list, because this phone can finally reach them', () => {
    /*
     * The 17 Pro is the first hardware here that can exercise Apple Log 2,
     * ProRes RAW and open gate. Leaving one out of the sheet wastes the only
     * opportunity the epic has had to prove FCC-008 by execution rather than
     * by structure.
     */
    const d = sheet();
    const missing = Object.entries(CAPABILITIES)
        .filter(([id, c]) => !d.includes(id) && !d.includes(c.label))
        .map(([id]) => id);
    assert.deepStrictEqual(missing, [], `the sheet never asks anyone to test: ${missing.join(', ')}`);
});

test('EVERY transport is exercised, since "how each travelled" is half the evidence', () => {
    const d = sheet();
    const missing = Object.keys(TRANSPORTS).filter((t) => !d.includes(t));
    assert.deepStrictEqual(missing, [], `the sheet does not exercise: ${missing.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 2 — the sheet records the device, and does not lie about it     *
 * ------------------------------------------------------------------ */

test('the sheet records the device and the iOS version it was measured on', () => {
    const d = sheet();
    assert.match(d, /iPhone 17 Pro/,
        'the sheet does not name the device, which is the first thing the task asks to record');
    assert.match(d, /26\.6\.1/,
        'the sheet does not name the iOS version, so a capability that is missing cannot be told '
        + 'from one the OS has not shipped yet');
    assert.match(d, /00008150-000908DC1188401C|ACE6174C/,
        'the sheet does not carry the device identifier, so nobody can tell whether a later run '
        + 'was the same phone');
});

test('NO document still claims this project has a device it does not have', () => {
    /*
     * The brief said "this project's device is a 15 Pro Max" and named the
     * hardware tier as one of two things that genuinely BLOCK parity — and a
     * test asserted that phrase, so the document was pinned to a fact that had
     * stopped being true. Four features it calls unreachable are reachable on
     * the phone that is actually paired.
     *
     * This is the same failure FCC-015 spent a task removing, one level up: not
     * a claim about the code that went stale, but a claim about the WORLD. It
     * is inside this task's own sentence — "Record device, iOS version".
     */
    const docs = ['final-cut-camera-parity-brief.md', 'fcc-parity-epic.md'];
    const wrong = [];
    for (const name of docs) {
        const p = path.join(ROOT, 'docs', 'plans', name);
        if (!fs.existsSync(p)) continue;
        const text = fs.readFileSync(p, 'utf8');
        /*
         * The DESIGN sentence is fine and must survive: "gated on the device
         * reporting the capability, so a 15 Pro Max degrades with a reason" is
         * a true statement about the rule, on any phone. What must not survive
         * is the claim that a 15 Pro Max is what this project HAS.
         */
        for (const m of text.matchAll(/[^.\n]*15 Pro Max[^.\n]*/g)) {
            if (/this project's device is|our device is|the device (we|this project) ha/i.test(m[0])) {
                wrong.push(`${name}: "${m[0].trim().slice(0, 90)}"`);
            }
        }
    }
    assert.deepStrictEqual(wrong, [],
        'a document still states a device this project does not have, and the hardware tier it '
        + `calls unreachable is reachable on the phone that is paired:\n  ${wrong.join('\n  ')}`);
});

test('the brief says which hardware the tier needs, and that this project HAS it', () => {
    const d = fs.readFileSync(BRIEF, 'utf8');
    for (const feature of ['ProRes RAW', 'Log 2', 'open gate', 'genlock']) {
        assert.ok(d.includes(feature), `the brief never mentions ${feature}`);
    }
    assert.match(d, /17 Pro/, 'the brief does not say which hardware those need');
    assert.ok(/17 Pro/.test(d) && !/this project's device is a 15 Pro Max/.test(d),
        'the brief still names a 15 Pro Max as this project\'s device, so it reports four '
        + 'reachable features as blocked');
});

/* ------------------------------------------------------------------ *
 * SET 3 — the sheet must not claim a shoot that has not happened      *
 * ------------------------------------------------------------------ */

test('the sheet states plainly that nothing has been shot yet', () => {
    /*
     * This is the acceptance evidence for a sixteen-task epic. A document that
     * reads as complete while every row is empty is worse than no document,
     * because somebody will believe it — and the one thing this task exists to
     * produce is a record that can be trusted.
     */
    const d = sheet();
    assert.match(d, /not (yet )?shot|NOT YET|nothing has been shot|unshot/i,
        'the sheet does not say that the shoot has not happened, so it reads as evidence of a '
        + 'session nobody has run');
    assert.ok(!/all formats verified|proven on the phone|shoot complete/i.test(d),
        'the sheet claims a shoot that has not happened');
});

test('the sheet names what BLOCKS the shoot, precisely enough to act on', () => {
    /*
     * "No hardware" would be wrong and would send somebody looking for a phone.
     * The phone is here, paired, and signing resolves — what stops the build
     * reaching it is that the device is locked, and what stops the shoot is
     * that somebody has to hold it. A blocker that names the wrong thing costs
     * the trip it was meant to save.
     */
    const d = sheet();
    /*
     * BOUND TO THE DEVICE'S RECORDED STATE, and it took two goes.
     *
     * `/lock/` matches inside "blocked", "blocker" and "blocks", which this
     * sheet says constantly — so the first version passed after every mention
     * of the lock was rewritten. Adding a word boundary was not enough either:
     * the sheet legitimately says "Lock exposure" and "LOCK HELD" about the
     * FCC-004 control, which is a completely different sense of the word and
     * satisfied a check about the phone.
     *
     * The fact the task asks to record is the device's STATE, so that is what
     * is asserted. Third and fourth time this epic has paid for a match that
     * was looser than the claim: `capture` inside `world-capture`,
     * `RecordingTransport` inside a rename, and now both of these.
     */
    assert.match(d, /\|\s*State\s*\|[^|]*lock/i,
        'the sheet does not record the device as locked, which is the first thing that stops the '
        + 'build reaching it — and a blocker that names the wrong thing costs the trip it was '
        + 'meant to save');
    assert.match(d, /sign(ing|ed)/i,
        'the sheet does not record that signing is configured, so the next reader re-investigates '
        + 'a wall that is not there');
    assert.ok(/person|somebody|by hand|holding/i.test(d),
        'the sheet does not say a person is required, which is the actual blocker');
});

test('the sheet lists the controls the epic built, so every one is exercised', () => {
    /*
     * "With every control exercised" — derived from the tasks the epic declares
     * rather than from memory, so a control built later is on the list. The
     * denominator is the epic's own task table, the same one FCC-015 made the
     * claims answer to.
     */
    const epic = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'fcc-parity-epic.md'), 'utf8');
    const tasks = [...epic.matchAll(/^\|\s*(FCC-\d{3})\s*\|/gm)].map((m) => m[1]);
    assert.ok(tasks.length >= 16, `only ${tasks.length} tasks parsed; the table read is broken`);

    const d = sheet();
    // FCC-015 and FCC-016 build nothing a hand can exercise — the claim
    // registry and this document itself.
    const NOTHING_TO_SHOOT = new Set(['FCC-015', 'FCC-016']);
    const missing = tasks.filter((t) => !NOTHING_TO_SHOOT.has(t) && !d.includes(t));
    assert.deepStrictEqual(missing, [],
        `the sheet asks nobody to exercise what these tasks built: ${missing.join(', ')}`);
});
