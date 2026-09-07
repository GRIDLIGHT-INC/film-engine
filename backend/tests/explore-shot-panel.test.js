/**
 * EXPLORE SHOT — six cameras in one world, and a comparison of two of them.
 *
 * Two registries define this surface and both come from lib/cinematography.js:
 *
 *   EXPLORE_CATEGORIES — 6 coverage categories, A..F. A tile missing for one
 *                        is a way of covering the scene a director cannot see.
 *   COMPARE_AXES       — 5 axes. A comparison showing four of them is worse
 *                        than none: it reads as complete and the axis that
 *                        would have decided it is the one that is absent.
 *
 * `compareCameras` HAS NEVER BEEN CALLED. It is written, exported, tested in
 * isolation and reachable from nowhere — the declared-and-unread shape this
 * codebase has paid for under five other names. A comparison the page computes
 * for itself would be a second implementation of it, which is how the two come
 * to disagree about what "distance" means.
 *
 * AND THE DESIGN'S TILE TABLE IS DEMO DATA, exactly as the Direct the Shot one
 * was: six rows carrying a lens, a height and a tilt. Baking them in gives
 * every film the same six cameras and looks like it works.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { EXPLORE_CATEGORIES, COMPARE_AXES, compareCameras } = require('../lib/cinematography');
const { UI, declSource, renderConsole } = require('./console-render');

const ROOT = path.join(__dirname, '..', '..');
const DESIGN = fs.readFileSync(
    path.join(ROOT, 'design_handoff_world_engine_previz', 'README.md'), 'utf8');
const WORLDS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'worlds.js'), 'utf8');

const ALL_FLAGS = { world_engine: true, marble_generation: true, cinematography_ai: true,
                    reference_match: true, camera_explore: true, world_splats: true };

const panel = () => {
    const src = declSource('worldExplorePanelHtml');
    assert.ok(src, 'there is no Explore Shot panel builder');
    return src;
};

/** Everything the feature is made of, so a scan is never bounded to one function. */
function featureSource() {
    return ['worldExplorePanelHtml', 'worldExploreTilesHtml', 'worldExploreBrief', 'worldExploreAccept',
            'worldExploreLoad', 'worldExploreToggleCompare', 'worldExplorePick', 'worldExploreCompare',
            'worldExploreShow', 'worldExploreCandidates']
        .map(n => declSource(n) || '').join('\n');
}

/* ── 1 · the six tiles ──────────────────────────────────────────────────── */

test('EVERY coverage category the engine declares has a tile', () => {
    const html = renderConsole(ALL_FLAGS);
    assert.strictEqual(EXPLORE_CATEGORIES.length, 6, 'the design draws six; re-derive this');
    const missing = EXPLORE_CATEGORIES.filter(c => !html.includes(c.name));
    assert.deepStrictEqual(missing.map(c => c.key), [],
        `these coverage options cannot be seen: ${missing.map(c => `${c.key} ${c.name}`).join(', ')}`);
});

test('each tile carries its KEY and its storytelling intent, not just a name', () => {
    /*
     * "Heroic Low" without "Power / dominance" is a label. The intent line is
     * what makes six tiles a set of choices rather than six spec sheets.
     */
    const html = renderConsole(ALL_FLAGS);
    const bare = EXPLORE_CATEGORIES.filter(c => !html.includes(c.intent));
    assert.deepStrictEqual(bare.map(c => c.key), [],
        `these tiles show no intent line: ${bare.map(c => c.key).join(', ')}`);
    for (const c of EXPLORE_CATEGORIES) {
        assert.ok(new RegExp(`>\\s*${c.key}\\s*<`).test(html), `tile ${c.key} carries no key badge`);
    }
});

test('the design\'s demo camera values are NOT baked into the page', () => {
    /*
     * The same trap Direct the Shot carried, and the same detector: the three
     * numbers of a row appearing together IS the formula. Scanned over the
     * whole page with comments stripped — a scan bounded to the panel builder
     * missed the equivalent mutation last time, and the widened one then
     * matched its own warning comment.
     */
    const at = DESIGN.indexOf('| Key | Name | Intent line |');
    assert.ok(at > -1, 'the tile table is gone from the design; re-derive this test');
    const rows = DESIGN.slice(at).split('\n\n')[0].split('\n')
        .filter(l => l.startsWith('| ') && !/^\| Key|^\|---/.test(l))
        .map(l => l.split('|').map(c => c.trim()));
    assert.ok(rows.length >= 6, `the tile table scan found ${rows.length} rows — it is broken`);

    const CODE = UI.split('\n').filter(l => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
    const baked = [];
    for (const cells of rows) {
        // lens, height, tilt — columns 4, 5, 6 of the design's own table.
        const nums = [cells[4], cells[5], cells[6]]
            .map(v => (String(v).match(/-?\d+\.?\d*/) || [])[0]).filter(Boolean);
        if (nums.length < 3) continue;
        const spots = nums.map(n =>
            [...CODE.matchAll(new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?![\\d.])`, 'g'))]
                .map(m => m.index));
        if (spots.some(l => !l.length)) continue;
        if (spots[0].some(a => spots[1].some(b => Math.abs(a - b) < 200)
                            && spots[2].some(c => Math.abs(a - c) < 200))) {
            baked.push(`${cells[1]} ${cells[2]}: ${nums.join(' / ')}`);
        }
    }
    assert.deepStrictEqual(baked, [],
        'the page carries the design\'s demo cameras, so Explore proposes rather than asking:\n  '
        + baked.join('\n  '));
});

/* ── 2 · the brief and the candidates go through the route ──────────────── */

test('the explore brief is FETCHED, and it is free', () => {
    const src = featureSource();
    assert.match(src, /\/direct\/explore/,
        'nothing asks the engine for the explore brief, so the categories shown are the page\'s own');
    const brief = declSource('worldExploreBrief') || '';
    assert.ok(!/method:\s*'POST'/.test(brief), 'reading the brief POSTs — it is meant to be free');
});

test('candidates are VALIDATED by the route, never accepted by the page', () => {
    const src = declSource('worldExploreAccept') || '';
    assert.ok(src, 'nothing sends candidates to be validated');
    assert.match(src, /method:\s*'POST'/, 'candidates are not POSTed');
    assert.match(src, /\/direct\/explore/, 'candidates do not go to the explore route');
    // The route decides; the page must not filter first.
    assert.ok(!/validateCamera|ADVISORY/.test(src),
        'the page filters candidates itself, so a camera the engine would reject can still be shown');
});

test('a candidate that cannot be shot is NAMED, with its reason', async () => {
    /*
     * BEHAVIOURAL, end to end, and it had to become so. The first version
     * grepped the feature for "rejected", "failures" and "shortfall" — words
     * that survive in the RENDERER even when nothing ever populates them. A
     * mutation that threw the route's rejections away on arrival passed.
     *
     * acceptCandidates drops what the geometry refuses and says why. That
     * reason being swallowed is the whole failure: six asked for, four shown,
     * and nothing saying the other two were impossible.
     */
    assert.match(WORLDS, /acceptCandidates/, 'the route no longer validates candidates');

    const names = ['worldExploreAccept', 'worldExploreCandidates', 'worldExploreShow',
                   'worldExploreTilesHtml'];
    const served = {
        accepted: [{ key: 'A', name: 'Neutral Wide', camera: { focalMm: 24, position: [0, 1.55, 0] } }],
        rejected: [{ key: 'D', name: 'Extreme Foreground',
                     failures: [{ check: 'camera_inside_geometry', detail: 'the camera is inside a wall' }] }],
        shortfall: 5,
    };
    const pre = `
        const EXPLORE = { brief: {}, cats: [], accepted: [], rejected: [], shortfall: 0,
                          compare: false, picks: [], result: null };
        const WORLD = { shotId: 'shot-1' };
        const WORLD_EXPLORE_FALLBACK = [];
        const esc = v => String(v == null ? '' : v);
        const BOX = { value: '[{"key":"A"},{"key":"D"}]' };
        const OUT = { innerHTML: '' };
        const document = { getElementById: (id) => (id === 'weExploreCandidates' ? BOX
            : id === 'weExploreOut' ? OUT : null) };
        const api = async () => (${JSON.stringify(served)});`;
    const src = names.map(n => declSource(n)).filter(Boolean).join('\n');
    const html = await new Function(
        `${pre}\n${src}\nreturn (async () => { await worldExploreAccept(); return OUT.innerHTML; })();`)();

    assert.ok(html.includes('D') && /Extreme Foreground|D:/.test(html),
        `the refused camera is not named:\n${html}`);
    assert.ok(html.includes('inside a wall'),
        `the refusal carries no reason, so a director is told a camera failed and not why:\n${html}`);
    assert.ok(/5\b/.test(html),
        `the shortfall is not shown, so asking for six and getting one looks like six:\n${html}`);
});

/* ── 3 · a tile loads its camera, in place ──────────────────────────────── */

test('clicking a tile loads that camera through the SAME apply path', () => {
    const src = declSource('worldExploreLoad') || '';
    assert.ok(src, 'a tile cannot be loaded');
    assert.match(src, /\/direct/, 'loading a camera does not go through the directing route');
    assert.ok(!/saveCamera|previs\/set/.test(src),
        'a tile writes the camera by another path, bypassing the geometry checks');
    // In place: it must not send the director to another page.
    assert.ok(!/navigateTo/.test(src),
        'clicking a tile navigates away — the design says the console updates in place');
});

/* ── 4 · Compare, over the function that was never called ───────────────── */

test('compareCameras is REACHABLE — it was written and called from nowhere', () => {
    /*
     * The point of this half of the task. A pure function nobody can reach is
     * the shape of NEVER_WRITES, `scope`, describeResolution and voice_id.
     */
    /*
     * A CALL, with comments stripped. The first version matched the word — and
     * the comment above the route explaining WHY compareCameras is exposed
     * contains it twice, so replacing the call with `{ axes: [] }` left this
     * green. Fourth comment false positive in this run of work; the rule is
     * the same every time: match the thing, not a description of it.
     */
    const CODE = WORLDS.split('\n').filter(l => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
    assert.match(CODE, /compareCameras\s*\(/,
        'no route CALLS compareCameras, so the comparison the page shows cannot be its output');
});

test('EVERY comparison axis the engine computes reaches the screen', () => {
    /*
     * BEHAVIOURAL, and it has to be. The first version searched the page for
     * the axis NAMES and demanded five literals — which is the opposite of
     * what this wants: the panel renders whatever the engine returns, so a
     * sixth axis appears with nothing to remember. Requiring the names to be
     * typed would have forced the page to carry a second copy of COMPARE_AXES.
     *
     * So the renderer is EXECUTED against a real compareCameras output and the
     * produced HTML is read. Four of five is worse than none: it looks like a
     * complete comparison and the axis that would have decided it is missing.
     */
    const cmp = compareCameras(
        { camera: { focalMm: 24, position: [0, 1.55, 0], rotation: [0, 0, 0] }, occupancy: 34 },
        { camera: { focalMm: 135, position: [0, 1.6, 0], rotation: [0, -2, 0] }, occupancy: 82 });
    assert.strictEqual(cmp.axes.length, COMPARE_AXES.length,
        'the engine no longer computes every axis; re-derive this');

    const names = ['worldExploreShow', 'worldExploreTilesHtml'];
    const pre = `
        const EXPLORE = { brief: null, cats: [], accepted: [], rejected: [], shortfall: 0,
                          compare: true, picks: ['A', 'C'],
                          result: { comparison: ${JSON.stringify({ ...cmp, names: ['Neutral Wide', 'Long Lens'] })} } };
        const WORLD_EXPLORE_FALLBACK = [];
        const esc = v => String(v == null ? '' : v);
        const OUT = { innerHTML: '' };
        const document = { getElementById: (id) => (id === 'weExploreOut' ? OUT : null) };`;
    const src = names.map(n => declSource(n)).filter(Boolean).join('\n');
    const html = new Function(`${pre}\n${src}\nworldExploreShow();\nreturn OUT.innerHTML;`)();

    const missing = COMPARE_AXES.filter(a => !html.includes(a));
    assert.deepStrictEqual(missing, [],
        `the comparison rendered without these axes: ${missing.join(', ')}\n${html}`);
    // And both cameras' values, or it is a list of labels.
    assert.ok(html.includes('135') && html.includes('24'),
        'the comparison shows the axes and neither camera\'s values');
    assert.ok(html.includes('Neutral Wide') && html.includes('Long Lens'),
        'the columns are not headed with the two cameras, so which is which is a guess');
});

test('the comparison is the ROUTE\'s output, not the page\'s arithmetic', () => {
    const src = declSource('worldExploreCompare') || '';
    assert.ok(src, 'there is no way to compare two cameras');
    assert.match(src, /method:\s*'POST'/, 'the comparison is not requested from the engine');
    assert.match(src, /compare/, 'the comparison does not go to a compare route');
    // A second implementation is how the two come to disagree about what
    // "distance" means.
    assert.ok(!/Math\.hypot|focalMm\s*-\s*|position\[1\]\s*-\s*/.test(src),
        'the page computes the comparison itself — a second implementation of compareCameras');
});

test('Compare selects rather than loads, and holds exactly two', () => {
    const pick = declSource('worldExplorePick') || '';
    assert.ok(pick, 'there is no way to pick a camera for comparison');
    assert.match(pick, /compare/i, 'picking does not know about compare mode');
    /*
     * FIFO past two, from the design. Without a cap the third pick either does
     * nothing — which reads as the tile being broken — or silently replaces
     * one the director cannot see.
     */
    assert.match(pick, /shift\(\)|slice\(-2\)|length\s*>=?\s*2/,
        'nothing bounds the selection to two, so a third pick has undefined meaning');
});

/* ── 5 · it is a region of the design, gated and placed ─────────────────── */

test('the panel is behind camera_explore, and hidden when it is off', () => {
    const on = renderConsole(ALL_FLAGS);
    const off = renderConsole({ ...ALL_FLAGS, camera_explore: false });
    assert.match(on, /EXPLORE SHOT/, 'the panel does not render even with its flag on');
    assert.ok(!/EXPLORE SHOT/.test(off),
        'the panel still renders with camera_explore switched off — the flag gates nothing');
});

test('no server-side model is reachable from this panel', () => {
    const src = featureSource();
    for (const forbidden of ['/screenplay-ai', '/llm', 'node_gen_llm']) {
        assert.ok(!src.includes(forbidden),
            `the panel reaches ${forbidden} — the six cameras come from the connected model`);
    }
    assert.match(src, /agent|model|MCP/i,
        'the panel never says where the six cameras come from');
});
