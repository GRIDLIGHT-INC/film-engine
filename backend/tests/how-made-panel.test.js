/**
 * PGN-014 — how was this made, make another, compare.
 *
 * The version drawer (and the shot drawer, for frames) shows the recipe a
 * version was made from: every RECIPE_FIELD, the unknown ones named plainly
 * rather than left out, a time-matched fact marked as such.
 *
 * "Make another like this" opens the ONE shared confirmation pre-filled with
 * that version's prompt, and sends its seed only where the provider honours a
 * seed — a seed sent to a provider that ignores it is a promise of "the same
 * again" nobody can keep. References are the shot's own current plates (the
 * route gathers them), and the plan says so.
 *
 * "Compare with selected" is an A/B wipe for frames and clips; sound has no
 * wipe and is not offered one.
 *
 * Set-based over RECIPE_FIELDS, over the version kinds (frame, clip, sound),
 * and over seed honoured / not honoured / not recorded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-hm-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const recipeLib = require('../lib/asset-recipe');
const providers = require('../lib/providers');

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
const ESC = `const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
    const pgSrc = u => u; const jsAttr = s => JSON.stringify(String(s)).replace(/"/g, '&quot;');`;
function page(names) {
    for (const n of names) assert.ok(fnSource(n), `${n} is not defined on the page`);
    return new Function(`${ESC} ${names.map(fnSource).join('\n')}; return { ${names.join(', ')} };`)();
}

// ---- the recipe knows whether its seed would be honoured -------------------------
const P = generateId(), SC = generateId(), SH = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'HowMade')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(SH, SC);
function asset(provider, meta) {
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_name, file_path, version, provider, metadata)
        VALUES (?, ?, ?, ?, 'storyboard', 'x.png', ?, 1, ?, ?)`).run(id, P, SH, SC, '/tmp/' + id + '.png', provider, JSON.stringify(meta || {}));
    return id;
}

test('the recipe says whether the provider honours a seed — from the adapter, never assumed', () => {
    const seeded = providers.list().filter(a => a.supportsSeed === true).map(a => a.id);
    const unseeded = providers.list().filter(a => a.supportsSeed === false).map(a => a.id);
    assert.ok(seeded.length && unseeded.length, 'need an adapter each way to prove anything');
    for (const p of seeded) assert.equal(recipeLib.assetRecipe(db, asset(p, { seed: 7 })).seed_honoured, true, p);
    for (const p of unseeded) assert.equal(recipeLib.assetRecipe(db, asset(p, { seed: 7 })).seed_honoured, false, p);
    assert.equal(recipeLib.assetRecipe(db, asset(null, {})).seed_honoured, null, 'an uploaded file has no provider to ask');
});

// ---- the panel ---------------------------------------------------------------------
const full = {
    asset_id: 'a1', provider: 'bfl', model: 'flux-2-pro', prompt: 'A woman waits at a bus stop', negative_prompt: 'text',
    references: [{ asset_id: 'r1', file_name: 'plate.png', thumb: '/film/storyboards/p/plate.png' }],
    seed: 1234, seed_honoured: true, size: '2048x1152', tier: 'standard',
    fingerprint: { state: 'behind' }, ledger: { id: 'l1', step: 'keyframe', version: 1 },
    cost: { amount: 0.12, currency: 'USD' }, made_at: '2026-09-28 10:00:00',
    ledger_match: 'exact', cost_match: 'nearest', unknown: [],
};

test('every recipe field has a place in the panel; unknown ones are NAMED, not dropped', () => {
    const { pgRecipeHtml } = page(['pgRecipeHtml']);
    const html = pgRecipeHtml(full);
    for (const needle of ['bfl', 'flux-2-pro', 'A woman waits', 'text', 'plate.png', '1234', '2048x1152', 'standard', 'behind', '0.12', '2026-09-28 10:00:00'])
        assert.ok(html.includes(needle), `${needle} not shown`);
    assert.match(html, /matched by time/i, 'a cost matched by time is shown as if it were exact');
    assert.match(html, /\?w=96/, 'reference thumbnails fetch the full-size plate');

    const empty = Object.fromEntries(recipeLib.RECIPE_FIELDS.map(f => [f, f === 'references' ? [] : null]));
    const none = pgRecipeHtml(Object.assign(empty, { asset_id: 'a2', unknown: recipeLib.RECIPE_FIELDS.slice() }));
    assert.match(none, /not recorded/i);
    for (const f of recipeLib.RECIPE_FIELDS) assert.ok(none.includes(f.replace(/_/g, ' ')), `unknown ${f} was left out rather than named`);
});

test('a seed the provider ignores is shown with that said, never as a promise', () => {
    const { pgRecipeHtml } = page(['pgRecipeHtml']);
    assert.match(pgRecipeHtml(Object.assign({}, full, { provider: 'muapi', seed_honoured: false })), /ignor|not honou?red/i);
});

// ---- make another --------------------------------------------------------------------
test('make another: frame and clip go through their own generate route with the prompt pre-filled; the seed travels only where honoured', () => {
    const { pgMakeAnotherPlan } = page(['pgMakeAnotherPlan']);
    const shot = { type: 'shot', id: 'S1', shot_code: '1A' };
    const cases = [
        { kind: 'frame', url: '/shots/S1/storyboard/regenerate', preview: '/shots/S1/prompt', cap: 'image' },
        { kind: 'video', url: '/shots/S1/video/generate', preview: '/shots/S1/video/preview', cap: 'video' },
    ];
    for (const c of cases) {
        for (const honoured of [true, false, null]) {
            const plan = pgMakeAnotherPlan(Object.assign({}, full, { seed_honoured: honoured }), c.kind, shot);
            assert.ok(!plan.refused, `${c.kind}: refused`);
            assert.equal(plan.url, c.url); assert.equal(plan.previewUrl, c.preview); assert.equal(plan.capability, c.cap);
            assert.equal(plan.prefill, full.prompt, `${c.kind}: not pre-filled with the version's prompt`);
            if (honoured === true) assert.equal(plan.body.seed, 1234, `${c.kind}: an honoured seed was not sent`);
            else assert.ok(!('seed' in plan.body), `${c.kind}: a seed sent to a provider that ${honoured === false ? 'ignores it' : 'nobody asked'}`);
            if (honoured === false) assert.ok(plan.notes.some(n => /seed/i.test(n)), 'dropping the seed is silent');
            assert.ok(plan.notes.some(n => /reference|plate/i.test(n)), 'where the references come from is not said');
        }
    }
});

test('make another refuses honestly where it cannot reproduce: a sound, a sequence clip, a version with no recorded prompt', () => {
    const { pgMakeAnotherPlan } = page(['pgMakeAnotherPlan']);
    assert.ok(pgMakeAnotherPlan(full, 'audio', { type: 'sound', id: 'C1' }).refused);
    assert.ok(pgMakeAnotherPlan(full, 'video', { type: 'sequence', id: 'Q1' }).refused);
    const r = pgMakeAnotherPlan(Object.assign({}, full, { prompt: null }), 'frame', { type: 'shot', id: 'S1' });
    assert.match(String(r.refused || ''), /prompt/i);
});

test('the confirmation can be pre-filled: the version\'s prompt is offered, and counts as an override against today\'s', () => {
    const src = fnSource('confirmPaidImage');
    assert.match(src, /o\.prefill/);
    assert.match(src, /CONFIRM_GEN_PROMPT\s*=\s*prompt\b|CONFIRM_GEN_PROMPT\s*=\s*d\.prompt/);
    assert.match(src, /CONFIRM_GEN_EDITED\s*=\s*[^;]*o\.prefill/, 'a pre-filled prompt is not sent as an override');
    const run = fnSource('pgMakeAnother');
    assert.match(run, /confirmPaidImage\(/); assert.match(run, /prefill/); assert.match(run, /pgMakeAnotherPlan\(/);
});

// ---- compare -------------------------------------------------------------------------
test('compare is an A/B wipe for frames and clips, with both labelled; a sound gets none', () => {
    const { pgCompareHtml } = page(['pgCompareHtml']);
    for (const kind of ['image', 'video']) {
        const html = pgCompareHtml({ kind, url: '/a', label: 'v3' }, { kind, url: '/b', label: 'v5 selected' });
        assert.ok(html.includes('/a') && html.includes('/b'));
        assert.ok(html.includes('v3') && html.includes('v5 selected'));
        assert.match(html, /type="range"[^>]*pgWipe\(/, `${kind}: no wipe control`);
        assert.match(html, new RegExp(kind === 'image' ? '<img' : '<video'));
    }
    assert.equal(pgCompareHtml({ kind: 'audio', url: '/a' }, { kind: 'audio', url: '/b' }), '');
    assert.match(fnSource('pgWipe'), /clip-path|clipPath/);
});

test('the drawers wire it in: version drawer and shot drawer load the recipe, offer make-another and compare-with-selected', () => {
    for (const d of ['pgDrawerVersion', 'pgDrawerShot']) {
        const src = fnSource(d);
        assert.match(src, /id="pgHowMade"/, `${d}: no how-was-this-made panel`);
        assert.match(src, /pgLoadHowMade\(/, `${d}: the panel is never filled`);
    }
    assert.match(fnSource('pgLoadHowMade'), /\/assets\/.*provenance/);
    assert.match(fnSource('pgDrawerVersion'), /pgCompareSelected\(/);
    assert.match(fnSource('pgDrawerShot'), /pgCompareSelected\(/);
    assert.match(fnSource('pgCompareSelected'), /pgCompareHtml\(/);
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
