/**
 * Subtitle CRUD + SRT/VTT export and conversion
 * GET    /film/projects/:id/subtitles              — list subtitles
 * POST   /film/projects/:id/subtitles              — create subtitle cue
 * GET    /film/projects/:id/subtitles/export/:fmt   — export as SRT or VTT
 * GET    /film/projects/:id/subtitles/languages     — list unique languages
 * POST   /film/projects/:id/subtitles/convert       — convert between formats
 * PUT    /film/subtitles/:id                        — update subtitle cue
 * DELETE /film/subtitles/:id                        — delete subtitle cue
 */
const { db, generateId } = require('../db/database');
const { generateSRT, parseSRT, generateVTT, parseVTT } = require('../lib/subtitle-generator');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleSubtitles(req, res, urlParts, query) {
    // /film/projects/:id/subtitles/export/:format — ['film', 'projects', id, 'subtitles', 'export', format]
    if (urlParts[1] === 'projects' && urlParts[3] === 'subtitles' && urlParts[4] === 'export' && urlParts[5]) {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        const format = urlParts[5];
        if (req.method === 'GET') return exportSubtitles(req, res, projectId, format, query);
    }

    // /film/projects/:id/subtitles/languages — ['film', 'projects', id, 'subtitles', 'languages']
    if (urlParts[1] === 'projects' && urlParts[3] === 'subtitles' && urlParts[4] === 'languages') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listLanguages(req, res, projectId);
    }

    // /film/projects/:id/subtitles/convert — ['film', 'projects', id, 'subtitles', 'convert']
    if (urlParts[1] === 'projects' && urlParts[3] === 'subtitles' && urlParts[4] === 'convert') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'POST') return convertFormat(req, res);
    }

    // /film/projects/:id/subtitles/dubbing — localized dubbing packages from subtitle cues
    if (urlParts[1] === 'projects' && urlParts[3] === 'subtitles' && urlParts[4] === 'dubbing') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listDubbingJobs(req, res, projectId);
        if (req.method === 'POST') return createDubbingPackage(req, res, projectId);
    }

    // /film/projects/:id/subtitles — ['film', 'projects', id, 'subtitles']
    if (urlParts[1] === 'projects' && urlParts[3] === 'subtitles' && !urlParts[4]) {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listSubtitles(req, res, projectId, query);
        if (req.method === 'POST') return createSubtitle(req, res, projectId);
    }

    // /film/subtitles/:id — ['film', 'subtitles', id]
    if (urlParts[1] === 'subtitles' && urlParts[2]) {
        const subtitleId = urlParts[2];
        if (!UUID_RE.test(subtitleId)) return badReq(res, 'Invalid subtitle ID');
        if (req.method === 'PUT') return updateSubtitle(req, res, subtitleId);
        if (req.method === 'DELETE') return deleteSubtitle(req, res, subtitleId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// --- List subtitles ---

function listSubtitles(req, res, projectId, query) {
    let sql = 'SELECT * FROM film_subtitles WHERE project_id = ?';
    const params = [projectId];

    if (query.language) {
        sql += ' AND language = ?';
        params.push(query.language);
    }

    sql += ' ORDER BY start_ms';

    const rows = db.prepare(sql).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ subtitles: rows, count: rows.length }));
}

// --- Create subtitle cue ---

function createSubtitle(req, res, projectId) {
    const body = req.body;

    if (!body.language || typeof body.language !== 'string' || !body.language.trim()) {
        return badReq(res, 'Language is required');
    }
    if (body.start_ms === undefined || body.start_ms === null) {
        return badReq(res, 'start_ms is required');
    }
    if (body.end_ms === undefined || body.end_ms === null) {
        return badReq(res, 'end_ms is required');
    }
    if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
        return badReq(res, 'Text is required');
    }

    const startMs = Number(body.start_ms);
    const endMs = Number(body.end_ms);

    if (isNaN(startMs) || isNaN(endMs)) {
        return badReq(res, 'start_ms and end_ms must be numbers');
    }
    if (startMs >= endMs) {
        return badReq(res, 'start_ms must be less than end_ms');
    }

    // Validate shot_id if provided
    if (body.shot_id) {
        if (!UUID_RE.test(body.shot_id)) return badReq(res, 'Invalid shot_id');
        const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(body.shot_id);
        if (!shot) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Shot not found' }));
            return;
        }
    }

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_subtitles (id, project_id, shot_id, language, start_ms, end_ms, text,
            position, style, is_cc, speaker, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        projectId,
        body.shot_id || null,
        body.language.trim().slice(0, 10),
        startMs,
        endMs,
        body.text.trim().slice(0, 5000),
        (body.position || 'bottom').slice(0, 50),
        (body.style || '').slice(0, 500),
        body.is_cc ? 1 : 0,
        body.speaker ? String(body.speaker).slice(0, 200) : null,
        now
    );

    const row = db.prepare('SELECT * FROM film_subtitles WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- Export subtitles as SRT or VTT ---

function exportSubtitles(req, res, projectId, format, query) {
    const fmt = format.toLowerCase();
    if (fmt !== 'srt' && fmt !== 'vtt') {
        return badReq(res, 'Unsupported format. Use srt or vtt');
    }

    let sql = 'SELECT * FROM film_subtitles WHERE project_id = ?';
    const params = [projectId];

    if (query.language) {
        sql += ' AND language = ?';
        params.push(query.language);
    }

    sql += ' ORDER BY start_ms';

    const rows = db.prepare(sql).all(...params);

    let output;
    let contentType;
    let ext;

    if (fmt === 'srt') {
        output = generateSRT(rows);
        contentType = 'text/plain';
        ext = 'srt';
    } else {
        output = generateVTT(rows);
        contentType = 'text/vtt';
        ext = 'vtt';
    }

    const langSuffix = query.language ? `_${query.language}` : '';
    const filename = `subtitles${langSuffix}.${ext}`;

    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.end(output);
}

// --- List unique languages ---

function listLanguages(req, res, projectId) {
    const rows = db.prepare(
        'SELECT language, COUNT(*) AS count FROM film_subtitles WHERE project_id = ? GROUP BY language ORDER BY language'
    ).all(projectId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ languages: rows }));
}

// --- Dubbing / Localization Packages ---

function listDubbingJobs(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const jobs = db.prepare('SELECT * FROM film_dubbing_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
        .map(row => ({ ...row, package: parseJSON(row.package_json, {}) }));
    json(res, 200, { project_id: projectId, total: jobs.length, jobs });
}

function createDubbingPackage(req, res, projectId) {
    const project = db.prepare('SELECT id, title FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const body = req.body || {};
    const sourceLanguage = String(body.source_language || 'en').slice(0, 10);
    const targetLanguage = String(body.target_language || '').slice(0, 10);
    if (!targetLanguage) return badReq(res, 'target_language is required');

    const voiceStrategy = ['preserve_character', 'new_cast', 'subtitles_only'].includes(body.voice_strategy)
        ? body.voice_strategy
        : 'preserve_character';
    const provider = (body.provider || '').slice(0, 100);

    const cues = db.prepare(
        'SELECT id, shot_id, language, start_ms, end_ms, text, speaker FROM film_subtitles WHERE project_id = ? AND language = ? ORDER BY start_ms'
    ).all(projectId, sourceLanguage);

    const packageJson = {
        project_id: projectId,
        project_title: project.title,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        voice_strategy: voiceStrategy,
        provider,
        generated_at: new Date().toISOString(),
        cues: cues.map(cue => ({
            subtitle_id: cue.id,
            shot_id: cue.shot_id,
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            source_text: cue.text,
            target_text: '',
            speaker: cue.speaker || '',
            voice_profile_id: null,
            status: voiceStrategy === 'subtitles_only' ? 'subtitle_only' : 'ready_for_voice_generation',
        })),
    };

    const id = generateId();
    const now = new Date().toISOString();
    const status = cues.length ? 'queued' : 'planned';
    db.prepare(`
        INSERT INTO film_dubbing_jobs (
            id, project_id, source_language, target_language, status, voice_strategy,
            provider, cue_count, package_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        projectId,
        sourceLanguage,
        targetLanguage,
        status,
        voiceStrategy,
        provider,
        cues.length,
        JSON.stringify(packageJson),
        now,
        now
    );

    const row = db.prepare('SELECT * FROM film_dubbing_jobs WHERE id = ?').get(id);
    json(res, 201, { ...row, package: packageJson });
}

function parseJSON(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

// --- Update subtitle cue ---

function updateSubtitle(req, res, subtitleId) {
    const body = req.body;
    const fields = [];
    const values = [];

    if (body.shot_id !== undefined) {
        if (body.shot_id === null) {
            fields.push('shot_id = ?');
            values.push(null);
        } else {
            if (!UUID_RE.test(body.shot_id)) return badReq(res, 'Invalid shot_id');
            fields.push('shot_id = ?');
            values.push(body.shot_id);
        }
    }
    if (body.language !== undefined) {
        fields.push('language = ?');
        values.push(String(body.language).slice(0, 10));
    }
    if (body.start_ms !== undefined) {
        fields.push('start_ms = ?');
        values.push(Number(body.start_ms));
    }
    if (body.end_ms !== undefined) {
        fields.push('end_ms = ?');
        values.push(Number(body.end_ms));
    }
    if (body.text !== undefined) {
        fields.push('text = ?');
        values.push(String(body.text).slice(0, 5000));
    }
    if (body.position !== undefined) {
        fields.push('position = ?');
        values.push(String(body.position).slice(0, 50));
    }
    if (body.style !== undefined) {
        fields.push('style = ?');
        values.push(String(body.style).slice(0, 500));
    }
    if (body.is_cc !== undefined) {
        fields.push('is_cc = ?');
        values.push(body.is_cc ? 1 : 0);
    }
    if (body.speaker !== undefined) {
        fields.push('speaker = ?');
        values.push(body.speaker ? String(body.speaker).slice(0, 200) : null);
    }

    if (fields.length === 0) return badReq(res, 'No valid fields to update');

    // Validate start_ms < end_ms if either is being updated
    if (body.start_ms !== undefined || body.end_ms !== undefined) {
        const existing = db.prepare('SELECT start_ms, end_ms FROM film_subtitles WHERE id = ?').get(subtitleId);
        if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Subtitle not found' }));
            return;
        }
        const newStart = body.start_ms !== undefined ? Number(body.start_ms) : existing.start_ms;
        const newEnd = body.end_ms !== undefined ? Number(body.end_ms) : existing.end_ms;
        if (newStart >= newEnd) return badReq(res, 'start_ms must be less than end_ms');
    }

    values.push(subtitleId);
    const result = db.prepare(`UPDATE film_subtitles SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Subtitle not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_subtitles WHERE id = ?').get(subtitleId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- Delete subtitle cue ---

function deleteSubtitle(req, res, subtitleId) {
    const result = db.prepare('DELETE FROM film_subtitles WHERE id = ?').run(subtitleId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Subtitle not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

// --- Convert between SRT and VTT ---

function convertFormat(req, res) {
    const body = req.body;

    if (!body.content || typeof body.content !== 'string') {
        return badReq(res, 'content is required');
    }
    if (!body.from_format || !body.to_format) {
        return badReq(res, 'from_format and to_format are required');
    }

    const from = body.from_format.toLowerCase();
    const to = body.to_format.toLowerCase();

    if (!['srt', 'vtt'].includes(from)) return badReq(res, 'from_format must be srt or vtt');
    if (!['srt', 'vtt'].includes(to)) return badReq(res, 'to_format must be srt or vtt');

    let cues;
    if (from === 'srt') {
        cues = parseSRT(body.content);
    } else {
        cues = parseVTT(body.content);
    }

    let result;
    if (to === 'srt') {
        result = generateSRT(cues);
    } else {
        result = generateVTT(cues);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result }));
}

module.exports = { handleSubtitles };
