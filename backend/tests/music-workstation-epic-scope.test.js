const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const EPIC = path.join(__dirname, '..', '..', 'docs', 'plans', 'epic-music-workstation.md');

const REQUIRED_SECTIONS = [
    '# Epic: Film Engine Music Workstation and DAW Integration',
    '## Overview',
    '## Business Goals',
    '## Current State',
    '## Target State',
    '## Constraints',
    '## Task Breakdown',
    '## Open Questions',
    '## Success Metrics',
];

const PHASES = [
    '### Phase 1: Native Score Workstation Foundation',
    '### Phase 2: AI Composition and Stem Workflows',
    '### Phase 3: DAW Package and Ableton MCP Round Trip',
    '### Phase 4: Final Pipeline Integration and Hardening',
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

const TASK_IDS = Array.from({ length: 24 }, (_, i) => `MUS-${String(i + 1).padStart(3, '0')}`);

test('music workstation epic covers the complete phased implementation set', () => {
    assert.ok(fs.existsSync(EPIC), `missing epic scope: ${EPIC}`);
    const text = fs.readFileSync(EPIC, 'utf8');
    for (const section of REQUIRED_SECTIONS) assert.ok(text.includes(section), `missing section: ${section}`);
    for (const phase of PHASES) assert.ok(text.includes(phase), `missing phase: ${phase}`);
    for (const area of COMPLETE_IMPLEMENTATION_SET) assert.ok(text.includes(area), `missing area: ${area}`);
    for (const id of TASK_IDS) {
        assert.equal((text.match(new RegExp(`^\\| ${id} \\|`, 'gm')) || []).length, 1, `${id} must appear once as a task row`);
    }
});
