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
 *   GET    /film/projects/:id/export[/fcpxml|edl|premiere] — NLE export
 *   POST   /film/projects/:id/storyboard/generate[/stream] — Storyboard generation
 *   GET    /film/projects/:id/storyboard                  — View storyboard frames
 *   POST   /film/shots/:id/storyboard/regenerate          — Regenerate single shot
 *   GET    /film/storyboards/:projectId/:filename          — Serve storyboard image
 *   POST   /film/shots/:id/voice/generate[/stream]         — Voice generation
 *   POST   /film/projects/:id/voice/batch[/stream]          — Batch voice generation
 *   GET    /film/shots/:id/voice                            — Voice job status
 *   GET    /film/audio/:projectId/:filename                 — Serve audio files
 *   POST   /film/shots/:id/video/generate[/stream]          — Video generation
 *   POST   /film/projects/:id/video/batch[/stream]          — Batch video generation
 *   GET    /film/video/:projectId/:filename                 — Serve video files
 *   POST   /film/shots/:id/lipsync/generate[/stream]        — Lip-sync generation
 *   POST   /film/projects/:id/lipsync/batch                 — Batch lip-sync
 *   POST   /film/scenes/:id/music/generate[/stream]         — Music score generation
 *   POST   /film/shots/:id/sfx/generate                     — SFX generation
 *   POST   /film/scenes/:id/ambient/generate                — Ambient audio generation
 *   POST   /film/projects/:id/music/batch[/stream]          — Batch music generation
 *   GET    /film/music/:projectId/:filename                 — Serve music files
 *   POST   /film/shots/:id/post/[upscale|face-restore|color-grade|composite] — Post-production
 *   POST   /film/projects/:id/post/batch[/stream]           — Batch post-production
 *   POST   /film/shots/:id/pipeline/run[/stream]            — Shot pipeline
 *   POST   /film/scenes/:id/pipeline/run                    — Scene pipeline
 *   POST   /film/projects/:id/pipeline/run                  — Project pipeline
 *   GET    /film/pipeline/:id                               — Pipeline run status
 *   POST   /film/pipeline/:id/[pause|resume|cancel]         — Pipeline control
 */

const http = require('http');
const { ensureSchema } = require('./db/schema');
const { handleProjects, handleProjectSettingsPreset } = require('./routes/projects');
const { handleScripts, handleComments } = require('./routes/scripts');
const { handleScenes } = require('./routes/scenes');
const { handleShots } = require('./routes/shots');
const { handleBreakdown } = require('./routes/breakdown');
const { handleScreenplayAI } = require('./routes/screenplay-ai');
const { handleCharacters } = require('./routes/characters');
const { handleActs } = require('./routes/acts');
const { handleSubtitles } = require('./routes/subtitles');
const { handleAudioDeliverables } = require('./routes/audio-deliverables');
const { handleLocations } = require('./routes/locations');
const { handleNotes } = require('./routes/notes');
const { handleAssets } = require('./routes/assets');
const { handleDashboard } = require('./routes/dashboard');
const { handleRenderLedger } = require('./routes/render-ledger');
const { handleProductionStatus } = require('./routes/production-status');
const { handleCallSheets } = require('./routes/call-sheets');
const { handleTextConvert } = require('./routes/text-convert');
const { handleNLEExport } = require('./routes/nle-export');
const { handleStoryboard } = require('./routes/storyboard');
const { handleVoice } = require('./routes/voice');
const { handleVideoGen } = require('./routes/video-gen');
const { handleLipsync } = require('./routes/lipsync');
const { handleMusicGen } = require('./routes/music-gen');
const { handlePostProduction } = require('./routes/post-production');
const { handlePipeline } = require('./routes/pipeline');
const { handleQA } = require('./routes/qa');
const { handleProjectBundle } = require('./routes/project-bundle');
const { handleContinuity } = require('./routes/continuity');
const { handleCredits } = require('./routes/credits');
const { handleMarketing } = require('./routes/marketing');
const { handleBudget } = require('./routes/budget');
const { handleBudgetEstimate } = require('./routes/budget-estimate');
const { handleBackups } = require('./routes/backups');
const { handleDemoProject } = require('./routes/demo-project');

const PORT = process.env.PORT || 3100;

// ── Rate Limiter ────────────────────────────────────────────────────
// Sliding-window rate limiter keyed by client IP.
// RATE_LIMIT_WINDOW_MS: window size (default 60s)
// RATE_LIMIT_MAX_GENERAL: max general requests per window (default 200)
// RATE_LIMIT_MAX_GENERATION: max generation requests per window (default 10)
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_GENERAL = parseInt(process.env.RATE_LIMIT_MAX_GENERAL || '200', 10);
const RATE_LIMIT_MAX_GENERATION = parseInt(process.env.RATE_LIMIT_MAX_GENERATION || '10', 10);

const _rateBuckets = {};  // ip → { general: [timestamps], generation: [timestamps] }

function _getRateBucket(ip) {
    if (!_rateBuckets[ip]) _rateBuckets[ip] = { general: [], generation: [] };
    return _rateBuckets[ip];
}

function _pruneTimestamps(arr, now) {
    const cutoff = now - RATE_LIMIT_WINDOW;
    while (arr.length && arr[0] < cutoff) arr.shift();
}

// Clean stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const ip of Object.keys(_rateBuckets)) {
        const b = _rateBuckets[ip];
        _pruneTimestamps(b.general, now);
        _pruneTimestamps(b.generation, now);
        if (!b.general.length && !b.generation.length) delete _rateBuckets[ip];
    }
}, 5 * 60 * 1000).unref();

/**
 * Check rate limit. Returns true if allowed, false if limited.
 */
function checkRateLimit(ip, bucket) {
    const now = Date.now();
    const b = _getRateBucket(ip);
    const arr = b[bucket];
    _pruneTimestamps(arr, now);
    const max = bucket === 'generation' ? RATE_LIMIT_MAX_GENERATION : RATE_LIMIT_MAX_GENERAL;
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
}

// Generation routes that consume GPU/API resources
const GENERATION_ROUTES = new Set([
    'breakdown', 'storyboard', 'voice', 'video', 'lipsync',
    'music', 'pipeline', 'screenplay-ai', 'text-to-screenplay',
    'post', 'qa',
]);

// Strip prototype pollution keys (__proto__, constructor, prototype) recursively
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function stripDangerousKeys(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripDangerousKeys);
    const clean = {};
    for (const key of Object.keys(obj)) {
        if (DANGEROUS_KEYS.has(key)) continue;
        clean[key] = stripDangerousKeys(obj[key]);
    }
    return clean;
}

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
            try { resolve(stripDangerousKeys(JSON.parse(body))); }
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

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // CORS — restrict to configured origins (default: allow all for local dev)
    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS || '*';
    const origin = req.headers.origin || '';
    if (allowedOrigins === '*') {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
        const origins = allowedOrigins.split(',').map(o => o.trim());
        if (origins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Rate limiting
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const subRoute = parts[3] || '';
    const rateBucket = (req.method === 'POST' && GENERATION_ROUTES.has(subRoute)) ? 'generation' : 'general';
    if (!checkRateLimit(clientIp, rateBucket)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW / 1000)) });
        res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }));
        return;
    }

    // Health check
    if (pathname === '/api/health' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'film-engine', version: '0.1.0' }));
        return;
    }

    // All film routes start with /film
    if (parts[0] !== 'film') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    // Parse body for POST/PUT (larger limit for bundle import)
    if (req.method === 'POST' || req.method === 'PUT') {
        const maxSize = (parts[1] === 'projects' && parts[2] === 'import')
            ? 500 * 1024 * 1024  // 500MB for bundle import
            : 10 * 1024 * 1024;  // 10MB default
        try {
            req.body = await readBody(req, maxSize);
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
        }
    }

    // parts[0]='film', parts[1]='projects'|'scenes'|'shots'|..., parts[2]=:id, parts[3]=sub-route, parts[4]=param
    try {
        // Route: /film/storyboards/:projectId/:filename — serve storyboard images
        if (parts[1] === 'storyboards' && parts[2] && parts[3]) {
            return handleStoryboard(req, res, parts, query);
        }

        // Route: /film/refsheets/:projectId/:filename — serve character reference images
        if (parts[1] === 'refsheets' && parts[2] && parts[3]) {
            const { serveFile } = require('./lib/file-storage');
            return serveFile(res, parts[2], 'refsheets', parts[3]);
        }

        // Route: /film/loc-refs/:projectId/:filename — serve location reference images
        if (parts[1] === 'loc-refs' && parts[2] && parts[3]) {
            const { serveFile } = require('./lib/file-storage');
            return serveFile(res, parts[2], 'loc-refs', parts[3]);
        }

        // Route: /film/prop-refs/:projectId/:filename — serve prop reference images
        if (parts[1] === 'prop-refs' && parts[2] && parts[3]) {
            const { serveFile } = require('./lib/file-storage');
            return serveFile(res, parts[2], 'prop-refs', parts[3]);
        }

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

        // Route: /film/projects/:id/screenplay/suggestions (FILM-121)
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'screenplay' && parts[4] === 'suggestions') {
            return await handleScripts(req, res, parts, query);
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

        // Route: /film/projects/:id/shots/reorder
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'shots' && parts[4] === 'reorder') {
            return await handleShots(req, res, parts, query);
        }

        // Route: /film/projects/:id/subtitles[/export/:fmt|/languages|/convert]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'subtitles') {
            return handleSubtitles(req, res, parts, query);
        }

        // Route: /film/projects/:id/audio-deliverables[/manifest]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'audio-deliverables') {
            return handleAudioDeliverables(req, res, parts, query);
        }

        // Route: /film/projects/:id/acts
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'acts') {
            return handleActs(req, res, parts, query);
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

        // Route: /film/projects/:id/music-rights
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'music-rights') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/projects/:id/continuity[/board]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'continuity') {
            return handleContinuity(req, res, parts, query);
        }

        // Route: /film/projects/:id/credits[/reorder]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'credits') {
            return handleCredits(req, res, parts, query);
        }

        // Route: /film/projects/:id/title-cards
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'title-cards') {
            return handleCredits(req, res, parts, query);
        }

        // Route: /film/projects/:id/marketing
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'marketing') {
            return handleMarketing(req, res, parts, query);
        }

        // Route: /film/projects/:id/budget/estimate[/analyze|/web-search|/ai|/:eid]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'budget' && parts[4] === 'estimate') {
            return handleBudgetEstimate(req, res, parts, query);
        }

        // Route: /film/projects/:id/budget[/ledger|/forecast|/limit]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'budget') {
            return handleBudget(req, res, parts, query);
        }

        // Route: /film/projects/:id/backups
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'backups') {
            return handleBackups(req, res, parts, query);
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

        // Route: /film/projects/import (must come before generic /film/projects/:id)
        if (parts[1] === 'projects' && parts[2] === 'import') {
            return handleProjectBundle(req, res, parts, query);
        }

        // Route: /film/projects/:id/bundle — export project archive
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'bundle') {
            return handleProjectBundle(req, res, parts, query);
        }

        // Route: /film/projects/:id/export[/fcpxml|edl|premiere]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'export') {
            return handleNLEExport(req, res, parts, query);
        }

        // Route: /film/projects/:id/storyboard[/generate[/stream]]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'storyboard') {
            return await handleStoryboard(req, res, parts, query);
        }

        // Route: /film/projects/:id/voice[/batch[/stream]]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'voice') {
            return await handleVoice(req, res, parts, query);
        }

        // Route: /film/projects/:id/video[/batch[/stream]]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'video') {
            return await handleVideoGen(req, res, parts, query);
        }

        // Route: /film/projects/:id/lipsync[/batch]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'lipsync') {
            return await handleLipsync(req, res, parts, query);
        }

        // Route: /film/projects/:id/music[/batch[/stream]|/jobs]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'music') {
            return await handleMusicGen(req, res, parts, query);
        }

        // Route: /film/projects/:id/post[/batch[/stream]]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'post') {
            return await handlePostProduction(req, res, parts, query);
        }

        // Route: /film/projects/:id/pipeline[/run|/schedule]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'pipeline') {
            return await handlePipeline(req, res, parts, query);
        }

        // Route: /film/projects/:id/qa[/run|/latest|/continuity|/rubric]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'qa') {
            return handleQA(req, res, parts, query);
        }

        // Route: /film/projects/demo — create demo project
        if (parts[1] === 'projects' && parts[2] === 'demo') {
            return handleDemoProject(req, res);
        }

        // Route: /film/projects/:id/settings/preset
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'settings' && parts[4] === 'preset') {
            return handleProjectSettingsPreset(req, res, parts);
        }

        // Route: /film/projects[/:id]
        if (parts[1] === 'projects') {
            return await handleProjects(req, res, parts, query);
        }

        // Route: /film/audio/:projectId/:filename — serve audio files
        if (parts[1] === 'audio' && parts[2] && parts[3]) {
            return handleVoice(req, res, parts, query);
        }

        // Route: /film/video/:projectId/:filename — serve video files
        if (parts[1] === 'video' && parts[2] && parts[3]) {
            return handleVideoGen(req, res, parts, query);
        }

        // Route: /film/music/:projectId/:filename — serve music files
        if (parts[1] === 'music' && parts[2] && parts[3]) {
            return handleMusicGen(req, res, parts, query);
        }

        // Route: /film/pipeline/:id[/pause|resume|cancel]
        if (parts[1] === 'pipeline' && parts[2]) {
            return await handlePipeline(req, res, parts, query);
        }

        // Route: /film/scenes/:id/call-sheet
        if (parts[1] === 'scenes' && parts[2] && parts[3] === 'call-sheet') {
            return handleCallSheets(req, res, parts, query);
        }

        // Route: /film/scenes/:id/music/generate[/stream]
        if (parts[1] === 'scenes' && parts[2] && parts[3] === 'music') {
            return await handleMusicGen(req, res, parts, query);
        }

        // Route: /film/scenes/:id/ambient/generate
        if (parts[1] === 'scenes' && parts[2] && parts[3] === 'ambient') {
            return await handleMusicGen(req, res, parts, query);
        }

        // Route: /film/scenes/:id/pipeline/run
        if (parts[1] === 'scenes' && parts[2] && parts[3] === 'pipeline') {
            return await handlePipeline(req, res, parts, query);
        }

        // Route: /film/scenes/:id/qa/run
        if (parts[1] === 'scenes' && parts[2] && parts[3] === 'qa') {
            return handleQA(req, res, parts, query);
        }

        // Route: /film/scenes/:id
        if (parts[1] === 'scenes') {
            return await handleScenes(req, res, parts, query);
        }

        // Route: /film/acts/:id[/assign]
        if (parts[1] === 'acts') {
            return handleActs(req, res, parts, query);
        }

        // Route: /film/subtitles/:id
        if (parts[1] === 'subtitles') {
            return handleSubtitles(req, res, parts, query);
        }

        // Route: /film/audio-deliverables/:id
        if (parts[1] === 'audio-deliverables') {
            return handleAudioDeliverables(req, res, parts, query);
        }

        // Route: /film/continuity/:id
        if (parts[1] === 'continuity') {
            return handleContinuity(req, res, parts, query);
        }

        // Route: /film/credits/:id
        if (parts[1] === 'credits') {
            return handleCredits(req, res, parts, query);
        }

        // Route: /film/title-cards/:id
        if (parts[1] === 'title-cards') {
            return handleCredits(req, res, parts, query);
        }

        // Route: /film/marketing/:id[/generate]
        if (parts[1] === 'marketing') {
            return handleMarketing(req, res, parts, query);
        }

        // Route: /film/budget/templates, /film/budget/talent-tiers, /film/budget/location-types
        if (parts[1] === 'budget' && (parts[2] === 'templates' || parts[2] === 'talent-tiers' || parts[2] === 'location-types')) {
            return handleBudgetEstimate(req, res, parts, query);
        }

        // Route: /film/budget/:id
        if (parts[1] === 'budget') {
            return handleBudget(req, res, parts, query);
        }

        // Route: /film/music-cues/:id/rights
        if (parts[1] === 'music-cues' && parts[2] && parts[3] === 'rights') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/backups/:id[/download|/restore]
        if (parts[1] === 'backups') {
            return handleBackups(req, res, parts, query);
        }

        // Route: /film/characters/:id/cost
        if (parts[1] === 'characters' && parts[2] && parts[3] === 'cost') {
            return handleBudgetEstimate(req, res, parts, query);
        }

        // Route: /film/characters/:id[/voice|/costumes]
        if (parts[1] === 'characters') {
            return handleCharacters(req, res, parts, query);
        }

        // Route: /film/locations/:id/cost
        if (parts[1] === 'locations' && parts[2] && parts[3] === 'cost') {
            return handleBudgetEstimate(req, res, parts, query);
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

        // Route: /film/scripts/:id/comments
        if (parts[1] === 'scripts' && parts[2] && parts[3] === 'comments') {
            return handleComments(req, res, parts, query);
        }

        // Route: /film/comments/:id (update/delete)
        if (parts[1] === 'comments' && parts[2]) {
            return handleComments(req, res, parts, query);
        }

        // Route: /film/notes/:id (update/delete)
        if (parts[1] === 'notes') {
            return handleNotes(req, res, parts, query);
        }

        // Route: /film/shots/:id/storyboard/regenerate
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'storyboard') {
            return await handleStoryboard(req, res, parts, query);
        }

        // Route: /film/shots/:id/voice[/generate[/stream]]
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'voice') {
            return await handleVoice(req, res, parts, query);
        }

        // Route: /film/shots/:id/video[/generate[/stream]]
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'video') {
            return await handleVideoGen(req, res, parts, query);
        }

        // Route: /film/shots/:id/lipsync[/generate[/stream]]
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'lipsync') {
            return await handleLipsync(req, res, parts, query);
        }

        // Route: /film/shots/:id/sfx/generate
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'sfx') {
            return await handleMusicGen(req, res, parts, query);
        }

        // Route: /film/shots/:id/post[/upscale|face-restore|color-grade|composite]
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'post') {
            return await handlePostProduction(req, res, parts, query);
        }

        // Route: /film/shots/:id/audio/mix
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'audio') {
            return await handleMusicGen(req, res, parts, query);
        }

        // Route: /film/shots/:id/pipeline/run[/stream]
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'pipeline') {
            return await handlePipeline(req, res, parts, query);
        }

        // Route: /film/shots/:id/qa/run
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'qa') {
            return handleQA(req, res, parts, query);
        }

        // Route: /film/shots/:id/notes, /film/shots/:id/review,
        //        /film/shots/:id/render, /film/shots/:id/renders,
        //        /film/shots/:id/versions, /film/shots/:id/re-render,
        //        /film/shots/:id/order, /film/shots/:id/transition
        if (parts[1] === 'shots' && parts[2] && parts[3]) {
            const sub = parts[3];
            if (sub === 'notes' || sub === 'review') {
                return handleNotes(req, res, parts, query);
            }
            if (sub === 'render' || sub === 'renders' || sub === 'versions' || sub === 're-render') {
                return handleRenderLedger(req, res, parts, query);
            }
            if (sub === 'order' || sub === 'transition') {
                return await handleShots(req, res, parts, query);
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
        res.end(JSON.stringify({ error: 'Internal server error' }));
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
        console.log('          /film/*/advance-status, /film/*/call-sheet, /film/*/breakdown,');
        console.log('          /film/*/export, /film/*/storyboard, /film/*/voice, /film/*/video,');
        console.log('          /film/*/lipsync, /film/*/music, /film/*/sfx, /film/*/post,');
        console.log('          /film/*/pipeline, /film/*/qa, /film/*/audio/mix, /film/*/schedule,');
        console.log('          /film/audio/*, /film/video/*, /film/music/*, /film/*/refsheet');
    });
}

start();
