/**
 * Audio Deliverables Routes
 *
 * GET/POST /film/projects/:id/audio-deliverables
 * GET/DELETE /film/audio-deliverables/:id
 * GET /film/projects/:id/audio-deliverables/manifest
 */
const { db, generateId } = require('../db/database');
const {
    validateAudioDeliverable,
    generate51Specification,
    generateMESpec,
    generateStemManifest,
    DELIVERABLE_TYPES,
} = require('../lib/audio-deliverables');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleAudioDeliverables(req, res, urlParts, query) {
    // /film/projects/:id/audio-deliverables[/manifest]
    if (urlParts[1] === 'projects' && urlParts[3] === 'audio-deliverables') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }

        if (urlParts[4] === 'manifest' && req.method === 'GET') {
            return getManifest(req, res, projectId);
        }

        if (req.method === 'GET') return listDeliverables(req, res, projectId);
        if (req.method === 'POST') return createDeliverable(req, res, projectId);
    }

    // /film/audio-deliverables/:id
    if (urlParts[1] === 'audio-deliverables' && urlParts[2]) {
        const id = urlParts[2];
        if (!UUID_RE.test(id)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid deliverable ID' }));
            return;
        }

        if (req.method === 'GET') return getDeliverable(req, res, id);
        if (req.method === 'DELETE') return deleteDeliverable(req, res, id);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function listDeliverables(req, res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_audio_deliverables WHERE project_id = ? ORDER BY type, created_at'
    ).all(projectId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deliverables: rows, types: DELIVERABLE_TYPES }));
}

function getDeliverable(req, res, id) {
    const row = db.prepare('SELECT * FROM film_audio_deliverables WHERE id = ?').get(id);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Deliverable not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function createDeliverable(req, res, projectId) {
    const body = req.body;

    if (!body.type) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'type is required' }));
        return;
    }

    const validation = validateAudioDeliverable(body);
    if (!validation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid deliverable', details: validation.errors }));
        return;
    }

    const id = generateId();
    db.prepare(`
        INSERT INTO film_audio_deliverables
        (id, project_id, type, name, channel_layout, sample_rate, bit_depth, lufs_target, codec, file_format, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.type,
        (body.name || '').slice(0, 200),
        body.channel_layout || '2.0',
        body.sample_rate || 48000,
        body.bit_depth || 24,
        body.lufs_target !== undefined ? Number(body.lufs_target) : -24.0,
        body.codec || 'pcm_s24le',
        body.file_format || 'wav',
        (body.notes || '').slice(0, 2000),
        body.status || 'planned',
    );

    const row = db.prepare('SELECT * FROM film_audio_deliverables WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteDeliverable(req, res, id) {
    const result = db.prepare('DELETE FROM film_audio_deliverables WHERE id = ?').run(id);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Deliverable not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

function getManifest(req, res, projectId) {
    const project = db.prepare('SELECT id, title FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const deliverables = db.prepare(
        'SELECT * FROM film_audio_deliverables WHERE project_id = ? ORDER BY type'
    ).all(projectId);

    const spec51 = generate51Specification(project);
    const meSpec = generateMESpec(project);
    const stemManifest = generateStemManifest(project);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        project_id: projectId,
        project_title: project.title,
        deliverables,
        specifications: {
            surround_51: spec51,
            me_track: meSpec,
            stems: stemManifest,
        },
    }));
}

module.exports = { handleAudioDeliverables };
