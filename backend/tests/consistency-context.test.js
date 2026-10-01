const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR || path.join(os.tmpdir(), 'film-engine-consistency-context');

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
const { saveFile } = require('../lib/file-storage');
const {
    REF_ROLES,
    auditShotReadiness,
    auditProjectReadiness,
    buildShotReferencePayload,
    applyConsistencyToImagePayload,
    applyConsistencyToVoicePayload,
    recordConsistencyCheck,
} = require('../lib/consistency-context');

function insertProject() {
    const id = generateId();
    db.prepare('INSERT INTO film_projects (id, title, style_preset) VALUES (?, ?, ?)').run(id, 'Consistency Test', 'cinematic');
    return db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);
}

function insertScene(projectId, location) {
    const id = generateId();
    db.prepare(
        'INSERT INTO film_scenes (id, project_id, scene_number, location, status) VALUES (?, ?, 1, ?, ?)'
    ).run(id, projectId, location, 'written');
    return db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(id);
}

function insertShot(sceneId, sceneCard) {
    const id = generateId();
    db.prepare(
        'INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, ?)'
    ).run(id, sceneId, '1A', JSON.stringify(sceneCard), 4000);
    return db.prepare('SELECT * FROM film_shots WHERE id = ?').get(id);
}

function insertCharacter(projectId, name) {
    const id = generateId();
    db.prepare(
        'INSERT INTO film_characters (id, project_id, name, appearance_prompt, voice_profile_id) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, name, `${name} exact wardrobe`, '');
    return db.prepare('SELECT * FROM film_characters WHERE id = ?').get(id);
}

function insertLocation(projectId, name) {
    const id = generateId();
    db.prepare(
        'INSERT INTO film_locations (id, project_id, name, description) VALUES (?, ?, ?, ?)'
    ).run(id, projectId, name, `${name} production design`);
    return db.prepare('SELECT * FROM film_locations WHERE id = ?').get(id);
}

function insertProp(projectId, name) {
    const id = generateId();
    db.prepare(
        'INSERT INTO film_props (id, project_id, name, description, visual_prompt) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, name, `${name} practical details`, `${name} exact silhouette`);
    return db.prepare('SELECT * FROM film_props WHERE id = ?').get(id);
}

function insertAsset(projectId, fields) {
    const id = generateId();
    db.prepare(
        `INSERT INTO film_assets (
            id, project_id, shot_id, character_id, location_id, asset_type,
            file_path, file_name, format, mime_type, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id, projectId, fields.shot_id || null, fields.character_id || null, fields.location_id || null,
        fields.asset_type || 'reference_image', fields.file_path || `/tmp/${id}.png`, fields.file_name || `${id}.png`,
        fields.format || 'png', fields.mime_type || 'image/png', JSON.stringify(fields.metadata || {})
    );
    return db.prepare('SELECT * FROM film_assets WHERE id = ?').get(id);
}

function insertProfile(projectId, fields) {
    const id = generateId();
    db.prepare(
        `INSERT INTO film_consistency_profiles (
            id, project_id, profile_type, subject_id, subject_name, status,
            canonical_asset_id, prompt_contract, negative_contract, provider,
            provider_model, locked_seed, reference_weight, required_roles, settings, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id, projectId, fields.profile_type, fields.subject_id || '', fields.subject_name || '',
        fields.status || 'locked', fields.canonical_asset_id || null, fields.prompt_contract || '',
        fields.negative_contract || '', fields.provider || '', fields.provider_model || '',
        fields.locked_seed === undefined ? null : fields.locked_seed,
        fields.reference_weight === undefined ? 0.7 : fields.reference_weight,
        JSON.stringify(fields.required_roles || []), JSON.stringify(fields.settings || {}), fields.notes || ''
    );
    return db.prepare('SELECT * FROM film_consistency_profiles WHERE id = ?').get(id);
}

function insertConsistencyRef(projectId, profileId, assetId, fields = {}) {
    const id = generateId();
    db.prepare(
        `INSERT INTO film_consistency_refs (id, project_id, profile_id, asset_id, ref_role, weight, is_required, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, profileId, assetId, fields.ref_role || 'canonical',
        fields.weight === undefined ? 0.7 : fields.weight, fields.is_required ? 1 : 0, fields.notes || '');
    return db.prepare('SELECT * FROM film_consistency_refs WHERE id = ?').get(id);
}

describe('consistency-context', () => {
    before(() => {
        ensureSchema();
    });

    it('reports missing locked profiles for production shots', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Ada');
        insertLocation(project.id, 'Lab');
        const scene = insertScene(project.id, 'Lab');
        const shot = insertShot(scene.id, {
            characters: [{ name: character.name }],
            dialogue: [{ character: character.name, line: 'Keep the pattern stable.' }],
            camera: { shot_type: 'close-up' },
        });

        const audit = auditShotReadiness(shot, scene, project);
        assert.equal(audit.ready, false);
        assert.ok(audit.missing.some(m => m.includes('Ada')));
        assert.ok(audit.missing.some(m => m.includes('Lab')));
        assert.ok(audit.warnings.some(w => w.includes('voice')));
    });

    it('builds locked reference payloads and applies them to image payloads', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Mara');
        const location = insertLocation(project.id, 'Atrium');
        const scene = insertScene(project.id, 'Atrium');
        const shot = insertShot(scene.id, {
            characters: ['Mara'],
            action: 'Mara crosses the atrium.',
            camera: { shot_type: 'medium' },
        });
        const charAsset = insertAsset(project.id, { character_id: character.id, file_path: '/refs/mara-front.png', metadata: { role: 'front' } });
        const locAsset = insertAsset(project.id, { location_id: location.id, file_path: '/refs/atrium-wide.png' });
        insertProfile(project.id, {
            profile_type: 'character',
            subject_id: character.id,
            subject_name: character.name,
            canonical_asset_id: charAsset.id,
            prompt_contract: 'Mara must keep the same face, hair, red coat, and proportions',
            negative_contract: 'different actor, changed costume',
            locked_seed: 4242,
            reference_weight: 0.82,
        });
        insertProfile(project.id, {
            profile_type: 'location',
            subject_id: location.id,
            subject_name: location.name,
            canonical_asset_id: locAsset.id,
            prompt_contract: 'Atrium layout, glass roof, brass railings remain fixed',
            reference_weight: 0.55,
        });

        const context = buildShotReferencePayload(shot, scene, project);
        assert.equal(context.references.length, 2);
        assert.deepEqual(context.input_refs.sort(), [charAsset.id, locAsset.id].sort());
        assert.equal(context.locked_seed, 4242);
        assert.ok(context.prompt_additions.some(p => p.includes('red coat')));

        const payload = applyConsistencyToImagePayload({ prompt: 'base prompt', negative_prompt: 'bad hands' }, context);
        assert.match(payload.prompt, /base prompt/);
        // Mara's locked picture travels, so her contract is not sent: a subject
        // sent as a picture is not described (2026-10-01).
        assert.doesNotMatch(payload.prompt, /red coat/);
        // Without her picture in the request, the contract is all there is.
        const noPicture = applyConsistencyToImagePayload(
            { prompt: 'base prompt', reference_images: [{ name: 'SOMEONE ELSE', kind: 'character' }] }, context);
        assert.match(noPicture.prompt, /red coat/);
        assert.match(payload.negative_prompt, /different actor/);
        assert.equal(payload.seed, 4242);
        assert.equal(payload.ip_adapter_image, '/refs/mara-front.png');
        assert.equal(payload.ip_adapter_weight, 0.82);
        assert.deepEqual(payload.input_refs.sort(), [charAsset.id, locAsset.id].sort());
    });

    it('applies locked voice settings by character', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Nia');
        const scene = insertScene(project.id, '');
        const shot = insertShot(scene.id, {
            characters: ['Nia'],
            dialogue: [{ character: 'Nia', line: 'Same voice, every time.' }],
        });
        insertProfile(project.id, {
            profile_type: 'voice',
            subject_id: character.id,
            subject_name: character.name,
            provider: 'elevenlabs',
            provider_model: 'eleven_multilingual_v2',
            settings: {
                voice_profile_id: 'profile-1',
                voice_id: 'voice-locked',
                language: 'en',
                speed: 0.95,
                stability: 0.8,
            },
        });

        const context = buildShotReferencePayload(shot, scene, project);
        const payload = applyConsistencyToVoicePayload({ text: 'Same voice, every time.', character_name: 'Nia' }, context);
        assert.equal(payload.voice_id, 'voice-locked');
        assert.equal(payload.language, 'en');
        assert.equal(payload.speed, 0.95);
        assert.equal(payload.stability, 0.8);
        assert.equal(payload.consistency_profile_id, context.voice.by_character.NIA.profile_id);
    });

    it('audits a whole project from shot rows', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Sol');
        const location = insertLocation(project.id, 'Bridge');
        const scene = insertScene(project.id, 'Bridge');
        insertShot(scene.id, { characters: ['Sol'], camera: { shot_type: 'wide' } });
        const charAsset = insertAsset(project.id, { character_id: character.id });
        const locAsset = insertAsset(project.id, { location_id: location.id });
        insertProfile(project.id, { profile_type: 'character', subject_id: character.id, subject_name: character.name, canonical_asset_id: charAsset.id });
        insertProfile(project.id, { profile_type: 'location', subject_id: location.id, subject_name: location.name, canonical_asset_id: locAsset.id });

        const audit = auditProjectReadiness(project.id);
        assert.equal(audit.ready, true);
        assert.equal(audit.shots.length, 1);
        assert.deepEqual(audit.missing, []);
    });

    it('includes locked prop profiles in shot references and readiness', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Vera');
        const location = insertLocation(project.id, 'Hangar');
        const prop = insertProp(project.id, 'Compass');
        const scene = insertScene(project.id, 'Hangar');
        const shot = insertShot(scene.id, {
            characters: ['Vera'],
            props: [{ name: 'Compass' }],
            action: 'Vera raises the compass.',
        });
        const charAsset = insertAsset(project.id, { character_id: character.id });
        const locAsset = insertAsset(project.id, { location_id: location.id });
        const propAsset = insertAsset(project.id, { metadata: { prop_id: prop.id }, file_path: '/refs/compass.png' });
        insertProfile(project.id, { profile_type: 'character', subject_id: character.id, subject_name: character.name, canonical_asset_id: charAsset.id });
        insertProfile(project.id, { profile_type: 'location', subject_id: location.id, subject_name: location.name, canonical_asset_id: locAsset.id });
        insertProfile(project.id, {
            profile_type: 'prop',
            subject_id: prop.id,
            subject_name: prop.name,
            canonical_asset_id: propAsset.id,
            prompt_contract: 'Compass always has a cracked brass case and blue needle',
        });

        const audit = auditShotReadiness(shot, scene, project);
        assert.equal(audit.ready, true);
        const context = buildShotReferencePayload(shot, scene, project);
        assert.ok(context.input_refs.includes(propAsset.id));
        assert.ok(context.prompt_additions.some(p => p.includes('cracked brass')));
        assert.ok(context.references.some(r => r.profile_type === 'prop' && r.subject_name === 'Compass'));
    });

    it('flags registry props that have no locked profile', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Ivo');
        const location = insertLocation(project.id, 'Garage');
        insertProp(project.id, 'Keycard');
        const scene = insertScene(project.id, 'Garage');
        const shot = insertShot(scene.id, { characters: ['Ivo'], props: ['Keycard'] });
        insertProfile(project.id, { profile_type: 'character', subject_id: character.id, subject_name: character.name, canonical_asset_id: insertAsset(project.id, { character_id: character.id }).id });
        insertProfile(project.id, { profile_type: 'location', subject_id: location.id, subject_name: location.name, canonical_asset_id: insertAsset(project.id, { location_id: location.id }).id });

        const audit = auditShotReadiness(shot, scene, project);
        assert.equal(audit.ready, false);
        assert.ok(audit.missing.some(m => m.includes('Keycard')));
    });

    it('resolves stored reference files when asset file_path is only a served path', () => {
        const project = insertProject();
        const prop = insertProp(project.id, 'Beacon');
        const scene = insertScene(project.id, '');
        const filename = `beacon-${generateId()}.png`;
        const storedPath = saveFile(project.id, 'prop-refs', filename, Buffer.from('png'));
        const shot = insertShot(scene.id, { props: ['Beacon'] });
        const propAsset = insertAsset(project.id, {
            metadata: { prop_id: prop.id },
            file_path: `/film/prop-refs/${project.id}/${filename}`,
            file_name: filename,
        });
        insertProfile(project.id, { profile_type: 'prop', subject_id: prop.id, subject_name: prop.name, canonical_asset_id: propAsset.id });

        const context = buildShotReferencePayload(shot, scene, project);
        assert.equal(context.references[0].file_path, storedPath);
        assert.equal(fs.existsSync(context.references[0].file_path), true);
    });

    it('records consistency check rows with Verify view details shape', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Rin');
        const location = insertLocation(project.id, 'Vault');
        const scene = insertScene(project.id, 'Vault');
        const shot = insertShot(scene.id, { characters: ['Rin'], action: 'Rin enters the vault.' });
        const charAsset = insertAsset(project.id, { character_id: character.id, file_path: '/refs/rin.png' });
        const locAsset = insertAsset(project.id, { location_id: location.id, file_path: '/refs/vault.png' });
        const outputAsset = insertAsset(project.id, { shot_id: shot.id, asset_type: 'storyboard', file_path: '/out/shot.png' });
        insertProfile(project.id, { profile_type: 'character', subject_id: character.id, subject_name: character.name, canonical_asset_id: charAsset.id });
        insertProfile(project.id, { profile_type: 'location', subject_id: location.id, subject_name: location.name, canonical_asset_id: locAsset.id });

        const check = recordConsistencyCheck(shot, scene, project, { output_asset_id: outputAsset.id });
        assert.equal(check.status, 'ready');
        assert.equal(check.details.scorer, 'stub');
        assert.deepEqual(check.details.thresholds, { ready: 0.85, warning: 0.70 });
        assert.equal(check.details.subjects.length, 2);

        const subject = check.details.subjects.find(s => s.profile_type === 'character');
        assert.ok(subject.profile_id);
        assert.equal(subject.subject_name, 'Rin');
        assert.equal(subject.role, 'canonical');
        assert.equal(subject.score, 1);
        assert.equal(subject.status, 'ready');
        assert.equal(subject.reference_asset_id, charAsset.id);
        assert.equal(subject.output_asset_id, outputAsset.id);

        const row = db.prepare('SELECT * FROM film_consistency_checks WHERE id = ?').get(check.id);
        assert.equal(row.project_id, project.id);
        assert.equal(row.shot_id, shot.id);
        assert.equal(row.scene_id, scene.id);
        assert.equal(row.status, 'ready');
        assert.deepEqual(JSON.parse(row.missing), []);
        assert.deepEqual(JSON.parse(row.warnings), []);
        assert.equal(JSON.parse(row.details).subjects[0].output_asset_id, outputAsset.id);
    });

    it('groups and orders multi-role references deterministically', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Tala');
        const scene = insertScene(project.id, '');
        const shot = insertShot(scene.id, { characters: ['Tala'] });
        const canonical = insertAsset(project.id, { character_id: character.id, file_path: '/refs/tala-canon.png' });
        const face = insertAsset(project.id, { character_id: character.id, file_path: '/refs/tala-face.png' });
        const side = insertAsset(project.id, { character_id: character.id, file_path: '/refs/tala-side.png' });
        const front = insertAsset(project.id, { character_id: character.id, file_path: '/refs/tala-front.png' });
        const fullBody = insertAsset(project.id, { character_id: character.id, file_path: '/refs/tala-full.png' });
        const expression = insertAsset(project.id, { character_id: character.id, file_path: '/refs/tala-expression.png' });
        const profile = insertProfile(project.id, {
            profile_type: 'character',
            subject_id: character.id,
            subject_name: character.name,
            canonical_asset_id: canonical.id,
            required_roles: ['front', 'side'],
        });
        insertConsistencyRef(project.id, profile.id, side.id, { ref_role: 'side', weight: 0.9 });
        insertConsistencyRef(project.id, profile.id, front.id, { ref_role: 'front', weight: 0.6 });
        insertConsistencyRef(project.id, profile.id, fullBody.id, { ref_role: 'full_body', weight: 0.9 });
        insertConsistencyRef(project.id, profile.id, face.id, { ref_role: 'face', weight: 0.5 });
        insertConsistencyRef(project.id, profile.id, expression.id, { ref_role: 'expression', weight: 0.9 });

        const context = buildShotReferencePayload(shot, scene, project);
        assert.deepEqual(context.references.map(r => r.role), ['canonical', 'face', 'front', 'side', 'full_body', 'expression']);
        assert.deepEqual(context.input_refs, [canonical.id, face.id, front.id, side.id, fullBody.id, expression.id]);
        assert.deepEqual(Object.keys(context.references_by_role).sort(), ['canonical', 'expression', 'face', 'front', 'full_body', 'side']);
        assert.equal(context.reference_groups.length, 1);
        assert.deepEqual(context.reference_groups[0].required_roles, ['front', 'side']);
        assert.equal(context.reference_groups[0].references_by_role.face[0].asset_id, face.id);
        assert.equal(context.reference_groups[0].references_by_role.front[0].asset_id, front.id);
    });

    it('exports the unified reference-role vocabulary in priority order', () => {
        assert.deepEqual(REF_ROLES, ['canonical', 'face', 'front', 'side', 'back', 'full_body', 'expression', 'wide', 'detail', 'color']);
    });

    it('audits missing required reference roles', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Koa');
        const scene = insertScene(project.id, '');
        const shot = insertShot(scene.id, { characters: ['Koa'] });
        const canonical = insertAsset(project.id, { character_id: character.id });
        insertProfile(project.id, {
            profile_type: 'character',
            subject_id: character.id,
            subject_name: character.name,
            canonical_asset_id: canonical.id,
            required_roles: ['front', 'side'],
        });

        const audit = auditShotReadiness(shot, scene, project);
        assert.equal(audit.ready, false);
        assert.ok(audit.missing.some(m => m.includes('front')));
        assert.ok(audit.missing.some(m => m.includes('side')));
    });

    it('guards against conflicting locked seeds', () => {
        const project = insertProject();
        const character = insertCharacter(project.id, 'Mika');
        const location = insertLocation(project.id, 'Garden');
        const scene = insertScene(project.id, 'Garden');
        const shot = insertShot(scene.id, { characters: ['Mika'] });
        insertProfile(project.id, {
            profile_type: 'character',
            subject_id: character.id,
            subject_name: character.name,
            canonical_asset_id: insertAsset(project.id, { character_id: character.id }).id,
            locked_seed: 111,
        });
        insertProfile(project.id, {
            profile_type: 'location',
            subject_id: location.id,
            subject_name: location.name,
            canonical_asset_id: insertAsset(project.id, { location_id: location.id }).id,
            locked_seed: 222,
        });

        const context = buildShotReferencePayload(shot, scene, project);
        assert.equal(context.locked_seed, null);
        assert.equal(context.seed_conflict, true);
        assert.ok(context.seed_warnings[0].includes('111'));
        assert.ok(context.seed_warnings[0].includes('222'));
        const payload = applyConsistencyToImagePayload({ prompt: 'base' }, context);
        assert.equal('seed' in payload, false);
        const audit = auditShotReadiness(shot, scene, project);
        assert.ok(audit.warnings.some(w => w.includes('Conflicting locked seeds')));
    });

    it('applies locked seed for unset and -1 sentinel seeds but preserves explicit 0', () => {
        const context = { locked_seed: 777, references: [] };
        assert.equal(applyConsistencyToImagePayload({ prompt: 'base' }, context).seed, 777);
        assert.equal(applyConsistencyToImagePayload({ prompt: 'base', seed: -1 }, context).seed, 777);
        assert.equal(applyConsistencyToImagePayload({ prompt: 'base', seed: '-1' }, context).seed, 777);
        assert.equal(applyConsistencyToImagePayload({ prompt: 'base', seed: 0 }, context).seed, 0);
    });

    it('treats consistency check recording as best-effort when context is missing', () => {
        const result = recordConsistencyCheck('missing-shot', null, null, {});
        assert.equal(result, null);
    });
});
