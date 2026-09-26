/**
 * FILM-095: Fountain Renderer
 *
 * Isomorphic JavaScript library for rendering Fountain AST to HTML.
 * Works in both Node.js (require) and browser (<script>) environments.
 *
 * Exports:
 *   renderFountainHTML(ast) -> string (HTML)
 *   SCREENPLAY_CSS -> string (CSS styles)
 *
 * Uses industry-standard screenplay formatting:
 *   - Courier Prime / Courier New 12pt
 *   - 1.5in left margin, 1in right margin for action
 *   - 3.7in left indent for character names
 *   - 2.5in left / 2.5in right for dialogue
 *   - 3.1in left for parentheticals
 *   - Transitions right-aligned
 */

(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.FountainRenderer = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    // =========================================================================
    // SCREENPLAY CSS
    // =========================================================================

    /**
     * Industry-standard screenplay CSS
     * Based on standard US Letter (8.5" x 11") formatting
     */
    const SCREENPLAY_CSS = `
/* Fountain Screenplay Styles */
@import url('https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400;1,700&display=swap');

.sp-screenplay {
    font-family: 'Courier Prime', 'Courier New', Courier, monospace;
    font-size: 12pt;
    line-height: 1;
    color: #000;
    background: #fff;
    max-width: 8.5in;
    margin: 0 auto;
    padding: 1in;
    box-sizing: border-box;
}

/* Title Page */
.sp-title-page {
    text-align: center;
    padding: 2in 1in;
    page-break-after: always;
}

.sp-title-page-title {
    font-size: 24pt;
    font-weight: bold;
    margin-bottom: 0.5in;
    text-transform: uppercase;
}

.sp-title-page-author {
    font-size: 12pt;
    margin-top: 1in;
}

.sp-title-page-contact {
    position: absolute;
    bottom: 1in;
    left: 1.5in;
    text-align: left;
    font-size: 12pt;
}

.sp-title-page-item {
    margin: 0.25em 0;
}

/* Scene Heading / Slugline */
.sp-scene-heading {
    font-weight: bold;
    text-transform: uppercase;
    margin: 1em 0 1em 0;
    padding-left: 0;
}

/* Action */
.sp-action {
    margin: 1em 0;
    padding-left: 0;
    padding-right: 0;
    white-space: pre-wrap;
}

/* Character Name */
.sp-character {
    text-transform: uppercase;
    margin-top: 1em;
    margin-bottom: 0;
    margin-left: 2.2in;
    padding: 0;
}

/* Dialogue */
.sp-dialogue {
    margin: 0;
    margin-left: 1in;
    margin-right: 1.5in;
    padding: 0;
    white-space: pre-wrap;
}

/* Parenthetical */
.sp-parenthetical {
    margin: 0;
    margin-left: 1.6in;
    margin-right: 2in;
    padding: 0;
}

/* Transition */
.sp-transition {
    text-align: right;
    text-transform: uppercase;
    margin: 1em 0;
    padding-right: 0;
}

/* Centered Text */
.sp-centered {
    text-align: center;
    margin: 1em 0;
}

/* Lyrics */
.sp-lyrics {
    font-style: italic;
    margin: 0.5em 0;
    margin-left: 1in;
}

/* Page Break */
.sp-page-break {
    text-align: center;
    margin: 2em 0;
    border-top: 1px solid #ccc;
    page-break-after: always;
}

.sp-page-break::after {
    content: '';
}

/* Section Headers (outline - not rendered in final) */
.sp-section {
    font-weight: bold;
    color: #666;
    margin: 1.5em 0 0.5em 0;
    border-bottom: 1px solid #ddd;
    padding-bottom: 0.25em;
}

.sp-section-1 { font-size: 16pt; }
.sp-section-2 { font-size: 14pt; }
.sp-section-3 { font-size: 12pt; }

/* Synopsis (outline - not rendered in final) */
.sp-synopsis {
    font-style: italic;
    color: #666;
    margin: 0.5em 0;
    padding-left: 1em;
    border-left: 3px solid #ddd;
}

/* Notes */
.sp-note {
    background: #fffacd;
    padding: 0.5em;
    margin: 0.5em 0;
    border-radius: 4px;
    font-size: 10pt;
    color: #666;
}

/* Boneyard (hidden by default) */
.sp-boneyard {
    display: none;
}

/* Dual Dialogue Container */
.sp-dual-dialogue {
    display: flex;
    gap: 0.5in;
    margin: 1em 0;
}

.sp-dual-dialogue-left,
.sp-dual-dialogue-right {
    flex: 1;
    min-width: 0;
}

.sp-dual-dialogue-left .sp-character,
.sp-dual-dialogue-right .sp-character {
    margin-left: 0.5in;
}

.sp-dual-dialogue-left .sp-dialogue,
.sp-dual-dialogue-right .sp-dialogue {
    margin-left: 0;
    margin-right: 0.25in;
}

.sp-dual-dialogue-left .sp-parenthetical,
.sp-dual-dialogue-right .sp-parenthetical {
    margin-left: 0.25in;
    margin-right: 0.5in;
}

/* Scene Numbers */
.sp-scene-number {
    float: right;
    font-weight: normal;
}

/* Character Extension (V.O., O.S., etc.) */
.sp-character-extension {
    font-weight: normal;
}

/* Emphasis */
.sp-bold { font-weight: bold; }
.sp-italic { font-style: italic; }
.sp-underline { text-decoration: underline; }
.sp-bold-italic { font-weight: bold; font-style: italic; }

/* Print Styles */
@media print {
    .sp-screenplay {
        padding: 0;
        max-width: none;
    }

    .sp-note,
    .sp-section,
    .sp-synopsis {
        display: none;
    }

    .sp-page-break {
        border: none;
        page-break-after: always;
    }
}
`.trim();

    // =========================================================================
    // HTML HELPERS
    // =========================================================================

    /**
     * Escape HTML special characters
     */
    function escapeHTML(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Process emphasis markup in text
     * Converts *italic*, **bold**, ***bold italic***, _underline_
     */
    function processEmphasis(text) {
        if (!text) return '';

        let result = escapeHTML(text);

        // Bold italic (must come before bold and italic)
        result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<span class="sp-bold-italic">$1</span>');

        // Bold
        result = result.replace(/\*\*(.+?)\*\*/g, '<span class="sp-bold">$1</span>');

        // Italic
        result = result.replace(/\*(.+?)\*/g, '<span class="sp-italic">$1</span>');

        // Underline
        result = result.replace(/_(.+?)_/g, '<span class="sp-underline">$1</span>');

        // Convert newlines to <br>
        result = result.replace(/\n/g, '<br>\n');

        return result;
    }

    // =========================================================================
    // RENDERER
    // =========================================================================

    /**
     * Render title page to HTML
     */
    function renderTitlePage(titlePage) {
        if (!titlePage) return '';

        const lines = ['<div class="sp-title-page">'];

        // Title
        if (titlePage.Title || titlePage.title) {
            lines.push(`<div class="sp-title-page-title">${escapeHTML(titlePage.Title || titlePage.title)}</div>`);
        }

        // Credit and Author
        const credit = titlePage.Credit || titlePage.credit || 'Written by';
        const author = titlePage.Author || titlePage.author || titlePage.Authors || titlePage.authors;
        if (author) {
            lines.push('<div class="sp-title-page-author">');
            lines.push(`<div class="sp-title-page-item">${escapeHTML(credit)}</div>`);
            lines.push(`<div class="sp-title-page-item">${escapeHTML(author)}</div>`);
            lines.push('</div>');
        }

        // Other fields (Source, Draft date, Contact, etc.)
        const skipKeys = ['Title', 'title', 'Credit', 'credit', 'Author', 'author', 'Authors', 'authors'];
        const otherFields = Object.entries(titlePage).filter(([key]) => !skipKeys.includes(key));

        if (otherFields.length > 0) {
            lines.push('<div class="sp-title-page-contact">');
            for (const [, value] of otherFields) {
                lines.push(`<div class="sp-title-page-item">${escapeHTML(value)}</div>`);
            }
            lines.push('</div>');
        }

        lines.push('</div>');
        return lines.join('\n');
    }

    /**
     * Render a single element to HTML
     */
    function renderElement(el, index, elements) {
        const type = el.type;
        const text = el.text || '';

        switch (type) {
            case 'scene_heading': {
                let sceneNum = '';
                if (el.scene_number) {
                    sceneNum = `<span class="sp-scene-number">${escapeHTML(el.scene_number)}</span>`;
                }
                return `<div class="sp-scene-heading">${processEmphasis(text)}${sceneNum}</div>`;
            }

            case 'action':
                return `<div class="sp-action">${processEmphasis(text)}</div>`;

            case 'character': {
                let charHTML = escapeHTML(text);
                if (el.meta && el.meta.extension) {
                    charHTML += ` <span class="sp-character-extension">(${escapeHTML(el.meta.extension)})</span>`;
                }
                // Dual dialogue is handled separately
                if (el.dual) {
                    return `<div class="sp-character">${charHTML}</div>`;
                }
                return `<div class="sp-character">${charHTML}</div>`;
            }

            case 'dialogue':
                return `<div class="sp-dialogue">${processEmphasis(text)}</div>`;

            case 'parenthetical':
                return `<div class="sp-parenthetical">(${processEmphasis(text)})</div>`;

            case 'transition':
                return `<div class="sp-transition">${escapeHTML(text)}</div>`;

            case 'centered':
                return `<div class="sp-centered">${processEmphasis(text)}</div>`;

            case 'lyrics':
                return `<div class="sp-lyrics">${processEmphasis(text)}</div>`;

            case 'page_break':
                return '<div class="sp-page-break"></div>';

            case 'section': {
                const depth = el.depth || 1;
                return `<div class="sp-section sp-section-${depth}">${escapeHTML(text)}</div>`;
            }

            case 'synopsis':
                return `<div class="sp-synopsis">${escapeHTML(text)}</div>`;

            case 'note':
                return `<div class="sp-note">${escapeHTML(text)}</div>`;

            case 'boneyard':
                return `<div class="sp-boneyard">${escapeHTML(text)}</div>`;

            default:
                return `<div class="sp-action">${processEmphasis(text)}</div>`;
        }
    }

    /**
     * Group elements for dual dialogue rendering
     * Returns array of { type: 'single'|'dual', elements: [...] }
     */
    function groupDualDialogue(elements) {
        const groups = [];
        let i = 0;

        while (i < elements.length) {
            const el = elements[i];

            // Check if this starts a dual dialogue block
            if (el.type === 'character' && el.dual === 'left') {
                // Collect left side (character + dialogue/parentheticals)
                const leftElements = [el];
                i++;
                while (i < elements.length &&
                       (elements[i].type === 'dialogue' || elements[i].type === 'parenthetical') &&
                       !elements[i].dual) {
                    leftElements.push(elements[i]);
                    i++;
                }

                // Look for right side character
                if (i < elements.length && elements[i].type === 'character' && elements[i].dual === 'right') {
                    const rightElements = [elements[i]];
                    i++;
                    while (i < elements.length &&
                           (elements[i].type === 'dialogue' || elements[i].type === 'parenthetical') &&
                           !elements[i].dual) {
                        rightElements.push(elements[i]);
                        i++;
                    }

                    groups.push({
                        type: 'dual',
                        left: leftElements,
                        right: rightElements
                    });
                } else {
                    // No right side found, render left as single
                    leftElements.forEach(e => groups.push({ type: 'single', element: e }));
                }
            } else {
                groups.push({ type: 'single', element: el });
                i++;
            }
        }

        return groups;
    }

    /**
     * Render parsed Fountain AST to HTML string
     * @param {{ title_page: object|null, elements: array }} ast - Parsed Fountain AST
     * @param {object} options - Rendering options
     * @param {boolean} options.includeCSS - Include CSS in a <style> tag (default: false)
     * @param {boolean} options.wrapInContainer - Wrap in .sp-screenplay div (default: true)
     * @returns {string} HTML string
     */
    function renderFountainHTML(ast, options = {}) {
        if (!ast) return '';

        const includeCSS = options.includeCSS || false;
        const wrapInContainer = options.wrapInContainer !== false;

        const htmlParts = [];

        // Optional CSS
        if (includeCSS) {
            htmlParts.push(`<style>\n${SCREENPLAY_CSS}\n</style>`);
        }

        // Container start
        if (wrapInContainer) {
            htmlParts.push('<div class="sp-screenplay">');
        }

        // Title page
        if (ast.title_page) {
            htmlParts.push(renderTitlePage(ast.title_page));
        }

        // Group elements for dual dialogue
        const groups = groupDualDialogue(ast.elements || []);

        // Render each group
        for (const group of groups) {
            if (group.type === 'dual') {
                htmlParts.push('<div class="sp-dual-dialogue">');

                // Left side
                htmlParts.push('<div class="sp-dual-dialogue-left">');
                for (const el of group.left) {
                    htmlParts.push(renderElement(el));
                }
                htmlParts.push('</div>');

                // Right side
                htmlParts.push('<div class="sp-dual-dialogue-right">');
                for (const el of group.right) {
                    htmlParts.push(renderElement(el));
                }
                htmlParts.push('</div>');

                htmlParts.push('</div>');
            } else {
                htmlParts.push(renderElement(group.element));
            }
        }

        // Container end
        if (wrapInContainer) {
            htmlParts.push('</div>');
        }

        return htmlParts.join('\n');
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    return {
        renderFountainHTML,
        SCREENPLAY_CSS
    };

}));
