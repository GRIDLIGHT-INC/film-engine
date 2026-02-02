const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    generateFDX, generateEmptyFDX, FDX_TYPE_MAP, escXML, formatText,
} = require('../lib/fdx-generator');

describe('fdx-generator', () => {
    describe('escXML', () => {
        it('escapes special characters', () => {
            assert.equal(escXML('&'), '&amp;');
            assert.equal(escXML('<script>'), '&lt;script&gt;');
            assert.equal(escXML('"hello"'), '&quot;hello&quot;');
        });

        it('returns empty for null', () => {
            assert.equal(escXML(null), '');
            assert.equal(escXML(undefined), '');
        });
    });

    describe('formatText', () => {
        it('wraps plain text in Text tags', () => {
            assert.equal(formatText('Hello'), '<Text>Hello</Text>');
        });

        it('handles bold formatting', () => {
            const result = formatText('**bold text**');
            assert.ok(result.includes('Style="Bold"'));
            assert.ok(result.includes('bold text'));
        });

        it('handles null', () => {
            assert.equal(formatText(null), '<Text></Text>');
        });
    });

    describe('FDX_TYPE_MAP', () => {
        it('maps all major Fountain types', () => {
            assert.equal(FDX_TYPE_MAP.scene_heading, 'Scene Heading');
            assert.equal(FDX_TYPE_MAP.action, 'Action');
            assert.equal(FDX_TYPE_MAP.character, 'Character');
            assert.equal(FDX_TYPE_MAP.dialogue, 'Dialogue');
            assert.equal(FDX_TYPE_MAP.parenthetical, 'Parenthetical');
            assert.equal(FDX_TYPE_MAP.transition, 'Transition');
        });
    });

    describe('generateEmptyFDX', () => {
        it('returns valid XML', () => {
            const xml = generateEmptyFDX();
            assert.ok(xml.includes('<?xml version="1.0"'));
            assert.ok(xml.includes('<FinalDraft'));
            assert.ok(xml.includes('Version="5"'));
            assert.ok(xml.includes('<Content>'));
            assert.ok(xml.includes('</FinalDraft>'));
        });
    });

    describe('generateFDX', () => {
        const sampleAST = {
            title_page: {
                title: 'Test Script',
                author: 'Jane Doe',
                date: '2025-01-01',
            },
            elements: [
                { type: 'scene_heading', text: 'INT. OFFICE - DAY', scene_number: '1' },
                { type: 'action', text: 'John walks in.' },
                { type: 'character', text: 'JOHN' },
                { type: 'dialogue', text: 'Hello there.' },
                { type: 'parenthetical', text: '(smiling)' },
                { type: 'dialogue', text: 'How are you?' },
                { type: 'transition', text: 'CUT TO:' },
                { type: 'scene_heading', text: 'EXT. PARK - NIGHT' },
                { type: 'action', text: 'A dog runs across the lawn.' },
            ],
        };

        it('generates valid FDX XML', () => {
            const xml = generateFDX(sampleAST);
            assert.ok(xml.includes('<?xml version="1.0"'));
            assert.ok(xml.includes('<FinalDraft'));
            assert.ok(xml.includes('</FinalDraft>'));
        });

        it('includes title page', () => {
            const xml = generateFDX(sampleAST);
            assert.ok(xml.includes('<TitlePage>'));
            assert.ok(xml.includes('Test Script'));
            assert.ok(xml.includes('Jane Doe'));
        });

        it('maps scene headings correctly', () => {
            const xml = generateFDX(sampleAST);
            assert.ok(xml.includes('Type="Scene Heading"'));
            assert.ok(xml.includes('INT. OFFICE - DAY'));
            assert.ok(xml.includes('Number="1"'));
        });

        it('maps character and dialogue', () => {
            const xml = generateFDX(sampleAST);
            assert.ok(xml.includes('Type="Character"'));
            assert.ok(xml.includes('JOHN'));
            assert.ok(xml.includes('Type="Dialogue"'));
            assert.ok(xml.includes('Hello there.'));
        });

        it('maps parentheticals', () => {
            const xml = generateFDX(sampleAST);
            assert.ok(xml.includes('Type="Parenthetical"'));
            assert.ok(xml.includes('(smiling)'));
        });

        it('maps transitions', () => {
            const xml = generateFDX(sampleAST);
            assert.ok(xml.includes('Type="Transition"'));
            assert.ok(xml.includes('CUT TO:'));
        });

        it('handles null AST', () => {
            const xml = generateFDX(null);
            assert.ok(xml.includes('<FinalDraft'));
            assert.ok(xml.includes('<Content>'));
        });

        it('handles empty elements', () => {
            const xml = generateFDX({ elements: [] });
            assert.ok(xml.includes('<Content>'));
            assert.ok(xml.includes('</Content>'));
        });

        it('handles AST with no title page', () => {
            const xml = generateFDX({ elements: [{ type: 'action', text: 'Hello' }] });
            assert.ok(!xml.includes('<TitlePage>'));
            assert.ok(xml.includes('Type="Action"'));
        });

        it('allows title page override', () => {
            const xml = generateFDX(sampleAST, { title: 'Override Title', author: 'Override Author' });
            assert.ok(xml.includes('Override Title'));
            assert.ok(xml.includes('Override Author'));
        });

        it('handles dual dialogue', () => {
            const ast = {
                elements: [
                    { type: 'character', text: 'JOHN', dual: true },
                    { type: 'dialogue', text: 'Hello' },
                ],
            };
            const xml = generateFDX(ast);
            assert.ok(xml.includes('DualDialogue="Start"'));
        });

        it('handles character extensions', () => {
            const ast = {
                elements: [
                    { type: 'character', text: 'JOHN', extension: 'V.O.' },
                    { type: 'dialogue', text: 'Narrating...' },
                ],
            };
            const xml = generateFDX(ast);
            assert.ok(xml.includes('JOHN (V.O.)'));
        });

        it('escapes special characters in text', () => {
            const ast = {
                elements: [
                    { type: 'action', text: 'He said "no" & left.' },
                ],
            };
            const xml = generateFDX(ast);
            assert.ok(xml.includes('&amp;'));
            assert.ok(xml.includes('&quot;'));
        });

        it('skips page breaks and sections', () => {
            const ast = {
                elements: [
                    { type: 'page_break' },
                    { type: 'section', text: 'ACT I' },
                    { type: 'action', text: 'Test' },
                ],
            };
            const xml = generateFDX(ast);
            assert.ok(!xml.includes('page_break'));
            assert.ok(!xml.includes('section'));
            assert.ok(xml.includes('Type="Action"'));
        });
    });
});
