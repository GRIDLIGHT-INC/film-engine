/**
 * Film Engine Backend Server
 * API server for film production management.
 *
 * Routes:
 *   POST/GET/PUT/DELETE /film/projects                — Project CRUD
 *   POST   /film/projects/:id/script                  — Upload screenplay
 *   GET    /film/projects/:id/scripts[/:version]       — Script versions
 *   GET    /film/projects/:id/scenes                   — List scenes
 *   GET    /film/scenes/:id                            — Scene with shots
 *   POST   /film/shots                                 — Create shots from scene cards
 *   GET    /film/projects/:id/shotlist                  — Aggregate shot list
 *   POST   /film/projects/:id/breakdown[/stream]        — AI screenplay breakdown
 *   POST/GET /film/projects/:id/characters              — Character CRUD
 *   GET/PUT/DELETE /film/characters/:id                 — Character by ID
 *   POST   /film/characters/:id/voice                   — Voice profile
 *   POST/GET /film/characters/:id/costumes              — Costumes
 *   POST/GET /film/projects/:id/locations               — Location CRUD
 *   GET/PUT/DELETE /film/locations/:id                  — Location by ID
 *   POST/GET /film/projects/:id/props                   — Props
 *   GET/PUT/DELETE /film/props/:id                      — Prop by ID
 *   POST/GET /film/shots/:id/notes                      — Shot notes
 *   POST   /film/shots/:id/review                       — Shot approval/rejection
 *   PUT/DELETE /film/notes/:id                          — Update/delete note
 *   POST/GET /film/projects/:id/assets                  — Asset registry
 *   GET/DELETE /film/assets/:id                         — Asset by ID
 *   POST/GET /film/projects/:id/music-cues              — Music cues
 *   POST/GET /film/projects/:id/color-presets            — Color presets
 *   GET    /film/projects/:id/dashboard                  — Production dashboard
 *   GET    /film/projects/:id/status-board               — Status board
 *   GET/POST /film/projects/:id/milestones               — Milestones
 *   PUT    /film/projects/:id/milestones/:mid            — Update milestone
 *   POST   /film/shots/:id/render                        — Log render
 *   GET    /film/shots/:id/renders                       — Render history
 *   GET    /film/shots/:id/versions                      — Shot version history
 *   POST   /film/shots/:id/re-render                     — Re-render from ledger
 *   POST   /film/projects/:id/advance-status             — Evaluate & advance project status
 *   GET    /film/scenes/:id/call-sheet                   — Scene call sheet
 *   GET    /film/projects/:id/call-sheet                 — Full project call sheet
 */

const http = require('http');
const { ensureSchema } = require('./db/schema');
const { handleProjects } = require('./routes/projects');
const { handleScripts } = require('./routes/scripts');
const { handleScenes } = require('./routes/scenes');
const { handleShots } = require('./routes/shots');
const { handleBreakdown } = require('./routes/breakdown');
const { handleScreenplayAI } = require('./routes/screenplay-ai');
const { handleCharacters } = require('./routes/characters');
const { handleLocations } = require('./routes/locations');
const { handleNotes } = require('./routes/notes');
const { handleAssets } = require('./routes/assets');
const { handleDashboard } = require('./routes/dashboard');
const { handleRenderLedger } = require('./routes/render-ledger');
const { handleProductionStatus } = require('./routes/production-status');
const { handleCallSheets } = require('./routes/call-sheets');
const { handleTextConvert } = require('./routes/text-convert');

const PORT = process.env.PORT || 3100;

// Parse JSON body from request
function readBody(req, maxSize = 10 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            body += chunk;
        });
        req.on('end', () => {
            if (!body) { resolve({}); return; }
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

// Parse query string into object
function parseQuery(search) {
    const params = {};
    if (!search) return params;
    const sp = new URLSearchParams(search);
    for (const [k, v] of sp) params[k] = v;
    return params;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const query = parseQuery(url.search);
    const parts = pathname.split('/').filter(Boolean); // ['film', 'projects', ...]

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health check
    if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'film-engine' }));
        return;
    }

    // All film routes start with /film
    if (parts[0] !== 'film') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    // Parse body for POST/PUT
    if (req.method === 'POST' || req.method === 'PUT') {
        try {
            req.body = await readBody(req);
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
        }
    }

    // parts[0]='film', parts[1]='projects'|'scenes'|'shots'|..., parts[2]=:id, parts[3]=sub-route, parts[4]=param
    try {
        // Route: /film/projects/:id/breakdown[/stream]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'breakdown') {
            return await handleBreakdown(req, res, parts);
        }

        // Route: /film/projects/:id/screenplay-ai (FILM-112)
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'screenplay-ai') {
            return await handleScreenplayAI(req, res, parts);
        }

        // Route: /film/projects/:id/text-to-screenplay[/preview] (FILM-117)
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'text-to-screenplay') {
            return await handleTextConvert(req, res, parts);
        }

        // Route: /film/projects/:id/advance-status
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'advance-status') {
            return handleProductionStatus(req, res, parts, query);
        }

        // Route: /film/projects/:id/call-sheet
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'call-sheet') {
            return handleCallSheets(req, res, parts, query);
        }

        // Route: /film/projects/:id/script or /film/projects/:id/scripts[/:version]
        if (parts[1] === 'projects' && parts[2] && (parts[3] === 'script' || parts[3] === 'scripts')) {
            return await handleScripts(req, res, parts, query);
        }

        // Route: /film/projects/:id/scenes
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'scenes') {
            return await handleScenes(req, res, parts, query);
        }

        // Route: /film/projects/:id/shotlist
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'shotlist') {
            return await handleShots(req, res, parts, query);
        }

        // Route: /film/projects/:id/characters
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'characters') {
            return handleCharacters(req, res, parts, query);
        }

        // Route: /film/projects/:id/locations
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'locations') {
            return handleLocations(req, res, parts, query);
        }

        // Route: /film/projects/:id/props
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'props') {
            return handleLocations(req, res, parts, query);
        }

        // Route: /film/projects/:id/assets
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'assets') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/projects/:id/music-cues
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'music-cues') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/projects/:id/color-presets
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'color-presets') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/projects/:id/dashboard
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'dashboard') {
            return handleDashboard(req, res, parts, query);
        }

        // Route: /film/projects/:id/status-board
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'status-board') {
            return handleDashboard(req, res, parts, query);
        }

        // Route: /film/projects/:id/milestones[/:mid]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'milestones') {
            return handleDashboard(req, res, parts, query);
        }

        // Route: /film/projects[/:id]
        if (parts[1] === 'projects') {
            return await handleProjects(req, res, parts, query);
        }

        // Route: /film/scenes/:id/call-sheet
        if (parts[1] === 'scenes' && parts[2] && parts[3] === 'call-sheet') {
            return handleCallSheets(req, res, parts, query);
        }

        // Route: /film/scenes/:id
        if (parts[1] === 'scenes') {
            return await handleScenes(req, res, parts, query);
        }

        // Route: /film/characters/:id[/voice|/costumes]
        if (parts[1] === 'characters') {
            return handleCharacters(req, res, parts, query);
        }

        // Route: /film/locations/:id
        if (parts[1] === 'locations') {
            return handleLocations(req, res, parts, query);
        }

        // Route: /film/props/:id
        if (parts[1] === 'props') {
            return handleLocations(req, res, parts, query);
        }

        // Route: /film/assets/:id
        if (parts[1] === 'assets') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/notes/:id (update/delete)
        if (parts[1] === 'notes') {
            return handleNotes(req, res, parts, query);
        }

        // Route: /film/shots/:id/notes, /film/shots/:id/review,
        //        /film/shots/:id/render, /film/shots/:id/renders,
        //        /film/shots/:id/versions, /film/shots/:id/re-render
        if (parts[1] === 'shots' && parts[2] && parts[3]) {
            const sub = parts[3];
            if (sub === 'notes' || sub === 'review') {
                return handleNotes(req, res, parts, query);
            }
            if (sub === 'render' || sub === 'renders' || sub === 'versions' || sub === 're-render') {
                return handleRenderLedger(req, res, parts, query);
            }
        }

        // Route: /film/shots (create shots from scene cards)
        if (parts[1] === 'shots') {
            return await handleShots(req, res, parts, query);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
        console.error('Request error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', details: err.message }));
    }
});

// Start server after schema is ready
function start() {
    console.log('Film Engine starting...');
    console.log('  Checking database schema (SQLite)...');

    try {
        ensureSchema();
    } catch (err) {
        console.error('Failed to initialize database:', err.message);
        process.exit(1);
    }

    server.listen(PORT, () => {
        console.log(`  Film Engine API ready on http://localhost:${PORT}`);
        console.log('  Routes: /film/projects, /film/shots, /film/scenes, /film/characters,');
        console.log('          /film/locations, /film/props, /film/notes, /film/assets,');
        console.log('          /film/*/dashboard, /film/*/milestones, /film/*/render,');
        console.log('          /film/*/advance-status, /film/*/call-sheet, /film/*/breakdown');
    });
}

start();
