const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * EVERY VOCABULARY THE WORKSTATION HAS, HELD TO EVERY CONSUMER THAT NEEDS IT;
 * AND THE PAGE AND THE AGENT EDITING ONE SESSION WITHOUT LOSING EACH OTHER.
 *
 * MUS-024. A registry that some consumers know and others do not fails
 * partially, which is the failure an example test passes over. So each
 * registry is taken from the code and every entry is walked through each
 * consumer that has to handle it:
 *
 *   track roles    × storage (the tool), rendering (audible, or a guide with its
 *                    reason), bundle (survives the round trip), documentation
 *   clip kinds     × storage, rendering, rights lineage, bundle, documentation
 *   asset kinds    × documentation (derived from the writers' own literals)
 *   workflows      × discovery and the refusal naming the provider's reason
 *   MCP tools      × a documented route the tool actually reaches
 *   package parts  × a built manifest, and documentation
 *   DAW mutations  × an agent tool, a page control with its portable twin, an
 *                    audit record, and documentation
 *
 * Then synchronized editing, executed rather than grepped: the Score page's
 * own save and reload functions run against the real route while an agent
 * edits the same session over MCP, and neither loses the other's change.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-registries-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DOC = () => read('docs/music-workstation.md');
const SPA = read('src/index.html');

const contracts = require('../lib/music-session');
const caps = require('../lib/music-capabilities');
const renderer = require('../lib/music-renderer');
const rights = require('../lib/music-rights');
const musicPackage = require('../lib/music-package');
const daw = require('../lib/daw-adapter');
const dawRegistry = require('../lib/daw-registry');
const { createMemoryDaw } = require('../lib/daw/memory');
const bundle = require('../lib/project-bundle');
const mcp = require('../lib/mcp-tools');
const { handleMusicSessions } = require('../routes/music-sessions');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');

const ROLE_KINDS = contracts.VOCABULARY['film_music_tracks.role_kind'];
const SOURCE_KINDS = contracts.VOCABULARY['film_music_clips.source_kind'];
const GUIDE_ROLES = Object.keys(renderer.GUIDE_ROLES);

async function tool(name, args, opts) {
    const raw = await mcp.callTool(name, args || {});
    const out = mcp.presentResult(raw);
    if (!(opts && opts.allowFailure)) assert.ok(!mcp.isFailure(raw), `${name} refused: ${JSON.stringify(out).slice(0, 500)}`);
    return out;
}
const idOf = x => (x && (x.session || x.project || x.track || x.clip || x.row) || x || {}).id;
function toneAsset(projectId, hz) {
    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `r_${hz}_${generateId().slice(0, 6)}.wav`);
    execFileSync(resolveFfmpeg().bin, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const id = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 2000, '{}')")
        .run(id, projectId, p, path.basename(p));
    return id;
}

// ── One session with a track per role and a clip per kind, built through the tools ──

let FIX;
async function fixture() {
    if (FIX) return FIX;
    const projectId = idOf(await tool('project_create', { title: 'Every vocabulary' }));
    await tool('script_write', { project_id: projectId, fountain_content: 'INT. ROOM - DAY\n\nA room, and a score for it.\n' });
    const sceneId = (await tool('scene_list', { project_id: projectId })).scenes[0].id;
    const sessionId = idOf(await tool('music_session_create', { project_id: projectId, scene_id: sceneId, name: 'Vocabulary' }));
    const tracks = {}, clips = {};
    for (const [i, role_kind] of ROLE_KINDS.entries()) {
        const t = await tool('music_track_create', { session_id: sessionId, name: `${role_kind} lane`, role_kind, role: role_kind, sort_order: i });
        tracks[role_kind] = idOf(t);
        const c = await tool('music_clip_create', { session_id: sessionId, track_id: idOf(t), asset_id: toneAsset(projectId, 200 + i * 40), name: `${role_kind} clip`, source_kind: 'imported', start_ms: 0, duration_ms: 2000, take_status: 'selected' });
        assert.ok(idOf(c), `a clip on the ${role_kind} track was not stored`);
    }
    for (const [i, source_kind] of SOURCE_KINDS.entries()) {
        const c = await tool('music_clip_create', { session_id: sessionId, track_id: tracks.instrument, asset_id: toneAsset(projectId, 500 + i * 40), name: `${source_kind} clip`, source_kind, start_ms: 0, duration_ms: 2000, take_status: 'selected', take_group: `g-${source_kind}` });
        clips[source_kind] = idOf(c);
    }
    FIX = { projectId, sessionId, tracks, clips };
    return FIX;
}

test('every track role: stored through the tool, rendered or named a guide with its reason, documented', async () => {
    assert.ok(ROLE_KINDS.length >= 5, `the role vocabulary has ${ROLE_KINDS.length} entries — the registry read is broken`);
    const f = await fixture();
    for (const role_kind of ROLE_KINDS) assert.strictEqual(db.prepare('SELECT role_kind FROM film_music_tracks WHERE id = ?').get(f.tracks[role_kind]).role_kind, role_kind);
    const plan = renderer.planBounce(db, f.sessionId, {});
    assert.ok(plan.ok, plan.error);
    const audibleTracks = new Set(plan.clips.map(c => c.track_id));
    for (const role_kind of ROLE_KINDS) {
        const guide = GUIDE_ROLES.includes(role_kind);
        const skipped = plan.skipped.find(s => s.track_id === f.tracks[role_kind] || (s.name || '').startsWith(role_kind));
        if (guide) assert.ok(skipped && /never part of the mix/.test(skipped.reason), `a ${role_kind} track reached the mix or was left out without its reason`);
        else assert.ok(audibleTracks.has(f.tracks[role_kind]), `a ${role_kind} track is not in the bounce`);
        assert.ok(DOC().includes('`' + role_kind + '`'), `track role ${role_kind} is not documented`);
    }
});

test('every clip kind: stored, rendered when selected, walked by the rights lineage, documented', async () => {
    assert.ok(SOURCE_KINDS.length >= 5);
    const f = await fixture();
    const plan = renderer.planBounce(db, f.sessionId, {});
    const lineage = rights.scoreLineage(db, f.sessionId);
    assert.ok(lineage.ok, lineage.error);
    for (const kind of SOURCE_KINDS) {
        assert.ok(plan.clips.some(c => c.clip_id === f.clips[kind] || c.id === f.clips[kind]), `a selected ${kind} clip is not in the bounce`);
        const node = lineage.clips.find(c => c.clip_id === f.clips[kind]);
        assert.ok(node && node.asset && node.asset.origin, `the rights lineage does not walk a ${kind} clip to its source`);
        assert.ok(DOC().includes('`' + kind + '`'), `clip kind ${kind} is not documented`);
    }
});

test('the role and clip vocabularies survive the bundle round trip', async () => {
    const f = await fixture();
    const { archivePath } = bundle.exportProject(f.projectId);
    const out = bundle.importProject(fs.readFileSync(archivePath));
    const newId = out.projectId || out.project_id || (out.project && out.project.id);
    const s = db.prepare('SELECT id FROM film_music_sessions WHERE project_id = ?').get(newId);
    assert.ok(s, 'the session did not survive the round trip');
    const roles = db.prepare('SELECT DISTINCT role_kind FROM film_music_tracks WHERE session_id = ?').all(s.id).map(r => r.role_kind).sort();
    const kinds = db.prepare('SELECT DISTINCT c.source_kind FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ?').all(s.id).map(r => r.source_kind).sort();
    assert.deepStrictEqual(roles, ROLE_KINDS.slice().sort(), 'a track role was lost in the bundle');
    assert.deepStrictEqual(kinds, SOURCE_KINDS.slice().sort(), 'a clip kind was lost in the bundle');
});

/** The metadata kinds the music writers stamp on the files they register, from their own literals. */
function assetKinds() {
    const kinds = new Set(Object.keys(caps.OUTPUT_KINDS));
    const dir = path.join(ROOT, 'backend/lib');
    for (const f of fs.readdirSync(dir).filter(x => /^music-.*\.js$/.test(x))) {
        for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/kind: '([a-z_]+)', (?:session_id|stem|matching_key|key|derived_from)\b/g)) kinds.add(m[1]);
    }
    return [...kinds].sort();
}

test('every kind of file the workstation registers is documented', () => {
    const kinds = assetKinds();
    for (const must of ['stem_original', 'stem_working', 'separated_stem', 'bounce_master', 'bounce_stem', 'package_stem', 'score_package', 'whole_cue']) {
        assert.ok(kinds.includes(must), `the writer scan did not find ${must} — it has stopped reading the writers`);
    }
    const missing = kinds.filter(k => !DOC().includes('`' + k + '`'));
    assert.deepStrictEqual(missing, [], `asset kinds registered and not documented: ${missing.join(', ')}`);
});

test('every workflow is discovered for the project, and a workflow its provider cannot do is refused with that provider\'s reason', async () => {
    const f = await fixture();
    await tool('project_update', { project_id: f.projectId, provider_config: { music: 'elevenlabs' } });
    const found = await tool('music_capabilities', { project_id: f.projectId });
    const workflows = found.workflows || [];
    for (const wf of Object.keys(caps.WORKFLOWS)) {
        const w = workflows.find(x => x.workflow === wf || x.id === wf);
        assert.ok(w && w.status, `discovery does not answer for ${wf}`);
        if (w.status !== 'available') {
            assert.ok(w.reason, `${wf} is ${w.status} with no reason`);
            const refused = await tool('music_generate_plan', { session_id: f.sessionId, workflow: wf, prompt: 'x', duration_ms: 4000, ignore_emotion: true }, { allowFailure: true });
            assert.ok(refused.ok === false || refused.status >= 400, `${wf} was planned on a provider that cannot do it`);
            assert.ok(JSON.stringify(refused).includes(w.reason), `the refusal of ${wf} does not carry the provider's own reason`);
        }
    }
});

/** A header route as a pattern: `:param` is a segment, `[/:x]` optional, `{a,b}` either. */
function routePattern(p) {
    const alts = [];
    const body = p.replace(/\[\/:[^\]]+\]/g, '\u0001').replace(/\{([^}]+)\}/g, (m, g) => { alts.push(g.split(',').join('|')); return `\u0002${alts.length - 1}\u0002`; })
        .replace(/:[A-Za-z]+/g, '[^/]+').replace(/\u0001/g, '(?:/[^/]+)?').replace(/\u0002(\d+)\u0002/g, (m, i) => `(?:${alts[Number(i)]})`);
    return new RegExp(`^${body}$`);
}

test('every score tool reaches a route the router names and the API reference documents', () => {
    const src = read('backend/routes/music-sessions.js');
    const header = src.slice(0, src.indexOf('*/'));
    const routes = [...header.matchAll(/^\s*\*\s+(?:GET|POST|PUT|DELETE)(?:\|(?:GET|POST|PUT|DELETE))*\s+(\/film\/\S+)/gm)].map(m => m[1]);
    const patterns = routes.map(r => ({ r, re: routePattern(r) }));
    const api = read('docs/api-film.md');
    const tools = mcp.ALL_ROUTE_TOOLS.filter(t => t.handler === handleMusicSessions);
    assert.ok(tools.length >= 60, `only ${tools.length} tools dispatch to the score router — the registry read is broken`);
    const unrouted = [];
    for (const t of tools) {
        const args = new Proxy({}, { get: (o, k) => (typeof k === 'string' ? (k === 'adapter' ? 'ableton' : (k.endsWith('_id') || k === 'kind' ? 'x1' : undefined)) : undefined) });
        const p = String(t.path(args)).split('?')[0];
        const hit = patterns.find(x => x.re.test(p));
        if (!hit) unrouted.push(`${t.name} → ${p}`);
        else assert.ok(api.includes(hit.r), `${t.name} reaches ${hit.r}, which the API reference does not document`);
    }
    assert.deepStrictEqual(unrouted, [], `tools reaching a route the router does not name:\n  ${unrouted.join('\n  ')}`);
    const guide = read('docs/claude-desktop-guide.md');
    for (const t of tools) assert.ok(guide.includes('`' + t.name + '`'), `${t.name} is not in the Claude Desktop guide`);
});

test('every section of the portable package is in a built manifest and in the documentation', async () => {
    const f = await fixture();
    const built = await musicPackage.buildPackage(db, f.sessionId, { include_picture: false });
    assert.ok(built.ok, built.error);
    const bytes = fs.readFileSync(db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(built.asset_id || built.package.asset_id).file_path);
    const v = musicPackage.validatePackage(bytes);
    assert.ok(v.ok, JSON.stringify(v.errors));
    for (const section of musicPackage.MANIFEST_SECTIONS) {
        assert.ok(section in v.manifest, `a built manifest has no ${section}`);
        assert.ok(DOC().includes('`' + section + '`'), `package section ${section} is not documented`);
    }
});

test('every DAW mutation has an agent tool, a page control with its portable twin, an audit record, and documentation', async () => {
    const mutations = Object.entries(daw.DAW_OPERATIONS).filter(([, o]) => o.mutates).map(([k]) => k);
    assert.ok(mutations.length >= 3, 'the DAW registry read is broken');
    const toolOps = Object.values(dawRegistry.ABLETON_TOOLS);
    const actions = /const DAW_ACTIONS = \[([\s\S]*?)\n\s*\];/.exec(SPA);
    assert.ok(actions, 'the page has no DAW_ACTIONS');
    const f = await fixture();
    const d = createMemoryDaw();
    const plan = await daw.planPush(db, f.sessionId, d);
    assert.ok((await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint })).ok, 'the reference push failed');
    const built = await musicPackage.buildPackage(db, f.sessionId, { include_picture: false });
    d.renderFrom(fs.readFileSync(db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(built.asset_id || built.package.asset_id).file_path));
    const items = (await daw.planPull(db, f.sessionId, d)).items;
    assert.ok((await daw.pull(db, f.sessionId, d, { item_id: items[0].item_id })).ok, 'the reference pull failed');
    assert.ok((await daw.transport(db, f.sessionId, d, { command: 'locate', position_ms: 1000, supervised: true })).ok, 'the reference transport failed');
    const audited = new Set(daw.listAudit(db, f.sessionId).map(a => a.op));
    for (const op of mutations) {
        assert.ok(toolOps.includes(op), `no agent tool performs the DAW ${op}`);
        const entry = new RegExp(`\\{\\s*op:\\s*'${op}'[^\\n]*portable:\\s*\\{`).exec(actions[1]);
        assert.ok(entry, `the page offers no ${op} control with a portable twin`);
        assert.ok(audited.has(op), `a DAW ${op} left no audit record`);
        assert.ok(DOC().includes('`' + op + '`'), `DAW mutation ${op} is not documented`);
    }
});

// ── Synchronized editing: the page and the agent on one session ────────────

/** A function's whole body from the page, by brace depth. */
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    assert.ok(m, `no ${name} on the page`);
    let i = SPA.indexOf('{', m.index), depth = 0;
    for (let j = i; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}

/** The Score page's own load, save and lookup functions, bound to the real router. */
function pageHarness(projectId) {
    const notes = [];
    const route = (url, opts) => new Promise((resolve, reject) => {
        const [p, q] = ('/film' + url).split('?');
        const query = Object.fromEntries(new URLSearchParams(q || ''));
        const method = (opts && opts.method) || 'GET';
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        const chunks = [];
        const res = { statusCode: 200, setHeader() {}, writeHead(s) { this.statusCode = s; return this; }, write(c) { chunks.push(String(c)); },
            end(c) { if (c) chunks.push(String(c)); let data = {}; try { data = JSON.parse(chunks.join('')); } catch (_) { data = {}; }
                if (this.statusCode >= 400) reject(new Error(data.error || `HTTP ${this.statusCode}`)); else resolve(data); } };
        if (!/^\/film\/(music-sessions|projects\/[^/]+\/music-sessions)/.test(p)) return reject(new Error('not served in this harness'));
        Promise.resolve(handleMusicSessions({ method, url: p, body, headers: {} }, res, p.split('/').filter(Boolean), query)).catch(reject);
    });
    const names = ['mwFindRow', 'mwFieldChanged', 'mwSave', 'mwLoadSession', 'loadMusicWorkstation'];
    const src = `
        const MW = { pending: {}, timers: {}, selection: null };
        const state = { currentProject: { id: ${JSON.stringify(projectId)} } };
        const document = { getElementById: () => ({ innerHTML: '' }) };
        const esc = s => String(s == null ? '' : s);
        const mwNote = m => notes.push(m), mwRender = () => {}, mwRepaint = () => {}, mwRestartAudio = () => {}, dawRefresh = () => {}, setStatus = () => {};
        ${names.map(fnSource).join('\n')}
        return { MW, mwFieldChanged, mwLoadSession, loadMusicWorkstation };`;
    // eslint-disable-next-line no-new-func
    const page = new Function('api', 'notes', 'setTimeout', 'clearTimeout', src)(route, notes, setTimeout, clearTimeout);
    return { ...page, notes };
}
const settle = () => new Promise(r => setTimeout(r, 700));
const control = (table, field, kind, id, value, type) => ({ dataset: { mw: `${table}:${field}`, kind, id }, type: type || 'range', value: String(value), tagName: 'INPUT', nextElementSibling: null });

test('synchronized editing: the page and an agent edit one clip, neither loses the other\'s change, a refused edit reloads the truth, and a deletion clears the selection', async () => {
    const f = await fixture();
    const page = pageHarness(f.projectId);
    await page.loadMusicWorkstation();
    assert.strictEqual(page.MW.session && page.MW.session.id, f.sessionId, 'the page did not load the session');
    const clipId = f.clips.imported;
    page.MW.selection = { kind: 'clips', id: clipId };

    // The page moves the gain; before its debounced save lands, the agent sets the fade on the same clip.
    page.mwFieldChanged(control('film_music_clips', 'gain_db', 'clips', clipId, -6));
    await tool('music_clip_update', { session_id: f.sessionId, clip_id: clipId, fade_in_ms: 250 });
    await settle();
    const row = db.prepare('SELECT gain_db, fade_in_ms FROM film_music_clips WHERE id = ?').get(clipId);
    assert.deepStrictEqual({ gain: row.gain_db, fade: row.fade_in_ms }, { gain: -6, fade: 250 }, 'one side\'s edit overwrote the other\'s');
    assert.ok(page.notes.includes('Saved'), `the page did not report its save: ${page.notes.join(' | ')}`);

    // The live-events refresh reloads the page: it now shows the agent's change and keeps the selection.
    await page.loadMusicWorkstation();
    const shown = page.MW.model.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
    assert.deepStrictEqual({ gain: shown.gain_db, fade: shown.fade_in_ms }, { gain: -6, fade: 250 }, 'the reloaded page does not show both edits');
    assert.deepStrictEqual(page.MW.selection, { kind: 'clips', id: clipId }, 'a reload lost what the page had selected');

    // A value the validator refuses is not saved, says so, and the page reloads what is true.
    page.mwFieldChanged(control('film_music_clips', 'gain_db', 'clips', clipId, 99));
    await settle(); await settle();
    assert.strictEqual(db.prepare('SELECT gain_db FROM film_music_clips WHERE id = ?').get(clipId).gain_db, -6, 'a refused value was stored');
    assert.ok(page.notes.some(n => /^Save failed: .*gain_db/.test(n)), `the refusal did not name the field: ${page.notes.slice(-2).join(' | ')}`);
    const after = page.MW.model.tracks.flatMap(t => t.clips).find(c => c.id === clipId);
    assert.strictEqual(after.gain_db, -6, 'the page kept showing the refused value');

    // The agent deletes the clip the page has selected; the next reload lets go of it.
    await tool('music_clip_delete', { session_id: f.sessionId, clip_id: clipId });
    await page.loadMusicWorkstation();
    assert.strictEqual(page.MW.selection, null, 'the page still selects a clip the agent deleted');
});
