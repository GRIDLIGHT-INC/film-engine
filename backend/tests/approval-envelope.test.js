const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-approval-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const envelope = require('../lib/approval-envelope');
const guard = require('../lib/approval-guard');
const { handleApprovals } = require('../routes/approvals');
const { callRoute } = require('../lib/mcp-tools');
const { fingerprintFor } = require('../lib/artefact-fingerprint');

const REPO = path.join(__dirname, '..', '..');
const DATA = process.env.FILM_DATA_DIR;

// ── fixtures ────────────────────────────────────────────────────────────────

function makeShot(opts) {
    const o = opts || {};
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)')
        .run(projectId, o.title || 'Approval Test');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)')
        .run(sceneId, projectId, '1', o.location || 'A DINER - DAY');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, o.code || '1A', JSON.stringify(o.card || {
            description: 'A man at a counter.', characters: ['RAY'], camera: {},
        }));
    return { projectId, sceneId, shotId };
}

function frame(shotId, projectId, version, meta, opts) {
    const o = opts || {};
    const dir = path.join(DATA, 'storyboards', projectId, 'versions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `f${version}.png`);
    if (o.onDisk !== false) fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name,
                                         version, metadata)
                VALUES (?, ?, ?, 'storyboard', ?, ?, ?, ?)`)
        .run(generateId(), projectId, shotId, file, `f${version}.png`, version,
             JSON.stringify(meta || {}));
    return file;
}

// callRoute is (method, url, BODY, handler) — passing the handler third
// silently routes to the flows default and 404s.
const get = (url) => callRoute('GET', url, {}, handleApprovals);

// ══ the envelope shape ══════════════════════════════════════════════════════

test('an envelope is free, side-effect-free, and says how media travels', async () => {
    const { shotId } = makeShot({});
    const r = await get(`/film/shots/${shotId}/approval-envelope?action=image`);
    assert.strictEqual(r._status, 200, JSON.stringify(r.body).slice(0, 200));
    const e = r.body;
    assert.strictEqual(e.kind, 'pre_spend');
    assert.strictEqual(e.free, true, 'an envelope that spends could not be raised speculatively');
    assert.strictEqual(e.media.transport, 'path',
        'the envelope does not say how media travels — the assumption that breaks silently');
    assert.ok(e.expires_hint_s > 0, 'no expiry hint');
});

/*
 * The warning that matters most: a subject with no plate will be invented, and
 * invented DIFFERENTLY in every shot it appears in. That is invisible in a
 * thumbnail and it changes the answer.
 */
test('an envelope for a shot with no plate warns, naming the missing plate', () => {
    const e = envelope.preSpendEnvelope({ missingPlates: ['SEDAN', 'MAYA'] });
    const w = e.warnings.find(x => x.id === 'missing_plate');
    assert.ok(w, 'no warning for a subject with no plate');
    assert.match(w.detail, /SEDAN/, 'the warning does not name which plate is missing');
    assert.match(w.detail, /MAYA/, 'the warning names only the first missing plate');
});

test('prompt.truncated_tail is non-empty when the prompt exceeds the ceiling', () => {
    const over = envelope.preSpendEnvelope({
        prompt: { text: 'x'.repeat(500), chars: 500, ceiling: 400, truncated_tail: 'the lost tail' },
    });
    assert.ok(over.prompt.truncated_tail, 'an over-ceiling prompt reports no truncated tail');
    assert.ok(over.warnings.some(w => w.id === 'prompt_truncated'),
        'an over-ceiling prompt raises no warning');

    const under = envelope.preSpendEnvelope({
        prompt: { text: 'short', chars: 5, ceiling: 400 },
    });
    assert.strictEqual(under.prompt.truncated_tail, null,
        'a prompt that fits reported a truncated tail');
    assert.ok(!under.warnings.some(w => w.id === 'prompt_truncated'));
});

test('every media item path exists and is inside the project data dir', async () => {
    const { projectId, shotId } = makeShot({});
    const file = frame(shotId, projectId, 1, {});
    const e = envelope.preSpendEnvelope({ media: [{ role: 'keyframe', path: file }] });
    assert.strictEqual(e.media.items.length, 1);
    for (const item of e.media.items) {
        assert.ok(fs.existsSync(item.path), `${item.path} does not exist`);
        assert.ok(path.resolve(item.path).startsWith(path.resolve(DATA)),
            `${item.path} is outside the data directory`);
        assert.ok(item.bytes > 0, 'a media item carries no size');
        assert.strictEqual(item.mime, 'image/png');
    }
});

/*
 * A path that does not resolve is DROPPED, not carried. An item whose file is
 * absent produces a broken attachment wherever it lands, which reads as the
 * packet being wrong rather than the file being gone.
 */
test('a media path that does not resolve is dropped, not carried', () => {
    const e = envelope.preSpendEnvelope({
        media: [{ role: 'keyframe', path: '/nowhere/at/all.png' }],
    });
    assert.deepStrictEqual(e.media.items, []);
});

/* Every warning is declared. An undeclared id would render as an unexplained
 * string that no consumer could rank. */
test('warnings come from the registry and each says what it means', () => {
    assert.ok(envelope.WARNINGS.length >= 6);
    for (const w of envelope.WARNINGS) {
        assert.ok(w.id && w.why, `warning ${w.id} does not say why it matters`);
        assert.ok(['info', 'warn', 'block'].includes(w.severity),
            `warning ${w.id} has severity '${w.severity}'`);
    }
    assert.throws(() => envelope.warning('not_a_real_warning'), /undeclared warning/,
        'an undeclared warning id was accepted');
});

// ══ the fingerprint ═════════════════════════════════════════════════════════

/*
 * The fingerprint is what makes an approval given at 22:00 still mean something
 * at 22:40. It must move when the shot moves and stay put when unrelated rows
 * change — a fingerprint that moved on any write would refuse every approval,
 * which is how the guard gets switched off.
 */
test('the fingerprint changes when the shot changes and not when unrelated rows do', () => {
    const a = makeShot({ code: '2A' });
    const before = fingerprintFor('scene_card', { shotId: a.shotId });
    assert.ok(before, 'no fingerprint for a fresh shot');

    // An unrelated shot in another project.
    makeShot({ code: '9Z', title: 'Somewhere else' });
    assert.strictEqual(fingerprintFor('scene_card', { shotId: a.shotId }), before,
        'an unrelated row moved this shot\'s fingerprint');

    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ description: 'He stands and leaves.', camera: {} }), a.shotId);
    assert.notStrictEqual(fingerprintFor('scene_card', { shotId: a.shotId }), before,
        'editing the card did not move the fingerprint');
});

// ══ the guard — the most important item ═════════════════════════════════════

test('an approval whose fingerprint no longer matches is refused', () => {
    const { shotId } = makeShot({ code: '3A' });
    const current = fingerprintFor('scene_card', { shotId });

    const ok = guard.checkApproval(
        { approval_fingerprint: current, approval_kind: 'scene_card' }, { shotId });
    assert.strictEqual(ok.ok, true, 'a current approval was refused');

    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ description: 'Something else entirely.', camera: {} }), shotId);

    const stale = guard.checkApproval(
        { approval_fingerprint: current, approval_kind: 'scene_card' }, { shotId });
    assert.strictEqual(stale.ok, false, 'an approval outlived its inputs and was honoured');
    assert.strictEqual(stale.code, 'STALE_APPROVAL');
    assert.strictEqual(stale.status, 409);
    assert.ok(stale.remedy, 'the refusal names no way forward');
    assert.strictEqual(stale.approved_fingerprint, current);
    assert.notStrictEqual(stale.current_fingerprint, current);
});

test('a request carrying no approval is not checked, and stays free', () => {
    const out = guard.checkApproval({}, { shotId: 'anything' });
    assert.deepStrictEqual(out, { ok: true, checked: false });
});

test('an approval that names nothing is refused rather than waved through', () => {
    const out = guard.checkApproval({ approval_fingerprint: 'x' }, {});
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'STALE_APPROVAL');
});

test('an approval against an unknown artefact kind is refused, not assumed', () => {
    const out = guard.checkApproval(
        { approval_fingerprint: 'x', approval_kind: 'not_a_kind' }, { shotId: 'a' });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /does not know/);
});

/*
 * The guard runs at the DISPATCH, once. Wired per paid route it would be wired
 * into most of them, and the one it missed is the one that runs unapproved
 * work — the reasoning that put metering in resolve() and the body limit in the
 * URL shape.
 */
test('the guard runs at the single dispatch point, not per route', () => {
    const server = fs.readFileSync(path.join(REPO, 'backend', 'server.js'), 'utf8');
    assert.match(server, /approvalGuard\.checkApproval/,
        'server.js does not re-check approvals');
    assert.match(server, /approvalGuard\.subjectOf\(parts\)/,
        'the guard does not derive its subject from the URL');

    // And no route re-implements it: two guards is two answers.
    const routes = fs.readdirSync(path.join(REPO, 'backend', 'routes'))
        .filter(f => f.endsWith('.js'));
    for (const f of routes) {
        const src = fs.readFileSync(path.join(REPO, 'backend', 'routes', f), 'utf8');
        assert.ok(!/checkApproval/.test(src),
            `${f} re-checks approvals — the guard must live in one place`);
    }
});

// ══ the per-run ceiling ═════════════════════════════════════════════════════

test('a run over its own max_credits is refused before anything generates', () => {
    const { projectId } = makeShot({ code: '4A' });
    const { buildRunPlan } = require('../lib/run-plan');

    const free = buildRunPlan(projectId, {});
    assert.strictEqual(free.run_ceiling, null,
        'a plan with no ceiling reported one — an absent ceiling must not become zero');

    const generous = buildRunPlan(projectId, { max_credits: 1e9 });
    assert.strictEqual(generous.run_ceiling.exceeded, false);
    assert.strictEqual(generous.refused, false);

    const mean = buildRunPlan(projectId, { max_credits: 1e-9 });
    if (mean.projected_cost > 0) {
        assert.strictEqual(mean.run_ceiling.exceeded, true);
        assert.strictEqual(mean.refused, true, 'a run over its ceiling was not refused');
        assert.match(mean.run_ceiling.reason, /nothing has been spent/,
            'the refusal does not say the run was stopped before spending');
    }
});

/*
 * `ignore_budget` lifts the PROJECT budget, which is the director overruling
 * their own total. It must not lift a ceiling the caller handed in with the
 * request — a run that could wave away its own limit was given none.
 */
test('ignore_budget does not lift the per-run ceiling', () => {
    const { projectId, shotId } = makeShot({ code: '5A' });
    frame(shotId, projectId, 1, {});
    const { buildRunPlan } = require('../lib/run-plan');
    const plan = buildRunPlan(projectId, { max_credits: 1e-9, ignore_budget: true });
    if (plan.projected_cost > 0) {
        assert.strictEqual(plan.refused, true,
            'ignore_budget waved away the ceiling the caller set for this run');
    }
});

// ══ reachability and the boundary ═══════════════════════════════════════════

test('both decision packets are on the MCP surface', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = new Set(listTools().map(t => t.name));
    for (const n of ['approval_envelope', 'take_candidates']) {
        assert.ok(names.has(n), `${n} has no MCP tool`);
    }
});

/*
 * THE INTEGRATION BOUNDARY.
 *
 * Film Engine emits decision packets and does not know what renders them. No
 * orchestrator, chat platform, scheduler or approval system may be named — not
 * in code, not in a config default, not in a tool description. A field shaped
 * for one consumer is how a general packet quietly becomes that consumer's
 * private format.
 */
test('no external consumer is named anywhere in the codebase', () => {
    /*
     * Bound to INTEGRATION references, not to English.
     *
     * The first version matched the bare word `slack` and reported three files
     * that use it for a numeric tolerance — "131 characters of slack". A check
     * that cries wolf three times out of five is one nobody runs again, and it
     * would have taken the one real hit with it: two migrations named an
     * external orchestrator in a comment, which is exactly what this forbids.
     */
    const NAMES = /\b(discord|telegram|neoncore|slack_?(?:api|bot|channel|webhook|workspace))\b/i
    const CONFIG = /\b(bot_token|webhook_url|channel_id|slack_token|discord_token)\b/i;
    /*
     * Scoped to what the rule is actually about: CODE, CONFIG AND TOOL
     * DESCRIPTIONS — the three places a name would mean this engine had been
     * shaped for one consumer. A test or an assessment that CITES another
     * system as prior art is neither; forbidding that would be forbidding
     * comparison, and the check would be switched off for saying so.
     */
    const roots = ['lib', 'routes', 'db'];
    const offenders = [];
    for (const root of roots) {
        const dir = path.join(REPO, 'backend', root);
        for (const f of walk(dir)) {
            const src = fs.readFileSync(f, 'utf8');
            if (NAMES.test(src) || CONFIG.test(src)) offenders.push(path.relative(REPO, f));
        }
    }
    // Tool descriptions travel to a model and are part of the surface.
    for (const t of require('../lib/mcp-tools').listTools()) {
        const text = `${t.name} ${t.description || ''} ${JSON.stringify(t.schema || {})}`;
        if (NAMES.test(text) || CONFIG.test(text)) offenders.push(`tool:${t.name}`);
    }
    assert.deepStrictEqual(offenders, [],
        `these name an external consumer: ${offenders.join(', ')}`);
    assert.ok(walk(path.join(REPO, 'backend', 'lib')).length > 50,
        'the scan found almost no files — it is not reading the codebase');
});

function walk(dir) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.js') || e.name.endsWith('.sql')) out.push(p);
    }
    return out;
}
