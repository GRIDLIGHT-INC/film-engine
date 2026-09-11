const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const REPORT = path.join(ROOT, 'docs', 'research', 'music-workstation-and-ableton.md');

const REQUIRED_HEADINGS = [
    '## Web Findings',
    '## Local Findings',
    '## Key Ideas & Themes',
];

const LOCAL_SURFACES = [
    'backend/db/migrations/016_film_music_and_color.sql',
    'backend/db/migrations/023_music_generation.sql',
    'backend/db/migrations/033_audio_deliverables.sql',
    'backend/db/migrations/038_music_rights.sql',
    'backend/db/migrations/043_film_assets_scene_id.sql',
    'backend/db/migrations/091_music_sections.sql',
    'backend/lib/music-prompt.js',
    'backend/lib/music-sections.js',
    'backend/lib/audio-mixer.js',
    'backend/lib/audio-deliverables.js',
    'backend/routes/assets.js',
    'backend/routes/music-gen.js',
    'backend/routes/audio-deliverables.js',
    'backend/routes/sequences.js',
    'backend/lib/mcp-tools.js',
    'backend/mcp-server.js',
    'backend/server.js',
    'src/index.html',
    'docs/api-film.md',
    'docs/claude-desktop-guide.md',
];

const SOURCE_CATEGORIES = [
    'Ableton official',
    'Ableton MCP prior art',
    'AI music and stems',
    'Screenplay, emotion, and video conditioning',
    'Open-source audio infrastructure',
];

test('music workstation research covers the complete derived surface and evidence set', () => {
    assert.ok(fs.existsSync(REPORT), `missing research artifact: ${REPORT}`);
    const report = fs.readFileSync(REPORT, 'utf8');

    for (const heading of REQUIRED_HEADINGS) {
        assert.ok(report.includes(heading), `missing required heading: ${heading}`);
    }
    for (const file of LOCAL_SURFACES) {
        assert.ok(report.includes(file), `local integration surface is undocumented: ${file}`);
    }
    for (const category of SOURCE_CATEGORIES) {
        assert.ok(report.includes(category), `web evidence category is undocumented: ${category}`);
    }

    const urls = new Set(report.match(/https:\/\/[^)\s]+/g) || []);
    assert.ok(urls.size >= 15, `expected at least 15 distinct web sources, found ${urls.size}`);
});
