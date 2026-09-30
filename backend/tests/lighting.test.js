/**
 * Lighting: a technique over a mood, per shot, per location, lit in Previs.
 *
 *   - the moods ARE the scene card's own vocabulary, and every technique is a
 *     rig with a key (or a back light for a silhouette);
 *   - the shot's own lighting wins, then the location's; the film's style is
 *     not repeated; nothing set sends nothing;
 *   - the technique reaches the image prompt in words, key side included, and
 *     a location's lighting note now reaches the shots filmed there;
 *   - a key from camera left is the rig mirrored;
 *   - the card, the location route and the Previs director route refuse an
 *     unknown technique by name;
 *   - Previs lights the Look view from the rig and draws it on the plan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-lighting-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();
const L = require('../lib/lighting');
const { VALID_LIGHTING, validateSceneCard } = require('../lib/scene-card-schema');
const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
const { handlePrevis } = require('../routes/previs');
const { callTool, isFailure } = require('../lib/mcp-tools');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function call(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const res = {
            statusCode: 200, writeHead(s) { this.statusCode = s; }, setHeader() {},
            end(c) { let d; try { d = JSON.parse(String(c)); } catch { d = c; } resolve({ status: this.statusCode, data: d }); },
        };
        handler({ method, body: body || {} }, res, urlPath.split('/').filter(Boolean), {});
    });
}

test('the moods are the scene card\'s own vocabulary, and every technique has a key light', () => {
    assert.deepEqual(Object.keys(L.MOODS).sort(), [...VALID_LIGHTING].sort());
    for (const [id, t] of Object.entries(L.TECHNIQUES)) {
        assert.ok(t.label && t.prompt, `${id} has no label or words`);
        assert.ok(t.rig.some(l => l.role === 'key' || l.role === 'back' || l.role === 'rim'), `${id} has no main light`);
        for (const l of t.rig) {
            assert.ok(Number.isFinite(l.az) && Number.isFinite(l.el) && l.ratio > 0, `${id}: a light with no place`);
        }
    }
    assert.equal(L.kelvinToHex(1900).slice(1, 3), 'ff', 'candlelight should be red-heavy');
    assert.ok(parseInt(L.kelvinToHex(9500).slice(5, 7), 16) === 255, 'blue hour should be blue-heavy');
});

test('the shot wins, then the location; nothing set says nothing', () => {
    const loc = { lighting_technique: 'window-motivated', lighting_key_side: 'left', lighting_default: 'sodium lamps outside' };
    const both = L.resolveLighting({ lighting: { technique: 'rembrandt' } }, loc);
    assert.equal(both.technique, 'rembrandt'); assert.equal(both.sources.technique, 'shot');
    assert.equal(both.key_side, 'left'); assert.equal(both.sources.key_side, 'location');
    const locOnly = L.resolveLighting({}, loc);
    assert.equal(locOnly.technique, 'window-motivated'); assert.equal(locOnly.sources.technique, 'location');
    assert.equal(locOnly.notes, 'sodium lamps outside');
    const none = L.resolveLighting({}, {});
    assert.equal(none.technique, null); assert.equal(L.techniquePhrase(none), null);
    assert.equal(L.resolveLighting({ lighting: { technique: 'nonsense' } }, {}).technique, null);
});

test('the technique reaches the prompt in words, and a location\'s lighting reaches its shots', () => {
    const card = { description: 'She waits at the counter.', lighting: { technique: 'rembrandt', key_side: 'left' } };
    const withTech = buildStoryboardPrompt(card, [], null, '').prompt;
    assert.match(withTech, /Rembrandt lighting/);
    assert.match(withTech, /key light from camera left/);
    const plain = buildStoryboardPrompt({ description: 'She waits at the counter.' }, [], null, '').prompt;
    assert.doesNotMatch(plain, /lighting/i, 'a shot that says nothing grew lighting words');
    const loc = { name: 'DINER', description: 'a chrome diner', lighting_technique: 'practical-motivated', lighting_default: 'neon sign bleeding pink' };
    const fromLoc = buildStoryboardPrompt({ description: 'She waits at the counter.' }, [], loc, '').prompt;
    assert.match(fromLoc, /practical lamps in frame/);
    assert.match(fromLoc, /neon sign bleeding pink/);
});

test('a key from camera left is the rig mirrored across the camera axis', () => {
    const cam = [0, 1.6, 0], subj = [0, 0, -4];     // camera south of the subject, looking north
    const right = L.rigLights({ technique: 'rembrandt', type: 'natural', key_side: 'right' }, cam, subj);
    const left = L.rigLights({ technique: 'rembrandt', type: 'natural', key_side: 'left' }, cam, subj);
    const key = r => r.find(l => l.role === 'key');
    assert.ok(key(right).position[0] > 0, 'camera-right key is not to the right (+X) of a north-facing camera');
    assert.ok(Math.abs(key(left).position[0] + key(right).position[0]) < 1e-9, 'left is not the mirror of right');
    assert.ok(key(right).position[2] > subj[2], 'a Rembrandt key stands on the camera side of the subject');
    const back = L.rigLights({ technique: 'silhouette', key_side: 'right' }, cam, subj)[0];
    assert.ok(back.position[2] < subj[2], 'a silhouette back light is not behind the subject');
    assert.equal(L.rigLights({ technique: 'loop', type: 'neon' }, cam, subj)[0].colour, '#ff3fa4', 'neon keys are not coloured');
});

test('the card, the location and the Previs director route refuse an unknown technique by name', async () => {
    assert.equal(validateSceneCard({ shot_code: '1A', description: 'x', lighting: { technique: 'rembrandt', key_side: 'left' } }).valid, true);
    const bad = validateSceneCard({ shot_code: '1A', description: 'x', lighting: { technique: 'moody' } });
    assert.ok((bad.errors || []).some(e => /lighting\.technique/.test(e)), JSON.stringify(bad));

    const projectId = generateId(), sceneId = generateId(), shotId = generateId(), locId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Light');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(locId, projectId, 'DINER');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)').run(sceneId, projectId, '1', 'DINER');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ description: 'x', lighting: { type: 'golden-hour' } }));

    const { handleLocations } = require('../routes/locations');
    assert.equal((await call(handleLocations, 'PUT', `/film/locations/${locId}`, { lighting_technique: 'moody' })).status, 400);
    const ok = await call(handleLocations, 'PUT', `/film/locations/${locId}`, { lighting_technique: 'window-motivated', lighting_key_side: 'left' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));

    // Before anything is staged: the card's mood, the location's technique and side.
    await call(handlePrevis, 'PUT', `/film/shots/${shotId}/previs`, {
        camera: { position: [0, 1.6, 0], rotation: [0, 0, 0], focalMm: 35 },
        subjects: [{ kind: 'human', name: 'A', isTarget: true, position: [0, 0, -3] }] });
    let g = await call(handlePrevis, 'GET', `/film/shots/${shotId}/previs`);
    assert.equal(g.data.lighting.technique, 'window-motivated'); assert.equal(g.data.lighting.sources.technique, 'location');
    assert.equal(g.data.lighting.type, 'golden-hour'); assert.equal(g.data.lighting.sources.type, 'shot');
    assert.ok(g.data.lighting.rig.length >= 1, 'no rig placed');

    // Staged in Previs: it wins and says so; the camera is untouched.
    assert.equal((await call(handlePrevis, 'PUT', `/film/shots/${shotId}/previs/director`, { lighting: { technique: 'moody' } })).status, 400);
    const put = await call(handlePrevis, 'PUT', `/film/shots/${shotId}/previs/director`, { lighting: { technique: 'rembrandt', key_side: 'right' } });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.deepEqual(put.data.blocking.camera.position, [0, 1.6, 0]);
    g = await call(handlePrevis, 'GET', `/film/shots/${shotId}/previs`);
    assert.equal(g.data.lighting.technique, 'rembrandt'); assert.equal(g.data.lighting.sources.technique, 'previs');
    // Direction staged beside it survives a lighting change.
    await call(handlePrevis, 'PUT', `/film/shots/${shotId}/previs/director`, { direction: 'she looks up' });
    await call(handlePrevis, 'PUT', `/film/shots/${shotId}/previs/director`, { lighting: { technique: 'loop' } });
    g = await call(handlePrevis, 'GET', `/film/shots/${shotId}/previs`);
    assert.equal(g.data.blocking.director.direction, 'she looks up', 'staging the lighting erased the direction');
    const t = await callTool('previs_director', { shot_id: shotId, lighting: null });
    assert.ok(!isFailure(t), JSON.stringify(t));
    g = await call(handlePrevis, 'GET', `/film/shots/${shotId}/previs`);
    assert.equal(g.data.lighting.technique, 'window-motivated', 'clearing the staged lighting did not fall back to the location');
});

test('Previs: a Light tab, the rig lighting the Look view, and the lights on the plan', () => {
    assert.ok(/\{ id: 'light',\s+label: 'Light' \}/.test(HTML), 'no Light tab');
    assert.ok(/pane\('light', worldLightHtml\(\)\)/.test(HTML), 'the Light tab has no panel');
    const fnSrc = name => {
        const i = HTML.indexOf(`function ${name}(`); assert.ok(i > 0, `${name} missing`);
        let j = HTML.indexOf(')', i); j = HTML.indexOf('{', j);
        for (let d = 0, k = j; k < HTML.length; k++) {
            if (HTML[k] === '{') d++; else if (HTML[k] === '}' && --d === 0) return HTML.slice(i, k + 1);
        }
        return '';
    };
    assert.ok(/previs\/director/.test(fnSrc('worldLightSet')), 'lighting is not staged through the director route');
    const rig = fnSrc('meshLookRig');
    assert.ok(/DirectionalLight/.test(rig) && /castShadow = true/.test(rig), 'the Look view is not lit by the rig');
    assert.ok(/meshLookRig\(\)/.test(fnSrc('worldMeshRenderOnce')), 'the Look render does not apply the rig');
    assert.ok(/lit\.rig/.test(fnSrc('worldPaintPlan')), 'the plan does not draw the lights');
    assert.ok(/LightTechnique/.test(HTML) && /set\(lighting, 'technique'/.test(HTML), 'the shot card has no technique');
    assert.ok(/ssField\('lighting_technique'/.test(HTML), 'the location sheet has no technique');
    // The page's list of techniques is the library's, in order.
    const m = HTML.match(/const LIGHTING_TECHNIQUE_IDS = Object\.freeze\((\[[^\]]*\])\)/);
    assert.ok(m, 'the page does not declare LIGHTING_TECHNIQUE_IDS');
    assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), Object.keys(L.TECHNIQUES));
});
