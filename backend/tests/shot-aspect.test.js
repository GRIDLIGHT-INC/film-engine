'use strict';

/**
 * -- A shot's own ratio ------------------------------------------------------
 *
 * The number that justifies this: a 9:16 centre crop of a 16:9 frame keeps 32%
 * of its width. 4:5 keeps 45%; 1:1 keeps 56%. Auto Reframe follows a subject
 * inside the pixels it has — it cannot invent the two-thirds that were never
 * generated. So a vertical hero or product shot is GENERATED vertical, or it is
 * lost, and the decision has to be per SHOT: a spot is not shot entirely
 * vertical, it has a handful of shots that carry the product and the CTA.
 *
 * `film_shots.aspect_ratio` is empty by default, which inherits the project's —
 * what every existing shot does and must keep doing.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'fe-shotasp-'));

const test = require('node:test');
const assert = require('node:assert');

const { calculateVideoParams, buildVideoFrame } = require('../lib/video-prompt');

const PROJECT = { target_resolution: '1920x1080', aspect_ratio: '16:9', target_fps: 30 };

test('a shot with no ratio of its own is byte-identical to before', () => {
    /*
     * Every shot in every existing project is in this state. A feature that
     * reshapes them the moment it ships is one nobody can adopt deliberately.
     */
    const base = calculateVideoParams({ duration_ms: 4000 }, PROJECT);
    for (const empty of [undefined, null, '', '   ']) {
        const got = calculateVideoParams({ duration_ms: 4000, aspect_ratio: empty }, PROJECT);
        assert.deepEqual(got, base, `an aspect of ${JSON.stringify(empty)} reshaped the frame`);
    }
    assert.equal(base.width, 1920);
    assert.equal(base.height, 1080);
});

test('a shot flagged vertical generates vertical, at the delivery size class', () => {
    /*
     * M4's acceptance, and the sizes are not arbitrary: a native deliverable is
     * specified at a resolution CLASS (1080-line), so an override keeps the
     * delivery raster's SHORT edge and derives the other from the ratio. That
     * lands exactly on the rasters the delivery profiles ask for — 1080x1920
     * for Reels, 1080x1350 for a Meta feed, 1080x1080 for square — rather than
     * on some fitted-inside-the-landscape size nobody buys.
     */
    const cases = [
        ['9:16', 1080, 1920],
        ['4:5',  1080, 1350],
        ['1:1',  1080, 1080],
    ];
    for (const [ratio, w, h] of cases) {
        const got = calculateVideoParams({ duration_ms: 4000, aspect_ratio: ratio }, PROJECT);
        assert.equal(got.width, w, `${ratio} should generate ${w} wide, got ${got.width}`);
        assert.equal(got.height, h, `${ratio} should generate ${h} tall, got ${got.height}`);
    }
});

test('neighbouring shots in one project generate at different shapes', () => {
    // The acceptance, stated as the thing a director would see.
    const hero = calculateVideoParams({ duration_ms: 4000, aspect_ratio: '9:16' }, PROJECT);
    const wide = calculateVideoParams({ duration_ms: 4000 }, PROJECT);
    assert.equal(`${hero.width}x${hero.height}`, '1080x1920');
    assert.equal(`${wide.width}x${wide.height}`, '1920x1080');
});

test('every frame generated is even in both dimensions', () => {
    // h.264 refuses an odd dimension, and that rejection is a paid generation
    // failing at the provider.
    for (const ratio of ['9:16', '4:5', '1:1', '16:9', '2.39:1', '1.85:1', '4:3']) {
        const got = calculateVideoParams({ duration_ms: 4000, aspect_ratio: ratio }, PROJECT);
        assert.equal(got.width % 2, 0, `${ratio} generated an odd width`);
        assert.equal(got.height % 2, 0, `${ratio} generated an odd height`);
    }
});

test('an unparseable shot ratio falls back to the project rather than guessing', () => {
    /*
     * A typed ratio that matches nothing must not silently become square or
     * zero-sized. Falling back to the project is the same rule the project's own
     * unparseable aspect already follows.
     */
    const base = calculateVideoParams({ duration_ms: 4000 }, PROJECT);
    for (const junk of ['vertical', '9-16', '0:0', ':', '16:0']) {
        const got = calculateVideoParams({ duration_ms: 4000, aspect_ratio: junk }, PROJECT);
        assert.deepEqual(got, base, `"${junk}" was interpreted as a ratio instead of ignored`);
    }
});

test('buildVideoFrame is the one place the shape is decided', () => {
    /*
     * Exported so the image payload and the video payload cannot compute the
     * frame differently — which is exactly what happened once before, when the
     * board derived its shape from aspect_ratio and the footage from
     * target_resolution, and ten of eleven ratios produced a storyboard in one
     * format and footage in another.
     */
    assert.equal(typeof buildVideoFrame, 'function', 'buildVideoFrame is not exported');
    assert.deepEqual(buildVideoFrame(PROJECT, '9:16'), { width: 1080, height: 1920 });
    assert.deepEqual(buildVideoFrame(PROJECT, null), { width: 1920, height: 1080 });
});

test('a flagged shot reaches the PROVIDER vertical, and its neighbour does not', async () => {
    /*
     * M4's acceptance, proven where it matters: what the provider receives.
     * A ratio stored on a row and honoured by nothing is the failure class this
     * codebase keeps paying for, so this asserts the payload rather than the
     * column.
     *
     * Both capabilities, because the keyframe a clip is generated FROM must be
     * the same shape as the clip: a vertical clip built from a landscape
     * keyframe is a letterboxed picture inside a vertical frame.
     */
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');

    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, aspect_ratio, target_resolution, target_fps)
                VALUES (?, 'Spot', '16:9', '1920x1080', 30)`).run(pid);
    const sc = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(sc, pid);

    const mkShot = (code, ratio) => {
        const id = generateId();
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, aspect_ratio, scene_card_yaml)
                    VALUES (?, ?, ?, 4000, ?, ?)`)
            .run(id, sc, code, ratio, JSON.stringify({ shot_code: code, description: 'a bottle on a table' }));
        return id;
    };
    const hero = mkShot('1A', '9:16');
    const wide = mkShot('1B', '');

    const shapeOf = (shotId, capability) => {
        const ctx = loadShotContext(shotId);
        const { payload } = buildCapabilityPayload(capability, ctx);
        const p = Array.isArray(payload) ? payload[0] : payload;
        return `${p.width}x${p.height}`;
    };

    /*
     * The image path is asserted on SHAPE, not on exact pixels, and that is a
     * real difference rather than a weaker test: an image payload is bounded by
     * the provider's own pixel ceiling and scaled down the diagonal to fit, so
     * a 9:16 keyframe arrives at 944x1672 rather than 1080x1920. Demanding the
     * video rule of it would be asserting a behaviour the engine deliberately
     * does not have. What must hold is that it is VERTICAL and the right shape.
     */
    const ratioOf = s2 => { const [w, h] = s2.split('x').map(Number); return w / h; };
    assert.ok(Math.abs(ratioOf(shapeOf(hero, 'image')) - 9 / 16) < 0.01,
        `the flagged shot reached the image provider as ${shapeOf(hero, 'image')}, not 9:16`);
    assert.ok(Math.abs(ratioOf(shapeOf(wide, 'image')) - 16 / 9) < 0.01,
        `an unflagged shot was reshaped: ${shapeOf(wide, 'image')}`);

    // The video path is exact: it is the delivered raster, not a budgeted one.
    assert.equal(shapeOf(hero, 'video'), '1080x1920',
        'the flagged shot did not reach the video provider vertical');
    assert.equal(shapeOf(wide, 'video'), '1920x1080',
        'an unflagged shot was reshaped on the video path');

    /*
     * And the two agree with each other. A vertical clip generated FROM a
     * landscape keyframe is a letterboxed picture inside a vertical frame —
     * which is the board/footage mismatch this engine already fixed once at
     * project level and would have reintroduced per shot.
     */
    for (const [name, id] of [['flagged', hero], ['unflagged', wide]]) {
        assert.ok(Math.abs(ratioOf(shapeOf(id, 'image')) - ratioOf(shapeOf(id, 'video'))) < 0.01,
            `the ${name} shot's board and footage are different shapes: `
            + `${shapeOf(id, 'image')} vs ${shapeOf(id, 'video')}`);
    }
});
