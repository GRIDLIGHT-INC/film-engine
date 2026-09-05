const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bridgeret-'));
const BACKEND = path.join(__dirname, '..');
const strip = (s) => s.split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');

/**
 * A BRIDGE THAT NOTHING CAN FIND.
 *
 * Raised by my peer in cross-review and verified: the bridge is generated,
 * conformed, cost-checked and filed — and the only three `'bridge'` readers in
 * the tree are on the page, all reading the PLAN object at request time. None
 * reads the persisted asset. Nothing reads its `between` metadata. conform.js
 * excludes it twice: it is `other`, and its INSERT carries no shot_id.
 *
 * STAYING OUT OF THE CUT IS DELIBERATE. The ask was "mark in in the first, mark
 * out in the second, ask a redo of in between, and insert it into Premiere" — a
 * bridge that entered the timeline by itself would be the engine making the
 * edit the editor opened Premiere to make.
 *
 * BUT INTENT DOES NOT EXCUSE UNREACHABLE. As a handoff it still has to be
 * handed over, and the path came back in a tool result that scrolls away.
 *
 * SO THIS IS SET-BASED OVER BOTH DIRECTIONS, which is the whole lesson: my
 * dispatch test asserted only that a bridge must NOT be selected as shot
 * footage, and never that it is selected by anything at all. One direction of a
 * two-directional property looks like coverage and is half of it.
 */

/** Everything that turns assets into a cut. A bridge must appear in none of them. */
function cutBuilders() {
    const out = [];
    for (const f of ['lib/conform.js', 'lib/timeline.js', 'lib/nle-export.js']) {
        const p = path.join(BACKEND, f);
        if (fs.existsSync(p)) out.push({ id: f, src: strip(fs.readFileSync(p, 'utf8')) });
    }
    return out;
}

/** Everything that can hand a bridge back. Derived, so a second one is covered. */
function retrievalPaths() {
    const out = [];
    for (const dir of ['routes', 'lib']) {
        const d = path.join(BACKEND, dir);
        for (const f of fs.readdirSync(d).filter(x => x.endsWith('.js'))) {
            const src = strip(fs.readFileSync(path.join(d, f), 'utf8'));
            if (/kind[^\n]*'bridge'|'bridge'[^\n]*kind|bridges/.test(src)
                && !/repair-bridge\.js|repair-run\.js/.test(f)) {
                out.push({ id: `${dir}/${f}`, src });
            }
        }
    }
    return out;
}

test('no cut-builder can select a bridge', () => {
    /*
     * The direction that was already true, pinned so it stays that way. A
     * bridge appearing here would put it in the film IN ADDITION to the two
     * shots it replaces part of.
     */
    const builders = cutBuilders();
    assert.ok(builders.length >= 3, `only ${builders.length} cut-builders found; this scan is wrong`);
    /*
     * Reads the SELECTION LIST, not lines mentioning asset_type. conform.js
     * builds its query from a VIDEO_PRECEDENCE constant, so the type literals
     * sit nowhere near the word `asset_type` — a mutation adding 'other' to
     * that array survived a line-scoped grep entirely.
     */
    const leaking = [];
    for (const b of builders) {
        for (const m of b.src.matchAll(/\[((?:\s*'[a-z_0-9]+'\s*,?)+)\]/g)) {
            const list = m[1];
            if (/'video_(final|synced|raw)'/.test(list) && /'other'/.test(list)) {
                leaking.push(`${b.id}: ${m[0]}`);
            }
        }
        if (/asset_type\s*(=|IN)[^\n]*'other'/.test(b.src)) leaking.push(`${b.id}: direct select`);
    }
    assert.deepStrictEqual(leaking, [],
        `these would select a bridge into the cut: ${leaking.join(', ')}`);
});

test('something can retrieve a filed bridge', () => {
    /*
     * THE DIRECTION MY DISPATCH TEST NEVER ASSERTED. Zero paths is the bug my
     * peer found: filed, paid for, and unreachable by anything.
     */
    const paths = retrievalPaths();
    assert.ok(paths.length >= 1,
        'nothing in routes/ or lib/ can find a filed bridge — it is generated, billed and invisible');
});

test('the retrieval is reachable over HTTP and from an agent', () => {
    /*
     * A capability with no MCP surface is one the connected model cannot use —
     * the goal's own stated rabbit hole, and the reason repair_run exists at
     * all. A bridge an agent can create and cannot then find is half a tool.
     */
    const server = strip(fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8'));
    assert.match(server, /bridges/, 'server.js dispatches no bridge listing');

    const { ALL_ROUTE_TOOLS, listTools } = require('../lib/mcp-tools');
    /*
     * Matched on the ROUTE it builds, not on the name containing "bridge" —
     * renaming it to bridge_listX still satisfied a /bridge/ test while making
     * the tool uncallable by anything that knew its name.
     */
    const tool = ALL_ROUTE_TOOLS.find(t => {
        if (typeof t.path !== 'function') return false;
        try { return /\/bridges\b/.test(t.path({ project_id: 'p' })); } catch (_) { return false; }
    });
    assert.ok(tool, 'no MCP tool targets the bridges route');
    assert.strictEqual(tool.name, 'bridge_list',
        `the bridge listing tool is called ${tool.name}; callers know it as bridge_list`);
    assert.ok(listTools().some(t => t.name === tool.name),
        `${tool.name} is in the registry but not in the listing, so no agent can call it`);
    assert.match(tool.description, /free|spends nothing|costs nothing/i,
        'listing bridges is a read; it must say it spends nothing');
});

test('a listed bridge carries what an editor needs to place it', () => {
    /*
     * A path alone is not a handoff. Without the two trim points the editor has
     * a clip and no idea where it goes — which is the state the tool result
     * left them in.
     */
    const { bridgeRow } = require('../lib/repair-bridge');
    assert.strictEqual(typeof bridgeRow, 'function', 'nothing shapes a bridge row for a caller');
    const row = bridgeRow({
        id: 'x', file_name: 'bridge_1A_abc.mp4', file_path: '/tmp/bridge_1A_abc.mp4',
        duration_ms: 6083, created_at: '2026-09-05T12:00:00Z',
        metadata: JSON.stringify({ kind: 'bridge', between: ['1A', '2A'],
            trim: [{ shot_code: '1A', new_out_sec: 19 }, { shot_code: '2A', new_in_sec: 3 }] }),
    });
    assert.ok(row, 'a bridge asset produced no row');
    assert.deepStrictEqual(row.between, ['1A', '2A']);
    assert.strictEqual(row.trim.length, 2, 'the trim points did not survive');
    assert.ok(row.url && /bridge_1A_abc\.mp4/.test(row.url), 'no servable URL for the bridge');
    /*
     * BOTH branches. The fixture above carries no project_id, so it only ever
     * took the fallback — a mutation nulling the project-scoped branch survived
     * untouched, which is the same one-direction blindness this whole file is
     * about.
     */
    const scoped = bridgeRow({ id: 'z', project_id: 'proj-9', file_name: 'bridge_z.mp4',
        duration_ms: 4000,
        metadata: JSON.stringify({ kind: 'bridge', between: ['1A', '2A'],
            trim: [{ shot_code: '1A', new_out_sec: 1 }, { shot_code: '2A', new_in_sec: 2 }] }) });
    assert.ok(scoped.url && scoped.url.includes('proj-9') && scoped.url.includes('bridge_z.mp4'),
        `a project-scoped bridge has no servable URL: ${scoped.url}`);
    assert.ok(row.note && /1A/.test(row.note) && /2A/.test(row.note),
        'the row carries no instruction naming the two shots');
});

test('a non-bridge asset is not mistaken for one', () => {
    const { bridgeRow } = require('../lib/repair-bridge');
    for (const meta of [null, '', '{}', JSON.stringify({ kind: 'model_3d' }), 'not json']) {
        assert.strictEqual(bridgeRow({ id: 'y', file_name: 'x.mp4', metadata: meta }), null,
            `an asset with metadata ${JSON.stringify(meta)} was read as a bridge`);
    }
});
