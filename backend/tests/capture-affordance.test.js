/**
 * SHOOTING IS NOT UPLOADING, AND ARMING THE UPLOAD WOULD HAVE COST THE LIBRARY.
 *
 * The obvious implementation of "let the phone shoot into a shot" is to put
 * `capture` on the file inputs that already exist. That is a REGRESSION, and it
 * is the reason this file exists: on iOS a file input with no `capture` opens an
 * action sheet offering Take Photo, Photo Library and Browse, while one WITH
 * `capture` goes straight to the camera and the library option is gone. Picking
 * a render made outside Film Engine is the primary use of a plate upload, so
 * arming the existing control would have traded the common case for the new one.
 *
 * So a media control renders TWO affordances: the upload it always had, and a
 * shoot beside it. Both come from the same builder, and which one is offered is
 * DERIVED from the accept type — a bundle importer or a screenplay importer must
 * never open a camera, because a camera cannot produce a .tar.gz.
 *
 * Set-based over the registries the builders actually serve (MEDIA_KINDS for the
 * capability controls, MEDIA_IMPORTS for the plate controls), so a capability or
 * a plate target added later is covered with nothing to remember. The builders
 * are EXECUTED, never grepped: their markup is built from template strings and
 * the attributes appear nowhere in the source as literals, so a grep reports a
 * working control as broken and a broken one as working.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const { MEDIA_KINDS } = require('../lib/media-kinds');
const { MEDIA_IMPORTS } = require('../lib/media-imports');

/** Pull a function out of the page by brace depth — never a character window. */
function fnSource(name) {
    const at = UI.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} is not in the page`);
    let d = 0;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') d++;
        else if (UI[i] === '}' && --d === 0) return UI.slice(at, i + 1);
    }
    throw new Error(`${name} does not close`);
}

/** Run the page's builders in isolation, with the few helpers they reach for. */
function builders() {
    const src = ['esc', 'captureFor', 'shootControl', 'uploadControl', 'mediaUploadControl']
        .map((n) => (UI.includes(`function ${n}(`) ? fnSource(n) : ''))
        .filter(Boolean)
        .join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(`${src}
        return {
            has: (n) => typeof eval(n) === 'function',
            uploadControl: typeof uploadControl === 'function' ? uploadControl : null,
            mediaUploadControl: typeof mediaUploadControl === 'function' ? mediaUploadControl : null,
        };`)();
}

/** Every <input> in a rendered control, as {accept, capture, hasCapture}. */
function inputsOf(html) {
    return [...html.matchAll(/<input\b[^>]*>/g)].map((m) => {
        const tag = m[0];
        const accept = (/accept="([^"]*)"/.exec(tag) || [, ''])[1];
        const cap = /\bcapture(?:="([^"]*)")?/.exec(tag);
        return { tag, accept, capture: cap ? (cap[1] || '') : null, hasCapture: !!cap };
    });
}

/** The capability controls mediaUploadControl serves: everything but `image`. */
const MEDIA_CAPABILITIES = Object.entries(MEDIA_KINDS)
    .filter(([cap]) => cap !== 'image')
    .map(([cap, spec]) => ({ cap, media: spec.media || spec.kind }));

/** The plate targets uploadControl serves. */
const PLATE_TARGETS = Object.entries(MEDIA_IMPORTS)
    .filter(([, s]) => /plate|mood-board/.test(s.target || '') || /plate|mood-board/.test(s.kind || ''))
    .map(([k]) => k);

test('the denominators are real, not an empty set', () => {
    assert.ok(MEDIA_CAPABILITIES.length >= 5,
        `only ${MEDIA_CAPABILITIES.length} media capabilities — the registry read is broken`);
    const b = builders();
    assert.ok(b.uploadControl, 'uploadControl did not survive extraction');
    assert.ok(b.mediaUploadControl, 'mediaUploadControl did not survive extraction');
});

test('every capability control offers a shoot beside its upload', () => {
    const b = builders();
    const bad = [];
    for (const { cap, media } of MEDIA_CAPABILITIES) {
        const html = b.mediaUploadControl(cap, media, 'shot', 'shot-1', {});
        const ins = inputsOf(html);
        if (!ins.some((i) => i.hasCapture)) bad.push(`${cap} (${media}): no capture input`);
        if (!ins.some((i) => !i.hasCapture)) {
            bad.push(`${cap} (${media}): the plain upload is GONE — the library is unreachable`);
        }
    }
    assert.deepStrictEqual(bad, [], `\n  - ${bad.join('\n  - ')}`);
});

test('every plate control offers a shoot beside its upload', () => {
    const b = builders();
    const bad = [];
    for (const target of PLATE_TARGETS.length ? PLATE_TARGETS : ['character-plate']) {
        const html = b.uploadControl(target, '/x', {});
        const ins = inputsOf(html);
        if (!ins.some((i) => i.hasCapture)) bad.push(`${target}: no capture input`);
        if (!ins.some((i) => !i.hasCapture)) bad.push(`${target}: the plain upload is GONE`);
    }
    assert.deepStrictEqual(bad, [], `\n  - ${bad.join('\n  - ')}`);
});

test('the capture value follows the medium, and is not one hardcoded string', () => {
    const b = builders();
    const seen = {};
    for (const { cap, media } of MEDIA_CAPABILITIES) {
        const shot = inputsOf(b.mediaUploadControl(cap, media, 'shot', 's1', {})).find((i) => i.hasCapture);
        assert.ok(shot, `${cap}: no capture input to inspect`);
        seen[media] = shot.capture;
    }
    // A camera medium points at a camera; audio does not name one.
    assert.strictEqual(seen.video, 'environment', 'video should capture from the rear camera');
    assert.strictEqual(seen.audio, '', 'audio capture must not name a camera facing');
    assert.notStrictEqual(seen.video, seen.audio,
        'video and audio produced the same capture value — it is hardcoded, not derived');
});

test('a control whose accept a camera cannot produce is NOT armed', () => {
    /*
     * The derivation has to be able to say no. A bundle importer, a .glb import
     * or a screenplay import that opened the camera would be a bug, and it is
     * exactly what a hardcoded `capture` would produce.
     */
    const NON_MEDIA = ['.tar.gz,.tgz', '.glb,model/gltf-binary', '.fdx,.xml,.fountain,.txt', '.txt,.docx'];
    const captureFor = fnSource('captureFor');
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${captureFor}; return captureFor;`)();
    for (const accept of NON_MEDIA) {
        assert.strictEqual(fn(accept), null,
            `captureFor(${accept}) armed a control a camera cannot fill`);
    }
    assert.strictEqual(fn('image/png,image/jpeg,.png,.jpg,.jpeg'), 'environment');
    assert.strictEqual(fn('video/mp4,.mov'), 'environment');
    assert.strictEqual(fn('audio/wav,.mp3'), '');
});

test('no call site passes capture itself — it comes from the builder', () => {
    /*
     * A per-call-site attribute is how one control gets it and the next does
     * not, which is the failure `uploadControl` was created to end.
     */
    const callSites = [...UI.matchAll(/(?:media)?[uU]ploadControl\([^)]*capture[^)]*\)/g)];
    assert.deepStrictEqual(callSites.map((m) => m[0]), [],
        'a call site is passing capture — it must be derived from the accept type');
});

test('the iOS bundle is re-synced, or the phone runs a page without the change', () => {
    const bundled = fs.readFileSync(path.join(ROOT, 'ios/FilmEngine/Web/index.html'), 'utf8');
    assert.strictEqual(bundled, UI,
        'ios/FilmEngine/Web/index.html has drifted from src/index.html — `cp src/index.html ios/FilmEngine/Web/index.html`');
});
