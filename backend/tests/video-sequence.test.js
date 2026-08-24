/**
 * A sequence: several shots, ordered, with a description, generated as one clip.
 *
 * "We must be able to send multiple pictures to generate a specific sequence
 * and details... I should be able to select which shots, and then enter details
 * for the scene so it's as accurate as possible."
 *
 * Video generation took exactly ONE picture — the shot's own keyframe as
 * init_image — so the only thing a director could say about motion was whatever
 * fitted in one still plus a movement word. Where the shot is going, and what
 * it looks like when it gets there, was unsayable.
 *
 * The ceiling is the PROVIDER's, not a number chosen here: Runway's
 * image_to_video takes promptImage as a string or as [{uri, position}] with
 * first and last, so two per generation. N selected shots therefore become N-1
 * segments, stitched. The tests are set-based over the video adapters and over
 * the sequence lengths, because the failure is per-adapter and per-length: two
 * shots is the case everyone tests and three is where ordering and stitching
 * break.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-seq-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

// ── 1. Every video adapter says how many keyframes it takes ─────────────

test('every video adapter declares its keyframe ceiling, with a reason', () => {
    const providers = require('../lib/providers');
    const video = providers.list().filter(e => (e.capabilities || []).includes('video'));
    assert.ok(video.length >= 2, `the video adapter set collapsed (${video.length})`);

    for (const entry of video) {
        assert.ok(Number.isInteger(entry.maxKeyframes) && entry.maxKeyframes >= 1,
            `${entry.id} declares maxKeyframes ${JSON.stringify(entry.maxKeyframes)} — an adapter that `
            + 'does not say will be assumed to take one, and a director’s second keyframe would be '
            + 'dropped with nothing said');
        assert.ok(entry.maxKeyframes <= 2 || entry.keyframeNote,
            `${entry.id} claims more than first/last without saying what endpoint supports it`);
    }
});

// ── 2. Two keyframes actually reach the request ─────────────────────────

test('a first and last frame reach the provider as positioned images', () => {
    const runway = require('../lib/providers/runway');
    const build = runway.buildVideoRequest || runway.__buildVideoRequest;
    assert.ok(typeof build === 'function',
        'runway does not expose its video request builder, so nothing can check what it sends');

    const one = build({ promptText: 'a push in', init_image: 'data:image/png;base64,AAA' });
    assert.strictEqual(one.mode, 'image_to_video');
    assert.ok(one.body.promptImage, 'a single keyframe stopped reaching the request');

    const two = build({
        promptText: 'the dragon crosses the road',
        keyframes: [
            { uri: 'data:image/png;base64,AAA', position: 'first' },
            { uri: 'data:image/png;base64,BBB', position: 'last' },
        ],
    });
    assert.ok(Array.isArray(two.body.promptImage),
        'two keyframes collapsed to one image — the shot has a start and no destination');
    assert.deepStrictEqual(two.body.promptImage.map(i => i.position), ['first', 'last'],
        'the keyframes lost their positions, so which frame is the start is anyone’s guess');
    assert.strictEqual(two.body.promptImage[0].uri, 'data:image/png;base64,AAA');

    /*
     * Over the ceiling, the extra frames are NOT silently dropped. A director
     * who selected four shots and got a two-shot interpolation with no message
     * would read it as the feature not working — the exact failure mode the
     * reference-limit and prompt-ceiling work each hit once.
     */
    const many = build({
        promptText: 'x',
        keyframes: ['a', 'b', 'c', 'd'].map((u, i) => ({ uri: u, position: i === 0 ? 'first' : 'last' })),
    });
    assert.ok(many.body.promptImage.length <= 2, 'more keyframes were sent than the endpoint accepts');
    assert.ok(many.dropped && many.dropped.length,
        'keyframes beyond the ceiling were dropped without saying so');
});

// ── 3. N shots become N-1 segments, in order ────────────────────────────

test('a sequence of any length plans adjacent pairs in order', () => {
    const { planSequence } = require('../lib/video-sequence');

    // Set-based over lengths, because two is the case everyone tests by hand
    // and three is where ordering and stitching first matter.
    for (const n of [1, 2, 3, 5]) {
        const shots = Array.from({ length: n }, (_, i) => ({
            id: `s${i}`, shot_code: `${i + 1}A`, keyframe: `frame-${i}`,
        }));
        const plan = planSequence(shots, { maxKeyframes: 2 });
        assert.strictEqual(plan.segments.length, Math.max(1, n - 1),
            `${n} shots planned ${plan.segments.length} segments`);

        if (n === 1) {
            // One shot is an ordinary single-keyframe generation, not an error.
            assert.strictEqual(plan.segments[0].keyframes.length, 1,
                'a single shot was planned as an interpolation with nothing to interpolate to');
        } else {
            plan.segments.forEach((seg, i) => {
                assert.deepStrictEqual(seg.keyframes.map(k => k.uri), [`frame-${i}`, `frame-${i + 1}`],
                    `segment ${i} does not run from shot ${i} to shot ${i + 1}`);
                assert.deepStrictEqual(seg.keyframes.map(k => k.position), ['first', 'last']);
            });
        }
        assert.strictEqual(plan.needs_stitching, n > 2,
            `${n} shots: stitching decision is wrong`);
    }

    // An adapter that takes one keyframe still produces a usable plan, and says
    // what it could not honour.
    const single = planSequence(
        [{ id: 'a', shot_code: '1A', keyframe: 'f0' }, { id: 'b', shot_code: '1B', keyframe: 'f1' }],
        { maxKeyframes: 1 });
    assert.ok(single.segments.every(s => s.keyframes.length === 1),
        'a one-keyframe adapter was handed two');
    assert.ok(single.degraded,
        'the plan silently became a series of stills instead of an interpolation');
});

// ── 4. A shot with no frame refuses, rather than generating from nothing ─

test('a sequence refuses a shot that has no keyframe', () => {
    const { planSequence } = require('../lib/video-sequence');
    const plan = planSequence([
        { id: 'a', shot_code: '1A', keyframe: 'f0' },
        { id: 'b', shot_code: '1B', keyframe: null },
    ], { maxKeyframes: 2 });
    assert.ok(plan.refused, 'a sequence generated from a shot with no picture');
    assert.ok(/1B/.test(plan.reason || ''),
        'the refusal does not name which shot is missing its frame');
});

// ── 5. The director's description reaches every segment ─────────────────

test('the scene description reaches each segment, with the shots it spans', () => {
    const { planSequence } = require('../lib/video-sequence');
    const shots = [
        { id: 'a', shot_code: '1A', keyframe: 'f0', description: 'MAYA turns' },
        { id: 'b', shot_code: '1B', keyframe: 'f1', description: 'the dragon lands' },
        { id: 'c', shot_code: '1C', keyframe: 'f2', description: 'she runs' },
    ];
    const plan = planSequence(shots, { maxKeyframes: 2, description: 'One continuous move, no cuts.' });
    for (const seg of plan.segments) {
        assert.ok(seg.prompt.includes('One continuous move, no cuts.'),
            'the description a director typed did not reach the segment prompt');
        // Each segment must also say what it is travelling between, or every
        // segment of a five-shot sequence asks for the same thing.
        assert.ok(seg.prompt.includes(seg.from) && seg.prompt.includes(seg.to),
            `segment ${seg.from}→${seg.to} does not name its own endpoints`);
    }
    assert.notStrictEqual(plan.segments[0].prompt, plan.segments[1].prompt,
        'every segment asks for exactly the same thing, so the sequence is three copies of one move');
});

// ── 6. The whole thing, through its real routes ─────────────────────────

test('a sequence is created, planned, refused for a missing frame, and takes an upload', async () => {
    const { handleSequences } = require('../routes/sequences');

    const call = (method, url, body) => new Promise(resolve => {
        const out = [];
        const res = {
            writeHead(status) { this.statusCode = status; return this; },
            end(p) { out.push(p || ''); resolve({ status: this.statusCode || 200, body: JSON.parse(out.join('') || '{}') }); },
        };
        Promise.resolve(handleSequences({ method, url, body: body || {} }, res,
            url.split('?')[0].split('/').filter(Boolean)))
            .then(r => { if (r === false) resolve({ status: 404, body: {} }); })
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });

    const projectId = generateId();
    const sceneId = generateId();
    /*
     * Pinned to a two-keyframe provider on purpose. A project with no config
     * resolves to the local gridlight agent, which honestly declares one
     * keyframe — so the plan correctly degrades and this test would be
     * measuring the degraded path while claiming to measure the interpolated
     * one. The degraded path has its own assertions above.
     */
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(projectId, 'Seq', JSON.stringify({ video: 'runway' }));
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');

    const dir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');

    const shotIds = [];
    ['1A', '1B', '1C'].forEach((code, i) => {
        const id = generateId();
        shotIds.push(id);
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, description: `beat ${i}` }));
        // 1C deliberately has no frame, so the refusal path is exercised on a
        // real row rather than a hand-built object.
        if (code === '1C') return;
        const file = path.join(dir, `${code}.png`);
        fs.writeFileSync(file, png);
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 1)`)
            .run(generateId(), projectId, id, file, `${code}.png`);
    });

    const made = await call('POST', `/film/projects/${projectId}/sequences`,
        { name: 'The crossing', shot_ids: shotIds.slice(0, 2), description: 'One continuous move, blue hour.' });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const seqId = made.body.sequence.id;

    const plan = await call('GET', `/film/sequences/${seqId}/plan`);
    assert.strictEqual(plan.status, 200, JSON.stringify(plan.body));
    assert.strictEqual(plan.body.generations, 1, 'two shots should plan exactly one segment');
    assert.ok(plan.body.segments[0].prompt.includes('One continuous move, blue hour.'),
        'the description did not reach the plan a director reads before paying');
    /*
     * The plan must not carry the pictures. It is read in a browser, and four
     * base64 stills is megabytes spent showing thumbnails the page already has.
     */
    assert.strictEqual(typeof plan.body.segments[0].keyframes, 'number',
        'the plan inlines the frames instead of counting them');

    // Order is the whole point of a sequence, so reordering must change it.
    await call('PUT', `/film/sequences/${seqId}`, { shot_ids: [shotIds[1], shotIds[0]] });
    const reversed = await call('GET', `/film/sequences/${seqId}/plan`);
    assert.strictEqual(reversed.body.segments[0].from, '1B',
        'reordering the shots did not reorder the move');

    // A shot with no frame refuses, and names itself.
    await call('PUT', `/film/sequences/${seqId}`, { shot_ids: shotIds });
    const refused = await call('GET', `/film/sequences/${seqId}/plan`);
    assert.strictEqual(refused.status, 409, 'a sequence with a frameless shot was planned anyway');
    assert.ok(/1C/.test(refused.body.reason || ''), 'the refusal does not name the shot without a frame');

    // And a clip made elsewhere lands on it without generating anything.
    const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(24)]);
    const up = await call('POST', `/film/sequences/${seqId}/import`,
        { data: `data:video/mp4;base64,${MP4.toString('base64')}`, name: 'runway-first-sequence.mp4' });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    assert.ok(up.body.asset_id, 'the uploaded clip registered no asset');
    const after = db.prepare('SELECT status, output_asset_id FROM film_sequences WHERE id = ?').get(seqId);
    assert.strictEqual(after.output_asset_id, up.body.asset_id,
        'the sequence does not point at the clip that was uploaded for it');
    assert.strictEqual(after.status, 'complete');
});

test('the Video Shots surface receives the keyframes its sequence picker uses', async () => {
    const { handleVideoGen } = require('../routes/video-gen');
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Picker');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, 'P1', '{}');
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, version)
                VALUES (?, ?, ?, 'storyboard', ?, 'P1.png', 1)`)
        .run(generateId(), projectId, shotId, path.join(process.env.FILM_DATA_DIR, 'P1.png'));

    const response = await new Promise(resolve => {
        const res = { writeHead(status) { this.statusCode = status; }, end(raw) {
            resolve({ status: this.statusCode, body: JSON.parse(raw) });
        } };
        handleVideoGen({ method: 'GET' }, res, ['film', 'projects', projectId, 'video'], {});
    });
    assert.strictEqual(response.status, 200);
    assert.ok((response.body.assets || []).some(a => a.shot_id === shotId && a.asset_type === 'storyboard'),
        'the picker shares Video Shots assets, but that response omits the keyframe and disables every shot');
});

test('sequence writes refuse foreign-project and duplicate shot ids', async () => {
    const { handleSequences } = require('../routes/sequences');
    const call = (method, url, body) => new Promise(resolve => {
        const res = { writeHead(status) { this.statusCode = status; }, end(raw) {
            resolve({ status: this.statusCode, body: JSON.parse(raw) });
        } };
        Promise.resolve(handleSequences({ method, body: body || {} }, res, url.split('/').filter(Boolean)))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
    const p1 = generateId(), p2 = generateId(), s1 = generateId(), s2 = generateId(), shot = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(p1, 'One');
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(p2, 'Two');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(s1, p1, '1');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(s2, p2, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shot, s2, 'FOREIGN', '{}');

    const foreign = await call('POST', `/film/projects/${p1}/sequences`, { shot_ids: [shot] });
    assert.strictEqual(foreign.status, 400, 'a sequence accepted a shot belonging to another project');
    const duplicate = await call('POST', `/film/projects/${p2}/sequences`, { shot_ids: [shot, shot] });
    assert.strictEqual(duplicate.status, 400, 'a sequence accepted the same shot twice');
});

test('sequence output filenames cannot escape project storage', () => {
    const { sequenceFileName } = require('../routes/sequences');
    assert.strictEqual(typeof sequenceFileName, 'function');
    const name = sequenceFileName('12345678-aaaa-bbbb-cccc-123456789012', '../../outside', 'A/B');
    assert.ok(!name.includes('/') && !name.includes('..'), `unsafe sequence filename: ${name}`);
    assert.match(name, /^sequence_12345678_/);
});

// ── 7. One file ─────────────────────────────────────────────────────────
//
// "Wire the stitcher so I get one file."
//
// The sequence produced N-1 clips and told the director to join them in an NLE
// — which is a pipeline whose last step happens outside it. The blocker was
// never the code: lib/conform.js has had the concat since it was written, and
// there is no ffmpeg on this machine, so availableExecutors() correctly
// reported nothing and runConform correctly refused.
//
// These tests PRODUCE A FILE and read it back. Asserting the argument array is
// the same mistake as asserting a serving URL is non-null: args that look right
// and produce an unplayable file pass every string check there is.

test('ffmpeg is resolved in a stated order, and says why when it cannot be', () => {
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const found = resolveFfmpeg();

    assert.ok(found && typeof found === 'object', 'nothing resolves an encoder at all');
    assert.ok(['env', 'path', 'bundled', null].includes(found.source),
        `unknown encoder source ${JSON.stringify(found.source)}`);

    if (found.available) {
        assert.ok(found.bin, 'an available encoder has no binary to run');
        assert.ok(fs.existsSync(found.bin) || found.source === 'path',
            `resolved encoder ${found.bin} does not exist`);
    } else {
        // Unavailable is a legitimate answer and must carry the remedy — a
        // director cannot act on "no executor".
        assert.ok(found.reason && /install|FFMPEG_PATH|npm/i.test(found.reason),
            `encoder is unavailable with no actionable reason: ${found.reason}`);
    }

    // The order is the point: an install that already has ffmpeg keeps using
    // it, and the bundled copy is the floor rather than the default.
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'ffmpeg.js'), 'utf8');
    const order = ['FFMPEG_PATH', 'PATH', 'ffmpeg-static'].map(k => src.indexOf(k));
    assert.ok(order.every(i => i >= 0), 'not every resolution step is present');
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b),
        'the encoder resolution order is not env → PATH → bundled');
});

test('clips are joined into one real, playable file', async () => {
    const { resolveFfmpeg, stitchClips, probe } = require('../lib/ffmpeg');
    const found = resolveFfmpeg();
    assert.ok(found.available,
        `no encoder available (${found.reason}) — the stitch cannot be verified, and a stitch that `
        + 'cannot be verified is the deferral this test exists to close');

    const dir = path.join(process.env.FILM_DATA_DIR, 'stitch-test');
    fs.mkdirSync(dir, { recursive: true });

    /*
     * Two clips of DIFFERENT durations, generated here rather than fixtured.
     * Equal-length inputs hide an off-by-one in the concat filter, and the real
     * case is segments of different lengths coming from different generations.
     */
    const inputs = [];
    for (const [i, seconds] of [1, 2].entries()) {
        const file = path.join(dir, `part${i}.mp4`);
        await probe(found.bin, [
            '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=24:duration=${seconds}`,
            '-f', 'lavfi', '-i', `sine=frequency=${400 + i * 200}:duration=${seconds}`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file,
        ]);
        assert.ok(fs.existsSync(file), `could not build test input ${i}`);
        inputs.push({ file_path: file });
    }

    const out = path.join(dir, 'joined.mp4');
    const result = await stitchClips(inputs, out, { fps: 24 });
    assert.ok(result.ok, `stitch failed: ${result.error}`);
    assert.ok(fs.existsSync(out), 'the stitch reported success and wrote no file');
    assert.ok(fs.statSync(out).size > 1000, 'the output file is too small to be a video');

    /*
     * And it must be READABLE. A file that exists is not a file that plays;
     * ffmpeg will happily write a container it cannot decode if the filter
     * graph is wrong.
     */
    const read = await probe(found.bin, ['-v', 'error', '-i', out, '-f', 'null', '-']);
    assert.strictEqual(read.code, 0, `the joined file does not decode: ${read.stderr.slice(0, 300)}`);

    // Roughly the sum of the parts, so the concat joined rather than replaced.
    const shown = await probe(found.bin, ['-i', out]);
    const duration = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(shown.stderr);
    assert.ok(duration, `no duration in the output: ${shown.stderr.slice(0, 300)}`);
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
    assert.ok(seconds > 2.5 && seconds < 3.6,
        `joined 1s + 2s and got ${seconds}s — the clips were not concatenated in full`);
});

test('the sequence stitch and the whole-film conform share one arg builder', () => {
    /*
     * Two concat implementations is how one of them acquires the pix_fmt fix
     * and the other does not, and the one that misses it produces a file that
     * plays everywhere except the NLE the director actually uses.
     */
    const conform = fs.readFileSync(path.join(ROOT, 'lib', 'conform.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/require\(['"]\.\/ffmpeg['"]\)/.test(conform),
        'conform.js does not use the shared encoder module');
    assert.ok(!/filter_complex/.test(conform),
        'conform.js still builds its own concat filter');
});

test('a sequence joins its own clips into one file, and refuses a short one', async () => {
    const { handleSequences } = require('../routes/sequences');
    const { resolveFfmpeg, probe } = require('../lib/ffmpeg');
    const found = resolveFfmpeg();
    assert.ok(found.available, `no encoder: ${found.reason}`);

    const call = (method, url, body) => new Promise(resolve => {
        const out = [];
        const res = {
            writeHead(s) { this.statusCode = s; return this; },
            end(p) { out.push(p || ''); resolve({ status: this.statusCode || 200, body: JSON.parse(out.join('') || '{}') }); },
        };
        Promise.resolve(handleSequences({ method, url, body: body || {} }, res,
            url.split('?')[0].split('/').filter(Boolean)))
            .then(r => { if (r === false) resolve({ status: 404, body: {} }); })
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });

    const projectId = generateId();
    const sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, provider_config, target_fps) VALUES (?, ?, ?, ?)')
        .run(projectId, 'Join', JSON.stringify({ video: 'runway' }), 24);
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');

    const sbDir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId);
    const vidDir = path.join(process.env.FILM_DATA_DIR, 'video', projectId);
    fs.mkdirSync(sbDir, { recursive: true }); fs.mkdirSync(vidDir, { recursive: true });

    const shotIds = [];
    for (const code of ['1A', '1B', '1C']) {
        const id = generateId();
        shotIds.push(id);
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, description: 'x' }));
        const png = path.join(sbDir, `${code}.png`);
        fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 1)`)
            .run(generateId(), projectId, id, png, `${code}.png`);
    }

    const made = await call('POST', `/film/projects/${projectId}/sequences`,
        { name: 'Join test', shot_ids: shotIds, description: 'one move' });
    const seqId = made.body.sequence.id;

    // Nothing generated yet: refuses rather than producing an empty file.
    const empty = await call('POST', `/film/sequences/${seqId}/stitch`);
    assert.strictEqual(empty.status, 409, 'joined a sequence with no clips');

    // One clip of the two this sequence needs. Joining what is there would make
    // a short film that plays fine, which is the failure nobody notices.
    const clipA = path.join(vidDir, 'seg_a.mp4');
    await probe(found.bin, ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=24:duration=1',
        '-f', 'lavfi', '-i', 'sine=frequency=400:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', clipA]);
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version, metadata)
                VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?)`)
        .run(generateId(), projectId, shotIds[0], clipA, 'seg_a.mp4',
            JSON.stringify({ sequence_id: seqId, from: '1A', to: '1B' }));

    const short = await call('POST', `/film/sequences/${seqId}/stitch`);
    assert.strictEqual(short.status, 409, 'joined an incomplete sequence into a short film');
    assert.ok(/1B/.test(JSON.stringify(short.body.missing || [])),
        `the refusal does not name the missing segment: ${JSON.stringify(short.body)}`);

    // Now the second one, and it must produce a real file.
    const clipB = path.join(vidDir, 'seg_b.mp4');
    await probe(found.bin, ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=24:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=600:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', clipB]);
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version, metadata)
                VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?)`)
        .run(generateId(), projectId, shotIds[1], clipB, 'seg_b.mp4',
            JSON.stringify({ sequence_id: seqId, from: '1B', to: '1C' }));

    const joined = await call('POST', `/film/sequences/${seqId}/stitch`);
    assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));
    assert.strictEqual(joined.body.clips, 2, 'the join did not use both clips');

    const outPath = path.join(vidDir, joined.body.file_name);
    assert.ok(fs.existsSync(outPath), 'the join reported success and wrote no file');
    const decode = await probe(found.bin, ['-v', 'error', '-i', outPath, '-f', 'null', '-']);
    assert.strictEqual(decode.code, 0, `the joined file does not decode: ${decode.stderr.slice(0, 300)}`);

    // 1s + 2s, so it joined rather than replaced.
    const shown = await probe(found.bin, ['-i', outPath]);
    const d = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(shown.stderr);
    const seconds = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    assert.ok(seconds > 2.5 && seconds < 3.6, `joined to ${seconds}s instead of ~3s`);

    // Joining twice replaces rather than accumulating: a folder of
    // near-identical masters is how the wrong one gets delivered.
    const again = await call('POST', `/film/sequences/${seqId}/stitch`);
    assert.strictEqual(again.status, 200);
    const masters = db.prepare(
        "SELECT COUNT(*) c FROM film_assets WHERE project_id = ? AND asset_type = 'video_final'")
        .get(projectId).c;
    assert.strictEqual(masters, 1, `joining twice left ${masters} masters`);
});
