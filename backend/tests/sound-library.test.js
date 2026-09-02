/**
 * A scene has SOUNDS, not one score and one ambient
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "The music and sound area is horrible. I'd like to be able to generate
 *  and/or add manually several sounds and categorize them. Right now we can
 *  only have one score and one ambient — what if I want to generate specific
 *  sounds or a new score for a sequence, or test a dialogue in a specific way?"
 *
 * THE DATA MODEL WAS NEVER THE LIMIT. `film_music_cues` (migration 016)
 * declares FIVE cue types and carries no UNIQUE constraint, so many cues per
 * scene have always been storable. The limit is two lines of SELECTION:
 * `cueOfKind` takes `LIMIT 1`, and the page keeps the first cue of each type
 * per scene and silently drops the rest. A director who writes three sound
 * effects gets one, with nothing said.
 *
 * So the denominator is the schema's own CHECK — read from the migration, not
 * typed here, because a sixth cue type added later must appear in this test
 * without anyone remembering. Each type is held to four capabilities, because
 * the failure is PARTIAL by nature: score and ambient can be generated while
 * sfx is refused and `source`/`transition` have no builder at all, and a test
 * written against the score passes in exactly that state.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '016_film_music_and_color.sql');
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'music-gen.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const TIMELINE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'timeline.js'), 'utf8');

/** The cue vocabulary, read from the CHECK constraint that enforces it. */
function cueTypes() {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const m = /CHECK\s*\(cue_type IN \(([^)]+)\)\)/.exec(sql);
    assert.ok(m, 'the cue_type CHECK is gone — this test can no longer read the vocabulary');
    const types = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);
    assert.ok(types.length >= 4, `found only ${types.length} cue types — the scan is broken`);
    return types;
}

const TYPES = cueTypes();

test('the cue vocabulary is read from the schema, and it is more than two', () => {
    assert.ok(TYPES.includes('score') && TYPES.includes('ambient'),
        `the two types that already worked are missing: ${TYPES.join(', ')}`);
    assert.ok(TYPES.length > 2,
        'the schema declares only two cue types, so there is nothing to categorise');
});

test('a scene can hold MANY cues of the same type — nothing selects just one', () => {
    /*
     * Two sites collapse a scene's sounds to one per type. Both are named
     * because fixing one leaves the other: the route would generate the right
     * cue while the page still showed a different one, which is the
     * display-disagrees-with-the-generator failure this codebase has paid for
     * repeatedly.
     */
    const collapses = [];
    if (/cue_type = \?[^;]*LIMIT 1/s.test(ROUTE)) {
        collapses.push('routes/music-gen.js: cueOfKind takes LIMIT 1, so a scene has one cue per type');
    }
    if (/!\w*Cues\[c\.scene_id\]/.test(UI)) {
        collapses.push('src/index.html: the page keeps the FIRST cue of a type per scene and drops the rest');
    }
    /*
     * The THIRD site, and asserted by RUNNING it rather than by grepping.
     * The first version matched the literal [['music',...],['ambient',...]],
     * which is still present on purpose: the object-keyed shape is honoured for
     * back-compat, and 23 existing timeline assertions depend on it. Matching a
     * literal reported working code as broken.
     */
    const { sceneBeds } = require('../lib/timeline');
    const ENTRIES = [{ scene_id: 's1', start_ms: 0, end_ms: 10000 }];
    const three = sceneBeds(ENTRIES, {}, {
        s1: [
            { id: 'a', cue_type: 'sfx', start_ms: 0, asset: { file_path: '/x/1.wav' } },
            { id: 'b', cue_type: 'sfx', start_ms: 2000, asset: { file_path: '/x/2.wav' } },
            { id: 'c', cue_type: 'score', start_ms: 0, asset: { file_path: '/x/3.wav' } },
        ],
    });
    if (three.length !== 3) {
        collapses.push(`lib/timeline.js: three cues on one scene produced ${three.length} beds`);
    }
    if (!three.some(b => b.kind === 'sfx')) {
        collapses.push('lib/timeline.js: an sfx cue produced no bed, so it can never be heard');
    }
    assert.deepStrictEqual(collapses, [], '\n  ' + collapses.join('\n  ') + '\n');
});

test('no cue type is REFUSED by the generator', () => {
    /*
     * Corrected while writing this. I first counted "2 of 5 generatable" from
     * mentions of CUE_KIND_FOR, which is not the dispatch. Reading
     * generateFromCue shows ambient has its own branch and score, source and
     * transition all fall through to the music builder — its own comment says
     * "Score, and the two music kinds beside it". Four of five already work.
     *
     * So the contract is not "each type has a branch" — demanding one would
     * fail a correct fallback. It is that NO type is turned away. Today sfx is:
     * it returns 400 with a hint to a shot route, which is reasonable for
     * effects derived from a scene card and useless to a director who wrote a
     * sound cue and wants that sound.
     */
    const refused = [];
    for (const t of TYPES) {
        const at = ROUTE.indexOf("cue.cue_type === '" + t + "'");
        if (at < 0) continue;                       // no branch: falls through to a builder
        const block = ROUTE.slice(at, at + 1400);
        // Reaching runCueGeneration IS generating. A 400 beside it is input
        // validation ("this cue has no description"), not a refusal of the type.
        if (!/runCueGeneration\(/.test(block)) refused.push(t);
    }
    assert.deepStrictEqual(refused, [],
        `these cue types are refused by generateFromCue: ${refused.join(', ')} — a type the `
        + 'app offers, stores and displays but will not produce audio for is a category with '
        + 'nothing in it');
});
test('every cue type can take an UPLOADED file as its audio', () => {
    // media_upload lands a file as an ASSET. Becoming a CUE's audio — so it
    // mixes, plays back and exports like a generated one — is the thing a
    // director means by "add manually".
    /*
     * Bound to a DISPATCH with comments stripped. The first version matched
     * \`cue.{0,40}(attach|import|upload)\` against the whole file and passed on
     * two sentences of PROSE — "cue is not attach…" and "cue's payload, with its
     * composition plan attach…". A check satisfied by a comment is worse than
     * none: it reports the capability as present while nothing implements it.
     */
    const IMPORTS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'media-import.js'), 'utf8');
    const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const code = (ROUTE + IMPORTS).replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
        .filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    const attaches = /music-cues'[\s\S]{0,90}'audio'/.test(code);
    // And it must be REACHED: a handler nothing dispatches to is indistinguishable
    // from a missing feature -- the /film/locations/:id trap, already paid for once.
    assert.ok(/music-cues' && parts\[2\] && parts\[3\] === 'audio'/.test(SERVER),
        'the cue audio route exists but server.js never dispatches to it');
    assert.ok(attaches,
        "no route attaches an uploaded file to a cue. media_upload lands audio as an ASSET; "
        + "until it can become a CUE's audio it never reaches the mix, the playback or the "
        + "export, so \"add manually\" produces a file nobody hears.");
});

test('the sound surface renders every cue individually, in the sheet design', () => {
    /*
     * "Use the same designs as the character plates." The three subject sheets
     * are built from `ss-region` blocks inside `ss-col` columns; a fourth sheet
     * for sound should be the same furniture, not a new idiom.
     */
    const gaps = [];
    if (!/function renderSoundSheet/.test(UI)) gaps.push('there is no sound sheet renderer');
    if (!/ssSection\('snd-/.test(UI)) gaps.push('the sound surface does not use ssSection regions');
    for (const t of TYPES) {
        if (!new RegExp(`snd-${t}`).test(UI)) gaps.push(`no region for cue type "${t}"`);
    }
    assert.deepStrictEqual(gaps, [], '\n  ' + gaps.join('\n  ') + '\n');
});
