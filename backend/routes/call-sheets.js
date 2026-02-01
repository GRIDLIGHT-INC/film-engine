/**
 * FILM-086: Scene Breakdown / Call Sheet Generator
 * GET /film/scenes/:id/call-sheet — per-scene call sheet
 * GET /film/projects/:id/call-sheet — full project call sheet (all scenes)
 *
 * Generates production call sheets using SQL joins instead of Neo4j.
 * Gathers characters, costumes, locations, props, shots, and notes
 * for each scene into a structured call sheet document.
 */
const { db } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleCallSheets(req, res, urlParts, query) {
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    // /film/scenes/:id/call-sheet
    if (urlParts[1] === 'scenes' && urlParts[2]) {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) return badReq(res, 'Invalid scene ID');
        return generateSceneCallSheet(req, res, sceneId);
    }

    // /film/projects/:id/call-sheet
    if (urlParts[1] === 'projects' && urlParts[2]) {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        return generateProjectCallSheet(req, res, projectId, query);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function generateSceneCallSheet(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Scene not found' }));
        return;
    }

    const callSheet = buildSceneCallSheet(scene);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(callSheet));
}

function generateProjectCallSheet(req, res, projectId, query) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    let scenes;
    if (query.scene_number) {
        scenes = db.prepare(
            'SELECT * FROM film_scenes WHERE project_id = ? AND scene_number = ? ORDER BY scene_number'
        ).all(projectId, parseInt(query.scene_number) || 0);
    } else {
        scenes = db.prepare(
            'SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number'
        ).all(projectId);
    }

    const callSheets = scenes.map(buildSceneCallSheet);

    // Aggregate unique elements across all scenes
    const allCharacters = new Map();
    const allLocations = new Set();
    const allProps = new Map();
    let totalShots = 0;
    let totalDurationMs = 0;

    for (const cs of callSheets) {
        for (const ch of cs.cast) {
            if (!allCharacters.has(ch.character_id)) {
                allCharacters.set(ch.character_id, { ...ch, scene_numbers: [] });
            }
            allCharacters.get(ch.character_id).scene_numbers.push(cs.scene.scene_number);
        }
        allLocations.add(cs.scene.location);
        for (const p of cs.props) {
            if (!allProps.has(p.id)) {
                allProps.set(p.id, { ...p, scene_numbers: [] });
            }
            allProps.get(p.id).scene_numbers.push(cs.scene.scene_number);
        }
        totalShots += cs.shots.length;
        totalDurationMs += cs.estimated_duration_ms;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        project: {
            id: project.id,
            title: project.title,
            genre: project.genre,
            status: project.status
        },
        generated_at: new Date().toISOString(),
        summary: {
            total_scenes: callSheets.length,
            total_shots: totalShots,
            total_duration_ms: totalDurationMs,
            total_duration_formatted: formatDuration(totalDurationMs),
            unique_characters: allCharacters.size,
            unique_locations: allLocations.size,
            unique_props: allProps.size
        },
        cast_summary: [...allCharacters.values()].map(c => ({
            character_id: c.character_id,
            name: c.name,
            scene_numbers: c.scene_numbers,
            total_scenes: c.scene_numbers.length
        })),
        location_summary: [...allLocations].filter(Boolean),
        props_summary: [...allProps.values()].map(p => ({
            id: p.id,
            name: p.name,
            category: p.category,
            scene_numbers: p.scene_numbers,
            total_scenes: p.scene_numbers.length
        })),
        scenes: callSheets
    }));
}

function buildSceneCallSheet(scene) {
    // 1. Get shots for this scene
    const shots = db.prepare(
        'SELECT * FROM film_shots WHERE scene_id = ? ORDER BY shot_code'
    ).all(scene.id);

    // 2. Get characters assigned to this scene
    const sceneCharacters = db.prepare(`
        SELECT c.id AS character_id, c.name, c.description, c.appearance_prompt,
               c.age_range, c.gender, c.personality_notes,
               sc.role AS scene_role
        FROM film_scene_characters sc
        JOIN film_characters c ON sc.character_id = c.id
        WHERE sc.scene_id = ?
        ORDER BY c.name
    `).all(scene.id);

    // 3. Get costumes for each character
    const costumeStmt = db.prepare(
        'SELECT id, name, description, visual_prompt, color_palette FROM film_costumes WHERE character_id = ?'
    );

    // 4. Get voice profiles for each character
    const voiceStmt = db.prepare(
        'SELECT id, name, tts_model, language FROM film_voice_profiles WHERE character_id = ? LIMIT 1'
    );

    const cast = sceneCharacters.map(ch => {
        const costumes = costumeStmt.all(ch.character_id);
        const voiceProfile = voiceStmt.get(ch.character_id);

        // Extract dialogue from shot scene cards
        const dialogue = [];
        for (const shot of shots) {
            let cardData;
            try { cardData = JSON.parse(shot.scene_card_yaml || '{}'); } catch { cardData = {}; }
            if (Array.isArray(cardData.dialogue)) {
                for (const dl of cardData.dialogue) {
                    if (dl.character && dl.character.toUpperCase() === ch.name.toUpperCase()) {
                        dialogue.push({
                            shot_code: shot.shot_code,
                            line: dl.line,
                            emotion: dl.emotion || 'neutral'
                        });
                    }
                }
            }
        }

        return {
            character_id: ch.character_id,
            name: ch.name,
            description: ch.description,
            appearance: ch.appearance_prompt,
            age_range: ch.age_range,
            gender: ch.gender,
            personality: ch.personality_notes,
            scene_role: ch.scene_role,
            costumes,
            voice_profile: voiceProfile || null,
            dialogue,
            dialogue_count: dialogue.length
        };
    });

    // 5. Also extract characters mentioned in scene cards but not in scene_characters
    const mentionedCharNames = new Set();
    const assignedCharNames = new Set(cast.map(c => c.name.toUpperCase()));

    for (const shot of shots) {
        let cardData;
        try { cardData = JSON.parse(shot.scene_card_yaml || '{}'); } catch { cardData = {}; }
        if (Array.isArray(cardData.characters)) {
            for (const c of cardData.characters) {
                const name = (typeof c === 'string' ? c : c.name || '').toUpperCase();
                if (name && !assignedCharNames.has(name)) {
                    mentionedCharNames.add(name);
                }
            }
        }
    }

    // 6. Get props linked to this scene
    const props = db.prepare(`
        SELECT p.id, p.name, p.description, p.visual_prompt, p.category,
               sp.notes AS scene_notes
        FROM film_scene_props sp
        JOIN film_props p ON sp.prop_id = p.id
        WHERE sp.scene_id = ?
        ORDER BY p.name
    `).all(scene.id);

    // 7. Get location details
    let locationDetails = null;
    if (scene.location) {
        locationDetails = db.prepare(
            'SELECT * FROM film_locations WHERE project_id = ? AND name = ?'
        ).get(scene.project_id, scene.location);
    }

    // 8. Get unresolved notes for shots in this scene
    const unresolvedNotes = db.prepare(`
        SELECT n.*, s.shot_code FROM film_shot_notes n
        JOIN film_shots s ON n.shot_id = s.id
        WHERE s.scene_id = ? AND n.resolved = 0
        ORDER BY n.priority DESC, n.created_at DESC
    `).all(scene.id);

    // 9. Calculate estimated duration
    const estimatedDurationMs = shots.reduce((sum, s) => sum + (s.duration_ms || 0), 0);

    // 10. Extract camera and lighting summary from shots
    const cameraTypes = new Set();
    const lightingTypes = new Set();
    for (const shot of shots) {
        let cardData;
        try { cardData = JSON.parse(shot.scene_card_yaml || '{}'); } catch { cardData = {}; }
        if (cardData.camera?.shot_type) cameraTypes.add(cardData.camera.shot_type);
        if (cardData.camera?.movement && cardData.camera.movement !== 'static') cameraTypes.add(cardData.camera.movement);
        if (cardData.lighting?.type) lightingTypes.add(cardData.lighting.type);
    }

    return {
        scene: {
            id: scene.id,
            scene_number: scene.scene_number,
            int_ext: scene.int_ext,
            location: scene.location,
            time_of_day: scene.time_of_day,
            status: scene.status,
            description: scene.description
        },
        location_details: locationDetails ? {
            id: locationDetails.id,
            name: locationDetails.name,
            description: locationDetails.description,
            lighting_default: locationDetails.lighting_default,
            time_of_day_default: locationDetails.time_of_day_default,
            atmosphere_notes: locationDetails.atmosphere_notes,
            sound_notes: locationDetails.sound_notes
        } : null,
        cast,
        unassigned_characters: [...mentionedCharNames],
        props,
        shots: shots.map(s => {
            let cardData;
            try { cardData = JSON.parse(s.scene_card_yaml || '{}'); } catch { cardData = {}; }
            return {
                id: s.id,
                shot_code: s.shot_code,
                status: s.status,
                duration_ms: s.duration_ms,
                description: cardData.description || '',
                camera: cardData.camera || {},
                lighting: cardData.lighting || {},
                characters: cardData.characters || [],
                generation_mode: cardData.generation_mode || 'creative'
            };
        }),
        shot_count: shots.length,
        estimated_duration_ms: estimatedDurationMs,
        estimated_duration_formatted: formatDuration(estimatedDurationMs),
        camera_requirements: [...cameraTypes],
        lighting_requirements: [...lightingTypes],
        unresolved_notes: unresolvedNotes,
        unresolved_note_count: unresolvedNotes.length
    };
}

function formatDuration(ms) {
    if (!ms) return '0:00';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    if (hr > 0) return `${hr}:${String(remMin).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${remMin}:${String(sec).padStart(2, '0')}`;
}

module.exports = { handleCallSheets };
