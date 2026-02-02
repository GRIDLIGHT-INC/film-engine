/**
 * FDX (Final Draft XML) Generator
 *
 * Converts Fountain AST to Final Draft XML format (.fdx).
 * Final Draft Version 5 compatible.
 *
 * Exports:
 *   generateFDX(fountainAST, titlePage) -> string (XML)
 */

// Map Fountain element types to FDX paragraph types
const FDX_TYPE_MAP = {
    scene_heading: 'Scene Heading',
    action: 'Action',
    character: 'Character',
    dialogue: 'Dialogue',
    parenthetical: 'Parenthetical',
    transition: 'Transition',
    centered: 'Action',
    lyrics: 'Action',
    note: 'Action',
};

/**
 * Escape XML special characters.
 */
function escXML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Convert inline Fountain formatting to FDX Text elements.
 * Handles bold (**), italic (*), underline (_).
 */
function formatText(text) {
    if (!text) return '<Text></Text>';

    const parts = [];
    let remaining = text;

    // Simple approach: process bold+italic, bold, italic, underline in order
    // For simplicity, output as a single Text element with Style attribute
    const hasBold = /\*\*(.+?)\*\*/.test(remaining);
    const hasItalic = /\*(.+?)\*/.test(remaining) && !hasBold;
    const hasUnderline = /_(.+?)_/.test(remaining);

    // Strip formatting markers and apply styles
    let style = '';
    if (hasBold) style += 'Bold';
    if (hasItalic) style += (style ? '+' : '') + 'Italic';
    if (hasUnderline) style += (style ? '+' : '') + 'Underline';

    // Remove markers
    remaining = remaining.replace(/\*\*(.+?)\*\*/g, '$1');
    remaining = remaining.replace(/\*(.+?)\*/g, '$1');
    remaining = remaining.replace(/_(.+?)_/g, '$1');

    if (style) {
        return `<Text Style="${style}">${escXML(remaining)}</Text>`;
    }
    return `<Text>${escXML(remaining)}</Text>`;
}

/**
 * Build the TitlePage section of the FDX.
 */
function buildTitlePage(titlePage) {
    if (!titlePage || Object.keys(titlePage).length === 0) return '';

    const fields = [];
    if (titlePage.title) {
        fields.push(`      <Paragraph Type="Title Page" Alignment="Center">\n        <Text>${escXML(titlePage.title)}</Text>\n      </Paragraph>`);
    }
    if (titlePage.credit) {
        fields.push(`      <Paragraph Type="Title Page" Alignment="Center">\n        <Text>${escXML(titlePage.credit)}</Text>\n      </Paragraph>`);
    }
    if (titlePage.author || titlePage.authors) {
        const author = titlePage.author || titlePage.authors;
        fields.push(`      <Paragraph Type="Title Page" Alignment="Center">\n        <Text>${escXML(author)}</Text>\n      </Paragraph>`);
    }
    if (titlePage.source) {
        fields.push(`      <Paragraph Type="Title Page" Alignment="Center">\n        <Text>${escXML(titlePage.source)}</Text>\n      </Paragraph>`);
    }
    if (titlePage.draft_date || titlePage.date) {
        const date = titlePage.draft_date || titlePage.date;
        fields.push(`      <Paragraph Type="Title Page" Alignment="Right">\n        <Text>${escXML(date)}</Text>\n      </Paragraph>`);
    }
    if (titlePage.contact) {
        fields.push(`      <Paragraph Type="Title Page" Alignment="Left">\n        <Text>${escXML(titlePage.contact)}</Text>\n      </Paragraph>`);
    }

    if (fields.length === 0) return '';
    return `  <TitlePage>\n    <Content>\n${fields.join('\n')}\n    </Content>\n  </TitlePage>`;
}

/**
 * Generate FDX XML from a Fountain AST.
 *
 * @param {Object} fountainAST - Parsed Fountain object { title_page, elements }
 * @param {Object} [titlePageOverride] - Optional title page overrides
 * @returns {string} Final Draft XML string
 */
function generateFDX(fountainAST, titlePageOverride) {
    if (!fountainAST) return generateEmptyFDX();

    const elements = fountainAST.elements || [];
    const titlePage = titlePageOverride || fountainAST.title_page || {};

    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<FinalDraft DocumentType="Script" Template="No" Version="5">');

    // Title page
    const tp = buildTitlePage(titlePage);
    if (tp) lines.push(tp);

    // Content
    lines.push('  <Content>');

    for (const el of elements) {
        const fdxType = FDX_TYPE_MAP[el.type];
        if (!fdxType) continue; // skip page breaks, sections, synopses, boneyard

        const text = el.text || el.content || '';

        if (el.type === 'scene_heading') {
            // Scene headings may have scene numbers
            const sceneNum = el.scene_number ? ` Number="${escXML(el.scene_number)}"` : '';
            lines.push(`    <Paragraph Type="${fdxType}"${sceneNum}>`);
            lines.push(`      ${formatText(text)}`);
            lines.push('    </Paragraph>');
        } else if (el.type === 'character') {
            // Character may have extension (V.O., O.S., etc.)
            let charText = text;
            if (el.extension) charText += ` (${el.extension})`;
            if (el.dual) {
                lines.push(`    <Paragraph Type="${fdxType}" DualDialogue="Start">`);
            } else {
                lines.push(`    <Paragraph Type="${fdxType}">`);
            }
            lines.push(`      <Text>${escXML(charText)}</Text>`);
            lines.push('    </Paragraph>');
        } else {
            lines.push(`    <Paragraph Type="${fdxType}">`);
            lines.push(`      ${formatText(text)}`);
            lines.push('    </Paragraph>');
        }
    }

    lines.push('  </Content>');
    lines.push('</FinalDraft>');

    return lines.join('\n');
}

/**
 * Generate an empty FDX document.
 */
function generateEmptyFDX() {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<FinalDraft DocumentType="Script" Template="No" Version="5">',
        '  <Content>',
        '  </Content>',
        '</FinalDraft>',
    ].join('\n');
}

module.exports = { generateFDX, generateEmptyFDX, FDX_TYPE_MAP, escXML, formatText };
