/**
 * What a storyboard frame is sent, held to the director's rules (2026-10-01).
 *
 *   - no geometric plate: the location plate travels, and Previs reaches the
 *     frame as words;
 *   - a subject sent as a picture is NAMED by a reference key, never described:
 *     its description competed with the picture, and a location's description
 *     was the text its EMPTY-set plate was generated from;
 *   - one shot size, from one vocabulary, Previs first: "wide" is never "wide
 *     angle", and a size word in shot_type never sits beside another size;
 *   - the film style can be replaced or removed per shot;
 *   - MuAPI is sent no negative;
 *   - the preview is the generation path stopped at the provider's door.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
const { FRAMINGS, shotFraming, SHOT_TYPE_FRAMING } = require('../lib/framing');

const MANNY = { name: 'MANNY', appearance_prompt: 'APPEARANCE-PROSE a man in a grey suit.' };
const LOC = { name: 'LIMBO', description: 'LOCATION-PROSE an empty white cove, the tabletop completely bare.' };
const BOTTLE = { name: 'THE BOTTLE', visual_prompt: 'PROP-PROSE a matte black bottle.' };
const CARD = { description: 'MANNY stands behind the table with THE BOTTLE.', characters: ['MANNY'],
    props: ['THE BOTTLE'], camera: { shot_type: 'wide', lens: '50mm' } };
const REFS = [
    { name: 'MANNY', kind: 'character', uri: 'data:image/png;base64,AA' },
    { name: 'LIMBO', kind: 'location', uri: 'data:image/png;base64,AA' },
    { name: 'THE BOTTLE', kind: 'prop', uri: 'data:image/png;base64,AA' },
];
const build = (card, refs, style, extra) => buildStoryboardPrompt(card, [MANNY], LOC, style,
    { references: refs, tagged: false, props: [BOTTLE], maxPromptChars: 16000, ...(extra || {}) }).prompt;

test('the shot sizes are the ones the Previs page frames with', () => {
    const block = HTML.slice(HTML.indexOf('const SHOT_FRAMINGS = Object.freeze(['));
    const page = [...block.slice(0, block.indexOf(']);')).matchAll(/id: '(\w+)'[^}]*short: '(\w+)',\s*cover:\s*([\d.]+)/g)]
        .map(m => [m[1], m[2], Number(m[3])]);
    assert.deepEqual(page, FRAMINGS.map(f => [f.id, f.short, f.cover]));
});

test('one shot size, Previs first, then the card, then a size word in shot_type', () => {
    const card = { camera: { shot_type: 'wide', framing: 'mws' } };
    assert.equal(shotFraming(card, { coverage_height_m: 0.4 }).id, 'cu', 'Previs did not win');
    assert.equal(shotFraming(card, {}).id, 'mws', 'the card framing did not win over shot_type');
    assert.equal(shotFraming({ camera: { shot_type: 'wide' } }, null).id, 'ws');
    assert.equal(shotFraming({ camera: { shot_type: 'low-angle' } }, null).id, null, 'an angle invented a size');
    for (const f of FRAMINGS) assert.ok(f.phrase.includes(f.short), `${f.id} phrase does not say its own name`);
});

test('the prompt says exactly one size, and never "wide angle" for a wide shot', () => {
    const plain = build(CARD, REFS, '');
    assert.ok(plain.includes('wide shot (WS)'));
    assert.ok(!/wide angle/i.test(plain), '"wide angle" is a lens, and the shot is on a 50');
    const sized = build({ ...CARD, camera: { ...CARD.camera, framing: 'mws' } }, REFS, '');
    assert.ok(sized.includes('medium wide shot (MWS)'));
    assert.ok(!sized.includes('wide shot (WS)'), 'two sizes in one prompt');
    for (const [type] of Object.entries(SHOT_TYPE_FRAMING)) {
        const p = build({ ...CARD, camera: { shot_type: type, framing: 'ms' } }, REFS, '');
        const sizes = FRAMINGS.filter(f => p.includes(f.phrase));
        assert.equal(sizes.length, 1, `${type}: ${sizes.map(f => f.id)}`);
    }
});

test('a subject sent as a picture is named in the key and not described', () => {
    const p = build(CARD, REFS, '');
    assert.ok(p.startsWith('Reference 1: character MANNY. Reference 2: location LIMBO. Reference 3: prop THE BOTTLE'));
    for (const prose of ['APPEARANCE-PROSE', 'LOCATION-PROSE', 'PROP-PROSE']) {
        assert.ok(!p.includes(prose), `${prose} travelled beside its own picture`);
    }
    // A subject whose picture did NOT travel keeps its words: neither is the failure.
    const none = build(CARD, undefined, '');
    for (const prose of ['APPEARANCE-PROSE', 'LOCATION-PROSE', 'PROP-PROSE']) {
        assert.ok(none.includes(prose), `${prose} vanished with no picture to replace it`);
    }
    const some = build(CARD, REFS.slice(0, 1), '');
    assert.ok(!some.includes('APPEARANCE-PROSE') && some.includes('PROP-PROSE') && some.includes('LOCATION-PROSE'));
});

test('the film style can be replaced or removed for one shot', () => {
    const film = 'FILM-STYLE shallow focus';
    assert.ok(build(CARD, REFS, film).includes('FILM-STYLE'));
    const own = build({ ...CARD, generation: { style: 'SHOT-STYLE flat and sharp' } }, REFS, film);
    assert.ok(own.includes('SHOT-STYLE') && !own.includes('FILM-STYLE'));
    const none = build({ ...CARD, generation: { style: '' } }, REFS, film);
    assert.ok(!none.includes('FILM-STYLE'));
    const { validateSceneCard } = require('../lib/scene-card-schema');
    assert.equal(validateSceneCard({ shot_code: '1A', generation: { style: '' } }).valid, true);
    assert.equal(validateSceneCard({ shot_code: '1A', generation: { style: 4 } }).valid, false);
    assert.equal(validateSceneCard({ shot_code: '1A', camera: { framing: 'mws' } }).valid, true);
    assert.equal(validateSceneCard({ shot_code: '1A', camera: { framing: 'wide' } }).valid, false);
});

test('a locked profile adds no prose for a subject whose picture is attached', () => {
    const { applyConsistencyToImagePayload } = require('../lib/consistency-apply');
    const ctx = {
        prompt_additions: ['CONTRACT-MANNY', 'CONTRACT-LIMBO'],
        prompt_addition_items: [
            { text: 'CONTRACT-MANNY', profile_type: 'character', subject_name: 'MANNY' },
            { text: 'CONTRACT-LIMBO', profile_type: 'location', subject_name: 'LIMBO' },
        ],
    };
    const out = applyConsistencyToImagePayload(
        { prompt: 'shot', reference_images: [REFS[0]] }, ctx, { maxPromptChars: 4000 });
    assert.ok(!out.prompt.includes('CONTRACT-MANNY'), 'described beside its picture');
    assert.ok(out.prompt.includes('CONTRACT-LIMBO'), 'a subject with no picture lost its words');
});

test('MuAPI is sent no negative, and says why', () => {
    const muapi = require('../lib/providers/muapi-image');
    const req = muapi.buildImageRequest({ prompt: 'a cove', negative_prompt: 'softbox, light stand', width: 1920, height: 1080 });
    assert.ok(!JSON.stringify(req).includes('softbox'));
    assert.equal(muapi.adapter.supportsNegativePrompt, false);
    assert.ok(String(muapi.adapter.negativePromptReason || '').length > 20);
});

test('the geometric plate is not gathered for a frame', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'shot-references.js'), 'utf8');
    const body = src.slice(src.indexOf('function gatherShotReferences('));
    assert.ok(!/plateReferenceFor\(/.test(body.slice(0, body.indexOf('\nfunction ', 10))),
        'gatherShotReferences still attaches the plate');
});

test('previewRequest stops at the provider: the adapter is never called, nothing is metered', async () => {
    const providers = require('../lib/providers');
    let called = 0;
    const fake = { id: 'muapi', generate: async () => { called++; return { ok: true }; } };
    const wrapped = providers.withJobRecording(fake, 'image', {});
    const r = await wrapped.generate('image', { prompt: 'a cove', width: 1920, height: 1080 }, { previewRequest: true });
    assert.equal(called, 0);
    assert.equal(r.preview, true);
    assert.ok(r.request && r.request.body && r.request.body.prompt === 'a cove', 'the adapter’s own request was not built');
});

test('the board preview is read from the generation path, and the dry run knows MuAPI', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'storyboard.js'), 'utf8');
    const preview = src.slice(src.indexOf('async function shotPromptPreview('));
    assert.ok(/realBoardRequest\(shotId/.test(preview.slice(0, 4000)));
    assert.ok(/preview: true/.test(src.slice(src.indexOf('async function realBoardRequest('))));
    assert.ok(require('../lib/dry-run').builderFor('muapi', 'image'));
});

test('the Direct panel sets the shot size and shows and edits the style', () => {
    assert.ok(/id="\$\{p\}Framing"/.test(HTML));
    assert.ok(/set\('framing', val\(p \+ 'Framing'\)\)/.test(HTML), 'the size is never saved');
    assert.ok(/id="shotCardStyle"/.test(HTML));
    assert.ok(/body\.generation = \{ \.\.\.\(body\.generation \|\| \{\}\), style: st \}/.test(HTML));
    for (const fn of ['shotCardStyleUseFilm', 'shotCardStyleNone', 'shotCardStyleValue']) {
        assert.ok(HTML.includes(`function ${fn}(`), fn);
    }
});
