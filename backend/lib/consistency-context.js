/**
 * Consistency context helpers.
 *
 * The generation contract is: explore freely, then lock profiles for production.
 * These helpers read locked profiles and assemble provider-agnostic reference
 * payloads that routes/adapters can map to their own input fields.
 */

const fs = require('fs');
const { db } = require('../db/database');
const { getFilePath } = require('./file-storage');

const VISUAL_TYPES = new Set(['character', 'location', 'prop', 'style']);

function parseJson(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeName(value) {
    return String(value || '').trim().toUpperCase();
}

function loadAsset(assetId) {
    if (!assetId) return null;
    return db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId) || null;
}

function parseAssetMetadata(asset) {
    return parseJson(asset && asset.metadata, {});
}

function referenceSubdirs(asset) {
    const metadata = parseAssetMetadata(asset);
    if (asset.asset_type === 'storyboard' || asset.asset_type === 'keyframe') return ['storyboards'];
    if (asset.asset_type === 'character_sheet' || asset.asset_type === 'reference_sheet') return ['refsheets'];
    if (asset.asset_type === 'reference_image') {
        if (metadata.prop_id) return ['prop-refs', 'loc-refs', 'refsheets', 'storyboards'];
        if (asset.location_id || metadata.location_id) return ['loc-refs', 'prop-refs', 'refsheets', 'storyboards'];
        if (asset.character_id || metadata.character_id) return ['refsheets', 'loc-refs', 'prop-refs', 'storyboards'];
        return ['refsheets', 'loc-refs', 'prop-refs', 'storyboards'];
    }
    return ['storyboards', 'refsheets', 'loc-refs', 'prop-refs'];
}

function resolveAssetPath(asset) {
    if (!asset) return '';
    const current = asset.file_path || '';
    if (/^https?:\/\//i.test(current)) return current;
    if (current && fs.existsSync(current)) return current;
    if (!asset.file_name || !asset.project_id) return current;
    for (const subdir of referenceSubdirs(asset)) {
        const candidate = getFilePath(asset.project_id, subdir, asset.file_name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return current;
}

function assetRef(asset) {
    if (!asset) return null;
    return {
        asset_id: asset.id,
        project_id: asset.project_id || '',
        file_path: resolveAssetPath(asset),
        file_name: asset.file_name || '',
        mime_type: asset.mime_type || '',
        format: asset.format || '',
        asset_type: asset.asset_type || '',
    };
}

function profileToContext(profile) {
    if (!profile) return null;
    const canonicalAsset = loadAsset(profile.canonical_asset_id);
    const refs = db.prepare(
        `SELECT r.*, a.project_id AS asset_project_id, a.character_id, a.location_id,
                a.file_path, a.file_name, a.mime_type, a.format, a.asset_type, a.metadata AS asset_metadata
         FROM film_consistency_refs r
         LEFT JOIN film_assets a ON a.id = r.asset_id
         WHERE r.profile_id = ?
         ORDER BY CASE r.ref_role WHEN 'canonical' THEN 0 ELSE 1 END, r.created_at`
    ).all(profile.id);

    return {
        ...profile,
        settings: parseJson(profile.settings, {}),
        required_roles: parseJson(profile.required_roles, []),
        canonical_asset: assetRef(canonicalAsset),
        refs: refs.map(r => ({
            id: r.id,
            asset_id: r.asset_id,
            role: r.ref_role,
            weight: r.weight,
            is_required: !!r.is_required,
            notes: r.notes || '',
            asset: assetRef(r.asset_id ? {
                id: r.asset_id,
                project_id: r.asset_project_id,
                character_id: r.character_id,
                location_id: r.location_id,
                file_path: r.file_path,
                file_name: r.file_name,
                mime_type: r.mime_type,
                format: r.format,
                asset_type: r.asset_type,
                metadata: r.asset_metadata,
            } : null),
        })),
    };
}

function getLockedProfiles(projectId, profileType) {
    let sql = "SELECT * FROM film_consistency_profiles WHERE project_id = ? AND status = 'locked'";
    const params = [projectId];
    if (profileType) {
        sql += ' AND profile_type = ?';
        params.push(profileType);
    }
    sql += ' ORDER BY updated_at DESC, created_at DESC';
    return db.prepare(sql).all(...params).map(profileToContext);
}

function getLockedProfileForSubject(projectId, profileType, subject) {
    const subjectId = typeof subject === 'object' && subject ? subject.id : '';
    const subjectName = typeof subject === 'object' && subject ? subject.name : subject;
    const byId = subjectId ? db.prepare(
        `SELECT * FROM film_consistency_profiles
         WHERE project_id = ? AND profile_type = ? AND status = 'locked' AND subject_id = ?
         ORDER BY updated_at DESC, created_at DESC LIMIT 1`
    ).get(projectId, profileType, subjectId) : null;
    if (byId) return profileToContext(byId);

    const name = normalizeName(subjectName);
    if (!name) return null;
    const byName = db.prepare(
        `SELECT * FROM film_consistency_profiles
         WHERE project_id = ? AND profile_type = ? AND status = 'locked' AND UPPER(subject_name) = ?
         ORDER BY updated_at DESC, created_at DESC LIMIT 1`
    ).get(projectId, profileType, name);
    return profileToContext(byName);
}

function getProject(projectOrId) {
    if (projectOrId && typeof projectOrId === 'object') return projectOrId;
    if (!projectOrId) return null;
    return db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectOrId) || null;
}

function getScene(sceneOrId) {
    if (sceneOrId && typeof sceneOrId === 'object') return sceneOrId;
    if (!sceneOrId) return null;
    return db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneOrId) || null;
}

function getShot(shotOrId) {
    if (shotOrId && typeof shotOrId === 'object') return shotOrId;
    if (!shotOrId) return null;
    return db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotOrId) || null;
}

function parseSceneCard(shot) {
    return parseJson(shot && shot.scene_card_yaml, {});
}

function cardCharacterNames(sceneCard) {
    const chars = sceneCard && Array.isArray(sceneCard.characters) ? sceneCard.characters : [];
    const names = chars.map(ch => typeof ch === 'string' ? ch : ch && ch.name).filter(Boolean);
    const dialogue = sceneCard && Array.isArray(sceneCard.dialogue) ? sceneCard.dialogue : [];
    for (const line of dialogue) {
        if (line && line.character) names.push(line.character);
    }
    return Array.from(new Set(names.map(String)));
}

function cardPropNames(sceneCard) {
    const props = sceneCard && Array.isArray(sceneCard.props) ? sceneCard.props : [];
    return Array.from(new Set(props.map(prop => {
        if (typeof prop === 'string') return prop;
        return prop && (prop.name || prop.prop || prop.label);
    }).filter(Boolean).map(String)));
}

function findProjectCharacter(projectId, name) {
    if (!name) return null;
    return db.prepare('SELECT * FROM film_characters WHERE project_id = ? AND UPPER(name) = ?')
        .get(projectId, normalizeName(name)) || null;
}

function findProjectLocation(projectId, name) {
    if (!name) return null;
    return db.prepare('SELECT * FROM film_locations WHERE project_id = ? AND UPPER(name) = ?')
        .get(projectId, normalizeName(name)) || null;
}

function findProjectProp(projectId, name) {
    if (!name) return null;
    return db.prepare('SELECT * FROM film_props WHERE project_id = ? AND UPPER(name) = ?')
        .get(projectId, normalizeName(name)) || null;
}

function referencesForProfile(profile) {
    if (!profile) return [];
    const refs = [];
    if (profile.canonical_asset) {
        refs.push({
            profile_id: profile.id,
            profile_type: profile.profile_type,
            subject_id: profile.subject_id,
            subject_name: profile.subject_name,
            role: 'canonical',
            weight: profile.reference_weight || 0.7,
            ...profile.canonical_asset,
        });
    }
    for (const ref of profile.refs || []) {
        if (!ref.asset || refs.some(r => r.asset_id === ref.asset.asset_id)) continue;
        refs.push({
            profile_id: profile.id,
            profile_type: profile.profile_type,
            subject_id: profile.subject_id,
            subject_name: profile.subject_name,
            role: ref.role,
            weight: ref.weight || profile.reference_weight || 0.7,
            ...ref.asset,
        });
    }
    return refs;
}

function buildPromptContract(profiles) {
    const promptParts = [];
    const negativeParts = [];
    const seeds = [];
    for (const profile of profiles) {
        if (profile.prompt_contract) promptParts.push(profile.prompt_contract);
        if (profile.negative_contract) negativeParts.push(profile.negative_contract);
        if (profile.locked_seed !== null && profile.locked_seed !== undefined) seeds.push(Number(profile.locked_seed));
    }
    return {
        prompt_additions: Array.from(new Set(promptParts.filter(Boolean))),
        negative_additions: Array.from(new Set(negativeParts.filter(Boolean))),
        locked_seed: seeds.length ? seeds[0] : null,
    };
}

/**
 * Build references and prompt/voice contracts for a shot.
 */
function buildShotReferencePayload(shotInput, sceneInput, projectInput) {
    const shot = getShot(shotInput);
    const scene = getScene(sceneInput || (shot && shot.scene_id));
    const project = getProject(projectInput || (scene && scene.project_id));
    if (!shot || !scene || !project) {
        return { profiles: [], references: [], input_refs: [], prompt_additions: [], negative_additions: [], locked_seed: null, voice: {} };
    }

    const sceneCard = parseSceneCard(shot);
    const profiles = [];

    for (const name of cardCharacterNames(sceneCard)) {
        const character = findProjectCharacter(project.id, name);
        const profile = getLockedProfileForSubject(project.id, 'character', character || name);
        if (profile) profiles.push(profile);

        const voiceProfile = getLockedProfileForSubject(project.id, 'voice', character || name);
        if (voiceProfile) profiles.push(voiceProfile);
    }

    for (const name of cardPropNames(sceneCard)) {
        const prop = findProjectProp(project.id, name);
        const profile = getLockedProfileForSubject(project.id, 'prop', prop || name);
        if (profile) profiles.push(profile);
    }

    const locationName = scene.location || sceneCard.location || shot.location;
    const location = findProjectLocation(project.id, locationName);
    const locationProfile = getLockedProfileForSubject(project.id, 'location', location || locationName);
    if (locationProfile) profiles.push(locationProfile);

    const styleProfiles = getLockedProfiles(project.id, 'style');
    profiles.push(...styleProfiles);

    const dedupedProfiles = [];
    const seen = new Set();
    for (const profile of profiles) {
        if (!profile || seen.has(profile.id)) continue;
        seen.add(profile.id);
        dedupedProfiles.push(profile);
    }

    const references = dedupedProfiles
        .filter(p => VISUAL_TYPES.has(p.profile_type))
        .flatMap(referencesForProfile)
        .filter(ref => ref.file_path || ref.file_name);
    const inputRefs = Array.from(new Set(references.map(r => r.asset_id).filter(Boolean)));
    const promptContract = buildPromptContract(dedupedProfiles);
    const voiceProfiles = dedupedProfiles.filter(p => p.profile_type === 'voice');
    const voiceByCharacter = {};
    for (const profile of voiceProfiles) {
        const settings = profile.settings || {};
        voiceByCharacter[normalizeName(profile.subject_name)] = {
            profile_id: profile.id,
            voice_profile_id: settings.voice_profile_id || profile.subject_id || '',
            voice_id: settings.voice_id || '',
            provider: profile.provider || settings.provider || '',
            provider_model: profile.provider_model || settings.model || '',
            settings,
        };
    }

    return {
        profiles: dedupedProfiles,
        references,
        input_refs: inputRefs,
        prompt_additions: promptContract.prompt_additions,
        negative_additions: promptContract.negative_additions,
        locked_seed: promptContract.locked_seed,
        voice: { by_character: voiceByCharacter },
    };
}

function auditShotReadiness(shotInput, sceneInput, projectInput) {
    const shot = getShot(shotInput);
    const scene = getScene(sceneInput || (shot && shot.scene_id));
    const project = getProject(projectInput || (scene && scene.project_id));
    const missing = [];
    const warnings = [];
    if (!shot || !scene || !project) {
        return { ready: false, missing: ['shot, scene, or project not found'], warnings };
    }

    const sceneCard = parseSceneCard(shot);
    for (const name of cardCharacterNames(sceneCard)) {
        const character = findProjectCharacter(project.id, name);
        if (!character) {
            warnings.push(`Character "${name}" is referenced by the shot but is not in the character registry.`);
            continue;
        }
        const profile = getLockedProfileForSubject(project.id, 'character', character);
        if (!profile) {
            missing.push(`Character "${character.name}" has no locked consistency profile.`);
        } else if (!profile.canonical_asset) {
            missing.push(`Character "${character.name}" locked profile has no canonical asset.`);
        }

        const hasDialogue = Array.isArray(sceneCard.dialogue) && sceneCard.dialogue.some(line => normalizeName(line.character) === normalizeName(name));
        if (hasDialogue) {
            const voiceProfile = getLockedProfileForSubject(project.id, 'voice', character);
            if (!voiceProfile) warnings.push(`Character "${character.name}" has dialogue but no locked voice profile.`);
        }
    }

    const locationName = scene.location || sceneCard.location || shot.location;
    if (locationName) {
        const location = findProjectLocation(project.id, locationName);
        if (!location) {
            warnings.push(`Location "${locationName}" is referenced by the scene but is not in the location registry.`);
        } else {
            const profile = getLockedProfileForSubject(project.id, 'location', location);
            if (!profile) {
                missing.push(`Location "${location.name}" has no locked consistency profile.`);
            } else if (!profile.canonical_asset) {
                missing.push(`Location "${location.name}" locked profile has no canonical asset.`);
            }
        }
    }

    for (const name of cardPropNames(sceneCard)) {
        const prop = findProjectProp(project.id, name);
        if (!prop) {
            warnings.push(`Prop "${name}" is referenced by the shot but is not in the prop registry.`);
            continue;
        }
        const profile = getLockedProfileForSubject(project.id, 'prop', prop);
        if (!profile) {
            missing.push(`Prop "${prop.name}" has no locked consistency profile.`);
        } else if (!profile.canonical_asset) {
            missing.push(`Prop "${prop.name}" locked profile has no canonical asset.`);
        }
    }

    return { ready: missing.length === 0, missing, warnings };
}

function auditProjectReadiness(projectId) {
    const project = getProject(projectId);
    if (!project) return { ready: false, project_id: projectId, shots: [], missing: ['Project not found'], warnings: [] };

    const rows = db.prepare(
        `SELECT s.*, sc.project_id, sc.location AS scene_location, sc.id AS scene_id
         FROM film_shots s
         JOIN film_scenes sc ON sc.id = s.scene_id
         WHERE sc.project_id = ? AND sc.status != 'removed'
         ORDER BY sc.scene_number, s.shot_code`
    ).all(project.id);
    const shots = rows.map(row => {
        const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(row.scene_id);
        const audit = auditShotReadiness(row, scene, project);
        return { shot_id: row.id, shot_code: row.shot_code, ...audit };
    });
    return {
        ready: shots.every(s => s.ready),
        project_id: project.id,
        shots,
        missing: shots.flatMap(s => s.missing),
        warnings: shots.flatMap(s => s.warnings),
    };
}

function applyConsistencyToImagePayload(payload, context) {
    const p = { ...(payload || {}) };
    const ctx = context || {};
    if (ctx.prompt_additions && ctx.prompt_additions.length) {
        p.prompt = [p.prompt, ...ctx.prompt_additions].filter(Boolean).join(', ');
    }
    if (ctx.negative_additions && ctx.negative_additions.length) {
        p.negative_prompt = [p.negative_prompt, ...ctx.negative_additions].filter(Boolean).join(', ');
    }
    if (!p.seed && ctx.locked_seed !== null && ctx.locked_seed !== undefined) p.seed = ctx.locked_seed;
    if (ctx.references && ctx.references.length) {
        p.reference_images = ctx.references;
        p.input_refs = ctx.input_refs || [];
        if (!p.ip_adapter_image) {
            const primary = ctx.references[0];
            p.ip_adapter_image = primary.file_path || primary.file_name || null;
            p.ip_adapter_weight = primary.weight || 0.7;
        }
    }
    return p;
}

function applyConsistencyToVoicePayload(payload, context, characterName) {
    const p = { ...(payload || {}) };
    const key = normalizeName(characterName || p.character_name);
    const voice = context && context.voice && context.voice.by_character && context.voice.by_character[key];
    if (!voice) return p;
    if (voice.voice_id) p.voice_id = voice.voice_id;
    if (voice.provider_model && !p.model) p.model = voice.provider_model;
    if (voice.settings) {
        if (voice.settings.language) p.language = voice.settings.language;
        if (voice.settings.speed) p.speed = voice.settings.speed;
        if (voice.settings.stability) p.stability = voice.settings.stability;
        if (voice.settings.similarity_boost) p.similarity_boost = voice.settings.similarity_boost;
    }
    p.consistency_profile_id = voice.profile_id;
    return p;
}

module.exports = {
    parseJson,
    cardPropNames,
    getLockedProfiles,
    getLockedProfileForSubject,
    buildShotReferencePayload,
    auditShotReadiness,
    auditProjectReadiness,
    applyConsistencyToImagePayload,
    applyConsistencyToVoicePayload,
};
