/**
 * Tagged reference images.
 *
 * Continuity by picture rather than by paragraph. The failures these pin are
 * the ones that would quietly undo the whole point:
 *
 *  - sending more than three references (a hard provider rejection, so every
 *    shot in a batch fails at once);
 *  - two subjects colliding onto one tag, so one silently shadows the other —
 *    the same "wrong person in frame" bug, one level down;
 *  - handing the provider a local filesystem path it cannot read;
 *  - spending a reference slot on the style plate while the character who is
 *    actually in the shot goes unreferenced.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    MAX_REFERENCES, MAX_INLINE_BYTES,
    toTag, assignTags, toDataUri, resolveUri, selectReferences, taggedNames, KIND_RANK,
} = require('../lib/reference-images');

// A real 1x1 PNG, so the data-URI path is exercised against actual bytes.
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-'));
const pngPath = path.join(tmp, 'maya.png');
fs.writeFileSync(pngPath, PNG_1X1);

// ── Tags ────────────────────────────────────────────────────────────────────

test('a tag is a bare lowercase word the prompt can carry', () => {
    // Runway substitutes `@tag` in prompt text, so punctuation or spaces would
    // break the match rather than merely look untidy.
    assert.strictEqual(toTag('MAYA'), 'maya');
    assert.strictEqual(toTag('Maya Chen'), 'mayachen');
    assert.strictEqual(toTag('SUBURBAN STREET'), 'suburbanstreet');
    assert.strictEqual(toTag("O'Brien-Smith"), 'obriensmith');
    for (const empty of ['', '   ', '!!!', null, undefined]) {
        assert.strictEqual(toTag(empty), null, `'${empty}' produced a tag`);
    }
});

test('colliding names get distinct tags rather than shadowing each other', () => {
    // Both slug to 'maya'. A duplicate tag would make one reference silently
    // stand in for the other — precisely the failure references exist to fix.
    const tags = assignTags(['Maya', 'Maya!', 'Maya?']);
    const values = [...tags.values()];
    assert.strictEqual(new Set(values).size, values.length, `duplicate tags: ${values.join(', ')}`);
    assert.ok(values.includes('maya'), 'the first claimant should keep the plain tag');
});

test('every assigned tag is itself a legal tag', () => {
    const tags = assignTags(['Maya Chen', 'Maya Diaz', 'MAYA', 'suburban street']);
    for (const tag of tags.values()) {
        assert.match(tag, /^[a-z0-9]+$/, `'${tag}' is not prompt-safe`);
    }
});

// ── Reaching the provider ───────────────────────────────────────────────────

test('a local file becomes a data URI the provider can actually read', () => {
    const uri = toDataUri(pngPath);
    assert.ok(uri && uri.startsWith('data:image/png;base64,'), 'no data URI produced');
    // Round-trips to the original bytes — a truncated encode would be worse
    // than none, because it fails inside the provider rather than here.
    const decoded = Buffer.from(uri.split(',')[1], 'base64');
    assert.ok(decoded.equals(PNG_1X1), 'the encoded image is not the file');
});

test('an unreadable, empty, oversized or unknown file yields null, never a bad URI', () => {
    const empty = path.join(tmp, 'empty.png');
    fs.writeFileSync(empty, Buffer.alloc(0));
    const huge = path.join(tmp, 'huge.png');
    fs.writeFileSync(huge, Buffer.alloc(MAX_INLINE_BYTES + 1));
    const weird = path.join(tmp, 'plate.tiff');
    fs.writeFileSync(weird, PNG_1X1);

    for (const [label, p] of [
        ['missing', path.join(tmp, 'nope.png')],
        ['empty', empty],
        ['oversized', huge],
        ['unknown type', weird],
        ['null', null],
    ]) {
        assert.strictEqual(toDataUri(p), null, `${label} produced a URI`);
    }
});

test('an http(s) or data URI passes through untouched; a bare path is inlined', () => {
    assert.strictEqual(resolveUri({ uri: 'https://x.test/a.png' }), 'https://x.test/a.png');
    assert.strictEqual(resolveUri({ uri: 'data:image/png;base64,AAA' }), 'data:image/png;base64,AAA');
    assert.ok(resolveUri({ file_path: pngPath }).startsWith('data:image/png;base64,'));
    assert.strictEqual(resolveUri({ file_path: '/no/such/file.png' }), null);
});

// ── Selection ───────────────────────────────────────────────────────────────

const CANDIDATES = [
    { name: 'STYLE PLATE', kind: 'style', file_path: pngPath },
    { name: 'SUBURBAN STREET', kind: 'location', file_path: pngPath },
    { name: 'GROCERY BAG', kind: 'prop', file_path: pngPath },
    { name: 'MAYA', kind: 'character', file_path: pngPath },
];

test('never more than the provider accepts', () => {
    // gen4_image takes 1–3. A fourth is a validation failure, so every shot in
    // a batch fails together — the loudest possible way to get this wrong.
    const picked = selectReferences(CANDIDATES);
    assert.ok(picked.length <= MAX_REFERENCES, `selected ${picked.length}`);
    assert.strictEqual(MAX_REFERENCES, 3);
});

test('identity outranks place, and place outranks everything else', () => {
    // Declared order in the input is deliberately the reverse of the ranking,
    // so a selector that merely preserved input order would fail here.
    const picked = selectReferences(CANDIDATES);
    assert.deepStrictEqual(picked.map(r => r.kind), ['character', 'location', 'prop'],
        'the style plate displaced a subject that is actually in the shot');
});

test('an unreadable plate costs its own slot, not the whole shot', () => {
    const picked = selectReferences([
        { name: 'MAYA', kind: 'character', file_path: '/no/such/file.png' },
        { name: 'SUBURBAN STREET', kind: 'location', file_path: pngPath },
    ]);
    assert.strictEqual(picked.length, 1);
    assert.strictEqual(picked[0].name, 'SUBURBAN STREET');
});

test('every selected reference carries both a uri and a tag', () => {
    for (const ref of selectReferences(CANDIDATES)) {
        assert.ok(ref.uri, `${ref.name} has no uri`);
        assert.match(ref.tag, /^[a-z0-9]+$/, `${ref.name} has an unusable tag '${ref.tag}'`);
    }
});

test('the ranking covers every kind the selector is given', () => {
    // Set-based: a kind added later without a rank would sort to the end
    // silently, which is a decision nobody made.
    for (const kind of ['character', 'location', 'prop', 'style']) {
        assert.ok(typeof KIND_RANK[kind] === 'number', `'${kind}' has no declared priority`);
    }
});

test('taggedNames keys on the upper-cased name the scene card uses', () => {
    // Scene cards say "MAYA"; the character row may say "Maya". A case-sensitive
    // lookup would miss and quietly fall back to prose.
    const map = taggedNames([{ name: 'Maya', tag: 'maya' }]);
    assert.strictEqual(map.get('MAYA'), 'maya');
});

test('no candidates yields no references rather than throwing', () => {
    for (const empty of [[], null, undefined]) {
        assert.deepStrictEqual(selectReferences(empty), []);
    }
});
