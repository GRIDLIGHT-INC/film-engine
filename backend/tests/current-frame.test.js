/**
 * Every surface shows the version you SELECTED.
 *
 * Reported twice from use: "if I select a version it's not the one that shows
 * when we go back to the storyboard."
 *
 * Selecting became a pointer — `film_shots.current_frame_version` — and the
 * file on disk is copied to match. But every surface that paints a frame still
 * asked for `ORDER BY version DESC LIMIT 1`, the HIGHEST version, and keys its
 * URL to that number. So after selecting v13 of 17 the picture on disk is v13
 * and the board requests `?v=17` — which the browser already has cached from
 * when v17 was current, so it serves the frame you just moved away from.
 *
 * Silent, and it looks exactly like selecting not working.
 *
 * Set-based over the surfaces, because they each query independently and a fix
 * to one leaves the others lying — which is worse than all of them being wrong,
 * since the board and previs would then disagree with each other.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Every query that resolves "the frame this shot is showing". */
const SURFACES = [
    { file: 'routes/storyboard.js', what: 'the board' },
    { file: 'routes/previs.js', what: 'the previs stage' },
    /*
     * PLAYBACK was missing, and it is the surface where being wrong is most
     * visible: it selected every asset for a shot with no version and no
     * ordering, so pickAsset's .find() returned whichever row was inserted
     * first — the FIRST attempt ever made. On a real shot with twenty-eight
     * versions, playback showed v1 while the board showed the selected frame.
     *
     * "It played the first image we had for each instead of the selected one
     * on the board."
     */
    { file: 'routes/timeline.js', what: 'playback' },
];

/*
 * Functions whose job genuinely IS "the newest attempt": the version allocator
 * and the archiver that copies the outgoing picture aside. Exempted by name
 * rather than by pattern, because the pattern is identical and only the
 * QUESTION differs — and an exemption that matches on text would quietly
 * excuse the next surface that gets it wrong.
 */
const NEWEST_IS_CORRECT = new Set([
    'archiveExistingFrame', 'registerStoryboardAsset', 'currentFrameVersion',
]);

/** The function each character offset falls inside. */
function functionAt(src, index) {
    let fn = null;
    const re = /^(?:async )?function (\w+)\(/gm;
    let m;
    while ((m = re.exec(src)) && m.index < index) fn = m[1];
    return fn;
}

test('no surface resolves the current frame by taking the highest version', () => {
    const offenders = [];
    for (const { file, what } of SURFACES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const re = /asset_type = 'storyboard'[\s\S]{0,200}?ORDER BY (?:a\.)?version DESC[\s\S]{0,60}?LIMIT 1/g;
        let m;
        while ((m = re.exec(src))) {
            const fn = functionAt(src, m.index);
            if (fn && NEWEST_IS_CORRECT.has(fn)) continue;
            // The guard may sit just outside the matched SQL, so look at the
            // whole statement it belongs to.
            const window = src.slice(Math.max(0, m.index - 700), m.index + m[0].length + 200);
            if (/current_frame_version|currentFrameVersion/.test(window)) continue;
            offenders.push(`${file}:${fn || '?'} — ${what}`);
        }
    }
    assert.deepStrictEqual([...new Set(offenders)], [],
        'these paint the frame a shot is showing but ask for the HIGHEST version, so after '
        + `selecting an earlier one they serve the wrong picture: ${[...new Set(offenders)].join('; ')}`);
});

test('the board reports the selected version, not the newest', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/storyboard.js'), 'utf8');
    const at = src.indexOf('asset_version:');
    assert.ok(at > 0, 'the board no longer reports a version');
    const around = src.slice(Math.max(0, at - 2000), at + 200);
    assert.ok(/currentFrameVersion\(/.test(around),
        'the board derives asset_version without consulting the pointer, so the URL it builds '
        + 'names a different version than the picture on disk');
});

test('previs keys its frame to the selected version too', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/previs.js'), 'utf8');
    const at = src.indexOf('function shotKeyframe(');
    assert.ok(at > 0, 'shotKeyframe is gone');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(/current_frame_version|currentFrameVersion/.test(body),
        'previs paints whichever version is highest, so it disagrees with the board after a selection');
});

test('the version used for cache-busting is the version on disk', () => {
    // The whole point: the ?v= key must name the picture actually served, or
    // the browser is asked for a URL it already has under a different picture.
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('function frameSrc('), html.indexOf('function frameSrc(') + 400);
    assert.ok(/asset_version/.test(fn), 'frameSrc no longer keys the URL to a version');
});


// ── Playback plays the frame the board is showing ───────────────────────

test('playback resolves the selected version, on real rows', () => {
    /*
     * Behavioural rather than textual, because the fault was not a wrong query
     * — it was NO query: no version selected, no ordering, and a .find() that
     * took whatever the table returned first.
     */
    const os = require('os');
    const crypto = require('crypto');
    process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
        || path.join(os.tmpdir(), 'film-engine-cf-' + crypto.randomUUID().slice(0, 8));
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { buildTimeline } = require('../lib/timeline');

    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Versions');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ shot_code: '1A' }));

    // Inserted oldest first, exactly as a shot regenerated five times is.
    for (let v = 1; v <= 5; v += 1) {
        db.prepare(`INSERT INTO film_assets
            (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
            VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', ?)`)
            .run(generateId(), projectId, shotId, `/tmp/1A_v${v}.png`, `1A_v${v}.png`, v);
    }

    const rows = [{ id: shotId, shot_code: '1A', scene_number: 1, sort_order: 0, duration_ms: 4000 }];
    const assets = db.prepare(
        `SELECT shot_id, asset_type, file_path, duration_ms, version FROM film_assets
          WHERE project_id = ?`).all(projectId);
    const byShot = { [shotId]: assets };

    // NULL pointer means "the newest", which is what a freshly generated shot
    // shows and what every shot showed before selection existed.
    let t = buildTimeline(rows, byShot, { fps: 24 });
    assert.match(String(t.entries[0].still.path), /1A_v5\.png$/,
        `an unselected shot plays ${t.entries[0].still.path} — it should show the newest`);

    // Select v3: playback must follow the pointer, not the newest and not the
    // first row the table happened to return.
    db.prepare('UPDATE film_shots SET current_frame_version = 3 WHERE id = ?').run(shotId);
    const withPointer = db.prepare(
        `SELECT a.shot_id, a.asset_type, a.file_path, a.duration_ms, a.version,
                sh.current_frame_version
           FROM film_assets a JOIN film_shots sh ON sh.id = a.shot_id
          WHERE a.project_id = ?`).all(projectId);
    t = buildTimeline(rows, { [shotId]: withPointer }, { fps: 24 });
    assert.match(String(t.entries[0].still.path), /1A_v3\.png$/,
        `v3 was selected and playback plays ${t.entries[0].still.path}`);
});

test('the playback route asks for the version and the pointer', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'timeline.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/a\.version/.test(src),
        'the playback query still selects no version, so nothing can tell the attempts apart');
    assert.ok(/current_frame_version/.test(src),
        'the playback query never reads the pointer, so a selected frame cannot be honoured');
});
