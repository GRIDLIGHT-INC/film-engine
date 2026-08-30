/**
 * Credits and Title Cards
 * GET/POST   /film/projects/:id/credits
 * POST       /film/projects/:id/credits/reorder
 * GET/PUT/DELETE /film/credits/:id
 * GET/POST   /film/projects/:id/title-cards
 * GET/PUT/DELETE /film/title-cards/:id
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_SECTIONS = ['opening', 'cast', 'crew', 'special_thanks', 'closing'];
const VALID_CARD_TYPES = ['main_title', 'subtitle', 'chapter', 'end_title', 'card'];

function handleCredits(req, res, urlParts, query) {
    // /film/projects/:id/credits — parts: ['film', 'projects', id, 'credits']
    // /film/projects/:id/credits/reorder — parts: ['film', 'projects', id, 'credits', 'reorder']
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'credits') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');

        if (urlParts[4] === 'reorder') {
            if (req.method === 'POST') return reorderCredits(req, res, projectId);
        }

        if (!urlParts[4]) {
            if (req.method === 'GET') return listCredits(req, res, projectId, query);
            if (req.method === 'POST') return createCredit(req, res, projectId);
        }
    }

    // /film/credits/:id — parts: ['film', 'credits', id]
    if (urlParts[1] === 'credits' && urlParts[2]) {
        const creditId = urlParts[2];
        if (!UUID_RE.test(creditId)) return badReq(res, 'Invalid credit ID');

        if (req.method === 'GET') return getCredit(req, res, creditId);
        if (req.method === 'PUT') return updateCredit(req, res, creditId);
        if (req.method === 'DELETE') return deleteCredit(req, res, creditId);
    }

    // /film/projects/:id/title-cards — parts: ['film', 'projects', id, 'title-cards']
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'title-cards') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');

        if (!urlParts[4]) {
            if (req.method === 'GET') return listTitleCards(req, res, projectId);
            if (req.method === 'POST') return createTitleCard(req, res, projectId);
        }
    }

    // /film/title-cards/:id — parts: ['film', 'title-cards', id]
    if (urlParts[1] === 'title-cards' && urlParts[2]) {
        const cardId = urlParts[2];
        if (!UUID_RE.test(cardId)) return badReq(res, 'Invalid title card ID');

        if (req.method === 'GET') return getTitleCard(req, res, cardId);
        if (req.method === 'PUT') return updateTitleCard(req, res, cardId);
        if (req.method === 'DELETE') return deleteTitleCard(req, res, cardId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

// --- Credits ---

function listCredits(req, res, projectId, query) {
    let sql = 'SELECT * FROM film_credits WHERE project_id = ?';
    const params = [projectId];

    if (query.section && VALID_SECTIONS.includes(query.section)) {
        sql += ' AND section = ?';
        params.push(query.section);
    }

    sql += ' ORDER BY section, sort_order';

    const rows = db.prepare(sql).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ credits: rows, count: rows.length, sections: VALID_SECTIONS }));
}

function createCredit(req, res, projectId) {
    const body = req.body;
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return badReq(res, 'Credit name is required');
    }

    const section = VALID_SECTIONS.includes(body.section) ? body.section : 'crew';

    // Get next sort_order for this section
    const last = db.prepare(
        'SELECT MAX(sort_order) AS max_order FROM film_credits WHERE project_id = ? AND section = ?'
    ).get(projectId, section);
    const sortOrder = body.sort_order !== undefined ? body.sort_order : (last.max_order !== null ? last.max_order + 1 : 0);

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_credits (id, project_id, section, role, name, character_name, sort_order, style, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        section,
        (body.role || '').slice(0, 200),
        body.name.trim().slice(0, 200),
        (body.character_name || '').slice(0, 200),
        sortOrder,
        JSON.stringify(body.style || {}),
        now
    );

    const row = db.prepare('SELECT * FROM film_credits WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function getCredit(req, res, creditId) {
    const row = db.prepare('SELECT * FROM film_credits WHERE id = ?').get(creditId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Credit not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateCredit(req, res, creditId) {
    const body = req.body;
    const fields = [];
    const values = [];

    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) return badReq(res, 'Name cannot be empty');
        fields.push('name = ?');
        values.push(body.name.trim().slice(0, 200));
    }
    if (body.role !== undefined) {
        fields.push('role = ?');
        values.push(String(body.role).slice(0, 200));
    }
    if (body.character_name !== undefined) {
        fields.push('character_name = ?');
        values.push(String(body.character_name).slice(0, 200));
    }
    if (body.section !== undefined && VALID_SECTIONS.includes(body.section)) {
        fields.push('section = ?');
        values.push(body.section);
    }
    if (body.sort_order !== undefined) {
        fields.push('sort_order = ?');
        values.push(body.sort_order);
    }
    if (body.style !== undefined) {
        fields.push('style = ?');
        values.push(JSON.stringify(body.style));
    }

    if (fields.length === 0) return badReq(res, 'No valid fields to update');

    values.push(creditId);
    const result = db.prepare(`UPDATE film_credits SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Credit not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_credits WHERE id = ?').get(creditId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteCredit(req, res, creditId) {
    const result = db.prepare('DELETE FROM film_credits WHERE id = ?').run(creditId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Credit not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

function reorderCredits(req, res, projectId) {
    const body = req.body;
    if (!body.credit_ids || !Array.isArray(body.credit_ids)) {
        return badReq(res, 'credit_ids array is required');
    }

    const update = db.prepare('UPDATE film_credits SET sort_order = ? WHERE id = ? AND project_id = ?');
    const reorder = db.transaction((ids) => {
        for (let i = 0; i < ids.length; i++) {
            update.run(i, ids[i], projectId);
        }
    });

    reorder(body.credit_ids);

    const rows = db.prepare('SELECT * FROM film_credits WHERE project_id = ? ORDER BY section, sort_order').all(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ credits: rows, count: rows.length, sections: VALID_SECTIONS }));
}

// --- Title Cards ---

function listTitleCards(req, res, projectId) {
    const rows = db.prepare('SELECT * FROM film_title_cards WHERE project_id = ? ORDER BY sort_order').all(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ title_cards: rows, count: rows.length, card_types: VALID_CARD_TYPES }));
}

function createTitleCard(req, res, projectId) {
    const body = req.body;
    if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
        return badReq(res, 'Title card text is required');
    }

    const cardType = VALID_CARD_TYPES.includes(body.card_type) ? body.card_type : 'card';

    // Get next sort_order
    const last = db.prepare(
        'SELECT MAX(sort_order) AS max_order FROM film_title_cards WHERE project_id = ?'
    ).get(projectId);
    const sortOrder = body.sort_order !== undefined ? body.sort_order : (last.max_order !== null ? last.max_order + 1 : 0);

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_title_cards (id, project_id, card_type, text, subtext, position_in_timeline, duration_ms, style, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        cardType,
        body.text.trim().slice(0, 500),
        (body.subtext || '').slice(0, 500),
        body.position_in_timeline || null,
        body.duration_ms || 3000,
        JSON.stringify(body.style || {}),
        sortOrder,
        now
    );

    const row = db.prepare('SELECT * FROM film_title_cards WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function getTitleCard(req, res, cardId) {
    const row = db.prepare('SELECT * FROM film_title_cards WHERE id = ?').get(cardId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title card not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateTitleCard(req, res, cardId) {
    const body = req.body;
    const fields = [];
    const values = [];

    if (body.text !== undefined) {
        if (typeof body.text !== 'string' || !body.text.trim()) return badReq(res, 'Text cannot be empty');
        fields.push('text = ?');
        values.push(body.text.trim().slice(0, 500));
    }
    if (body.subtext !== undefined) {
        fields.push('subtext = ?');
        values.push(String(body.subtext).slice(0, 500));
    }
    if (body.card_type !== undefined && VALID_CARD_TYPES.includes(body.card_type)) {
        fields.push('card_type = ?');
        values.push(body.card_type);
    }
    if (body.position_in_timeline !== undefined) {
        fields.push('position_in_timeline = ?');
        values.push(body.position_in_timeline);
    }
    if (body.duration_ms !== undefined) {
        fields.push('duration_ms = ?');
        values.push(body.duration_ms);
    }
    if (body.sort_order !== undefined) {
        fields.push('sort_order = ?');
        values.push(body.sort_order);
    }
    if (body.style !== undefined) {
        fields.push('style = ?');
        values.push(JSON.stringify(body.style));
    }

    if (fields.length === 0) return badReq(res, 'No valid fields to update');

    values.push(cardId);
    const result = db.prepare(`UPDATE film_title_cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title card not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_title_cards WHERE id = ?').get(cardId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteTitleCard(req, res, cardId) {
    const result = db.prepare('DELETE FROM film_title_cards WHERE id = ?').run(cardId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title card not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

module.exports = { handleCredits };
