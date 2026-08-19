/**
 * Character CRUD + voice profiles + costumes + reference sheets
 * POST/GET/PUT/DELETE /film/projects/:id/characters
 * GET /film/characters/:id
 * POST/GET /film/characters/:id/voice
 * POST/GET /film/characters/:id/costumes
 * POST /film/characters/:id/refsheet/generate     — FILM-014: Generate reference sheet
 * GET  /film/characters/:id/refsheet              — FILM-014: Get reference sheet status
 */
const { db, generateId } = require('../db/database');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { resolve } = require('../lib/providers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_ENDPOINT = '/image';

function parseProjectConfig(projectId) {
    const row = db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return {};
    try { return JSON.parse(row.provider_config || '{}'); } catch (_) { return {}; }
}

function handleCharacters(req, res, urlParts, query) {
    // /film/projects/:id/characters — parts: ['film', 'projects', id, 'characters']
    if (urlParts[1] === 'projects' && urlParts[3] === 'characters') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badRequest(res, 'Invalid project ID');

        if (req.method === 'GET') return listCharacters(req, res, projectId);
        if (req.method === 'POST') return createCharacter(req, res, projectId);
    }

    // /film/characters/:id — parts: ['film', 'characters', id]
    // /film/characters/:id/voice
    // /film/characters/:id/costumes
    if (urlParts[1] === 'characters' && urlParts[2]) {
        const charId = urlParts[2];
        if (!UUID_RE.test(charId)) return badRequest(res, 'Invalid character ID');
        const sub = urlParts[3];

        if (sub === 'voice') {
            if (req.method === 'GET') return getVoiceProfile(req, res, charId);
            if (req.method === 'POST') return createVoiceProfile(req, res, charId);
        }
        if (sub === 'costumes') {
            if (req.method === 'GET') return listCostumes(req, res, charId);
            if (req.method === 'POST') return createCostume(req, res, charId);
        }
        if (sub === 'refsheet') {
            if (urlParts[4] === 'generate' && req.method === 'POST') return generateRefSheet(req, res, charId);
            if (req.method === 'GET') return getRefSheetStatus(req, res, charId);
        }

        if (!sub) {
            if (req.method === 'GET') return getCharacter(req, res, charId);
            if (req.method === 'PUT') return updateCharacter(req, res, charId);
            if (req.method === 'DELETE') return deleteCharacter(req, res, charId);
        }
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badRequest(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

// --- Characters ---

function listCharacters(req, res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_characters WHERE project_id = ? ORDER BY name'
    ).all(projectId);

    // Attach costume count, voice profile status, and reference image
    const costumeCount = db.prepare('SELECT COUNT(*) AS count FROM film_costumes WHERE character_id = ?');
    const voiceCheck = db.prepare('SELECT id FROM film_voice_profiles WHERE character_id = ? LIMIT 1');
    const refsheetCheck = db.prepare(
        "SELECT file_name, project_id FROM film_assets WHERE asset_type = 'character_sheet' AND metadata LIKE ? ORDER BY created_at DESC LIMIT 1"
    );

    for (const ch of rows) {
        ch.costume_count = costumeCount.get(ch.id).count;
        ch.has_voice_profile = !!voiceCheck.get(ch.id);
        const refsheet = refsheetCheck.get(`%"character_id":"${ch.id}"%"view":"front"%`);
        ch.reference_image_url = refsheet ? getFileUrl('refsheets', refsheet.project_id, refsheet.file_name) : null;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ characters: rows }));
}

function getCharacter(req, res, charId) {
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Character not found' }));
        return;
    }

    // Include costumes
    ch.costumes = db.prepare('SELECT * FROM film_costumes WHERE character_id = ? ORDER BY name').all(charId);

    // Include voice profile
    ch.voice_profile = db.prepare('SELECT * FROM film_voice_profiles WHERE character_id = ?').get(charId) || null;

    // Include scene appearances
    ch.scene_appearances = db.prepare(`
        SELECT sc.scene_id, s.scene_number, s.location, s.time_of_day,
               sc.costume_id, sc.dialogue_lines, sc.screen_time_ms
        FROM film_scene_characters sc
        JOIN film_scenes s ON sc.scene_id = s.id
        WHERE sc.character_id = ?
        ORDER BY s.scene_number
    `).all(charId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ch));
}

function createCharacter(req, res, projectId) {
    const body = req.body;
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return badRequest(res, 'Character name is required');
    }

    // Reject a duplicate name rather than silently creating a second record.
    // Screenplays are edited and re-edited, and the same character comes back
    // every pass — without this, each pass could add another copy, and every
    // downstream reference (consistency profile, reference images, shots)
    // would then be split across duplicates that look identical in the UI.
    // Case- and whitespace-insensitive, because "MARIE" and "Marie " are the
    // same place to everyone except a database.
    const existing = db.prepare(
        'SELECT * FROM film_characters WHERE project_id = ? AND UPPER(TRIM(name)) = UPPER(TRIM(?))'
    ).get(projectId, body.name);
    if (existing) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Character "' + existing.name + '" already exists in this project.',
            code: 'duplicate_name',
            existing,
            // Named, or a caller with nothing else to try simply tries again —
            // which is exactly how props ended up duplicated.
            hint: 'Use character_update to change it, or character_delete to remove it first.',
        }));
        return;
    }

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_characters (id, project_id, name, description, appearance_prompt,
            personality_notes, age_range, gender, ethnicity, build, hair, distinguishing,
            reference_images, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.name.trim().slice(0, 200),
        (body.description || '').slice(0, 5000),
        (body.appearance_prompt || '').slice(0, 2000),
        (body.personality_notes || '').slice(0, 2000),
        (body.age_range || '').slice(0, 50),
        (body.gender || '').slice(0, 50),
        (body.ethnicity || '').slice(0, 100),
        (body.build || '').slice(0, 100),
        (body.hair || '').slice(0, 200),
        (body.distinguishing || '').slice(0, 500),
        JSON.stringify(body.reference_images || []),
        now, now
    );

    const row = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateCharacter(req, res, charId) {
    const body = req.body;
    const propagateToScreenplay = body.propagate_to_screenplay !== false;

    // Get current character to check for name changes
    const currentChar = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!currentChar) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Character not found' }));
        return;
    }

    const fields = [];
    const values = [];

    const textFields = {
        name: 200, description: 5000, appearance_prompt: 2000,
        personality_notes: 2000, age_range: 50, gender: 50,
        ethnicity: 100, build: 100, hair: 200, distinguishing: 500,
        lora_id: 200, ti_token: 200
    };

    for (const [field, maxLen] of Object.entries(textFields)) {
        if (body[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(String(body[field]).slice(0, maxLen));
        }
    }

    if (body.reference_images !== undefined) {
        fields.push('reference_images = ?');
        values.push(JSON.stringify(body.reference_images));
    }

    if (fields.length === 0) return badRequest(res, 'No valid fields to update');

    fields.push("updated_at = datetime('now')");
    values.push(charId);

    const result = db.prepare(`UPDATE film_characters SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);

    // FILM-122: Propagate name change to screenplay if name was changed
    let screenplayUpdate = null;
    if (propagateToScreenplay && body.name && body.name !== currentChar.name) {
        screenplayUpdate = propagateCharacterRename(
            currentChar.project_id,
            currentChar.name,
            body.name
        );
    }

    const response = { ...row };
    if (screenplayUpdate) {
        response.screenplay_update = screenplayUpdate;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
}

/**
 * FILM-122: Propagate character rename to screenplay
 * Finds all occurrences of old name in character cues and replaces with new name
 */
function propagateCharacterRename(projectId, oldName, newName) {
    // Get latest Fountain script
    const script = db.prepare(`
        SELECT id, version, fountain_content, format
        FROM film_scripts
        WHERE project_id = ?
        ORDER BY version DESC
        LIMIT 1
    `).get(projectId);

    if (!script || script.format !== 'fountain' || !script.fountain_content) {
        return { updated: false, reason: 'No Fountain script found' };
    }

    const oldNameUpper = oldName.toUpperCase();
    const newNameUpper = newName.toUpperCase();
    const lines = script.fountain_content.split('\n');
    let replacementCount = 0;
    let prevLineBlank = true;

    // Replace character cues (all caps name on its own line after blank)
    const newLines = lines.map((line, i) => {
        const trimmed = line.trim();
        const nextLine = lines[i + 1];
        const nextLineBlank = !nextLine || nextLine.trim() === '';

        // Check if this is a character cue
        if (prevLineBlank && !nextLineBlank && trimmed.toUpperCase() === trimmed) {
            // Match exact character name (with optional extension)
            const charMatch = trimmed.match(/^([A-Z][A-Z0-9\s\-'\.]+?)(\s*\([^)]+\))?(\s*\^)?$/);
            if (charMatch && charMatch[1].trim() === oldNameUpper) {
                replacementCount++;
                const extension = charMatch[2] || '';
                const dual = charMatch[3] || '';
                return newNameUpper + extension + dual;
            }
        }

        prevLineBlank = trimmed === '';
        return line;
    });

    if (replacementCount === 0) {
        return { updated: false, reason: 'No occurrences found in screenplay', occurrences: 0 };
    }

    // Save as new script version
    const newFountain = newLines.join('\n');
    const nextVersion = script.version + 1;
    const wordCount = newFountain.split(/\s+/).filter(w => w.length > 0).length;

    const scriptId = generateId();
    db.prepare(`
        INSERT INTO film_scripts
        (id, project_id, version, content, word_count, format, fountain_content, created_at)
        VALUES (?, ?, ?, ?, ?, 'fountain', ?, datetime('now'))
    `).run(scriptId, projectId, nextVersion, newFountain, wordCount, newFountain);

    return {
        updated: true,
        occurrences: replacementCount,
        new_version: nextVersion,
        old_name: oldName,
        new_name: newName
    };
}

function deleteCharacter(req, res, charId) {
    const result = db.prepare('DELETE FROM film_characters WHERE id = ?').run(charId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Character not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

// --- Voice Profiles ---

function getVoiceProfile(req, res, charId) {
    const profile = db.prepare('SELECT * FROM film_voice_profiles WHERE character_id = ?').get(charId);
    if (!profile) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No voice profile for this character' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(profile));
}

function createVoiceProfile(req, res, charId) {
    const ch = db.prepare('SELECT id, project_id FROM film_characters WHERE id = ?').get(charId);
    if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Character not found' }));
        return;
    }

    const body = req.body;
    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_voice_profiles (id, project_id, character_id, name, description,
            sample_path, sample_duration_ms, tts_model, voice_params, language, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, ch.project_id, charId,
        (body.name || ch.id).slice(0, 200),
        (body.description || '').slice(0, 1000),
        (body.sample_path || ''),
        body.sample_duration_ms || 0,
        (body.tts_model || 'qwen3-tts').slice(0, 100),
        JSON.stringify(body.voice_params || {}),
        (body.language || 'en').slice(0, 10),
        now
    );

    // Link back to character
    db.prepare('UPDATE film_characters SET voice_profile_id = ? WHERE id = ?').run(id, charId);

    const row = db.prepare('SELECT * FROM film_voice_profiles WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- Costumes ---

function listCostumes(req, res, charId) {
    const rows = db.prepare('SELECT * FROM film_costumes WHERE character_id = ? ORDER BY name').all(charId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ costumes: rows }));
}

function createCostume(req, res, charId) {
    const ch = db.prepare('SELECT id, project_id FROM film_characters WHERE id = ?').get(charId);
    if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Character not found' }));
        return;
    }

    const body = req.body;
    if (!body.name || !body.name.trim()) return badRequest(res, 'Costume name is required');

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_costumes (id, project_id, character_id, name, description,
            visual_prompt, color_palette, reference_images, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, ch.project_id, charId,
        body.name.trim().slice(0, 200),
        (body.description || '').slice(0, 2000),
        (body.visual_prompt || '').slice(0, 2000),
        (body.color_palette || '').slice(0, 500),
        JSON.stringify(body.reference_images || []),
        (body.notes || '').slice(0, 2000),
        now
    );

    const row = db.prepare('SELECT * FROM film_costumes WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- FILM-014: Character Reference Sheet Generation ---

const REFSHEET_VIEWS = ['front', 'side', 'back'];

/**
 * @param {string} [stylePreset] the project's look
 *
 * The sheet is the continuity ANCHOR: once it exists, every shot references it,
 * so whatever look it happens to render in propagates to the whole film. Left
 * styleless it came back as flat cartoon illustration — correct wardrobe,
 * wrong medium — and referencing that would have pulled a live-action gothic
 * piece toward line art. 'clean lines' made it worse: a drawing instruction in
 * a prompt meant to describe a person.
 */
/**
 * What a plate must not contain.
 *
 * The old negative said "text, watermark" and nothing about labels, charts,
 * annotations or handwriting — which is most of what actually turned up on the
 * first real plate. A reference that carries printed matter teaches every frame
 * that references it to carry printed matter too.
 */
const REFSHEET_NEGATIVE = 'blurry, low quality, distorted, multiple characters, background clutter, '
    + 'text, label, labels, annotation, annotations, caption, handwriting, chart, colour chart, '
    + 'swatch, swatches, watermark, logo, arrows, callouts, measurement marks, collage, multiple views';

function buildRefSheetPrompt(character, view, stylePreset) {
    const parts = [];
    const style = stylePreset && String(stylePreset).trim();

    // The MEDIUM leads. Appending the look last left "character reference
    // sheet, front view, full body, T-pose, plain seamless background" to
    // decide what kind of picture this is, and that phrasing asks for a stock
    // asset-library render: MAYA came back as a flat vector cutout with a
    // shrug emoji, and every shot referencing her inherited the cartoon.
    // With no project style there is still an explicit medium, because the
    // absence of one is what the model fills in with clip art.
    // NOT "reference sheet". An image model takes that literally and renders
    // the sheet: the first real plate came back with a handwritten "FRONT /
    // mid 30s" caption, a colour-swatch chart labelled in gibberish and a strip
    // of tape. The person underneath was right; the document around them was
    // not. A plate conditions every frame its subject appears in, so anything
    // printed on it bleeds into all of them.
    parts.push(style ? `${style}. Full-body studio photograph` : 'photoreal cinematic full-body studio photograph');
    // The view still has to be named, or three plates are three unrelated
    // pictures rather than a turnaround.
    parts.push(`${view} view of the subject`);
    parts.push(style
        ? 'standing, arms slightly away from body, neutral expression, plain seamless backdrop'
        : 'standing, arms slightly away from body, plain seamless backdrop');

    if (character.appearance_prompt) parts.push(character.appearance_prompt);
    if (character.gender) parts.push(character.gender);
    if (character.age_range) parts.push(`${character.age_range} years old`);
    if (character.build) parts.push(character.build);
    if (character.hair) parts.push(character.hair);
    if (character.distinguishing) parts.push(character.distinguishing);
    if (character.ethnicity) parts.push(character.ethnicity);

    // Add LoRA/TI tokens if available
    if (character.lora_id) parts.push(`<lora:${character.lora_id}:0.8>`);
    if (character.ti_token) parts.push(character.ti_token);

    return parts.join(', ');
}

async function generateRefSheet(req, res, charId) {
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Character not found' }));
    }

    const views = (req.body && req.body.views) || REFSHEET_VIEWS;
    const seed = (req.body && req.body.seed) || null;
    const model = (req.body && req.body.model) || 'sdxl';

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_refsheet_jobs (id, project_id, character_id, status, views, model, seed)
         VALUES (?, ?, ?, 'processing', ?, ?, ?)`
    ).run(jobId, ch.project_id, charId, JSON.stringify(views), model, seed);

    const results = [];
    ensureDir(ch.project_id, 'refsheets');

    // Resolve the image provider for this project (gridlight default → OpenAI/etc when configured).
    const imageProvider = resolve('image', parseProjectConfig(ch.project_id));

    for (const view of views) {
        const project = db.prepare('SELECT style_preset FROM film_projects WHERE id = ?').get(ch.project_id);
        const projectStyle = project && project.style_preset;
        let styleApplied = !!(projectStyle && String(projectStyle).trim());
        const prompt = buildRefSheetPrompt(ch, view, projectStyle);
        const negativePrompt = REFSHEET_NEGATIVE;

        const payload = {
            prompt,
            negative_prompt: negativePrompt,
            model,
            width: 1024,
            height: 1024,
            steps: 30,
            guidance_scale: 7.5,
            seed,
        };

        try {
            let result = await imageProvider.generate('image', payload, { timeout: 300000 });

            // A style written for the FILM can be refused on a reference sheet:
            // it lands beside a full-body physical description, and the pair
            // trips provider moderation where either alone passes. The sheet's
            // job is identity — wardrobe, face, build — and the look can come
            // from the shot prompt at generation time, so a styleless sheet is
            // far better than no sheet. Retried once, and reported: silently
            // dropping the style is how a director ends up anchoring a whole
            // film to a look nobody chose.
            if (!result.ok && styleApplied && /moderation/i.test(String(result.error || ''))) {
                result = await imageProvider.generate('image', {
                    ...payload,
                    prompt: buildRefSheetPrompt(ch, view, null),
                }, { timeout: 300000 });
                if (result.ok) styleApplied = false;
            }

            if (!result.ok) {
                results.push({ view, status: 'failed', error: result.error });
                continue;
            }

            const safeName = ch.name.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filename = `${safeName}_${view}.png`;
            let filePath;
            try {
                filePath = await persistProviderMedia(ch.project_id, 'refsheets', filename, result.data, { serveDir: 'images' });
            } catch (err) {
                results.push({ view, status: 'failed', error: `reference image generated but could not be stored: ${err.message}` });
                continue;
            }

            const assetId = generateId();
            db.prepare(
                // character_id goes in its own column, not only in metadata.
                // The column existed and was left NULL, so anything selecting
                // "this character's reference plates" found nothing — including
                // the storyboard route's reference lookup, which would then
                // silently fall back to prose and lose the continuity the sheet
                // was generated to provide.
                `INSERT INTO film_assets (
                    id, project_id, character_id, asset_type, file_path, file_name, format, mime_type, version, metadata,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'character_sheet', ?, ?, 'png', 'image/png', 1, ?, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, ch.project_id, charId, filePath, filename, JSON.stringify({ character_id: charId, view }),
                result.provider || imageProvider.id, result.provider_model || '', result.provider_job_id || ''
            );

            // The plate that started all of this: generated in a stock clip-art
            // style, fixed fourteen hours later, and still referenced by every
            // frame with this character in it because nothing recorded what it
            // had been made from.
            require('../lib/artefact-fingerprint').stampAsset(assetId, 'character_plate', { charId });

            results.push({ view, status: 'complete', style_applied: styleApplied, image_url: getFileUrl('refsheets', ch.project_id, filename) });
        } catch (err) {
            if (err.message.includes('ECONNREFUSED')) {
                db.prepare('UPDATE film_refsheet_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', 'Image generation service unavailable', jobId);
                res.writeHead(503, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(serviceUnavailableError(IMAGE_ENDPOINT, 'image generation')));
            }
            results.push({ view, status: 'failed', error: err.message });
        }
    }

    const allOk = results.every(r => r.status === 'complete');
    const status = allOk ? 'complete' : 'completed_with_errors';
    db.prepare('UPDATE film_refsheet_jobs SET status = ?, output_paths = ? WHERE id = ?')
        .run(status, JSON.stringify(results), jobId);

    // No render_ledger row here. That table is keyed to a shot — shot_id is a
    // NOT NULL FK to film_shots and step is CHECK-constrained to the nine
    // pipeline steps — so a character reference sheet fits neither column.
    // Writing one threw SQLITE_CONSTRAINT_CHECK from an async handler, which
    // took the whole server process down on every refsheet request.
    // film_refsheet_jobs (updated above) is the source of truth for this job,
    // the same way film_3d_jobs is for 3D assets.

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        character_id: charId, character_name: ch.name, job_id: jobId,
        status, views: results,
    }));
}

function getRefSheetStatus(req, res, charId) {
    const jobs = db.prepare('SELECT * FROM film_refsheet_jobs WHERE character_id = ? ORDER BY created_at DESC').all(charId);
    const assets = db.prepare(
        "SELECT * FROM film_assets WHERE asset_type = 'reference_sheet' AND metadata LIKE ? ORDER BY created_at DESC"
    ).all(`%"character_id":"${charId}"%`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        character_id: charId, jobs, sheets: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            image_url: a.file_name ? getFileUrl('refsheets', a.project_id, a.file_name) : null,
            metadata: a.metadata ? JSON.parse(a.metadata) : null,
        })),
    }));
}

module.exports = { handleCharacters, buildRefSheetPrompt, REFSHEET_NEGATIVE };
