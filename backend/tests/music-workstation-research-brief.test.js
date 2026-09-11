const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const BRIEF = path.join(__dirname, '..', '..', 'docs', 'research', 'music-workstation-research-brief.md');

const SECTIONS = [
    '## Research Brief: Film Engine Music Workstation and DAW Integration',
    '### Executive Summary',
    '### Key Themes',
    '### Top Ideas & Opportunities',
    '### Technical Approaches',
    '### Open Questions',
    '### Recommended Direction',
];

const COMPLETE_IMPLEMENTATION_SET = [
    'Canonical score session',
    'Screenplay and picture context',
    'AI generation and separation',
    'User stem import',
    'Mixing and rendering',
    'MCP and DAW round trip',
    'Safety, rights, and provenance',
    'Delivery and testing',
];

test('research brief covers every requested section and implementation area', () => {
    assert.ok(fs.existsSync(BRIEF), `missing research brief: ${BRIEF}`);
    const text = fs.readFileSync(BRIEF, 'utf8');
    for (const section of SECTIONS) {
        assert.ok(text.includes(section), `missing section: ${section}`);
    }
    for (const area of COMPLETE_IMPLEMENTATION_SET) {
        assert.ok(text.includes(area), `missing implementation area: ${area}`);
    }
});
