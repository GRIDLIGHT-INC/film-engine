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
    auditShotReadiness,
    auditProjectReadiness,
    buildShotReferencePayload,
    applyConsistencyToImagePayload,
    applyConsistencyToVoicePayload,
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
        assert.match(payload.prompt, /red coat/);
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
});
