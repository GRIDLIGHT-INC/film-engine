const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const crypto = require('crypto');

/**
 * THE DAW PANEL: CONNECTION, PORTABLE PACKAGES, PUSH AND PULL REVIEW,
 * PROGRESS, CONFLICTS, AUDIT AND RECOVERY — AND AN EDITOR THAT DOES NOT CARE
 * WHETHER A DAW IS THERE.
 *
 * MUS-019. Set-based over the DAW contract's own operations
 * (`DAW_OPERATIONS`): every operation has an action on the Score page, bound
 * to a control, reaching its own route, and every action names a PORTABLE
 * equivalent that works with no DAW at all — export a package, import one,
 * validate one, or the workstation's own playback. The panel's renderer is
 * EXECUTED across every connection state the engine can report (unconfigured,
 * unreachable, not the reviewed version, connected), because a template that
 * mentions "conflict" and a template that lets a person decide one look
 * identical in the source.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-dawui-' + crypto.randomUUID().slice(0, 8));

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const { DAW_OPERATIONS } = require('../lib/daw-adapter');

function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('{', m.index), depth = 0;
    for (let j = i; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
const dawNames = () => [...new Set([...SPA.matchAll(/function\s+(daw[A-Z][\w$]*)\s*\(/g)].map(m => m[1]))];
function actions() {
    const m = /const DAW_ACTIONS = (\[[\s\S]*?\n    \]);/.exec(SPA);
    assert.ok(m, 'no DAW_ACTIONS registry on the page');
    // A JSON round trip: arrays made in another realm are not deepStrictEqual to ours.
    return JSON.parse(JSON.stringify(vm.runInNewContext(`(${m[1]})`)));
}
/** A function plus the daw helpers it calls, one level down. */
function withHelpers(name) {
    const own = fnSource(name) || '';
    const called = [...new Set([...own.matchAll(/\b(daw[A-Z][\w$]*)\s*\(/g)].map(x => x[1]).filter(n => n !== name))];
    return [own, ...called.map(fnSource).filter(Boolean)].join('\n');
}

/** The panel's renderers, run in a sandbox. */
function sandbox() {
    const ctx = { MW: { session: { id: 'sess-1' }, playheadMs: 3000, daw: null }, console };
    ctx.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    ctx.mwTime = ms => (ms / 1000).toFixed(1) + 's';
    ctx.API_BASE = 'http://x';
    vm.createContext(ctx);
    const m = /const DAW_ACTIONS = (\[[\s\S]*?\n    \]);/.exec(SPA);
    vm.runInContext(`var DAW_ADAPTER = 'ableton'; var DAW_ACTIONS = ${m[1]};`, ctx);
    for (const n of dawNames()) {
        const src = fnSource(n);
        if (/\bawait\b|\bapi\(/.test(src)) continue; // renderers only
        vm.runInContext(src, ctx);
    }
    return ctx;
}
const base = over => Object.assign({ status: null, error: null, plan: null, resolutions: {}, pullPlan: null, audit: [], busy: null, result: null, pkg: null, loaded: true }, over || {});
const CONNECTED = { ok: true, connected: true, compatible: true, version: '12.4', pin: '0ca6821', reason: null };

// ── The registry ───────────────────────────────────────────────────────────

test('every operation of the DAW contract has an action on the page, and every action has a portable equivalent that needs no DAW', () => {
    const list = actions();
    assert.deepStrictEqual(list.map(a => a.op).sort(), Object.keys(DAW_OPERATIONS).sort(), 'an operation has no action on the page');
    const reach = {
        status: /\/daw\/'\s*\+\s*DAW_ADAPTER\s*\+\s*'\/status|\/status'/, session_read: /\/session'/, push_plan: /\/push\/plan'/,
        push: /\/push'[\s\S]*method:\s*'POST'/, pull_plan: /\/pull\/plan'/, pull: /\/pull'[\s\S]*method:\s*'POST'/, transport: /\/transport'[\s\S]*supervised:\s*true/,
    };
    for (const a of list) {
        assert.ok(a.label && a.what && a.what.length > 15, `${a.op}: no label or explanation`);
        assert.ok(fnSource(a.fn), `${a.op}: its handler ${a.fn} is not on the page`);
        assert.match(withHelpers(a.fn), reach[a.op], `${a.op}: ${a.fn} does not reach its own route`);
        assert.ok(a.portable && a.portable.fn && a.portable.label, `${a.op}: no portable equivalent`);
        assert.ok(fnSource(a.portable.fn), `${a.op}: the portable path ${a.portable.fn} is not on the page`);
    }
    assert.match(fnSource('dawExportPackage'), /\/package'[\s\S]*method:\s*'POST'/);
    assert.match(withHelpers('dawImportPackage'), /\/music-packages\/import/);
    assert.match(withHelpers('dawImportPackage'), /validate_only:\s*true/, 'a package is imported without being validated first');
    assert.match(withHelpers('dawImportPackage'), /checkUploadSize\(/, 'an oversize package would read as a dead server');
});

// ── Every state the engine can report ──────────────────────────────────────

const STATES = {
    unconfigured: base({ status: null, error: 'the Ableton sidecar is not configured: start it (node backend/ableton-sidecar.js) and give this server the same ABLETON_SIDECAR_TOKEN — see docs/ableton-sidecar.md', unconfigured: true }),
    unreachable: base({ status: { ok: false, connected: false, error: 'the Ableton sidecar at http://127.0.0.1:3190 is not reachable (fetch failed)' } }),
    live_down: base({ status: { ok: true, connected: false, compatible: false, reason: 'Live did not complete the handshake — is Live running, with AbletonOSC selected?' } }),
    incompatible: base({ status: { ok: true, connected: true, compatible: false, version: '11.3', reason: 'Live 11.3 is not the reviewed version (12.4, build 12.4.5); reads are allowed and every change is refused' } }),
    connected: base({ status: CONNECTED }),
};

test('in every connection state the panel says where it stands and what to do, and the portable package path is always offered', () => {
    const ctx = sandbox();
    for (const [name, d] of Object.entries(STATES)) {
        const html = ctx.dawPanelHtml(d);
        assert.ok(typeof html === 'string' && html.length > 100, `${name}: nothing rendered`);
        assert.match(html, /onclick="dawExportPackage\(\)"/, `${name}: no way to export a package`);
        assert.match(html, /dawImportPackage\(/, `${name}: no way to import a package`);
        assert.match(html, /onclick="dawRefresh\(\)"/, `${name}: no way to check again`);
        const connected = d.status && d.status.connected && d.status.compatible;
        const push = /<button[^>]*onclick="dawPlanPush\(\)"[^>]*>/.exec(html);
        assert.ok(push, `${name}: no push control`);
        assert.strictEqual(/disabled/.test(push[0]), !connected, `${name}: push is ${connected ? 'disabled while connected' : 'enabled without a compatible Live'}`);
    }
    const g = n => ctx.dawPanelHtml(STATES[n]);
    assert.match(g('unconfigured'), /ABLETON_SIDECAR_TOKEN/); assert.match(g('unconfigured'), /ableton-sidecar\.md/);
    assert.match(g('unreachable'), /sidecar/i); assert.match(g('unreachable'), /node backend\/ableton-sidecar\.js/);
    assert.match(g('live_down'), /AbletonOSC/); assert.match(g('live_down'), /Control Surface/i);
    assert.match(g('incompatible'), /11\.3/); assert.match(g('incompatible'), /reads? only|can be read/i);
    assert.match(g('connected'), /12\.4/); assert.match(g('connected'), /0ca6821/);
    assert.match(g('unconfigured'), /editor|workstation/i, 'the panel does not say the editor still works');
});

test('a push plan is reviewed as a diff, every conflict is decided by a person, and nothing is pushed until each is', () => {
    const ctx = sandbox();
    const plan = { ok: true, plan_fingerprint: 'fp1', instructions: [{ fe_key: 'fe:track:a', name: 'strings', action: 'create' }, { fe_key: 'fe:track:b', name: 'drums', action: 'update', external_id: 'fe:1234567890' }],
        conflicts: [{ fe_key: 'fe:track:c', name: 'pads', external_id: 'fe:abcdefabcd', reason: 'changed in the DAW since Film Engine last wrote it (revision r1 → r2)', choices: ['overwrite', 'keep_daw'] },
            { fe_key: 'fe:track:d', name: 'bass', external_id: 'fe:0000000000', reason: 'the DAW no longer attributes it to Film Engine (owner live)' }],
        untouched: [{ external_id: 'live:0', name: 'Keys (the composer\'s)', owner: 'live' }], orphans: [{ external_id: 'fe:9999999999', name: 'old', reason: 'no track in the session any more' }], notes: [] };
    const html = ctx.dawPanelHtml(base({ status: CONNECTED, plan }));
    for (const s of ['strings', 'drums', 'pads', 'bass', 'Keys (the composer', 'old']) assert.ok(html.includes(s), `${s} is not in the diff`);
    assert.match(html, /create/); assert.match(html, /update/); assert.match(html, /left alone|untouched/i);
    const sel = [...html.matchAll(/<select[^>]*onchange="dawResolve\('([^']+)',\s*this\.value\)"[^>]*>([\s\S]*?)<\/select>/g)];
    assert.deepStrictEqual(sel.map(s => s[1]).sort(), ['fe:track:c', 'fe:track:d'], 'a conflict cannot be decided on the page');
    const forD = sel.find(s => s[1] === 'fe:track:d')[2];
    assert.ok(!/value="overwrite"/.test(forD), 'Film Engine offers to overwrite a track it does not own');
    const btn = h => /<button[^>]*onclick="dawPush\(\)"[^>]*>/.exec(h);
    assert.match(btn(html)[0], /disabled/, 'push offered while conflicts are undecided');
    const decided = ctx.dawPanelHtml(base({ status: CONNECTED, plan, resolutions: { 'fe:track:c': 'overwrite', 'fe:track:d': 'keep_daw' } }));
    assert.ok(!/disabled/.test(btn(decided)[0]), 'push still disabled after every conflict was decided');
});

test('operation progress, the result with its manual audio step, the pull review, and the audit with recovery guidance', () => {
    const ctx = sandbox();
    const busy = ctx.dawPanelHtml(base({ status: CONNECTED, busy: 'push' }));
    assert.match(busy, /Pushing/i);
    for (const fn of ['dawPlanPush', 'dawPlanPull']) {
        const b = new RegExp(`<button[^>]*onclick="${fn}\\(\\)"[^>]*>`).exec(busy);
        assert.match(b[0], /disabled/, `${fn} can be pressed again while an operation runs`);
    }
    const done = ctx.dawPanelHtml(base({ status: CONNECTED, result: { op: 'push', ok: true, applied: [{ fe_key: 'fe:track:a', external_id: 'fe:1', action: 'create', audio: 'manual', stem_path: 'stems/01_strings.wav', place_at: '1.1.1' }] } }));
    assert.match(done, /stems\/01_strings\.wav/); assert.match(done, /1\.1\.1/);

    const noPull = ctx.dawPanelHtml(base({ status: CONNECTED, pullPlan: { ok: true, items: [], unavailable: 'AbletonOSC cannot export a render; bring stems back through the score package import' } }));
    assert.match(noPull, /cannot export a render/); assert.match(noPull, /dawImportPackage\(/);
    const pull = ctx.dawPanelHtml(base({ status: CONNECTED, pullPlan: { ok: true, items: [{ item_id: 'render-abc', kind: 'stems', sha256: 'f'.repeat(64), bytes: 1000, already_pulled: false }, { item_id: 'render-old', sha256: 'e'.repeat(64), already_pulled: true }] } }));
    assert.match(pull, /onclick="dawPull\('render-abc'\)"/);
    assert.ok(!/onclick="dawPull\('render-old'\)"/.test(pull), 'a render already pulled is offered again');

    const audit = [
        { operation_id: 'op1', op: 'push', adapter_id: 'ableton', status: 'complete', duration_ms: 812, completed_at: '2026-09-11 10:00:00' },
        { operation_id: 'op2', op: 'push', adapter_id: 'ableton', status: 'failed', idempotency_key: 'k9', error: 'push timed out after 120000 ms: the outcome is unknown — the DAW may have applied part of it. Read the session, then retry with the same idempotency key (k9); it cannot apply twice.' },
        { operation_id: 'op3', op: 'transport', adapter_id: 'ableton', status: 'failed', error: 'transport was refused by the DAW: nope' },
    ];
    const a = ctx.dawPanelHtml(base({ status: CONNECTED, audit }));
    for (const r of audit) assert.ok(a.includes(r.op) && a.includes(r.status), `${r.operation_id} missing from the audit`);
    assert.match(a, /812/);
    assert.match(a, /outcome is unknown/); assert.match(a, /onclick="dawPlanPush\(\)"[^>]*>[^<]*(again|Re-plan)/i, 'a push with an unknown outcome offers no way to recover');
    assert.match(a, /never created twice|cannot apply twice/i);
});

// ── The editor does not depend on the DAW ──────────────────────────────────

test('the editor loads and renders with no DAW: the panel is fetched after, painted in its own region, and its failures stay there', () => {
    const load = fnSource('mwLoadSession');
    assert.ok(!/Promise\.all\([\s\S]*\/daw\//.test(load), 'the session waits on the DAW before it renders');
    assert.match(load, /dawRefresh\(\)/, 'the panel is never loaded');
    assert.ok(!/await\s+dawRefresh/.test(load), 'the editor waits for the DAW');
    assert.match(fnSource('mwRender'), /id="mwDaw"/, 'the panel has no region of its own');
    const refresh = fnSource('dawRefresh');
    assert.match(refresh, /catch/, 'a DAW failure is not caught');
    for (const n of dawNames()) assert.ok(!/\bmwRender\(/.test(fnSource(n)), `${n} repaints the whole editor for a DAW change`);
    assert.match(fnSource('dawPaint'), /getElementById\('mwDaw'\)/);
});

// ── The audit route and tool ───────────────────────────────────────────────

test('the audit is readable with no DAW configured, over HTTP and as a tool', async () => {
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const mcp = require('../lib/mcp-tools');
    const saved = process.env.ABLETON_SIDECAR_TOKEN; delete process.env.ABLETON_SIDECAR_TOKEN;
    try {
        const pid = generateId(), sid = generateId();
        db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'DawUi')").run(pid);
        db.prepare("INSERT INTO film_music_sessions (id, project_id, name) VALUES (?, ?, 'S')").run(sid, pid);
        const r = mcp.presentResult(await mcp.callTool('music_daw_audit', { session_id: sid, adapter: 'ableton' }));
        assert.ok(r && Array.isArray(r.audit), JSON.stringify(r));
        assert.strictEqual(r.adapter_id, 'ableton');
        const bad = mcp.presentResult(await mcp.callTool('music_daw_audit', { session_id: sid, adapter: 'protools-nope' }));
        assert.strictEqual(bad.status, 404);
    } finally { if (saved) process.env.ABLETON_SIDECAR_TOKEN = saved; }
});
