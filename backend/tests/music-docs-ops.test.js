const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * THE WORKSTATION IS DOCUMENTED FROM ITS OWN REGISTRIES, AND ITS HEALTH IS
 * READABLE WITHOUT A SECRET OR A PATH IN IT.
 *
 * MUS-023. Two halves, both set-based.
 *
 * DOCUMENTATION. The denominators are the code, never a list typed here:
 *   - every route the score-session router's own header names is in the API
 *     reference (a route that ships undocumented is one nobody finds);
 *   - every environment variable the music, DAW and sidecar code reads is in
 *     the workstation guide, as is the one setting (music_rights_policy);
 *   - the provider capability table agrees with every music provider's live
 *     contract, cell by cell — a table typed once goes stale the first time a
 *     provider wires a workflow;
 *   - the rights table agrees with DEFAULT_POLICY for every gate × status;
 *   - every origin, status, score consumer, report state and score table the
 *     bundle carries is named, and every migration of the epic has a note;
 *   - every status code the Ableton sidecar can answer is in its
 *     troubleshooting section.
 *
 * OPERATIONS. `music_health` / GET /film/music-sessions/health reports every
 * operation area — render, generation, separation, package, DAW, import — by
 * status, with what is stalled and what failed and how to recover, plus the
 * encoder and every DAW adapter. It must say all that WITHOUT the sidecar
 * token, any other secret, the encoder's path or an absolute local path: a
 * health page is what gets pasted into a ticket.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-docs-ops-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

// ── Documentation ──────────────────────────────────────────────────────────

/** The routes the score-session router says it serves, from its own header. */
function headerRoutes() {
    const src = read('backend/routes/music-sessions.js');
    const header = src.slice(0, src.indexOf('*/'));
    const out = [];
    for (const line of header.split('\n')) {
        const m = /^\s*\*\s+((?:GET|POST|PUT|DELETE)(?:\|(?:GET|POST|PUT|DELETE))*)\s+(\/film\/\S+)/.exec(line);
        if (m) out.push({ method: m[1], path: m[2] });
    }
    return out;
}

test('every route the score-session router names is in the API reference', () => {
    const routes = headerRoutes();
    assert.ok(routes.length >= 40, `the header scan found only ${routes.length} routes — it has stopped reading the header`);
    const api = read('docs/api-film.md');
    const missing = routes.filter(r => !api.includes(r.path)).map(r => `${r.method} ${r.path}`);
    assert.deepStrictEqual(missing, [], `undocumented score routes:\n  ${missing.join('\n  ')}`);
    assert.ok(api.includes('/film/projects/:id/music/capabilities'), 'the free capability discovery route is undocumented');
    assert.ok(routes.some(r => r.path === '/film/music-sessions/health'), 'the router does not name its health route');
});

/** Every environment variable the workstation's code reads, from the source. */
function envVars() {
    const files = ['backend/ableton-sidecar.js', 'backend/lib/daw-registry.js', 'backend/lib/daw-adapter.js', 'backend/lib/ableton-osc.js',
        'backend/routes/music-sessions.js', 'backend/lib/music-health.js', 'backend/lib/ffmpeg.js'];
    for (const f of fs.readdirSync(path.join(ROOT, 'backend/lib'))) if (/^music-.*\.js$/.test(f)) files.push(`backend/lib/${f}`);
    for (const f of fs.readdirSync(path.join(ROOT, 'backend/lib/daw'))) files.push(`backend/lib/daw/${f}`);
    const vars = new Set();
    for (const f of files) {
        if (!exists(f)) continue;
        for (const m of read(f).matchAll(/\b(?:process\.env|env|e)\.([A-Z][A-Z0-9_]{2,})\b/g)) vars.add(m[1]);
    }
    return [...vars].sort();
}

test('every environment variable the workstation reads, and its one setting, is in the workstation guide', () => {
    assert.ok(exists('docs/music-workstation.md'), 'docs/music-workstation.md does not exist');
    const doc = read('docs/music-workstation.md');
    const vars = envVars();
    for (const must of ['ABLETON_SIDECAR_TOKEN', 'ABLETON_SIDECAR_URL', 'ABLETON_SIDECAR_PORT', 'FFMPEG_PATH']) assert.ok(vars.includes(must), `the env scan did not find ${must} — it has stopped reading the source`);
    const missing = vars.filter(v => !doc.includes('`' + v + '`'));
    assert.deepStrictEqual(missing, [], `environment variables read and not documented: ${missing.join(', ')}`);
    assert.ok(doc.includes('`music_rights_policy`'), 'the rights policy setting is not documented');
});

/** A markdown table as rows of trimmed cells, found by its first header cell. */
function table(doc, firstHeader) {
    const lines = doc.split('\n');
    const at = lines.findIndex(l => l.trim().startsWith('|') && l.split('|')[1] && l.split('|')[1].trim() === firstHeader);
    assert.ok(at >= 0, `no table headed "${firstHeader}"`);
    const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim().replace(/`/g, ''));
    const head = cells(lines[at]);
    const rows = [];
    for (let i = at + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
    return { head, rows };
}

test('the provider capability table agrees with every music provider\'s live contract, cell by cell', () => {
    const providers = require('../lib/providers');
    const mc = require('../lib/music-capabilities');
    const music = providers.list().filter(a => (a.capabilities || []).includes('music'));
    assert.ok(music.length >= 2, 'fewer than two music providers — the registry scan is broken');
    const t = table(read('docs/music-workstation.md'), 'Workflow');
    for (const a of music) assert.ok(t.head.includes(a.id), `the capability table has no column for ${a.id}`);
    for (const wf of Object.keys(mc.WORKFLOWS)) {
        const row = t.rows.find(r => r[0] === wf);
        assert.ok(row, `the capability table has no row for ${wf}`);
        for (const a of music) {
            const want = mc.contractOf(a)[wf].status;
            const got = row[t.head.indexOf(a.id)];
            assert.ok(got.startsWith(want), `${wf} × ${a.id}: the table says "${got}", the contract says ${want}`);
        }
    }
});

test('the rights table is DEFAULT_POLICY, gate by status; every origin, consumer and report state is named', () => {
    const rights = require('../lib/music-rights');
    const approval = require('../lib/music-approval');
    const doc = read('docs/music-workstation.md');
    const t = table(doc, 'Status');
    for (const gate of rights.GATES) assert.ok(t.head.includes(gate), `the rights table has no column for the ${gate} gate`);
    for (const status of rights.STATUSES) {
        const row = t.rows.find(r => r[0] === status);
        assert.ok(row, `the rights table has no row for ${status}`);
        for (const gate of rights.GATES) assert.strictEqual(row[t.head.indexOf(gate)], rights.DEFAULT_POLICY[gate][status], `${status} at ${gate}`);
    }
    for (const o of rights.ORIGINS) assert.ok(doc.includes('`' + o + '`'), `origin ${o} is not documented`);
    for (const c of approval.SCORE_CONSUMERS) assert.ok(doc.includes('`' + c.id + '`'), `score consumer ${c.id} is not documented`);
    for (const s of approval.REPORT_STATES) assert.ok(doc.includes('`' + s + '`'), `score report state ${s} is not documented`);
});

test('backup and restore name every score table the bundle carries; every migration of the epic has a note', () => {
    const doc = read('docs/music-workstation.md');
    const { EXPORT_TABLES } = require('../lib/project-bundle');
    const score = EXPORT_TABLES.map(t => t.table).filter(t => /^film_music_/.test(t));
    assert.ok(score.length >= 8, `the bundle carries only ${score.length} score tables — the scan is broken`);
    for (const t of score) assert.ok(doc.includes('`' + t + '`'), `the bundle carries ${t} and the guide does not say so`);
    for (const must of ['backup.sh', 'VACUUM INTO']) assert.ok(doc.includes(must), `backup and restore does not mention ${must}`);
    // The epic's migrations: from the workstation's first (105) on, every one that touches a score table or the rights register.
    const dir = path.join(ROOT, 'backend/db/migrations');
    const migrations = fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f) && parseInt(f, 10) >= 105)
        .filter(f => /film_music_|film_rights/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.ok(migrations.length >= 5, 'the epic\'s migrations were not found');
    for (const m of migrations) assert.ok(doc.includes(m), `migration ${m} has no note`);
    assert.ok(doc.includes('ableton-sidecar.md'), 'the guide does not point at the sidecar setup');
});

test('every status code the Ableton sidecar can answer is in its troubleshooting section', () => {
    const codes = new Set();
    for (const f of ['backend/ableton-sidecar.js', 'backend/lib/ableton-osc.js']) {
        const src = read(f);
        for (const m of src.matchAll(/send\(res, (\d{3})|refuse\((\d{3})|status: (\d{3})|\? (\d{3}) : (\d{3})/g)) for (const g of m.slice(1)) if (g && g !== '200') codes.add(g);
    }
    assert.ok(codes.size >= 6, `found only ${[...codes]} — the scan is broken`);
    const doc = read('docs/ableton-sidecar.md');
    const trouble = doc.slice(doc.indexOf('## Troubleshooting'), doc.indexOf('\n## ', doc.indexOf('## Troubleshooting') + 5));
    const missing = [...codes].filter(c => !trouble.includes(c)).sort();
    assert.deepStrictEqual(missing, [], `sidecar status codes with no troubleshooting entry: ${missing.join(', ')}`);
});

// ── Operations ─────────────────────────────────────────────────────────────

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const TOKEN = 'tok_' + crypto.randomBytes(18).toString('hex');
const SECRET_KEY = 'sk_' + crypto.randomBytes(20).toString('hex');
const DATA_DIR = process.env.FILM_DATA_DIR;
const ENV = { ...process.env, ABLETON_SIDECAR_TOKEN: TOKEN, ELEVENLABS_API_KEY: SECRET_KEY };

function fixture() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Health')").run(projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name) VALUES (?, ?, 'S')").run(sessionId, projectId);
    const op = (kind, status, o) => {
        const x = o || {};
        const id = generateId();
        db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, provider, params_json, error_message, started_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`)
            .run(id, sessionId, kind, status, x.provider || '', JSON.stringify(x.params || {}), x.error || '', x.age || '-1 seconds', x.age || '-1 seconds');
        return id;
    };
    return { projectId, sessionId, op };
}

test('every operation kind the schema allows is claimed by an area, and the writers\' own sub-kinds land where they belong', () => {
    const health = require('../lib/music-health');
    const { VOCABULARY } = require('../lib/music-session');
    const kinds = VOCABULARY['film_music_operations.kind'];
    for (const k of kinds) assert.ok(Object.values(health.HEALTH_AREAS).some(a => a.claims.some(c => c.split(':')[0] === k)), `no health area claims ${k}`);
    // The sub-kinds the writers stamp into params, from the source.
    const pks = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, 'backend/lib')).filter(x => /\.js$/.test(x))) {
        for (const m of read(`backend/lib/${f}`).matchAll(/params:\s*\{\s*kind:\s*'(\w+)'/g)) pks.add(m[1]);
    }
    assert.ok(pks.has('package') && pks.has('daw'), `the params-kind scan found ${[...pks]}`);
    for (const pk of pks) assert.ok(kinds.some(k => health.areaOf({ kind: k, params: { kind: pk } }) !== 'unclassified'), `params.kind ${pk} lands in no area`);
    assert.strictEqual(health.areaOf({ kind: 'push', params: { kind: 'package' } }), 'package');
    assert.strictEqual(health.areaOf({ kind: 'import', params: { kind: 'package_import' } }), 'package');
    assert.strictEqual(health.areaOf({ kind: 'push', params: { kind: 'daw' } }), 'daw');
    assert.strictEqual(health.areaOf({ kind: 'pull', params: { kind: 'daw' } }), 'daw');
    assert.strictEqual(health.areaOf({ kind: 'import', params: {} }), 'import');
    assert.strictEqual(health.areaOf({ kind: 'bounce', params: {} }), 'render');
    assert.strictEqual(health.areaOf({ kind: 'push', params: { kind: 'something_new' } }), 'unclassified');
    for (const [id, a] of Object.entries(health.HEALTH_AREAS)) {
        assert.ok(a.what && a.recovery, `${id} does not say what it is and how to recover`);
        assert.ok(read('docs/music-workstation.md').includes('`' + id + '`'), `health area ${id} is not documented`);
    }
});

test('redaction removes absolute paths and secrets and keeps what a person needs to act', () => {
    const { redact } = require('../lib/music-health');
    const s = redact(`the encoder failed (/opt/homebrew/bin/ffmpeg: 1): ${DATA_DIR}/music/p1/take_master.wav: Invalid data; Bearer ${TOKEN}; key ${SECRET_KEY}; see docs/ableton-sidecar.md at http://127.0.0.1:3190/op and C:\\Users\\x\\y.wav`, ENV);
    for (const bad of [DATA_DIR, '/opt/homebrew', TOKEN, SECRET_KEY, 'C:\\Users']) assert.ok(!s.includes(bad), `redacted text still holds ${bad}: ${s}`);
    for (const keep of ['ffmpeg', 'take_master.wav', 'Invalid data', 'docs/ableton-sidecar.md', 'http://127.0.0.1:3190/op', 'y.wav']) assert.ok(s.includes(keep), `redaction lost ${keep}: ${s}`);
});

test('the health report: every area by status, what is stalled, what failed and how to recover — no secret, no path', async () => {
    const health = require('../lib/music-health');
    const { VOCABULARY } = require('../lib/music-session');
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const f = fixture();
    const failed = f.op('bounce', 'failed', { error: `the encoder failed (${resolveFfmpeg().bin}: 1): ${DATA_DIR}/music/${f.projectId}/x_master.wav: No such file (token ${TOKEN})` });
    const orphan = f.op('generate', 'running', { provider: 'elevenlabs', age: '-2 hours' });
    // A job with a failed child is ONE failure: the child folds into its parent.
    const job = f.op('separate', 'failed', { error: 'child #0 (vocals) failed: provider 500' });
    const child = f.op('separate', 'failed', { error: 'provider 500' });
    db.prepare('UPDATE film_music_operations SET group_id = ?, seq = 0 WHERE id = ?').run(job, child);
    const stuck = f.op('bounce', 'running', { age: '-3 hours' });
    const fresh = f.op('bounce', 'running', { age: '-5 seconds' });
    f.op('push', 'complete', { params: { kind: 'package' } });
    f.op('push', 'failed', { params: { kind: 'daw', adapter_id: 'ableton' }, error: `the sidecar at http://127.0.0.1:3190 answered 504 for ${os.homedir()}/Music/set.als` });
    f.op('separate', 'complete');
    f.op('import', 'complete');

    const rep = await health.musicHealth(db, { project_id: f.projectId, env: ENV });
    for (const id of Object.keys(health.HEALTH_AREAS)) {
        assert.ok(rep.areas[id], `no ${id} area in the report`);
        for (const st of VOCABULARY['film_music_operations.status']) assert.strictEqual(typeof rep.areas[id].counts[st], 'number', `${id}.counts.${st}`);
    }
    assert.strictEqual(rep.areas.render.counts.failed, 1);
    assert.strictEqual(rep.areas.render.counts.running, 2);
    assert.strictEqual(rep.areas.package.counts.complete, 1);
    assert.strictEqual(rep.areas.separation.counts.failed, 1, 'a failed job and its failed child were counted as two failures');
    assert.deepStrictEqual(rep.areas.separation.recent_failures.map(x => x.id), [job], 'the failure listed is not the job that can be retried');
    void child;
    assert.strictEqual(rep.areas.daw.counts.failed, 1);
    const stalled = Object.values(rep.areas).flatMap(a => a.stalled.map(x => x.id));
    assert.ok(stalled.includes(orphan), 'a running generation no process owns is not reported stalled');
    assert.ok(stalled.includes(stuck), 'a bounce running for hours is not reported stalled');
    assert.ok(!stalled.includes(fresh), 'a bounce started seconds ago is reported stalled');
    const fail = rep.areas.render.recent_failures.find(x => x.id === failed);
    assert.ok(fail, 'the failed bounce is not in recent failures');
    assert.ok(fail.recovery && fail.session_id === f.sessionId, 'a failure without its session and its recovery is not actionable');
    assert.ok(fail.error.includes('x_master.wav') && fail.error.includes('No such file'), `the failure lost its meaning: ${fail.error}`);
    assert.ok(rep.attention >= 4, `attention ${rep.attention}`);

    assert.strictEqual(typeof rep.encoder.available, 'boolean');
    assert.ok(rep.encoder.source, 'the encoder does not say where it came from');
    assert.deepStrictEqual(Object.keys(rep.daw).sort(), Object.keys(require('../lib/daw-registry').ADAPTERS).sort());
    assert.strictEqual(rep.daw.ableton.configured, true);
    const bare = await health.musicHealth(db, { project_id: fixture().projectId, env: { ...process.env, ABLETON_SIDECAR_TOKEN: '' } });
    assert.strictEqual(bare.daw.ableton.configured, false);
    assert.ok(bare.daw.ableton.reason && bare.daw.ableton.guide, 'an unconfigured adapter does not say why or where to read');

    const whole = JSON.stringify(rep) + JSON.stringify(bare);
    for (const bad of [TOKEN, SECRET_KEY, DATA_DIR, os.homedir(), resolveFfmpeg().bin].filter(Boolean)) assert.ok(!whole.includes(bad), `the health report leaks ${bad}`);
});

test('the health route and the music_health tool are the same report, scoped, and free', async () => {
    const f = fixture();
    const id = f.op('separate', 'failed', { error: `bad archive at ${DATA_DIR}/x.zip` });
    const other = fixture(); other.op('separate', 'failed');
    const prev = process.env.ABLETON_SIDECAR_TOKEN; process.env.ABLETON_SIDECAR_TOKEN = TOKEN;
    try {
        const mcp = require('../lib/mcp-tools');
        assert.ok(mcp.hasTool('music_health'), 'there is no music_health tool');
        const out = mcp.presentResult(await mcp.callTool('music_health', { project_id: f.projectId }));
        const text = JSON.stringify(out);
        assert.ok(text.includes(id), 'the tool does not report the project\'s failed separation');
        assert.ok(!text.includes(other.sessionId), 'the tool reports another project\'s session');
        assert.ok(!text.includes(TOKEN) && !text.includes(DATA_DIR), 'the tool leaks a secret or a path');
    } finally { if (prev == null) delete process.env.ABLETON_SIDECAR_TOKEN; else process.env.ABLETON_SIDECAR_TOKEN = prev; }
});
