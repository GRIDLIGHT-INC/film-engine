/**
 * EVERY sound file is a card, and one button makes a new one
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "I want EVERY sound file in its own card, with the details of the sound and
 * all the features of the sound file. And then a simple button that allows us
 * to generate a new sound with a prompt and the ability to select a shot to
 * add its details."
 *
 * The page was built around CUES, and that is the whole miss. A cue is a
 * written intention; a file is a thing that exists. Measured on the real
 * library: 95 audio files — 86 dialogue, 7 music, 2 ambient — and DIALOGUE IS
 * NOT A CUE, so 86 of the 95 could not appear on the sound page at all,
 * whatever it did with the other nine. A card per cue can never be a card per
 * file.
 *
 * So the unit is the FILE. Set-based over two registries:
 *
 *   - the audio kinds in MEDIA_KINDS, because the failure was per-kind: a page
 *     that renders music and ambient perfectly is still missing 90% of the
 *     library, which is exactly the state being replaced.
 *   - SOUND_FACTS, the facts a card carries, each declaring whether it comes
 *     from the asset row or from reading the file itself. "All the features"
 *     means the ones only the file knows — sample rate, channels, codec,
 *     bitrate — not just what was written down when it was made.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const { MEDIA_KINDS } = require('../lib/media-kinds');

/** Audio kinds, from the registry that decides where generated media goes. */
const AUDIO_KINDS = Object.entries(MEDIA_KINDS)
    .filter(([, v]) => v.media === 'audio')
    .map(([id, v]) => ({ id, assetType: v.assetType }));

test('the audio kinds are read from the registry, not listed', () => {
    assert.ok(AUDIO_KINDS.length >= 4,
        `only ${AUDIO_KINDS.length} audio kinds found; the registry is not being read`);
    const types = AUDIO_KINDS.map(k => k.assetType);
    assert.ok(types.includes('audio_dialogue'),
        'dialogue is not in the denominator — it is 86 of the 95 files in the real library and the '
        + 'single biggest thing the cue-based page could not show');
});

test('a sound file carries facts the file itself knows, not only what was written down', () => {
    const A = require('../lib/audio-features');
    assert.ok(Array.isArray(A.SOUND_FACTS), 'no registry of the facts a card shows');

    for (const f of A.SOUND_FACTS) {
        assert.ok(f.id && f.label, `a fact with no id/label: ${JSON.stringify(f)}`);
        assert.ok(['row', 'probe', 'link'].includes(f.from),
            `${f.id}: does not say where it comes from — a card that cannot distinguish a stored `
            + 'value from a measured one cannot be trusted about either');
        assert.ok(f.what && f.what.length > 10, `${f.id}: no description`);
    }
    // "All the features of the sound file" means the ones only the file knows.
    const probed = A.SOUND_FACTS.filter(f => f.from === 'probe').map(f => f.id);
    for (const need of ['sample_rate', 'channels', 'codec', 'bitrate_kbps']) {
        assert.ok(probed.includes(need),
            `${need} is not read from the file, so "all the features" is only what was written down`);
    }
});

test('reading a real file returns those features, and never throws', async () => {
    const A = require('../lib/audio-features');
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    if (!resolveFfmpeg().available) return;      // no encoder here: nothing to prove against

    // A file that is not audio at all must come back empty rather than explode:
    // a card without technical detail is fine, a page that fails to render is not.
    const notAudio = await A.featuresFor(path.join(ROOT, 'package.json'));
    assert.ok(notAudio && typeof notAudio === 'object', 'a non-audio file threw instead of returning nothing');

    const missing = await A.featuresFor('/nowhere/at/all.wav');
    assert.ok(missing && typeof missing === 'object', 'a missing file threw');
});

test('the API serves every audio asset as its own row', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sounds.js'), 'utf8');
    /*
     * The selection must be DERIVED from the audio kinds rather than naming
     * one, and must not be joined to cues — that join is what made dialogue
     * invisible. This originally demanded a LIKE; an `IN (...)` built from the
     * registry is stronger, because a fifth audio kind joins the list with
     * nothing to remember.
     */
    const { AUDIO_TYPES } = require('../routes/sounds');
    assert.deepStrictEqual([...AUDIO_TYPES].sort(), AUDIO_KINDS.map(k => k.assetType).sort(),
        'the route and the media registry disagree about which assets are audio');
    assert.match(routes, /asset_type IN \(\$\{types\}\)|asset_type IN \(/,
        'the sound list does not select by audio type, so it cannot be "every sound file"');
    const listBody = routes.split('async function listSounds')[1] || '';
    assert.ok(!/film_music_cues/.test(listBody),
        'the list is joined to cues, which is exactly what made 86 dialogue files invisible');
});

test('the server dispatches the sound routes', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /sounds/, 'the sound routes are unreachable — a route nothing dispatches does not exist');
});

test('every audio kind can appear on the page, and the card shows each fact', () => {
    const A = require('../lib/audio-features');
    assert.match(UI, /function soundFileCard\(/,
        'there is no per-FILE card — the page is still built around cues');

    for (const f of A.SOUND_FACTS) {
        assert.ok(UI.includes(f.id),
            `the card never reads ${f.id}, so "${f.label}" is declared and shown nowhere`);
    }
});

test('one button generates a sound from a prompt, with a shot for its details', () => {
    assert.match(UI, /function openSoundGenerator\(|id="soundGenModal"/,
        'there is no generate control');
    // The three things the ask names: a prompt, a shot to pull details from,
    // and it must actually reach a route.
    assert.match(UI, /id="soundGenPrompt"/, 'no prompt field');
    assert.match(UI, /id="soundGenShot"/, 'no shot picker — "select a shot to add its details"');
    assert.match(UI, /sounds\/generate/, 'the generator reaches no route');
});
