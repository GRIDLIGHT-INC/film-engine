/**
 * PGN-003 — the running node says how far along it is.
 *
 * SERVER: `runningWork` maps every running job to the graph node it belongs
 * to, by the attribution the job already carries (shot, sequence, music cue),
 * and says what its provider can report. A job the director did not start in
 * this page — Claude, over MCP — is a row like any other, so it shows too.
 *
 * PAGE: the node draws a real bar and "42%" when there is a percentage, and
 * elapsed time plus "no percentage from this provider" when there is not — an
 * invented percentage is worse than none. Progress is repainted in place by a
 * poller that runs only while something is running, because the live channel
 * is silent about this server's own writes.
 *
 * Set-based where a set exists: every mapping rule the module declares, every
 * registered provider's declaration.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-pgp-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const pg = require('../lib/production-graph');
const providers = require('../lib/providers');

const P = generateId(), SC = generateId(), SH = generateId(), SEQ = generateId(), CUE = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Running')").run(P);
db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(SH, SC);
db.prepare("INSERT INTO film_sequences (id, project_id, name) VALUES (?, ?, 'Walk')").run(SEQ, P);
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type) VALUES (?, ?, ?, 'score')").run(CUE, P, SC);

function job({ provider = 'runway', shot = null, scene = null, meta = {}, status = 'pending', percent = null,
    phase = 'generating', ageSec = 5, heartbeatAgeSec = 1 } = {}) {
    const id = generateId();
    db.prepare(`INSERT INTO film_generation_jobs (id, project_id, shot_id, scene_id, provider, capability, request_id,
        status, meta, percent, phase, started_at, heartbeat_at, collectable)
        VALUES (?, ?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), 1)`)
        .run(id, P, shot, scene, provider, 'r-' + id, status, JSON.stringify(meta), percent, phase,
            `-${ageSec} seconds`, `-${heartbeatAgeSec} seconds`);
    return id;
}
const clear = () => db.prepare('DELETE FROM film_generation_jobs WHERE project_id = ?').run(P);

test('every declared mapping rule sends a running job to its node', () => {
    assert.ok(Array.isArray(pg.RUNNING_RULES) && pg.RUNNING_RULES.length >= 3, 'no RUNNING_RULES declared');
    const cases = {
        music_cue: { meta: { music_cue_id: CUE }, want: 'sound:' + CUE },
        sequence: { meta: { sequence_id: SEQ }, want: 'seq:' + SEQ },
        storyboard_frame: { meta: { storyboard_frame: { shot_id: SH } }, want: 'shot:' + SH },
        shot: { shot: SH, want: 'shot:' + SH },
    };
    const missing = [];
    for (const rule of pg.RUNNING_RULES) {
        const c = cases[rule.id];
        if (!c) { missing.push(`${rule.id}: no case in this test`); continue; }
        clear();
        job({ shot: c.shot || null, meta: c.meta || {} });
        const [r] = pg.runningWork(db, P);
        if (!r || r.key !== c.want) missing.push(`${rule.id}: got ${r && r.key}, wanted ${c.want}`);
    }
    assert.deepEqual(missing, []);
});

test('a sequence leg wins over its shot; the most specific attribution is the node that runs', () => {
    clear();
    job({ shot: SH, meta: { sequence_id: SEQ } });
    assert.equal(pg.runningWork(db, P)[0].key, 'seq:' + SEQ);
});

test('it reports percent, phase, start and what the provider can say, for every registered provider', () => {
    const gen = providers.list().filter(a => typeof a.generate === 'function' && a.reportsProgress);
    assert.ok(gen.length >= 8);
    const wrong = [];
    for (const a of gen) {
        clear();
        job({ provider: a.id, shot: SH, percent: a.reportsProgress === 'percent' ? 42 : null });
        const [r] = pg.runningWork(db, P);
        if (!r || r.reports !== a.reportsProgress) wrong.push(`${a.id}: reports ${r && r.reports}`);
        if (r && !r.started_at) wrong.push(`${a.id}: no started_at`);
        if (r && a.reportsProgress === 'percent' && r.percent !== 42) wrong.push(`${a.id}: percent ${r.percent}`);
    }
    assert.deepEqual(wrong, []);
});

test('settled jobs and silent jobs are not running; an unattributed one is listed without a node', () => {
    clear();
    job({ shot: SH, status: 'completed' });
    job({ shot: SH, status: 'failed' });
    job({ shot: SH, ageSec: 900, heartbeatAgeSec: 600 });       // nothing heard for ten minutes
    const loose = job({ meta: {} });
    const r = pg.runningWork(db, P);
    assert.equal(r.length, 1, `expected only the unattributed live job, got ${r.length}`);
    assert.equal(r[0].job_id, loose);
    assert.equal(r[0].key, null);
});

test('the graph carries running work, and a job from another connection (Claude over MCP) appears', () => {
    clear();
    const Database = require('better-sqlite3');
    const other = new Database(path.join(process.env.FILM_DATA_DIR, 'film-engine.db'));
    try {
        other.prepare(`INSERT INTO film_generation_jobs (id, project_id, shot_id, provider, capability, request_id,
            status, meta, percent, phase, started_at, heartbeat_at, collectable)
            VALUES ('mcp-1', ?, ?, 'meshy', 'model3d', 'm1', 'pending', '{}', 30, 'in progress',
            datetime('now'), datetime('now'), 1)`).run(P, SH);
    } finally { other.close(); }
    const g = pg.buildGraph(db, P);
    assert.ok(Array.isArray(g.running));
    const r = g.running.find(x => x.job_id === 'mcp-1');
    assert.ok(r, 'the MCP-started job is not in the graph');
    assert.equal(r.key, 'shot:' + SH);
    assert.equal(r.percent, 30);
});

test('GET …/production-graph/running answers with the same list', async () => {
    const { handleProductionGraph } = require('../routes/production-graph');
    let out = null;
    const res = { statusCode: 0, setHeader() {}, writeHead(s) { this.statusCode = s; }, end(b) { out = JSON.parse(b); } };
    await handleProductionGraph({ method: 'GET', url: `/film/projects/${P}/production-graph/running` }, res,
        ['film', 'projects', P, 'production-graph', 'running'], {});
    assert.ok(out && Array.isArray(out.running), 'no running list from the route');
    assert.ok(out.running.some(x => x.job_id === 'mcp-1'));
});

test('bad input never throws', () => {
    assert.deepEqual(pg.runningWork(db, 'no-such-project'), []);
    assert.deepEqual(pg.runningWork(null, P), []);
});

// ---- the page -------------------------------------------------------------

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) {
        if (SPA[i] === '(') parens++;
        else if (SPA[i] === ')' && --parens === 0) { i++; break; }
    }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
function progressHtml() {
    const src = fnSource('pgProgressHtml');
    assert.ok(src, 'the page has no pgProgressHtml');
    return new Function(`const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
        ${fnSource('pgElapsed') || ''}
        ${src}; return pgProgressHtml;`)();
}
const NOW = Date.parse('2026-09-28T12:01:05Z');

test('with a percentage: a real bar at that width, the percent, the phase and the elapsed time', () => {
    const html = progressHtml()({ percent: 42, phase: 'generating', started_at: '2026-09-28 12:00:00', reports: 'percent' }, null, NOW);
    assert.match(html, /width:\s*42%/);
    assert.match(html, /42%/);
    assert.match(html, /generating/);
    assert.match(html, /1:05/, 'elapsed time since start');
    assert.doesNotMatch(html, /no percentage/);
});

test('without one: elapsed time and a plain statement, never an invented number', () => {
    for (const reports of ['phase', 'none']) {
        const html = progressHtml()({ percent: null, phase: 'queued', started_at: '2026-09-28 12:00:00', reports }, null, NOW);
        assert.match(html, /no percentage from this provider/, `${reports}: not said`);
        assert.match(html, /1:05/);
        assert.doesNotMatch(html, /\d+%/, `${reports}: a percent was drawn`);
    }
});

test('a click that has not reached a job row yet still shows the local label; nothing running shows nothing', () => {
    const f = progressHtml();
    assert.match(f(null, 'generating frame', NOW), /generating frame/);
    assert.equal(f(null, null, NOW), '');
    assert.equal(f(undefined, undefined, NOW), '');
});

test('every node type draws its progress through the one slot the poller repaints', () => {
    const node = fnSource('pgNodeHtml');
    assert.ok(node);
    assert.match(node, /pgProgressHtml\(/, 'pgNodeHtml does not draw progress through pgProgressHtml');
    assert.match(node, /data-run=/, 'no repaintable progress slot on the node');
    const poll = fnSource('pgPollRunning');
    assert.ok(poll, 'no poller');
    assert.match(poll, /production-graph\/running/, 'the poller does not read the running list');
    assert.match(poll, /setTimeout\(/, 'the poller does not reschedule itself');
    assert.match(fnSource('pgLoad'), /pgPollRunning\(/, 'loading the graph does not start the poller');
    assert.match(fnSource('pgBusy'), /pgPollRunning\(/, 'starting work on a node does not start the poller');
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
