/**
 * FILM-094: Fountain Format Parser
 *
 * Isomorphic JavaScript library for parsing Fountain screenplay markup.
 * Works in both Node.js (require) and browser (<script>) environments.
 *
 * Exports:
 *   parseFountain(text) -> { title_page, elements }
 *   toFountain(parsed)  -> string
 *   analyzeScreenplay(parsed) -> statistics object
 *
 * Supports all Fountain spec elements:
 *   Title Page, Scene Heading, Action, Character, Dialogue, Parenthetical,
 *   Transition, Dual Dialogue, Centered, Lyrics, Page Break, Section,
 *   Synopsis, Notes, Boneyard
 */

(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.FountainParser = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    // =========================================================================
    // ELEMENT TYPES
    // =========================================================================

    const ELEMENT_TYPES = {
        SCENE_HEADING: 'scene_heading',
        ACTION: 'action',
        CHARACTER: 'character',
        DIALOGUE: 'dialogue',
        PARENTHETICAL: 'parenthetical',
        TRANSITION: 'transition',
        CENTERED: 'centered',
        LYRICS: 'lyrics',
        PAGE_BREAK: 'page_break',
        SECTION: 'section',
        SYNOPSIS: 'synopsis',
        NOTE: 'note',
        BONEYARD: 'boneyard'
    };

    // =========================================================================
    // REGEX PATTERNS
    // =========================================================================

    const PATTERNS = {
        // Title page: Key: Value (key ends with colon)
        TITLE_KEY: /^([A-Za-z][A-Za-z0-9\s-]*)\s*:\s*(.*)$/,

        // Scene heading: INT./EXT. with optional forced prefix and scene number
        SCENE_HEADING: /^(\.)?(?:\s)*[^\w\s.]*(INT|EXT|EST|INT\.?\/?EXT|EXT\.?\/?INT|I\/E)[\.\s]+(.+?)(?:\s*#([^#]+)#)?$/i,

        // Character: ALL CAPS with optional extension and dual dialogue marker
        CHARACTER: /^(@)?([A-Z][A-Z0-9\s\-'\.]+?)(?:\s*\(([^)]+)\))?(\s*\^)?$/,

        // Transition: ends with TO: or is FADE IN/OUT (with optional forced prefix)
        TRANSITION: /^(>)?([A-Z\s]+(?:TO:|IN:|OUT:)|FADE\s*(?:IN|OUT|TO\s+\w+)[:\.]?)$/i,

        // Forced transition (starts with >)
        FORCED_TRANSITION: /^>\s*(.+)$/,

        // Centered text: > text <
        CENTERED: /^>\s*(.+)\s*<$/,

        // Page break: 3+ equals signs
        PAGE_BREAK: /^={3,}$/,

        // Section headers: # ## ###
        SECTION: /^(#{1,6})\s*(.+)$/,

        // Synopsis: = text
        SYNOPSIS: /^=(?!=)\s*(.+)$/,

        // Notes: [[text]]
        NOTE_INLINE: /\[\[([^\]]*)\]\]/g,

        // Boneyard: /* ... */
        BONEYARD: /\/\*[\s\S]*?\*\//g,

        // Lyrics: ~ text
        LYRICS: /^~\s*(.*)$/,

        // Parenthetical: (text)
        PARENTHETICAL: /^\s*\(([^)]+)\)\s*$/,

        // Forced action: ! text
        FORCED_ACTION: /^!\s*(.+)$/,

        // Common transitions for liberal parsing
        COMMON_TRANSITIONS: /^(CUT TO|FADE IN|FADE OUT|FADE TO|DISSOLVE TO|SMASH CUT TO|MATCH CUT TO|JUMP CUT TO|WIPE TO|IRIS IN|IRIS OUT|INTERCUT|TIME CUT|FLASH CUT)[:\s]*$/i
    };

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    /**
     * Count words in a string
     */
    function countWords(text) {
        if (!text || typeof text !== 'string') return 0;
        const words = text.trim().split(/\s+/).filter(w => w.length > 0);
        return words.length;
    }

    /**
     * Check if a line is blank (empty or only whitespace)
     */
    function isBlankLine(line) {
        return !line || line.trim() === '';
    }

    /**
     * Check if text is all uppercase (with at least one letter)
     */
    function isUpperCase(text) {
        if (!text) return false;
        const hasLetter = /[A-Z]/.test(text);
        const isUpper = text === text.toUpperCase();
        return hasLetter && isUpper;
    }

    /**
     * Extract and remove boneyard sections from text
     * Returns { text: cleanedText, boneyards: [...] }
     */
    function extractBoneyard(text) {
        const boneyards = [];
        let index = 0;
        const cleaned = text.replace(PATTERNS.BONEYARD, (match) => {
            boneyards.push({
                type: ELEMENT_TYPES.BONEYARD,
                text: match.slice(2, -2).trim(),
                index: index++
            });
            return '';
        });
        return { text: cleaned, boneyards };
    }

    /**
     * Extract inline notes from text
     * Returns { text: cleanedText, notes: [...] }
     */
    function extractInlineNotes(text) {
        const notes = [];
        const cleaned = text.replace(PATTERNS.NOTE_INLINE, (match, content) => {
            notes.push({
                type: ELEMENT_TYPES.NOTE,
                text: content.trim()
            });
            return '';
        });
        return { text: cleaned.trim(), notes };
    }

    /**
     * Parse scene heading for INT/EXT and time of day
     */
    function parseSceneHeadingDetails(text) {
        const result = { int_ext: null, location: null, time_of_day: null };

        // Remove scene number marker if present at end
        text = text.replace(/\s*#[^#]+#\s*$/, '');
        text = text.replace(/^[^\w\s.]*(?=(INT|EXT|EST|I\/E)\b)/i, '');

        // Extract INT/EXT prefix
        const prefixMatch = text.match(/^(INT|EXT|EST|INT\.?\/?EXT|EXT\.?\/?INT|I\/E)[\.\s]+/i);
        if (prefixMatch) {
            result.int_ext = prefixMatch[1].toUpperCase().replace(/\s/g, '');
            text = text.slice(prefixMatch[0].length);
        }

        // Split on the final dash only when the final segment is a time marker.
        const timeMatch = text.match(/^(.*?)\s*[-–—]\s*(DAY|NIGHT|MORNING|AFTERNOON|EVENING|DUSK|DAWN|LATER|EARLIER|CONTINUOUS|SAME|MOMENTS LATER|THE NEXT DAY|SUNRISE|SUNSET)$/i);
        if (timeMatch) {
            result.location = timeMatch[1].trim();
            result.time_of_day = timeMatch[2].trim().toUpperCase();
        } else {
            result.location = text.trim();
        }

        return result;
    }

    // =========================================================================
    // TITLE PAGE PARSER
    // =========================================================================

    /**
     * Parse title page from the beginning of text
     * Returns { title_page: {...} | null, remaining: string }
     */
    function parseTitlePage(text) {
        const lines = text.split(/\r?\n/);
        const titlePage = {};
        let inTitlePage = false;
        let currentKey = null;
        let currentValue = [];
        let lineIndex = 0;

        // Title page must start with a key: value pair
        const firstNonEmpty = lines.findIndex(l => l.trim() !== '');
        if (firstNonEmpty === -1) {
            return { title_page: null, remaining: text };
        }

        const firstLine = lines[firstNonEmpty];
        if (!PATTERNS.TITLE_KEY.test(firstLine)) {
            return { title_page: null, remaining: text };
        }

        // Parse title page lines
        for (let i = firstNonEmpty; i < lines.length; i++) {
            const line = lines[i];
            lineIndex = i;

            // Empty line ends title page (unless we're in a multi-line value)
            if (isBlankLine(line)) {
                // Save current key if exists
                if (currentKey) {
                    titlePage[currentKey] = currentValue.length === 1
                        ? currentValue[0]
                        : currentValue.join('\n');
                }
                // Check if next non-empty line is also a key
                const nextNonEmpty = lines.slice(i + 1).findIndex(l => l.trim() !== '');
                if (nextNonEmpty === -1) break;
                const nextLine = lines[i + 1 + nextNonEmpty];
                if (!PATTERNS.TITLE_KEY.test(nextLine)) {
                    lineIndex = i;
                    break;
                }
                currentKey = null;
                currentValue = [];
                continue;
            }

            const keyMatch = line.match(PATTERNS.TITLE_KEY);
            if (keyMatch) {
                // Save previous key
                if (currentKey) {
                    titlePage[currentKey] = currentValue.length === 1
                        ? currentValue[0]
                        : currentValue.join('\n');
                }
                currentKey = keyMatch[1].trim();
                if (keyMatch[2].trim()) {
                    currentValue = [keyMatch[2].trim()];
                } else {
                    currentValue = [];
                }
                inTitlePage = true;
            } else if (currentKey && (line.startsWith('   ') || line.startsWith('\t'))) {
                // Indented continuation of multi-line value
                currentValue.push(line.trim());
            } else if (inTitlePage) {
                // Non-key, non-indented line ends title page
                if (currentKey) {
                    titlePage[currentKey] = currentValue.length === 1
                        ? currentValue[0]
                        : currentValue.join('\n');
                }
                break;
            }
        }

        // Save final key if exists
        if (currentKey && !titlePage[currentKey]) {
            titlePage[currentKey] = currentValue.length === 1
                ? currentValue[0]
                : currentValue.join('\n');
        }

        const hasContent = Object.keys(titlePage).length > 0;
        const remaining = hasContent ? lines.slice(lineIndex + 1).join('\n') : text;

        return {
            title_page: hasContent ? titlePage : null,
            remaining
        };
    }

    // =========================================================================
    // MAIN PARSER
    // =========================================================================

    /**
     * Parse Fountain text into structured AST
     * @param {string} text - Fountain formatted text
     * @returns {{ title_page: object|null, elements: array }}
     */
    function parseFountain(text) {
        if (!text || typeof text !== 'string') {
            return { title_page: null, elements: [] };
        }

        // Pre-process: extract boneyard sections
        const { text: cleanedText, boneyards } = extractBoneyard(text);

        // Parse title page
        const { title_page, remaining } = parseTitlePage(cleanedText);

        const lines = remaining.split(/\r?\n/);
        const elements = [];
        let sceneNumber = 0;

        // State machine
        let prevLineBlank = true;
        let currentElement = null;
        let expectingDialogue = false;
        let lastCharacterDual = false;
        let dualDialogueActive = false;

        function pushElement(el) {
            if (el && el.text !== undefined) {
                elements.push(el);
            }
        }

        function finishCurrentElement() {
            if (currentElement) {
                pushElement(currentElement);
                currentElement = null;
            }
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            const nextLine = i < lines.length - 1 ? lines[i + 1] : '';
            const nextLineBlank = isBlankLine(nextLine);

            // Handle blank lines
            if (isBlankLine(line)) {
                finishCurrentElement();
                prevLineBlank = true;
                expectingDialogue = false;
                if (!dualDialogueActive) {
                    lastCharacterDual = false;
                }
                continue;
            }

            // Check for page break
            if (PATTERNS.PAGE_BREAK.test(trimmed)) {
                finishCurrentElement();
                pushElement({ type: ELEMENT_TYPES.PAGE_BREAK, text: '' });
                prevLineBlank = true;
                expectingDialogue = false;
                continue;
            }

            // Check for standalone note (entire line is [[...]])
            if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
                finishCurrentElement();
                pushElement({
                    type: ELEMENT_TYPES.NOTE,
                    text: trimmed.slice(2, -2).trim()
                });
                prevLineBlank = false;
                continue;
            }

            // Check for section header
            const sectionMatch = trimmed.match(PATTERNS.SECTION);
            if (sectionMatch) {
                finishCurrentElement();
                pushElement({
                    type: ELEMENT_TYPES.SECTION,
                    text: sectionMatch[2].trim(),
                    depth: sectionMatch[1].length
                });
                prevLineBlank = true;
                continue;
            }

            // Check for synopsis
            const synopsisMatch = trimmed.match(PATTERNS.SYNOPSIS);
            if (synopsisMatch) {
                finishCurrentElement();
                pushElement({
                    type: ELEMENT_TYPES.SYNOPSIS,
                    text: synopsisMatch[1].trim()
                });
                prevLineBlank = true;
                continue;
            }

            // Check for centered text
            const centeredMatch = trimmed.match(PATTERNS.CENTERED);
            if (centeredMatch) {
                finishCurrentElement();
                pushElement({
                    type: ELEMENT_TYPES.CENTERED,
                    text: centeredMatch[1].trim()
                });
                prevLineBlank = true;
                continue;
            }

            // Check for lyrics
            const lyricsMatch = trimmed.match(PATTERNS.LYRICS);
            if (lyricsMatch) {
                finishCurrentElement();
                pushElement({
                    type: ELEMENT_TYPES.LYRICS,
                    text: lyricsMatch[1]
                });
                prevLineBlank = false;
                continue;
            }

            // Check for forced action
            const forcedActionMatch = trimmed.match(PATTERNS.FORCED_ACTION);
            if (forcedActionMatch) {
                finishCurrentElement();
                pushElement({
                    type: ELEMENT_TYPES.ACTION,
                    text: forcedActionMatch[1]
                });
                prevLineBlank = false;
                expectingDialogue = false;
                continue;
            }

            // Check for scene heading
            const sceneMatch = trimmed.match(PATTERNS.SCENE_HEADING);
            if (sceneMatch || (trimmed.startsWith('.') && trimmed.length > 1 && !trimmed.startsWith('..'))) {
                finishCurrentElement();
                sceneNumber++;

                let headingText = trimmed;
                let extractedSceneNum = null;

                if (sceneMatch) {
                    // Remove forced prefix if present
                    if (sceneMatch[1]) {
                        headingText = trimmed.slice(1);
                    }
                    extractedSceneNum = sceneMatch[4] || null;
                } else {
                    // Forced scene heading with .
                    headingText = trimmed.slice(1);
                }

                // Parse scene heading details
                const details = parseSceneHeadingDetails(headingText);

                pushElement({
                    type: ELEMENT_TYPES.SCENE_HEADING,
                    text: headingText,
                    scene_number: extractedSceneNum || String(sceneNumber),
                    meta: {
                        int_ext: details.int_ext,
                        location: details.location,
                        time_of_day: details.time_of_day
                    }
                });
                prevLineBlank = true;
                expectingDialogue = false;
                continue;
            }

            // Check for parenthetical (after character or dialogue)
            if (expectingDialogue || (currentElement && currentElement.type === ELEMENT_TYPES.DIALOGUE)) {
                const parenMatch = trimmed.match(PATTERNS.PARENTHETICAL);
                if (parenMatch) {
                    finishCurrentElement();
                    pushElement({
                        type: ELEMENT_TYPES.PARENTHETICAL,
                        text: parenMatch[1]
                    });
                    expectingDialogue = true;
                    prevLineBlank = false;
                    continue;
                }
            }

            // Check for character (uppercase, blank before, dialogue after)
            if (prevLineBlank && !nextLineBlank) {
                const charMatch = trimmed.match(PATTERNS.CHARACTER);
                const isForced = trimmed.startsWith('@');
                const textToCheck = isForced ? trimmed.slice(1).trim() : trimmed;

                if (charMatch || (isForced && textToCheck.length > 0)) {
                    // Validate it's not a transition or other element
                    if (!PATTERNS.COMMON_TRANSITIONS.test(trimmed) &&
                        !PATTERNS.TRANSITION.test(trimmed)) {

                        finishCurrentElement();

                        const isDual = charMatch && charMatch[4];
                        let charName = isForced ? textToCheck : (charMatch ? charMatch[2].trim() : trimmed);
                        let extension = charMatch ? charMatch[3] : null;

                        // Handle forced character with extension
                        if (isForced) {
                            const extMatch = textToCheck.match(/^(.+?)\s*\(([^)]+)\)(\s*\^)?$/);
                            if (extMatch) {
                                charName = extMatch[1].trim();
                                extension = extMatch[2];
                            }
                        }

                        const element = {
                            type: ELEMENT_TYPES.CHARACTER,
                            text: charName
                        };

                        if (extension) {
                            element.meta = { extension };
                        }

                        if (isDual || (isForced && textToCheck.endsWith('^'))) {
                            element.dual = 'right';
                            dualDialogueActive = false;
                            // Mark previous character as left
                            for (let j = elements.length - 1; j >= 0; j--) {
                                if (elements[j].type === ELEMENT_TYPES.CHARACTER && !elements[j].dual) {
                                    elements[j].dual = 'left';
                                    break;
                                }
                            }
                        }

                        pushElement(element);
                        expectingDialogue = true;
                        lastCharacterDual = !!isDual;
                        prevLineBlank = false;
                        continue;
                    }
                }
            }

            /*
             * A FORCED TRANSITION IS FORCED WHEREVER IT APPEARS.
             *
             * This sat behind `prevLineBlank`, so `> FADE OUT.` written on the
             * line straight after an action paragraph — no blank line between,
             * which is how people actually type it — was swallowed into that
             * paragraph as ordinary prose. It then read as two capitalised
             * words inside action text and was detected as a CHARACTER called
             * "FADE OUT", complete with a scene count, in every report built on
             * scene presence.
             *
             * That is also why re-typing the line with a `>` did not fix
             * anything: the marker was being ignored, so the author's explicit
             * instruction changed nothing at all.
             *
             * `>` is the author saying "this is a transition". A force that
             * only works in some positions is not a force. The UNFORCED check
             * below stays gated, because a bare capitalised line in the middle
             * of action may well be a shout.
             */
            const forcedTransition = trimmed.match(PATTERNS.FORCED_TRANSITION);
            if (forcedTransition && !PATTERNS.CENTERED.test(trimmed)) {
                finishCurrentElement();
                pushElement({
                    type: ELEMENT_TYPES.TRANSITION,
                    text: forcedTransition[1]
                });
                prevLineBlank = true;
                expectingDialogue = false;
                continue;
            }

            // Check for transition
            if (prevLineBlank) {
                const transMatch = trimmed.match(PATTERNS.TRANSITION);
                const commonTrans = trimmed.match(PATTERNS.COMMON_TRANSITIONS);
                if ((transMatch || commonTrans) && isUpperCase(trimmed.replace(/[:\s]/g, ''))) {
                    finishCurrentElement();
                    pushElement({
                        type: ELEMENT_TYPES.TRANSITION,
                        text: trimmed
                    });
                    prevLineBlank = true;
                    expectingDialogue = false;
                    continue;
                }
            }

            // Check for dialogue (after character or parenthetical)
            if (expectingDialogue) {
                if (currentElement && currentElement.type === ELEMENT_TYPES.DIALOGUE) {
                    // Continue multi-line dialogue
                    currentElement.text += '\n' + trimmed;
                } else {
                    finishCurrentElement();
                    currentElement = {
                        type: ELEMENT_TYPES.DIALOGUE,
                        text: trimmed
                    };
                }
                prevLineBlank = false;
                continue;
            }

            // Default to action
            if (currentElement && currentElement.type === ELEMENT_TYPES.ACTION) {
                // Continue multi-line action
                currentElement.text += '\n' + trimmed;
            } else {
                finishCurrentElement();
                currentElement = {
                    type: ELEMENT_TYPES.ACTION,
                    text: trimmed
                };
            }
            prevLineBlank = false;
            expectingDialogue = false;
        }

        // Finish any remaining element
        finishCurrentElement();

        // Add boneyards back (they're typically not rendered, but included in AST)
        boneyards.forEach(b => {
            elements.push(b);
        });

        return { title_page, elements };
    }

    // =========================================================================
    // SERIALIZER (toFountain)
    // =========================================================================

    /**
     * Convert parsed AST back to Fountain format string
     * @param {{ title_page: object|null, elements: array }} parsed
     * @returns {string}
     */
    function toFountain(parsed) {
        if (!parsed) return '';

        const lines = [];

        // Title page
        if (parsed.title_page) {
            for (const [key, value] of Object.entries(parsed.title_page)) {
                if (typeof value === 'string' && value.includes('\n')) {
                    lines.push(`${key}:`);
                    value.split('\n').forEach(v => lines.push(`   ${v}`));
                } else {
                    lines.push(`${key}: ${value}`);
                }
            }
            lines.push('');
        }

        // Elements
        let prevType = null;
        for (const el of (parsed.elements || [])) {
            // Add blank line before scene headings, transitions, characters
            if (prevType && [ELEMENT_TYPES.SCENE_HEADING, ELEMENT_TYPES.TRANSITION].includes(el.type)) {
                lines.push('');
            }
            if (el.type === ELEMENT_TYPES.CHARACTER && prevType !== null) {
                lines.push('');
            }

            switch (el.type) {
                case ELEMENT_TYPES.SCENE_HEADING: {
                    let heading = el.text;
                    if (el.scene_number) {
                        heading += ` #${el.scene_number}#`;
                    }
                    lines.push(heading);
                    break;
                }

                case ELEMENT_TYPES.ACTION:
                    lines.push(el.text);
                    break;

                case ELEMENT_TYPES.CHARACTER: {
                    let char = el.text;
                    if (el.meta && el.meta.extension) {
                        char += ` (${el.meta.extension})`;
                    }
                    if (el.dual === 'right') {
                        char += ' ^';
                    }
                    lines.push(char);
                    break;
                }

                case ELEMENT_TYPES.DIALOGUE:
                    lines.push(el.text);
                    break;

                case ELEMENT_TYPES.PARENTHETICAL:
                    lines.push(`(${el.text})`);
                    break;

                case ELEMENT_TYPES.TRANSITION:
                    lines.push(el.text);
                    break;

                case ELEMENT_TYPES.CENTERED:
                    lines.push(`> ${el.text} <`);
                    break;

                case ELEMENT_TYPES.LYRICS:
                    lines.push(`~${el.text}`);
                    break;

                case ELEMENT_TYPES.PAGE_BREAK:
                    lines.push('===');
                    break;

                case ELEMENT_TYPES.SECTION:
                    lines.push('#'.repeat(el.depth || 1) + ' ' + el.text);
                    break;

                case ELEMENT_TYPES.SYNOPSIS:
                    lines.push(`= ${el.text}`);
                    break;

                case ELEMENT_TYPES.NOTE:
                    lines.push(`[[${el.text}]]`);
                    break;

                case ELEMENT_TYPES.BONEYARD:
                    lines.push(`/*\n${el.text}\n*/`);
                    break;
            }

            prevType = el.type;
        }

        return lines.join('\n');
    }

    // =========================================================================
    // ANALYZER
    // =========================================================================

    /**
     * Analyze screenplay statistics
     * @param {{ title_page: object|null, elements: array }} parsed
     * @returns {object} Statistics object
     */
    function analyzeScreenplay(parsed) {
        if (!parsed || !parsed.elements) {
            return {
                total_words: 0,
                dialogue_words: 0,
                action_words: 0,
                dialogue_percentage: 0,
                scene_count: 0,
                scenes_by_int_ext: {},
                scenes_by_time: {},
                avg_scene_length: 0,
                longest_scene: null,
                shortest_scene: null,
                character_dialogue: {}
            };
        }

        const elements = parsed.elements;
        let totalWords = 0;
        let dialogueWords = 0;
        let actionWords = 0;
        const scenesByIntExt = {};
        const scenesByTime = {};
        const characterDialogue = {};
        const sceneLengths = [];

        let currentScene = null;
        let currentSceneLines = 0;
        let currentCharacter = null;

        for (const el of elements) {
            const words = countWords(el.text);
            totalWords += words;

            switch (el.type) {
                case ELEMENT_TYPES.SCENE_HEADING:
                    // Save previous scene length
                    if (currentScene) {
                        sceneLengths.push({
                            scene_number: currentScene,
                            length: currentSceneLines
                        });
                    }
                    currentScene = el.scene_number || String(sceneLengths.length + 1);
                    currentSceneLines = 1;

                    // Track INT/EXT
                    if (el.meta && el.meta.int_ext) {
                        const intExt = el.meta.int_ext;
                        scenesByIntExt[intExt] = (scenesByIntExt[intExt] || 0) + 1;
                    }

                    // Track time of day
                    if (el.meta && el.meta.time_of_day) {
                        const time = el.meta.time_of_day;
                        scenesByTime[time] = (scenesByTime[time] || 0) + 1;
                    }
                    break;

                case ELEMENT_TYPES.ACTION:
                    actionWords += words;
                    currentSceneLines += el.text.split('\n').length;
                    break;

                case ELEMENT_TYPES.CHARACTER:
                    currentCharacter = el.text;
                    if (!characterDialogue[currentCharacter]) {
                        characterDialogue[currentCharacter] = 0;
                    }
                    currentSceneLines++;
                    break;

                case ELEMENT_TYPES.DIALOGUE:
                    dialogueWords += words;
                    if (currentCharacter) {
                        characterDialogue[currentCharacter] += words;
                    }
                    currentSceneLines += el.text.split('\n').length;
                    break;

                case ELEMENT_TYPES.PARENTHETICAL:
                    currentSceneLines++;
                    break;

                default:
                    currentSceneLines++;
            }
        }

        // Save final scene length
        if (currentScene) {
            sceneLengths.push({
                scene_number: currentScene,
                length: currentSceneLines
            });
        }

        const sceneCount = sceneLengths.length;
        const avgSceneLength = sceneCount > 0
            ? sceneLengths.reduce((sum, s) => sum + s.length, 0) / sceneCount
            : 0;

        const sortedScenes = [...sceneLengths].sort((a, b) => b.length - a.length);
        const longestScene = sortedScenes[0] || null;
        const shortestScene = sortedScenes[sortedScenes.length - 1] || null;

        const dialoguePercentage = totalWords > 0
            ? Math.round((dialogueWords / totalWords) * 100)
            : 0;

        return {
            total_words: totalWords,
            dialogue_words: dialogueWords,
            action_words: actionWords,
            dialogue_percentage: dialoguePercentage,
            scene_count: sceneCount,
            scenes_by_int_ext: scenesByIntExt,
            scenes_by_time: scenesByTime,
            avg_scene_length: Math.round(avgSceneLength * 10) / 10,
            longest_scene: longestScene,
            shortest_scene: shortestScene,
            character_dialogue: characterDialogue
        };
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    return {
        parseFountain,
        toFountain,
        analyzeScreenplay,
        ELEMENT_TYPES
    };

}));
