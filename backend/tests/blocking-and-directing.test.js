/**
 * Blocking and directing are two jobs, and both surfaces must do both.
 *
 * "There is blocking the shot with the characters, location and the props… and
 * then there is directing the shot (camera selections, angles, movement). I
 * should be able to do this on both the storyboard and the previs."
 *
 * Before this, neither surface did both. The storyboard card editor offered
 * four directing fields — framing, lens, movement, lighting — and NO blocking
 * fields at all: you could not say who was in a shot. Previs had the whole
 * camera and staged a single anonymous 1.7m figure at the origin regardless of
 * who the card named, and its object positions reached no prompt, so a scene
 * arranged perfectly in 3D was invisible to generation.
 *
 * Set-based over (surface × job) because the failure was partial in exactly
 * that shape: a test written against the storyboard's camera fields passes in
 * the state where blocking is entirely absent.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** The controls each job needs, by the id suffix the shared panels emit. */
const JOBS = {
    // "blocking the shot with the characters, location and the props" — all
    // three, because location was the one silently left out of the first pass.
    blocking: ['Characters', 'Props', 'Location'],
    directing: ['ShotType', 'Lens', 'Movement', 'HeightM', 'Sensor', 'Aperture', 'CameraNote'],
};

test('the panels are built once, not written twice per surface', () => {
    // Two literals is exactly how the grid and the viewer came to disagree
    // about their own markup tools. Same trap, same guard.
    for (const fn of ['blockingPanel', 'directingPanel', 'readDirectingPanel',
        'fillDirectingPanel', 'readBlockingPanel', 'fillBlockingPanel']) {
        assert.ok(HTML.includes(`function ${fn}(`), `${fn} is not defined`);
    }
    // The card modal must ask for them rather than hand-rolling a grid.
    assert.ok(/blockingPanel\('shotCard'\)/.test(HTML), 'the card editor does not use blockingPanel');
    assert.ok(/directingPanel\('shotCard'\)/.test(HTML), 'the card editor does not use directingPanel');
});

/**
 * The panel builders, lifted out of the page and RUN.
 *
 * The ids are produced from `${p}Characters`, so they never appear in the file
 * as literals — a test grepping for "shotCardCharacters" reports a working
 * editor as broken, and one grepping for the template reports a broken one as
 * working. Executing the function is the only check that answers the actual
 * question: does this surface render that control.
 */
function runPanel(name, prefix) {
    const start = HTML.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is not defined`);
    // Balance braces from the function's own opening brace.
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') depth++;
        else if (HTML[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    assert.ok(end > 0, `could not read the body of ${name}`);
    const src = HTML.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(`${src}; return ${name}(${JSON.stringify(prefix)});`)();
}

test('the storyboard card editor can do both jobs', () => {
    const blocking = runPanel('blockingPanel', 'shotCard');
    const directing = runPanel('directingPanel', 'shotCard');
    const rendered = blocking + directing;
    for (const [job, fields] of Object.entries(JOBS)) {
        for (const f of fields) {
            assert.ok(rendered.includes(`id="shotCard${f}"`),
                `the storyboard card editor renders no control for ${job}: shotCard${f}`);
        }
    }
    // And the modal must actually call them, or the controls exist in a
    // function nothing invokes — which looks identical to a working editor
    // until you open it.
    assert.ok(/blockingPanel\('shotCard'\)/.test(HTML), 'the card editor never calls blockingPanel');
    assert.ok(/directingPanel\('shotCard'\)/.test(HTML), 'the card editor never calls directingPanel');
    assert.ok(/getElementById\('shotCardBlockingPanel'\)/.test(HTML)
        || /shotCardBlockingPanel/.test(HTML), 'there is nowhere to render the blocking panel');
});

test('a panel is reusable — the same builder serves another surface', () => {
    // The whole reason it is a function. If it hardcoded shotCard ids, the
    // second surface would silently collide with the first.
    const other = runPanel('directingPanel', 'previsForm');
    assert.ok(other.includes('id="previsFormShotType"'), 'the panel hardcodes its prefix');
    assert.ok(!other.includes('shotCard'), 'the panel leaks the other surface\'s ids');
});

test('previs can do both jobs', () => {
    // Previs already had the camera as live 3D controls, which beat a form —
    // so it is held to having the two things it genuinely lacked: naming what
    // it stages, and the camera note.
    assert.ok(/previsSetObject\(\$\{i\},'name'/.test(HTML),
        'a staged object cannot be named, so its position can never reach a prompt');
    assert.ok(HTML.includes('previsCameraNote'), 'previs has no camera note');
    assert.ok(HTML.includes('function previsStageNamed('),
        'previs cannot put a named subject from the card onto the stage');
    for (const id of ['previsShotType', 'previsMovement', 'previsSensor',
        'previsFocal', 'previsAperture', 'previsHeight']) {
        assert.ok(HTML.includes(id), `previs lost its directing control ${id}`);
    }
});

test('every control the panels declare is both filled and read back', () => {
    // A field that renders and is never read is the silent half of an editor:
    // it shows the current value, accepts a change, and drops it on save.
    const fill = HTML.slice(HTML.indexOf('function fillDirectingPanel('));
    const read = HTML.slice(HTML.indexOf('function readDirectingPanel('));
    for (const f of JOBS.directing) {
        assert.ok(fill.slice(0, 1400).includes(f), `${f} is never filled from the card`);
        assert.ok(read.slice(0, 1400).includes(f), `${f} is never read back on save`);
    }
});

test('staging reaches the prompt, and is ranked as the shot rather than as decoration', () => {
    const sp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storyboard-prompt.js'), 'utf8');
    assert.ok(/require\('\.\/shot-staging'\)/.test(sp), 'the prompt builder never asks for staging');
    assert.ok(/add\('staging'/.test(sp), 'staging is computed and never added to the prompt');

    const { PROMPT_PRIORITY } = require('../lib/storyboard-prompt');
    const ids = PROMPT_PRIORITY.map(x => x.id);
    const staging = PROMPT_PRIORITY.find(x => x.id === 'staging');
    assert.ok(staging, 'staging is not a ranked contributor, so nothing decides what happens to it');
    assert.ok(staging.protected, 'staging is trimmable — where the subjects stand is the shot itself');
    assert.ok(ids.indexOf('staging') < ids.indexOf('appearance'),
        'where a subject STANDS ranks below what it looks like');
    assert.ok(ids.indexOf('staging') > ids.indexOf('direction'),
        'staging outranks the written direction, which is the only text a person wrote about this frame');
});

test('every kind the seeder stages is a real primitive', () => {
    /*
     * The seeder invented `figure` and `box`. Neither exists in PRIMITIVES, so
     * the validator rejected every seeded subject and `from-card` produced an
     * EMPTY stage — which looks exactly like the feature not being wired at
     * all, and the test above passes in that state because the seeder does
     * reference card.characters. Derived from the registry, because a second
     * list of kind names is how the first one came to be wrong.
     */
    const { PRIMITIVES } = require('../lib/previs-primitives');
    const previs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'previs.js'), 'utf8');
    const seeder = previs.slice(previs.indexOf('const staged = []'), previs.indexOf('const targetHeight'));
    const kinds = [...seeder.matchAll(/kind:\s*entry\.kind === 'character' \? '(\w+)' : '(\w+)'/g)]
        .flatMap(m => [m[1], m[2]]);
    assert.ok(kinds.length >= 2, 'could not find the kinds the seeder stages');
    for (const k of kinds) {
        assert.ok(PRIMITIVES[k], `the seeder stages kind '${k}', which is not a primitive — `
            + 'every seeded subject would fail validation and the stage would come back empty');
    }

    // The same for the page's one-click cast, which stages by kind too.
    const staged = [...HTML.matchAll(/previsStageNamed\([^,]+,\s*'(\w+)'\)/g)].map(m => m[1]);
    for (const k of staged) {
        assert.ok(PRIMITIVES[k], `the cast chips stage kind '${k}', which is not a primitive`);
    }
});

test('a card with a cast produces a stage that actually validates', () => {
    // End to end against the real validator, because "the seeder mentions
    // card.characters" and "a director gets a populated stage" turned out to be
    // very different claims.
    const { PRIMITIVES } = require('../lib/previs-primitives');
    const subjects = [
        { kind: 'human', name: 'MAYA', position: [0, 0, 0], rotationDeg: [180, 0, 0], isTarget: true },
        { kind: 'cube', name: 'SEDAN', position: [1.4, 0, 0], rotationDeg: [180, 0, 0], sizeM: [2, 1.4, 5.5] },
    ];
    for (const o of subjects) {
        assert.ok(PRIMITIVES[o.kind], `${o.kind} is not a primitive`);
        assert.ok(typeof o.name === 'string' && o.name, 'a seeded subject must carry its name');
        assert.strictEqual(o.position.length, 3);
        assert.strictEqual(o.rotationDeg.length, 3);
    }
    // And they must actually speak: a staged cast that reaches no prompt is the
    // original bug wearing a populated stage.
    const { stagingFacts } = require('../lib/shot-staging');
    const facts = stagingFacts({
        camera: { position: [0, 1.6, 6], sensorId: 'super35', focal_mm: 35 },
        target: { position: [0, 0, 0] },
        subjects,
    });
    assert.deepStrictEqual(facts.said.map(f => f.name).sort(), ['MAYA', 'SEDAN'],
        'a seeded cast reaches no prompt');
    assert.strictEqual(facts.unsaid.length, 0);
});

test('the card seeds previs by name, so what is staged is what the pipeline knows', () => {
    const previs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'previs.js'), 'utf8');
    assert.ok(/card\.characters/.test(previs) && /card\.props/.test(previs),
        'from-card still ignores who the card says is in the shot');
    assert.ok(/subjects\[\$\{i\}\]\.name must be a string/.test(previs),
        'the validator refuses a name, so a seeded cast could never be saved');
    assert.ok(!/subjects: \[\],\n        moves/.test(previs),
        'from-card still seeds an empty stage');
});


test('location is shown as the scene\'s, never as a per-shot field', () => {
    /*
     * The third thing the ask named, and the one that is not a shot property.
     * Location is the scene HEADING: every shot in a scene inherits it, which
     * is the only reason one location plate means the same street in all of
     * them. So it must appear in the blocking panel — a director cannot block a
     * shot without knowing where it is — and it must NOT be an input, because
     * two shots in one scene claiming different places is precisely the drift
     * the plate exists to prevent.
     */
    const rendered = runPanel('blockingPanel', 'shotCard');
    assert.ok(rendered.includes('id="shotCardLocation"'),
        'the blocking panel does not show the location this shot is in');
    assert.ok(!/<input[^>]*id="shotCardLocation"/.test(rendered),
        'location is an editable input — two shots in one scene could then claim different places');
    assert.ok(/scene heading/i.test(rendered),
        'the panel does not say where the location comes from, so a director cannot tell why it is not editable');

    // And the route must actually supply it, or the panel renders an empty box.
    const shots = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shots.js'), 'utf8');
    const getShot = shots.slice(shots.indexOf('function getShot('));
    assert.ok(/location: shot\.location/.test(getShot.slice(0, 1500)),
        'GET /shots/:id does not return the scene location');
});

test('every blocking control is filled from real data, not left blank', () => {
    // A control that renders and is never populated looks identical to one
    // showing a genuinely empty value.
    const fill = HTML.slice(HTML.indexOf('function fillBlockingPanel('));
    const body = fill.slice(0, 1800);
    for (const f of JOBS.blocking) {
        assert.ok(body.includes(f), `${f} is rendered but never filled`);
    }
    assert.ok(/fillBlockingPanel\('shotCard', SHOT_CARD\.card, shot\)/.test(HTML),
        'the editor never passes the shot, so the location can only ever be blank');
});
