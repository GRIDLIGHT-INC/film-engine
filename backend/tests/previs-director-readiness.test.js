const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const THREED = fs.readFileSync(path.join(ROOT, 'backend', 'routes', 'threed.js'), 'utf8');

function bodyOf(name) {
    const start = UI.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is missing`);
    const brace = UI.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < UI.length; i++) {
        if (UI[i] === '{') depth++;
        else if (UI[i] === '}' && --depth === 0) return UI.slice(brace + 1, i);
    }
    throw new Error(`${name} is incomplete`);
}

test('every selected staged model reaches both the blocking and textured views', () => {
    const refresh = bodyOf('previsRefresh');
    assert.match(refresh, /previsSolidSync\s*\(/,
        'the textured model loader exists but is never called when selection or model changes');
});

test('generated subject scale follows its model into the stage', () => {
    const scaledKinds = [...THREED.matchAll(/metadata\.subject_kind === '([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(new Set(scaledKinds), new Set(['character', 'prop']),
        'the model catalogue must derive scale for every subject table that declares metric height');
    assert.match(THREED, /declared_height_m/);
    const chooser = bodyOf('previsChooseModel');
    assert.match(chooser, /geometry\.size[\s\S]*?model\.declaredHeightM[\s\S]*?o\.sizeM/,
        'choosing a generated model does not apply its declared real-world height to its GLB bounds');
});

test('the stage exposes a direct action for every stored camera pose axis', () => {
    const reader = bodyOf('previsReadInspector');
    const poseIds = [...reader.matchAll(/num\('(previsCamera(?:X|Yaw|Pitch|Roll)|previsHeight|previsDistance)'/g)]
        .map(m => m[1]);
    assert.equal(new Set(poseIds).size, 6, `expected six stored pose controls, found ${poseIds.join(', ')}`);

    const actionsMatch = UI.match(/const PREVIS_CAMERA_STAGE_ACTIONS\s*=\s*Object\.freeze\((\{[\s\S]*?\})\);/);
    assert.ok(actionsMatch, 'there is no on-stage camera action registry');
    for (const id of new Set(poseIds)) {
        assert.match(actionsMatch[1], new RegExp(`\\b${id}\\b`), `${id} has no direct stage action`);
    }
    const controls = UI.match(/<div[^>]+id="previsCameraStageControls"[\s\S]*?<\/div>/);
    assert.ok(controls, 'the six-axis camera actions have no controls on the stage');
    for (const action of [...actionsMatch[1].matchAll(/(['"])([a-z-]+)\1\s*:/g)].map(m => m[2])) {
        assert.match(controls[0], new RegExp(`previsNudgeCamera\\('${action}'\\)`),
            `${action} exists in the registry but has no stage button`);
    }
});
