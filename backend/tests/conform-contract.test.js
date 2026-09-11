const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { stages, checkConformDependency } = require('../lib/e2e-preflight');

test('the architecture record declares one conform executor and its resolution order', () => {
    const adrPath = path.join(ROOT, 'docs', 'adr', '007-local-ffmpeg-for-conform.md');
    assert.ok(fs.existsSync(adrPath), 'SHIP-001 has no conform architecture decision');

    const adr = fs.readFileSync(adrPath, 'utf8');
    assert.match(adr, /Decision[\s\S]*local FFmpeg/i);
    assert.match(adr, /FFMPEG_PATH[\s\S]*system PATH[\s\S]*ffmpeg-static/i,
        'the ADR does not pin the executable resolution order');
    assert.match(adr, /preflight/i, 'the ADR does not say how the dependency is checked');
});

test('every pipeline stage with an external runtime dependency declares it', () => {
    const external = stages().filter(stage => stage.externalDependency);
    assert.deepStrictEqual(external.map(stage => [stage.id, stage.externalDependency]), [
        ['assembly', 'ffmpeg'],
    ]);
});

test('an available encoder makes the conform dependency ready', () => {
    const result = checkConformDependency(() => ({
        available: true, bin: '/usr/local/bin/ffmpeg', source: 'path',
    }));
    assert.strictEqual(result.verdict, 'go');
    assert.match(result.reasons.join(' '), /system PATH/i);
    assert.deepStrictEqual(result.fixes, []);
});

test('a missing encoder blocks assembly and gives every supported remedy', () => {
    const result = checkConformDependency(() => ({
        available: false,
        reason: 'No encoder available.',
    }));
    assert.strictEqual(result.verdict, 'blocked');
    assert.match(result.reasons.join(' '), /No encoder available/);
    assert.match(result.fixes.join(' '), /FFMPEG_PATH/);
    assert.match(result.fixes.join(' '), /system PATH/);
    assert.match(result.fixes.join(' '), /ffmpeg-static/);
});

test('a broken encoder probe blocks instead of crashing preflight', () => {
    const result = checkConformDependency(() => { throw new Error('probe exploded'); });
    assert.strictEqual(result.verdict, 'blocked');
    assert.match(result.reasons.join(' '), /probe exploded/);
});
