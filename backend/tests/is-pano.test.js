/**
 * A PANORAMA IS THE INPUT MARBLE CALLS MOST ACCURATE, AND NOTHING COULD ASK FOR ONE.
 *
 * `is_pano` decides whether Marble reads a single image as a 360 panorama or as
 * a flat frame, and its own documentation calls a panorama "maximum control over
 * world layout and the most accurate spatial representation". It was hardcoded
 * `'auto'` at every construction site and the route never accepted it, so the
 * one lever that most improves a reconstruction was unreachable.
 *
 * The DOMAIN comes from the recorded contract, never a list typed here.
 * ICP-004 established it from the API's own refusal — 'auto', True or False —
 * and a picker built from a guess offers values the provider refuses.
 *
 * Set-based over every site that builds an image world_prompt, because the
 * failure is partial by nature: the adapter can honour a caller while the spike
 * script still sends a literal, and only the path someone happens to run is
 * ever noticed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { buildWorldPrompt, PANO_VALUES } = require('../lib/providers/worldlabs');
const contract = () => JSON.parse(src('backend/tests/fixtures/marble-contract.json'));

const IMAGE = { uri: 'https://x/pano.jpg' };

test('the accepted values are the ones the provider actually accepts', () => {
    assert.ok(Array.isArray(PANO_VALUES), 'the adapter does not declare the is_pano domain');
    const recorded = ((contract().prompt_types.image || {}).enums || {}).is_pano;
    assert.ok(Array.isArray(recorded) && recorded.length >= 3,
        `the contract records ${JSON.stringify(recorded)} for is_pano — Marble answers `
        + "\"Input should be 'auto', True or False\", so the record is incomplete and a picker "
        + 'built from it would offer one value');
    assert.deepStrictEqual(
        PANO_VALUES.map(String).sort(), recorded.map(String).sort(),
        'the adapter and the recorded contract disagree about what is_pano accepts');
});

test('a caller can ask for a panorama, and for NOT a panorama', () => {
    assert.strictEqual(buildWorldPrompt({ images: [IMAGE], is_pano: true }).prompt.is_pano, true);
    /*
     * `false` is the case a `||` default silently eats: it is falsy, so
     * `p.is_pano || 'auto'` returns 'auto' and the caller's explicit "this is a
     * flat frame, do not read it as a panorama" is discarded — the answer looks
     * like the feature working.
     */
    assert.strictEqual(buildWorldPrompt({ images: [IMAGE], is_pano: false }).prompt.is_pano, false);
});

test('saying nothing still means auto, and null says nothing', () => {
    assert.strictEqual(buildWorldPrompt({ images: [IMAGE] }).prompt.is_pano, 'auto',
        'omitting is_pano changed behaviour for every world built before this');
    assert.strictEqual(buildWorldPrompt({ images: [IMAGE], is_pano: null }).prompt.is_pano, 'auto',
        'null is a client omitting the field, not a value the provider should be asked about');
});

test('a value the provider would refuse is refused here, with the domain named', () => {
    /*
     * `null` is deliberately NOT here. Absent and null both mean "no opinion" —
     * a client that omits the field and one that sends null are saying the same
     * thing, and refusing the second would make an ordinary JSON body an error.
     * The value is pinned below so that choice is a decision rather than a
     * happy accident of how `undefined` compares.
     */
    for (const bad of ['yes', 'panorama', 1, {}]) {
        assert.throws(
            () => buildWorldPrompt({ images: [IMAGE], is_pano: bad }),
            (e) => /is_pano/.test(e.message) && /auto/.test(e.message),
            `is_pano: ${JSON.stringify(bad)} was accepted, and Marble would refuse the request`);
    }
});

test('no site sends a literal a caller cannot override', () => {
    /*
     * Derived from the source, not listed. `spike-world.js` sent a bare
     * `is_pano: 'auto'` at two sites, so a panorama could not be spiked even
     * from the command line — and the adapter being right would have hidden it.
     */
    const files = ['backend/lib/providers/worldlabs.js', 'backend/spike-world.js', 'backend/routes/worlds.js'];
    const bad = [];
    for (const f of files) {
        for (const line of src(f).split('\n')) {
            const m = /is_pano:\s*(.+?)[,}]/.exec(line);
            if (!m) continue;
            const value = m[1].trim();
            // A bare literal is unreachable from a caller. A reference — even
            // one with a default — is not.
            if (/^'[a-z]+'$/.test(value) || /^(true|false)$/.test(value)) {
                bad.push(`${path.basename(f)}: is_pano: ${value} cannot be set by a caller`);
            }
        }
    }
    assert.deepStrictEqual(bad, [], `\n  - ${bad.join('\n  - ')}`);
});

test('the route carries it through to the provider', () => {
    const routeSrc = src('backend/routes/worlds.js');
    assert.match(routeSrc, /is_pano/,
        'the generate route does not accept is_pano, so nothing reaching it can ask for a panorama');
    // and it must be forwarded, not merely read
    assert.match(routeSrc, /is_pano:\s*body\.is_pano/,
        'is_pano is mentioned but not passed into the generation payload');
});

test('an agent can ask for it too, and is told what it may say', () => {
    const tool = require('../lib/mcp-tools').listTools().find((t) => t.name === 'world_generate');
    assert.ok(tool, 'world_generate is gone');
    // listTools publishes the wire shape, not the declaration: inputSchema.properties.
    const props = (tool.inputSchema && tool.inputSchema.properties) || {};
    assert.ok(props.is_pano, 'world_generate does not expose is_pano');
    const d = String(props.is_pano.description || '');
    for (const v of PANO_VALUES) {
        assert.ok(d.includes(String(v)),
            `the schema does not tell the model it may say ${JSON.stringify(v)}`);
    }
});
