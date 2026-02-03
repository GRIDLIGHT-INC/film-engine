/**
 * FILM-112: AI Screenplay Assistant
 * POST /film/projects/:id/screenplay-ai — AI chat for screenplay writing
 *
 * Supports modes: brainstorm, write-scene, rewrite, convert
 * Gathers project context and calls Gridlight's /chat/intelligent endpoint.
 */
const { db } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// System prompts for different modes
const SYSTEM_PROMPTS = {
    brainstorm: `You are an experienced screenwriter and story consultant. Help the user develop their story, brainstorm ideas, create beat sheets, explore themes, and develop character arcs. Be creative and encouraging while offering practical screenplay advice.

PROJECT CONTEXT:
Title: {title}
Genre: {genre}
Logline: {logline}

Known Characters:
{characters}

Known Locations:
{locations}`,

    'write-scene': `You are a professional screenplay writer. Write scenes in proper Fountain screenplay format.

FOUNTAIN FORMAT RULES:
1. Scene headings: Start with INT. or EXT. followed by location and time (e.g., "INT. COFFEE SHOP - DAY")
2. Action: Present tense, visual descriptions. No blank lines between consecutive action paragraphs.
3. Character cues: Character names in ALL CAPS on their own line before dialogue
4. Dialogue: Immediately follows character name. Natural, character-appropriate speech.
5. Parentheticals: In (parentheses) between character name and dialogue for tone/direction
6. Transitions: Optional, like "CUT TO:" or "FADE OUT." at end of scenes

Write concise, visual, shootable scenes that match the project's tone and genre.

PROJECT CONTEXT:
Title: {title}
Genre: {genre}
Logline: {logline}

CHARACTERS:
{characters}

LOCATIONS:
{locations}

STORY CONTINUITY (recent scenes):
{recent_scenes}`,

    rewrite: `You are a screenplay editor and script doctor. Improve the provided content while maintaining the original intent.

REWRITE GUIDELINES:
- Preserve character names exactly as given
- Maintain scene heading format (INT./EXT. LOCATION - TIME)
- Keep the same scene structure unless explicitly asked to restructure
- Focus on: sharper dialogue, clearer action, better pacing, stronger character voices
- Return ONLY the rewritten content in proper Fountain format
- Do not add commentary or explanations before/after the screenplay content

ORIGINAL CONTENT TO REWRITE:
{original_content}

PROJECT CONTEXT:
Title: {title}
Genre: {genre}
Characters: {characters}`,

    convert: `You are a screenplay formatter. Convert the provided text into proper Fountain screenplay format. Include:
- Correct scene headings
- Properly formatted action lines
- Character names in ALL CAPS
- Dialogue with correct indentation
- Transitions where appropriate

Return only the formatted screenplay content.`
};

function handleScreenplayAI(req, res, urlParts) {
    const projectId = urlParts[2];
    const subRoute = urlParts[4]; // 'stream' for SSE mode

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

    // FILM-115: Handle streaming endpoint
    if (subRoute === 'stream') {
        return processScreenplayAIStream(req, res, projectId);
    }

    return processScreenplayAI(req, res, projectId);
}

async function processScreenplayAI(req, res, projectId) {
    const body = req.body || {};
    const {
        mode = 'brainstorm',
        message,
        conversation_history = [],
        original_content = '',
        current_scene_fountain = '' // FILM-115: Current scene context
    } = body;

    if (!message || typeof message !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message is required' }));
        return;
    }

    // FILM-114: For rewrite mode, original_content is required
    if (mode === 'rewrite' && !original_content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'original_content is required for rewrite mode' }));
        return;
    }

    // Get project context
    const project = db.prepare(`
        SELECT title, genre, logline, style_preset
        FROM film_projects WHERE id = ?
    `).get(projectId);

    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    // Get characters
    const characters = db.prepare(`
        SELECT name, personality_notes, role
        FROM film_characters WHERE project_id = ?
    `).all(projectId);

    const charList = characters.length > 0
        ? characters.map(c => `- ${c.name}${c.role ? ` (${c.role})` : ''}${c.personality_notes ? `: ${c.personality_notes.slice(0, 100)}` : ''}`).join('\n')
        : '(No characters defined yet)';

    // Get locations
    const locations = db.prepare(`
        SELECT name, description
        FROM film_locations WHERE project_id = ?
    `).all(projectId);

    const locList = locations.length > 0
        ? locations.map(l => `- ${l.name}${l.description ? `: ${l.description.slice(0, 80)}` : ''}`).join('\n')
        : '(No locations defined yet)';

    // FILM-113: Get recent scenes for story continuity (write-scene mode)
    let recentScenes = '(No previous scenes)';
    if (mode === 'write-scene') {
        const scenes = db.prepare(`
            SELECT scene_number, int_ext, location, time_of_day, description
            FROM film_scenes
            WHERE project_id = ?
            ORDER BY scene_number DESC
            LIMIT 3
        `).all(projectId);

        if (scenes.length > 0) {
            recentScenes = scenes.reverse().map(s => {
                const heading = `${s.int_ext || 'INT.'} ${s.location || 'LOCATION'} - ${s.time_of_day || 'DAY'}`;
                const summary = s.description ? s.description.slice(0, 150) : '(No description)';
                return `Scene ${s.scene_number}: ${heading}\n   ${summary}`;
            }).join('\n\n');
        }
    }

    // Build system prompt
    let systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.brainstorm;
    systemPrompt = systemPrompt
        .replace('{title}', project.title || 'Untitled')
        .replace('{genre}', project.genre || 'Not specified')
        .replace('{logline}', project.logline || 'Not specified')
        .replace('{characters}', charList)
        .replace('{locations}', locList)
        .replace('{recent_scenes}', recentScenes)
        .replace('{original_content}', original_content || '(No content provided)');

    // FILM-115: Add current scene context if provided
    if (current_scene_fountain) {
        systemPrompt += `\n\nCURRENT SCENE (cursor is here):\n${current_scene_fountain.slice(0, 2000)}`;
    }

    // Build messages array with truncation
    const messages = [];

    // FILM-115: Truncate conversation history to last 20 messages or ~8000 tokens
    if (Array.isArray(conversation_history)) {
        let tokenCount = 0;
        const maxTokens = 8000;
        const recentHistory = conversation_history.slice(-20);

        for (const msg of recentHistory) {
            if (msg.role && msg.content) {
                // Rough token estimation: ~4 chars per token
                const msgTokens = Math.ceil(msg.content.length / 4);
                if (tokenCount + msgTokens > maxTokens) break;
                tokenCount += msgTokens;
                messages.push({ role: msg.role, content: msg.content });
            }
        }
    }

    // Add current message
    messages.push({ role: 'user', content: message });

    // Call AI gateway
    const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8080';
    const apiToken = process.env.API_TOKEN || process.env.GRIDLIGHT_API_KEY || '';

    try {
        const aiRes = await fetch(`${gatewayUrl}/chat/intelligent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`
            },
            body: JSON.stringify({
                message: message,
                system_prompt: systemPrompt,
                conversation_history: messages.slice(0, -1), // Exclude current message
                domain: 'screenplay',
                options: {
                    temperature: mode === 'brainstorm' ? 0.8 : 0.7,
                    max_tokens: 4000
                }
            })
        });

        if (!aiRes.ok) {
            const errText = await aiRes.text();
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'AI service error',
                details: errText,
                mode
            }));
            return;
        }

        const aiData = await aiRes.json();
        const responseText = aiData.response || aiData.message || '';

        // FILM-113: Validate Fountain content for write-scene mode
        let isValidFountain = false;
        let fountainValidation = {};
        if (mode === 'write-scene') {
            const hasSceneHeading = /^(INT|EXT|EST|INT\.?\/?EXT|I\/E)[\.\s]/im.test(responseText);
            const hasCharacter = /^[A-Z][A-Z\s\-'\.]+$/m.test(responseText);
            const hasDialogue = responseText.includes('\n') && responseText.length > 50;

            isValidFountain = hasSceneHeading && hasCharacter;
            fountainValidation = {
                has_scene_heading: hasSceneHeading,
                has_character: hasCharacter,
                has_dialogue: hasDialogue,
                is_valid: isValidFountain
            };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            content: responseText,
            mode,
            project_id: projectId,
            is_valid_fountain: isValidFountain,
            validation: fountainValidation
        }));

    } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'AI gateway unavailable',
            details: err.message,
            hint: 'Ensure the Gridlight gateway is running and GATEWAY_URL is set.',
            mode
        }));
    }
}

// FILM-115: SSE streaming endpoint for screenplay AI
async function processScreenplayAIStream(req, res, projectId) {
    const body = req.body || {};
    const {
        mode = 'brainstorm',
        message,
        conversation_history = [],
        current_scene_fountain = ''
    } = body;

    if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message is required' }));
        return;
    }

    // Get project context (simplified for streaming)
    const project = db.prepare(`
        SELECT title, genre, logline
        FROM film_projects WHERE id = ?
    `).get(projectId);

    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    // Build simple system prompt
    let systemPrompt = `You are an AI screenplay assistant for "${project.title || 'Untitled'}" (${project.genre || 'genre not specified'}).`;
    if (current_scene_fountain) {
        systemPrompt += `\n\nCurrent scene context:\n${current_scene_fountain.slice(0, 1500)}`;
    }

    // Truncate history for streaming
    const truncatedHistory = conversation_history.slice(-10).filter(m => m.role && m.content);

    const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8080';
    const apiToken = process.env.API_TOKEN || process.env.GRIDLIGHT_API_KEY || '';

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    const sendEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('status', { phase: 'sending', message: 'Sending to AI...' });

    try {
        const aiRes = await fetch(`${gatewayUrl}/chat/intelligent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`
            },
            body: JSON.stringify({
                message: message,
                system_prompt: systemPrompt,
                conversation_history: truncatedHistory,
                domain: 'screenplay',
                stream: true,
                options: {
                    temperature: 0.7,
                    max_tokens: 4000
                }
            })
        });

        if (!aiRes.ok) {
            sendEvent('error', { message: 'AI service returned error', status: aiRes.status });
            res.end();
            return;
        }

        sendEvent('status', { phase: 'generating', message: 'AI is responding...' });

        // Handle streaming response
        const contentType = aiRes.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
            // Relay SSE chunks
            const reader = aiRes.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                sendEvent('chunk', { text: chunk });
            }
        } else {
            // Non-streaming response
            const aiData = await aiRes.json();
            const responseText = aiData.response || aiData.message || '';
            sendEvent('chunk', { text: responseText });
        }

        sendEvent('done', { message: 'Complete' });
        res.end();

    } catch (err) {
        sendEvent('error', { message: 'AI gateway unavailable', details: err.message });
        res.end();
    }
}

module.exports = { handleScreenplayAI };
