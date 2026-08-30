'use strict';

/**
 * -- A brand kit that reaches the frame -------------------------------------
 *
 * The failure this is written against is the one this codebase keeps paying
 * for: a table of fields nobody consults. A brand kit is exactly the shape of
 * thing that becomes a form — fifteen columns, a logo, a palette — so the test
 * is set-based over the fields and asks, per field, whether it reaches a
 * PAYLOAD or is honestly declared as being for a person.
 *
 * A brand OUTLIVES a project, for the reason the style book does: one client
 * buys many spots, and a kit that dies with the project is re-uploaded every
 * time that client comes back.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'fe-brand-'));

const test = require('node:test');
const assert = require('node:assert');

const {
    BRAND_FIELDS, PROMPT_FIELDS, validateBrand, brandPromptContext,
    applyBrandToImagePayload, brandFolder,
} = require('../lib/brand-kit');

const BRAND = {
    id: 'b1', name: 'Acme',
    logo_asset_id: 'asset-1', logo_clear_space: '0.5x cap height',
    palette: JSON.stringify(['#ff0044', '#101010']),
    fonts: JSON.stringify([{ role: 'display', family: 'Inter', weight: '700' }]),
    cta: 'Buy now', cta_url: 'https://acme.example',
    legal_line: 'Terms apply.', banned_phrases: JSON.stringify(['revolutionary']),
    tone: 'dry, confident, never shouty', approval_contact: 'legal@acme.example',
    notes: 'Never show the logo on red.',
};

test('every brand field either reaches a payload or says it is for a person', () => {
    /*
     * The whole point. A field that neither conditions a generation nor is
     * declared as production paperwork is a column somebody fills in believing
     * it does something.
     */
    for (const f of BRAND_FIELDS) {
        assert.ok(f.id && f.label, `a field has no id or label: ${JSON.stringify(f)}`);
        assert.ok(['prompt', 'compliance', 'handoff', 'person'].includes(f.reaches),
            `${f.id} declares reaches="${f.reaches}", which is not one of prompt, compliance, handoff, person`);
        assert.ok(f.why, `${f.id} does not say why it reaches what it reaches`);
    }
    // And the declaration is not vacuous: at least one field of each kind.
    for (const kind of ['prompt', 'compliance', 'handoff', 'person']) {
        assert.ok(BRAND_FIELDS.some(f => f.reaches === kind),
            `no brand field reaches "${kind}" — the vocabulary is bigger than the thing`);
    }
});

test('a field declared to reach the prompt actually changes the prompt', () => {
    /*
     * Differential, not presence-based: change the value, and what a provider
     * would receive must come out different. A field that is READ and discarded
     * looks identical to one that is used.
     */
    for (const f of PROMPT_FIELDS) {
        const before = brandPromptContext(BRAND);
        const after = brandPromptContext({ ...BRAND, [f]: 'ZZTOPMARKER' });
        assert.notEqual(JSON.stringify(before), JSON.stringify(after),
            `${f} is declared to reach the prompt and changing it changes nothing`);
    }
});

test('the prompt context carries the LOOK and never the copy', () => {
    /*
     * A brand's tone and palette belong in a generation. Its CTA, its legal
     * line and its banned phrases do NOT: they are words that go on the screen
     * in Premiere's graphics layer, and putting them in an image prompt asks a
     * diffusion model to render legible text — which it does badly, and which
     * would then be baked into a frame that cost money.
     */
    const ctx = brandPromptContext(BRAND);
    const asText = JSON.stringify(ctx);
    for (const forbidden of ['Buy now', 'Terms apply', 'revolutionary', 'legal@acme.example']) {
        assert.ok(!asText.includes(forbidden),
            `the prompt context carries "${forbidden}" — copy and legal text belong in the graphics layer`);
    }
    assert.ok(asText.includes('dry, confident'), 'the tone does not reach the prompt');
});

test('the brand is applied where consistency already is, and does not fight it', () => {
    const payload = { prompt: 'a blender on a counter', negative_prompt: 'blurry' };
    const out = applyBrandToImagePayload({ ...payload }, BRAND);
    assert.ok(out.prompt.length > payload.prompt.length, 'the brand reached nothing');
    assert.ok(out.prompt.startsWith('a blender on a counter'),
        'the brand leads the prompt — whatever leads is what the image is OF, and it is of the shot');

    // No brand at all is byte-identical. Every film in this tool has none.
    assert.deepEqual(applyBrandToImagePayload({ ...payload }, null), payload);
    assert.deepEqual(applyBrandToImagePayload({ ...payload }, {}), payload);
});

test('validation refuses what the columns cannot hold, and tolerates junk JSON', () => {
    assert.equal(validateBrand(BRAND).valid, true, JSON.stringify(validateBrand(BRAND).errors));
    assert.equal(validateBrand({ name: '' }).valid, false, 'a nameless brand was accepted');

    // A colour that is not a colour: the browser understands "red" and a print
    // document, an export and a contrast calculation do not all agree what it
    // means — the rule the character palette already follows.
    const bad = validateBrand({ ...BRAND, palette: JSON.stringify(['red', '#ff0044']) });
    assert.equal(bad.valid, false, 'a named CSS colour was accepted as a palette entry');
    assert.ok(bad.errors.some(e => /red/.test(e)), 'the offending colour is not named');

    // A malformed JSON column must not throw. It arrives from a database.
    for (const junk of ['not json', '{}', '[', null, undefined]) {
        assert.doesNotThrow(() => validateBrand({ ...BRAND, palette: junk }),
            `validateBrand threw on palette=${JSON.stringify(junk)}`);
        assert.doesNotThrow(() => brandPromptContext({ ...BRAND, fonts: junk }));
    }
});

test('a cta_url must be http(s), because it is rendered as a link', () => {
    // A javascript: URL in something the page renders is a script injection
    // with extra steps — the rule the style book's link classifier already sets.
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
        const out = validateBrand({ ...BRAND, cta_url: bad });
        assert.equal(out.valid, false, `${bad} was accepted as a CTA URL`);
    }
    assert.equal(validateBrand({ ...BRAND, cta_url: '' }).valid, true, 'an empty CTA URL was refused');
});

test('the handoff folder names every file an editor needs, relatively', () => {
    const files = brandFolder(BRAND, [{ id: 'asset-1', file_path: '/abs/logo.png', file_name: 'logo.png' }]);
    const paths = files.map(f => f.path);
    for (const want of ['palette.json', 'legal.txt', 'cta.txt', 'fonts.json']) {
        assert.ok(paths.some(p => p.endsWith(want)), `the brand folder has no ${want}`);
    }
    assert.ok(paths.some(p => /logo/.test(p)), 'the logo is not in the brand folder');

    // Relative, always. An absolute path relinks on exactly one machine, which
    // is the machine it will never be opened on.
    for (const p of paths) {
        assert.ok(!p.startsWith('/') && !/^[a-z]:/i.test(p), `${p} is absolute`);
        assert.ok(!p.includes('..'), `${p} climbs out of the package`);
    }

    // A brand with nothing in it produces nothing rather than empty files.
    assert.deepEqual(brandFolder({ name: 'Bare' }, []), []);
});
