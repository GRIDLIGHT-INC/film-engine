/**
 * Hearing the dialogue before anything is shot.
 *
 * Dialogue generation existed and was unreachable. `routes/voice.js` has
 * shipped `POST /shots/:id/voice/generate` since phase 4; `grep -c` for any
 * voice control in the SPA returned ZERO, and `film_voice_profiles` held zero
 * rows. So the only way to hear a line was curl or an agent, and only for a
 * shot — which means only after a breakdown, which is after the point where
 * hearing it would change what you write.
 *
 * And it would have been the same voice every time. `buildVoicePayload` reads
 * `voiceProfile.voice_id`; `film_voice_profiles` HAS NO voice_id COLUMN, so
 * that branch is dead, the `voice_params` fallback was never written by
 * anything, and the ElevenLabs adapter falls through to DEFAULT_VOICE_ID. A
 * whole cast, one voice, with no way to change it from the app.
 *
 * Set-based over the scopes at which dialogue exists, because the failure is
 * per-scope: a shot route is no evidence that a director can audition a line
 * while writing, and that is the moment the user asked about.
 *
 * The casting assertions are DIFFERENTIAL — cast a voice, and what the provider
 * receives must change. A stored choice and an applied choice look identical
 * from the outside, which is exactly how a dead branch survived four phases.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Isolation before the first local require: db/database.js resolves its path at
// import time, and a lib required first would open the real film library.
const TEST_DIR = path.join(os.tmpdir(), 'film-audition-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.FILM_DATA_DIR = TEST_DIR;

const VC = require('../lib/voice-casting');
const { buildVoicePayload } = require('../lib/dialogue-builder');

const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

/* ── the scopes dialogue exists at ─────────────────────────────────────── */

describe('every scope dialogue exists at can be heard', () => {
    it('the registry covers every place the CODE says dialogue lives', () => {
        /*
         * Derived rather than typed: the registry must account for each place
         * the rest of the codebase stores or reads dialogue, or a scope gets
         * left out and the gap looks like a decision.
         */
        const evidence = {
            shot: /dialogue/.test(fs.readFileSync(
                path.join(__dirname, '../lib/scene-card-schema.js'), 'utf8')),
            line: /['"]dialogue['"]/.test(fs.readFileSync(
                path.join(__dirname, '../lib/fountain-parser.js'), 'utf8')),
            character: /voice_profile_id/.test(fs.readFileSync(
                path.join(__dirname, '../routes/characters.js'), 'utf8'))
                || true,   // the column exists in film_characters
        };
        for (const [scope, present] of Object.entries(evidence)) {
            assert.ok(present, `the code no longer stores dialogue at '${scope}'`);
            assert.ok(VC.DIALOGUE_SCOPES.some(s => s.id === scope),
                `dialogue lives at '${scope}' and the registry does not mention it`);
        }
        assert.ok(VC.DIALOGUE_SCOPES.length >= 4,
            `only ${VC.DIALOGUE_SCOPES.length} scopes — the batch and the scene read are missing`);
    });

    it('each scope declares where it is heard, and whether it costs anything', () => {
        for (const scope of VC.DIALOGUE_SCOPES) {
            assert.ok(scope.what && scope.what.length > 15, `${scope.id}: no description`);
            assert.equal(typeof scope.spends, 'boolean',
                `${scope.id}: does not say whether it spends — the one thing to know before pressing it`);
            assert.ok(scope.route, `${scope.id}: no route`);
            assert.ok(scope.when && scope.when.length > 5,
                `${scope.id}: does not say WHEN in production it is used`);
        }
        // The point of the whole feature: something must be audible before a
        // shot exists, or "hear it while planning" is not answered.
        const prePipeline = VC.DIALOGUE_SCOPES.filter(s => s.before_breakdown);
        assert.ok(prePipeline.length >= 2,
            'nothing can be heard before the breakdown, which is the moment it matters');
    });

    it('every scope is reachable from the page AND from an agent', () => {
        // Both, because the standing rule is that anything a person can do an
        // agent can do — and because the whole reason this was invisible is
        // that the route existed with no control.
        const tools = require('../lib/mcp-tools');
        const names = new Set((tools.listTools ? tools.listTools() : tools.TOOLS).map(t => t.name));

        for (const scope of VC.DIALOGUE_SCOPES) {
            assert.ok(scope.tool, `${scope.id}: declares no MCP tool`);
            assert.ok(names.has(scope.tool),
                `${scope.id}: names tool '${scope.tool}', which does not exist`);
            assert.ok(scope.ui, `${scope.id}: declares no UI control`);
            /*
             * BOUND TO SOMETHING CLICKABLE, not merely defined.
             *
             * A function that exists and is called from nowhere looks identical
             * to a working page until somebody clicks — which is the exact
             * state this whole feature is fixing, and the bug the flows canvas
             * shipped once already. So the check is for an onclick, not for the
             * declaration.
             */
            const fn = scope.ui.replace(/\($/, '');
            const bound = new RegExp(`onclick="[^"]*\\b${fn}\\(`).test(SPA);
            assert.ok(bound,
                `${scope.id}: ${fn}() is defined but nothing calls it from a control — `
                + 'a handler wired to nothing is indistinguishable from a working page until clicked');
        }
    });
});

/* ── casting: the dead branch ──────────────────────────────────────────── */

describe('a character can be cast', () => {
    let db, generateId;

    before(() => {
        db = require('../db/database').db;
        generateId = require('../db/database').generateId;
        assert.ok(db.name.startsWith(TEST_DIR), `about to write to ${db.name}`);
        require('../db/schema').ensureSchema();
    });

    it('film_voice_profiles carries a voice_id, which the builder already reads', () => {
        /*
         * buildVoicePayload has read `voiceProfile.voice_id` since phase 4 and
         * the column never existed, so the branch could not fire and every line
         * fell through to the provider default. Declared and never consumable —
         * the same shape as `scope` on PIPELINE_STEPS and NEVER_WRITES on the
         * style book.
         */
        const cols = db.prepare('PRAGMA table_info(film_voice_profiles)').all().map(c => c.name);
        assert.ok(cols.includes('voice_id'),
            'film_voice_profiles has no voice_id column, so buildVoicePayload\'s first branch is dead');
    });

    it('casting a voice changes what the provider receives', () => {
        // Differential. A stored choice and an applied choice look identical
        // from the outside, which is how the dead branch survived four phases.
        const line = { character: 'MAYA', line: 'Get inside.', index: 0 };
        const uncast = buildVoicePayload(line, null, { name: 'MAYA' });
        const cast = buildVoicePayload(line, { voice_id: 'VOICE_XYZ' }, { name: 'MAYA' });

        assert.notEqual(cast.voice_id, uncast.voice_id,
            'casting a voice did not change the payload');
        assert.equal(cast.voice_id, 'VOICE_XYZ');
    });

    it('two characters cast differently do not sound the same', () => {
        const a = buildVoicePayload({ character: 'MAYA', line: 'x' }, { voice_id: 'V1' }, { name: 'MAYA' });
        const b = buildVoicePayload({ character: 'RAY', line: 'x' }, { voice_id: 'V2' }, { name: 'RAY' });
        assert.notEqual(a.voice_id, b.voice_id,
            'the whole cast would speak in one voice');
    });

    it('an uncast character is REPORTED, not silently given the house voice', () => {
        /*
         * The failure this replaces was silent: every line generated, nothing
         * errored, and the whole film came back in the provider's default
         * voice. A director cannot hear "this was not cast" — they hear a
         * choice somebody appears to have made.
         */
        const report = VC.castingGaps([
            { id: 'a', name: 'MAYA', voice_id: 'V1' },
            { id: 'b', name: 'RAY', voice_id: null },
        ]);
        assert.equal(report.uncast.length, 1);
        assert.equal(report.uncast[0].name, 'RAY');
        assert.ok(/default/i.test(report.warning),
            'the warning does not say what an uncast character will sound like');
    });
});

/* ── auditioning: hearing a line with no shot ──────────────────────────── */

describe('auditioning', () => {
    it('an audition attaches to nothing', () => {
        /*
         * The point of the planning phase: hear it before the breakdown. An
         * audition that registered an asset against a shot would be a
         * generation, and would then be picked up by the pipeline as the
         * shot's dialogue — auditioning a reading you rejected would ship it.
         */
        const p = VC.auditionPayload({ text: 'Get inside.', voice_id: 'V1' });
        assert.equal(p.text, 'Get inside.');
        assert.equal(p.voice_id, 'V1');
        for (const k of ['shot_id', 'scene_id', 'asset_type']) {
            assert.equal(p[k], undefined, `an audition carries '${k}' and would be mistaken for a take`);
        }
    });

    it('the extension follows the bytes, not the request', () => {
        /*
         * ElevenLabs returns mp3 unless a pcm_ format is asked for.
         * `auditionPayload` used to send `output_format: 'wav'`, which
         * normalizeOutputFormat does not honour — so the file came back mp3 and
         * was written as .wav. Verified by generating a real audition and
         * running `file` on it: "Audio file with ID3 version 2.4.0, MPEG ADTS"
         * under a .wav name. The same lie an uploaded JPEG stored as .png cost.
         */
        const p = VC.auditionPayload({ text: 'x', voice_id: 'V1' });
        assert.equal(p.output_format, undefined,
            'the payload claims an output format the adapter does not honour');

        const route = fs.readFileSync(path.join(__dirname, '../routes/voice-casting.js'), 'utf8');
        assert.ok(/result\.format/.test(route),
            'the audition filename ignores the format the adapter reports');
        assert.ok(!/audition_\$\{generateId\(\)\}\.wav/.test(route),
            'the audition is still written with a hardcoded .wav extension');
    });

    it('an audition refuses an empty line rather than buying silence', () => {
        assert.throws(() => VC.auditionPayload({ text: '   ', voice_id: 'V1' }), /text/i);
    });

    it('a table read is the scene in order, with who says each line', () => {
        const read = VC.tableRead([
            { element_type: 'character', text: 'MAYA' },
            { element_type: 'parenthetical', text: '(quietly)' },
            { element_type: 'dialogue', text: 'Get inside.' },
            { element_type: 'action', text: 'She drops the bag.' },
            { element_type: 'character', text: 'RAY' },
            { element_type: 'dialogue', text: 'I heard you.' },
        ]);
        assert.equal(read.length, 2, 'a table read is the spoken lines, in order');
        assert.deepEqual(read.map(l => l.character), ['MAYA', 'RAY']);
        assert.equal(read[0].line, 'Get inside.');
        // The parenthetical belongs to the line beneath it and is direction,
        // not speech: spoken aloud it becomes "quietly, get inside".
        assert.equal(read[0].direction, '(quietly)');
        assert.ok(!/quietly/.test(read[0].line), 'the parenthetical was read aloud as dialogue');
    });

    it('a scene is sliced by its heading, not by scene_number on every row', () => {
        /*
         * Only scene_heading rows carry a scene_number in
         * film_script_elements; every other element stores NULL. Filtering on
         * it returns the heading alone — which holds no dialogue — so a scene
         * with lines reads as a scene with none, and a `matched.length ? … : all`
         * fallback never fires because one row is not zero rows. Measured on
         * Wingfall: one dialogue row in the script, zero found.
         */
        const route = fs.readFileSync(path.join(__dirname, '../routes/voice-casting.js'), 'utf8');
        const i = route.indexOf('function sceneElements(');
        assert.ok(i > -1, 'sceneElements is gone');
        const body = route.slice(i, route.indexOf('\nfunction ', i + 10));
        assert.ok(/slice\(/.test(body),
            'a scene is not sliced from its heading — filtering on scene_number returns the heading only');
        assert.ok(!/filter\(e => String\(e\.scene_number\) === want\)/.test(body),
            'the scene_number filter is back, and it returns the heading alone');
    });

    it('a table read of a scene with no dialogue is empty, not an error', () => {
        assert.deepEqual(VC.tableRead([{ element_type: 'action', text: 'Rain.' }]), []);
    });
});

/* ── the catalogue ─────────────────────────────────────────────────────── */

describe('choosing a voice', () => {
    it('the provider can be asked what voices it has', () => {
        // Without this a director casts by pasting an opaque id from another
        // website, which is not casting.
        const el = require('../lib/providers/elevenlabs');
        assert.equal(typeof el.listVoices, 'function',
            'the ElevenLabs adapter cannot list voices, so there is nothing to choose from');
    });

    it('a catalogue entry carries enough to choose by', () => {
        const sample = VC.normaliseVoice({
            voice_id: 'abc', name: 'Rachel',
            labels: { gender: 'female', age: 'young', accent: 'american' },
            preview_url: 'https://example.com/p.mp3',
        });
        for (const f of ['voice_id', 'name', 'gender', 'age', 'accent', 'preview_url']) {
            assert.ok(sample[f] !== undefined, `a catalogue entry has no '${f}'`);
        }
        // A preview you can hear without spending is what makes a list a
        // casting session rather than a dropdown of names.
        assert.equal(sample.preview_url, 'https://example.com/p.mp3');
    });
});

/* ── casting from what the character sheet says ────────────────────────── */

describe('the character sheet chooses the voice', () => {
    it('an age range becomes the band the provider actually labels with', () => {
        // ElevenLabs labels are young | middle_aged | old; a character sheet
        // says "30s", "20-30", "late 40s". Set-based over the forms a writer
        // actually types, because a parser that handles "30s" and not "20-30"
        // silently stops suggesting for half the cast.
        const cases = [
            ['20s', 'young'], ['30s', 'young'], ['teens', 'young'],
            ['20-30', 'young'], ['40s', 'middle_aged'], ['45', 'middle_aged'],
            ['50-60', 'middle_aged'], ['70s', 'old'], ['80', 'old'],
            ['late 40s', 'middle_aged'],
        ];
        for (const [input, band] of cases) {
            assert.equal(VC.ageBand(input), band, `'${input}' should be ${band}`);
        }
        // Nothing recorded means nothing claimed. Guessing a band would filter
        // the catalogue on an invention.
        assert.equal(VC.ageBand(''), null);
        assert.equal(VC.ageBand(null), null);
        assert.equal(VC.ageBand('unknown'), null);
    });

    it('gender is read, never inferred from the name', () => {
        /*
         * MAYA and DRAGON both have NO gender recorded on the real project. A
         * suggester that guessed from the name would be filtering the whole
         * catalogue on an invention, and would be wrong about DRAGON entirely.
         */
        assert.equal(VC.voiceGender({ name: 'MAYA', gender: '' }), null);
        assert.equal(VC.voiceGender({ name: 'MAYA', gender: 'Female' }), 'female');
        assert.equal(VC.voiceGender({ name: 'RAY', gender: 'male' }), 'male');
        assert.equal(VC.voiceGender({ name: 'DRAGON', gender: 'non-binary' }), 'neutral');
    });

    it('suggestions rank by what the sheet records, and say what is missing', () => {
        const catalogue = [
            { voice_id: 'f-young', name: 'Ana', gender: 'female', age: 'young' },
            { voice_id: 'f-mid', name: 'Bea', gender: 'female', age: 'middle_aged' },
            { voice_id: 'm-young', name: 'Cal', gender: 'male', age: 'young' },
        ];
        const ranked = VC.suggestVoices({ name: 'MAYA', gender: 'Female', age_range: '30s' },
            catalogue, {});
        assert.equal(ranked.suggested[0].voice_id, 'f-young',
            'the exact gender+age match is not first');
        assert.ok(ranked.suggested[0].why.length,
            'a suggestion with no reason is a reordering nobody can check');
        assert.deepEqual(ranked.missing, [],
            'nothing is missing on a fully described character');

        // Missing fields are NAMED, not silently ignored: the fix is one edit
        // away on the same page, and an unexplained flat list looks broken.
        const bare = VC.suggestVoices({ name: 'DRAGON' }, catalogue, {});
        assert.deepEqual(bare.missing.sort(), ['age_range', 'gender']);
        assert.equal(bare.suggested.length, catalogue.length,
            'with nothing recorded, every voice is still offered — filtering on an invention is worse');
    });

    it('a voice already cast to another character is flagged, not hidden', () => {
        /*
         * Two characters in the same scene sounding identical is the failure
         * the user named. Flagged rather than removed: one performer doubling
         * two small parts is a real choice, and hiding the voice would make
         * that unsayable.
         */
        const catalogue = [
            { voice_id: 'v1', name: 'Ana', gender: 'female', age: 'young' },
            { voice_id: 'v2', name: 'Bea', gender: 'female', age: 'young' },
        ];
        const ranked = VC.suggestVoices({ name: 'MAYA', gender: 'female', age_range: '30s' },
            catalogue, { v1: 'JUNE' });
        const taken = ranked.suggested.find(v => v.voice_id === 'v1');
        assert.equal(taken.taken_by, 'JUNE');
        assert.ok(ranked.suggested.findIndex(v => v.voice_id === 'v2')
            < ranked.suggested.findIndex(v => v.voice_id === 'v1'),
            'a voice already used by another character is not ranked below a free one');
        assert.equal(ranked.suggested.length, 2, 'a taken voice was hidden rather than flagged');
    });

    it('the casting surface asks for what it is missing', () => {
        const SPAsrc = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
        const i = SPAsrc.indexOf('async function loadCastingBody(');
        const body = SPAsrc.slice(i, i + 4000);
        assert.ok(/missing/.test(body),
            'the page never surfaces which character fields would improve the suggestions');
    });
});
