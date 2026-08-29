/**
 * Casting a voice, and hearing a line before anything is shot.
 *
 *   GET    /film/voices                          — the catalogue, FREE
 *   GET|PUT|DELETE /film/characters/:id/voice    — cast a part
 *   GET    /film/projects/:id/casting            — who is cast, who is not, FREE
 *   GET    /film/audition/preview                — what an audition would send, FREE
 *   POST   /film/audition                        — hear one line (PAID, attached to nothing)
 *   GET    /film/scenes/:id/table-read           — the scene's lines in order, FREE
 *   POST   /film/scenes/:id/table-read           — hear the scene (PAID)
 *
 * An AUDITION is deliberately not a generation. It attaches to no shot and
 * registers no asset, because an audition that looked like a take would be
 * picked up by the pipeline and ship a reading the director was only trying.
 */

const crypto = require('crypto');
const { db, generateId } = require('../db/database');
const VC = require('../lib/voice-casting');
const { resolveGenerator } = require('../lib/providers');
const { providerConfigOf } = require('../lib/provider-config');
const { saveFile, getFileUrl } = require('../lib/file-storage');
const { buildVoicePayload } = require('../lib/dialogue-builder');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/* ── the catalogue ─────────────────────────────────────────────────────── */

let CATALOGUE = null;   // { at, voices } — the account's voices change rarely

async function getVoices(req, res, query) {
    const fresh = query && query.refresh === 'true';
    if (CATALOGUE && !fresh && Date.now() - CATALOGUE.at < 10 * 60 * 1000) {
        return json(res, 200, { free: true, cached: true, ...CATALOGUE.body });
    }
    const { listVoices } = require('../lib/providers/elevenlabs');
    const result = await listVoices({});
    const body = {
        ok: result.ok,
        total: (result.voices || []).length,
        voices: (result.voices || []).map(VC.normaliseVoice),
        ...(result.ok ? {} : { error: result.error }),
    };
    if (result.ok) CATALOGUE = { at: Date.now(), body };
    return json(res, result.ok ? 200 : 502, { free: true, cached: false, ...body });
}

/* ── casting a character ───────────────────────────────────────────────── */

function characterOr404(res, id) {
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(id);
    if (!ch) { json(res, 404, { error: 'Character not found' }); return null; }
    return ch;
}

function profileFor(characterId) {
    return db.prepare(
        'SELECT * FROM film_voice_profiles WHERE character_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(characterId) || null;
}

/** Which voice each OTHER character in this project is already cast in. */
function takenVoices(projectId, exceptCharacterId) {
    const out = {};
    for (const row of db.prepare(
        `SELECT c.name, c.id, p.voice_id FROM film_characters c
           JOIN film_voice_profiles p ON p.character_id = c.id
          WHERE c.project_id = ? AND p.voice_id IS NOT NULL`).all(projectId)) {
        if (row.id === exceptCharacterId) continue;
        out[row.voice_id] = row.name;
    }
    return out;
}

async function getCasting(req, res, characterId) {
    const ch = characterOr404(res, characterId);
    if (!ch) return;
    const profile = profileFor(characterId);

    /*
     * The catalogue, ordered for THIS character.
     *
     * The engine already knows the character's gender and age; a flat list of
     * twenty-one voices makes the director re-derive that by ear. Ranked rather
     * than filtered, and what the sheet does not record is NAMED — the fix is
     * one edit away on the same page, and an unexplained flat list looks broken.
     */
    let suggestions = null;
    try {
        const { listVoices } = require('../lib/providers/elevenlabs');
        const cat = (CATALOGUE && Date.now() - CATALOGUE.at < 10 * 60 * 1000)
            ? { ok: true, voices: null } : null;
        const result = cat ? { ok: true, voices: CATALOGUE.body.voices }
            : await listVoices({});
        const voices = cat ? CATALOGUE.body.voices : (result.voices || []).map(VC.normaliseVoice);
        if (voices.length) {
            suggestions = VC.suggestVoices(ch, voices, takenVoices(ch.project_id, ch.id));
        }
    } catch (_) { /* the catalogue is a convenience; casting still works without it */ }

    return json(res, 200, {
        ...(suggestions ? { suggestions } : {}),
        character_id: ch.id, name: ch.name,
        cast: !!(profile && profile.voice_id),
        voice_id: profile ? profile.voice_id : null,
        voice_name: profile ? profile.name : null,
        cast_note: profile ? profile.cast_note : null,
        ...(profile && profile.voice_id ? {} : {
            warning: 'Not cast. Every line will generate in the provider’s default voice, which '
                + 'sounds like a decision rather than an omission.',
        }),
    });
}

function setCasting(req, res, characterId) {
    const ch = characterOr404(res, characterId);
    if (!ch) return;
    const body = req.body || {};
    if (!body.voice_id) return json(res, 400, { error: 'voice_id is required' });

    const existing = profileFor(characterId);
    if (existing) {
        // An unchanged save writes nothing: "did that apply?" is a free question.
        if (existing.voice_id === body.voice_id
            && (body.voice_name === undefined || existing.name === body.voice_name)
            && (body.cast_note === undefined || existing.cast_note === body.cast_note)) {
            return json(res, 200, { character_id: ch.id, voice_id: existing.voice_id, changed: false });
        }
        db.prepare('UPDATE film_voice_profiles SET voice_id = ?, name = ?, cast_note = ? WHERE id = ?')
            .run(body.voice_id, body.voice_name || existing.name, body.cast_note ?? existing.cast_note,
                existing.id);
    } else {
        db.prepare(
            `INSERT INTO film_voice_profiles (id, project_id, character_id, name, voice_id, cast_note, language)
             VALUES (?, ?, ?, ?, ?, ?, 'en')`
        ).run(generateId(), ch.project_id, ch.id, body.voice_name || ch.name,
            body.voice_id, body.cast_note || null);
    }
    // The character row's pointer, so anything reading the character finds it.
    const p = profileFor(characterId);
    db.prepare('UPDATE film_characters SET voice_profile_id = ? WHERE id = ?').run(p.id, ch.id);

    return json(res, 200, {
        character_id: ch.id, name: ch.name, voice_id: p.voice_id, changed: true,
        note: `${ch.name} will speak in this voice everywhere — auditions, the table read, and the `
            + 'dialogue that ships.',
    });
}

function clearCasting(req, res, characterId) {
    const ch = characterOr404(res, characterId);
    if (!ch) return;
    const p = profileFor(characterId);
    if (!p) return json(res, 404, { error: 'This character is not cast' });
    db.prepare('UPDATE film_voice_profiles SET voice_id = NULL WHERE id = ?').run(p.id);
    return json(res, 200, {
        character_id: ch.id, cleared: true,
        warning: `${ch.name} is uncast again: their lines will generate in the provider’s default voice.`,
    });
}

/** Who is cast and who is not — the actionable half. */
function projectCasting(req, res, projectId) {
    const rows = db.prepare(
        `SELECT c.id, c.name, p.voice_id, p.name AS voice_name
           FROM film_characters c
           LEFT JOIN film_voice_profiles p ON p.character_id = c.id
          WHERE c.project_id = ? ORDER BY c.name`
    ).all(projectId);

    // Lines per character, so the uncast list is ordered by what it costs to
    // leave uncast rather than alphabetically.
    /*
     * Counted through the same cue collapse.
     *
     * RAY MERCER read as "0 cues" while thirty of his lines sat in the script
     * under RAY — so the uncast list, which is ordered by what it costs to
     * leave uncast, put the film's second lead last.
     */
    const cast = castByCue(projectId);
    const lines = {};
    for (const row of db.prepare(
        `SELECT e.text AS cue, COUNT(*) AS n FROM film_script_elements e
           WHERE e.script_id = (SELECT id FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1)
             AND e.element_type = 'character' GROUP BY e.text`).all(projectId)) {
        const cue = String(row.cue).replace(/\s*\(CONT'D\)\s*$/i, '').trim().toUpperCase();
        const owner = cast[cue];
        const key = owner ? String(owner.name).toUpperCase() : cue;
        lines[key] = (lines[key] || 0) + row.n;
    }

    const withLines = rows.map(r => ({ ...r, line_count: lines[String(r.name).toUpperCase()] || 0 }));
    const gaps = VC.castingGaps(withLines);
    return json(res, 200, {
        free: true,
        project_id: projectId,
        characters: withLines.sort((a, b) => b.line_count - a.line_count),
        ...gaps,
        uncast: gaps.uncast
            .map(u => ({ ...u, line_count: lines[String(u.name).toUpperCase()] || 0 }))
            .sort((a, b) => b.line_count - a.line_count),
    });
}

/**
 * The cue "RAY" and the character "RAY MERCER" are one person.
 *
 * A screenplay cues a character by whatever the writer types, and the entity is
 * whatever the breakdown recorded — usually the fuller name from the action
 * line that introduced them. Matching those exactly meant thirty of RAY's
 * lines in The Glass Harbour resolved to no voice at all and would have been
 * spoken in the provider's default, on a character that WAS cast. That is
 * precisely the silent failure casting exists to prevent.
 *
 * The rule is not reinvented here: `canonicaliseCharacterNames` already
 * collapses a first name onto the full name it prefixes, on a word boundary so
 * RAY does not match RAYMOND, preferring whichever form has a character record.
 * Two implementations of one rule is what this codebase keeps paying for.
 */
function castByCue(projectId) {
    const { canonicaliseCharacterNames } = require('./scripts');
    const rows = db.prepare(
        `SELECT c.id, c.name, p.voice_id, p.name AS voice_name FROM film_characters c
           LEFT JOIN film_voice_profiles p ON p.character_id = c.id
          WHERE c.project_id = ?`).all(projectId);

    const script = db.prepare(
        'SELECT id FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(projectId);
    const cues = script
        ? db.prepare("SELECT DISTINCT text FROM film_script_elements WHERE script_id = ? AND element_type = 'character'")
            .all(script.id).map(r => String(r.text || '').replace(/\s*\(CONT'D\)\s*$/i, '').trim())
            .filter(Boolean)
        : [];

    const names = rows.map(r => r.name);
    const canonical = canonicaliseCharacterNames([...names, ...cues], names);

    // cue (upper) -> the character row it belongs to
    const byName = {};
    for (const r of rows) byName[String(r.name).toUpperCase()] = r;

    const out = {};
    for (const cue of [...cues, ...names]) {
        const pick = canonical.get(cue) || cue;
        const row = byName[String(pick).toUpperCase()];
        if (row) out[cue.toUpperCase()] = row;
    }
    return out;
}

/* ── auditioning ───────────────────────────────────────────────────────── */

function resolveVoiceFor(characterId) {
    if (!characterId) return null;
    const p = profileFor(characterId);
    return p && p.voice_id ? p.voice_id : null;
}

function auditionInputs(source) {
    const text = String(source.text || '').trim();
    const voice_id = source.voice_id || resolveVoiceFor(source.character_id);
    return { text, voice_id };
}

function auditionPreview(req, res, query) {
    const { text, voice_id } = auditionInputs(query || {});
    if (!text) return json(res, 400, { error: 'text is required' });

    let provider = null;
    try { provider = resolveGenerator('voice', {}); } catch (_) { /* reported */ }

    return json(res, 200, {
        free: true,
        provider: provider ? provider.id : null,
        voice_id: voice_id || null,
        text,
        characters: text.length,
        ...(voice_id ? {} : {
            warning: 'No voice — this will be spoken in the provider’s default voice. Cast the '
                + 'character, or pass a voice_id to try one.',
        }),
        ...(provider ? {} : { error: 'No voice provider is configured.' }),
    });
}

/**
 * Hear one line. Attached to nothing.
 *
 * Written under `auditions/` rather than `audio/`, and registered in NO asset
 * table: an audition that looked like a take would be picked up by the pipeline
 * and ship a reading the director was only trying out.
 */
async function audition(req, res) {
    const body = req.body || {};
    const { text, voice_id } = auditionInputs(body);

    let payload;
    try { payload = VC.auditionPayload({ ...body, text, voice_id }); }
    catch (err) { return json(res, 400, { error: err.code || 'BAD_REQUEST', message: err.message }); }

    let provider;
    try { provider = resolveGenerator('voice', {}); }
    catch (err) { return json(res, 400, { error: 'No voice provider: ' + err.message }); }

    const result = await provider.generate('voice', payload);
    if (!result || !result.ok) {
        return json(res, 502, { error: (result && result.error) || 'voice generation failed' });
    }

    const projectId = body.project_id || 'auditions';
    /*
     * The extension follows the BYTES.
     *
     * ElevenLabs returns mp3 unless a pcm_ format is asked for, and the adapter
     * says so in `result.format`. Writing it as .wav produces a file whose name
     * a decoder eventually calls a lie — the same fault an uploaded JPEG stored
     * under a .png name already cost.
     */
    const ext = (result.format === 'wav' || result.format === 'pcm') ? 'wav' : 'mp3';
    const fileName = `audition_${generateId()}.${ext}`;
    const data = result.data || result.buffer || result.audio;
    try {
        saveFile('auditions', projectId, fileName,
            Buffer.isBuffer(data) ? data : Buffer.from(data || '', 'base64'));
    } catch (err) {
        return json(res, 500, { error: 'could not save the audition: ' + err.message });
    }

    return json(res, 200, {
        audio_url: getFileUrl('auditions', projectId, fileName),
        voice_id: voice_id || null,
        text,
        note: 'An audition. It is attached to no shot and registered as no asset, so nothing '
            + 'downstream will mistake it for a take.',
    });
}

/* ── the table read ────────────────────────────────────────────────────── */

function sceneElements(sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return null;
    const script = db.prepare(
        'SELECT id FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(scene.project_id);
    if (!script) return { scene, elements: [] };
    const all = db.prepare(
        'SELECT element_type, text, scene_number FROM film_script_elements WHERE script_id = ? ORDER BY element_index'
    ).all(script.id);

    /*
     * A scene's elements are its HEADING to the next heading.
     *
     * Not `WHERE scene_number = ?`: only scene_heading rows carry a
     * scene_number and every other element stores NULL. Filtering on it returns
     * the heading alone — which contains no dialogue, so a scene with lines
     * read as a scene with none, and a `mine.length ? mine : all` fallback
     * never fires because one row is not zero rows. Measured on Wingfall: one
     * dialogue row in the script, zero found.
     *
     * Compared as strings on both sides because scene_number has INTEGER
     * affinity and returns 2 for '2' but '2A' for '2A' — the same
     * normalisation the sides and DOOD reports already make.
     */
    const want = String(scene.scene_number);
    const isHeading = e => String(e.element_type || '').replace(/_/g, '-') === 'scene-heading';
    const start = all.findIndex(e => isHeading(e) && String(e.scene_number) === want);
    if (start === -1) return { scene, elements: [] };
    let end = all.length;
    for (let i = start + 1; i < all.length; i++) {
        if (isHeading(all[i])) { end = i; break; }
    }
    return { scene, elements: all.slice(start, end) };
}

function getTableRead(req, res, sceneId) {
    const found = sceneElements(sceneId);
    if (!found) return json(res, 404, { error: 'Scene not found' });
    const lines = VC.tableRead(found.elements);

    // Which voice each line would be spoken in, so the read shows the casting
    // rather than making the director cross-reference it.
    const cast = castByCue(found.scene.project_id);
    const voiceFor = cue => {
        const row = cast[String(cue || '').toUpperCase()];
        return row ? row.voice_id : null;
    };

    const withVoices = lines.map(l => ({
        ...l,
        voice_id: voiceFor(l.character),
        cast: !!voiceFor(l.character),
        // Which character record the cue resolved to, so "RAY is uncast" and
        // "RAY is RAY MERCER, who is cast" are distinguishable on the page.
        character_id: (cast[String(l.character || '').toUpperCase()] || {}).id || null,
    }));

    return json(res, 200, {
        free: true,
        scene_id: sceneId,
        scene_number: found.scene.scene_number,
        heading: `${found.scene.int_ext || ''} ${found.scene.location || ''} - ${found.scene.time_of_day || ''}`.trim(),
        total: withVoices.length,
        lines: withVoices,
        uncast: [...new Set(withVoices.filter(l => !l.cast).map(l => l.character))].filter(Boolean),
        ...(withVoices.length ? {} : { note: 'This scene has no dialogue.' }),
    });
}

/**
 * Hear the scene.
 *
 * Sequentially, and stopping on a refusal with the lines not attempted NAMED:
 * a partial read reported as success is how a director listens to four lines
 * of a seven-line scene and concludes the scene is short.
 */
async function runTableRead(req, res, sceneId) {
    const found = sceneElements(sceneId);
    if (!found) return json(res, 404, { error: 'Scene not found' });
    const lines = VC.tableRead(found.elements);
    if (!lines.length) return json(res, 200, { scene_id: sceneId, total: 0, lines: [], note: 'No dialogue in this scene.' });

    const cast = castByCue(found.scene.project_id);

    let provider;
    try { provider = resolveGenerator('voice', {}); }
    catch (err) { return json(res, 400, { error: 'No voice provider: ' + err.message }); }

    const out = [];
    const notAttempted = [];
    let refusal = null;
    let reused = 0;

    /*
     * A line already spoken is not bought again.
     *
     * Reported as "nothing happened but my credits went down": re-running a
     * sixty-eight line read regenerated all sixty-eight, at a credit each,
     * because the filename carried a RANDOM suffix and nothing could ever find
     * the previous one.
     *
     * The name now carries the scene, the line index, and a hash of the TEXT
     * and the VOICE — so an unchanged line in an unchanged voice is reused, and
     * a rewritten line or a recast character generates. Same reasoning as the
     * artefact fingerprint: what it was made from decides whether it is current.
     */
    const lineKey = (line, voice) => crypto.createHash('sha1')
        .update(`${line.line}|${line.direction || ''}|${voice || 'default'}`)
        .digest('hex').slice(0, 10);

    for (const line of lines) {
        if (refusal) { notAttempted.push(line.index); continue; }
        const voice_id = (cast[String(line.character || '').toUpperCase()] || {}).voice_id || null;

        const key = lineKey(line, voice_id);
        const existingName = `read_${sceneId}_${line.index}_${key}.mp3`;
        let existingPath = null;
        try { existingPath = getFilePath('auditions', found.scene.project_id, existingName); } catch (_) {}
        if (!(req.body && req.body.regenerate === true) && existingPath && fs.existsSync(existingPath)) {
            reused++;
            out.push({ ...line, voice_id, cast: !!voice_id, reused: true,
                audio_url: getFileUrl('auditions', found.scene.project_id, existingName) });
            continue;
        }

        const payload = VC.auditionPayload({
            text: line.line, voice_id,
            // A parenthetical is direction, and the provider takes it as
            // emotion rather than as words to speak.
            ...(line.direction ? { emotion: line.direction.replace(/[()]/g, '').trim() } : {}),
        });
        const result = await provider.generate('voice', payload);
        if (!result || !result.ok) { refusal = (result && result.error) || 'failed'; notAttempted.push(line.index); continue; }

        // Deterministic, so the NEXT run can find it. A random suffix made
        // every line unfindable and therefore bought again.
        const fileName = `read_${sceneId}_${line.index}_${key}.mp3`;
        const data = result.data || result.buffer || result.audio;
        try {
            saveFile('auditions', found.scene.project_id, fileName,
                Buffer.isBuffer(data) ? data : Buffer.from(data || '', 'base64'));
        } catch (err) { refusal = err.message; notAttempted.push(line.index); continue; }

        out.push({ ...line, voice_id, cast: !!voice_id,
            audio_url: getFileUrl('auditions', found.scene.project_id, fileName) });
    }

    return json(res, out.length ? 200 : 502, {
        scene_id: sceneId,
        requested: lines.length,
        made: out.length,
        generated: out.length - reused,
        reused,
        ...(reused ? { note_reused: `${reused} line(s) were already spoken in this voice and were `
            + 'reused rather than bought again. Pass regenerate to force them.' } : {}),
        lines: out,
        ...(refusal ? { error: refusal, not_attempted: notAttempted,
            note: 'The provider refused, so the remaining lines were not attempted rather than '
                + 'asked for again.' } : {}),
        note: 'A table read. None of this is attached to a shot — it is for hearing the scene.',
    });
}

/* ── serving ───────────────────────────────────────────────────────────── */

const fs = require('fs');
const pathMod = require('path');
const { getFilePath } = require('../lib/file-storage');

/**
 * Serve an audition.
 *
 * Its own directory rather than the dialogue one: an audition sitting beside a
 * real take is one rename away from being mistaken for one, and the whole point
 * is that nothing downstream can confuse the two. A directory with no serving
 * route would 404, which reads as the generation having failed — the fault
 * `servedUrlFor` already cost once.
 */
function serveAudition(req, res, projectId, fileName) {
    let filePath;
    try {
        // Throws rather than silently correcting if the name escapes the
        // project directory, which is the contract getFilePath states.
        filePath = getFilePath('auditions', projectId, fileName);
    } catch (err) {
        return json(res, 400, { error: 'Bad path' });
    }
    if (!fs.existsSync(filePath)) return json(res, 404, { error: 'Audition not found' });
    const ext = pathMod.extname(filePath).toLowerCase();
    res.writeHead(200, {
        'Content-Type': ext === '.wav' ? 'audio/wav' : 'audio/mpeg',
        'Content-Length': fs.statSync(filePath).size,
        'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
}

/* ── routing ───────────────────────────────────────────────────────────── */

async function handleVoiceCasting(req, res, urlParts, query) {
    if (urlParts[1] === 'auditions' && urlParts[2] && urlParts[3] && req.method === 'GET') {
        return serveAudition(req, res, urlParts[2], urlParts[3]);
    }
    if (urlParts[1] === 'voices' && req.method === 'GET') return getVoices(req, res, query);

    if (urlParts[1] === 'characters' && urlParts[2] && urlParts[3] === 'voice') {
        if (req.method === 'GET') return getCasting(req, res, urlParts[2]);
        if (req.method === 'PUT' || req.method === 'POST') return setCasting(req, res, urlParts[2]);
        if (req.method === 'DELETE') return clearCasting(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'casting' && req.method === 'GET') {
        return projectCasting(req, res, urlParts[2]);
    }

    if (urlParts[1] === 'audition') {
        if (urlParts[2] === 'preview' && req.method === 'GET') return auditionPreview(req, res, query);
        if (req.method === 'POST') return audition(req, res);
        return json(res, 405, { error: 'Method not allowed' });
    }

    if (urlParts[1] === 'scenes' && urlParts[2] && urlParts[3] === 'table-read') {
        if (req.method === 'GET') return getTableRead(req, res, urlParts[2]);
        if (req.method === 'POST') return runTableRead(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleVoiceCasting };
