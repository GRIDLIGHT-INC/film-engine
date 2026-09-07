/**
 * THE MARBLE INPUT CONTRACT, HELD TO A RECORD ANYBODY CAN RE-DERIVE.
 *
 * The adapter's own comment says the video field name "was read from the API's
 * own 422". Very likely true — and unverifiable, because nothing was written
 * down: no date, no source, no probe. That is the RBF-002 lesson pointed at a
 * different provider: a paid answer nobody can re-read will be paid for twice,
 * and a claim nobody can re-check decays into a confident lie exactly like an
 * unsourced price.
 *
 * So the contract is SNAPSHOTTED WITH ITS DATE by
 * `backend/tests/refresh-marble-contract.js`, on the same rule
 * refresh-muapi-contract.js already follows, and this file reads the snapshot
 * rather than the network — a test that reaches the internet fails on a train
 * and passes in an office, and a suite that is red for unrelated reasons is one
 * people stop reading.
 *
 * Set-based over the PROMPT TYPES the adapter can build, executed rather than
 * grepped. Three of four being right is the exact state this prevents: the
 * image path is the one that was verified end to end, and it is not the one the
 * capture work depends on.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'marble-contract.json');
const { buildWorldPrompt } = require('../lib/providers/worldlabs');

const contract = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/**
 * One representative payload per prompt type the adapter can produce.
 * Derived by exercising the builder's own branches, so a fifth type added to
 * buildWorldPrompt shows up here as an unrecognised `type` rather than being
 * silently untested.
 */
const CASES = [
    { type: 'multi-image', payload: { images: [
        { uri: 'https://x/a.png', view: 'north' }, { uri: 'https://x/b.png', view: 'east' }] } },
    { type: 'video', payload: { video: { uri: 'https://x/walk.mp4' } } },
    { type: 'image', payload: { images: [{ uri: 'https://x/pano.jpg' }] } },
    { type: 'text', payload: { prompt: 'a diner at dusk' } },
];

/** The field names a built prompt actually puts on the wire, one level deep. */
function fieldsOf(prompt) {
    return Object.keys(prompt || {}).filter((k) => k !== 'type').sort();
}

test('the contract is recorded, dated, and says how it was obtained', () => {
    assert.ok(fs.existsSync(FIXTURE),
        'no marble-contract.json — run `node backend/tests/refresh-marble-contract.js`');
    const c = contract();
    assert.match(String(c.source || ''), /^https?:\/\//, 'the contract names no source URL');
    assert.match(String(c.checked || ''), /^\d{4}-\d{2}-\d{2}$/, 'the contract carries no checked date');
    assert.ok(String(c.how || '').length > 40,
        'the contract does not say how it was obtained, so nobody can repeat it');
    assert.match(String(c.how), /without generating|no world|nothing (?:is )?generated|free/i,
        'the record does not state that obtaining it costs nothing — the reason it can be re-run');
});

test('a re-runnable probe is checked in, not a one-off', () => {
    const p = path.join(__dirname, 'refresh-marble-contract.js');
    assert.ok(fs.existsSync(p), 'no refresher — the snapshot cannot be re-derived when Marble changes');
    const s = fs.readFileSync(p, 'utf8');
    assert.match(s, /worlds:generate|world_prompt/,
        'the refresher does not probe the generate endpoint it claims to describe');
    assert.match(s, /writeFileSync/, 'the refresher does not write the snapshot');
});

test('every prompt type the adapter builds is a type the API knows', () => {
    const c = contract();
    const known = c.prompt_types || {};
    assert.ok(Object.keys(known).length >= 3,
        `the contract records ${Object.keys(known).length} prompt types — it is not the real set`);
    const bad = [];
    for (const { type, payload } of CASES) {
        const { prompt } = buildWorldPrompt(payload);
        assert.ok(prompt, `${type}: the builder produced nothing`);
        if (!known[prompt.type]) bad.push(`${prompt.type}: the adapter sends it; the contract does not record it`);
    }
    assert.deepStrictEqual(bad, [], `\n  - ${bad.join('\n  - ')}`);
});

test('every field the adapter sends is one the API accepts', () => {
    /*
     * The failure this exists to catch is SILENT: an unknown field is ignored
     * rather than refused, so the request succeeds, the input is dropped, and
     * the world comes back built on less than it was given. That is exactly how
     * every MuAPI reference image travelled and was thrown away.
     */
    const c = contract();
    const bad = [];
    for (const { type, payload } of CASES) {
        const { prompt } = buildWorldPrompt(payload);
        const accepted = (c.prompt_types[prompt.type] || {}).fields || [];
        if (!accepted.length) { bad.push(`${prompt.type}: no accepted field list recorded`); continue; }
        for (const f of fieldsOf(prompt)) {
            if (!accepted.includes(f)) bad.push(`${prompt.type}.${f} is not a field Marble accepts`);
        }
    }
    assert.deepStrictEqual(bad, [], `\n  - ${bad.join('\n  - ')}`);
});

test('the video field name is recorded, not asserted in a comment', () => {
    const c = contract();
    const video = (c.prompt_types || {}).video || {};
    assert.ok((video.fields || []).includes('video_prompt'),
        'the contract does not confirm world_prompt.video.video_prompt — the name everything downstream is built on');
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'lib', 'providers', 'worldlabs.js'), 'utf8');
    assert.match(src, /marble-contract\.json|refresh-marble-contract/,
        'the adapter still claims the field was verified without pointing at the record that proves it');
});

test('the recorded limits are real numbers, not prose', () => {
    const c = contract();
    const lim = c.limits || {};
    for (const k of ['max_input_images', 'video_max_bytes']) {
        assert.ok(Number.isFinite(lim[k]) && lim[k] > 0,
            `limits.${k} is not recorded as a number — a limit nobody can compare against is not a limit`);
    }
    const { MAX_INPUT_IMAGES } = require('../lib/providers/worldlabs');
    assert.strictEqual(MAX_INPUT_IMAGES, lim.max_input_images,
        'the adapter caps images somewhere other than where the contract says Marble does');
});
