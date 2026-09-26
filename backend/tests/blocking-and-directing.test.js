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
/*
 * The directing controls, in the vocabulary the panels actually emit.
 *
 * Blocking became a PICKER over the project's own cast rather than two
 * free-text boxes, so its controls are checkboxes rendered from project data
 * and are asserted in tests/direct-shot-ui.test.js, which owns that surface.
 * What stays here is the half this file is uniquely about: previs doing both
 * jobs, and staging reaching the prompt.
 */
const JOBS = {
    directing: ['ShotType', 'Lens', 'Movement', 'HeightM', 'Sensor', 'Aperture', 'Note'],
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

test('a panel is reusable — the same builder serves another surface', () => {
    // The whole reason it is a function. If it hardcoded shotCard ids, the
    // second surface would silently collide with the first.
    const other = runPanel('directingPanel', 'previsForm');
    assert.ok(other.includes('id="previsFormShotType"'), 'the panel hardcodes its prefix');
    assert.ok(!other.includes('shotCard'), 'the panel leaks the other surface\'s ids');
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


