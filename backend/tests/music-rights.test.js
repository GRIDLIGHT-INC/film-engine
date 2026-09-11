const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * RIGHTS FOLLOW THE MUSIC: EVERY DERIVATIVE CARRIES ITS SOURCES', THE LINEAGE
 * IS ONE REPORT, AND THE POLICY IS STATED WHERE IT ACTS.
 *
 * MUS-022. Set-based over four registries:
 *   ORIGINS             original, generated, licensed, public-domain, unknown —
 *                       each distinguished, and none assigned without a
 *                       declaration (a generated file is generated, not cleared)
 *   DERIVATIVE_WRITERS  generation from a source, separation, bounce, and a
 *                       DAW/package return — each records the most encumbered
 *                       status of its sources, and links them
 *   GATES × STATUSES    the warn/block policy at approval and final export,
 *                       from its stated default and from the setting that
 *                       changes it
 * Everything runs through the real writers with fake providers, so nothing
 * here spends.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-rights-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const rights = require('../lib/music-rights');
const stems = require('../lib/music-stems');
const gen = require('../lib/music-generation');
const sep = require('../lib/music-separation');
const renderer = require('../lib/music-renderer');
const musicPackage = require('../lib/music-package');
const approval = require('../lib/music-approval');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const mcp = require('../lib/mcp-tools');

const bin = () => resolveFfmpeg().bin;
function tone(hz, secs) {
    const p = path.join(os.tmpdir(), `rt_${crypto.randomUUID().slice(0, 8)}.wav`);
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p], { stdio: 'pipe', timeout: 120000 });
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}

// Fake providers: a composer that answers every generating workflow, and a separator that returns a ZIP.
const CONTRACT = {
    music_compose: { status: 'available', models: ['m1'], limits: { min_ms: 1000, max_ms: 600000, models: ['m1'], section_min_ms: 3000, section_max_ms: 120000 }, source: 'test' },
    music_parts: { status: 'available', limits: { max_parts: 4, part_roles: ['strings', 'drums', 'bass', 'piano'] }, source: 'test' },
    music_separate: { status: 'unsupported', reason: 'this fake provider does not separate recordings' },
    music_reference: { status: 'available', limits: { reference_kinds: ['audio', 'melody'], max_reference_ms: 60000 }, source: 'test' },
    music_video: { status: 'available', limits: { max_video_ms: 600000, video_formats: ['mp4', 'mov'] }, source: 'test' },
    music_inpaint: { status: 'available', limits: { max_range_ms: 30000, context_ms: 5000 }, source: 'test' },
};
const composer = { id: 'fakemusic', capabilities: ['music'], music: CONTRACT,
    async generate(cap, payload) { const s = payload.workflow === 'music_inpaint' ? (payload.range.end_ms - payload.range.start_ms) / 1000 : 2; return { ok: true, data: tone(330, s), provider_model: 'm1', provider_job_id: 'job-1' }; } };
function zipOf(entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-'));
    for (const e of entries) fs.writeFileSync(path.join(dir, e.name), e.bytes);
    const out = path.join(dir, 'x.zip');
    execFileSync('zip', ['-q', '-j', out, ...entries.map(e => path.join(dir, e.name))]);
    return fs.readFileSync(out);
}
const separator = zip => ({ id: 'elevenlabs', async generate() { return { ok: true, data: zip, mimeType: 'application/zip', provider_model: 'two_stems_v1' }; } });

async function session(opts) {
    const o = opts || {};
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, 'Rights', ?)").run(projectId, JSON.stringify({ music: 'elevenlabs' }));
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(sceneId, projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name, status, tempo_map_json) VALUES (?, ?, ?, 'S', 'review', ?)").run(sessionId, projectId, sceneId, JSON.stringify([{ at_ms: 0, bpm: 90, numerator: 4, denominator: 4 }]));
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, source, status) VALUES (?, ?, 0, 4000, 'x', 'director', 'accepted')").run(generateId(), sessionId);
    const imported = {};
    for (const [key, decl] of Object.entries(o.imports || {})) {
        const out = await stems.importStems(db, sessionId, { files: [{ name: `${key}.wav`, bytes: tone(200 + Object.keys(imported).length * 80, 2) }], rights: decl });
        assert.ok(out.ok, out.error);
        imported[key] = out.imported[0];
    }
    return { projectId, sessionId, imported };
}
const assetRow = id => db.prepare('SELECT * FROM film_assets WHERE id = ?').get(id);

// ── Origins ────────────────────────────────────────────────────────────────

test('every origin is distinguished, and none is assigned without a declaration: a generated file is generated, not cleared', async () => {
    assert.deepStrictEqual(rights.ORIGINS.slice().sort(), ['generated', 'licensed', 'original', 'public_domain', 'unknown'].sort());
    const s = await session({ imports: {
        mine: { origin: 'original', status: 'cleared', owner: 'the director' },
        bought: { origin: 'licensed', status: 'cleared', owner: 'Library Co', license_url: 'https://example.com/licence' },
        old: { origin: 'public_domain', status: 'cleared' },
        found: {},
    } });
    const g = await gen.generate(db, s.sessionId, 'music_compose', { prompt: 'a cue', duration_ms: 2000 }, { adapter: composer, wait: true });
    assert.ok(g.ok, g.error);
    const genAsset = db.prepare("SELECT id FROM film_assets WHERE project_id = ? AND license_source = 'generated'").get(s.projectId).id;
    const expect = { [s.imported.mine.asset_id]: ['original', 'cleared'], [s.imported.bought.asset_id]: ['licensed', 'cleared'],
        [s.imported.old.asset_id]: ['public_domain', 'cleared'], [s.imported.found.asset_id]: ['unknown', 'unknown'], [genAsset]: ['generated', 'unknown'] };
    for (const [id, [origin, status]] of Object.entries(expect)) {
        const n = rights.assetLineage(db, id);
        assert.strictEqual(n.origin, origin, `${n.name}: origin ${n.origin}`);
        assert.strictEqual(n.status, status, `${n.name}: status ${n.status}`);
    }
    const gRow = db.prepare("SELECT * FROM film_rights WHERE entity_id = ?").get(genAsset);
    assert.ok(gRow, 'a generated file has no rights record'); assert.strictEqual(gRow.origin, 'generated'); assert.strictEqual(gRow.status, 'unknown');
    const bad = await stems.importStems(db, s.sessionId, { files: [{ name: 'x.wav', bytes: tone(500, 1) }], rights: { origin: 'mine-probably' } });
    assert.strictEqual(bad.ok, false); assert.match(bad.error, /origin/);
});

// ── Derivatives ────────────────────────────────────────────────────────────

test('every derivative writer records the most encumbered status of its sources, links them, and the lineage stays live', async () => {
    assert.deepStrictEqual(rights.DERIVATIVE_WRITERS.map(w => w.kind).sort(), ['bounced', 'daw_returned', 'generated_from_source', 'separated'].sort());
    for (const w of rights.DERIVATIVE_WRITERS) {
        assert.match(fs.readFileSync(path.join(__dirname, '..', w.file), 'utf8'), /recordDerivative\(/, `${w.kind}: ${w.file} never records its derivative`);
    }
    const s = await session({ imports: { clean: { origin: 'licensed', status: 'cleared' }, tied: { origin: 'licensed', status: 'restricted', restrictions: 'no broadcast' } } });
    const made = {};
    // Generated from a source: an inpaint over the restricted clip.
    const inp = await gen.generate(db, s.sessionId, 'music_inpaint', { clip_id: s.imported.tied.clip_id, range: { start_ms: 200, end_ms: 1200 }, prompt: 'fix' }, { adapter: composer, wait: true });
    assert.ok(inp.ok, inp.error);
    made.generated_from_source = { id: db.prepare("SELECT id FROM film_assets WHERE project_id = ? AND license_source = 'generated' ORDER BY created_at DESC").get(s.projectId).id, sources: [s.imported.tied.asset_id], expect: 'restricted' };
    // Separated from the clean clip.
    const t = tone(300, 2);
    const sp = await sep.startSeparation(db, s.sessionId, { clip_id: s.imported.clean.clip_id, stems: 2 }, { adapter: separator(zipOf([{ name: 'vocals.mp3', bytes: t }, { name: 'instrumental.mp3', bytes: t }])), wait: true });
    assert.ok(sp.ok, sp.error);
    const sepAssets = db.prepare("SELECT id FROM film_assets WHERE project_id = ? AND metadata LIKE '%separated_stem%'").all(s.projectId);
    assert.ok(sepAssets.length === 2);
    made.separated = { id: sepAssets[0].id, sources: [s.imported.clean.asset_id], expect: 'cleared' };
    // Bounced from everything selected.
    const b = await renderer.runBounce(db, s.sessionId, {});
    assert.ok(b.ok, b.error);
    const master = renderer.listBounces(db, s.sessionId).find(x => x.current).master.asset_id;
    made.bounced = { id: master, sources: null, expect: 'restricted' };
    // DAW / package return: the package imported into a new session.
    const pkg = await musicPackage.buildPackage(db, s.sessionId, { include_picture: false });
    assert.ok(pkg.ok, pkg.error);
    const back = musicPackage.importPackage(db, s.projectId, fs.readFileSync(pkg.file_path), {});
    assert.ok(back.ok, back.error);
    const returned = db.prepare("SELECT id, license_status FROM film_assets WHERE project_id = ? AND metadata LIKE '%package_id%' AND asset_type != 'other' ORDER BY created_at DESC").all(s.projectId);
    const restrictedReturn = returned.find(r => r.license_status === 'restricted');
    assert.ok(restrictedReturn, 'no returned stem carries the restricted source status');
    made.daw_returned = { id: restrictedReturn.id, sources: null, expect: 'restricted' };

    for (const w of rights.DERIVATIVE_WRITERS) {
        const m = made[w.kind];
        assert.ok(m, `${w.kind}: not exercised`);
        const a = assetRow(m.id);
        assert.strictEqual(a.license_status, m.expect, `${w.kind}: recorded ${a.license_status}, sources say ${m.expect}`);
        const node = rights.assetLineage(db, m.id);
        assert.strictEqual(node.status, m.expect, `${w.kind}: the live lineage says ${node.status}`);
        assert.ok(node.derived_from.length >= 1, `${w.kind}: the derivative names no source`);
        if (m.sources) for (const src of m.sources) assert.ok(node.derived_from.some(d => d.asset_id === src), `${w.kind}: ${src} missing from its lineage`);
        const row = db.prepare("SELECT * FROM film_rights WHERE entity_id = ? AND origin = 'derived'").get(m.id);
        assert.ok(row, `${w.kind}: no derived rights record`);
    }
    // Live: blocking a source reaches the bounce's lineage without re-rendering anything.
    db.prepare("UPDATE film_rights SET status = 'blocked' WHERE entity_id = ?").run(s.imported.clean.asset_id);
    assert.strictEqual(rights.assetLineage(db, master).status, 'blocked');
});

// ── The report ─────────────────────────────────────────────────────────────

test('the score lineage report walks every clip and the approved mix to their sources, and names every issue', async () => {
    const s = await session({ imports: { mine: { origin: 'original', status: 'cleared' }, found: {} } });
    await renderer.runBounce(db, s.sessionId, {});
    const rep = rights.scoreLineage(db, s.sessionId);
    const clipIds = db.prepare('SELECT c.id FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ?').all(s.sessionId).map(r => r.id);
    assert.deepStrictEqual(rep.clips.map(c => c.clip_id).sort(), clipIds.sort(), 'a clip is missing from the lineage');
    for (const c of rep.clips) for (const k of ['asset_id', 'origin', 'status', 'hash', 'derived_from']) assert.ok(k in c.asset, `${c.clip_id}: no ${k}`);
    assert.strictEqual(rep.summary.origins.original, 1); assert.strictEqual(rep.summary.origins.unknown, 1);
    assert.ok(rep.issues.some(i => i.asset_id === s.imported.found.asset_id && /unknown/.test(i.reason)));
    assert.strictEqual(rep.effective_status, 'unknown');
    assert.ok(rep.mix && rep.mix.derived_from.length === 2, 'the current mix is not traced to both sources');
    const tool = mcp.presentResult(await mcp.callTool('music_score_lineage', { session_id: s.sessionId }));
    assert.strictEqual(tool.effective_status, 'unknown');
});

// ── The policy at its gates ────────────────────────────────────────────────

test('the stated default policy, over every gate and every status', () => {
    assert.deepStrictEqual(rights.GATES.slice().sort(), ['approval', 'final_export']);
    for (const gate of rights.GATES) {
        for (const status of rights.STATUSES) {
            const act = rights.DEFAULT_POLICY[gate][status];
            assert.ok(['allow', 'warn', 'block'].includes(act), `${gate}/${status}: no action`);
            if (status === 'cleared') assert.strictEqual(act, 'allow');
            if (status === 'blocked') assert.strictEqual(act, 'block', `${gate}: material a person marked blocked is not blocked`);
            if (status === 'unknown') assert.notStrictEqual(act, 'allow', `${gate}: unknown rights pass silently`);
        }
    }
    assert.ok(rights.POLICY_NOTE && /Open Question 3/.test(rights.POLICY_NOTE), 'the default does not say it is a default pending the decision');
});

test('approval and final export act on the policy: block refuses with the items, warn passes and says so, an override is recorded, and the setting changes it', async () => {
    const s = await session({ imports: { hot: { origin: 'licensed', status: 'blocked' } } });
    await renderer.runBounce(db, s.sessionId, {});
    const refused = approval.approveMix(db, s.sessionId);
    assert.strictEqual(refused.ok, false); assert.strictEqual(refused.code, 'RIGHTS_BLOCKED');
    assert.ok(refused.items.some(i => i.status === 'blocked'));
    const forced = approval.approveMix(db, s.sessionId, { ignore_rights: true });
    assert.ok(forced.ok, forced.error);
    const op = db.prepare("SELECT params_json FROM film_music_operations WHERE session_id = ? AND kind = 'approve' ORDER BY created_at DESC").get(s.sessionId);
    assert.match(op.params_json, /ignore_rights/);

    // Final export: the conform refuses before encoding anything.
    const conform = require('../lib/conform');
    const shotScene = db.prepare('SELECT scene_id FROM film_music_sessions WHERE id = ?').get(s.sessionId).scene_id;
    const shotId = generateId();
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, '1A', '{}', 2000)").run(shotId, shotScene);
    const clipDir = path.join(process.env.FILM_DATA_DIR, 'video', s.projectId); fs.mkdirSync(clipDir, { recursive: true });
    const clip = path.join(clipDir, '1A.mp4');
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { stdio: 'pipe', timeout: 120000 });
    db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'video_raw', ?, '1A.mp4', 'mp4', 2000)").run(generateId(), s.projectId, shotId, clip);
    const out = await conform.runConform(s.projectId, { filename: 'rights_master' });
    assert.strictEqual(out.ok, false); assert.strictEqual(out.state, 'rights_blocked'); assert.match(out.error, /blocked/);
    assert.ok(!fs.existsSync(path.join(process.env.FILM_DATA_DIR, 'video', s.projectId, 'rights_master.mp4')), 'the master was encoded anyway');
    const { CONFORM_STATES } = require('../routes/pipeline');
    assert.ok(CONFORM_STATES.rights_blocked && CONFORM_STATES.rights_blocked.permanent === true);
    const pf = require('../lib/export-package').preflightExport({ id: s.projectId }, [{ id: shotId, shot_code: '1A', duration_ms: 2000 }], [], { rights: rights.evaluateProject(db, s.projectId, 'final_export') });
    assert.ok(pf.blocking.some(b => b.code === 'SCORE_RIGHTS'), 'the export preflight does not block on the score');
    const passed = await conform.runConform(s.projectId, { filename: 'rights_master', ignore_rights: true });
    assert.ok(passed.ok, passed.error);

    // Warn: a restricted source approves, with the warning.
    const w = await session({ imports: { tied: { origin: 'licensed', status: 'restricted' } } });
    await renderer.runBounce(db, w.sessionId, {});
    const ok = approval.approveMix(db, w.sessionId);
    assert.ok(ok.ok, ok.error); assert.ok(ok.warnings.some(x => /restricted/.test(x)));

    // The setting changes the policy; a bad one is refused.
    const settings = require('../routes/app-settings');
    const put = body => new Promise(resolve => settings.handleAppSettings({ method: 'PUT', body, url: '/film/settings' }, { writeHead(st) { this.s = st; }, end(p) { resolve({ status: this.s, body: JSON.parse(p || '{}') }); } }, ['film', 'settings'], {}));
    const refusedPolicy = await put({ music_rights_policy: JSON.stringify({ approval: { unknown: 'perhaps' } }) });
    assert.strictEqual(refusedPolicy.status, 400); assert.match(refusedPolicy.body.error, /music_rights_policy/);
    const stricter = await put({ music_rights_policy: JSON.stringify({ approval: { restricted: 'block' } }) });
    assert.strictEqual(stricter.status, 200);
    db.prepare("UPDATE film_music_sessions SET status = 'review', approved_mix_asset_id = NULL WHERE id = ?").run(w.sessionId);
    assert.strictEqual(approval.approveMix(db, w.sessionId).code, 'RIGHTS_BLOCKED');
    await put({ music_rights_policy: '' });
});
