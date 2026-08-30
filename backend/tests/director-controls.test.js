/**
 * Three controls a director asked for, and one question
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  A. "Could we add a full regenerate dialogue button on playback in case we
 *      made changes… are we also sending the details of the scene so the
 *      emotions of the dialogue are accurate?"
 *  B. "Still don't have a way to add details to the music generator when we
 *      want (do not regenerate it again though)."
 *  C. "How does the camera movements saved in previs? What are all the buttons
 *      on the top right… seems like we have a lot of unused or overcomplicated
 *      buttons there."
 *
 * Set-based over the registries, because each of these fails PARTIALLY: a
 * delivery chain that reads a line and ignores a scene, a music field settable
 * in one place and not the other, a toolbar where two of twelve buttons are
 * accounted for. An example test passes in every one of those states.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-controls-' + crypto.randomUUID().slice(0, 8));

const delivery = require('../lib/dialogue-delivery');
const { buildVoicePayload } = require('../lib/dialogue-builder');
const previsUi = require('../lib/previs-toolbar');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const route = f => fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8');
const lib = f => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');

/* ── A. The dialogue, and what decides how it is said ───────────────────── */

const line = (over) => ({ character: 'RAY', line: 'You came.', ...(over || {}) });

test('A1 · the scene\'s own direction reaches the take', () => {
    /*
     * buildVoicePayload took (line, voiceProfile, character) and no scene at
     * all — so "the details of the scene" reached nothing, and every line in a
     * tense scene was read exactly as neutrally as a line in a calm one unless
     * the writer had put a parenthetical on it.
     */
    const plain = buildVoicePayload(line(), null, null);
    const scened = buildVoicePayload(line(), null, null, { scene: { delivery: 'tense, hushed' } });
    assert.notDeepStrictEqual(plain, scened,
        'a scene direction changes nothing about what the provider is asked for');
});

test('A2 · precedence is line, then scene, then character', () => {
    // A cast voice is how someone always sounds; a scene direction is how this
    // scene is played; a parenthetical is how THIS line is said. Each beats
    // the one behind it.
    const character = { name: 'RAY', delivery: 'weary' };
    const scene = { delivery: 'shouting' };

    const fromChar = buildVoicePayload(line(), null, character);
    const fromScene = buildVoicePayload(line(), null, character, { scene });
    const fromLine = buildVoicePayload(line({ direction: 'whispering' }), null, character, { scene });

    assert.notDeepStrictEqual(fromScene, fromChar, 'the scene did not beat the character');
    assert.notDeepStrictEqual(fromLine, fromScene, 'the line did not beat the scene');

    // And the line's own direction is what actually lands.
    const whisper = delivery.DELIVERIES.find(d => d.id === 'whisper');
    assert.equal(fromLine.style, whisper.style);
    assert.equal(fromLine.stability, whisper.stability);
});

test('A3 · every delivery the engine knows can come from a scene', () => {
    /*
     * Set-based over DELIVERIES: a chain that carries "tense" and drops
     * "whisper" is indistinguishable from a working one until the scene that
     * needed the other word.
     */
    const deaf = delivery.DELIVERIES.filter(d => {
        const cue = d.cues[0];
        const p = buildVoicePayload(line(), null, null, { scene: { delivery: cue } });
        return p.style !== d.style || p.stability !== d.stability;
    }).map(d => d.id);
    assert.deepEqual(deaf, [],
        `these deliveries do not reach the payload from a scene: ${deaf.join(', ')}`);
});

test('A4 · nothing is invented for a scene that says nothing', () => {
    // The safety property: a project that has never written a scene direction
    // must build byte-identical payloads.
    const before = buildVoicePayload(line(), null, null);
    for (const scene of [undefined, null, {}, { delivery: '' }, { delivery: '   ' }]) {
        assert.deepStrictEqual(buildVoicePayload(line(), null, null, { scene }), before,
            `an empty scene direction changed the request (${JSON.stringify(scene)})`);
    }
});

test('A5 · playback can regenerate a scene\'s dialogue, and says what that costs', () => {
    /*
     * routes/voice.js has accepted `regenerate` since the reuse-by-hash skip
     * shipped, and nothing on any page sent it — so a director who changed a
     * line or recast a voice had no way to buy the new take from where they
     * were listening to the old one.
     */
    assert.ok(/function pbRegenerateDialogue\(/.test(SRC), 'no way to regenerate the dialogue from Playback');
    assert.ok(/onclick="pbRegenerateDialogue\(/.test(SRC),
        'pbRegenerateDialogue is defined and bound to nothing — indistinguishable from a working page');
    const fn = SRC.match(/async function pbRegenerateDialogue\([\s\S]*?\n    \}/);
    assert.ok(fn, 'pbRegenerateDialogue is not an async function that can be read');
    assert.ok(/regenerate:\s*true/.test(fn[0]),
        'the button does not force regeneration, so an unchanged line is reused and nothing happens');
    assert.ok(/confirmPaidImage\s*\(/.test(fn[0]),
        'a paid action must go through the shared confirmation, which shows the lines it will '
        + 'speak and lets the voice provider and model be chosen');
});

/* ── B. Music details, without buying the cue again ─────────────────────── */

test('B1 · a scene\'s score direction can be written from where the score is', () => {
    // The cue form lives on the Music Cues page behind "+ Music Cue". A
    // director looking at a scene that already HAS a score had no way to say
    // anything about it without generating something.
    assert.ok(/function saveScoreDirection\(/.test(SRC), 'no way to write a score direction per scene');
    assert.ok(/onchange="saveScoreDirection\(/.test(SRC),
        'saveScoreDirection is bound to nothing');
});

test('B2 · writing the direction never generates', () => {
    const fn = SRC.match(/async function saveScoreDirection\([\s\S]*?\n    \}/);
    assert.ok(fn, 'saveScoreDirection is not readable');
    assert.ok(!/\/generate/.test(fn[0]),
        'saving a direction generates — the one thing the director said not to do');
    assert.ok(/music-cues/.test(fn[0]), 'the direction is stored somewhere other than the cue');
});

test('B3 · it edits the scene\'s existing cue rather than making a second one', () => {
    // Two cues on one scene means "the cue" is whichever the query returns
    // first — the same defect two plate rows for one view already caused.
    const fn = SRC.match(/async function saveScoreDirection\([\s\S]*?\n    \}/)[0];
    assert.ok(/method: 'PUT'/.test(fn), 'an existing cue is never updated, only created');
    assert.ok(/cue_type: 'score'/.test(fn), 'the cue it writes is not a score cue');
    assert.ok(/__scoreCues/.test(fn), 'it never looks for the scene\'s existing cue');
    // And the loader must actually fill that lookup, or every save creates a
    // second cue and "the cue" becomes whichever the query returns first.
    assert.ok(/cue_type === 'score' && !scoreCues\[c\.scene_id\]/.test(SRC),
        'nothing classifies a scene\'s existing score cue, so the lookup is always empty');
});

/* ── C. The previs toolbar ──────────────────────────────────────────────── */

test('C1 · every control in the toolbar is accounted for', () => {
    /*
     * Twelve buttons on one row, three of them saying "save" about three
     * different things — the blocking, the card, and a PNG. The registry is
     * the answer to "what are all these buttons", and it is derived from the
     * page rather than typed beside it.
     */
    const bar = SRC.slice(SRC.indexOf('<h2>Previs</h2>'), SRC.indexOf('<div class="previs-workspace">'));
    // onchange as well as onclick: Import GLB is a file input, and a collector
    // that only reads clicks reports a real control as absent.
    const onPage = [...new Set([...bar.matchAll(
        /on(?:click|change)="(previs[A-Za-z]+|importThreeDModel)\(/g)].map(m => m[1]))];
    /*
     * The shot picker is not a control on the shot — it is what chooses which
     * shot the controls act on. Exempt by name with the reason, on the rule
     * manual-edit.test.js already follows: an exemption matching on shape would
     * quietly excuse the next button that has no explanation.
     */
    const CHROME = ['previsOpenShot'];
    const declared = [...previsUi.PREVIS_CONTROLS.map(c => c.fn), ...CHROME];
    const missing = onPage.filter(f => !declared.includes(f));
    const stale = declared.filter(f => !onPage.includes(f));
    for (const c of CHROME) {
        assert.ok(onPage.includes(c), `${c} is exempted as chrome and is no longer on the toolbar`);
    }
    assert.deepEqual(missing, [], `the toolbar has controls the registry does not explain: ${missing}`);
    assert.deepEqual(stale, [], `the registry names controls the toolbar does not have: ${stale}`);
});

test('C2 · every control says which job it belongs to, and why', () => {
    const groups = new Set(previsUi.PREVIS_GROUPS.map(g => g.id));
    for (const c of previsUi.PREVIS_CONTROLS) {
        assert.ok(groups.has(c.group), `${c.fn} is in no group`);
        assert.ok(c.what && c.what.length > 12, `${c.fn} does not say what it does`);
    }
    // Every group is used — a group with nothing in it is a heading that lies.
    for (const g of previsUi.PREVIS_GROUPS) {
        assert.ok(previsUi.PREVIS_CONTROLS.some(c => c.group === g.id),
            `the group '${g.id}' holds nothing`);
    }
});

test('C3 · the answer to "how is a move saved" is on the page', () => {
    /*
     * Three verbs on one row meant the same word covered a blocking, a scene
     * card and a PNG. The page has to say which one keeps the camera move.
     */
    const saving = previsUi.PREVIS_CONTROLS.filter(c => c.saves);
    assert.ok(saving.length >= 1, 'no control claims to save the move');

    // Specifically THIS one. Four other controls saying they save something is
    // not an answer to "where is my camera move kept" — it is the confusion.
    const blocking = previsUi.PREVIS_CONTROLS.find(c => c.fn === 'previsSave');
    assert.ok(blocking && blocking.saves, 'Save blocking does not say what it saves');
    assert.ok(/camera|move|blocking/i.test(blocking.saves),
        `Save blocking does not claim the camera move: ${blocking.saves}`);
    assert.ok(/Save blocking/.test(previsUi.SAVE_HELP),
        'the help sentence does not name the control that keeps a move');
    for (const c of saving) {
        assert.ok(c.saves.length > 20, `${c.fn} does not say WHAT it saves`);
    }
    assert.ok(/id="previsSaveHelp"/.test(SRC),
        'the page never explains where a camera move is kept');
});

test('C4 · nothing that was reachable stopped being reachable', () => {
    // Regrouping a toolbar is exactly how a control quietly disappears.
    const ui = fs.readFileSync(path.join(__dirname, 'previs-explore-ui.test.js'), 'utf8');
    const ops = [...ui.matchAll(/control: (\/[^/]+\/)/g)].map(m => m[1]);
    assert.ok(ops.length >= 8, 'the explore registry shrank — this test no longer covers what it was written for');
    for (const src of ops) {
        // eslint-disable-next-line no-eval
        const re = eval(src);
        assert.ok(re.test(SRC), `a previs operation lost its control: ${src}`);
    }
});
