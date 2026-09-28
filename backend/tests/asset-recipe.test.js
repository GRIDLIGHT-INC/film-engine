/**
 * PGN-013 — how a version was made.
 *
 * One read per version: provider, model, prompt, negative prompt, the
 * references it was made from (with thumbnails), seed, size, tier, whether its
 * inputs are still current, the render-ledger row, what it cost, and when.
 * Served on the existing provenance route as `recipe`, beside the disclosure
 * manifest that route already returns.
 *
 * Nothing is guessed. A fact that cannot be found is listed in `unknown`; a
 * fact matched by time rather than by identity says so (`ledger_match`,
 * `cost_match`). Set-based over the declared RECIPE_FIELDS, across a frame, a
 * clip and a sound.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-rcp2-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const recipe = require('../lib/asset-recipe');

const P = generateId(), SC = generateId(), SH = generateId(), CUE = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Recipe')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', ?)").run(SH, SC, JSON.stringify({ description: 'A woman waits.' }));
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type) VALUES (?, ?, ?, 'score')").run(CUE, P, SC);

const dir = path.join(process.env.FILM_DATA_DIR, 'storyboards', P);
fs.mkdirSync(dir, { recursive: true });
const plateId = generateId();
const platePath = path.join(dir, 'plate.png'); fs.writeFileSync(platePath, 'x');
db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_name, file_path, version) VALUES (?, ?, 'reference_image', 'plate.png', ?, 1)`).run(plateId, P, platePath);

const frameId = generateId();
const framePath = path.join(dir, '1A.png'); fs.writeFileSync(framePath, 'x');
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_name, file_path, version, provider, provider_model,
    metadata, input_refs, input_fingerprint, artefact_kind, created_at)
    VALUES (?, ?, ?, ?, 'storyboard', '1A.png', ?, 1, 'muapi', 'nano-banana-pro', ?, ?, 'an-old-fingerprint', 'keyframe', '2026-09-28 10:00:00')`)
    .run(frameId, P, SH, SC, framePath, JSON.stringify({ tier: 'standard', width: 2048, height: 1152 }), JSON.stringify([plateId]));
db.prepare(`INSERT INTO render_ledger (id, shot_id, version, step, model_id, seed, prompt, negative_prompt, output_path, resolution, created_at)
    VALUES (?, ?, 1, 'keyframe', 'nano-banana-pro', 1234, 'A woman waits at a bus stop', 'text, watermark', ?, '2048x1152', '2026-09-28 10:00:02')`)
    .run(generateId(), SH, framePath);
db.prepare(`INSERT INTO film_cost_entries (id, project_id, cost_type, description, amount, currency, model_used, shot_id, created_at)
    VALUES (?, ?, 'image_generation', 'frame', 0.12, 'USD', 'nano-banana-pro', ?, '2026-09-28 10:00:03')`).run(generateId(), P, SH);

const clipId = generateId();
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_name, file_path, version, provider, provider_model, created_at)
    VALUES (?, ?, ?, ?, 'video_raw', '1A.mp4', '/tmp/1A.mp4', 1, 'runway', 'gen4.5', '2026-09-28 11:00:00')`).run(clipId, P, SH, SC);
const soundId = generateId();
db.prepare(`INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_name, file_path, version, created_at, metadata)
    VALUES (?, ?, ?, 'audio_music', 'score.mp3', '/tmp/score.mp3', 1, '2026-09-28 12:00:00', ?)`).run(soundId, P, SC, JSON.stringify({ music_cue_id: CUE }));

test('every declared field is present on every recipe, known or listed as unknown — for a frame, a clip and a sound', () => {
    assert.ok(recipe.RECIPE_FIELDS.length >= 10);
    for (const id of [frameId, clipId, soundId]) {
        const r = recipe.assetRecipe(db, id);
        assert.ok(r, `no recipe for ${id}`);
        for (const f of recipe.RECIPE_FIELDS) {
            assert.ok(f in r, `${f} missing from the recipe`);
            const isUnknown = r[f] === null || (Array.isArray(r[f]) && !r[f].length);
            assert.equal(r.unknown.includes(f), isUnknown, `${f}: unknown list disagrees with the value`);
        }
    }
});

test('a frame: everything the ledger, the row, the references and the meter know', () => {
    const r = recipe.assetRecipe(db, frameId);
    assert.equal(r.provider, 'muapi');
    assert.equal(r.model, 'nano-banana-pro');
    assert.equal(r.prompt, 'A woman waits at a bus stop');
    assert.equal(r.negative_prompt, 'text, watermark');
    assert.equal(r.seed, 1234);
    assert.equal(r.size, '2048x1152');
    assert.equal(r.tier, 'standard');
    assert.equal(r.references.length, 1);
    assert.equal(r.references[0].asset_id, plateId);
    assert.match(r.references[0].thumb || '', /plate\.png/);
    assert.equal(r.fingerprint.state, 'behind', 'a frame stamped from other inputs is behind');
    assert.equal(r.ledger_match, 'exact');
    assert.equal(r.cost.amount, 0.12);
    assert.equal(r.cost_match, 'nearest');
    assert.equal(r.made_at, '2026-09-28 10:00:00');
});

test('a clip with no ledger row and no stamp: those facts are unknown, never borrowed from the frame', () => {
    const r = recipe.assetRecipe(db, clipId);
    assert.equal(r.provider, 'runway');
    assert.equal(r.model, 'gen4.5');
    assert.equal(r.prompt, null, 'the frame\'s ledger prompt was borrowed for the clip');
    assert.ok(r.unknown.includes('prompt'));
    assert.equal(r.fingerprint.state, 'untracked');
    assert.equal(r.ledger_match, null);
    assert.equal(r.cost, null, 'the frame\'s cost from an hour earlier was borrowed for the clip');
});

test('a sound made outside the tracked paths is almost all unknown, and says so', () => {
    const r = recipe.assetRecipe(db, soundId);
    for (const f of ['provider', 'model', 'prompt', 'seed']) assert.ok(r.unknown.includes(f), `${f} not reported unknown`);
    assert.equal(r.fingerprint.state, 'untracked');
});

test('an unknown asset has no recipe; the route answers 404, and a real one carries the recipe beside the manifest', async () => {
    assert.equal(recipe.assetRecipe(db, generateId()), null);
    const { handleAssets } = require('../routes/assets');
    let status = 0, body = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
    await handleAssets({ method: 'GET' }, res, ['film', 'assets', frameId, 'provenance'], {});
    assert.equal(status, 200);
    assert.ok(body.recipe, 'no recipe on the provenance route');
    assert.equal(body.recipe.prompt, 'A woman waits at a bus stop');
    assert.equal(body.manifest.format, 'film-engine-ai-provenance-sidecar', 'the disclosure manifest was replaced rather than kept');
    await handleAssets({ method: 'GET' }, res, ['film', 'assets', generateId(), 'provenance'], {});
    assert.equal(status, 404);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
