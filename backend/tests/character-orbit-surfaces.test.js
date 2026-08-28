/**
 * The orbit turnaround, reachable everywhere a plate already is.
 *
 * The pure core shipped unwired, which is the failure this codebase keeps
 * paying for under other names: a capability with no control is
 * indistinguishable from one that does not exist. An existing plate is
 * reachable four ways — an HTTP route, an MCP tool, a control on the page, and
 * a free preview before anything is spent — so the orbit has to be too, or it
 * is a library.
 *
 * Set-based over TWO registries:
 *   - the four surfaces, derived from how the existing refsheet capability is
 *     reachable, because a capability wired to three of four reads as done;
 *   - the four ORBIT_VIEWS, because a sheet with a good front and a mislabelled
 *     back is exactly the state the old three-plate path was already in.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(__dirname, '../routes/characters.js'), 'utf8');
const orbit = require('../lib/character-orbit');
const { listTools } = require('../lib/mcp-tools');
const { VIEW_RANK, orderByViewSql } = require('../lib/plate-views');

/* ── the four surfaces ───────────────────────────────────────────────── */

test('the route accepts an orbit, and a FREE preview of it', () => {
    assert.match(ROUTE, /return generateOrbit\s*\(/,
        'no orbit POST dispatch — the capability is unreachable over HTTP');
    assert.match(ROUTE, /function generateOrbit\s*\(/, 'generateOrbit is dispatched and undefined');
    assert.match(ROUTE, /orbitPlan|character-orbit/,
        'the route does not use the orbit planner, so it cannot say what it will cost');
});

test('nothing spends without a free preview first', () => {
    // Every paid path in this engine goes through one confirmation built from
    // a preview that costs nothing. An orbit spends credits; it needs the same.
    // Bound to the orbit's OWN handler: "preview" appears elsewhere in this
    // file, so a file-wide match passed before the orbit had one at all.
    const i = ROUTE.indexOf('function previewOrbit(');
    assert.ok(i > 0, 'there is no previewOrbit — the orbit cannot be costed before it is bought');
    let depth = 0, j = ROUTE.indexOf('{', i), end = j;
    for (; j < ROUTE.length; j++) {
        if (ROUTE[j] === '{') depth++;
        else if (ROUTE[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const body = ROUTE.slice(i, end);
    assert.match(body, /orbitPlan\s*\(/, 'the preview does not price the plan it previews');
    assert.match(body, /nothing was spent/i, 'the preview does not say it spends nothing');
    assert.match(ROUTE, /return previewOrbit\s*\(/,
        'previewOrbit exists and nothing dispatches to it');
});

test('an agent can run it — this pipeline is driven from an agent host', () => {
    const names = listTools().map(t => t.name);
    // The generating tool specifically: a preview tool alone would satisfy a
    // /orbit/ match while leaving an agent unable to actually make the sheet.
    assert.ok(names.includes('refsheet_orbit'),
        `no refsheet_orbit among ${names.length} tools — an agent building a cast cannot make a sheet`);
    assert.ok(names.includes('refsheet_orbit_preview'), 'no free preview for an agent');
    const t = listTools().find(x => x.name === 'refsheet_orbit');
    assert.match(String(t.description), /turnaround|orbit|character sheet/i);
    assert.match(String(t.description), /credit|cost|\$|spend/i,
        'the tool does not say it spends money');
});

test('the page offers it where plates are already generated', () => {
    assert.match(SPA, /orbitRefsheet|refsheetOrbit/,
        'no control on the character surface runs an orbit');
    // Anchored on the BUTTON, not the first occurrence of its label — the
    // string "Regen Image" appears first in a CSS comment, so indexOf found
    // prose and the assertion was about the wrong place in the file.
    const i = SPA.indexOf("onclick=\"event.stopPropagation(); generateCharacterImage(");
    assert.ok(i > 0, 'the existing plate control moved');
    assert.match(SPA.slice(i, i + 700), /orbitRefsheet/,
        'the orbit control is not beside the plate control it is an alternative to');
});

/* ── the four views ──────────────────────────────────────────────────── */

test('every orbit view is stored under a name plate selection understands', () => {
    for (const v of orbit.ORBIT_VIEWS) {
        assert.ok(Object.prototype.hasOwnProperty.call(VIEW_RANK, v.view),
            `"${v.view}" is not in VIEW_RANK — headlinePlate could never choose it`);
    }
    // and the route must write the view, or every frame lands as the same one
    assert.match(ROUTE, /\$\.view|'\$\.view'|view:/,
        'the route does not record which view a frame is');
});

test('a re-run replaces each view rather than accumulating duplicates', () => {
    // Regenerating wrote a NEW row for the same file once already: six entries
    // for three pictures, and "the plate" became whichever the query returned.
    // Bound to generateOrbit: the still-plate path has this same clause, so a
    // file-wide match passed while the orbit had no scoping at all.
    const i = ROUTE.indexOf('async function generateOrbit(');
    assert.ok(i > 0, 'generateOrbit not found');
    let depth = 0, j = ROUTE.indexOf('{', i), end = j;
    for (; j < ROUTE.length; j++) {
        if (ROUTE[j] === '{') depth++;
        else if (ROUTE[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const body = ROUTE.slice(i, end);
    assert.match(body, /json_extract\(metadata, '\$\.view'\) = \?/,
        'the orbit does not scope its replacement to the view, so re-running duplicates rows');
    assert.match(body, /frame\.view/, 'the orbit does not record which view each frame is');
});

test('selection still ranks front first after an orbit', () => {
    assert.match(orderByViewSql(), /CASE/i);
    assert.strictEqual(VIEW_RANK.front, 0,
        'front is no longer the identity view — the orbit would attach the wrong frame');
});

/* ── and it must not spend without saying what it costs ──────────────── */

test('the plan the route prices is the plan it runs', () => {
    // One planner, so the number in the confirmation is the number charged.
    const plan = orbit.orbitPlan({ seconds: 5 });
    assert.strictEqual(plan.credits, 25);
    assert.strictEqual(plan.frames.length, orbit.ORBIT_VIEWS.length);
    assert.ok(plan.saving > 0, 'the plan no longer beats three separate plates');
});
