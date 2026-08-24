/**
 * ONE CLIP, SEVERAL SHOTS.
 *
 * "I generated a video that includes 1A-B-C... when playing a video in playback
 * it should be playing the entire video, not a few seconds and then switch to
 * the next image. And if I option select which other shots are part of the
 * video in the upload clip, it shouldn't play any of the images that are part
 * of the video."
 *
 * Three faults, one cause each:
 *
 *  - An asset belongs to exactly ONE shot, so a clip containing 1A, 1B and 1C
 *    could not say so.
 *  - lib/timeline.js shotDuration() reads the CARD's duration_ms and falls back
 *    to DEFAULT_SHOT_MS = 4000, never asking the file — so a ten-second upload
 *    plays for four seconds and cuts to the next still. That is true of every
 *    uploaded clip, not only the multi-shot ones.
 *  - With no notion of coverage, the shots inside the clip still hold their own
 *    slot and show their storyboard frames after you have just watched them.
 *
 * SET-BASED OVER THE ASSEMBLY SURFACES, because there are FOUR independent
 * shot-walks and fixing the visible one leaves the others wrong in ways nobody
 * sees until delivery: playback would be right while planConform refuses to
 * build a master (reporting 1B and 1C as missing) and Premiere receives a
 * three-second film with two gaps.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-cover-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const CLIP_MS = 9000;   // the real length of the covering clip
const CARD_MS = 3000;   // what each shot's card claims — deliberately different

/** A project whose 1A carries one clip that also contains 1B and 1C. */
function fixture({ cover = true } = {}) {
    const projectId = generateId();
    const sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)')
        .run(projectId, 'Coverage');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');

    const dir = path.join(process.env.FILM_DATA_DIR, 'video', projectId);
    const sbDir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(sbDir, { recursive: true });

    const shots = {};
    ['1A', '1B', '1C', '1D'].forEach((code, i) => {
        const id = generateId();
        shots[code] = id;
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, sort_order, duration_ms, scene_card_yaml)
                    VALUES (?, ?, ?, ?, ?, ?)`)
            .run(id, sceneId, code, i, CARD_MS, JSON.stringify({ shot_code: code, description: code }));
        // Every shot has a storyboard frame — the point is that the covered
        // ones must NOT be shown, not that they have nothing to show.
        const png = path.join(sbDir, `${code}.png`);
        fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 1)`)
            .run(generateId(), projectId, id, png, `${code}.png`);
    });

    // The covering clip lives on 1A and is nine seconds long.
    const clipPath = path.join(dir, 'runway_1A.mp4');
    fs.writeFileSync(clipPath, Buffer.alloc(2048, 7));
    const clipId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name,
                    format, duration_ms, version, metadata)
                VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', ?, 1, ?)`)
        .run(clipId, projectId, shots['1A'], clipPath, 'runway_1A.mp4', CLIP_MS,
            JSON.stringify({ imported: true }));

    // 1D has its own clip, so "the shot after the covered run" is exercised.
    const tailPath = path.join(dir, 'runway_1D.mp4');
    fs.writeFileSync(tailPath, Buffer.alloc(2048, 8));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name,
                    format, duration_ms, version)
                VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 2000, 1)`)
        .run(generateId(), projectId, shots['1D'], tailPath, 'runway_1D.mp4');

    if (cover) {
        const { setCoverage } = require('../lib/clip-coverage');
        setCoverage(db, clipId, [shots['1A'], shots['1B'], shots['1C']]);
    }
    return { projectId, sceneId, shots, clipId, clipPath };
}

/**
 * The assembly surfaces, DERIVED. Each turns shots into a running film and each
 * walks them independently.
 */
function assemblySurfaces() {
    const nle = require('../lib/nle-export');
    return {
        timeline: true,
        conform: true,
        ...Object.fromEntries(Object.keys(nle)
            .filter(k => /^generate(EDL|FCPXML|PremiereXML)$/.test(k))
            .map(k => [k, true])),
    };
}

// ── 1. The registry has not quietly shrunk ──────────────────────────────

test('every surface that turns shots into a film is covered by this test', () => {
    const surfaces = Object.keys(assemblySurfaces());
    assert.deepStrictEqual(surfaces.sort(),
        ['conform', 'generateEDL', 'generateFCPXML', 'generatePremiereXML', 'timeline'],
        'the set of assembly surfaces changed — a new one must honour coverage or a clip is laid '
        + 'down once in four places and three times in the fifth');
});

// ── 2. Coverage is consecutive, or refused ──────────────────────────────

test('coverage must be a consecutive run, and says so when it is not', () => {
    const { setCoverage, coverageFor } = require('../lib/clip-coverage');
    const f = fixture({ cover: false });

    // 1A + 1C, skipping 1B: the clip would contain a jump the timeline cannot
    // represent, so it is refused rather than guessed at.
    assert.throws(() => setCoverage(db, f.clipId, [f.shots['1A'], f.shots['1C']]),
        /consecutive|order|between/i,
        'a non-consecutive coverage was accepted, so the timeline now contains a hole nobody declared');

    // And the clip's own shot has to be in it, or the coverage describes a clip
    // that is not where it says it is.
    assert.throws(() => setCoverage(db, f.clipId, [f.shots['1B'], f.shots['1C']]),
        /own shot|1A|lead/i,
        'coverage that excludes the clip’s own shot was accepted');

    // Cross-project ids are refused: a covered shot in another film would put
    // this clip on a timeline it has nothing to do with.
    const other = fixture({ cover: false });
    assert.throws(() => setCoverage(db, f.clipId, [f.shots['1A'], other.shots['1B']]),
        /project/i, 'a shot from another project was accepted into a coverage');

    // Duplicates are refused rather than de-duplicated: repeating a shot means
    // the caller has a different model of the clip than we do, and silently
    // fixing it hides that.
    assert.throws(() => setCoverage(db, f.clipId, [f.shots['1A'], f.shots['1A'], f.shots['1B']]),
        /duplicate|twice|repeat/i, 'a duplicated shot was accepted into a coverage');

    /*
     * Consecutiveness is judged in CANONICAL running order, not in the order
     * the array happened to arrive in. A caller listing 1C, 1A, 1B describes a
     * perfectly valid run; a caller listing 1A, 1C does not, however they sort
     * it. Trusting submitted order would accept the second and reject the first.
     */
    setCoverage(db, f.clipId, [f.shots['1C'], f.shots['1A'], f.shots['1B']]);
    const scrambled = coverageFor(db, f.projectId);
    assert.strictEqual(scrambled.get(f.shots['1B']).lead_shot_id, f.shots['1A'],
        'coverage submitted out of order did not resolve to the run it describes');

    setCoverage(db, f.clipId, [f.shots['1A'], f.shots['1B'], f.shots['1C']]);
    const map = coverageFor(db, f.projectId);
    assert.strictEqual(map.get(f.shots['1B']).lead_shot_id, f.shots['1A'],
        '1B is not reported as covered by the clip on 1A');
    assert.ok(!map.get(f.shots['1D']), '1D was swept into a coverage it is not part of');

    /*
     * Rewriting coverage REPLACES it. Without that, narrowing a clip from three
     * shots to two would leave 1C covered by a clip that no longer contains it,
     * and 1C would never play again.
     */
    setCoverage(db, f.clipId, [f.shots['1A'], f.shots['1B']]);
    const narrowed = coverageFor(db, f.projectId);
    assert.ok(!narrowed.get(f.shots['1C']),
        'narrowing a coverage left the dropped shot covered, so it can never play');

    // And it goes with the asset, by cascade rather than by cleanup code that
    // someone has to remember to call.
    setCoverage(db, f.clipId, [f.shots['1A'], f.shots['1B'], f.shots['1C']]);
    db.prepare('DELETE FROM film_assets WHERE id = ?').run(f.clipId);
    assert.strictEqual(coverageFor(db, f.projectId).size, 0,
        'deleting the clip left its coverage behind, so shots stay hidden by a file that is gone');

    // Same for the shot: deleting a covered shot must not leave a dangling row.
    const g = fixture();
    db.prepare('DELETE FROM film_shots WHERE id = ?').run(g.shots['1C']);
    const after = coverageFor(db, g.projectId);
    assert.ok(!after.get(g.shots['1C']), 'deleting a covered shot left its coverage row behind');
});

// ── 3. Every surface plays it once, for its real length ─────────────────

test('all four assembly surfaces lay the clip down once, not three times', () => {
    const f = fixture();
    const { buildTimeline } = require('../lib/timeline');
    const { planConform } = require('../lib/conform');
    const { generateEDL, generateFCPXML, generatePremiereXML } = require('../lib/nle-export');
    const { coverageFor, foldShots } = require('../lib/clip-coverage');

    const rows = db.prepare(
        `SELECT sh.*, s.scene_number FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ? ORDER BY sh.sort_order`).all(f.projectId);
    const assets = db.prepare('SELECT * FROM film_assets WHERE project_id = ?').all(f.projectId);
    const byShot = {};
    for (const a of assets) { if (a.shot_id) (byShot[a.shot_id] ||= []).push(a); }
    const coverage = coverageFor(db, f.projectId);
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(f.projectId);

    // --- playback -------------------------------------------------------
    const timeline = buildTimeline(rows, byShot, { fps: 24, coverage });
    const codes = timeline.entries.map(e => e.shot_code);
    assert.deepStrictEqual(codes, ['1A', '1D'],
        `playback still plays the covered shots: ${codes.join(', ')}`);

    const lead = timeline.entries[0];
    assert.strictEqual(lead.duration_ms, CLIP_MS,
        `the clip plays for ${lead.duration_ms}ms instead of its real ${CLIP_MS}ms — this is why a `
        + 'ten-second upload cuts to a still after four seconds');
    assert.deepStrictEqual(lead.covers, ['1A', '1B', '1C'],
        'the entry does not say which shots it contains, so a viewer cannot tell why 1B vanished');
    // The shot AFTER the covered run must start where the clip ends.
    assert.strictEqual(timeline.entries[1].start_ms, CLIP_MS,
        'the next shot does not start where the clip ends');

    // --- the master file ------------------------------------------------
    const plan = planConform(f.projectId);
    assert.ok(plan.ok, `conform refused a complete film: ${plan.error}`);
    assert.strictEqual(plan.clips.length, 2,
        `the master would contain ${plan.clips.length} clips — the covering clip is laid down more `
        + 'than once, so the film repeats itself');
    assert.strictEqual(plan.clips.filter(c => c.file_path === f.clipPath).length, 1,
        'the covering clip appears more than once in the conform');
    assert.deepStrictEqual((plan.missing || []).map(m => m.shot_code), [],
        'covered shots are reported missing, so the director is told to generate footage they have');

    // --- the three NLE formats -----------------------------------------
    const folded = foldShots(rows, coverage);
    /*
     * The fold must put the MEASURED duration on the retained shot, not merely
     * drop the covered ones. Suppressing 1B and 1C while the exporters still
     * read 1A's card would lay a nine-second clip into a three-second slot, and
     * every cut after it in the Premiere timeline would be six seconds early.
     */
    const foldedLead = folded.shots.find(sh => sh.shot_code === '1A');
    assert.strictEqual(foldedLead.duration_ms, CLIP_MS,
        `the folded shot carries ${foldedLead.duration_ms}ms, so the NLE lays a ${CLIP_MS}ms clip `
        + 'into the wrong slot and everything after it is early');

    /*
     * An EDL references REELS by shot code and timecode, not filenames — so the
     * guarantee here is that the covered shots are not cut to, and that the one
     * retained event is as long as the clip really is.
     */
    const edl = generateEDL(project, folded.shots, { fps: 24 });
    assert.ok(/\b1A\b/.test(edl), 'the EDL lost the shot the clip is laid down at');
    for (const covered of ['1B', '1C']) {
        assert.ok(!new RegExp(`\\b${covered}\\b`).test(edl),
            `the EDL still cuts to ${covered}, which is inside the clip it has already played`);
    }
    // 9s at 24fps = 00:00:09:00. If the fold did not move the duration this
    // reads 00:00:03:00 and every event after it is six seconds early.
    assert.ok(edl.includes('00:00:09:00'),
        `the EDL lays the clip into the wrong slot:\n${edl.split('\n').slice(0, 8).join('\n')}`);

    for (const [name, gen] of [['FCPXML', generateFCPXML], ['Premiere', generatePremiereXML]]) {
        const xml = gen(project, folded.shots, assets, { fps: 24 });
        const n = (xml.match(/runway_1A/g) || []).length;
        assert.ok(n >= 1, `${name} lost the covering clip entirely`);
        assert.ok(!new RegExp('"1B"|>1B<').test(xml),
            `${name} still lays down 1B, which is inside the clip it already contains`);
    }
});

// ── 4. Without coverage, nothing changes ────────────────────────────────

test('a project with no coverage assembles exactly as before', () => {
    const f = fixture({ cover: false });
    const { buildTimeline } = require('../lib/timeline');
    const rows = db.prepare(
        `SELECT sh.*, s.scene_number FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ? ORDER BY sh.sort_order`).all(f.projectId);
    const assets = db.prepare('SELECT * FROM film_assets WHERE project_id = ?').all(f.projectId);
    const byShot = {};
    for (const a of assets) { if (a.shot_id) (byShot[a.shot_id] ||= []).push(a); }

    /*
     * Every existing project is uncovered, so this is the guarantee that
     * shipping coverage changes nothing for anyone who has not asked for it.
     */
    const withArg = buildTimeline(rows, byShot, { fps: 24, coverage: new Map() });
    const without = buildTimeline(rows, byShot, { fps: 24 });
    assert.deepStrictEqual(withArg.entries.map(e => e.shot_code), ['1A', '1B', '1C', '1D']);
    assert.deepStrictEqual(
        without.entries.map(e => ({ c: e.shot_code, d: e.duration_ms })),
        withArg.entries.map(e => ({ c: e.shot_code, d: e.duration_ms })),
        'omitting coverage entirely differs from passing an empty one');
});

// ── 5. A clip plays for its own length even when it covers nothing ──────

test('an ordinary clip plays for its real length, not the card’s guess', () => {
    /*
     * The duration fault is independent of coverage and was the director's
     * second complaint: "it should be playing the entire video, not a few
     * seconds and then switch to the next image."
     */
    const f = fixture({ cover: false });
    const { buildTimeline } = require('../lib/timeline');
    const rows = db.prepare(
        `SELECT sh.*, s.scene_number FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ? ORDER BY sh.sort_order`).all(f.projectId);
    const assets = db.prepare('SELECT * FROM film_assets WHERE project_id = ?').all(f.projectId);
    const byShot = {};
    for (const a of assets) { if (a.shot_id) (byShot[a.shot_id] ||= []).push(a); }

    const t = buildTimeline(rows, byShot, { fps: 24 });
    const oneA = t.entries.find(e => e.shot_code === '1A');
    assert.strictEqual(oneA.duration_ms, CLIP_MS,
        `1A holds for ${oneA.duration_ms}ms while its clip runs ${CLIP_MS}ms — playback cuts the video off`);

    // A shot with only a still keeps the card's duration: there is no measured
    // length to prefer, and a still has no opinion about how long it is held.
    const oneB = t.entries.find(e => e.shot_code === '1B');
    assert.strictEqual(oneB.duration_ms, CARD_MS,
        'a still-only shot stopped using the duration its card asks for');
});

// ── 6. The duration is actually measured, from a real file ──────────────

test('a real media file reports its real length', () => {
    /*
     * Nothing tested the MEASUREMENT, only what the timeline did with a number
     * already in the database — so the first implementation returned 0 for
     * every file and every clip silently fell back to the card's guess. It ran
     * `-f null -` inside a try/catch and read stderr only from the thrown
     * error, and that command exits 0 and never throws.
     *
     * This builds a file of a known length and asks.
     */
    const { resolveFfmpeg, probe } = require('../lib/ffmpeg');
    const { measureDurationMs } = require('../lib/media-imports');
    assert.ok(typeof measureDurationMs === 'function', 'nothing measures a file at all');

    const found = resolveFfmpeg();
    assert.ok(found.available, `no encoder: ${found.reason}`);

    const dir = path.join(process.env.FILM_DATA_DIR, 'measure-test');
    fs.mkdirSync(dir, { recursive: true });

    // Several lengths, because a probe that returns a constant passes a
    // single-value check.
    for (const seconds of [1, 5, 9]) {
        const file = path.join(dir, `len${seconds}.mp4`);
        require('child_process').spawnSync(found.bin, [
            '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=24:duration=${seconds}`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file,
        ], { timeout: 60000 });
        assert.ok(fs.existsSync(file), `could not build a ${seconds}s file`);

        const ms = measureDurationMs(file);
        assert.ok(Math.abs(ms - seconds * 1000) < 200,
            `a ${seconds}s file measured ${ms}ms — the clip will play for the card's guess instead`);
    }

    // A file that is not media measures 0 rather than throwing: an unprobeable
    // upload is still an upload the director paid for.
    const junk = path.join(dir, 'notmedia.txt');
    fs.writeFileSync(junk, 'this is not a video');
    assert.strictEqual(measureDurationMs(junk), 0, 'an unreadable file did not measure 0');
});

// ── 7. Every assembly agrees on the running order ───────────────────────
//
// Found by running the real project rather than by reading: sort_order is
// PER SCENE and resets to 0 for each, so ordering by it first interleaves the
// scenes. On Wingfall that produced
//
//   playback  : 1A 1B 1BA 1C 2A 2AA 2B 2C 3A 3B 3C 3D
//   conform   : 1A 1B 2A 3A 3B 3C 3D 2AA 1BA 2B 1C 2C   ← and all three exports
//
// So the master file and every NLE export were assembling the film in a
// scrambled order while playback showed it correctly. Nothing failed; the
// exports opened and played, in the wrong sequence.
//
// It also makes coverage unsound: a run validated as consecutive in one order
// is not consecutive in the other, which is how [1A, 1B, 2A] was accepted on a
// project whose running order has 1BA and 1C between them.

test('all five assembly surfaces put the shots in the same order', () => {
    const { compareShots, ORDER_BY_SQL } = require('../lib/running-order');
    assert.ok(typeof compareShots === 'function', 'there is no single running order');
    assert.ok(typeof ORDER_BY_SQL === 'string' && ORDER_BY_SQL.length,
        'the SQL surfaces have no shared ORDER BY to use');

    /*
     * sort_order resets per scene — that is the fact the wrong order missed —
     * so the fixture reproduces it exactly.
     */
    const shots = [
        { shot_code: '1A', scene_number: 1, sort_order: 0 },
        { shot_code: '1B', scene_number: 1, sort_order: 0 },
        { shot_code: '1BA', scene_number: 1, sort_order: 2 },
        { shot_code: '1C', scene_number: 1, sort_order: 3 },
        { shot_code: '2A', scene_number: 2, sort_order: 0 },
        { shot_code: '2AA', scene_number: 2, sort_order: 1 },
        { shot_code: '3A', scene_number: 3, sort_order: 0 },
    ];
    const expected = ['1A', '1B', '1BA', '1C', '2A', '2AA', '3A'];
    assert.deepStrictEqual([...shots].sort(compareShots).map(s => s.shot_code), expected,
        'the canonical order interleaves scenes');

    // The SQL clause must express the SAME rule. Checked by running it.
    const projectId = generateId();
    const scenes = {};
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Order');
    for (const n of [1, 2, 3]) {
        const id = generateId();
        scenes[n] = id;
        db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
            .run(id, projectId, String(n));
    }
    for (const s of shots) {
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, sort_order) VALUES (?, ?, ?, ?)')
            .run(generateId(), scenes[s.scene_number], s.shot_code, s.sort_order);
    }
    const fromSql = db.prepare(
        `SELECT sh.shot_code FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ? ORDER BY ${ORDER_BY_SQL}`).all(projectId).map(r => r.shot_code);
    assert.deepStrictEqual(fromSql, expected,
        'the SQL order and the comparator disagree, so playback and the export cut differently');

    /*
     * And every surface must actually use it. Checked against the SOURCE
     * because three of the five order in SQL and two in JS, so there is no one
     * value to compare — what matters is that none of them still carries its
     * own ORDER BY.
     */
    for (const file of ['lib/timeline.js', 'lib/conform.js', 'lib/clip-coverage.js']) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(/require\(['"]\.\/running-order['"]\)/.test(src),
            `${file} does not use the shared running order`);
        assert.ok(!/ORDER BY\s+sh?\.?sort_order/i.test(src),
            `${file} still declares its own shot ordering`);
    }
});

test('the shot list feeding the sequence picker uses the film running order', async () => {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Picker order');
    const sceneIds = [];
    for (const n of [1, 2]) {
        const sceneId = generateId();
        sceneIds.push(sceneId);
        db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
            .run(sceneId, projectId, String(n));
    }
    for (const [scene, code, order] of [
        [0, '1A', 0], [0, '1B', 1], [1, '2A', 0], [1, '2B', 1],
    ]) {
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, sort_order) VALUES (?, ?, ?, ?)')
            .run(generateId(), sceneIds[scene], code, order);
    }

    const { handleShots } = require('../routes/shots');
    const response = await new Promise((resolve, reject) => {
        const chunks = [];
        const res = {
            writeHead(status) { this.statusCode = status; },
            end(chunk) {
                if (chunk) chunks.push(Buffer.from(chunk));
                try { resolve({ status: this.statusCode || 200, body: JSON.parse(Buffer.concat(chunks)) }); }
                catch (err) { reject(err); }
            },
        };
        try {
            handleShots({ method: 'GET' }, res, ['film', 'projects', projectId, 'shotlist'], {});
        } catch (err) { reject(err); }
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.shots.map(s => s.shot_code), ['1A', '1B', '2A', '2B'],
        'the sequence picker interleaves scenes instead of showing the order the film plays');
});
