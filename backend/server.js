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
const { handleStoryStructure } = require('./routes/story-structure');
const { handleStoryDevelopment } = require('./routes/story-development');
const { handleSubjectGallery } = require('./routes/subject-gallery');
const { handleVoiceCasting } = require('./routes/voice-casting');
const { handleAgentPresence } = require('./routes/agent-presence');
const { handleScenes } = require('./routes/scenes');
const { handleShots } = require('./routes/shots');
const { handleAppSettings } = require('./routes/app-settings');
const { handleEvents } = require('./routes/events');
const { handleStoryBible } = require('./routes/story-bible');
const { handleBreakdown } = require('./routes/breakdown');
const { handleProductionReports } = require('./routes/production-reports');
const { handleGenerationJobs } = require('./routes/generation-jobs');
const { handleMoodBoard } = require('./routes/mood-board');
const { handleStyleBook } = require('./routes/style-book');
const { handleDeliverables } = require('./routes/deliverables');
const { handleBrands } = require('./routes/brands');
const { handleMediaImport } = require('./routes/media-import');
const { handleSequences } = require('./routes/sequences');
const { handleAnnotations } = require('./routes/annotations');
const { handleScreenplayAI } = require('./routes/screenplay-ai');
const { handleCharacters } = require('./routes/characters');
const { handleSubtitles } = require('./routes/subtitles');
const { handleAudioDeliverables } = require('./routes/audio-deliverables');
const { handleLocations } = require('./routes/locations');
const { handleNotes } = require('./routes/notes');
const { handleAssets } = require('./routes/assets');
const { handleDashboard } = require('./routes/dashboard');
const { handleRenderLedger } = require('./routes/render-ledger');
// ==== CLAUDE:START editorial (gaps 3/4/5) ====
const { handleTimeline } = require('./routes/timeline');
const { handleTakes } = require('./routes/takes');
// ==== CLAUDE:END ====
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
const { handleThreeD } = require('./routes/threed');
const { handleWorlds, SHOT_TAILS: WORLD_SHOT_TAILS } = require('./routes/worlds');
const approvalGuard = require('./lib/approval-guard');
const { handleApprovals } = require('./routes/approvals');
const { handleProviders } = require('./routes/providers');
const { handleConsistency } = require('./routes/consistency');
const { handleQA } = require('./routes/qa');
const { handleProjectBundle } = require('./routes/project-bundle');
const { handleContinuity } = require('./routes/continuity');
const { handleCredits } = require('./routes/credits');
const { handleMarketing } = require('./routes/marketing');
const { handleBudget } = require('./routes/budget');
const { handleBudgetEstimate } = require('./routes/budget-estimate');
const { handleBackups } = require('./routes/backups');
const { handleDemoProject } = require('./routes/demo-project');
// ==== CODEX:START ops-compliance-routes ====
const { handleJobs } = require('./routes/jobs');
const { handleFlows } = require('./routes/flows');
const { handlePrevis } = require('./routes/previs');
// ==== CODEX:END ====

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
    'model', 'models', 'rig', 'retexture', 'animate',
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
const bodyLimit = require('./lib/body-limit');

function readBody(req, maxSize = 10 * 1024 * 1024, res = null) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        let oversize = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                /*
                 * SAY SO, then hang up — not the other way round.
                 *
                 * This destroyed the request and then tried to write a 400. A
                 * destroyed request surfaces in the browser as a network error,
                 * and api() maps anything mentioning fetch to "Backend offline"
                 * — so an upload that was merely too big was indistinguishable
                 * from a dead server. Video is the most likely thing to reach
                 * the ceiling, which is exactly when the wrong diagnosis costs
                 * the most time.
                 */
                const limitMb = Math.floor(maxSize / (1024 * 1024));
                if (!res.headersSent) {
                    res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
                    res.end(JSON.stringify({
                        error: `That file is too large. The limit is ${limitMb}MB of upload, which is `
                            + `about ${Math.floor(limitMb * 0.75)}MB of actual file — uploads travel `
                            + 'base64-encoded, which is a third larger than the file itself.',
                        limit_mb: limitMb,
                        max_file_mb: Math.floor(limitMb * 0.75),
                    }));
                }
                oversize = true;
                req.destroy();
                reject(new Error(`Request body too large (limit ${limitMb}MB)`));
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
        const isBundleImport = parts[1] === 'projects' && parts[2] === 'import';
        /*
         * Any /import endpoint carries a file, so any /import endpoint gets the
         * large body.
         *
         * This was a hand-written list of three path shapes — exactly the kind
         * that rots: the four plate and mood-board imports added afterwards
         * would each have inherited a 10MB ceiling and refused a normal
         * photograph, with the failure surfacing as a destroyed connection
         * rather than a message. Derived from the URL shape instead, so a new
         * import target inherits it with nothing to remember.
         */
        const maxSize = isBundleImport ? bodyLimit.BUNDLE_LIMIT : bodyLimit.bodyLimitFor(parts);
        try {
            req.body = await readBody(req, maxSize, res);
        } catch (err) {
            // A 413 has already been written and the socket closed; writing
            // again throws and replaces a clear refusal with a stack trace.
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }
    }

    /*
     * AN APPROVAL IS RE-CHECKED HERE, ONCE, BEFORE ANY ROUTE SEES IT.
     *
     * A request that carries `approval_fingerprint` is claiming somebody
     * already said yes to a specific set of inputs. Between that yes and this
     * request a plate can have been regenerated or a card edited, and without
     * a re-check "I approved that" and "that is what ran" become two different
     * claims that nothing afterwards can separate.
     *
     * It lives at the dispatch rather than in each paid route on purpose. A
     * guard wired per endpoint gets wired into most of them, and the one it
     * misses is the one that runs unapproved work — the same reasoning that
     * put metering in `resolve()` and the body limit in the URL shape. Here it
     * covers every route, present and future, with nothing to remember, and it
     * costs nothing at all on the ordinary path where the field is absent.
     */
    if (req.body && req.body[approvalGuard.FIELD]) {
        const verdict = approvalGuard.checkApproval(req.body, approvalGuard.subjectOf(parts));
        if (!verdict.ok) {
            res.writeHead(verdict.status || 409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(verdict));
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
            return serveFile(res, parts[2], 'refsheets', parts[3], { width: query && query.w });
        }

        // Route: /film/loc-refs/:projectId/:filename — serve location reference images
        if (parts[1] === 'loc-refs' && parts[2] && parts[3]) {
            const { serveFile } = require('./lib/file-storage');
            return serveFile(res, parts[2], 'loc-refs', parts[3], { width: query && query.w });
        }

        // Route: /film/prop-refs/:projectId/:filename — serve prop reference images
        if (parts[1] === 'prop-refs' && parts[2] && parts[3]) {
            const { serveFile } = require('./lib/file-storage');
            return serveFile(res, parts[2], 'prop-refs', parts[3], { width: query && query.w });
        }

        // Route: /film/projects/:id/breakdown[/stream]
        if (parts[1] === 'assets' && parts[2] && parts[3] === 'accept') {
            return await handleProductionReports(req, res, parts, query);
        }

        /*
         * Footage and sound made outside Film Engine. Registered EARLY, and
         * before any /shots/:id/... or /scenes/:id/... dispatch, because the
         * domain handlers match on their own third segment and would otherwise
         * swallow /media/ — the same trap the 3D location route and the frames
         * route each fell into, where a handler existed and nothing reached it.
         */
        /*
         * Sequences. Before the generic /projects/:id/... and /shots/:id/...
         * dispatch for the same reason media-import is: the domain handlers
         * match on their own third segment and would swallow these.
         */
        /*
         * The sound library. Registered BEFORE the project catch-alls, on the
         * trap `/film/locations/:id` already cost once: a handler that exists
         * and is never reached looks exactly like a missing feature.
         */
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'sounds') {
            const sounds = require('./routes/sounds');
            if (parts[4] === 'generate') {
                // GET is the free preview the shared confirmation reads; POST spends.
                return await sounds.generateSound(req, res, parts[2]);
            }
            if (!parts[4] && req.method === 'GET') {
                return await sounds.listSounds(req, res, parts[2]);
            }
        }

        if ((parts[1] === 'projects' && parts[2] && parts[3] === 'sequences')
            || (parts[1] === 'sequences' && parts[2])) {
            const handled = await handleSequences(req, res, parts, query);
            if (handled !== false) return handled;
        }

        /*
         * The shape of a sound, for the card that plays it.
         *
         * Answered here rather than from a media route because the file lives
         * wherever its capability puts it, and the asset row is the only thing
         * that knows which. Peaks, not an image: one small JSON serves every
         * width the card is drawn at.
         */
        if (parts[1] === 'assets' && parts[2] && parts[3] === 'waveform' && req.method === 'GET') {
            const { db } = require('./db/database');
            const row = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(parts[2]);
            if (!row || !row.file_path) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'No such asset' }));
            }
            const { waveformFor } = require('./lib/waveform');
            const wave = await waveformFor(row.file_path);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                // Keyed on mtime and size inside, so a regenerated cue gets a
                // new shape; safe to hold for a day.
                'Cache-Control': 'public, max-age=86400',
            });
            // null is a legitimate answer: no encoder, or a file that will not
            // decode. The card draws a flat line and still plays the audio.
            return res.end(JSON.stringify(wave || { peaks: [], buckets: 0 }));
        }

        if (parts[1] === 'media-kinds'
            || (parts[1] === 'assets' && parts[2] && parts[3] === 'coverage')
            // A cue's own audio. Listed here because the music handler matches
            // music-cues and would swallow it -- the /film/locations/:id trap
            // already cost once: a handler that exists and is never reached
            // looks exactly like a missing feature.
            || (parts[1] === 'music-cues' && parts[2] && parts[3] === 'audio')
            || (['shots', 'scenes'].includes(parts[1]) && parts[2] && parts[3] === 'media')) {
            const handled = await handleMediaImport(req, res, parts, query);
            if (handled !== false) return handled;
        }

        if ((parts[1] === 'shots' && parts[2] && parts[3] === 'annotations')
            || (parts[1] === 'annotations' && parts[2])) {
            return await handleAnnotations(req, res, parts, query);
        }

        if ((parts[1] === 'projects' && parts[2] && parts[3] === 'mood-board')
            || (parts[1] === 'mood-board' && parts[2])) {
            return await handleMoodBoard(req, res, parts, query);
        }

        /*
         * Route: the brand library and the claims register. Brands are matched
         * before /film/projects/:id for the same reason the style book is: the
         * library is not scoped to a project, and the claim sub-paths would
         * otherwise be swallowed by the project router.
         */
        if (parts[1] === 'brands'
            || (parts[1] === 'claims' && parts[2])
            || (parts[1] === 'projects' && parts[2]
                && (parts[3] === 'claims' || parts[3] === 'compliance'))) {
            return handleBrands(req, res, parts, query);
        }

        /*
         * Route: the deliverable set — one row per file that leaves the job.
         * Matched before /film/projects/:id so the sub-paths are not swallowed
         * by the project router, the same reason the style book sits above the
         * shot router.
         */
        if ((parts[1] === 'projects' && parts[2] && parts[3] === 'deliverables')
            || (parts[1] === 'deliverables' && parts[2])) {
            return handleDeliverables(req, res, parts, query);
        }

        // Route: the style book — the director's library, and applying an
        // entry to a shot. Matched before /film/shots/:id so the apply path is
        // not swallowed by the shot router.
        if ((parts[1] === 'projects' && parts[2] && parts[3] === 'style-book')
            || (parts[1] === 'shots' && parts[2] && parts[3] === 'style-book')
            || parts[1] === 'style-book') {
            return handleStyleBook(req, res, parts, query);
        }

        // Route: /film/projects/:id/bible[/:section] and /bible-drift
        if (parts[1] === 'projects' && parts[2] && (parts[3] === 'bible' || parts[3] === 'bible-drift')) {
            return handleStoryBible(req, res, parts);
        }

        // Outstanding generations. Registered BEFORE the project catch-alls
        // below, on the trap /film/locations/:id already cost once: a handler
        // that exists and is never reached looks exactly like a missing feature.
        if (parts[1] === 'generation-jobs'
            || (parts[1] === 'projects' && parts[3] === 'generation-jobs')) {
            return await handleGenerationJobs(req, res, parts, query);
        }

        if (parts[1] === 'projects' && parts[2] && ['staleness', 'screenplay-drift', 'impact', 'scale-check', 'sides', 'dood', 'run-plan', 'breakdown-summary', 'elements-list', 'run-report', 'board-groups', 'setups', 'conform'].includes(parts[3])) {
            return await handleProductionReports(req, res, parts, query);
        }

        if (parts[1] === 'projects' && parts[2] && (parts[3] === 'breakdown' || parts[3] === 'entities')) {
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

        // Route: /film/projects/:id/script[s] and /film/projects/:id/outline
        //
        // `outline` is here rather than beside the project routes because it IS
        // the screenplay — sections and synopses are Fountain elements, not
        // project metadata. Without this line the generic /projects/:id route
        // below swallows it: GET returned the project and POST returned
        // "Method not allowed", which is the fourth time in this codebase a
        // handler has existed with nothing routed to it.
        if (parts[1] === 'projects' && parts[2]
            && (parts[3] === 'script' || parts[3] === 'scripts' || parts[3] === 'outline')) {
            return await handleScripts(req, res, parts, query);
        }

        // Route: /film/projects/:id/scenes
        // Route: /film/agent — is an agent host attached, and what would it
        // replace? Above everything, because it takes no project id and would
        // otherwise fall through to a project lookup.
        if (parts[1] === 'agent' && !parts[2]) {
            return handleAgentPresence(req, res, parts, query);
        }

        // Route: casting and auditioning. Above /characters/:id and
        // /scenes/:id, which would otherwise swallow the sub-paths — the trap
        // that has now bitten six times in this file.
        if (parts[1] === 'voices'
            || (parts[1] === 'characters' && parts[2] && parts[3] === 'voice')
            || (parts[1] === 'projects' && parts[2] && parts[3] === 'casting')
            || parts[1] === 'audition'
            || (parts[1] === 'scenes' && parts[2] && parts[3] === 'table-read')
            || (parts[1] === 'auditions' && parts[2] && parts[3])) {
            return await handleVoiceCasting(req, res, parts, query);
        }

        // Route: the subject workspace — gallery, explore, inspiration, promote.
        // ABOVE the generic /characters/:id and /locations/:id handlers, which
        // would otherwise swallow the sub-paths. That trap has now bitten five
        // times in this file.
        if (['characters', 'locations', 'props'].includes(parts[1]) && parts[2]
            && ['gallery', 'explore', 'inspiration', 'palette'].includes(parts[3])) {
            return await handleSubjectGallery(req, res, parts, query);
        }
        if (parts[1] === 'gallery' && parts[2]) {
            return await handleSubjectGallery(req, res, parts, query);
        }

        // Route: the writing tools — treatment, analysis, timing.
        // Above the generic project routes for the same reason beats is: a
        // /projects/:id matcher below would swallow them.
        if (parts[1] === 'projects' && parts[2]
            && (parts[3] === 'treatment' || parts[3] === 'analysis' || parts[3] === 'timing')) {
            return handleStoryDevelopment(req, res, parts, query);
        }
        if (parts[1] === 'analysis' && parts[2]) {
            return handleStoryDevelopment(req, res, parts, query);
        }

        // Route: /film/projects/:id/beats and /film/projects/:id/directives.
        // Above the generic project routes, or they swallow it — the trap that
        // has now bitten four times in this codebase.
        if (parts[1] === 'projects' && parts[2] && (parts[3] === 'beats' || parts[3] === 'directives')) {
            return handleStoryStructure(req, res, parts, query);
        }

        // Route: /film/beats/:id
        if (parts[1] === 'beats' && parts[2]) {
            return handleStoryStructure(req, res, parts, query);
        }

        if (parts[1] === 'projects' && parts[2] && parts[3] === 'scenes') {
            return await handleScenes(req, res, parts, query);
        }

        /*
         * Route: /film/shots/:id/preview/:capability — free, and it must be
         * matched BEFORE the general /film/shots/:id router, which would
         * otherwise read `preview` as an unknown sub-path.
         */
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'preview') {
            return await handleShots(req, res, parts, query);
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

        // Route: /film/projects/:id/flows  and  /film/flows/:id[/validate]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'flows') {
            return handleFlows(req, res, parts, query);
        }
        if (parts[1] === 'flows' && parts[2]) {
            return handleFlows(req, res, parts, query);
        }
        if (parts[1] === 'flow-runs' && parts[2]) {
            return handleFlows(req, res, parts, query);
        }
        if (parts[1] === 'flow-templates') {
            return handleFlows(req, res, parts, query);
        }

        // Route: /film/shots/:id/previs[/solve]  and  /film/previs/taxonomy
        // /motion rides with previs because previs owns the blocking it reads.
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'motion') {
            return handlePrevis(req, res, ['film', 'shots', parts[2], 'previs', 'motion'], query);
        }
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'previs') {
            return handlePrevis(req, res, parts, query);
        }
        if (parts[1] === 'previs' || parts[1] === 'nav-flow') {
            return handlePrevis(req, res, parts, query);
        }

        // ==== CODEX:START ops-compliance-routes ====
        // Route: /film/projects/:id/jobs[/summary]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'jobs') {
            return handleJobs(req, res, parts, query);
        }

        // Route: /film/projects/:id/rights
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'rights') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/rights/:id
        if (parts[1] === 'rights' && parts[2]) {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/projects/:id/provenance[/export]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'provenance') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/assets/:id/provenance
        if (parts[1] === 'assets' && parts[2] && parts[3] === 'provenance') {
            return handleAssets(req, res, parts, query);
        }
        // ==== CODEX:END ====

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

        // Route: /film/projects/:id/spend[/usage|/backfill] — what AI actually cost
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'spend') {
            return handleBudget(req, res, parts, query);
        }

        // Route: /film/projects/:id/backups
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'backups') {
            return handleBackups(req, res, parts, query);
        }

        /*
         * Route: /film/projects/:id/dry-run
         *
         * Registered with the other dashboard sub-routes. A sub-path that is
         * not dispatched here falls through to the project route, which
         * happily returns the PROJECT — a 200 with the wrong body, which reads
         * as a working endpoint returning nonsense rather than as a missing one.
         */
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'dry-run') {
            return handleDashboard(req, res, parts, query);
        }

        // Route: /film/projects/:id/dashboard
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'home') {
            return handleDashboard(req, res, parts, query);
        }

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

        /*
         * World Engine — registered BEFORE the project and shot catch-alls.
         *
         * A handler that exists and is never reached looks exactly like a
         * missing feature: the /film/locations/:id trap that already cost once.
         */
        if (parts[1] === 'worlds' || parts[1] === 'world-versions'
            || (parts[1] === 'projects' && parts[3] === 'worlds')
            // The tails come from the route module itself, so one added there
            // is reachable here with nothing to remember.
            || (parts[1] === 'shots' && WORLD_SHOT_TAILS.includes(parts[3]))) {
            return await handleWorlds(req, res, parts, query);
        }

        // Route: /film/shots/:id/{approval-envelope,take-candidates} — decision
        // packets. Both FREE: a packet that spent money to produce itself could
        // not be raised speculatively, which is the only way it gets used.
        if (parts[1] === 'shots' && parts[2]
            && (parts[3] === 'approval-envelope' || parts[3] === 'take-candidates')) {
            return await handleApprovals(req, res, parts, query);
        }

        // Route: /film/projects/:id/models[/batch[/stream]] — 3D asset generation
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'models') {
            return await handleThreeD(req, res, parts, query);
        }

        // Route: /film/projects/:id/providers — per-project provider selection
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'providers') {
            return handleProviders(req, res, parts, query);
        }

        // Route: /film/providers[/:provider/credentials] — provider catalog + credentials
        if (parts[1] === 'providers') {
            return handleProviders(req, res, parts, query);
        }

        // Route: /film/projects/:id/consistency[/profiles|/audit] — consistency profiles
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'consistency') {
            return handleConsistency(req, res, parts, query);
        }

        // Route: /film/consistency/... and /film/shots/:id/consistency/audit
        if (parts[1] === 'consistency') {
            return handleConsistency(req, res, parts, query);
        }
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'consistency') {
            return handleConsistency(req, res, parts, query);
        }

        // Route: /film/projects/demo — create demo project
        if (parts[1] === 'projects' && parts[2] === 'demo') {
            return handleDemoProject(req, res);
        }

        // Route: /film/projects/:id/settings/preset
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'settings' && parts[4] === 'preset') {
            return handleProjectSettingsPreset(req, res, parts);
        }

        // ==== CLAUDE:START editorial routes (gaps 3/4/5/7d) ====
        // MUST stay above the /film/projects and /film/shots catch-alls below —
        // those match on parts[1] alone and would swallow these sub-paths.
        // None of these collide with an existing route.

        // Gap 3: /film/projects/:id/timeline[/notes]
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'timeline') {
            return handleTimeline(req, res, parts, query);
        }

        // Gap 5: /film/projects/:id/selects
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'selects') {
            return handleTakes(req, res, parts, query);
        }

        // Gap 5: /film/shots/:id/takes
        if (parts[1] === 'shots' && parts[2] && parts[3] === 'takes') {
            return handleTakes(req, res, parts, query);
        }

        // Gap 5: /film/versions/:id/select
        if (parts[1] === 'versions' && parts[2] && parts[3] === 'select') {
            return handleTakes(req, res, parts, query);
        }

        // Gap 7d: /film/shots/:id/prompt-history, /film/shots/:id/prompt-diff
        if (parts[1] === 'shots' && parts[2] &&
            (parts[3] === 'prompt-history' || parts[3] === 'prompt-diff')) {
            return handleRenderLedger(req, res, parts, query);
        }
        // ==== CLAUDE:END ====

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

        // Route: /film/3d/:projectId/:filename — serve 3D model files
        if (parts[1] === '3d' && parts[2] && parts[3]) {
            return await handleThreeD(req, res, parts, query);
        }

        // Route: /film/models/:assetId/{rig|retexture|animate|animations} and /film/models/job/:jobId
        if (parts[1] === 'models' && parts[2]) {
            return await handleThreeD(req, res, parts, query);
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

        // Route: /film/spend/rates — the published rate book, and corrections
        if (parts[1] === 'spend') {
            return handleBudget(req, res, parts, query);
        }

        // Route: /film/music-cues/:id/rights
        /*
         * Route: /film/music-cues/:id — change or remove a cue.
         *
         * routes/assets.js has dispatched PUT and DELETE here since the update
         * route was written, and the server only ever forwarded `/rights` — so
         * `music_cue_update` and `music_cue_delete` were listed, described,
         * schema'd, and answered 404 on every call. A handler nothing routes to
         * looks identical to a working one until someone presses it.
         */
        if (parts[1] === 'music-cues' && parts[2] && !parts[3]) {
            return handleAssets(req, res, parts, query);
        }
        // /film/music-cues/:id/generate — generate the cue that was written.
        // Registered beside the other music-cue verbs; handled by music-gen.js
        // because that is where the payload builders and the persistence live.
        if (parts[1] === 'music-cues' && parts[2] && parts[3] === 'generate') {
            return await handleMusicGen(req, res, parts, query);
        }
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

        // Route: /film/characters/:id/model[/generate|from-image[/stream]] — 3D generation
        if (parts[1] === 'characters' && parts[2] && parts[3] === 'model') {
            return await handleThreeD(req, res, parts, query);
        }

        // Route: /film/characters/:id[/voice|/costumes]
        if (parts[1] === 'characters') {
            return handleCharacters(req, res, parts, query);
        }

        // Route: /film/locations/:id/cost
        if (parts[1] === 'locations' && parts[2] && parts[3] === 'cost') {
            return handleBudgetEstimate(req, res, parts, query);
        }

        // Route: /film/locations/:id/model[/generate|from-image[/stream]] — 3D
        // A location mesh is a previs STAGE. Must come before the generic
        // locations route below, which would otherwise swallow it — the same
        // trap the frames route fell into, where a handler existed and nothing
        // ever reached it.
        if (parts[1] === 'locations' && parts[2] && parts[3] === 'model') {
            return await handleThreeD(req, res, parts, query);
        }

        // Route: /film/locations/:id
        if (parts[1] === 'locations') {
            return handleLocations(req, res, parts, query);
        }

        // Route: /film/props/:id/model[/generate|from-image[/stream]] — 3D generation
        if (parts[1] === 'props' && parts[2] && parts[3] === 'model') {
            return await handleThreeD(req, res, parts, query);
        }

        // Route: /film/props/:id
        // The registries the location and prop sheets are built from.
        if (parts[1] === 'sheet-spec') {
            return handleLocations(req, res, parts, query);
        }
        if (parts[1] === 'props') {
            return handleLocations(req, res, parts, query);
        }

        // Route: /film/assets/:id
        if (parts[1] === 'assets') {
            return handleAssets(req, res, parts, query);
        }

        // Route: /film/scripts/:id/comments
        if (parts[1] === 'scripts' && parts[2] && parts[3] === 'tag') {
            return handleComments(req, res, parts, query);
        }

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
            if (sub === 'storyboard') {
                return await handleStoryboard(req, res, parts, query);
            }
            if (sub === 'prompt') {
                return await handleStoryboard(req, res, parts, query);
            }
            // Every attempt at this shot's keyframe, and putting one back.
            if (sub === 'frames') {
                return await handleStoryboard(req, res, parts, query);
            }
            if (sub === 'order' || sub === 'transition') {
                return await handleShots(req, res, parts, query);
            }
        }

        // Route: /film/events — an SSE stream that fires when another process
        // (the MCP server) has written to the database.
        if (parts[1] === 'events' && !parts[2]) {
            return handleEvents(req, res);
        }

        // Route: /film/settings — who is using the app, not what they are making.
        if (parts[1] === 'settings' && !parts[2]) {
            return handleAppSettings(req, res);
        }

        // Route: /film/card-vocabulary — the lists a scene card may draw on.
        if (parts[1] === 'card-vocabulary') {
            return await handleShots(req, res, parts, query);
        }

        // Route: /film/shots (create shots from scene cards)
        if (parts[1] === 'shots') {
            return await handleShots(req, res, parts, query);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
        console.error('Request error:', err);
        // If a handler already flushed headers (e.g. an SSE stream) we cannot
        // send a 500 status — writeHead would throw ERR_HTTP_HEADERS_SENT and
        // leave the socket hung open. Just close the response instead.
        if (res.headersSent || res.writableEnded) {
            if (!res.writableEnded) {
                try { res.end(); } catch (_) { /* socket already gone */ }
            }
            return;
        }
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

    // The built-in flow is derived from PIPELINE_STEPS, so re-seeding on every
    // boot is how a newly added pipeline step reaches the canvas without a
    // migration. Idempotent.
    try {
        const { db } = require('./db/database');
        const { seedBuiltinFlows } = require('./lib/flow-seed');
        const seeded = seedBuiltinFlows(db);
        console.log(`  Built-in flow ${seeded.created ? 'created' : 'refreshed'}: ${seeded.nodes} nodes, ${seeded.edges} edges`);
    } catch (err) {
        console.error('Failed to seed built-in flows:', err.message);
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
