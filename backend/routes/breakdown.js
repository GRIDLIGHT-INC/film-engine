/**
 * FILM-009: AI Screenplay Breakdown Assistant
 * POST /film/projects/:id/breakdown — full AI breakdown via /chat/intelligent
 * POST /film/projects/:id/breakdown/stream — SSE streaming version
 *
 * Sends screenplay through the selected LLM provider
 * to auto-generate scene cards with camera, lighting, character,
 * and dialogue suggestions. Optionally auto-saves shots to DB.
 */
const { db, generateId } = require('../db/database');
const { stampShot } = require('../lib/screenplay-drift');
const { validateSceneCards } = require('../lib/scene-card-schema');
const { resolveCardSubjects } = require('../lib/shot-references');
const { parseFountain, ELEMENT_TYPES } = require('../lib/fountain-parser');
const { callProjectLLM, streamProjectLLM } = require('../lib/llm-client');
const { fallbackNotice } = require('../lib/agent-presence');

/**
 * What replaces this over MCP. See screenplay-ai.js for the reasoning.
 *
 * `breakdown_run` was added as an MCP tool once and came straight back out,
 * taking `entities_describe` with it: both wrapped a route that calls a
 * server-side LLM, which is the mistake this file's declaration exists to stop
 * being made a third time. The replacements are plain data tools, and they are
 * strictly better — a model composing a scene card has the whole revision in
 * context rather than one scene of it.
 */
const MCP_ALTERNATIVE = [
    {
        route: 'POST /film/projects/:id/breakdown',
        does: 'derive scenes and shot cards from the screenplay',
        mcp_alternative: 'script_get + card_vocabulary + shot_create (or shot_tag)',
        why: 'composing a card is reasoning, and the agent host IS the model',
    },
    {
        route: 'POST /film/projects/:id/entities/describe',
        does: 'write appearance/description/visual_prompt from the screenplay',
        mcp_alternative: 'script_get + character_update / location_update / prop_update',
        why: 'the connected model reads the screenplay and writes better descriptions from all of it',
    },
];


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Project-aware prompt with scene card schema enforcement
const BREAKDOWN_SYSTEM_PROMPT = `You are a professional film director, cinematographer, and script supervisor. You break down screenplays into precise shot-by-shot scene cards for an AI film production pipeline.

RULES:
1. Return ONLY a valid JSON array. No markdown fences, no commentary.
2. Each shot must be a complete, self-contained visual description.
3. Match dialogue exactly from the script — never invent lines.
4. Assign sequential shot codes per scene (e.g. "1A", "1B", "1C").
5. Duration should be realistic: dialogue shots 3-6s, action 2-4s, establishing 3-5s.
6. Choose camera/lighting from the allowed values listed below.

ALLOWED camera.shot_type: wide, medium, close-up, extreme-close-up, over-the-shoulder, two-shot, establishing, aerial, low-angle, high-angle, dutch-angle, pov, tracking, dolly, steadicam, handheld, crane, insert

ALLOWED camera.movement: static, pan-left, pan-right, tilt-up, tilt-down, dolly-in, dolly-out, zoom-in, zoom-out, tracking-left, tracking-right, tracking-forward, tracking-back, crane-up, crane-down, orbit, push-in, pull-out

ALLOWED lighting.type: natural, golden-hour, blue-hour, overcast, night, studio, high-key, low-key, silhouette, rim-light, practical, neon, candlelight, moonlight, fluorescent, dramatic, soft, hard

JSON SCHEMA per shot:
{
  "shot_code": "1A",
  "description": "visual description of the shot",
  "environment_motion": "what the WORLD does during this shot: only things that MOVE and are not the characters -- rain falling, a door swinging shut, flames, traffic, smoke, debris, a curtain lifting. Take it from the screenplay's own action lines. OMIT THE KEY ENTIRELY if nothing in the environment moves, which is most shots. This is NOT a description of the place: the storyboard frame already shows what the place looks like, and repeating it here wastes the video prompt.",
  "camera": {
    "shot_type": "medium",
    "movement": "static",
    "lens": "35mm"
  },
  "lighting": {
    "type": "natural",
    "notes": "warm afternoon light through window"
  },
  "characters": [
    { "name": "CHARACTER_NAME", "position": "frame-left", "action": "walks toward door", "emotion": "determined" }
  ],
  "dialogue": [
    { "character": "CHARACTER_NAME", "line": "exact dialogue from script", "emotion": "neutral" }
  ],
  "duration_ms": 4000,
  "generation_mode": "creative"
}`;

const SCENE_BREAKDOWN_PROMPT = `Break down this scene into shots. Return a JSON array of scene cards.\n\nSCENE:\n`;

const MULTI_SCENE_PROMPT = `Break down each scene below into shots. Return a JSON object where keys are scene numbers (as strings) and values are arrays of scene cards for that scene.\n\nSCENES:\n`;

function handleBreakdown(req, res, urlParts) {
    const projectId = urlParts[2];

    if (!UUID_RE.test(projectId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const sub = urlParts[4]; // 'stream' for SSE mode

    // POST /film/projects/:id/entities/describe
    if (urlParts[3] === 'entities' && sub === 'describe') {
        return describeEntities(req, res, projectId);
    }

    if (sub === 'stream') {
        return breakdownStream(req, res, projectId);
    }

    return breakdownSync(req, res, projectId);
}

/**
 * Describe the entities a screenplay introduced.
 *
 * The breakdown has always READ appearance_prompt to enrich its scene cards
 * and never written one, so entities arrived at generation as bare names.
 * buildStoryboardPrompt then looked a character up, found nothing to inject,
 * and every keyframe invented its own person — which is how one production got
 * a different dragon in each of eight frames while the location, which did have
 * a description, stayed rock solid across all of them.
 *
 * A separate pass rather than more fields on the scene-card call: card parsing
 * is load-bearing and adding entity output to it would put both behind one
 * fragile response. This one is also re-runnable, which matters because
 * entities keep appearing as a script is revised.
 *
 * Only fills what is EMPTY. A description someone wrote by hand is a decision,
 * and silently improving it is how a production loses the look it chose.
 */
const DESCRIBE_SYSTEM_PROMPT = `You are a film production designer. For each entity below, write a short visual description usable directly as an image-generation prompt.

RULES:
- Describe only what a camera would see: age, build, hair, wardrobe, materials, period, wear, colour.
- No story, no personality, no camera directions, no lighting direction.
- 25-45 words each. Concrete nouns over adjectives.
- Stay consistent with the screenplay. Invent only what it leaves unsaid.
- Reply with STRICT JSON only, no prose, no code fences:
  {"entities":[{"name":"<exact name given>","kind":"character|location|prop","description":"..."}]}`;

async function describeEntities(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Project not found' }));
    }

    const force = !!(req.body && req.body.force);
    const blank = v => !String(v || '').trim();

    const characters = db.prepare('SELECT id, name, appearance_prompt FROM film_characters WHERE project_id = ?')
        .all(projectId).filter(c => force || blank(c.appearance_prompt));
    const locations = db.prepare('SELECT id, name, description FROM film_locations WHERE project_id = ?')
        .all(projectId).filter(l => force || blank(l.description));
    const props = db.prepare('SELECT id, name, visual_prompt FROM film_props WHERE project_id = ?')
        .all(projectId).filter(p => force || blank(p.visual_prompt));

    const targets = [
        ...characters.map(c => ({ kind: 'character', id: c.id, name: c.name })),
        ...locations.map(l => ({ kind: 'location', id: l.id, name: l.name })),
        ...props.map(p => ({ kind: 'prop', id: p.id, name: p.name })),
    ];

    if (!targets.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ project_id: projectId, described: [], message: 'Every entity already has a description.' }));
    }

    const script = db.prepare('SELECT fountain_content, content FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
    const screenplay = String((script && (script.fountain_content || script.content)) || '').slice(0, 12000);

    const styleNote = project.style_preset
        ? `\n\nThe production's look is: ${project.style_preset}. Do NOT restate it in each description — it is applied separately. Describe only the subject itself.`
        : '';

    const question = DESCRIBE_SYSTEM_PROMPT + styleNote
        + '\n\nSCREENPLAY:\n' + screenplay
        + '\n\nENTITIES TO DESCRIBE:\n'
        + targets.map(t => `- ${t.name} (${t.kind})`).join('\n');

    const aiResult = await callProjectLLM(project, { question, stream: false });
    if (!aiResult.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'AI service error', details: aiResult.error, provider: aiResult.provider,
            ai_path: fallbackNotice(MCP_ALTERNATIVE[0].mcp_alternative) }));
    }

    let parsed;
    try {
        const raw = String(aiResult.answer || '');
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        parsed = JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw);
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Could not parse entity descriptions', raw: String(aiResult.answer || '').slice(0, 400) }));
    }

    const byName = new Map(targets.map(t => [t.name.toUpperCase(), t]));
    const update = {
        character: db.prepare('UPDATE film_characters SET appearance_prompt = ? WHERE id = ?'),
        location: db.prepare('UPDATE film_locations SET description = ? WHERE id = ?'),
        prop: db.prepare('UPDATE film_props SET visual_prompt = ? WHERE id = ?'),
    };

    const described = [];
    const tx = db.transaction(() => {
        for (const e of (parsed.entities || [])) {
            const target = byName.get(String(e.name || '').toUpperCase());
            const text = String(e.description || '').trim();
            if (!target || !text) continue;
            update[target.kind].run(text, target.id);
            described.push({ kind: target.kind, name: target.name, description: text });
        }
    });
    tx();

    const missed = targets.filter(t => !described.some(d => d.name === t.name)).map(t => t.name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        project_id: projectId,
        described,
        described_count: described.length,
        // Named rather than swallowed: an entity that stays blank generates a
        // bare name, and that must not look like success.
        still_blank: missed,
        provider: aiResult.provider,
            ai_path: fallbackNotice(MCP_ALTERNATIVE[0].mcp_alternative),
    }));
}

async function breakdownSync(req, res, projectId) {
    const body = req.body;
    const autoSave = body.auto_save === true;
    const multiScene = body.multi_scene === true;

    // Gather scene text
    const { sceneTexts, sceneIds, error } = gatherSceneText(projectId, body);
    if (error) {
        res.writeHead(error.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        return;
    }

    // Build prompt based on single vs multi-scene
    let prompt;
    if (multiScene && sceneTexts.length > 1) {
        prompt = MULTI_SCENE_PROMPT + sceneTexts.join('\n---\n');
    } else {
        prompt = SCENE_BREAKDOWN_PROMPT + sceneTexts[0];
    }

    // Gather project context for style hints
    const project = db.prepare('SELECT title, genre, style_preset, provider_config FROM film_projects WHERE id = ?').get(projectId);
    let contextHint = '';
    if (project) {
        const hints = [];
        if (project.genre) hints.push(`Genre: ${project.genre}`);
        if (project.style_preset) hints.push(`Visual style: ${project.style_preset}`);
        if (hints.length) contextHint = `\n\nPROJECT CONTEXT: ${hints.join('. ')}.\n`;
    }

    try {
        const fullQuestion = BREAKDOWN_SYSTEM_PROMPT + contextHint + '\n\n---\n\nPlease break down the following screenplay:\n\n' + prompt + contextHint;

        const aiResult = await callProjectLLM(project, { question: fullQuestion, stream: false });

        if (!aiResult.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'AI service error',
                details: aiResult.error,
                provider: aiResult.provider,
            ai_path: fallbackNotice(MCP_ALTERNATIVE[0].mcp_alternative),
                hint: 'Check the selected LLM provider in Settings and make sure its credentials/service are available.'
            }));
            return;
        }

        const responseText = aiResult.answer || '';

        // Parse AI response
        let result;
        if (multiScene && sceneTexts.length > 1) {
            result = parseMultiSceneResponse(responseText, sceneIds);
        } else {
            result = parseSingleSceneResponse(responseText, sceneIds[0]);
        }

        if (result.parse_error) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                raw_response: responseText,
                parse_error: result.parse_error,
                cards: [],
                scene_id: sceneIds[0] || null
            }));
            return;
        }

        // Auto-save if requested
        if (autoSave) {
            const saveResults = autoSaveShots(result.scenes || [{ scene_id: sceneIds[0], cards: result.cards }]);
            result.saved = saveResults;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));

    } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'AI gateway unavailable',
            details: err.message,
            hint: 'Check the selected LLM provider in Settings and make sure its credentials/service are available.'
        }));
    }
}

async function breakdownStream(req, res, projectId) {
    const body = req.body;

    const { sceneTexts, sceneIds, error } = gatherSceneText(projectId, body);
    if (error) {
        res.writeHead(error.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        return;
    }

    const prompt = SCENE_BREAKDOWN_PROMPT + sceneTexts[0];

    const project = db.prepare('SELECT title, genre, style_preset, provider_config FROM film_projects WHERE id = ?').get(projectId);
    let contextHint = '';
    if (project) {
        const hints = [];
        if (project.genre) hints.push(`Genre: ${project.genre}`);
        if (project.style_preset) hints.push(`Visual style: ${project.style_preset}`);
        if (hints.length) contextHint = `\n\nPROJECT CONTEXT: ${hints.join('. ')}.\n`;
    }

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('status', { phase: 'sending', message: 'Sending screenplay to AI...' });

    try {
        const fullQuestion = BREAKDOWN_SYSTEM_PROMPT + contextHint + '\n\n---\n\nPlease break down the following screenplay:\n\n' + prompt + contextHint;

        sendEvent('status', { phase: 'generating', message: 'AI is generating scene cards...' });

        let accumulated = '';
        let parsedSent = false;
        const parseAndSend = (answer) => {
            if (parsedSent) return;
            parsedSent = true;
            sendEvent('status', { phase: 'parsing', message: 'Parsing AI response...' });
            const parsed = parseSingleSceneResponse(answer || accumulated, sceneIds[0]);
            if (parsed.parse_error) {
                sendEvent('error', { message: parsed.parse_error, raw: (answer || accumulated).slice(0, 500) });
            } else {
                if (body.auto_save === true) {
                    const saveResults = autoSaveShots([{ scene_id: sceneIds[0], cards: parsed.cards }]);
                    sendEvent('saved', saveResults[0] || {});
                }
                sendEvent('result', parsed);
            }
        };

        if (clientGone) return;
        const result = await streamProjectLLM(project, { question: fullQuestion, stream: true }, res, {
            onToken: (text) => {
                accumulated += text;
                sendEvent('chunk', { text });
            },
            onComplete: (data) => parseAndSend(data.answer || accumulated),
            onError: (data) => sendEvent('error', { message: data.error || 'AI service returned error' }),
        });
        // Nobody is listening: do not parse or auto-save shots for a request
        // the browser abandoned.
        if (clientGone) return;
        if (!result.ok && !result.aborted) sendEvent('error', { message: result.error || 'AI service returned error' });
        if (result.ok && !parsedSent) parseAndSend(result.finalData && result.finalData.answer);

        sendEvent('done', { message: 'Breakdown complete' });
        res.end();

    } catch (err) {
        sendEvent('error', { message: 'AI gateway unavailable', details: err.message });
        res.end();
    }
}

// --- Helpers ---

/**
 * FILM-123: Get Fountain AST for a project's screenplay
 * Returns parsed elements grouped by scene, or null if no Fountain script exists
 */
function getFountainSceneElements(projectId) {
    const script = db.prepare(`
        SELECT fountain_content, format
        FROM film_scripts
        WHERE project_id = ?
        ORDER BY version DESC
        LIMIT 1
    `).get(projectId);

    if (!script || script.format !== 'fountain' || !script.fountain_content) {
        return null;
    }

    const parsed = parseFountain(script.fountain_content);
    if (!parsed || !parsed.elements || parsed.elements.length === 0) {
        return null;
    }

    // Group elements by scene
    const scenes = [];
    let currentScene = null;
    let currentElements = [];

    for (const el of parsed.elements) {
        if (el.type === ELEMENT_TYPES.SCENE_HEADING) {
            if (currentScene) {
                scenes.push({ heading: currentScene, elements: currentElements });
            }
            currentScene = el;
            currentElements = [];
        } else if (currentScene) {
            currentElements.push(el);
        }
    }

    // Push final scene
    if (currentScene) {
        scenes.push({ heading: currentScene, elements: currentElements });
    }

    return scenes;
}

/**
 * FILM-123: Get character and location context for enhanced prompts
 */
function getEntityContext(projectId) {
    const characters = db.prepare(`
        SELECT name, appearance_prompt, personality_notes, age_range, build, distinguishing
        FROM film_characters
        WHERE project_id = ?
    `).all(projectId);

    const locations = db.prepare(`
        SELECT name, description, reference_prompt, lighting_default, atmosphere_notes
        FROM film_locations
        WHERE project_id = ?
    `).all(projectId);

    return { characters, locations };
}

/**
 * FILM-123: Format scene using Fountain elements with explicit labels
 */
function formatFountainScene(sceneData, entityContext) {
    const { heading, elements } = sceneData;
    const lines = [];

    // Scene heading with explicit label
    lines.push(`SCENE HEADING: ${heading.text}`);

    // Add location context if available
    if (heading.meta && heading.meta.location && entityContext.locations) {
        const locMatch = entityContext.locations.find(
            l => l.name.toUpperCase() === heading.meta.location.toUpperCase()
        );
        if (locMatch) {
            lines.push('');
            lines.push('LOCATION CONTEXT:');
            if (locMatch.description) lines.push(`  Description: ${locMatch.description.slice(0, 300)}`);
            if (locMatch.reference_prompt) lines.push(`  Visual: ${locMatch.reference_prompt.slice(0, 200)}`);
            if (locMatch.lighting_default) lines.push(`  Default Lighting: ${locMatch.lighting_default}`);
            if (locMatch.atmosphere_notes) lines.push(`  Atmosphere: ${locMatch.atmosphere_notes.slice(0, 200)}`);
        }
    }

    lines.push('');

    // Track characters mentioned for context
    const charactersInScene = new Set();

    // Process elements with labels
    for (const el of elements) {
        switch (el.type) {
            case ELEMENT_TYPES.ACTION:
                lines.push(`ACTION: ${el.text}`);
                break;

            case ELEMENT_TYPES.CHARACTER:
                charactersInScene.add(el.text.toUpperCase());
                let charLine = `CHARACTER: ${el.text}`;
                if (el.meta && el.meta.extension) {
                    charLine += ` (${el.meta.extension})`;
                }
                lines.push(charLine);
                break;

            case ELEMENT_TYPES.DIALOGUE:
                lines.push(`DIALOGUE: ${el.text}`);
                break;

            case ELEMENT_TYPES.PARENTHETICAL:
                lines.push(`PARENTHETICAL: (${el.text})`);
                break;

            case ELEMENT_TYPES.TRANSITION:
                lines.push(`TRANSITION: ${el.text}`);
                break;

            // Skip non-visual elements
            case ELEMENT_TYPES.NOTE:
            case ELEMENT_TYPES.BONEYARD:
            case ELEMENT_TYPES.SECTION:
            case ELEMENT_TYPES.SYNOPSIS:
                break;

            default:
                if (el.text) lines.push(el.text);
        }
    }

    // Add character context for characters in this scene
    if (charactersInScene.size > 0 && entityContext.characters) {
        const relevantChars = entityContext.characters.filter(
            c => charactersInScene.has(c.name.toUpperCase())
        );

        if (relevantChars.length > 0) {
            lines.push('');
            lines.push('CHARACTER APPEARANCES:');
            for (const c of relevantChars) {
                let desc = `  ${c.name}:`;
                if (c.appearance_prompt) desc += ` ${c.appearance_prompt.slice(0, 150)}`;
                if (c.age_range) desc += ` Age: ${c.age_range}.`;
                if (c.build) desc += ` Build: ${c.build}.`;
                if (c.distinguishing) desc += ` Notable: ${c.distinguishing.slice(0, 100)}.`;
                lines.push(desc);
            }
        }
    }

    return lines.join('\n');
}

function gatherSceneText(projectId, body) {
    const sceneTexts = [];
    const sceneIds = [];

    // FILM-123: Get Fountain elements and entity context for enhanced prompts
    const fountainScenes = getFountainSceneElements(projectId);
    const entityContext = getEntityContext(projectId);

    if (body.scene_id && UUID_RE.test(body.scene_id)) {
        // Single scene breakdown
        const row = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(body.scene_id);
        if (!row) return { error: { status: 404, message: 'Scene not found' } };
        sceneIds.push(row.id);

        // Try to find matching Fountain scene
        if (fountainScenes) {
            const fountainScene = fountainScenes.find(fs => {
                const loc = fs.heading.meta?.location?.toUpperCase();
                return loc && loc === (row.location || '').toUpperCase();
            });
            if (fountainScene) {
                sceneTexts.push(formatFountainScene(fountainScene, entityContext));
            } else {
                sceneTexts.push(formatSceneText(row, entityContext));
            }
        } else {
            sceneTexts.push(formatSceneText(row, entityContext));
        }

    } else if (body.scene_ids && Array.isArray(body.scene_ids)) {
        // Multi-scene breakdown
        for (const sid of body.scene_ids) {
            if (!UUID_RE.test(sid)) continue;
            const row = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sid);
            if (row) {
                sceneIds.push(row.id);

                // Try to find matching Fountain scene
                if (fountainScenes) {
                    const fountainScene = fountainScenes.find(fs => {
                        const loc = fs.heading.meta?.location?.toUpperCase();
                        return loc && loc === (row.location || '').toUpperCase();
                    });
                    if (fountainScene) {
                        sceneTexts.push(formatFountainScene(fountainScene, entityContext));
                    } else {
                        sceneTexts.push(formatSceneText(row, entityContext));
                    }
                } else {
                    sceneTexts.push(formatSceneText(row, entityContext));
                }
            }
        }
        if (sceneTexts.length === 0) return { error: { status: 404, message: 'No valid scenes found' } };

    } else if (body.all_scenes === true) {
        // Break down all scenes for the project
        const rows = db.prepare(
            "SELECT * FROM film_scenes WHERE project_id = ? AND status = 'written' ORDER BY scene_number"
        ).all(projectId);
        if (rows.length === 0) return { error: { status: 400, message: 'No scenes in "written" status to break down.' } };

        for (const row of rows) {
            sceneIds.push(row.id);

            // Try to find matching Fountain scene by scene number
            if (fountainScenes && row.scene_number) {
                const fountainScene = fountainScenes.find(fs =>
                    fs.heading.scene_number === String(row.scene_number)
                );
                if (fountainScene) {
                    sceneTexts.push(formatFountainScene(fountainScene, entityContext));
                } else {
                    sceneTexts.push(formatSceneText(row, entityContext));
                }
            } else {
                sceneTexts.push(formatSceneText(row, entityContext));
            }
        }

    } else {
        // Fallback: use latest script - try Fountain first
        if (fountainScenes && fountainScenes.length > 0) {
            // Format all Fountain scenes
            for (const fs of fountainScenes.slice(0, 10)) { // Limit to 10 scenes
                sceneTexts.push(formatFountainScene(fs, entityContext));
            }
            sceneIds.push(null);
        } else {
            const row = db.prepare(
                'SELECT content FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
            ).get(projectId);
            if (!row) return { error: { status: 400, message: 'No script uploaded. Upload a script first or provide scene_id.' } };
            sceneTexts.push(row.content.slice(0, 12000));
            sceneIds.push(null); // No specific scene
        }
    }

    return { sceneTexts, sceneIds };
}

function formatSceneText(scene, entityContext = {}) {
    let text = `SCENE HEADING: ${scene.int_ext || 'INT'}.  ${scene.location || 'UNKNOWN'} - ${scene.time_of_day || 'DAY'}`.trim();

    // FILM-123: Add location context from entity context
    if (scene.location && entityContext.locations) {
        const locMatch = entityContext.locations.find(
            l => l.name.toUpperCase() === scene.location.toUpperCase()
        );
        if (locMatch) {
            text += '\n\nLOCATION CONTEXT:';
            if (locMatch.description) text += `\n  Description: ${locMatch.description.slice(0, 300)}`;
            if (locMatch.reference_prompt) text += `\n  Visual: ${locMatch.reference_prompt.slice(0, 200)}`;
            if (locMatch.lighting_default) text += `\n  Default Lighting: ${locMatch.lighting_default}`;
            if (locMatch.atmosphere_notes) text += `\n  Atmosphere: ${locMatch.atmosphere_notes.slice(0, 200)}`;
        }
    }

    // Add character context from scene_characters
    const chars = db.prepare(`
        SELECT c.name, c.appearance_prompt, c.personality_notes, c.age_range, c.build, c.distinguishing
        FROM film_scene_characters sc
        JOIN film_characters c ON sc.character_id = c.id
        WHERE sc.scene_id = ?
    `).all(scene.id);

    if (chars.length > 0) {
        text += '\n\nCHARACTER APPEARANCES:';
        for (const c of chars) {
            let charDesc = `\n  ${c.name}:`;
            if (c.appearance_prompt) charDesc += ` ${c.appearance_prompt.slice(0, 150)}`;
            if (c.age_range) charDesc += ` Age: ${c.age_range}.`;
            if (c.build) charDesc += ` Build: ${c.build}.`;
            if (c.distinguishing) charDesc += ` Notable: ${c.distinguishing.slice(0, 100)}.`;
            text += charDesc;
        }
    }

    // Add scene description as ACTION
    if (scene.description) {
        text += `\n\nACTION: ${scene.description}`;
    }

    return text;
}

function parseSingleSceneResponse(responseText, sceneId) {
    try {
        // Strip markdown code fences if present
        let clean = responseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

        // Extract JSON array
        const jsonMatch = clean.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array found in AI response');

        const cards = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(cards)) throw new Error('Parsed result is not an array');

        // Normalize cards
        const normalized = cards.map(normalizeCard);

        return {
            cards: normalized,
            card_count: normalized.length,
            scene_id: sceneId
        };
    } catch (parseErr) {
        return {
            parse_error: parseErr.message,
            cards: [],
            scene_id: sceneId
        };
    }
}

function parseMultiSceneResponse(responseText, sceneIds) {
    try {
        let clean = responseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

        // Try to parse as object { "1": [...], "2": [...] }
        const objMatch = clean.match(/\{[\s\S]*\}/);
        if (objMatch) {
            const parsed = JSON.parse(objMatch[0]);
            const scenes = [];
            let totalCards = 0;

            for (const [key, cards] of Object.entries(parsed)) {
                if (!Array.isArray(cards)) continue;
                const sceneNum = parseInt(key);
                // Match scene ID by scene number order
                const sceneId = sceneIds[sceneNum - 1] || sceneIds[scenes.length] || null;
                const normalized = cards.map(normalizeCard);
                scenes.push({ scene_id: sceneId, scene_number: sceneNum, cards: normalized });
                totalCards += normalized.length;
            }

            return { scenes, total_cards: totalCards };
        }

        // Fallback: try as a flat array
        return parseSingleSceneResponse(responseText, sceneIds[0]);

    } catch (parseErr) {
        return { parse_error: parseErr.message, scenes: [] };
    }
}

function normalizeCard(card) {
    // Ensure required fields exist with defaults
    return {
        shot_code: card.shot_code || 'X',
        description: (card.description || '').slice(0, 2000),
        camera: {
            shot_type: card.camera?.shot_type || 'medium',
            movement: card.camera?.movement || 'static',
            lens: card.camera?.lens || '35mm'
        },
        lighting: {
            type: card.lighting?.type || card.lighting || 'natural',
            notes: card.lighting?.notes || ''
        },
        characters: Array.isArray(card.characters)
            ? card.characters.map(c => typeof c === 'string' ? { name: c } : c)
            : [],
        /*
         * PROPS WERE DROPPED HERE, and that was the whole bug.
         *
         * This normaliser rebuilds the card field by field, and `props` was
         * not one of the fields -- so whatever the model proposed was thrown
         * away before the card was ever written. Every shot from the breakdown
         * therefore reached generation with an EMPTY prop list, and the only
         * thing standing between a scene's objects and the picture was a
         * regex over the action line at request time.
         */
        props: Array.isArray(card.props)
            ? card.props.map(p => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean)
            : [],
        dialogue: Array.isArray(card.dialogue) ? card.dialogue : [],
        duration_ms: Math.max(1000, Math.min(15000, parseInt(card.duration_ms || card.duration_s * 1000) || 4000)),
        generation_mode: card.generation_mode || 'creative'
    };
}

function autoSaveShots(sceneGroups) {
    const results = [];

    const insertStmt = db.prepare(`
        INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `);
    const selectStmt = db.prepare('SELECT * FROM film_shots WHERE id = ?');

    for (const group of sceneGroups) {
        if (!group.scene_id || !group.cards || !Array.isArray(group.cards)) {
            results.push({ scene_id: group.scene_id, saved: 0, error: 'Missing scene_id or cards' });
            continue;
        }

        // Validate cards before saving
        const validation = validateSceneCards(group.cards);
        if (!validation.valid) {
            results.push({ scene_id: group.scene_id, saved: 0, errors: validation.errors });
            continue;
        }

        // Check for existing shots to avoid duplicates
        const existingCount = db.prepare('SELECT COUNT(*) AS count FROM film_shots WHERE scene_id = ?')
            .get(group.scene_id).count;
        if (existingCount > 0) {
            results.push({
                scene_id: group.scene_id,
                saved: 0,
                skipped: true,
                message: `Scene already has ${existingCount} shots. Delete them first or use scene_id to target a different scene.`
            });
            continue;
        }

        const saved = [];
        const now = new Date().toISOString();

        /*
         * WHO IS IN THIS SHOT IS DECIDED NOW, NOT AT GENERATION TIME.
         *
         * The subjects used to be worked out from the description on every
         * request, which made the cast of a frame a property of how a sentence
         * was phrased. Resolving once and writing it down puts the answer on
         * the card, where the director can see it and change it, and stops a
         * prose rewrite quietly removing a creature.
         *
         * `unresolved` is kept on the card rather than discarded: a name the
         * card asserts that matches nothing in the project is the failure that
         * produces a confident wrong frame, and it must be visible to the
         * audit rather than inferred from an absence.
         */
        const sceneRow = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(group.scene_id);
        const projectId = sceneRow && sceneRow.project_id;

        for (const card of group.cards) {
            const shotId = generateId();
            if (projectId) {
                try {
                    const resolved = resolveCardSubjects(db, projectId, card);
                    card.characters = resolved.characters.map(name => ({ name }));
                    card.props = resolved.props;
                    if (resolved.unresolved.length) card.unresolved_subjects = resolved.unresolved;
                } catch (_) { /* a project mid-migration still saves its shots */ }
            }
            const cardYaml = JSON.stringify(card, null, 2);
            insertStmt.run(shotId, group.scene_id, card.shot_code, cardYaml, card.duration_ms || 4000, now);
            // Which draft of the scene this card was written from. Without it a
            // later rewrite has nothing to compare against and the shot looks
            // current forever.
            stampShot(shotId, group.scene_id);
            saved.push(selectStmt.get(shotId));
        }

        // Advance scene status
        db.prepare("UPDATE film_scenes SET status = 'broken_down' WHERE id = ? AND status = 'written'")
            .run(group.scene_id);

        results.push({ scene_id: group.scene_id, saved: saved.length, shots: saved });
    }

    return results;
}

module.exports = { MCP_ALTERNATIVE, handleBreakdown };
