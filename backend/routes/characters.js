/**
 * Character CRUD + voice profiles + costumes + reference sheets
 * POST/GET/PUT/DELETE /film/projects/:id/characters
 * GET /film/characters/:id
 * POST/GET /film/characters/:id/voice
 * POST/GET /film/characters/:id/costumes
 * POST /film/characters/:id/refsheet/generate     — FILM-014: Generate reference sheet
 * GET  /film/characters/:id/refsheet              — FILM-014: Get reference sheet status
 */
const { isolationNegativeFor, subjectPlateOpening, projectMedium } = require('../lib/plate-isolation');
const { orderByViewSql } = require('../lib/plate-views');
const { db, generateId } = require('../db/database');
const { stampSubject } = require('../lib/story-bible');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
// Where a character plate goes, known in ONE place so the collect road files
// one exactly as the live road does. See lib/plate-delivery.js.
const plateDelivery = require('../lib/plate-delivery');
const { resolve } = require('../lib/providers');
const { providerConfigFor } = require('../lib/provider-config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_ENDPOINT = '/image';

// One implementation, in lib/provider-config.js — it also tags the config
// with the project id so spend can be attributed. See that file for why.
const parseProjectConfig = providerConfigFor;

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
            /*
             * A turnaround from ONE orbit rather than three separate rolls.
             *
             * Three plates are three independent generations that can disagree
             * about the face, the wardrobe and the build — and this codebase
             * has already paid for that. Frames of one continuous motion
             * cannot disagree with each other.
             *
             * The preview is free and comes first, like every other paid path
             * here: an orbit spends credits, so the number is shown before the
             * button rather than discovered on the ledger.
             */
            if (urlParts[4] === 'orbit') {
                if (urlParts[5] === 'preview' && req.method === 'GET') return previewOrbit(res, charId, query);
                if (!urlParts[5] && req.method === 'POST') return generateOrbit(req, res, charId);
            }
            /*
             * A character sheet supplied from outside — a photograph, a Midjourney
             * export, art the department already made. It lands under the same
             * per-view filename as a generated sheet, so it REPLACES that view rather
             * than sitting beside it, and every shot referencing the character picks
             * it up with nothing else to change.
             */
            /*
             * The three views of a turnaround, listed.
             *
             * A reference sheet is front, side and back — three files, three
             * asset rows — and there was nowhere in the app to see that they
             * existed. Locations have had `plate/views` since the compass work;
             * characters, which are the subject a turnaround is FOR, had
             * nothing.
             */
            if (urlParts[4] === 'views' && !urlParts[5] && req.method === 'GET') {
                return listRefsheetViews(res, charId);
            }
            if (urlParts[4] === 'views' && urlParts[5] && req.method === 'DELETE') {
                return deleteRefsheetView(res, charId, decodeURIComponent(urlParts[5]));
            }

            if (urlParts[4] === 'import' && req.method === 'POST') {
                const body = req.body || {};
                if (!body.data) return badRequest(res, 'no image supplied');
                try {
                    const imported = require('../lib/media-imports').importMedia('character-plate', {
                        subjectId: charId, data: body.data, view: body.view, name: body.name,
                    });
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ kind: 'character', ...imported }));
                } catch (err) {
                    res.writeHead(/not found/i.test(err.message) ? 404 : 400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: err.message }));
                }
            }
            // FREE: what a generation would send, before any of it is bought.
            if (urlParts[4] === 'preview' && req.method === 'GET') {
                return previewRefSheet(req, res, charId, query);
            }
            if (urlParts[4] === 'generate' && req.method === 'POST') {
                return generateRefSheet(req, res, charId);
            }
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
        // Front first, for the same reason the prompt gather takes the front:
        // a card showing the back of someone's head identifies nobody.
        //
        /*
         * MATCHED ON THE COLUMN, NOT ON A SHAPE OF THE JSON.
         *
         * This was `metadata LIKE '%"character_id":"…"%"view":"front"%'` — both
         * keys required, in that order, inside the blob. A GENERATED plate
         * happens to write them that way. An UPLOADED one does not: it carries
         * the link in the character_id column and records
         * {kind, imported, style_applied, view}. So a character whose plate was
         * uploaded reported has_plate TRUE and showed NO PICTURE on the card —
         * the same two-queries-disagreeing split this function documents for
         * the picker below, arrived at from the other side.
         *
         * No view filter either. The pattern demanded `front`, so a character
         * plated only in profile had a plate the card could not show. Ranked
         * front-first and take the best one there is.
         *
         * A demoted plate is skipped: `gallery_promote` writes plate_role, and
         * a concept is by definition the picture nobody chose.
         */
        `SELECT file_name, project_id, version, created_at FROM film_assets
           WHERE asset_type = 'character_sheet' AND character_id = ?
             AND COALESCE(json_extract(metadata, '$.plate_role'), 'reference') = 'reference'
           ORDER BY ${orderByViewSql()}, created_at DESC LIMIT 1`
    );

    for (const ch of rows) {
        ch.costume_count = costumeCount.get(ch.id).count;
        ch.has_voice_profile = !!voiceCheck.get(ch.id);
        const refsheet = refsheetCheck.get(ch.id);
        // Keyed to the plate's own row so a regeneration through MCP is visible
        // without a hard refresh.
        ch.reference_image_url = refsheet
            ? getFileUrl('refsheets', refsheet.project_id, refsheet.file_name,
                refsheet.created_at || refsheet.version)
            : null;
    }

    /*
     * Whether each character has a reference plate, from the SAME query the
     * gatherer uses to attach one — the two answers have to agree.
     *
     * The picker that shows this used three invented field names
     * (`plate_asset_id`, `has_plate`, `refsheet_asset_id`), none of which any
     * route returns, so every subject in every project reported "no plate":
     * telling a director their cast would be invented fresh in each frame when
     * it was already plated, which is misinformation in the direction that
     * costs money to act on.
     */
    try {
        const { platedSubjects } = require('../lib/shot-references');
        const byId = new Map(platedSubjects(db, projectId).characters.map(p => [p.id, p.has_plate]));
        for (const ch of rows) ch.has_plate = !!byId.get(ch.id);
    } catch (_) { /* the list is still a list without it */ }


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

/**
 * The fields a character write accepts, as a SET clause.
 *
 * ONE LIST, USED BY BOTH PATHS. `createCharacter` carried its own INSERT column
 * list, written when the table was smaller and never grown -- so `height_m`,
 * `lora_id` and `ti_token` reached the update path and were silently dropped on
 * create. `height_m` is the one that costs: it produces the scale clause in an
 * image prompt, so a character created and never updated generates at whatever
 * size the model imagines, and nothing reports it.
 *
 * Returning the clause rather than performing the write is what lets create
 * INSERT its identity and then apply exactly what update would apply. A second
 * list is how the first one went stale.
 */
function characterFields(body) {
    const fields = [];
    const values = [];

    /*
     * THE SHEET FIELDS ARE PROMPT INPUT, AND THEY WERE CAPPED LIKE LABELS.
     *
     * build, hair, distinguishing and ethnicity are pushed straight into the
     * character plate prompt a few hundred lines below -- they are not
     * captions on a card. At 100 characters `build` held "Tall and lean at
     * 1.85m, long-limbed, narrow through the hips, shoulders square without
     * bulk -- a fram", cut there, silently, with a 200 OK and the stump echoed
     * back. Every one of these fields was written at 300-900 characters for
     * Northline and every one was stumped on save.
     *
     * Same failure as lighting_default at fifty and the orientation plan at
     * two hundred: a cap set to the width of the thing that DISPLAYS the field
     * rather than to the length of the thing that is written into it. The
     * sheet is what clamps what it draws.
     *
     * `age_range` and `gender` keep their fifty -- they really are short.
     */
    const textFields = {
        name: 200, description: 5000, appearance_prompt: 2000,
        personality_notes: 2000, age_range: 50, gender: 50,
        ethnicity: 300, build: 800, hair: 800, distinguishing: 1500,
        lora_id: 200, ti_token: 200
    };

    for (const [field, maxLen] of Object.entries(textFields)) {
        if (body[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(String(body[field]).slice(0, maxLen));
        }
    }

    // Height in metres. Validated as a number rather than a length-capped
    // string: it is the one field here the prompt divides by.
    if (body.height_m !== undefined) {
        const n = Number(body.height_m);
        if (!Number.isFinite(n) || n <= 0) {
            return { error: 'height_m must be a positive number of metres' };
        }
        fields.push('height_m = ?');
        values.push(n);
    }

    if (body.reference_images !== undefined) {
        fields.push('reference_images = ?');
        values.push(JSON.stringify(body.reference_images));
    }

    return { fields, values };
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

    /*
     * Validated BEFORE the row exists, so a bad height cannot leave a
     * half-made character behind for someone to find later.
     */
    const built = characterFields(body);
    if (built.error) return badRequest(res, built.error);

    const id = generateId();

    /*
     * Identity only. Every other column carries its own default, and the
     * values come from the SAME builder the update path uses -- which is what
     * stops this list going stale again the next time a column is added.
     */
    db.prepare(`INSERT INTO film_characters (id, project_id, name, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))`)
        .run(id, projectId, body.name.trim().slice(0, 200));

    if (built.fields.length) {
        db.prepare(`UPDATE film_characters SET ${built.fields.join(', ')} WHERE id = ?`)
            .run(...built.values, id);
    }

    const row = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateCharacter(req, res, charId) {
    // Which part of the story bible this description was written from.
    //
    // Recorded here rather than inferred later, because only the person writing
    // the words knows which section they were reading. Without it a bible
    // revision can say "something changed" and never "and MAYA's appearance came
    // from it", which is the difference between a note and an instruction.
    if (req.body && req.body.bible_section) {
        stampSubject('character', charId, String(req.body.bible_section));
    }
    const body = req.body;
    const propagateToScreenplay = body.propagate_to_screenplay !== false;

    // Get current character to check for name changes
    const currentChar = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!currentChar) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Character not found' }));
        return;
    }

    const built = characterFields(body);
    if (built.error) return badRequest(res, built.error);
    const { fields, values } = built;

    // Recording where a description came from is a change in itself, and does
    // not require rewriting the description to say it. Refusing a link-only
    // update would mean an agent that has just read the bible has to touch the
    // text to record that it did.
    if (fields.length === 0 && req.body && req.body.bible_section) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ linked: true, bible_section: String(req.body.bible_section) }));
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
const REFSHEET_NEGATIVE_BASE = 'blurry, low quality, distorted, multiple characters, '
    + 'text, label, labels, annotation, annotations, caption, handwriting, chart, colour chart, '
    + 'swatch, swatches, watermark, logo, arrows, callouts, measurement marks, collage, multiple views';

/*
 * The negative is what actually holds once the style has spent four hundred
 * characters describing a place. "background clutter" asked for a TIDY room;
 * the isolation list refuses the room.
 */
const REFSHEET_NEGATIVE = isolationNegativeFor('character', REFSHEET_NEGATIVE_BASE);

function buildRefSheetPrompt(character, view, stylePreset, projectId) {
    const parts = [];
    const style = stylePreset && String(stylePreset).trim();
    // The board decides the medium. With no board entry this is photoreal —
    // never nothing, because nothing is what a model fills in with clip art.
    const medium = projectMedium(projectId);

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
    /*
     * Isolation is said WITH the medium, not three clauses later.
     *
     * The backdrop was already asked for and the plates still came back with
     * full rooms behind the subject, because a real style preset is largely a
     * description of a SCENE — "hard low-sun key raking through glass",
     * "practical tungsten warmth blooming in frame" — stated first and at
     * length, against three trailing words. Whatever leads is what the image
     * is of, and that applies to what is NOT in it too.
     */
    /*
     * THE EMPTY FRAME IS THE FIRST THING SAID.
     *
     * Isolation after the style was not enough, and the measurement is the
     * argument: a real preset put 276 characters of "hard low-sun key raking
     * through glass … shafts in heavy haze … practical tungsten warmth
     * blooming in frame" ahead of it. Every one of those is a room with a
     * window, asserted first and at length.
     *
     * The medium is still explicit and still leads, so the clip-art defect
     * this ordering was built against does not return: "photoreal full-body
     * studio photograph" names a medium far more plainly than a colour palette
     * does. What must never lead again is `character reference sheet, front
     * view, T-pose`, which names a DOCUMENT.
     */
    /*
     * THE MEDIUM, NOT THE STYLE PRESET.
     *
     * The preset describes finished frames — light through windows, practicals
     * in shot — so on a plate it asks for the room the plate exists to
     * exclude. A plate needs exactly one thing from the look: what KIND of
     * picture this is. Photoreal, 3D render, cel animation. That is what has
     * to match across a production, and leaving it unsaid is what made a plate
     * come back as a flat vector cutout.
     *
     * `stylePreset` is still accepted so every existing caller and test keeps
     * working; it is used only when the board records no medium, and only its
     * medium-bearing intent is wanted.
     */
    parts.push(subjectPlateOpening(medium, 'Full-body studio image of the subject'));
    // The view still has to be named, or three plates are three unrelated
    // pictures rather than a turnaround.
    parts.push(`${view} view of the subject`);
    parts.push(style
        ? 'standing, arms slightly away from body, neutral expression'
        : 'standing, arms slightly away from body');

    if (character.appearance_prompt) parts.push(character.appearance_prompt);
    if (character.gender) parts.push(character.gender);
    if (character.age_range) parts.push(`${character.age_range} years old`);
    if (character.build) parts.push(character.build);
    if (character.hair) parts.push(character.hair);
    if (character.distinguishing) parts.push(character.distinguishing);
    if (character.ethnicity) parts.push(character.ethnicity);

    // How tall they are, on the plate that establishes them.
    //
    // This reached the keyframe prompt and never the plate — backwards, because
    // a plate is a full-frame studio photograph and conditioning transfers
    // appearance rather than scale, so every frame referencing it inherits
    // whatever height the plate happened to imply.
    try {
        const { scalePhrase } = require('../lib/subject-scale');
        const note = scalePhrase(character.name || 'the subject', 'character', character, null);
        if (note) parts.push(note);
    } catch (_) { /* a character with no declared height plates exactly as before */ }

    // Add LoRA/TI tokens if available
    if (character.lora_id) parts.push(`<lora:${character.lora_id}:0.8>`);
    if (character.ti_token) parts.push(character.ti_token);

    return parts.join(', ');
}


/**
 * FREE. What generating this character's reference sheet would send.
 *
 * A ref sheet is three views from one call, so the preview shows the view that
 * would be generated FIRST — editing here replaces that view's prompt, and a
 * caller wanting one specific view sends `views`.
 */
function previewRefSheet(req, res, charId, query) {
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!ch) { res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Character not found' })); }
    const project = db.prepare('SELECT id, style_preset FROM film_projects WHERE id = ?').get(ch.project_id);

    const q = query || {};
    const { imageOverride } = require('../lib/generation-override');
    const tierOverride = imageOverride({ quality: q.quality, provider: q.provider, model: q.model });
    const providers = require('../lib/providers');
    const { spendContext } = require('../lib/provider-config');
    const adapter = providers.get(providers.resolveId('image',
        spendContext(project || { id: ch.project_id }, null, null, tierOverride)));

    const view = q.view || REFSHEET_VIEWS[0];
    const prompt = buildRefSheetPrompt(ch, view, project && project.style_preset, ch.project_id);
    const payload = require('../lib/capability-payloads').withTierModel(
        { prompt }, { project: project || { id: ch.project_id }, tierOverride }, adapter);

    let cost = null;
    try {
        const rate = require('../lib/provider-pricing').rateFor(adapter.id, 'image', payload.model);
        if (rate) cost = { usd: rate.usd_per_unit !== undefined ? rate.usd_per_unit : rate.usd_per_native,
            native: rate.native_per_unit, native_unit: rate.native_unit,
            // Three views by default, so the sheet costs three times a frame.
            views: REFSHEET_VIEWS.length };
    } catch (_) { /* an unpriced pair must not break a free preview */ }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        character_id: charId, view, views: REFSHEET_VIEWS,
        provider: adapter && adapter.id, model: payload.model || null,
        prompt, prompt_length: prompt.length,
        ceiling: Number(adapter && adapter.promptLimit) || null,
        estimated_cost: cost,
        note: 'Nothing was generated and nothing was spent.',
    }));
}

async function generateRefSheet(req, res, charId) {
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Character not found' }));
    }

    const views = (req.body && req.body.views) || REFSHEET_VIEWS;
    const seed = (req.body && req.body.seed) || null;
    /*
     * No default model.
     *
     * This named a model none of the image providers wired here offers, so
     * Meshy fell through to its own default of nano-banana-pro at 9 credits —
     * every reference sheet silently buying the most expensive model in the
     * catalogue while ignoring the project's quality tier entirely.
     *
     * The job row keeps a readable value; the PAYLOAD gets nothing unless a
     * caller asked, which lets the tier decide.
     */
    const model = (req.body && req.body.model) || null;

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_refsheet_jobs (id, project_id, character_id, status, views, model, seed)
         VALUES (?, ?, ?, 'processing', ?, ?, ?)`
    ).run(jobId, ch.project_id, charId, JSON.stringify(views), model, seed);

    const results = [];
    ensureDir(ch.project_id, 'refsheets');

    // Resolve the image provider for this project (gridlight default → OpenAI/etc when configured).
    const { imageOverride, promptOverride } = require('../lib/generation-override');
    const tierOverride = imageOverride(req.body || {});
    const promptEdit = promptOverride(req.body || {});
    const imageProvider = resolve('image',
        require('../lib/provider-config').spendContext({ id: ch.project_id }, null, null, tierOverride)
            || parseProjectConfig(ch.project_id));

    for (const view of views) {
        const project = db.prepare('SELECT style_preset FROM film_projects WHERE id = ?').get(ch.project_id);
        const projectStyle = project && project.style_preset;
        let styleApplied = !!(projectStyle && String(projectStyle).trim());
        // The board's look as a picture, not only as the words it composed into
        // style_preset. A plate conditions every frame its subject appears in,
        // so a sheet generated outside the film's look drags all of them with
        // it. One reference only: a turnaround has one subject, and a second
        // look plate starts voting on who that is.
        const styleRefs = require('../lib/reference-plates').styleReferencesFor(db, ch.project_id);
        let prompt = styleRefs.length && styleRefs[0].tag
            ? `${buildRefSheetPrompt(ch, view, projectStyle, ch.project_id)}, in the light, palette and colour grade of @${styleRefs[0].tag}`
            : buildRefSheetPrompt(ch, view, projectStyle, ch.project_id);
        /*
         * An edited prompt replaces the composed one for THIS view.
         *
         * A ref sheet generates front, side and back from one call, and they
         * are different prompts — so an override applies to whichever view is
         * being generated rather than flattening all three into one picture
         * repeated. A caller wanting one specific view sends `views`.
         */
        if (promptEdit) prompt = promptEdit;
        const negativePrompt = REFSHEET_NEGATIVE;

        const payload = {
            prompt,
            negative_prompt: negativePrompt,
            ...(styleRefs.length ? { reference_images: styleRefs } : {}),
            // Absent rather than null: a null falls through to the provider's own
            // default, which is the most expensive model it sells.
            ...(model ? { model } : {}),
            width: 1024,
            height: 1024,
            steps: 30,
            guidance_scale: 7.5,
            seed,
        };

        try {
            /*
             * A reference sheet is generated on the film's chosen quality too.
             *
             * A plate conditions every frame its subject appears in, so making
             * one outside the tier the production chose drags all of them with
             * it — the same reason the board and the plates had to agree about
             * resolution and aspect.
             */
            require('../lib/capability-payloads').withTierModel(
                payload, { project: { id: ch.project_id }, tierOverride }, imageProvider);

            let result = await imageProvider.generate('image', payload, {
                timeout: 300000,
                /*
                 * WHAT THIS GENERATION IS, written onto the handle.
                 *
                 * The adapter contributes the capability — `image` — which is
                 * equally true of a keyframe and a mood board, so it cannot say
                 * where the bytes belong. A render that outruns the host window
                 * is delivered later by `generation_collect`, which holds the
                 * handle and not this payload: without this the plate came back
                 * as a loose file and the character library never saw it.
                 */
                jobMeta: plateDelivery.jobMeta({
                    projectId: ch.project_id, characterId: charId,
                    characterName: ch.name, view, styleApplied }),
            });

            // A style written for the FILM can be refused on a reference sheet:
            // it lands beside a full-body physical description, and the pair
            // trips provider moderation where either alone passes. The sheet's
            // job is identity — wardrobe, face, build — and the look can come
            // from the shot prompt at generation time, so a styleless sheet is
            // far better than no sheet. Retried once, and reported: silently
            // dropping the style is how a director ends up anchoring a whole
            // film to a look nobody chose.
            if (!result.ok && styleApplied && /moderation/i.test(String(result.error || ''))) {
                // The look drops whole — its words AND its picture. Retrying
                // with the reference still attached re-sends what may have been
                // refused, and would report style_applied: false while the look
                // was in fact still applied.
                const { reference_images: _dropped, ...styleless } = payload;
                result = await imageProvider.generate('image', {
                    ...styleless,
                    prompt: buildRefSheetPrompt(ch, view, null, ch.project_id),
                }, {
                    timeout: 300000,
                    // The retry is a different handle, and the look is off it.
                    jobMeta: plateDelivery.jobMeta({
                        projectId: ch.project_id, characterId: charId,
                        characterName: ch.name, view, styleApplied: false }),
                });
                if (result.ok) styleApplied = false;
            }

            if (!result.ok) {
                results.push({ view, status: 'failed', error: result.error });
                continue;
            }

            /*
             * Filed by lib/plate-delivery, which `generation_collect` also calls.
             *
             * This block used to live here in full — persist, drop the stale row
             * for this view, insert, stamp — and the collect road had no copy of
             * it. So a plate that came back late was stored and never registered.
             * Two roads, one filing rule.
             */
            const filed = await plateDelivery.fileCharacterPlate({
                projectId: ch.project_id, characterId: charId, characterName: ch.name, view,
                data: result.data,
                provider: result.provider || imageProvider.id,
                providerModel: result.provider_model || '',
                providerJobId: result.provider_job_id || '',
                styleApplied,
            });
            if (!filed.ok) {
                results.push({ view, status: 'failed', error: filed.error });
                continue;
            }

            results.push({ view, status: 'complete', style_applied: styleApplied,
                image_url: filed.image_url });
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
            image_url: a.file_name ? getFileUrl('refsheets', a.project_id, a.file_name, a.created_at || a.version) : null,
            metadata: a.metadata ? JSON.parse(a.metadata) : null,
        })),
    }));
}


/**
 * Every stored view of a character, in turnaround order.
 *
 * Ordered front → side → back rather than by recency, because that is the
 * order a person reads a turnaround in, and because the front is the one that
 * matters: it is what conditions every frame the character appears in.
 */
function listRefsheetViews(res, charId) {
    const fs = require('fs');
    const path = require('path');
    const { viewRank } = require('../lib/plate-views');

    const ch = db.prepare('SELECT id, project_id, name FROM film_characters WHERE id = ?').get(charId);
    if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Character not found' }));
    }

    const rows = db.prepare(
        `SELECT id, file_name, file_path, metadata, created_at FROM film_assets
          WHERE project_id = ? AND character_id = ?
            AND asset_type IN ('character_sheet', 'reference_image')
       ORDER BY created_at ASC`).all(ch.project_id, charId);

    const views = rows.map(r => {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }
        const view = String(meta.view || '').trim();

        // Whether the picture is really THERE — the same mistake plate views
        // made once already, manufacturing a URL for a file that was gone.
        let available = false;
        try { available = !!(r.file_path && fs.existsSync(r.file_path)); } catch (_) { available = false; }
        const subdir = (() => {
            try { return path.basename(path.dirname(path.dirname(r.file_path))); } catch (_) { return null; }
        })();

        return {
            asset_id: r.id,
            view: view || 'front',
            is_identity_plate: false,        // filled in below
            file_name: r.file_name,
            available,
            unavailable_reason: available ? null : 'Picture unavailable — generate this view again.',
            image_url: (available && subdir)
                ? getFileUrl(subdir, ch.project_id, r.file_name, r.created_at) : null,
            created_at: r.created_at,
        };
    }).sort((a, b) => viewRank(a.view) - viewRank(b.view)
        || String(a.created_at).localeCompare(String(b.created_at)));

    /*
     * WHICH ONE ACTUALLY REACHES A PROMPT, said out loud.
     *
     * Three plates exist and exactly one is attached to a frame — the
     * reference budget is three on Runway and five on Meshy, shared with the
     * location, the props and the anchor, so a second view of the same person
     * costs a slot a subject with no picture at all would otherwise get.
     * Which one that is used to be invisible, and it was the wrong one.
     */
    const identity = views.find(v => v.available);
    if (identity) identity.is_identity_plate = true;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        character_id: charId,
        character: ch.name,
        views,
        identity_plate: identity ? identity.view : null,
        note: identity
            ? `Every frame ${ch.name} appears in is conditioned on the ${identity.view} view. `
              + 'The others are kept for reference and for a shot that needs them.'
            : 'No usable plate yet — every frame will invent this character from the description alone.',
    }));
}

/** Remove one view: the row and the file together. */
function deleteRefsheetView(res, charId, rawView) {
    const fs = require('fs');
    const view = String(rawView || '').trim().toLowerCase();

    const ch = db.prepare('SELECT id, project_id, name FROM film_characters WHERE id = ?').get(charId);
    if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Character not found' }));
    }

    const rows = db.prepare(
        `SELECT id, file_path, metadata FROM film_assets
          WHERE project_id = ? AND character_id = ?
            AND asset_type IN ('character_sheet', 'reference_image')`).all(ch.project_id, charId);

    const match = rows.find(r => {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }
        return String(meta.view || 'front').trim().toLowerCase() === view;
    });
    if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `${ch.name} has no ${view} view` }));
    }

    /*
     * THE ROW GOES; THE PICTURE IS SET ASIDE, NOT DESTROYED.
     *
     * A plate cost money to generate, and a turnaround puts three of them
     * behind three Delete buttons. Unlinking makes one mis-click
     * unrecoverable — and "generation is a coin flip you already paid for" is
     * exactly why archiveExistingFrame keeps every storyboard attempt instead
     * of overwriting it.
     *
     * The ROW still goes, so the view stops being listed and stops reaching a
     * prompt: a row pointing at nothing is the half-delete the original
     * comment guarded against, and it still is. What changes is that the bytes
     * survive under `deleted/` for anyone who has to put one back by hand.
     */
    if (match.file_path) {
        try {
            const graveyard = path.join(path.dirname(match.file_path), 'deleted');
            fs.mkdirSync(graveyard, { recursive: true });
            fs.renameSync(match.file_path,
                path.join(graveyard, `${Date.now()}_${path.basename(match.file_path)}`));
        } catch (_) {
            // Already gone, or the disk will not take it. Either way the row
            // must still go, or the app lists a view with no picture.
        }
    }
    db.prepare('DELETE FROM film_assets WHERE id = ?').run(match.id);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ character_id: charId, deleted_view: view }));
}

/**
 * What an orbit turnaround would cost and produce. Spends nothing.
 */
function previewOrbit(res, charId, query) {
    const { orbitPlan, orbitPrompt, ORBIT_VIEWS } = require('../lib/character-orbit');
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!ch) return json(res, 404, { error: 'Character not found' });

    const seconds = Number((query || {}).seconds) || 5;
    const plan = orbitPlan({ seconds });
    const front = frontPlateUriFor(ch);
    const built = orbitPrompt(ch, projectMedium(ch.project_id, db), { frontPlateUri: front || undefined });

    return json(res, 200, {
        character: ch.name,
        seconds,
        views: ORBIT_VIEWS.map(v => v.view),
        frames: plan.frames,
        estimate: { credits: plan.credits, usd: plan.usd },
        compared_to: plan.comparedTo,
        saving_credits: plan.saving,
        seeded_from_front_plate: !!front,
        warnings: front ? [] : [
            'No front plate yet. The orbit will invent this character rather than turning the '
            + 'one you approved — generate the front plate first, or accept a new face.',
        ],
        prompt: built.prompt,
        negative_prompt: built.negative_prompt,
        note: 'Nothing was generated and nothing was spent.',
    });
}

/** The approved front plate, as a data URI, or null. */
function frontPlateUriFor(ch) {
    try {
        const row = db.prepare(
            `SELECT file_name FROM film_assets
              WHERE character_id = ? AND asset_type = 'character_sheet'
                AND json_extract(metadata, '$.view') = 'front'
              ORDER BY created_at DESC LIMIT 1`).get(ch.id);
        if (!row) return null;
        const fsx = require('fs');
        const { getFilePath } = require('../lib/file-storage');
        const p = getFilePath(ch.project_id, 'refsheets', row.file_name);
        if (!fsx.existsSync(p)) return null;
        return `data:image/png;base64,${fsx.readFileSync(p).toString('base64')}`;
    } catch (_) { return null; }
}

/**
 * Generate the orbit, then cut it into the turnaround.
 *
 * The frames are stored exactly as generated plates are — same per-view
 * filename, same per-view replacement — so `gatherShotReferences` and
 * `headlinePlate` pick them up with nothing else to change.
 */
async function generateOrbit(req, res, charId) {
    const { orbitPlan, orbitPrompt, mayOverwrite } = require('../lib/character-orbit');
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!ch) return json(res, 404, { error: 'Character not found' });

    const seconds = Number((req.body || {}).seconds) || 5;
    const plan = orbitPlan({ seconds });
    const built = orbitPrompt(ch, projectMedium(ch.project_id, db),
        { frontPlateUri: frontPlateUriFor(ch) || undefined });

    const provider = resolve('video', parseProjectConfig(ch.project_id));
    const result = await provider.generate('video', {
        prompt: built.prompt,
        negative_prompt: built.negative_prompt,
        init_image: built.init_image,
        motion: built.motion,
        camera_control: built.camera_control,
        duration_s: seconds,
        model: (req.body || {}).model || 'gen4_turbo',
        width: 1280, height: 720,
    }, { timeout: 300000 });
    if (!result.ok) return json(res, result.status || 500, { error: result.error });

    const fsx = require('fs');
    const pathx = require('path');
    ensureDir(ch.project_id, 'video');
    const clipName = `${String(ch.name).replace(/[^\w.-]/g, '_')}_orbit.mp4`;
    let clipPath;
    try {
        clipPath = await persistProviderMedia(ch.project_id, 'video', clipName, result.data, { serveDir: 'videos' });
    } catch (err) {
        return json(res, 502, { error: `orbit generated but could not be stored: ${err.message}` });
    }

    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const bin = resolveFfmpeg();
    if (!bin || !bin.available) {
        return json(res, 200, {
            clip: clipName, views: [],
            error: 'The orbit was generated but no encoder is available to cut it into frames. '
                + 'Install ffmpeg, or set FFMPEG_PATH.',
        });
    }

    ensureDir(ch.project_id, 'refsheets');
    const safeName = String(ch.name).replace(/[^\w.-]/g, '_');
    const made = [];
    const kept = [];
    for (const frame of plan.frames) {
        const filename = `${safeName}_${frame.view}.png`;
        const filePath = require('../lib/file-storage').getFilePath(ch.project_id, 'refsheets', filename);

        /*
         * CUT TO A SCRATCH PATH, NOT OVER THE PLATE.
         *
         * `filename` is exactly what plateFileName() gives a character view, so
         * cutting straight to it meant ffmpeg -y had already destroyed the
         * approved plate's pixels BEFORE mayOverwrite() was consulted — and the
         * decline path then unlinked the file outright, leaving the approved
         * row pointing at nothing. Declining to replace a plate was the one
         * operation that reliably destroyed it.
         *
         * The frame is only moved into place once we know we may take the view.
         */
        const scratchPath = filePath + '.orbit-cut';
        try {
            require('child_process').execFileSync(bin.bin,
                ['-y', '-ss', String(frame.atSeconds), '-i', clipPath, '-frames:v', '1', '-q:v', '2', scratchPath],
                { stdio: 'ignore', timeout: 30000 });
        } catch (_) { continue; }
        if (!fsx.existsSync(scratchPath)) continue;

        /*
         * A BOOTSTRAP, not the identity source.
         *
         * The guide says this twice, and the first version of this route
         * ignored it: it replaced every view it produced, including FRONT —
         * the picture that attaches to every shot this character appears in. A
         * cheap orbit frame silently overwriting an approved anchor is exactly
         * what "not the final identity source" is warning about.
         *
         * So an identity view is filled only when it is empty. Any other angle
         * is refreshed freely, with the same per-view replacement the still
         * plates use, because two rows claiming one view means "the plate" is
         * whichever the query happens to return.
         */
        const stale = db.prepare(
            `SELECT id FROM film_assets
              WHERE project_id = ? AND character_id = ?
                AND asset_type IN ('character_sheet', 'reference_image')
                AND json_extract(metadata, '$.view') = ?`
        ).all(ch.project_id, charId, frame.view);
        if (!mayOverwrite(frame.view, { approved: stale.length > 0 })) {
            // Reported, never silent: a view the orbit declined to take is a
            // thing the director asked for and did not get.
            kept.push({ view: frame.view, reason: 'an approved identity anchor already exists — '
                + 'an orbit frame is a bootstrap and will not replace it' });
            // Only the scratch cut is removed. The approved plate is untouched:
            // it was never written over.
            try { fsx.unlinkSync(scratchPath); } catch (_) { /* the frame we just cut */ }
            continue;
        }
        // Taken: the cut becomes the plate for this view.
        try { fsx.renameSync(scratchPath, filePath); } catch (_) { continue; }
        for (const old of stale) db.prepare('DELETE FROM film_assets WHERE id = ?').run(old.id);

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, character_id, asset_type, file_path, file_name, format, mime_type,
                version, metadata, provider, provider_model, license_source, license_status
             ) VALUES (?, ?, ?, 'character_sheet', ?, ?, 'png', 'image/png', 1, ?, ?, ?, 'generated', 'generated')`
        ).run(assetId, ch.project_id, charId, filePath, filename,
            JSON.stringify({ character_id: charId, view: frame.view, from: 'orbit', at_seconds: frame.atSeconds }),
            provider.id, result.provider_model || '');
        /*
         * Stamped like every other generated plate. An orbit frame that
         * persists without a fingerprint carries NULL, and NULL means "outside
         * the workflow" — so a character whose appearance is rewritten would
         * never report the turnaround cut from the old description as behind.
         * stampAsset never throws: a fingerprint that cannot be computed must
         * not fail a generation that already succeeded and cost money.
         */
        require('../lib/artefact-fingerprint').stampAsset(assetId, 'character_plate', { charId });
        made.push({ view: frame.view, file: filename, at_seconds: frame.atSeconds });
    }

    return json(res, 200, {
        character: ch.name,
        clip: clipName,
        views: made,
        kept_existing: kept,
        estimate: { credits: plan.credits, usd: plan.usd },
        note: made.length
            ? `Turnaround cut from one orbit — ${made.length} views that cannot disagree with each other.`
                + (kept.length ? ` ${kept.length} left alone: an orbit bootstraps a turnaround, it does not replace an approved identity anchor.` : '')
            : 'The orbit generated but no frames could be cut from it.',
    });
}


module.exports = { handleCharacters, buildRefSheetPrompt, REFSHEET_NEGATIVE };
