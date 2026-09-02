/**
 * An audio file is a card, not a line of text
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "The new audio section is horrible. Each audio file should be its own card
 *  with details about it — format, what it is, etc. I should be able to add a
 *  new audio through either generate or upload."
 *
 * The cue sheet shipped as a one-line row per cue: a title, a badge and three
 * buttons. It says what the cue is CALLED and nothing about the audio — not
 * its format, not how long it runs, not how big it is, not what made it or
 * when. A director choosing between two takes of a score has nothing to choose
 * on.
 *
 * The detail fields are DERIVED from the columns `film_assets` actually has,
 * read from the schema rather than typed here, because a card that invents a
 * field shows a blank where a fact should be — and because the honest set is
 * exactly what the database can answer.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '016_film_music_and_color.sql');

/** The cue vocabulary, from the CHECK that enforces it. */
function cueTypes() {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const m = /CHECK\s*\(cue_type IN \(([^)]+)\)\)/.exec(sql);
    assert.ok(m, 'the cue_type CHECK is gone');
    return [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);
}

/*
 * What a card must say about a file, and the column each fact comes from.
 * Every one of these exists on film_assets today — nothing here is invented,
 * which is the point: a card should report, not guess.
 */
const DETAIL = {
    format: 'format',
    duration: 'duration_ms',
    size: 'size_bytes',
    provider: 'provider',
    made: 'created_at',
};

test('every detail the card promises is a column the database has', () => {
    /*
     * EVERY migration that touches film_assets, not just the one that creates
     * it. `provider` was added by a later ALTER, so scanning only the CREATE
     * reported a column the live table plainly has as missing — a test wrong
     * about the schema is worse than no test, because it is believed.
     *
     * Read from the migrations rather than the live database on purpose:
     * test-isolation forbids a test opening the real one.
     */
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const schema = fs.readdirSync(dir)
        .map(n => fs.readFileSync(path.join(dir, n), 'utf8'))
        .filter(sql => /film_assets/i.test(sql))
        .join('\n');
    assert.ok(/CREATE TABLE[^;]*film_assets/i.test(schema),
        'no migration creates film_assets — the scan is broken');
    const missing = Object.values(DETAIL).filter(col => !new RegExp('\\b' + col + '\\b').test(schema));
    assert.deepStrictEqual(missing, [],
        `the card promises facts the table cannot answer: ${missing.join(', ')}`);
});

test('an audio cue renders as a CARD carrying every detail', () => {
    const gaps = [];
    if (!/function soundCueCard/.test(UI)) gaps.push('there is no soundCueCard renderer');
    if (!/class="snd-card"/.test(UI)) gaps.push('no card element — the cue is still a row');
    for (const [label, col] of Object.entries(DETAIL)) {
        if (!new RegExp(`(?:asset|a)\\.${col}\\b`).test(UI)) {
            gaps.push(`the card never reads ${col}, so it cannot show ${label}`);
        }
    }
    assert.deepStrictEqual(gaps, [], '\n  ' + gaps.join('\n  ') + '\n');
});

test('the card shows a waveform, and the server can produce one', () => {
    const gaps = [];
    if (!fs.existsSync(path.join(__dirname, '..', 'lib', 'waveform.js'))) {
        gaps.push('lib/waveform.js does not exist — nothing can compute peaks');
    }
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    if (!/waveform/.test(server)) gaps.push('server.js dispatches nothing to a waveform route');
    if (!/drawWaveform|snd-wave/.test(UI)) gaps.push('the page never draws a waveform');
    /*
     * And it must be CALLED. Declaring a painter and never invoking it renders
     * every canvas blank, which looks exactly like a waveform that failed to
     * compute — this test passed in precisely that state until a wiring check
     * was added.
     */
    if (!/paintWaveforms\([a-zA-Z]/.test(UI)) gaps.push('paintWaveforms is defined but never called');
    assert.deepStrictEqual(gaps, [], '\n  ' + gaps.join('\n  ') + '\n');
});

test('every category offers BOTH ways to add audio', () => {
    /*
     * "Either generate or upload" — and both must be offered per CATEGORY, not
     * once for the page. A sound effect and a score are added in the same two
     * ways, and a category that only offers one is a category you cannot fill
     * the other way.
     */
    const gaps = [];
    const region = /function renderSoundSheet[\s\S]*?\n    \}/.exec(UI);
    assert.ok(region, 'renderSoundSheet is gone');
    if (!/addSoundCue\(/.test(region[0])) gaps.push('no way to add a cue by generating');
    if (!/mediaUploadControl\([^)]*'cue'/.test(UI)) gaps.push('no way to add audio by uploading');
    assert.deepStrictEqual(gaps, [], '\n  ' + gaps.join('\n  ') + '\n');
    assert.ok(cueTypes().length >= 5, 'the vocabulary shrank');
});

/**
 * A cue with no audio yet must still render a card.
 *
 * This is the one the suite missed. Every assertion above reads the SOURCE —
 * that the card exists, that it names each column — and all of them passed
 * while the Music & Sound page rendered completely blank, with
 * `Cannot read properties of undefined (reading 'toString')` in the status bar.
 *
 * The cause was `(asset && (asset.format || '')).toString()`: with no asset the
 * guard yields `undefined` and `.toString()` throws. Most cues have no asset —
 * that is the normal state of a cue somebody has just written — so ONE
 * ungenerated cue took the whole page down, and the page is where the feature
 * lives.
 *
 * So this EXECUTES the renderer instead of reading it. A source check cannot
 * tell a working card from one that throws on the commonest input it has.
 */
test('a cue with no audio yet renders a card rather than taking the page down', () => {
    const src = UI;
    const CATEGORIES = cueTypes();

    const grab = (name) => {
        const start = src.indexOf(`function ${name}(`);
        assert.ok(start > -1, `${name} is gone`);
        let depth = 0;
        for (let i = src.indexOf('{', start); i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
        }
        throw new Error(`${name} does not close`);
    };

    const preamble = `
        const API_BASE = '';
        const SOUND_CATEGORIES = ${JSON.stringify(CATEGORIES.map(t => ({ type: t, label: t })))};
        function esc(v) { return String(v == null ? '' : v); }
        // Stubbed, not extracted: the upload control is asserted by its own
        // test above, and pulling it in would drag half the page with it.
        function mediaUploadControl() { return '<span class="up"></span>'; }
    `;
    const card = new Function(`${preamble}
        ${grab('fmtDuration')} ${grab('fmtSize')} ${grab('fmtAge')} ${grab('soundCueCard')}
        return soundCueCard;`)();

    // The state every cue starts in: written, not yet generated.
    for (const type of CATEGORIES) {
        const html = card({ id: 'c1', cue_type: type, title: 'A cue' }, undefined);
        assert.match(html, /snd-card/, `an ungenerated ${type} cue renders no card`);
        assert.match(html, /A cue/, `an ungenerated ${type} cue loses its own title`);
    }
    // A null asset is the same state spelled differently, and reaches here from
    // a cue whose generated_asset_id points at a row that has been deleted.
    assert.match(card({ id: 'c2', cue_type: 'score', title: 'B' }, null), /snd-card/);

    // And a generated one still reports what it is.
    const full = card({ id: 'c3', cue_type: 'score', title: 'C' }, {
        id: 'a1', url: '/film/music/p/x.wav', format: 'wav',
        duration_ms: 32000, size_bytes: 3072000, provider: 'elevenlabs',
        created_at: new Date().toISOString(),
    });
    assert.match(full, /WAV/, 'the format is not shown');
    assert.match(full, /0:32/, 'the duration is not shown');
    assert.match(full, /2\.9 MB|3\.1 MB|3 MB/, 'the size is not shown');
    assert.match(full, /elevenlabs/, 'the provider is not shown');
});
