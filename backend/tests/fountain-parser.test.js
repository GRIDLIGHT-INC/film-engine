const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFountain } = require('../lib/fountain-parser');

test('scene heading keeps room names in multi-dash locations', () => {
    const parsed = parseFountain('INT. MANCHESTER TOWNHOUSE - FRONT HALL - NIGHT\n\nThe man waits.');
    const scene = parsed.elements.find((el) => el.type === 'scene_heading');

    assert.equal(scene.meta.int_ext, 'INT');
    assert.equal(scene.meta.location, 'MANCHESTER TOWNHOUSE - FRONT HALL');
    assert.equal(scene.meta.time_of_day, 'NIGHT');
});

test('scene heading tolerates leading editor status glyphs', () => {
    const parsed = parseFountain('⏱INT. MANCHESTER TOWNHOUSE - PARLOR - EARLIER\n\nThe room is still.');
    const scene = parsed.elements.find((el) => el.type === 'scene_heading');

    assert.ok(scene);
    assert.equal(scene.meta.location, 'MANCHESTER TOWNHOUSE - PARLOR');
    assert.equal(scene.meta.time_of_day, 'EARLIER');
});
