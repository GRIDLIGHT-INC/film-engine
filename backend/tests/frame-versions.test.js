/**
 * Telling one attempt from another.
 *
 * The version modal lists a shot's attempts and you cannot tell which is which,
 * so you cannot choose one. That reads as a display bug and is not: the modal
 * renders exactly what it is given, and what it is given is wrong in four
 * separate ways, all visible on one real shot (1A, 7 versions):
 *
 *     v7  url=1A.png     current=true   provider=null
 *     v6  url=1A_v6.png  current=false  provider=null
 *     v5  url=1A.png     current=true   provider=null      ← v1..v5 all point at
 *     v4  url=1A.png     current=true   provider=null        the LIVE file, so
 *     v3  url=1A.png     current=true   provider=null        five thumbnails are
 *     v2  url=1A.png     current=true   provider=null        the same picture
 *     v1  url=1A.png     current=true   provider=null
 *
 * Across the real database: 10 of 31 version rows point at a picture another row
 * already shows, and six versions of one shot claim to be on the board — which
 * also means six of them hide their Restore button, so they cannot be selected
 * even if you could tell them apart.
 *
 * The cause is historical, not current. `archiveExistingFrame` copies the
 * outgoing picture aside and repoints its row, but only ever the NEWEST row —
 * versions written before it existed were never archived and still name the live
 * filename. The fix is therefore two things that must both hold: the API stops
 * asserting things it cannot know, and the modal shows enough to choose by.
 *
 * Set-based over the four defects rather than over one shot, because a fix for
 * any one of them leaves the modal unusable: distinguishable thumbnails with six
 * missing Restore buttons is as useless as seven identical ones.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-fv-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const ROOT = path.join(__dirname, '..', '..');
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64');

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handler({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

/**
 * A shot with the damage a real project has: some versions properly archived,
 * some — written before the archiver existed — still naming the live file.
 */
function damagedShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Versions');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ shot_code: '1A' }));

    const dir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId);
    fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
    const live = path.join(dir, '1A.png');
    fs.writeFileSync(live, PNG);

    // v1..v5: never archived, all naming the live file. This is the damage.
    for (let v = 1; v <= 5; v++) {
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version, metadata)
                    VALUES (?, ?, ?, 'storyboard', '1A.png', ?, ?, ?)`)
            .run(generateId(), projectId, shotId, live, v, JSON.stringify({ provider: 'runway' }));
    }
    // v6: properly archived to its own file.
    const arch = path.join(dir, 'versions', '1A_v6.png');
    fs.writeFileSync(arch, Buffer.concat([PNG, Buffer.from('v6')]));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version, metadata)
                VALUES (?, ?, ?, 'storyboard', '1A_v6.png', ?, 6, ?)`)
        .run(generateId(), projectId, shotId, arch, JSON.stringify({ provider: 'openai' }));
    // v7: the live frame.
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version, metadata)
                VALUES (?, ?, ?, 'storyboard', '1A.png', ?, 7, ?)`)
        .run(generateId(), projectId, shotId, live, JSON.stringify({ provider: 'meshy' }));

    return { projectId, shotId };
}


/**
 * A shot whose versions were archived the way the app archives them: each
 * outgoing picture copied to `versions/{code}_v{n}.png` and its row repointed.
 * This is the shape every project has from now on.
 */
function archivedShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Archived');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '2B', JSON.stringify({ shot_code: '2B' }));

    const dir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId);
    fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });

    for (let v = 1; v <= 3; v++) {
        const f = path.join(dir, 'versions', `2B_v${v}.png`);
        fs.writeFileSync(f, Buffer.concat([PNG, Buffer.from(`v${v}`)]));
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version, metadata)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, ?, '{}')`)
            .run(generateId(), projectId, shotId, `2B_v${v}.png`, f, v);
    }
    const live = path.join(dir, '2B.png');
    fs.writeFileSync(live, Buffer.concat([PNG, Buffer.from('live')]));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version, metadata)
                VALUES (?, ?, ?, 'storyboard', '2B.png', ?, 4, '{}')`)
        .run(generateId(), projectId, shotId, live);

    return { projectId, shotId };
}

const frames = shotId => {
    const { handleStoryboard } = require('../routes/storyboard');
    return callRoute(handleStoryboard, 'GET', `/film/shots/${shotId}/frames`);
};

// ── The four defects ────────────────────────────────────────────────────

test('exactly one version is reported as the one on the board', async () => {
    // Six rows claiming `is_current` is not a cosmetic error: the modal hides
    // Restore on the current version, so six attempts cannot be selected at all.
    const { shotId } = damagedShot();
    const r = await frames(shotId);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const current = r.body.versions.filter(v => v.is_current);
    assert.strictEqual(current.length, 1,
        `${current.length} versions claim to be on the board (v${current.map(v => v.version).join(', v')})`);
    assert.strictEqual(current[0].version, 7, 'the newest version is not the one on the board');
});

test('every version that can be selected has a distinct picture', async () => {
    // Seven rows, five of them the same image, is a chooser you cannot choose
    // from. A version whose own file was never archived cannot be recovered —
    // that has to be said rather than shown as a duplicate thumbnail.
    const { shotId } = damagedShot();
    const r = await frames(shotId);
    const selectable = r.body.versions.filter(v => v.restorable);
    const urls = selectable.map(v => v.url);
    assert.strictEqual(new Set(urls).size, urls.length,
        `two selectable versions show the same picture: ${urls.join(', ')}`);
});

test('a version whose picture was never kept says so, and cannot be restored', async () => {
    // Honesty over hiding. These rows are real history — they record that an
    // attempt happened and what it cost — and dropping them would rewrite the
    // ledger. Marking them unrecoverable keeps the record and stops the lie.
    const { shotId } = damagedShot();
    const r = await frames(shotId);
    const lost = r.body.versions.filter(v => !v.restorable && !v.is_current);
    assert.ok(lost.length > 0, 'the fixture has unarchived versions and none were flagged');
    for (const v of lost) {
        assert.ok(v.reason, `v${v.version} is not restorable and gives no reason`);
        assert.match(v.reason, /archiv|kept|overwritten|not saved/i,
            `v${v.version}'s reason does not explain what happened: ${v.reason}`);
    }
});

test('each version carries something to tell it apart by', async () => {
    // The literal ask: "we don't know which is which". A version needs an
    // identity beyond its number — when it was made, what made it, and whether
    // it came from a regenerate, a refine or a restore.
    const { shotId } = damagedShot();
    const r = await frames(shotId);
    const missing = [];
    for (const v of r.body.versions) {
        if (!v.created_at) missing.push(`v${v.version}: no timestamp`);
        if (v.provider === undefined) missing.push(`v${v.version}: no provider field`);
        if (!v.origin) missing.push(`v${v.version}: does not say how it was made`);
    }
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('the provider that made each attempt is reported when it is known', async () => {
    // Two attempts from different providers is exactly the case where you want
    // an earlier one back, and the reason "which is which" matters.
    const { shotId } = damagedShot();
    const r = await frames(shotId);
    const named = r.body.versions.filter(v => v.provider);
    assert.ok(named.length >= 3,
        `only ${named.length} versions report a provider, though the metadata holds one`);
});

// ── Restore still behaves ───────────────────────────────────────────────

test('restoring an unrecoverable version is refused, not half-done', async () => {
    const { handleStoryboard } = require('../routes/storyboard');
    const { shotId } = damagedShot();
    const r = await frames(shotId);
    const lost = r.body.versions.find(v => !v.restorable && !v.is_current);
    const attempt = await callRoute(handleStoryboard, 'POST',
        `/film/shots/${shotId}/frames/${lost.version}/restore`);
    assert.ok(attempt.status >= 400,
        `restoring a version whose picture was never kept was accepted: ${JSON.stringify(attempt.body)}`);
});

test('selecting a version points at it and creates nothing', async () => {
    /*
     * Reported from use: "when I switch versions it keeps adding new versions
     * instead of keeping the number of versions in relation to the images
     * generated — me selecting a previous version counts it as a new version."
     *
     * That was deliberate and wrong. Copying the chosen attempt to a new
     * highest version kept history perfectly and made the COUNT a lie: five
     * generations plus one selection read as six attempts, and "which am I on"
     * stopped having an answer. Versions are the generations; which one is on
     * the board is a pointer, and moving a pointer creates nothing.
     */
    const { handleStoryboard } = require('../routes/storyboard');
    const { shotId } = damagedShot();
    const before = await frames(shotId);
    const countBefore = before.body.versions.length;
    const good = before.body.versions.find(v => v.restorable && !v.is_current);
    assert.ok(good, 'the fixture has no restorable version');

    const r = await callRoute(handleStoryboard, 'POST', `/film/shots/${shotId}/frames/${good.version}/restore`);
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.version, good.version,
        'selecting a version reported a different one');

    const after = await frames(shotId);
    assert.strictEqual(after.body.versions.length, countBefore,
        `selecting an attempt created a version: ${countBefore} generations became `
        + `${after.body.versions.length}`);
    assert.strictEqual(after.body.versions.filter(v => v.is_current).length, 1,
        'more than one version claims to be on the board');
    assert.strictEqual(after.body.versions.find(v => v.is_current).version, good.version,
        'the board is not showing the version that was selected');
});

test('nothing is lost by selecting: every earlier attempt survives', async () => {
    // The forward-only design existed to protect history. The pointer has to
    // protect it just as well, or this trade was a downgrade.
    const { handleStoryboard } = require('../routes/storyboard');
    const { shotId } = damagedShot();
    const before = await frames(shotId);
    const versionsBefore = before.body.versions.map(v => v.version).sort((a, b) => a - b);
    const good = before.body.versions.find(v => v.restorable && !v.is_current);

    await callRoute(handleStoryboard, 'POST', `/film/shots/${shotId}/frames/${good.version}/restore`);
    const after = await frames(shotId);
    assert.deepStrictEqual(after.body.versions.map(v => v.version).sort((a, b) => a - b),
        versionsBefore, 'selecting an attempt changed which attempts exist');
});

// ── The modal shows it ──────────────────────────────────────────────────

test('the modal renders what distinguishes one attempt from another', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('async function openFrameVersions'),
        html.indexOf('function closeFrameVersions'));
    const missing = [];
    for (const [field, why] of [
        ['v.created_at', 'when it was made'],
        ['v.provider', 'what made it'],
        ['v.origin', 'whether it was a regenerate, a refine or a restore'],
        ['v.reason', 'why an unrecoverable version cannot be chosen'],
    ]) {
        if (!fn.includes(field)) missing.push(`${field} — ${why}`);
    }
    assert.deepStrictEqual(missing, [], `the modal does not show:\n  ${missing.join('\n  ')}`);
});

test('an unrecoverable version offers no Restore button', () => {
    // A button that cannot work is worse than no button: it reads as a working
    // feature until pressed.
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('async function openFrameVersions'),
        html.indexOf('function closeFrameVersions'));
    assert.match(fn, /v\.restorable/,
        'the modal offers Restore without checking whether the picture still exists');
});


// ── The label after a restore ───────────────────────────────────────────

test('after selecting, the number on the card IS the picture', async () => {
    /*
     * "I was at v5, selected v3, and the card shows v6."
     *
     * The old answer was to report `shows_version` alongside, so v6 could say
     * it carried v3's picture. That is a label explaining a confusing number.
     * The number is not confusing any more: selecting v3 shows v3, so the card
     * and the picture agree without anything having to explain them.
     */
    const { handleStoryboard } = require('../routes/storyboard');
    const { shotId, projectId } = damagedShot();
    const before = await frames(shotId);
    const good = before.body.versions.find(v => v.restorable && !v.is_current);

    const r = await callRoute(handleStoryboard, 'POST', `/film/shots/${shotId}/frames/${good.version}/restore`);
    assert.ok(r.status < 400, JSON.stringify(r.body));
    const after = await frames(shotId);
    const now = after.body.versions.find(v => v.is_current);
    assert.strictEqual(now.version, good.version,
        `selected v${good.version} and the board reports v${now.version}`);

    // And the board — the surface the report came from — agrees.
    const board = await callRoute(handleStoryboard, 'GET', `/film/projects/${projectId}/storyboard`);
    const frame = board.body.frames.find(f => f.shot_id === shotId);
    assert.ok(frame, 'the shot vanished from the board');
});

test('an ordinary generation reports no divergence', async () => {
    // The label must stay a plain number in the normal case, or every card
    // grows an arrow that means nothing.
    const { shotId } = damagedShot();
    const r = await frames(shotId);
    for (const v of r.body.versions.filter(x => !x.restored_from)) {
        assert.strictEqual(v.shows_version, v.version,
            `v${v.version} claims to show v${v.shows_version} without having been restored`);
    }
});

test('the card names both numbers only when they differ', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    assert.match(html, /function frameVersionLabel/, 'the card has no label function');
    const fn = html.slice(html.indexOf('function frameVersionLabel'),
        html.indexOf('function frameVersionTitle'));
    assert.match(fn, /asset_shows_version/, 'the label ignores which picture is shown');
    assert.match(fn, /shows !== v/, 'the label does not compare the two, so it would always show an arrow');
});


// ── The pictures actually load ──────────────────────────────────────────

test('every URL the modal renders serves real bytes', async () => {
    // The defect this file was written for and did not catch: the DATA was
    // fixed — distinct urls, honest is_current, origins — and 9 of 11 of those
    // urls returned 404, so the modal was a grid of broken images. Asserting
    // that two versions have different urls says nothing about whether either
    // one loads.
    //
    // archiveExistingFrame writes to `{project}/versions/{code}_v{n}.png`, and
    // serveStoryboardImage only ever looked in `{project}/`. The URL is built
    // from file_name, which carries no directory, so the two halves disagreed
    // about where a version lives and nothing connected them.
    const { handleStoryboard } = require('../routes/storyboard');
    const { shotId, projectId } = archivedShot();

    const list = await frames(shotId);
    assert.ok(list.body.versions.length >= 3, 'the fixture has too few versions to be meaningful');

    const broken = [];
    for (const v of list.body.versions) {
        const file = decodeURIComponent(v.url.split('/').pop());
        const r = await new Promise(resolve => {
            const chunks = [];
            const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
            res.statusCode = 200;
            res.writeHead = function (code) { this.statusCode = code; return this; };
            res.setHeader = function () {};
            res.on('finish', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length }));
            handleStoryboard({ method: 'GET' }, res,
                ['film', 'storyboards', projectId, file], {});
        });
        if (r.status !== 200 || r.bytes < 8) {
            broken.push(`v${v.version}: ${file} → ${r.status} (${r.bytes} bytes)`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('an archived version is served from where the archiver put it', async () => {
    // Directly, because the round trip above could pass if the archiver ever
    // stopped using a subdirectory — and then this test would be guarding
    // nothing while still going green.
    const { handleStoryboard } = require('../routes/storyboard');
    const { projectId } = archivedShot();
    const dir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId, 'versions');
    assert.ok(fs.existsSync(dir), 'the archiver no longer writes to a versions/ subdirectory');

    const file = fs.readdirSync(dir)[0];
    const r = await new Promise(resolve => {
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length }));
        handleStoryboard({ method: 'GET' }, res, ['film', 'storyboards', projectId, file], {});
    });
    assert.strictEqual(r.status, 200, `${file} is on disk in versions/ and the route returns ${r.status}`);
    assert.ok(r.bytes > 0, 'the file served zero bytes');
});

test('a filename cannot escape the project directory', () => {
    // Widening where the route looks is exactly when a traversal creeps back
    // in. Asserted over the shapes that matter rather than one example.
    const { handleStoryboard } = require('../routes/storyboard');
    const { projectId } = archivedShot();
    const attempts = ['../../../etc/passwd', '..%2F..%2Fsecret.png', 'versions/../../escape.png',
        '/etc/passwd', 'a/../../b.png'];
    const leaked = [];
    for (const bad of attempts) {
        const st = { status: 0 };
        const res = new Writable({ write(_c, _e, n) { n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { st.status = code; return this; };
        res.setHeader = function () {};
        handleStoryboard({ method: 'GET' }, res, ['film', 'storyboards', projectId, bad], {});
        if (st.status === 200) leaked.push(bad);
    }
    assert.deepStrictEqual(leaked, [], `these escaped the project directory: ${leaked.join(', ')}`);
});
