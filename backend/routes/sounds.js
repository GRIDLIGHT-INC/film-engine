/**
 * The sound library: every audio file in the project, one row each.
 *
 * The Music & Sound page was built around CUES — a written intention that a
 * piece of music should exist. That can never be a list of files: dialogue is
 * not a cue, and on the real library dialogue is 86 of 95 files. A page built
 * on cues was structurally incapable of showing 90% of the sound in the film.
 *
 * So the unit here is the FILE. One row per audio asset, whatever produced it,
 * carrying what the row knows and what only the file knows.
 */

const fs = require('fs');
const { db } = require('../db/database');
const { MEDIA_KINDS } = require('../lib/media-kinds');
const { SOUND_FACTS, featuresFor } = require('../lib/audio-features');
const { getFileUrl, ensureDir, getFilePath } = require('../lib/file-storage');

/** Audio asset types, derived from the registry that files generated media. */
const AUDIO_TYPES = Object.values(MEDIA_KINDS)
    .filter(k => k.media === 'audio')
    .map(k => k.assetType);

/** Where each audio type is served from, so a card can link the file. */
const SERVE_DIR = {};
for (const k of Object.values(MEDIA_KINDS)) {
    if (k.media === 'audio') SERVE_DIR[k.assetType] = k.serveDir;
}

/** A human label per type, from the registry's own capability names. */
const KIND_LABEL = {
    audio_dialogue: 'Dialogue',
    audio_music: 'Score',
    audio_sfx: 'Effect',
    audio_ambient: 'Room tone',
};

function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * GET /film/projects/:id/sounds
 *
 * Deliberately NOT joined to film_music_cues: that join is what made dialogue
 * invisible. A file that no cue ever asked for is still a file in the film.
 */
async function listSounds(req, res, projectId) {
    const types = AUDIO_TYPES.map(() => '?').join(', ');
    const rows = db.prepare(
        `SELECT a.*, s.shot_code, s.scene_id AS shot_scene,
                sc.scene_number, sc.location
           FROM film_assets a
           LEFT JOIN film_shots  s  ON s.id  = a.shot_id
           LEFT JOIN film_scenes sc ON sc.id = COALESCE(a.scene_id, s.scene_id)
          WHERE a.project_id = ? AND a.asset_type IN (${types})
          ORDER BY a.created_at DESC`
    ).all(projectId, ...AUDIO_TYPES);

    /*
     * ONE CARD PER FILE, so deduplicate by name — newest row wins.
     *
     * Regenerating writes the SAME filename and INSERTs a new row, so the
     * library carried 90 rows for 64 files: the same take shown four times.
     * That is the fault this codebase already fixed once for plates ("six
     * entries for three files") and it is live here. Newest first is the
     * query's own order, so the first row seen for a name is the current one.
     *
     * Rows are counted rather than hidden — `takes` says how many times this
     * file has been regenerated, which is a fact worth seeing.
     */
    const seen = new Map();
    const unique = [];
    for (const r of rows) {
        const key = r.file_name || r.id;
        if (seen.has(key)) { seen.get(key).takes++; continue; }
        const entry = { row: r, takes: 1 };
        seen.set(key, entry);
        unique.push(entry);
    }

    const sounds = [];
    for (const { row: r, takes } of unique) {
        let meta = {};
        try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch (_) { meta = {}; }

        const dir = SERVE_DIR[r.asset_type] || 'audio';

        /*
         * Resolve by (project, subdir, name), not by the stored file_path.
         *
         * `file_path` is ABSOLUTE and was written when the file was made, so it
         * breaks the moment the data directory moves — a profile switch, a
         * different machine, a restore from a bundle. Measured here: every path
         * in this library pointed at a directory that no longer exists, so the
         * probe read nothing and every card would have shown no technical
         * detail at all. `getFilePath` resolves against the CURRENT data dir and
         * is the containment-checked reader everything else already uses; the
         * stored path stays as the fallback for anything filed outside it.
         */
        let onDisk = null;
        try { onDisk = getFilePath(r.project_id, dir, r.file_name); } catch (_) { onDisk = null; }
        if (!onDisk || !fs.existsSync(onDisk)) onDisk = r.file_path;

        // Cached per (size, mtime), so a library of a hundred files probes each
        // once and is free thereafter.
        const probe = await featuresFor(onDisk);
        sounds.push({
            id: r.id,
            takes,
            kind: r.asset_type,
            kind_label: KIND_LABEL[r.asset_type] || r.asset_type,
            file_name: r.file_name,
            url: r.file_name ? getFileUrl(dir, r.project_id, r.file_name, r.created_at) : null,

            // what the row knows
            duration_ms: r.duration_ms || probe.duration_ms || null,
            size_bytes: r.size_bytes || null,
            format: r.format || null,
            provider: r.provider || null,
            provider_model: r.provider_model || null,
            created_at: r.created_at,
            imported: r.license_source === 'external',

            // what only the file knows
            codec: probe.codec || null,
            sample_rate: probe.sample_rate || null,
            channels: probe.channels || null,
            channel_layout: probe.channel_layout || null,
            bitrate_kbps: probe.bitrate_kbps || null,
            sample_fmt: probe.sample_fmt || null,

            /*
             * Composed HERE rather than in the card, so every reader says the
             * same thing about what a file is for. A shot when there is one, a
             * scene otherwise, and the character when it is a line — which is
             * the only thing that tells two takes of one shot apart.
             */
            belongs_to: [
                r.shot_code ? `Sc${r.scene_number == null ? '?' : r.scene_number} / ${r.shot_code}`
                            : (r.scene_number == null ? null : `Scene ${r.scene_number}`),
                meta.character || null,
            ].filter(Boolean).join(' · ') || null,

            // what it belongs to
            shot_id: r.shot_id || null,
            shot_code: r.shot_code || null,
            scene_number: r.scene_number == null ? null : String(r.scene_number),
            location: r.location || null,
            character: meta.character || null,
            line: meta.line || meta.text || null,

            /*
             * Said out loud, because it is the fault this library exists to
             * surface: a file filed as one container and encoded as another.
             * Every audio file in this project was requested as wav and
             * arrived as 44.1kHz mp3, and nothing anywhere said so.
             */
            format_mismatch: !!(r.format && probe.codec
                && !String(probe.codec).includes(String(r.format).replace('wav', 'pcm'))
                && String(r.format) !== String(probe.codec)),
        });
    }

    json(res, 200, {
        project_id: projectId,
        total: sounds.length,
        kinds: AUDIO_TYPES.map(t => ({ id: t, label: KIND_LABEL[t] || t,
            count: sounds.filter(s => s.kind === t).length })),
        facts: SOUND_FACTS,
        sounds,
    });
}

/**
 * POST /film/projects/:id/sounds/generate
 *
 * One prompt, one sound. The existing sfx route builds its prompts from a
 * scene card's cues and cannot take a free one, so "generate a sound" had no
 * route at all.
 *
 * A shot is OPTIONAL and is context, not scope: naming one appends what that
 * shot is — its action, location and hour — so the effect sits in the room it
 * is for rather than in the abstract. That is what "select a shot to add its
 * details" asks for, and it is why the shot's text is appended to the
 * director's prompt rather than replacing it.
 */
async function generateSound(req, res, projectId) {
    /*
     * Query OR body, because this is read two ways: the shared pre-spend
     * confirmation GETs a preview URL, and the generate itself POSTs. One
     * handler so the preview cannot describe a different request from the one
     * that spends — the failure `buildRefinePayload` was created to end.
     */
    const body = { ...((req && req.query) || {}), ...((req && req.body) || {}) };
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: 'A prompt is required — say what the sound is.' });

    const kind = String(body.kind || 'sfx');
    const KINDS = { sfx: 'audio_sfx', ambient: 'audio_ambient', music: 'audio_music' };
    if (!KINDS[kind]) {
        return json(res, 400, { error: `Unknown kind "${kind}"`, valid: Object.keys(KINDS) });
    }

    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    let shot = null;
    let scene = null;
    if (body.shot_id) {
        shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(body.shot_id);
        if (!shot) return json(res, 404, { error: 'Shot not found' });
        scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    }

    // The shot's details, appended — never replacing what the director wrote.
    let full = prompt;
    const detail = [];
    if (shot) {
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
        if (scene && scene.location) detail.push(scene.location);
        if (scene && scene.time_of_day) detail.push(scene.time_of_day);
        if (card.action || card.description) {
            detail.push(String(card.action || card.description).slice(0, 240));
        }
        if (detail.length) full = `${prompt}. In this shot: ${detail.join('; ')}`;
    }

    const seconds = Math.max(0.5, Math.min(30, Number(body.duration_s) || 5));

    const { resolveGenerator } = require('../lib/providers');
    const capability = kind === 'music' ? 'music' : kind;
    let provider;
    try {
        provider = resolveGenerator(capability, { id: projectId });
    } catch (err) {
        return json(res, 400, { error: `No provider for ${capability}: ${err.message}` });
    }

    if (body.preview) {
        // Free: what would be sent, before anything spends.
        return json(res, 200, {
            preview: true, prompt: full, kind, capability,
            provider: provider.id, duration_s: seconds,
            shot_details_added: detail,
        });
    }

    const payload = { prompt: full, text: full, duration_s: seconds, duration_seconds: seconds };
    const result = await provider.generate(capability, payload, { timeout: 300000 });
    if (!result || !result.ok) {
        return json(res, (result && result.status) || 502,
            { error: (result && result.error) || 'generation failed', prompt: full });
    }

    const { persistProviderMedia } = require('../lib/provider-media');
    const mk = Object.values(MEDIA_KINDS).find(k => k.assetType === KINDS[kind]);
    const stamp = Date.now().toString(36);
    const ext = (result.format || mk.ext || 'wav').replace(/^\./, '');
    const filename = `sound_${kind}_${stamp}.${ext}`;

    let filePath;
    try {
        ensureDir(projectId, mk.subdir);
        filePath = await persistProviderMedia(projectId, mk.subdir, filename, result.data,
            { serveDir: mk.serveDir });
    } catch (err) {
        return json(res, 502, { error: `generated but could not be stored: ${err.message}` });
    }

    const assetId = require('crypto').randomUUID();

    db.prepare(
        `INSERT INTO film_assets (
            id, project_id, shot_id, scene_id, asset_type, file_path, file_name,
            format, mime_type, duration_ms, version, provider, provider_model,
            license_source, license_status, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'generated', 'generated', ?)`
    ).run(assetId, projectId, shot ? shot.id : null, scene ? scene.id : null,
        KINDS[kind], filePath, filename, ext, result.contentType || 'audio/wav',
        Math.round(seconds * 1000), provider.id, result.provider_model || null,
        JSON.stringify({ prompt: full, written: prompt, shot_details: detail }));

    json(res, 200, {
        asset_id: assetId, kind: KINDS[kind], file_name: filename,
        url: getFileUrl(mk.serveDir, projectId, filename, null),
        prompt: full, shot_details_added: detail, provider: provider.id,
    });
}

module.exports = { listSounds, generateSound, AUDIO_TYPES, KIND_LABEL };
