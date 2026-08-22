/**
 * FILM-112: AI Screenplay Assistant
 * POST /film/projects/:id/screenplay-ai — AI chat for screenplay writing
 *
 * Supports modes: brainstorm, write-scene, rewrite, convert
 * Gathers project context and calls the selected LLM provider.
 */
const { db } = require('../db/database');
const { callProjectLLM, streamProjectLLM } = require('../lib/llm-client');
const { fallbackNotice } = require('../lib/agent-presence');

/**
 * What replaces this over MCP.
 *
 * Declared here rather than in a central list so that a new AI endpoint cannot
 * be added without answering the question — `tests/mcp-first-writing.test.js`
 * fails if a module that imports the LLM client declares nothing.
 *
 * These routes are the FALLBACK under option (c): they work, they spend this
 * project's API key, and they exist so the editor is usable with no agent host
 * attached. When one IS attached, the same work is done by the model already in
 * the conversation, which has the whole revision in context rather than one
 * scene of it.
 */
const MCP_ALTERNATIVE = [
    {
        route: 'POST /film/projects/:id/screenplay-ai',
        does: 'brainstorm, write, rewrite or convert, as a chat turn',
        mcp_alternative: 'script_get + scene_update / scene_edit / scene_append',
        why: 'the connected model reads the draft and writes the Fountain itself; nothing is relayed',
    },
];


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

Return only the formatted screenplay content.`,

    'generate-element': `You are a professional screenplay writer. Generate a single screenplay element of the specified type.

ELEMENT TYPE: {element_type}

RULES:
- Return ONLY the raw text content for the element — no labels, no formatting markers, no quotes.
- Match the tone and style of the project.
- For scene-heading: Return a valid scene heading like "INT. LOCATION - TIME OF DAY"
- For action: Return vivid, present-tense visual action description.
- For character: Return a character name in ALL CAPS.
- For dialogue: Return natural, character-appropriate dialogue lines only.
- For parenthetical: Return a brief parenthetical direction (without parentheses).
- For transition: Return a transition like "CUT TO:" or "DISSOLVE TO:"
- For centered: Return centered text content.
- For lyrics: Return song lyrics.
- For note: Return a production note.
- Do NOT include any explanation or commentary — just the element text.

SURROUNDING CONTEXT:
{context}

PROJECT CONTEXT:
Title: {title}
Genre: {genre}
Characters: {characters}`
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
        current_scene_fountain = '', // FILM-115: Current scene context
        element_type = '',
        context = ''
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
        SELECT title, genre, logline, style_preset, provider_config
        FROM film_projects WHERE id = ?
    `).get(projectId);

    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    // Get characters
    const characters = db.prepare(`
        SELECT name, personality_notes, description
        FROM film_characters WHERE project_id = ?
    `).all(projectId);

    const charList = characters.length > 0
        ? characters.map(c => `- ${c.name}${c.description ? ` (${c.description.slice(0, 60)})` : ''}${c.personality_notes ? `: ${c.personality_notes.slice(0, 100)}` : ''}`).join('\n')
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
        .replace('{original_content}', original_content || '(No content provided)')
        .replace('{element_type}', element_type || 'action')
        .replace('{context}', context || '(No surrounding context)');

    // FILM-115: Add current scene context if provided
    if (current_scene_fountain) {
        systemPrompt += `\n\nCURRENT SCENE (cursor is here):\n${current_scene_fountain.slice(0, 2000)}`;
    }

    // Build conversation history in Gridlight format: {question, answer} pairs
    const gridlightHistory = [];
    if (Array.isArray(conversation_history)) {
        let tokenCount = 0;
        const maxTokens = 8000;
        const recentHistory = conversation_history.slice(-20);

        // Convert {role, content} pairs to {question, answer} pairs
        for (let i = 0; i < recentHistory.length - 1; i += 2) {
            const userMsg = recentHistory[i];
            const assistantMsg = recentHistory[i + 1];
            if (userMsg?.role === 'user' && assistantMsg?.role === 'assistant') {
                const pairTokens = Math.ceil((userMsg.content.length + assistantMsg.content.length) / 4);
                if (tokenCount + pairTokens > maxTokens) break;
                tokenCount += pairTokens;
                gridlightHistory.push({
                    question: userMsg.content,
                    answer: assistantMsg.content
                });
            }
        }
    }

    const fullQuestion = systemPrompt + '\n\n---\n\nUser request:\n' + message;

    try {
        const aiResult = await callProjectLLM(project, {
            question: fullQuestion,
            conversation_history: gridlightHistory.length > 0 ? gridlightHistory : undefined,
            stream: false
        });

        if (!aiResult.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'AI service error',
                details: aiResult.error,
                provider: aiResult.provider,
                mode,
                // Said on the FAILURE path too, and especially there: a key with
                // no credit produces an error the reader cannot act on, and the
                // free path being already connected is the actionable part.
                ai_path: fallbackNotice(MCP_ALTERNATIVE[0].mcp_alternative),
            }));
            return;
        }

        const responseText = aiResult.answer || '';

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
            validation: fountainValidation,
            provider: aiResult.provider,
            provider_model: aiResult.provider_model || '',
            ai_path: fallbackNotice(MCP_ALTERNATIVE[0].mcp_alternative),
        }));

    } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'AI gateway unavailable',
            details: err.message,
            hint: 'Check the selected LLM provider in Settings and make sure its credentials/service are available.',
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
        SELECT title, genre, logline, provider_config
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

    // Convert history to Gridlight format: {question, answer} pairs
    const gridlightHistory = [];
    const recentHistory = conversation_history.slice(-10).filter(m => m.role && m.content);
    for (let i = 0; i < recentHistory.length - 1; i += 2) {
        const userMsg = recentHistory[i];
        const assistantMsg = recentHistory[i + 1];
        if (userMsg?.role === 'user' && assistantMsg?.role === 'assistant') {
            gridlightHistory.push({ question: userMsg.content, answer: assistantMsg.content });
        }
    }

    // Embed system prompt in question for Gridlight
    const fullQuestion = systemPrompt + '\n\n---\n\nUser request:\n' + message;

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

    sendEvent('status', { phase: 'sending', message: 'Sending to AI...' });

    try {
        sendEvent('status', { phase: 'generating', message: 'AI is responding...' });

        let accumulated = '';
        const result = await streamProjectLLM(project, {
            question: fullQuestion,
            conversation_history: gridlightHistory.length > 0 ? gridlightHistory : undefined,
            stream: true
        }, res, {
            onToken: (text) => {
                accumulated += text;
                sendEvent('chunk', { text });
            },
            onComplete: (data) => {
                if (!accumulated && data.answer) {
                    accumulated = data.answer;
                    sendEvent('chunk', { text: data.answer });
                }
            },
            onError: (data) => sendEvent('error', { message: data.error || 'AI service returned error' }),
        });
        if (!result.ok && !result.aborted) sendEvent('error', { message: result.error || 'AI service returned error' });

        sendEvent('done', { message: 'Complete', content: accumulated });
        res.end();

    } catch (err) {
        sendEvent('error', { message: 'AI gateway unavailable', details: err.message });
        res.end();
    }
}

module.exports = { MCP_ALTERNATIVE, handleScreenplayAI };
