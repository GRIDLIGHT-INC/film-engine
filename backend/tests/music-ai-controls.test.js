const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * EVERY AI ACTION ON THE SCORE PAGE: A FREE PLAN FIRST, A CONFIRMED SPEND,
 * AND A PLAIN "NO" WITH THE PROVIDER'S REASON.
 *
 * MUS-014. The workstation can generate, separate, inpaint and regenerate —
 * over HTTP and MCP. This puts those actions in front of the director, and
 * holds every one of them to three things, set-based over the page's own
 * action registry and over the capability registry's workflows:
 *
 *   1. a spending action goes through the ONE shared confirmation, which reads
 *      the free plan first and shows the provider, the inputs, the length, the
 *      outputs, the cost and what happens to the takes already there — and it
 *      says it is working while it runs;
 *   2. an action the project's provider cannot do is DISABLED WITH THE
 *      PROVIDER'S OWN REASON, never hidden and never attempted; an action that
 *      needs a selection says what to select;
 *   3. a free action (proposing the arc is the connected agent's job, A/B
 *      audition, approving a take) reaches no paid endpoint.
 *
 * The renderers are EXECUTED against real plans the backend produced, because
 * a template that names `cost_hint` and a template that shows the cost look
 * identical in the source.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR || path.join(require('os').tmpdir(), 'film-engine-aictl-' + process.pid + '-' + Date.now());

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const caps = require('../lib/music-capabilities');

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
const strip = s => (s || '').split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

function actions() {
    const m = /const SCORE_AI_ACTIONS = (\[[\s\S]*?\n    \]);/.exec(SPA);
    assert.ok(m, 'no SCORE_AI_ACTIONS registry on the page');
    return vm.runInNewContext(`(${m[1]})`);
}
/** A function's body plus the bodies of the scoreAi helpers it calls, one level down. */
function withHelpers(name) {
    const own = fnSource(name) || '';
    const called = [...new Set([...own.matchAll(/\b(scoreAi[A-Z][\w$]*)\s*\(/g)].map(x => x[1]).filter(n => n !== name))];
    return [own, ...called.map(fnSource).filter(Boolean)].join('\n');
}
const PAID = /api\(\s*[^)]*(\/generate'|\/generate`|\/separations'|\/separations`|\/retry'|\/retry`)[^)]*method:\s*'POST'/;

// ── The registry ───────────────────────────────────────────────────────────

test('the action registry covers every action the epic names and every workflow the capability registry declares', () => {
    const list = actions();
    const ids = list.map(a => a.id);
    // The epic's own list, word for word: emotion proposal, whole score,
    // selected track/section, separation, reference generation, inpainting,
    // regenerate-as-new-take, A/B audition, take approval.
    for (const id of ['emotion', 'compose', 'section', 'separate', 'reference', 'inpaint', 'regenerate', 'audition', 'approve']) {
        assert.ok(ids.includes(id), `no '${id}' action on the page`);
    }
    for (const wf of Object.keys(caps.WORKFLOWS)) {
        assert.ok(list.some(a => a.workflow === wf), `the ${wf} workflow has no control — a capability with no control does not exist`);
    }
    for (const a of list) {
        assert.ok(a.label && a.what && a.what.length > 15, `${a.id}: no label or no explanation`);
        assert.strictEqual(typeof a.spends, 'boolean', `${a.id}: does not say whether it spends`);
        assert.ok(fnSource(a.fn), `${a.id}: its handler ${a.fn} is not on the page`);
        assert.ok(a.workflow === null || caps.WORKFLOWS[a.workflow], `${a.id}: ${a.workflow} is not a workflow`);
    }
});

test('every spending action goes through the shared confirmation and shows it is working; every free one reaches nothing paid', () => {
    for (const a of actions()) {
        const src = strip(withHelpers(a.fn));
        if (a.spends) {
            assert.match(src, /confirmPaidImage\(/, `${a.id}: spends without the shared confirmation`);
            assert.match(src, /previewUrl:/, `${a.id}: the confirmation is not handed the free plan`);
            assert.match(src, /describe:\s*scoreAi/, `${a.id}: the confirmation does not say what the plan contains`);
            assert.match(src, /setStatus\([^;]*,\s*true\s*\)/, `${a.id}: gives no sign it is working`);
            assert.ok(PAID.test(src), `${a.id}: claims to spend and posts to nothing paid`);
        } else {
            assert.ok(!PAID.test(src), `${a.id}: a free action posts to a paid endpoint`);
            assert.ok(!/confirmPaidImage\(/.test(src), `${a.id}: a free action asks to spend`);
        }
    }
    // Retrying a failed job spends too, and is gated the same way.
    const retry = strip(fnSource('scoreAiRetry'));
    assert.match(retry, /confirmPaidImage\(/); assert.match(retry, /setStatus\([^;]*,\s*true\s*\)/);
    assert.ok(!/\/retry/.test(strip(fnSource('scoreAiPoll') || '')), 'polling a job retries it');
});

test('the shared confirmation can read a POST plan and describe it, and still refuses to arm when the plan cannot be read', () => {
    const gate = fnSource('confirmPaidImage');
    assert.match(gate, /previewBody/, 'the confirmation cannot send a plan body');
    assert.match(gate, /method:\s*'POST'/, 'a plan body is not POSTed');
    assert.match(gate, /o\.describe/, 'the confirmation cannot describe a plan');
    // The disarm on a failed read is the existing rule; it must still come before any arming.
    const failed = gate.indexOf('Could not read what would be sent');
    assert.ok(failed > -1 && gate.indexOf('confirmGenArm(false)', failed) > failed, 'a failed plan read does not keep the gate disarmed');
});

// ── Unsupported is explained; missing selection is explained ──────────────

function panelSandbox(capsFixture, selection) {
    const model = {
        session: { id: 'S1', name: 'S', status: 'draft' },
        tracks: [{ id: 'T1', name: 'score', clips: [
            { id: 'C1', name: 'take 1', asset_id: 'A1', source_operation_id: 'OP1', start_ms: 0, duration_ms: 8000, source_offset_ms: 0, take_group: 'g', take_status: 'selected' },
            { id: 'C2', name: 'take 2', asset_id: 'A2', source_operation_id: 'OP1', start_ms: 0, duration_ms: 8000, source_offset_ms: 0, take_group: 'g', take_status: 'candidate' },
        ], automation: [] }],
        markers: [], emotion_ranges: [{ id: 'E1', start_ms: 0, end_ms: 4000, label: 'dread', status: 'accepted' }], operations: [], duration_ms: 8000,
    };
    const src = `
        function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
        ${/const SCORE_AI_ACTIONS = (\[[\s\S]*?\n    \]);/.exec(SPA)[0]}
        const MW = { model: ${JSON.stringify(model)}, session: { id: 'S1' }, selection: ${JSON.stringify(selection)}, capabilities: ${JSON.stringify(capsFixture)}, playheadMs: 1000, jobs: [] };
        ${['mwFindRow', 'mwTrackOf', 'mwTime', 'scoreAiPanelHtml', 'scoreAiNeed', 'scoreAiCapability'].map(n => { const f = fnSource(n); assert.ok(f, `no ${n}`); return f; }).join('\n')}
        out = scoreAiPanelHtml(MW.capabilities);`;
    const ctx = { out: null };
    vm.runInNewContext(src, ctx);
    return ctx.out;
}
function capsWith(status) {
    return { provider: { id: 'prov' }, workflows: Object.keys(caps.WORKFLOWS).map(w => ({ workflow: w, status: status(w), reason: status(w) === 'available' ? null : `prov cannot ${w} because of reason-${w}` })) };
}
const buttonOf = (html, id) => {
    const m = new RegExp(`<button[^>]*data-ai-action="${id}"[^>]*>`).exec(html);
    assert.ok(m, `no button for ${id}`);
    return m[0];
};
const reasonNear = (html, id) => {
    const at = html.indexOf(`data-ai-action="${id}"`);
    return html.slice(at, html.indexOf('</div>', at) + 6);
};

test('every workflow action is disabled with the provider\'s own reason when unsupported, and enabled when available', () => {
    const list = actions();
    const sel = { kind: 'clips', id: 'C1' };
    for (const wf of Object.keys(caps.WORKFLOWS)) {
        const offHtml = panelSandbox(capsWith(w => (w === wf ? 'unsupported' : 'available')), sel);
        const onHtml = panelSandbox(capsWith(() => 'available'), sel);
        for (const a of list.filter(x => x.workflow === wf)) {
            assert.match(buttonOf(offHtml, a.id), /disabled/, `${a.id}: enabled while ${wf} is unsupported`);
            assert.ok(reasonNear(offHtml, a.id).includes(`reason-${wf}`), `${a.id}: the provider's reason is not shown`);
            assert.ok(!/disabled/.test(buttonOf(onHtml, a.id)), `${a.id}: disabled while ${wf} is available and a clip is selected`);
        }
    }
});

test('an action that needs a selection says what to select, and every action says whether it spends', () => {
    const html = panelSandbox(capsWith(() => 'available'), null);
    for (const a of actions()) {
        const b = buttonOf(html, a.id);
        if (a.needs) {
            assert.match(b, /disabled/, `${a.id}: enabled with nothing selected`);
            assert.match(reasonNear(html, a.id), /select/i, `${a.id}: does not say what to select`);
        }
        assert.match(reasonNear(html, a.id), a.spends ? /spends|costs/i : /free/i, `${a.id}: does not say whether it spends`);
    }
});

// ── The plan the director reads before spending ────────────────────────────

test('the confirmation shows the exact provider, inputs, length, outputs, cost and take behaviour of a real generation plan', () => {
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const gen = require('../lib/music-generation');
    const pid = generateId(), sid = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, 'AI', ?)").run(pid, JSON.stringify({ music: 'elevenlabs' }));
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name, tempo_map_json) VALUES (?, ?, 'S', ?)").run(sid, pid, JSON.stringify([{ at_ms: 0, bpm: 84, numerator: 3, denominator: 4 }]));
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 0, 9000, 'longing', 0.1, 0.3, 0.6, 'director', 'accepted')").run(generateId(), sid);
    const plan = gen.publicPlan(gen.planGeneration(db, sid, 'music_compose', { prompt: 'solo cello under the goodbye', duration_ms: 9000, key: 'E minor' }));
    assert.strictEqual(plan.ok, true, plan.error);

    const src = `function esc(s) { return String(s === undefined || s === null ? '' : s); }
        ${['mwTime', 'scoreAiUsd', 'scoreAiPlanHtml'].map(fnSource).join('\n')}
        out = scoreAiPlanHtml(${JSON.stringify(plan)});`;
    const ctx = { out: null }; vm.runInNewContext(src, ctx);
    const html = ctx.out;
    for (const [what, needle] of [['provider', plan.provider.id], ['model', plan.provider.model], ['prompt', 'solo cello under the goodbye'], ['key', 'E minor'],
        ['tempo', '84'], ['emotion', 'longing'], ['output kind', plan.outputs.kind], ['output count', String(plan.outputs.count)], ['take behaviour', 'candidate'], ['takes kept', 'kept']]) {
        assert.ok(html.includes(needle), `the confirmation does not show the ${what} (${needle})`);
    }
    assert.match(html, /0:09|9\.0\s*s|9 s/, 'the confirmation does not show the length');
    assert.match(html, /\$\d/, 'the confirmation does not show the cost');

    // A separation plan and a failed job read the same way.
    const sepPlan = { ok: true, provider: { id: 'elevenlabs', model: 'six_stems_v1' }, variation: { id: 'six_stems_v1', stems: 6, cost_multiplier: 1, inferred: true }, expected_stems: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
        source: { file_name: 'mix.wav', duration_ms: 4000 }, placement: { start_ms: 0, source_offset_ms: 0, duration_ms: 4000 }, cost_hint: { usd: 0.01, note: 'held at the full music rate' }, writes: 'one separate operation; on success 6 assets…' };
    const job = { operation_id: 'J', kind: 'generate', workflow: 'music_parts', status: 'failed', attempt: 1, reason: 'child #1 (drums) failed: not audio', provider: 'p', children: [{ seq: 0, label: 'strings', status: 'cancelled' }, { seq: 1, label: 'drums', status: 'failed', error_message: 'not audio' }] };
    const src2 = `function esc(s) { return String(s === undefined || s === null ? '' : s); }
        ${['mwTime', 'scoreAiUsd', 'scoreAiSeparationPlanHtml', 'scoreAiRetryHtml'].map(n => { const f = fnSource(n); assert.ok(f, `no ${n}`); return f; }).join('\n')}
        out = [scoreAiSeparationPlanHtml(${JSON.stringify(sepPlan)}), scoreAiRetryHtml(${JSON.stringify(job)})];`;
    const c2 = { out: null }; vm.runInNewContext(src2, c2);
    for (const needle of ['six_stems_v1', 'vocals', 'guitar', 'mix.wav', '$0.01', 'full music rate', 'untouched']) assert.ok(c2.out[0].includes(needle), `the separation confirmation does not show ${needle}`);
    for (const needle of ['attempt 2', 'drums', 'not audio']) assert.ok(c2.out[1].includes(needle), `the retry confirmation does not show ${needle}`);
});

// ── Jobs, takes, A/B ───────────────────────────────────────────────────────

test('the jobs panel shows every job with its children, take numbers and acceptance, and offers poll and retry where they apply', () => {
    const jobs = [
        { operation_id: 'J1', kind: 'generate', workflow: 'music_compose', status: 'complete', attempt: 1, cost_usd: 0.02, provider: 'elevenlabs', children: [{ seq: 0, label: 'compose', status: 'complete', take_number: 2, acceptance: 'pending' }] },
        { operation_id: 'J2', kind: 'separate', workflow: 'music_separate', status: 'failed', attempt: 1, reason: 'no outputs', provider: 'elevenlabs', children: [] },
        { operation_id: 'J3', kind: 'generate', workflow: 'music_parts', status: 'running', attempt: 1, provider: 'elevenlabs', children: [{ seq: 0, label: 'strings', status: 'running' }] },
    ];
    const src = `function esc(s) { return String(s === undefined || s === null ? '' : s); }
        ${['scoreAiJobsHtml'].map(n => { const f = fnSource(n); assert.ok(f, `no ${n}`); return f; }).join('\n')}
        out = scoreAiJobsHtml(${JSON.stringify(jobs)});`;
    const ctx = { out: null }; vm.runInNewContext(src, ctx);
    const html = ctx.out;
    assert.match(html, /take 2/); assert.match(html, /pending/);
    assert.match(html, /scoreAiRetry\('J2'\)/, 'a failed job offers no retry');
    assert.ok(!/scoreAiRetry\('J1'\)/.test(html) && !/scoreAiRetry\('J3'\)/.test(html), 'a job that has not failed offers a retry');
    assert.match(html, /scoreAiPoll\('J3'\)/, 'a running job offers no poll');
    assert.match(html, /no outputs/, 'a failed job does not say why');
});

test('A/B audition changes what is HEARD, not what is saved, and approving a take is the explicit act', () => {
    const heard = fnSource('mwHeard');
    assert.ok(heard, 'no mwHeard: playback cannot audition a take without selecting it');
    const play = strip(fnSource('mwPlay'));
    assert.match(play, /mwHeard\(/, 'playback does not ask which take is heard');
    const ctx = {};
    vm.runInNewContext(`const MW = { audition: { group: 'g', clipId: 'C2' } }; ${heard}
        out = [mwHeard({ id: 'C1', take_group: 'g', take_status: 'selected' }), mwHeard({ id: 'C2', take_group: 'g', take_status: 'candidate' }),
               mwHeard({ id: 'C9', take_group: 'other', take_status: 'selected' }), mwHeard({ id: 'C8', take_group: 'other', take_status: 'candidate' })];
        MW.audition = null;
        out.push(mwHeard({ id: 'C1', take_group: 'g', take_status: 'selected' }), mwHeard({ id: 'C2', take_group: 'g', take_status: 'candidate' }));`, ctx);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.out)), [false, true, true, false, true, false]);
    const audition = strip(fnSource('scoreAiAudition'));
    assert.ok(!/api\(/.test(audition), 'auditioning a take saves something');
    assert.match(strip(fnSource('scoreAiApprove')), /mwChooseTake\(|take_status/, 'approving does not select the take');
});

test('the Score page draws the AI panel and the jobs, and loads the jobs with the session', () => {
    assert.match(strip(fnSource('mwRender')), /scoreAiPanelHtml\(/, 'the AI panel is not drawn');
    assert.match(strip(fnSource('mwRender')), /scoreAiJobsHtml\(/, 'the jobs are not drawn');
    assert.match(strip(fnSource('mwLoadSession')), /\/jobs/, 'the jobs are not loaded with the session');
    // The editing and playback functions still spend nothing; spending lives in scoreAi*.
    const mwAll = [...SPA.matchAll(/(?:async\s+)?function\s+(mw[A-Z][\w$]*)\s*\(/g)].map(m => fnSource(m[1])).join('\n');
    assert.ok(!/\/generate\b|\/separations\b|\/retry\b/.test(strip(mwAll)), 'a mw* editing function reaches a paid endpoint');
});
