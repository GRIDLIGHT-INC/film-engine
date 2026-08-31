/**
 * Directing the sound
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Three things a director could not do: hear the score they had paid for,
 * shape a cue over its own length, and say one word about the ambient bed.
 *
 * The section limits below are asserted against the values PROBED from the
 * live API with deliberately invalid bodies — validation rejects those for
 * free, and every one of them is otherwise a paid request that fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// db/database.js resolves FILM_DATA_DIR at import time, so this must come
// before the first local require or the suite opens the real database.
process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-music-' + crypto.randomUUID().slice(0, 8));

const sections = require('../lib/music-sections');
const { sceneBeds, DEFAULT_BED_GAIN_DB, buildTimeline } = require('../lib/timeline');
const { buildAmbientPrompt, buildMusicPrompt } = require('../lib/music-prompt');

const SRC = path.join(__dirname, '..', '..', 'src', 'index.html');
const LIB = f => path.join(__dirname, '..', 'lib', f);
const ROUTE = f => path.join(__dirname, '..', 'routes', f);
const read = p => fs.readFileSync(p, 'utf8');

// ── 1. The beds reach the assembled film ───────────────────────────────────

const ENTRIES = [
    { index: 0, shot_id: 'a', scene_id: 's1', start_ms: 0, end_ms: 4000 },
    { index: 1, shot_id: 'b', scene_id: 's1', start_ms: 4000, end_ms: 9000 },
    { index: 2, shot_id: 'c', scene_id: 's2', start_ms: 9000, end_ms: 15000 },
];

test('a scene-scoped bed spans its whole scene, not one shot', () => {
    /*
     * The timeline's asset query reads `shot_id IS NOT NULL`, which is right
     * for a shot's picture and its dialogue and excludes a scene's score
     * entirely — so a generated cue was invisible to the assembled film, which
     * from the outside is indistinguishable from it never having generated.
     */
    const beds = sceneBeds(ENTRIES, {
        s1: { audio_music: { file_path: '/x/1_score.mp3', duration_ms: 202000 } },
    }, {});
    assert.equal(beds.length, 1);
    assert.equal(beds[0].kind, 'music');
    assert.equal(beds[0].start_ms, 0);
    assert.equal(beds[0].end_ms, 9000, 'the bed stopped at the end of the first shot of its scene');
});

test('every scene-scoped kind gets a bed, not just the one that was reported', () => {
    // Set-based: music worked and ambient silently did not would look exactly
    // like a working feature to whoever generated a score first.
    const beds = sceneBeds(ENTRIES, {
        s1: { audio_music: { file_path: '/x/s.mp3' }, audio_ambient: { file_path: '/x/a.mp3' } },
        s2: { audio_ambient: { file_path: '/x/a2.mp3' } },
    }, {});
    assert.deepEqual(beds.map(b => `${b.scene_id}:${b.kind}`).sort(),
        ['s1:ambient', 's1:music', 's2:ambient']);
});

test('a bed with no cue sits at the level the finished mix uses', () => {
    // A player at unity is louder than the delivered film and sends everyone
    // reaching for the fader.
    const beds = sceneBeds(ENTRIES, {
        s1: { audio_music: { file_path: '/x/s.mp3' }, audio_ambient: { file_path: '/x/a.mp3' } },
    }, {});
    for (const bed of beds) {
        assert.equal(bed.gain_db, DEFAULT_BED_GAIN_DB[bed.kind]);
    }
    assert.ok(DEFAULT_BED_GAIN_DB.music < 0 && DEFAULT_BED_GAIN_DB.ambient < DEFAULT_BED_GAIN_DB.music,
        'the bed defaults do not match the mix: music under dialogue, ambient under music');
});

test("the cue's own level, fades and offset are honoured", () => {
    /*
     * volume_db, fade_in_ms, fade_out_ms and start_ms have been on
     * film_music_cues since migration 016 and only the offline mixer ever read
     * them. A player that ignores them plays a different mix from the one being
     * delivered.
     */
    const beds = sceneBeds(ENTRIES, { s1: { audio_music: { file_path: '/x/s.mp3' } } }, {
        s1: { music: { id: 'c1', volume_db: -3, fade_in_ms: 1500, fade_out_ms: 2000, start_ms: 2000 } },
    });
    assert.equal(beds[0].gain_db, -3);
    assert.equal(beds[0].fade_in_ms, 1500);
    assert.equal(beds[0].fade_out_ms, 2000);
    // start_ms is an offset INTO THE SCENE — the only reading that survives the
    // scene being moved, and what the mixer has always taken it as.
    assert.equal(beds[0].start_ms, 2000);
    assert.equal(beds[0].cue_id, 'c1');
});

test('buildTimeline carries the beds through, and grows none from nothing', () => {
    // Both halves. Asserting only the empty case passes against a timeline that
    // hardcodes `beds: []` — which is the state the feature was in.
    const shots = [{ id: 'a', shot_code: '1A', scene_id: 's1', scene_number: 1, duration_ms: 4000 }];
    assert.deepEqual(buildTimeline(shots, {}, {}).beds, [], 'a bedless project grew a bed');

    const withBed = buildTimeline(shots, {}, {
        sceneAssets: { s1: { audio_music: { file_path: '/x/1_score.mp3', duration_ms: 40000 } } },
        cues: { s1: { music: { id: 'c', volume_db: -5, fade_in_ms: 0, fade_out_ms: 0, start_ms: 0 } } },
    });
    assert.equal(withBed.beds.length, 1, 'the timeline never passes its scene assets to sceneBeds');
    assert.equal(withBed.beds[0].kind, 'music');
    assert.equal(withBed.beds[0].gain_db, -5);
    assert.equal(withBed.beds[0].end_ms, withBed.entries[0].end_ms);
});

test('the timeline route reads scene-scoped audio and the cues', () => {
    const src = read(ROUTE('timeline.js'));
    assert.ok(/scene_id IS NOT NULL AND a\.shot_id IS NULL/.test(src),
        'the route never selects scene-scoped assets, so no bed can ever exist');
    assert.ok(/audio_music.*audio_ambient|audio_ambient.*audio_music/s.test(src));
    assert.ok(/film_music_cues/.test(src), 'the cue levels and fades are never read');
});

// ── 2. Playing them ────────────────────────────────────────────────────────

test('playback plays each bed, with a switch, and stops it on pause', () => {
    const src = read(SRC);
    for (const id of ['pbMusic', 'pbAmbient', 'pbScore', 'pbAmbient2']) {
        assert.ok(src.includes(`id="${id}"`), `the page has no ${id}`);
    }
    const sync = src.match(/function pbSyncBeds\(\)[\s\S]*?\n    \}/);
    assert.ok(sync, 'nothing puts a bed where the playhead is');
    assert.ok(/checked/.test(sync[0]), 'pbSyncBeds ignores the switches');

    // Bound to what runs every frame AND to the transport — a bed left running
    // after Pause is worse than one that never played.
    const head = src.match(/function updatePlayhead\(\)[\s\S]*?\n    \}/);
    assert.ok(head && /pbSyncBeds\(/.test(head[0]), 'the playhead never syncs the beds');
    const toggle = src.match(/function pbTogglePlay\(\)[\s\S]*?\n    \}/);
    assert.ok(toggle && /pbSyncBeds\(/.test(toggle[0]), 'pausing leaves the score running');
});

test('a bed is seeded once and not restarted at every cut', () => {
    // Reloading a score on each shot boundary is the one behaviour that would
    // make a perfectly good cue sound broken.
    const src = read(SRC);
    const sync = src.match(/function pbSyncBeds\(\)[\s\S]*?\n    \}/)[0];
    assert.ok(/dataset\.bedPath !== src/.test(sync),
        'the bed source is set unconditionally, so it restarts on every frame');
    assert.ok(/Math\.abs\(el\.currentTime - into\) > /.test(sync),
        'currentTime is written every frame, which stutters continuous audio');
});

// ── 3. Sections: the cue over its own length ───────────────────────────────

test('the limits are the ones the API actually enforces', () => {
    // Probed live: "greater than or equal to 3000" / "less than or equal to
    // 120000". Each is otherwise a paid request that fails.
    assert.equal(sections.SECTION_MIN_MS, 3000);
    assert.equal(sections.SECTION_MAX_MS, 120000);
    assert.equal(sections.CUE_MAX_MS, 600000);
});

test('the plan body is the shape the MODEL wants, per model', () => {
    /*
     * Undocumented, and only running it found it: sending v1's shape to v2 is
     * "Invalid type of `composition_plan` used for model music_v2". Which body
     * a model wants is a provider fact, like promptLimit and referenceMode, so
     * the plan arrives neutral and the adapter converts.
     */
    const { buildMusicRequest } = require('../lib/providers/elevenlabs');
    const plan = sections.compositionPlan(['jazz noir'], [
        { name: 'under the argument', direction: 'one held note', duration_ms: 20000, negative: 'drums' },
    ], 'sentimental strings');

    const v2 = buildMusicRequest({ model: 'music_v2', composition_plan: plan }).body;
    assert.ok(Array.isArray(v2.composition_plan.chunks), 'music_v2 must be sent chunks');
    assert.equal(v2.composition_plan.sections, undefined);
    const chunk = v2.composition_plan.chunks[0];
    for (const f of ['text', 'duration_ms', 'positive_styles', 'negative_styles']) {
        assert.ok(f in chunk, `a v2 chunk omits ${f}`);
    }
    // v2 has no globals of its own, so the cue's overall style travels with
    // every chunk — that is the shape, not a workaround.
    assert.ok(chunk.positive_styles.includes('jazz noir'));

    const v1 = buildMusicRequest({ model: 'music_v1', composition_plan: plan }).body;
    assert.ok(Array.isArray(v1.composition_plan.sections), 'music_v1 must be sent sections');
    assert.equal(v1.composition_plan.chunks, undefined);
    for (const f of ['section_name', 'positive_local_styles', 'negative_local_styles', 'duration_ms', 'lines']) {
        assert.ok(f in v1.composition_plan.sections[0], `a v1 section omits ${f}, which the API requires`);
    }
    // `lines` is required even for an instrumental cue — probed: "Field required".
    assert.deepEqual(v1.composition_plan.sections[0].lines, []);
});

test('a plan carries no length and no force_instrumental, and still refuses vocals', () => {
    /*
     * Probed live, both:
     *   "You must not provide `music_length_ms` when passing `composition_plan`."
     *   "`force_instrumental` can only be used with `prompt`."     (undocumented)
     *
     * Dropping the flag silently would lose the protection it exists for —
     * sung vocals over dialogue ruin a scene, and instrumental is the default.
     * The plan says the same thing with a negative.
     */
    const { buildMusicRequest } = require('../lib/providers/elevenlabs');
    const plan = sections.compositionPlan(['jazz'], [
        { name: 'a', direction: 'x', duration_ms: 20000, negative: '' },
    ], '');

    for (const model of ['music_v1', 'music_v2']) {
        const body = buildMusicRequest({ model, composition_plan: plan, duration_s: 40 }).body;
        assert.equal(body.music_length_ms, undefined, `${model}: a length was sent with a plan`);
        assert.equal(body.force_instrumental, undefined, `${model}: force_instrumental was sent with a plan`);
        assert.equal(body.prompt, undefined, `${model}: a prompt was sent with a plan`);
        const negatives = model === 'music_v1'
            ? body.composition_plan.negative_global_styles
            : body.composition_plan.chunks[0].negative_styles;
        assert.ok(negatives.some(n => /vocals/i.test(n)),
            `${model}: an instrumental cue lost its refusal of vocals`);
    }

    // And a cue that WANTS vocals is not given the negative.
    const sung = buildMusicRequest({ model: 'music_v2', composition_plan: plan, vocals: true }).body;
    assert.ok(!sung.composition_plan.chunks[0].negative_styles.some(n => /vocals/i.test(n)));

    // A cue with no plan is byte-identical to what it always sent.
    const plain = buildMusicRequest({ model: 'music_v2', prompt: 'sparse piano', duration_s: 40 }).body;
    assert.equal(plain.composition_plan, undefined);
    assert.equal(plain.music_length_ms, 40000);
    assert.equal(plain.force_instrumental, true);
});

test('sections outside the generator\'s limits are refused, never rounded', () => {
    // Rounding 130s down to 120 gives the director a different piece of music
    // than they asked for, and does it silently.
    const tooLong = sections.validateSections([{ name: 'a', direction: 'x', seconds: 130 }]);
    assert.equal(tooLong.valid, false);
    assert.ok(/120/.test(tooLong.errors[0]) && /split/.test(tooLong.errors[0]),
        `the refusal must name the limit and the fix: ${tooLong.errors[0]}`);

    const tooShort = sections.validateSections([{ name: 'a', direction: 'x', seconds: 1 }]);
    assert.equal(tooShort.valid, false);

    assert.equal(sections.validateSections([{ name: 'a', direction: 'x', seconds: 30 }]).valid, true);
    // A section with no words is the cue's own description repeated.
    assert.equal(sections.validateSections([{ name: 'a', direction: '', seconds: 30 }]).valid, false);
    // Over the whole-cue ceiling.
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, direction: 'x', seconds: 120 }));
    assert.equal(sections.validateSections(many).valid, false);
});

test('a suggested split is structural, and says nothing about the music', () => {
    /*
     * A 202-second scene CANNOT be one section and a director should not have
     * to do that arithmetic. What it must not do is invent the SHAPE of the
     * music, which is the judgement this engine hands to whoever is directing.
     */
    const split = sections.splitToFit(202000, 'sparse piano underscore');
    assert.ok(split.length >= 2, '202s came back as one section, which the API refuses');
    for (const s of split) {
        assert.ok(s.duration_ms >= sections.SECTION_MIN_MS && s.duration_ms <= sections.SECTION_MAX_MS);
        assert.equal(s.direction, 'sparse piano underscore',
            'the split invented a direction for a part the director has not written yet');
    }
    assert.equal(new Set(split.map(s => s.direction)).size, 1,
        'the split gave different parts different music');
});

test('a cue with no sections sends exactly what it sent before', () => {
    // THE safety property: prompt and plan are mutually exclusive, so a cue
    // nobody has sectioned must be byte-identical.
    const scene = { location: 'DINER', int_ext: 'INT', time_of_day: 'DAY', description: 'Two people talk.' };
    const payload = buildMusicPrompt({ mood: 'melancholy', description: 'holds under the dialogue' }, scene, {});
    assert.equal(payload.composition_plan, undefined);
    assert.ok(payload.prompt.length > 0);
    assert.deepEqual(payload.sections, []);
});

test('a plan\'s global styles come from the same parts as the prompt', () => {
    // Re-splitting the finished prompt, or writing a second list beside it, is
    // how a sectioned cue and a plain one come to describe different films.
    const scene = { location: 'DINER', int_ext: 'INT', time_of_day: 'DAY' };
    const payload = buildMusicPrompt({ mood: 'tense', genre: 'noir' }, scene, {});
    assert.ok(Array.isArray(payload.prompt_parts) && payload.prompt_parts.length > 0);
    const plan = sections.compositionPlan(payload.prompt_parts, [], '');
    assert.deepEqual(plan.positive_global_styles, payload.prompt_parts);
});

// ── 4. Ambient direction ───────────────────────────────────────────────────

test('the location\'s sound notes reach the ambient prompt', () => {
    /*
     * `film_locations.sound_notes` has existed since migration 006, has a
     * textarea on the Locations page placeholdered "Traffic two streets over, a
     * screen door, gulls...", and reached nothing but the call sheet. The one
     * field whose entire purpose is to describe how a place SOUNDS was invisible
     * to the only thing that generates how a place sounds.
     */
    const scene = { location: 'THE GLASS HARBOUR DINER', int_ext: 'INT', time_of_day: 'DAY' };
    const without = buildAmbientPrompt(scene, {}).prompt;
    const with_ = buildAmbientPrompt(scene, { sound_notes: 'a screen door, gulls' }).prompt;
    assert.notEqual(without, with_, 'sound_notes changes nothing about the bed');
    assert.ok(/screen door/.test(with_) && /gulls/.test(with_));
});

test('a scene\'s ambient direction leads, and is not invented', () => {
    const scene = { location: 'DINER', int_ext: 'INT', time_of_day: 'DAY' };
    const directed = buildAmbientPrompt(scene, {}, { direction: 'the fridge compressor cuts out halfway through' });
    assert.ok(directed.prompt.startsWith('the fridge compressor cuts out'),
        `the direction must lead — it is the specific thing about THIS scene: ${directed.prompt}`);
    // Nothing invented: a scene with no direction gets what it always got.
    assert.equal(buildAmbientPrompt(scene, {}, {}).prompt, buildAmbientPrompt(scene, {}).prompt);
});

test('the ambient bed is as long as the cut, not a thirty-second default', () => {
    // scene.estimated_duration is 0 on every scene in every real project, and 0
    // is falsy — exactly the defect the SCORE had until it was measured.
    const scene = { location: 'DINER', int_ext: 'INT', time_of_day: 'DAY', estimated_duration: 0 };
    const guessed = buildAmbientPrompt(scene, {}, {});
    assert.equal(guessed.bed_source, 'default');
    const measured = buildAmbientPrompt(scene, {}, { bed_ms: 202000 });
    assert.equal(measured.bed_duration_s, 202);
    assert.equal(measured.bed_source, 'measured');
});

test('every path that builds a bed reads the direction', () => {
    /*
     * Three sites build the ambient payload and three build the music one. A
     * fix applied to two of three means a scene generated from the Music page
     * sounds different from the same scene generated from the batch, and only
     * whoever used the third path ever finds out.
     */
    const route = read(ROUTE('music-gen.js'));
    /*
     * Each call WITH the function it sits in, because the assignment check has
     * to be scoped. Searched file-wide, `const ambient = {}` in the batch path
     * passed on the strength of `const ambient = ambientOptions(...)` in a
     * different function — the same scoping mistake the prop-modal check
     * already paid for.
     */
    const enclosing = (src, at) => {
        const starts = [...src.slice(0, at).matchAll(/\n(?:async )?function \w+\(/g)];
        const from = starts.length ? starts[starts.length - 1].index : 0;
        const next = src.indexOf('\nfunction ', at);
        return src.slice(from, next > 0 ? next : src.length);
    };
    const ambientCalls = [...route.matchAll(/buildAmbientPrompt\([^)]*\)/g)]
        .map(m => ({ text: m[0], scope: enclosing(route, m.index) }));
    assert.ok(ambientCalls.length >= 2, 'the ambient build sites moved');
    for (const { text: call, scope } of ambientCalls) {
        /*
         * The third argument must BE ambientOptions' output -- either called
         * inline, or a variable assigned from it in this file. Matching the
         * name `ambient` alone passed against `const ambient = {}`, which is
         * the failure this check exists for; and refusing a variable outright
         * would forbid an ordinary refactor, which is how a check gets
         * loosened until it protects nothing.
         */
        const arg = (/buildAmbientPrompt\([^,]*,[^,]*,\s*([^)]*)\)/.exec(call) || [])[1] || '';
        const inline = /ambientOptions\(/.test(arg);
        const viaVar = /^[A-Za-z_$][\w$]*$/.test(arg.trim())
            && new RegExp(`\\b${arg.trim()}\\s*=\\s*ambientOptions\\(`).test(scope);
        assert.ok(inline || viaVar,
            `this path generates a bed with no direction and no measured length: ${call}`);
    }
    // Exactly one call to the builder, and it is inside the shared function.
    // Three sites built this independently and the batch one did not even go
    // through cueForScene — so a scene generated from the batch got a
    // thirty-second default where the Music page got its measured length.
    const shared = route.match(/function musicPayloadFor\(scored, scene, project\) \{[\s\S]*?\n\}/);
    assert.ok(shared, 'the shared music builder is gone');
    assert.equal((shared[0].match(/buildMusicPrompt\(/g) || []).length, 1);
    const outside = route.replace(shared[0], '');
    const stray = [...outside.matchAll(/buildMusicPrompt\([^)]*\)/g)].map(m => m[0]);
    assert.deepEqual(stray, [],
        `every music path must go through musicPayloadFor, not the builder: ${stray.join(', ')}`);
    assert.ok((route.match(/musicPayloadFor\(/g) || []).length >= 4,
        'the shared music builder is not used by every path');

    // The orchestrator and the flow canvas too — the whole point of that file.
    const payloads = read(LIB('capability-payloads.js'));
    assert.ok(/buildAmbientPrompt\(ctx\.scene, ctx\.location, ctx\.ambient/.test(payloads),
        'the orchestrated ambient payload ignores the scene\'s direction');
    assert.ok(/ambientCue/.test(payloads), 'loadShotContext never reads an ambient cue');
});

// ── 5. It is settable, everywhere ─────────────────────────────────────────

test('sections and the negative are settable by a person and by an agent', () => {
    const src = read(SRC);
    assert.ok(src.includes('data-field="negative_prompt"'), 'no control for the cue negative');
    assert.ok(src.includes('id="cueSections"') && /function cueAddSection\(\)/.test(src),
        'no section editor');
    assert.ok(/data\.sections = sections/.test(src), 'the section editor never sends anything');

    const tools = require('../lib/mcp-tools').listTools();
    for (const name of ['music_cue_create', 'music_cue_update']) {
        const tool = tools.find(t => t.name === name);
        assert.ok(tool, `${name} is gone`);
        for (const field of ['sections', 'negative_prompt']) {
            assert.ok(tool.inputSchema.properties[field], `${name} cannot set ${field}`);
        }
    }

    // And the route stores them.
    const assets = read(ROUTE('assets.js'));
    assert.ok(/sections_json/.test(assets), 'the cue route never stores sections');
    assert.ok(/negative_prompt/.test(assets), 'the cue route never stores the negative');
    assert.ok(/normalizeCueSections/.test(assets),
        'sections are stored without being checked against the limits');
});

/*
 * The route, exercised. A source check that the word `sections_json` appears
 * passes against a route that writes '[]' into it.
 */
const { db } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleAssets } = require('../routes/assets');

function cueCall(method, urlParts, body) {
    return new Promise(resolve => {
        const res = {
            writeHead(status) { this._s = status; },
            end(payload) { resolve({ status: this._s, body: payload ? JSON.parse(payload) : null }); },
        };
        handleAssets({ method, body }, res, urlParts, {});
    });
}

const PROJECT = 'ad000000-0000-4000-8000-0000000000a1';
test.before(() => {
    db.prepare(`INSERT OR IGNORE INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'p', datetime('now'), datetime('now'))`).run(PROJECT);
});

test('sections and the negative survive a real write and read back', async () => {
    const made = await cueCall('POST', ['film', 'projects', PROJECT, 'music-cues'], {
        cue_type: 'score', title: 'sectioned',
        negative_prompt: 'vocals, sentimental strings',
        sections: [
            { name: 'under the argument', direction: 'one held bass note', seconds: 20, negative: 'drums' },
            { name: 'he says her name', direction: 'muted trumpet enters', seconds: 25 },
        ],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const back = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(made.body.id);
    assert.equal(back.negative_prompt, 'vocals, sentimental strings');
    const stored = JSON.parse(back.sections_json);
    assert.equal(stored.length, 2, 'the sections were stored empty');
    assert.equal(stored[0].name, 'under the argument');
    assert.equal(stored[0].duration_ms, 20000, 'seconds were not converted to milliseconds');
    assert.equal(stored[0].negative, 'drums');

    // A merge, not a swap: refining one sentence must not clear the sections.
    const upd = await cueCall('PUT', ['film', 'music-cues', made.body.id], { description: 'holds under' });
    assert.equal(upd.status, 200);
    assert.equal(JSON.parse(
        db.prepare('SELECT sections_json FROM film_music_cues WHERE id = ?').get(made.body.id).sections_json
    ).length, 2, 'editing the description dropped the sections');

    // Rewriting the sections through the update path stores what was sent.
    const rewritten = await cueCall('PUT', ['film', 'music-cues', made.body.id], {
        sections: [{ name: 'one part', direction: 'sparse, unresolved', seconds: 45 }],
    });
    assert.equal(rewritten.status, 200);
    const after = JSON.parse(
        db.prepare('SELECT sections_json FROM film_music_cues WHERE id = ?').get(made.body.id).sections_json);
    assert.equal(after.length, 1, 'the update stored something other than the sections it was sent');
    assert.equal(after[0].direction, 'sparse, unresolved');
    assert.equal(after[0].duration_ms, 45000);

    // And a section the generator would refuse is refused HERE, for free.
    const bad = await cueCall('POST', ['film', 'projects', PROJECT, 'music-cues'], {
        cue_type: 'score', sections: [{ name: 'a', direction: 'x', seconds: 900 }],
    });
    assert.equal(bad.status, 400, 'a 900-second section was stored and will fail at generation');
    assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length,
        'the refusal must say which section and why');
});

test('every cue verb the route dispatches is reachable through the server', () => {
    /*
     * routes/assets.js has dispatched PUT and DELETE on /film/music-cues/:id
     * since the update route was written, and server.js only ever forwarded
     * `/rights` — so music_cue_update and music_cue_delete were listed,
     * described, schema'd, and answered 404 on every call, and the ambient
     * direction saved from the page would have too. A handler nothing routes to
     * looks identical to a working one until somebody presses it.
     */
    const server = read(path.join(__dirname, '..', 'server.js'));
    assert.ok(/parts\[1\] === 'music-cues' && parts\[2\] && !parts\[3\]/.test(server),
        'the server does not route a bare /film/music-cues/:id, so update and delete 404');

    const assets = read(ROUTE('assets.js'));
    const bare = assets.match(/urlParts\[1\] === 'music-cues' && urlParts\[2\] && !urlParts\[3\][\s\S]{0,400}/);
    assert.ok(bare, 'the cue route no longer handles a bare id');
    for (const verb of ['PUT', 'DELETE']) {
        assert.ok(bare[0].includes(`'${verb}'`), `the route claims no ${verb} — this test is now stale`);
    }
});

test('an ambient direction has somewhere to be written', () => {
    const src = read(SRC);
    assert.ok(/function saveAmbientDirection\(/.test(src), 'nothing writes an ambient direction');
    assert.ok(/onchange="saveAmbientDirection\(/.test(src),
        'saveAmbientDirection is defined and bound to nothing — indistinguishable from a working page');
    assert.ok(/cue_type: 'ambient'/.test(src),
        'the direction is stored somewhere other than as an ambient cue');
});
