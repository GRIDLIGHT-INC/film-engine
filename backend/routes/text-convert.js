/**
 * FILM-117: Text-to-Screenplay Conversion
 * POST /film/projects/:id/text-to-screenplay — Convert prose to Fountain format
 * POST /film/projects/:id/text-to-screenplay/preview — Preview conversion without saving
 *
 * Converts prose/novel text into properly formatted Fountain screenplay.
 */
const { db } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 10000;

const CONVERSION_SYSTEM_PROMPT = `You are a professional screenwriter converting prose/novel text into properly formatted Fountain screenplay format.

CONVERSION RULES:
1. SCENE HEADINGS: Identify location changes and create scene headings
   - Format: INT. or EXT. followed by LOCATION - TIME OF DAY
   - Example: INT. COFFEE SHOP - DAY

2. ACTION LINES: Convert narrative descriptions into present-tense action
   - Write what we SEE and HEAR
   - Keep it visual and concise
   - Remove internal thoughts (unless expressed through action)

3. DIALOGUE: Extract spoken words and format as:
   - Character name in ALL CAPS on its own line
   - Dialogue text below (no quotes needed)
   - Add parentheticals for tone/direction when needed

4. PRESERVE:
   - All story beats and plot points
   - Character relationships and dynamics
   - Emotional arcs
   - Key visual moments

5. CONSISTENT NAMES:
   Use these existing character names when applicable:
{characters}

Use these existing location names when applicable:
{locations}

OUTPUT FORMAT:
Return ONLY valid Fountain screenplay text. No commentary, no explanations.
Start with a scene heading. Include all converted content.

{style_notes}`;

/**
 * Handle text-to-screenplay conversion routes
 */
function handleTextConvert(req, res, urlParts) {
    const projectId = urlParts[2];
    const subRoute = urlParts[4]; // 'preview' for preview mode

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

    const isPreview = subRoute === 'preview';
    return processTextConversion(req, res, projectId, isPreview);
}

async function processTextConversion(req, res, projectId, isPreview) {
    const body = req.body || {};
    const {
        text,
        chapter_title = '',
        style_notes = ''
    } = body;

    // Validate input
    if (!text || typeof text !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Text is required' }));
        return;
    }

    if (text.length > MAX_TEXT_LENGTH) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: `Text too long. Maximum ${MAX_TEXT_LENGTH} characters per request.`,
            received: text.length
        }));
        return;
    }

    // Get project
    const project = db.prepare(`
        SELECT title, genre FROM film_projects WHERE id = ?
    `).get(projectId);

    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    // Get existing characters for consistency
    const characters = db.prepare(`
        SELECT name FROM film_characters WHERE project_id = ?
    `).all(projectId);
    const charList = characters.length > 0
        ? characters.map(c => `- ${c.name}`).join('\n')
        : '(No characters defined yet)';

    // Get existing locations for consistency
    const locations = db.prepare(`
        SELECT name FROM film_locations WHERE project_id = ?
    `).all(projectId);
    const locList = locations.length > 0
        ? locations.map(l => `- ${l.name}`).join('\n')
        : '(No locations defined yet)';

    // Build system prompt
    let systemPrompt = CONVERSION_SYSTEM_PROMPT
        .replace('{characters}', charList)
        .replace('{locations}', locList)
        .replace('{style_notes}', style_notes
            ? `STYLE NOTES:\n${style_notes}`
            : '');

    // Build user message
    let userMessage = `Convert the following prose into Fountain screenplay format:\n\n`;
    if (chapter_title) {
        userMessage += `CHAPTER: ${chapter_title}\n\n`;
    }
    userMessage += text;

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
                message: userMessage,
                system_prompt: systemPrompt,
                domain: 'screenplay',
                options: {
                    temperature: 0.6,
                    max_tokens: 4000
                }
            })
        });

        if (!aiRes.ok) {
            const errText = await aiRes.text();
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'AI service error',
                details: errText
            }));
            return;
        }

        const aiData = await aiRes.json();
        const fountainText = aiData.response || aiData.message || '';

        // Validate output
        const validation = validateFountainOutput(fountainText);

        // Extract detected elements
        const scenesDetected = extractScenes(fountainText);
        const charactersDetected = extractCharacters(fountainText);

        const result = {
            fountain_text: fountainText,
            scenes_detected: scenesDetected,
            characters_detected: charactersDetected,
            validation: validation,
            preview: isPreview,
            chapter_title: chapter_title || null,
            input_length: text.length,
            output_length: fountainText.length
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));

    } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'AI gateway unavailable',
            details: err.message,
            hint: 'Ensure the Gridlight gateway is running and GATEWAY_URL is set.'
        }));
    }
}

/**
 * Validate Fountain output
 */
function validateFountainOutput(text) {
    const issues = [];

    // Check for scene heading
    const hasSceneHeading = /^(INT|EXT|EST|INT\.?\/?EXT|I\/E)[\.\s]/im.test(text);
    if (!hasSceneHeading) {
        issues.push('No scene heading detected');
    }

    // Check for character cue
    const hasCharacter = /^[A-Z][A-Z\s\-'\.]+$/m.test(text);
    if (!hasCharacter) {
        issues.push('No character cues detected');
    }

    // Check minimum length
    if (text.length < 50) {
        issues.push('Output too short');
    }

    return {
        valid: issues.length === 0,
        issues: issues,
        has_scene_heading: hasSceneHeading,
        has_character: hasCharacter
    };
}

/**
 * Extract scene headings from Fountain text
 */
function extractScenes(text) {
    const scenes = [];
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(/^(INT|EXT|EST|INT\.?\/?EXT|I\/E)[\.\s]+(.+?)(?:\s*#[^#]+#)?$/i);
        if (match) {
            scenes.push({
                int_ext: match[1].toUpperCase(),
                heading: match[2].trim()
            });
        }
    }

    return scenes;
}

/**
 * Extract character names from Fountain text
 */
function extractCharacters(text) {
    const characters = new Set();
    const lines = text.split('\n');
    let prevBlank = true;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
            prevBlank = true;
            continue;
        }

        // Check if this looks like a character cue
        // (all caps, preceded by blank, followed by non-blank)
        if (prevBlank && i < lines.length - 1) {
            const nextLine = lines[i + 1];
            if (nextLine && nextLine.trim()) {
                // Character pattern: all caps, possibly with extension
                const charMatch = trimmed.match(/^([A-Z][A-Z0-9\s\-'\.]+?)(?:\s*\([^)]+\))?(?:\s*\^)?$/);
                if (charMatch) {
                    const name = charMatch[1].trim();
                    // Exclude likely non-characters
                    if (!isLikelyTransition(name) && name.length < 30) {
                        characters.add(name);
                    }
                }
            }
        }

        prevBlank = false;
    }

    return Array.from(characters);
}

/**
 * Check if text looks like a transition rather than a character
 */
function isLikelyTransition(text) {
    const transitions = [
        'CUT TO', 'FADE IN', 'FADE OUT', 'FADE TO', 'DISSOLVE TO',
        'SMASH CUT TO', 'MATCH CUT TO', 'JUMP CUT TO', 'WIPE TO',
        'TIME CUT', 'INTERCUT', 'END', 'THE END', 'CONTINUED'
    ];
    return transitions.some(t => text.toUpperCase().includes(t));
}

module.exports = { handleTextConvert };
