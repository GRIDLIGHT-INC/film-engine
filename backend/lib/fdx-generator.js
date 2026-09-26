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
/**
 * Three defects lived in this table, and they were three different bugs wearing
 * one map. Fixing them as one — "send the rest as Action" — is what produced the
 * worst of them.
 *
 * DROPPED: `section` and `synopsis` had no entry, so an outline written in Film
 * Engine vanished on the way to Final Draft, silently. Final Draft has both.
 *
 * WRONGLY PROMOTED: `note` mapped to `Action`, putting a private production note
 * into the SCREENPLAY BODY. The only one of the three that changes what the
 * script says, and worse than dropping it. Notes travel as ScriptNote now, via
 * FDX_NOTE_TYPES below.
 *
 * LOSSY, and now fixed at the paragraph rather than the type. `centered` and
 * `lyrics` have no FDX *type* — centring is an ALIGNMENT and there is no lyric
 * paragraph at all — which is why mapping them to a type was always going to
 * lose something. They stay `Action` and carry the form as paragraph attributes
 * instead: `Alignment="Center"` and italics. That is what Final Draft itself
 * does, so it reads back.
 *
 * `page_break` was simply dropped, and unlike the other two it has a real FDX
 * type. It is exported.
 *
 * `boneyard` stays absent deliberately: it is text that was cut, and exporting
 * it would resurrect the cuts.
 */
const FDX_TYPE_MAP = {
    scene_heading: 'Scene Heading',
    action: 'Action',
    character: 'Character',
    dialogue: 'Dialogue',
    parenthetical: 'Parenthetical',
    transition: 'Transition',
    section: 'Section Heading',
    synopsis: 'Summary',
    centered: 'Action',
    lyrics: 'Action',
    page_break: 'Page Break',
};

/**
 * Form that FDX carries on the PARAGRAPH rather than in its type.
 *
 * Mapping `centered` to a type was always lossy because centring is not a type
 * in Final Draft — it is an alignment on an Action paragraph, which is exactly
 * how Final Draft writes it itself. Same for lyrics, which have no paragraph
 * type at all and are conventionally italic.
 *
 * Kept as attributes rather than a second type map so that widening the type
 * map can never silently pick these up and flatten them again.
 */
const FDX_PARAGRAPH_FORM = {
    centered: { attrs: ' Alignment="Center"', italic: false },
    lyrics: { attrs: '', italic: true },
};

/**
 * Types that travel as a ScriptNote rather than as script text.
 *
 * A separate list so that adding an entry to FDX_TYPE_MAP can never silently
 * turn a note back into dialogue.
 */
const FDX_NOTE_TYPES = new Set(['note']);

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
        const text = el.text || el.content || '';

        // A note is ABOUT the screenplay, not part of it. Written as a Final
        // Draft ScriptNote so it survives the trip without appearing in the
        // script body — which is what mapping it to Action did.
        if (FDX_NOTE_TYPES.has(el.type)) {
            if (text) {
                lines.push(`    <Paragraph Type="Action">`);
                lines.push(`      <ScriptNote><Text>${escXML(text)}</Text></ScriptNote>`);
                lines.push('    </Paragraph>');
            }
            continue;
        }

        if (!fdxType) continue; // boneyard: deliberately not exported

        // A page break is a paragraph with no text. Written before the general
        // path so an empty <Text> is not emitted for it.
        if (el.type === 'page_break') {
            lines.push(`    <Paragraph Type="${fdxType}"/>`);
            continue;
        }

        // Form FDX carries on the paragraph rather than in its type: centring is
        // an alignment, lyrics are conventionally italic. Written here so that
        // widening FDX_TYPE_MAP later cannot silently flatten them again.
        const form = FDX_PARAGRAPH_FORM[el.type];
        if (form) {
            lines.push(`    <Paragraph Type="${fdxType}"${form.attrs}>`);
            lines.push(form.italic
                ? `      <Text Style="Italic">${escXML(text)}</Text>`
                : `      ${formatText(text)}`);
            lines.push('    </Paragraph>');
            continue;
        }

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
