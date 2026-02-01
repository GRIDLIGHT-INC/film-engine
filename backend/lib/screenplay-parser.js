/**
 * Screenplay Parser
 * Parses standard screenplay format into structured scenes.
 *
 * Recognizes:
 *   INT. / EXT. / INT./EXT. scene headings (sluglines)
 *   CHARACTER NAME (all-caps before dialogue)
 *   Parentheticals
 *   Action lines
 *   Transitions (CUT TO:, FADE IN:, etc.)
 */

// Scene heading pattern: INT. or EXT. (or both) followed by location - TIME OF DAY
const SCENE_HEADING_RE = /^(INT\.|EXT\.|INT\.\/EXT\.|EXT\.\/INT\.)\s+(.+?)(?:\s*[-–—]\s*(.+))?$/i;

// Character cue: all-caps name, optionally with (V.O.) (O.S.) (CONT'D) etc.
const CHARACTER_RE = /^([A-Z][A-Z\s.''-]{1,40})(?:\s*\(([^)]+)\))?$/;

// Transition: UPPERCASE ending with colon or common transitions
const TRANSITION_RE = /^(?:CUT TO|FADE IN|FADE OUT|FADE TO|DISSOLVE TO|SMASH CUT|MATCH CUT|JUMP CUT|IRIS IN|IRIS OUT)[\s:]*|.+:$/;

function parseScreenplay(text) {
    if (!text || typeof text !== 'string') return [];

    const lines = text.split(/\r?\n/);
    const scenes = [];
    let currentScene = null;
    let currentCharacters = new Set();
    let lineBuffer = [];

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();

        // Skip empty lines
        if (!trimmed) continue;

        // Check for scene heading
        const headingMatch = trimmed.match(SCENE_HEADING_RE);
        if (headingMatch) {
            // Finalize previous scene
            if (currentScene) {
                currentScene.description = lineBuffer.join('\n').trim();
                currentScene.characters_present = [...currentCharacters];
                scenes.push(currentScene);
            }

            currentScene = {
                scene_number: scenes.length + 1,
                int_ext: headingMatch[1].toUpperCase().replace(/\s/g, ''),
                location: headingMatch[2].trim(),
                time_of_day: (headingMatch[3] || '').trim().toUpperCase(),
                description: '',
                characters_present: []
            };
            currentCharacters = new Set();
            lineBuffer = [];
            continue;
        }

        // If no scene started yet, skip non-heading lines
        if (!currentScene) continue;

        // Check for character cue
        const charMatch = trimmed.match(CHARACTER_RE);
        if (charMatch && trimmed === trimmed.toUpperCase() && trimmed.length > 1) {
            const name = charMatch[1].trim();
            // Filter out common transitions and single words that aren't character names
            if (!TRANSITION_RE.test(trimmed) && name.length > 1) {
                currentCharacters.add(name);
            }
        }

        // Accumulate action/description lines (skip transitions)
        if (!TRANSITION_RE.test(trimmed)) {
            lineBuffer.push(trimmed);
        }
    }

    // Finalize last scene
    if (currentScene) {
        currentScene.description = lineBuffer.join('\n').trim();
        currentScene.characters_present = [...currentCharacters];
        scenes.push(currentScene);
    }

    return scenes;
}

module.exports = { parseScreenplay };
