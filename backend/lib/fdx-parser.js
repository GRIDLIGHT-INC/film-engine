/**
 * FILM-098: FDX (Final Draft) Import Parser
 *
 * Parses Final Draft XML files (.fdx) and converts to Fountain format.
 * Final Draft is the industry-standard screenwriting software.
 *
 * Exports:
 *   parseFDX(xmlString) -> { fountain_text, title_page, metadata }
 */

/**
 * Simple XML parser for FDX files
 * Uses regex-based parsing to avoid external dependencies
 */

// Escape special regex characters in tag names to prevent regex injection
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseXMLElement(xml, tagName) {
    const safe = escapeRegex(tagName);
    const regex = new RegExp(`<${safe}[^>]*>([\\s\\S]*?)<\\/${safe}>`, 'gi');
    const matches = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
        matches.push(match[1]);
    }
    return matches;
}

function parseXMLAttributes(tag) {
    const attrs = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let match;
    while ((match = attrRegex.exec(tag)) !== null) {
        attrs[match[1]] = match[2];
    }
    return attrs;
}

function getTagContent(xml, tagName) {
    const safe = escapeRegex(tagName);
    const match = xml.match(new RegExp(`<${safe}[^>]*>([\\s\\S]*?)<\\/${safe}>`, 'i'));
    return match ? match[1] : '';
}

function getAllTags(xml, tagName) {
    const safe = escapeRegex(tagName);
    const regex = new RegExp(`<${safe}([^>]*)>([\\s\\S]*?)<\\/${safe}>`, 'gi');
    const results = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
        results.push({
            attributes: parseXMLAttributes(match[1]),
            content: match[2]
        });
    }
    return results;
}

function getSelfClosingTags(xml, tagName) {
    const safe = escapeRegex(tagName);
    const regex = new RegExp(`<${safe}([^/>]*)\\/>`, 'gi');
    const results = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
        results.push(parseXMLAttributes(match[1]));
    }
    return results;
}

/**
 * Decode XML entities
 */
function decodeEntities(text) {
    if (!text) return '';
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Extract text content from a Paragraph element, handling Text children with styles
 */
function extractParagraphText(paragraphContent) {
    const textElements = getAllTags(paragraphContent, 'Text');
    let result = '';

    for (const textEl of textElements) {
        let text = decodeEntities(textEl.content);
        const style = textEl.attributes.Style || '';

        // Apply Fountain emphasis markers
        if (style.includes('Bold') && style.includes('Italic')) {
            text = `***${text}***`;
        } else if (style.includes('Bold')) {
            text = `**${text}**`;
        } else if (style.includes('Italic')) {
            text = `*${text}*`;
        } else if (style.includes('Underline')) {
            text = `_${text}_`;
        }

        result += text;
    }

    // If no Text elements found, try to get direct content
    if (!result && paragraphContent) {
        result = decodeEntities(paragraphContent.replace(/<[^>]+>/g, ''));
    }

    return result.trim();
}

/**
 * Map FDX paragraph types to Fountain element types
 */
const FDX_TYPE_MAP = {
    'Scene Heading': 'scene_heading',
    'Action': 'action',
    'Character': 'character',
    'Dialogue': 'dialogue',
    'Parenthetical': 'parenthetical',
    'Transition': 'transition',
    'Shot': 'action',           // Treat shots as action
    'General': 'action',         // General text as action
    'Cast List': 'action',
    'New Act': 'section',
    'End of Act': 'action'
};

/**
 * Parse Title Page from FDX
 */
function parseTitlePage(xml) {
    const titlePageContent = getTagContent(xml, 'TitlePage');
    if (!titlePageContent) return null;

    const titlePage = {};
    const contentElements = getAllTags(titlePageContent, 'Content');

    for (const content of contentElements) {
        const paragraphs = getAllTags(content.content, 'Paragraph');
        for (const para of paragraphs) {
            const type = para.attributes.Type || '';
            const text = extractParagraphText(para.content);

            if (!text) continue;

            // Map common title page elements
            if (type.toLowerCase().includes('title')) {
                titlePage.Title = titlePage.Title ? `${titlePage.Title}\n${text}` : text;
            } else if (type.toLowerCase().includes('author') || type.toLowerCase().includes('written')) {
                titlePage.Author = titlePage.Author ? `${titlePage.Author}\n${text}` : text;
            } else if (type.toLowerCase().includes('contact') || type.toLowerCase().includes('address')) {
                titlePage.Contact = titlePage.Contact ? `${titlePage.Contact}\n${text}` : text;
            } else if (type.toLowerCase().includes('draft') || type.toLowerCase().includes('date')) {
                titlePage['Draft date'] = text;
            } else if (type.toLowerCase().includes('copyright')) {
                titlePage.Copyright = text;
            } else if (text) {
                // Store other content
                if (!titlePage.Notes) titlePage.Notes = text;
                else titlePage.Notes += '\n' + text;
            }
        }
    }

    return Object.keys(titlePage).length > 0 ? titlePage : null;
}

/**
 * Parse Revisions metadata from FDX
 */
function parseRevisions(xml) {
    const revisionsContent = getTagContent(xml, 'Revisions');
    if (!revisionsContent) return [];

    const revisions = [];
    const revisionElements = getAllTags(revisionsContent, 'Revision');

    for (const rev of revisionElements) {
        revisions.push({
            name: rev.attributes.Name || '',
            color: rev.attributes.Color || '',
            fullRevision: rev.attributes.FullRevision === 'Yes',
            id: rev.attributes.ID || ''
        });
    }

    return revisions;
}

/**
 * Parse scene properties for scene numbering
 */
function parseSceneProperties(paragraphContent) {
    const props = getTagContent(paragraphContent, 'SceneProperties');
    if (!props) return null;

    const match = props.match(/Number="([^"]*)"/);
    return match ? match[1] : null;
}

/**
 * Convert FDX content to Fountain text
 */
function convertToFountain(xml) {
    const lines = [];
    const contentSection = getTagContent(xml, 'Content');
    if (!contentSection) return '';

    const paragraphs = getAllTags(contentSection, 'Paragraph');
    let prevType = null;
    let inDualDialogue = false;

    for (const para of paragraphs) {
        const fdxType = para.attributes.Type || 'Action';
        const fountainType = FDX_TYPE_MAP[fdxType] || 'action';
        const text = extractParagraphText(para.content);

        if (!text && fountainType !== 'scene_heading') continue;

        // Check for dual dialogue
        const dualDialogue = para.attributes.DualDialogue === 'Yes' ||
                             para.attributes.DualDialogue === 'Start';

        // Add blank line before certain elements
        if (prevType && (fountainType === 'scene_heading' || fountainType === 'transition')) {
            lines.push('');
        }
        if (fountainType === 'character' && prevType && prevType !== 'character') {
            lines.push('');
        }

        switch (fountainType) {
            case 'scene_heading': {
                // Check for scene number
                const sceneNum = parseSceneProperties(para.content);
                let heading = text.toUpperCase();
                if (sceneNum) {
                    heading += ` #${sceneNum}#`;
                }
                lines.push(heading);
                break;
            }

            case 'character': {
                let charLine = text.toUpperCase();
                if (dualDialogue && !inDualDialogue) {
                    // First character of dual dialogue - mark will be on second
                    inDualDialogue = true;
                } else if (inDualDialogue) {
                    // Second character - add caret
                    charLine += ' ^';
                    inDualDialogue = false;
                }
                lines.push(charLine);
                break;
            }

            case 'dialogue':
                lines.push(text);
                break;

            case 'parenthetical':
                // Ensure parentheses
                if (!text.startsWith('(')) {
                    lines.push(`(${text})`);
                } else {
                    lines.push(text);
                }
                break;

            case 'transition':
                // Force transition with >
                if (!text.endsWith(':')) {
                    lines.push(`> ${text}`);
                } else {
                    lines.push(text.toUpperCase());
                }
                break;

            case 'section':
                lines.push(`# ${text}`);
                break;

            case 'action':
            default:
                lines.push(text);
                break;
        }

        prevType = fountainType;
    }

    return lines.join('\n');
}

/**
 * Generate Fountain title page from parsed title page object
 */
function generateTitlePageFountain(titlePage) {
    if (!titlePage) return '';

    const lines = [];
    const order = ['Title', 'Credit', 'Author', 'Source', 'Draft date', 'Contact', 'Copyright', 'Notes'];

    for (const key of order) {
        if (titlePage[key]) {
            const value = titlePage[key];
            if (value.includes('\n')) {
                lines.push(`${key}:`);
                value.split('\n').forEach(v => lines.push(`   ${v}`));
            } else {
                lines.push(`${key}: ${value}`);
            }
        }
    }

    // Add any remaining keys not in order
    for (const key of Object.keys(titlePage)) {
        if (!order.includes(key)) {
            lines.push(`${key}: ${titlePage[key]}`);
        }
    }

    return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * Parse FDX XML string and convert to Fountain
 *
 * @param {string} xmlString - The FDX XML content
 * @returns {{ fountain_text: string, title_page: object|null, metadata: object }}
 */
function parseFDX(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') {
        return {
            fountain_text: '',
            title_page: null,
            metadata: { error: 'Invalid input' }
        };
    }

    // Basic validation - check for FinalDraft root
    if (!xmlString.includes('<FinalDraft') && !xmlString.includes('<finalDraft')) {
        return {
            fountain_text: '',
            title_page: null,
            metadata: { error: 'Not a valid FDX file' }
        };
    }

    // Parse components
    const titlePage = parseTitlePage(xmlString);
    const revisions = parseRevisions(xmlString);
    const bodyContent = convertToFountain(xmlString);

    // Combine title page and body
    const titlePageFountain = generateTitlePageFountain(titlePage);
    const fountain_text = titlePageFountain + bodyContent;

    // Extract document info
    const docInfoMatch = xmlString.match(/<FinalDraft[^>]*DocumentType="([^"]*)"[^>]*>/i);
    const versionMatch = xmlString.match(/<FinalDraft[^>]*Version="([^"]*)"[^>]*>/i);

    const metadata = {
        document_type: docInfoMatch ? docInfoMatch[1] : 'Unknown',
        fdx_version: versionMatch ? versionMatch[1] : 'Unknown',
        revisions: revisions,
        has_title_page: !!titlePage
    };

    return {
        fountain_text,
        title_page: titlePage,
        metadata
    };
}

module.exports = { parseFDX };
