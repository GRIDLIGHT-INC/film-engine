/**
 * THE REMAINING CONSOLE REGIONS, EACH FED FROM REAL STATE.
 *
 * THE DENOMINATOR IS THE PENDING REGISTRY, not the task description. ICP-020
 * is written as "the Header bar, the Left rail, Camera Operate, the secondary
 * strip and the advanced strip" — five — and that list is wrong in two
 * directions: the Header bar has rendered since before Phase 4 began, and it
 * omits Spatial World and Blocking, which NOT_BUILT assigns to this task and
 * which no later task builds. Leaving those two would make the pending list
 * name a task that has finished, which its own rule calls a lie.
 *
 * So the set is every entry still in NOT_BUILT: six.
 *
 * THE HANDOFF SAYS IT TWICE — "All numeric data is demo data. Wire to real
 * state." Maple Street, Maya, the Dragon, 25.7m, COOKE S4, dp-agent v4. A
 * console wired to those renders perfectly in a screenshot and describes
 * nothing, which is how a home page once got half built and read as finished.
 * WE-2.5 already guards eight of those strings; this widens the guard to every
 * data value the design's own tables carry, and checks the harder half: that
 * an EMPTY project renders no numbers at all rather than plausible ones.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PROPOSAL_FIELDS } = require('../lib/cinematography');
const { UI, declSource, renderConsole } = require('./console-render');

const ROOT = path.join(__dirname, '..', '..');
const DESIGN = fs.readFileSync(
    path.join(ROOT, 'design_handoff_world_engine_previz', 'README.md'), 'utf8');
const PLACEMENT = fs.readFileSync(
    path.join(__dirname, 'previz-console-placement.test.js'), 'utf8');

const ALL_FLAGS = { world_engine: true, marble_generation: true, cinematography_ai: true,
                    reference_match: true, camera_explore: true, world_splats: true };

/** The regions still excused, read from the placement test's own registry. */
function stillPending() {
    const m = /const NOT_BUILT = \{([\s\S]*?)\n\};/.exec(PLACEMENT);
    assert.ok(m, 'the placement test no longer declares NOT_BUILT; re-derive this');
    return [...m[1].matchAll(/^\s*'([a-z-]+)'\s*:/gm)].map(x => x[1]);
}

/** Every region the design draws, and the column it states for each. */
const slug = (s) => s.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[—–-].*$/, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function designRegions() {
    const from = DESIGN.indexOf('## Screens / Views');
    const to = DESIGN.indexOf('## Interactions & Behavior');
    return DESIGN.slice(from, to).split('\n').filter(l => l.startsWith('### '))
        .map(l => l.slice(4).trim()).filter(h => !/^Screen:/.test(h))
        .map(h => ({ heading: h, slug: slug(h.replace(/^Modal:\s*/, '')) }));
}

/* ── 1 · every pending region now renders ───────────────────────────────── */

test('the set is the PENDING REGISTRY, and it is what this task must clear', () => {
    const pending = stillPending();
    const designed = new Set(designRegions().map(r => r.slug));
    for (const p of pending) {
        assert.ok(designed.has(p), `NOT_BUILT names "${p}", which the design does not draw`);
    }
    // A registry that has quietly emptied means this policing nothing.
    assert.deepStrictEqual(pending, [],
        `these regions the design draws still do not render: ${pending.join(', ')}`);
});

test('EVERY region carries a data-region anchor, so placement can find it', () => {
    /*
     * The mechanism the placement test relies on. A region rendered without
     * one is invisible to the column check — present on screen and unpoliced.
     */
    const html = renderConsole(ALL_FLAGS);
    const anchors = [...html.matchAll(/data-region="([a-z-]+)"/g)].map(m => m[1]);
    const designed = new Set(designRegions().map(r => r.slug));
    for (const a of anchors) {
        assert.ok(designed.has(a), `the console anchors "${a}", which the design does not draw`);
    }
    assert.ok(anchors.length >= 6,
        `only ${anchors.length} regions carry an anchor — the console is not built out`);
});

/* ── 2 · real state, and nothing invented ───────────────────────────────── */

/** Every value the design's own tables carry, as strings that must not ship. */
function demoValues() {
    const out = new Set(['Maple Street', 'WLD-031', 'dp-agent v4', 'COOKE S4', 'ALEXA 35',
                         'Maya', 'Dragon', 'Sedan', 'MOONLIGHT', 'LAMPS · CAR']);
    // Distances and spans the design writes into its asset labels.
    for (const m of DESIGN.matchAll(/\b\d+\.\d+m\b/g)) out.add(m[0]);
    for (const m of DESIGN.matchAll(/span \d+\.\d+m/g)) out.add(m[0]);
    return [...out];
}

test('no demo VALUE from the design ships in the console', () => {
    /*
     * WE-2.5 guards eight strings. This is every data value the design's
     * tables carry — the distances, the spans, the equipment names — because
     * the failure is one of them surviving, not all of them.
     */
    const CODE = UI.split('\n').filter(l => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
    const at = CODE.indexOf('function worldConsoleHtml');
    const consoleSrc = CODE.slice(at);
    const leaked = demoValues().filter(v => consoleSrc.includes(v));
    assert.deepStrictEqual(leaked, [],
        `demo data from the design shipped in the console: ${leaked.join(', ')}`);
});

test('an EMPTY project renders no numbers it was not given', () => {
    /*
     * The harder half, and the one a string ban cannot reach. A panel that
     * invents 1.55m for a camera nobody has placed shows a confident value
     * that is not the shot's — indistinguishable from a real one, and wrong
     * in every project that has not been blocked.
     */
    const html = renderConsole(ALL_FLAGS);
    for (const region of ['spatial-world', 'blocking', 'camera-operate']) {
        const at = html.indexOf(`data-region="${region}"`);
        assert.ok(at > -1, `${region} does not render`);
        const block = html.slice(at, at + 2600);
        // Metres and degrees are the units these panels speak in.
        const invented = [...block.matchAll(/(-?\d+\.\d+)\s*(m|°)\b/g)].map(m => m[0]);
        assert.deepStrictEqual(invented, [],
            `${region} shows ${invented.join(', ')} for a project with no world and no blocking`);
    }
});

test('a panel with nothing to show SAYS so, rather than rendering empty', () => {
    // An empty panel reads as broken; a panel that names what is missing is a
    // route to the work.
    const html = renderConsole(ALL_FLAGS);
    for (const region of ['spatial-world', 'blocking', 'left-rail']) {
        const at = html.indexOf(`data-region="${region}"`);
        const block = html.slice(at, at + 2600);
        assert.match(block, /no |not |yet|none/i,
            `${region} renders nothing and explains nothing when there is no data`);
    }
});

/* ── 3 · the left rail loads a shot, in place ───────────────────────────── */

test('clicking a shot loads its saved camera, its world pin and its move', () => {
    const src = declSource('worldRailSelect') || '';
    assert.ok(src, 'a shot in the rail cannot be selected');
    for (const [what, pattern] of [
        ['its saved blocking', /\/previs/],
        ['its world pin', /worldLoadForShot/],
    ]) {
        assert.match(src, pattern, `selecting a shot does not load ${what}`);
    }
    assert.ok(!/navigateTo/.test(src),
        'selecting a shot navigates away — the console is meant to update in place');
});

test('the rail is fed from the project\'s own shots', () => {
    const src = (declSource('worldRailHtml') || '') + (declSource('worldLoadShots') || '');
    assert.match(src, /shotlist|shots/,
        'the rail is not fed from the project\'s shots, so it shows whatever it was written with');
});

/* ── 4 · Camera Operate moves the camera through the ONE apply path ─────── */

test('EVERY axis Camera Operate offers is a field the proposal contract permits', () => {
    /*
     * Six nudges, and each is a PROPOSAL_FIELD — so a nudge travels the same
     * validated road as an intention and a coverage camera. An axis outside
     * the contract would be refused by the route after the director moved it,
     * which reads as the control being broken.
     */
    /*
     * EXECUTED, not grepped. The rows are generated from a registry, so the
     * field names appear nowhere as literals — demanding them would force the
     * page to carry a second copy of the axis list, which is the opposite of
     * what this wants. The same correction the comparison-axis check needed.
     */
    assert.ok(declSource('worldOperateHtml'), 'there is no Camera Operate panel');
    const src = renderConsole(ALL_FLAGS);
    const axes = [...src.matchAll(/worldNudge\('([A-Za-z]+)'/g)].map(m => m[1]);
    assert.ok(axes.length >= 6, `only ${axes.length} axes are offered; the design draws seven`);
    const outside = axes.filter(a => !PROPOSAL_FIELDS.includes(a));
    assert.deepStrictEqual(outside, [],
        `these axes are not in the proposal contract, so the route refuses them: ${outside.join(', ')}`);
});

test('a nudge goes through the directing route, not a private write', () => {
    const src = declSource('worldNudge') || '';
    assert.ok(src, 'nothing performs a nudge');
    assert.match(src, /\/direct/, 'a nudge does not go through the directing route');
    assert.ok(!/saveCamera|previs\/set/.test(src),
        'a nudge writes the camera by another path, bypassing the geometry checks');
});

/* ── 5 · the two strips, from the design's own tables ───────────────────── */

test('the secondary strip carries every panel the design names', () => {
    const at = DESIGN.indexOf('| Panel | Aside | Rows |');
    assert.ok(at > -1, 'the secondary-strip table is gone from the design');
    const panels = DESIGN.slice(at).split('\n\n')[0].split('\n')
        .filter(l => l.startsWith('| ') && !/^\| Panel|^\|---/.test(l))
        .map(l => l.split('|')[1].trim());
    assert.ok(panels.length >= 3, `the table scan found ${panels.length} panels — it is broken`);
    const html = renderConsole(ALL_FLAGS);
    const missing = panels.filter(p => !html.includes(p));
    assert.deepStrictEqual(missing, [], `the strip omits: ${missing.join(', ')}`);
});

test('the advanced strip carries every disclosure the design names', () => {
    const at = DESIGN.indexOf('| Chip | Revealed rows |');
    assert.ok(at > -1, 'the advanced-strip table is gone from the design');
    const chips = DESIGN.slice(at).split('\n\n')[0].split('\n')
        .filter(l => l.startsWith('| ') && !/^\| Chip|^\|---/.test(l))
        .map(l => l.split('|')[1].trim());
    assert.strictEqual(chips.length, 5, `the design draws five chips, the scan found ${chips.length}`);
    const html = renderConsole(ALL_FLAGS);
    const missing = chips.filter(c => !html.includes(c));
    assert.deepStrictEqual(missing, [], `the advanced strip omits: ${missing.join(', ')}`);
});

test('only one disclosure is open at a time', () => {
    // The design's rule. Two open at once is a four-column grid rendered twice
    // and a strip that is no longer collapsed.
    /*
     * BEHAVIOURAL. The first version matched `=\s*(...|null|key)`, which
     * accepts `WORLD.adv = key` — the exact mutation it was written to catch.
     * A pattern loose enough to match the bug is not a check.
     */
    const src = declSource('worldToggleAdvanced');
    assert.ok(src, 'the disclosures cannot be opened');
    const run = new Function(`
        const WORLD = { adv: null };
        const worldConsoleRender = () => {};
        ${src}
        worldToggleAdvanced('xyz');   const first = WORLD.adv;
        worldToggleAdvanced('focus'); const second = WORLD.adv;
        worldToggleAdvanced('focus'); const closed = WORLD.adv;
        return { first, second, closed };`)();
    assert.strictEqual(run.first, 'xyz', 'opening a disclosure does not open it');
    assert.strictEqual(run.second, 'focus',
        'opening a second disclosure leaves the first open — the strip is no longer collapsed');
    assert.strictEqual(run.closed, null,
        'a disclosure cannot be closed by pressing it again, so once open it stays open');
});

/* ── 6 · Blocking shows what is actually staged ─────────────────────────── */

test('blocking lists the shot\'s staged subjects, with the three representations', () => {
    const decl = declSource('worldBlockingHtml');
    assert.ok(decl, 'there is no Blocking panel');
    assert.match(decl, /subjects/,
        'the panel is not fed from the shot\'s staged subjects, so it shows whatever it invented');

    // Executed with a staged subject, because the representations are rendered
    // from a registry and appear nowhere as literals in the builder.
    const html = new Function(`
        const WORLD = { blocking: { blocking: { subjects: [{ name: 'FIGURE', height: 1.7 }] } } };
        const esc = v => String(v == null ? '' : v);
        ${declSource('BLOCKING_REPS')}
        ${declSource('weM')}
        ${decl}
        return worldBlockingHtml();`)();
    for (const rep of ['CARD', 'PROXY', 'MESH']) {
        assert.ok(html.includes(rep), `the ${rep} representation is not offered`);
    }
    assert.ok(html.includes('FIGURE'), 'a staged subject does not reach the panel');
});
