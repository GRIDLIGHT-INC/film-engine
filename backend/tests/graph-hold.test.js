/**
 * PGN-016 — hold on shots, sequences and cues.
 *
 * Migration 118 adds `held_at` to film_shots, film_sequences and
 * film_music_cues. A hold is set and released through each node's EXISTING
 * update route and MCP update tool (`held: true | false`), never a new
 * surface, so a page, an agent and curl cannot disagree about it. The graph
 * reports `held` on each node and draws a "held" badge; Ctrl+B and a menu item
 * toggle it.
 *
 * Set-based over HOLDABLE: every holdable node type must be settable,
 * releasable, refused on a bad value, visible on the graph, reachable from its
 * MCP tool, and toggleable from the page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-hold-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const hold = require('../lib/graph-hold');
const pg = require('../lib/production-graph');
const mcp = require('../lib/mcp-tools');

const P = generateId(), SC = generateId(), SH = generateId(), SEQ = generateId(), CUE = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Hold')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', '{}')").run(SH, SC);
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Walk', ?)").run(SEQ, P, JSON.stringify([SH]));
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type) VALUES (?, ?, ?, 'score')").run(CUE, P, SC);
const IDS = { shot: SH, sequence: SEQ, sound: CUE };

const heldAt = h => db.prepare(`SELECT held_at FROM ${h.table} WHERE id = ?`).get(IDS[h.node]).held_at;
const node = h => pg.buildGraph(db, P).nodes.find(n => n.key === `${h.key_prefix}:${IDS[h.node]}`);

async function put(h, body) {
    const handler = require(`../routes/${h.route_module}`)[h.handler];
    const url = h.path(IDS[h.node]);
    let status = 0, out = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = b ? JSON.parse(b) : null; } };
    await handler({ method: 'PUT', body, url }, res, url.split('/').filter(Boolean), {});
    return { status, out };
}

test('migration 118 adds held_at to exactly the holdable tables', () => {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '118_graph_hold.sql'), 'utf8');
    assert.deepEqual(hold.HOLDABLE.map(h => h.table).sort(), ['film_music_cues', 'film_sequences', 'film_shots']);
    for (const h of hold.HOLDABLE) {
        assert.match(mig, new RegExp(`ALTER TABLE ${h.table} ADD COLUMN held_at`), `${h.table} has no held_at`);
        assert.ok(db.prepare(`PRAGMA table_info(${h.table})`).all().some(c => c.name === 'held_at'));
    }
});

test('the value is read strictly: true holds, false or null releases, anything else is refused by name', () => {
    assert.equal(hold.readHeld(true).hold, true);
    assert.equal(hold.readHeld(false).hold, false);
    assert.equal(hold.readHeld(null).hold, false);
    for (const bad of ['yes', 1, 'true', {}]) assert.match(hold.readHeld(bad).error || '', /held/);
});

for (const h of hold.HOLDABLE) {
    test(`${h.node}: held through its own update route, shown on the graph, released again, bad value refused`, async () => {
        let r = await put(h, { held: true });
        assert.equal(r.status, 200, `${h.node} hold: ${JSON.stringify(r.out)}`);
        assert.ok(heldAt(h), `${h.node}: held_at not set`);
        assert.equal(node(h).held, true, `${h.node}: the graph does not say it is held`);
        assert.ok(node(h).held_at);
        r = await put(h, { held: false });
        assert.equal(r.status, 200);
        assert.equal(heldAt(h), null, `${h.node}: not released`);
        assert.equal(node(h).held, false);
        r = await put(h, { held: 'yes' });
        assert.equal(r.status, 400, `${h.node}: a bad value was accepted`);
        assert.match(JSON.stringify(r.out), /held/);
        assert.equal(heldAt(h), null, `${h.node}: a refused hold still wrote`);
    });
}

test('every holdable node\'s MCP update tool advertises `held` and reaches the column', async () => {
    const tools = mcp.listTools();
    for (const h of hold.HOLDABLE) {
        const t = tools.find(x => x.name === h.tool);
        assert.ok(t, `${h.tool} missing`);
        assert.equal((t.inputSchema.properties.held || {}).type, 'boolean', `${h.tool} does not advertise held`);
        const idArg = { shot: 'shot_id', sequence: 'sequence_id', sound: 'cue_id' }[h.node];
        await mcp.callTool(h.tool, { [idArg]: IDS[h.node], held: true });
        assert.ok(heldAt(h), `${h.tool} did not hold`);
        await mcp.callTool(h.tool, { [idArg]: IDS[h.node], held: false });
        assert.equal(heldAt(h), null, `${h.tool} did not release`);
    }
});

// ---- the page ----------------------------------------------------------------------
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') parens++; else if (SPA[i] === ')' && --parens === 0) { i++; break; } }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) { if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1); }
    return null;
}
function constSource(name) {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(SPA);
    if (!m) return null;
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) { const ch = SPA[j]; if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1); }
    return null;
}

test('the page toggles a hold through each node\'s own update route, for every holdable type', async () => {
    assert.ok(constSource('PG_HOLD_ROUTES'), 'PG_HOLD_ROUTES is not defined');
    const calls = [];
    const env = new Function('api', 'pgNode', 'setStatus', 'loadProductionGraph',
        `${constSource('PG_HOLD_ROUTES')} ${fnSource('pgToggleHold')}; return { PG_HOLD_ROUTES, pgToggleHold };`);
    const nodes = {};
    for (const h of hold.HOLDABLE) nodes[`${h.key_prefix}:x`] = { key: `${h.key_prefix}:x`, type: h.node, id: 'x', held: false };
    const page = env(async (url, o) => { calls.push({ url, body: JSON.parse(o.body), method: o.method }); return {}; },
        k => nodes[k], () => {}, async () => {});
    assert.deepEqual(Object.keys(page.PG_HOLD_ROUTES).sort(), hold.HOLDABLE.map(h => h.node).sort());
    for (const h of hold.HOLDABLE) {
        calls.length = 0;
        await page.pgToggleHold(`${h.key_prefix}:x`);
        assert.equal(calls.length, 1, `${h.node}: toggling sent nothing`);
        assert.equal(calls[0].method, 'PUT');
        assert.equal(calls[0].url, h.path('x').replace(/^\/film/, ''));
        assert.deepEqual(calls[0].body, { held: true });
        nodes[`${h.key_prefix}:x`].held = true;
        calls.length = 0;
        await page.pgToggleHold(`${h.key_prefix}:x`);
        assert.deepEqual(calls[0].body, { held: false }, `${h.node}: a held node is not released`);
    }
    calls.length = 0;
    await page.pgToggleHold('missing');
    assert.equal(calls.length, 0);
});

test('a held node wears a "held" badge; nothing else does; Ctrl+B and the menu reach the toggle', () => {
    const deco = new Function(`const esc = s => String(s); ${fnSource('pgHoldDecorate')}; return pgHoldDecorate;`)();
    const html = '<div class="pg-node" data-key="shot:x"><b>1A</b></div>';
    const held = deco(html, { held: true, held_at: '2026-09-28 10:00:00' });
    assert.match(held, /class="pg-node held/);
    assert.match(held, /held/i);
    assert.ok(held.indexOf('pg-held') > held.indexOf('>'), 'the badge is outside the node');
    assert.equal(deco(html, { held: false }), html);
    assert.match(fnSource('pgNodeHtml'), /pgHoldDecorate\(/, 'nodes are never decorated');
    assert.match(fnSource('pgInitCanvas'), /ev\.key[^;]*'b'[\s\S]*?pgToggleHold\(PG\.sel\)/i, 'Ctrl+B does not toggle the selected node');
    assert.match(fnSource('pgOpenMenu'), /pgMenuDo\('hold'\)/);
    assert.match(fnSource('pgMenuDo'), /'hold'[\s\S]*?pgToggleHold\(/);
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
