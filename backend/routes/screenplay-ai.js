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

    'write-scene': `You are a professional screenplay writer. Write scenes in proper Fountain screenplay format. Include:
- Scene headings (INT./EXT. LOCATION - TIME)
- Action lines (present tense, visual descriptions)
- Character names (ALL CAPS)
- Dialogue (natural, character-appropriate)
- Parentheticals where needed

Match the tone and style of the project. Write concise, visual, shootable scenes.

PROJECT CONTEXT:
Title: {title}
Genre: {genre}
Logline: {logline}

Known Characters:
{characters}`,

    rewrite: `You are a screenplay editor and script doctor. Improve the provided content while maintaining the original intent. Focus on:
- Sharper dialogue
- Clearer action descriptions
- Better pacing
- Stronger character voices
- Visual storytelling

Return the rewritten content in proper Fountain format.

PROJECT CONTEXT:
Title: {title}
Genre: {genre}`,

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

    return processScreenplayAI(req, res, projectId);
}

async function processScreenplayAI(req, res, projectId) {
    const body = req.body || {};
    const { mode = 'brainstorm', message, conversation_history = [] } = body;

    if (!message || typeof message !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message is required' }));
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

    // Build system prompt
    let systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.brainstorm;
    systemPrompt = systemPrompt
        .replace('{title}', project.title || 'Untitled')
        .replace('{genre}', project.genre || 'Not specified')
        .replace('{logline}', project.logline || 'Not specified')
        .replace('{characters}', charList)
        .replace('{locations}', locList);

    // Build messages array
    const messages = [];

    // Add conversation history
    if (Array.isArray(conversation_history)) {
        for (const msg of conversation_history.slice(-10)) { // Limit to last 10 messages
            if (msg.role && msg.content) {
                messages.push({ role: msg.role, content: msg.content });
            }
        }
    }

    // Add current message
    messages.push({ role: 'user', content: message });

    // Call AI gateway
    const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8080';
    const apiToken = process.env.API_TOKEN || 'dev-token';

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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            content: responseText,
            mode,
            project_id: projectId
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

module.exports = { handleScreenplayAI };
