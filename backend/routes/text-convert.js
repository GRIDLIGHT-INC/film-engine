/**
 * FILM-117: Text-to-Screenplay Conversion
 * POST /film/projects/:id/text-to-screenplay — Convert prose to Fountain format
 * POST /film/projects/:id/text-to-screenplay/preview — Preview conversion without saving
 * POST /film/projects/:id/text-to-screenplay/extract  — .docx upload -> plain text
 *
 * Converts prose/novel text into properly formatted Fountain screenplay.
 */
const { db } = require('../db/database');
const { extractDocxText } = require('../lib/docx-text');
const { callProjectLLM } = require('../lib/llm-client');
const { fallbackNotice } = require('../lib/agent-presence');

/**
 * What replaces this over MCP. See screenplay-ai.js for the reasoning.
 *
 * The novel import is exactly this case: Claude Desktop reads a chapter, writes
 * Fountain, and calls scene_append. Routing that through a server-side LLM would
 * ask the user for a second key so a second model could redo work the first one
 * had already done better, having read the chapter.
 */
const MCP_ALTERNATIVE = [
    {
        route: 'POST /film/projects/:id/text-to-screenplay',
        does: 'prose in, Fountain out, saved as a new version',
        mcp_alternative: 'scene_append (or script_write for a whole draft)',
        why: 'the connected model has the prose in front of it; converting is what it is for',
    },
    {
        route: 'POST /film/projects/:id/text-to-screenplay/preview',
        does: 'the same conversion, without saving',
        mcp_alternative: 'ask the connected model to show the Fountain before you save it',
        why: 'a preview is a conversation turn, which is the thing an agent host is',
    },
];


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 20000;

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

    // .docx -> text. Separate from conversion because extraction is local and
    // instant, while conversion is a slow, paid LLM call — the user should see
    // and be able to edit the extracted prose before spending anything on it.
    if (subRoute === 'extract') return extractUploadedDocument(req, res);

    const isPreview = subRoute === 'preview';
    return processTextConversion(req, res, projectId, isPreview);
}

/**
 * Extract plain text from an uploaded document.
 *
 * The body parser is JSON-only, so the file arrives base64-encoded rather than
 * as a binary stream. Base64 inflates by roughly a third, which the 10MB body
 * limit comfortably covers for a manuscript chapter.
 */
function extractUploadedDocument(req, res) {
    const body = req.body || {};
    const filename = String(body.filename || '').slice(0, 300);
    const b64 = body.data_base64;

    if (!b64 || typeof b64 !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'data_base64 is required' }));
        return;
    }
    if (filename && !/\.docx$/i.test(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only .docx files can be extracted. For .doc, .pages or PDF, save as .docx or plain text first.' }));
        return;
    }

    let buffer;
    try {
        buffer = Buffer.from(b64, 'base64');
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload was not valid base64' }));
        return;
    }

    const result = extractDocxText(buffer);
    if (!result.ok) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        filename,
        text: result.text,
        paragraphs: result.paragraphs,
        characters: result.characters,
        files_read: result.files_read || [],
    }));
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
        SELECT title, genre, provider_config FROM film_projects WHERE id = ?
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

    // Embed system prompt in the question because Gridlight has no system_prompt
    // field; OpenAI also receives this canonical LLM shape through the adapter.
    const fullQuestion = systemPrompt + '\n\n---\n\n' + userMessage;

    try {
        const aiResult = await callProjectLLM(project, { question: fullQuestion, stream: false }, { timeout: 300000 });

        if (!aiResult.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'AI service error',
                details: aiResult.error,
                provider: aiResult.provider,
            ai_path: fallbackNotice(MCP_ALTERNATIVE[0].mcp_alternative)
            }));
            return;
        }

        const fountainText = aiResult.answer || '';

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
            output_length: fountainText.length,
            provider: aiResult.provider,
            ai_path: fallbackNotice(MCP_ALTERNATIVE[0].mcp_alternative),
            provider_model: aiResult.provider_model || ''
        };

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

module.exports = { MCP_ALTERNATIVE, handleTextConvert };
