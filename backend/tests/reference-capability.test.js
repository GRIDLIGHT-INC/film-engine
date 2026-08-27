/**
 * Tags are only emitted to a provider that can receive the images.
 *
 * The regression this exists to prevent, which shipped: Meshy's text-to-image
 * takes ai_model, prompt and aspect_ratio — there is no reference-image field.
 * The prompt builder emitted "@maya" and "@suburbanstreet" anyway, and those
 * tags REPLACED the appearance and location descriptions. The model received
 * two meaningless tokens where 500 characters of continuity information used
 * to be, so eight frames came back with a different woman on a different
 * street each time — worse than before the reference work existed.
 *
 * Set-based over the image-capable adapters, because the question is per
 * provider and the answer changes as adapters are added. An example-based test
 * ("meshy does not get tags") passes while a fifth adapter silently repeats it.
 */

const test = require('node:test');
/*
 * These assert what an UNTAGGABLE provider receives, and the local gateway is
 * the untaggable one they use. It is off unless switched on, so without this
 * the config resolves to a refusing adapter and the assertions are about
 * nothing. Set before the registry is required, which caches the answer.
 */
process.env.GRIDLIGHT_ENABLED = '1';
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-refcap-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const providers = require('../lib/providers');
const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');

const IMAGE_ADAPTERS = providers.list().filter(a => a.supports && a.supports('image'));

const CARD = {
    shot_code: '1C',
    description: 'MAYA looks up as a shadow crosses the houses.',
    camera: { shot_type: 'medium', movement: 'tilt-up', lens: '35mm' },
    lighting: { type: 'blue-hour' },
    characters: [{ name: 'MAYA' }],
};
const CHARS = [{ name: 'MAYA', appearance_prompt: 'Mid-30s woman, olive skin, rust-orange cardigan, dark jeans, white sneakers.' }];
const LOC = { name: 'SUBURBAN STREET', description: 'Late-1970s cul-de-sac, faded siding, wet asphalt, basketball hoops.' };

test('every image-capable adapter declares whether it accepts reference images', () => {
    // Undeclared means unknown, and the caller then has to guess — which is how
    // tags reached a provider that could not receive the pictures they name.
    const undeclared = IMAGE_ADAPTERS
        .filter(a => typeof a.supportsReferenceImages !== 'boolean'
                  || typeof a.supportsReferenceTags !== 'boolean')
        .map(a => a.id);
    assert.deepStrictEqual(undeclared, [],
        `these serve image but never say whether references work: ${undeclared.join(', ')}`);
});

test('at least one image provider does accept references', () => {
    // Otherwise the whole tagged-reference path is dead code and the tests
    // below would pass vacuously.
    assert.ok(IMAGE_ADAPTERS.some(a => a.supportsReferenceImages),
        'no image adapter accepts reference images');
});

test('a prompt never carries a tag when references were not attached', () => {
    // The exact failure: "@maya" with nothing behind it, and the description it
    // displaced now missing.
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir');
    assert.ok(!/@\w+/.test(prompt), `untagged build still emitted a tag: ${prompt}`);
    assert.ok(prompt.includes('rust-orange cardigan'),
        'the appearance description is missing and no tag replaced it');
    assert.ok(prompt.includes('cul-de-sac'), 'the location description is missing');
});

test('an explicitly empty reference list falls back to prose, not tags', () => {
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: [] });
    assert.ok(!/@\w+/.test(prompt), 'an empty reference list still produced tags');
    assert.ok(prompt.includes('rust-orange cardigan'), 'prose did not come back');
});

test('tags appear only alongside the references that define them', () => {
    const refs = [{ name: 'MAYA', tag: 'maya', uri: 'data:image/png;base64,AAA' }];
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: refs });

    assert.ok(prompt.includes('@maya'), 'a supplied reference did not produce its tag');
    // The location has no reference here, so it must still be described.
    assert.ok(!prompt.includes('@suburbanstreet'), 'a tag was emitted for an unreferenced subject');
    assert.ok(prompt.includes('cul-de-sac'), 'the unreferenced location lost its description');
});

test('every tag in a prompt has a matching attached reference', () => {
    // The invariant, stated directly: a tag with no image is a token that
    // refers to nothing.
    const refs = [
        { name: 'MAYA', tag: 'maya', uri: 'data:image/png;base64,AAA' },
        { name: 'SUBURBAN STREET', tag: 'suburbanstreet', uri: 'data:image/png;base64,BBB' },
    ];
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: refs });
    const tags = (prompt.match(/@(\w+)/g) || []).map(t => t.slice(1));
    const attached = new Set(refs.map(r => r.tag));
    const dangling = tags.filter(t => !attached.has(t));
    assert.deepStrictEqual(dangling, [], `tags with no attached image: ${dangling.join(', ')}`);
});

test('the storyboard route gates references on the provider that will run', () => {
    // A declaration nothing consults is decoration. The route must ask the
    // lead provider whether references work before gathering them — and both
    // generation paths must do it, since a fix applied to one leaves the other
    // emitting dangling tags.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

    // Exclude the declaration — `function gatherShotReferences(projectId…` is
    // not a call site, and counting it made the gate look one short.
    const gathers = src.split('\n')
        .filter(l => /gatherShotReferences\(projectId/.test(l) && !/^function\s/.test(l.trim()))
        .length;
    const gated = (src.match(/supportsReferenceImages/g) || []).length;
    const tagged = (src.match(/supportsReferenceTags/g) || []).length;

    assert.ok(gathers >= 2, `expected 2+ gather sites, found ${gathers}`);
    assert.ok(gated >= gathers,
        `${gathers} gather site(s) but only ${gated} checked supportsReferenceImages`);
    assert.ok(tagged >= 1, 'nothing checks supportsReferenceTags, so tags reach providers that cannot read them');
});

test('a provider that takes pictures but cannot name them keeps the prose', () => {
    // Meshy conditions on an untagged array. Attaching the plate AND keeping
    // the description is strictly better than either alone — the picture fixes
    // identity, the words survive for a model that cannot read @tags.
    const refs = [{ name: 'MAYA', tag: 'maya', uri: 'data:image/png;base64,AAA' }];
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: refs, tagged: false });

    assert.ok(!/@\w+/.test(prompt), `untaggable provider still got a tag: ${prompt}`);
    assert.ok(prompt.includes('rust-orange cardigan'),
        'the description was dropped for a provider that cannot read tags');
});

/**
 * A prop that is in the shot gets its plate attached.
 *
 * Characters are matched from sceneCard.characters and props from
 * sceneCard.props, and on a real production every card came back with
 * `props: []` — so the prop plates a director had generated, accepted and
 * locked attached to nothing. The grocery bag is central to 1C and the
 * sprinkler opens 1B; both were described in the prompt text and invented
 * per-frame anyway.
 *
 * The card's array is a hint, not the truth. A prop the description names IS in
 * the shot, whoever wrote the card — the same reasoning that made scene
 * presence read action lines rather than only dialogue cues. Matching on the
 * description means a plate attaches because the object is there, not because
 * somebody remembered to list it.
 *
 * Set-based over the ways a prop can be named, because the failure was total:
 * one path was implemented and the other was assumed to be filled in.
 */
const { matchProps } = require('../routes/storyboard');

const PROJECT_PROPS = [
    { id: 'p1', name: 'Grocery bag' },
    { id: 'p2', name: 'Sprinkler' },
    { id: 'p3', name: 'Storm drain' },
];

const PROP_MENTIONS = [
    { id: 'explicit list', card: { props: ['Sprinkler'], description: 'Nothing here.' }, expect: ['Sprinkler'] },
    { id: 'named in the description', card: { props: [], description: 'The sprinkler stops mid-arc.' }, expect: ['Sprinkler'] },
    { id: 'different case', card: { props: [], description: 'A GROCERY BAG on her hip.' }, expect: ['Grocery bag'] },
    { id: 'two words', card: { props: [], description: 'She reaches a storm drain.' }, expect: ['Storm drain'] },
    { id: 'both sources, no duplicate', card: { props: ['Sprinkler'], description: 'The sprinkler ticks.' }, expect: ['Sprinkler'] },
    { id: 'not mentioned at all', card: { props: [], description: 'Empty, ordinary, still.' }, expect: [] },
];

test('a prop is matched however the card names it', () => {
    const broken = [];
    for (const c of PROP_MENTIONS) {
        const got = matchProps(c.card, PROJECT_PROPS).map(p => p.name).sort();
        if (JSON.stringify(got) !== JSON.stringify(c.expect.slice().sort())) {
            broken.push(`${c.id}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a substring is not a mention', () => {
    // "bag" inside "baggage" is not the grocery bag, and a plate attached on a
    // coincidence is a wrong subject in the frame.
    const got = matchProps({ props: [], description: 'She checks the baggage claim.' },
        [{ id: 'p1', name: 'Bag' }]).map(p => p.name);
    assert.deepStrictEqual(got, [], `matched a substring: ${JSON.stringify(got)}`);
});

/**
 * Regenerating one shot must attach the same plates as regenerating the board.
 *
 * regenerateShot never called gatherShotReferences. It relied on the
 * consistency context's references, which carry a `file_path` — a path on OUR
 * disk — while every image adapter reads `uri`/`url`. So the single-shot path
 * ran text-to-image with no plate conditioning at all, and the whole-board path
 * conditioned correctly. Nothing failed and nothing was logged.
 *
 * It stayed hidden because the full prose contracts were carrying the subjects:
 * 1,936 characters describing the car produced a good car without ever looking
 * at its plate. The moment those contracts were shortened — on the correct
 * assumption that a picture was attached — the subject had neither the picture
 * nor the words, and the frame collapsed.
 */
test('the single-shot path attaches plates, not disk paths', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');
    const body = src.slice(src.indexOf('async function regenerateShot('), src.indexOf('async function regenerateShot(') + 12000);

    assert.ok(/gatherShotReferences\(/.test(body),
        'regenerating one shot does not gather its plates, so it generates unconditioned');
    assert.ok(/reference_images: shotRefs/.test(body),
        'the gathered plates are never put on the payload');
});

test('every path that generates a keyframe gathers references the same way', () => {
    // Set-based over the generation entry points, because the divergence was
    // invisible: one path conditioned, one did not, and both reported success.
    //
    // The FOURTH entry is the one that stayed open longest. The shared
    // capability payload gathered no references at all, so an orchestrated
    // pipeline run generated keyframes unconditioned while the board
    // conditioned correctly — and every reference feature added since (prop
    // plates, mood-board style images, the scene anchor) reached three paths
    // out of four. It is listed here rather than in a test of its own, because
    // a gap that lives in a different file is exactly the one a per-file test
    // cannot see.
    const read = f => require('fs').readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8');
    const ENTRY_POINTS = [
        { file: 'routes/storyboard.js', fn: 'generateStoryboard(' },
        { file: 'routes/storyboard.js', fn: 'generateStoryboardStream(' },
        { file: 'routes/storyboard.js', fn: 'regenerateShot(' },
        { file: 'lib/capability-payloads.js', fn: 'loadShotContext(' },
    ];
    const missing = ENTRY_POINTS.filter(({ file, fn }) => {
        const src = read(file);
        const i = src.indexOf('function ' + fn);
        if (i < 0) return true;
        const body = src.slice(i, i + 12000);
        return !/gatherShotReferences\(|shotReferencesFor\(/.test(body);
    }).map(e => `${e.file}:${e.fn}`);
    assert.deepStrictEqual(missing, [],
        `these generate keyframes without gathering plates: ${missing.join(', ')}`);
});

test('the orchestrated payload actually carries the plates, not just a call to gather them', () => {
    // The source check above proves the call exists. This proves the pictures
    // arrive: a prompt that names @maya with no matching image is strictly
    // worse than one that used prose, and that is precisely what a gather whose
    // result never reaches the payload produces.
    const fs = require('fs');
    const os = require('os');
    const crypto = require('crypto');
    process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
        || path.join(os.tmpdir(), 'film-engine-refcap-' + crypto.randomUUID().slice(0, 8));
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');

    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refcap-plate-'));
    const plate = path.join(dir, 'maya.png');
    fs.writeFileSync(plate, png);

    const projectId = generateId(), sceneId = generateId(), shotId = generateId(), charId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Orchestrated');
    db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?, ?, ?, ?)')
        .run(charId, projectId, 'MAYA', 'rust-orange cardigan, dark bob');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({
            shot_code: '1A', action: 'MAYA crosses the street.', characters: ['MAYA'], camera: {},
        }));
    db.prepare(`INSERT INTO film_assets (id, project_id, character_id, asset_type, file_name, file_path, version)
                VALUES (?, ?, ?, 'character_sheet', 'maya.png', ?, 1)`)
        .run(generateId(), projectId, charId, plate);

    const { payload } = buildCapabilityPayload('image', loadShotContext(shotId));
    assert.ok(Array.isArray(payload.reference_images) && payload.reference_images.length,
        'the orchestrated payload gathered plates and then dropped them on the floor');
    assert.ok(payload.reference_images.some(r => /^data:/.test(r.uri || '')),
        'a plate travelled as a disk path, which no provider can read');
});

test('a subject never loses its words unless its picture is in the same payload', () => {
    // The invariant behind the contract-shortening revert, stated as a rule
    // rather than as a story. `@maya` may replace an appearance only when the
    // reference that gives it meaning is attached to the SAME request; a
    // subject that travels with neither is how an establishing shot came back
    // as a product photograph.
    const withPicture = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', {
        references: [{ name: 'MAYA', tag: 'maya', uri: 'data:image/png;base64,AAA' }],
        tagged: true,
    });
    assert.ok(/@maya/.test(withPicture.prompt), 'the attached plate was never named');

    const withoutPicture = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', {});
    assert.ok(!/@maya/.test(withoutPicture.prompt), 'a tag was emitted with no picture to point at');
    assert.ok(withoutPicture.prompt.includes('rust-orange cardigan'),
        'no picture and no words: the subject travels as a bare name');
});

test('a composed prompt is the whole prompt, not a prefix', () => {
    // prompt_override was appended to rather than replaced, so a deliberate
    // 1,573-character composition became 5,024 against a 4,000 ceiling — and a
    // provider truncates the tail, so what survived was exactly the material
    // the composer had chosen to leave out.
    const { applyConsistencyToImagePayload } = require('../lib/consistency-apply');
    const ctx = {
        prompt_additions: ['X'.repeat(1900)],
        prompt_addition_items: [{ text: 'X'.repeat(1900), profile_type: 'prop', subject_name: 'SEDAN' }],
        references: [],
    };
    const composed = 'The whole shot, composed deliberately.';

    const final = applyConsistencyToImagePayload({ prompt: composed }, ctx,
        { maxPromptChars: 4000, promptIsFinal: true });
    assert.strictEqual(final.prompt, composed, 'an override was still appended to');

    // Without the flag the additions still apply, which is the default path.
    const assembled = applyConsistencyToImagePayload({ prompt: composed }, ctx, { maxPromptChars: 4000 });
    assert.ok(assembled.prompt.length > composed.length, 'the default path stopped adding subjects');
});

/**
 * Shortening follows the picture that actually went, not the one that exists.
 *
 * A provider takes three references; a shot can want five. On this film's two
 * biggest frames the card names MAYA, the DRAGON, the sedan and the sewer plate
 * plus the street — so two of those five subjects travel as words alone, and
 * which two is decided by the reference selector, not by the card.
 *
 * Deciding "this subject has a picture, so name it rather than describe it"
 * against the profiles AVAILABLE rather than the references ATTACHED drops a
 * subject's description on precisely the frame whose reference had just been
 * cut for room. That is the failure that turned an establishing shot into a
 * product shot, repeated on the shots that can least afford it.
 */
