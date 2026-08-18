#!/usr/bin/env node
/**
 * Live Runway smoke test: will the first real shot work?
 *
 *   node backend/smoke-runway.js [project-id] [--video] [--keep]
 *
 * The preflight answers "is this configured"; it opens sockets and reads
 * config, and deliberately generates nothing. That leaves one question it
 * cannot answer — whether a real generation completes, comes back, and lands
 * somewhere the rest of the pipeline can see it. This spends a small amount of
 * money to answer exactly that, before a real shot depends on it.
 *
 * It drives lib/providers/runway.js rather than calling the API directly. A
 * hand-rolled curl proves the account works and nothing about the code that
 * will actually run: the request builder, the ratio snapping, the async task
 * poll, and the media download are all adapter behaviour, and all of them are
 * places this has broken before.
 *
 * Cost, at $0.01/credit:
 *   image (default)  gen4_image 720p   5 credits   ~$0.05
 *   --video          gen4.5 @ 5s      60 credits   ~$0.60
 *
 * The image path exercises everything except the video model itself: auth,
 * request shape, task polling, download, persistence, asset registration. Run
 * it first; add --video only when you want the video model itself confirmed.
 */

const path = require('path');
const { adapter: runway } = require('./lib/providers/runway');
const { persistProviderMedia } = require('./lib/provider-media');
const { db, generateId } = require('./db/database');
const providers = require('./lib/providers');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' };
const pass = m => console.log(`  ${C.g}PASS${C.x}  ${m}`);
const fail = (m, d) => { console.log(`  ${C.r}FAIL${C.x}  ${m}`); if (d) console.log(`        ${C.d}${d}${C.x}`); };
const info = m => console.log(`  ${C.c}····${C.x}  ${m}`);

/** The whole point: a stage that fails must say what to do about it. */
function bail(message, fix) {
    fail(message);
    console.log(`\n${C.y}To fix:${C.x} ${fix}\n`);
    process.exit(1);
}

async function main() {
    const argv = process.argv.slice(2);
    const wantVideo = argv.includes('--video');
    const keep = argv.includes('--keep');
    const projectId = argv.find(a => !a.startsWith('--')) || null;

    const kind = wantVideo ? 'video' : 'image';
    const cost = wantVideo ? '~60 credits (~$0.60)' : '~5 credits (~$0.05)';

    console.log(`\n${C.c}Runway live smoke test${C.x} — ${kind}, ${cost}`);
    console.log('─'.repeat(70));

    // ── 1. Credential ───────────────────────────────────────────────────────
    if (!providers.isProviderConfigured('runway')) {
        bail('no Runway credential stored',
            'paste the developer-portal key in Settings > Providers > Runway, or set RUNWAY_API_KEY');
    }
    pass('credential present');

    // ── 2. Resolution ───────────────────────────────────────────────────────
    // Worth its own stage: a stored key that the registry does not route to is
    // the failure mode that made every capability quietly fall to Gridlight.
    const resolved = providers.resolveId('video', {});
    if (resolved !== 'runway') {
        fail(`video resolves to '${resolved}', not runway`);
        info('the key is stored but something is overriding it — check the project provider_config');
    } else {
        pass(`video resolves to runway for a project with no explicit config`);
    }

    // ── 3. Generate ─────────────────────────────────────────────────────────
    // The prompt is deliberately dull. This is a connectivity test, not a
    // creative one, and a bland subject is least likely to trip a content
    // filter and report an account problem that isn't one.
    const payload = wantVideo
        ? { prompt: 'A slow push in on an empty wooden chair in a bare room, daylight', duration: 5, ratio: '1280:720' }
        : { prompt: 'An empty wooden chair in a bare room, daylight', ratio: '1280:720' };

    info(`submitting ${kind} generation and polling to completion…`);
    const started = Date.now();
    const result = await runway.generate(kind, payload, { timeout: 300000 });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (!result.ok) {
        fail(`generation failed after ${elapsed}s`, result.error);
        const e = String(result.error || '');
        if (/credit|balance|quota|payment/i.test(e)) {
            bail('the account has no API credits',
                'buy credits at dev.runwayml.com — an app subscription does NOT fund API calls');
        }
        if (/401|unauthor|invalid.*key|forbidden/i.test(e)) {
            bail('the key was rejected',
                'confirm the key came from the developer portal (dev.runwayml.com), not the Runway app');
        }
        bail('generation did not complete', 'see the provider error above');
    }
    pass(`generation completed in ${elapsed}s`);
    if (result.provider_model) info(`model: ${result.provider_model}`);

    // ── 4. Retrieve the media ───────────────────────────────────────────────
    // Runway answers with a URL, not bytes. "The task succeeded" and "we hold
    // the file" are different claims, and only the second one lets a shot reach
    // the timeline.
    const project = projectId
        ? db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId)
        : db.prepare('SELECT * FROM film_projects ORDER BY updated_at DESC LIMIT 1').get();

    if (!project) bail('no project to store the asset against', 'create a project first');

    const ext = wantVideo ? 'mp4' : 'png';
    const subdir = wantVideo ? 'video' : 'storyboards';
    const filename = `_smoketest_runway.${ext}`;

    let stored;
    try {
        stored = await persistProviderMedia(project.id, subdir, filename, result.data || result);
    } catch (err) {
        bail(`the generation succeeded but the media could not be retrieved: ${err.message}`,
            'the task completed on Runway but the asset never reached disk — check network egress');
    }
    const bytes = stored && stored.size ? stored.size : null;
    pass(`media downloaded to ${subdir}/${filename}${bytes ? ` (${bytes} bytes)` : ''}`);

    // ── 5. Register it ──────────────────────────────────────────────────────
    // The claim being tested is "assets land in Film Engine". A file on disk
    // that no row points at is invisible to the timeline, QA and NLE export.
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_name, metadata, created_at)
                VALUES (?, ?, 'other', ?, ?, datetime('now'))`)
        .run(assetId, project.id, filename, JSON.stringify({ kind: 'smoke_test', provider: 'runway' }));

    const row = db.prepare('SELECT id FROM film_assets WHERE id = ?').get(assetId);
    if (!row) bail('the asset row did not persist', 'database write failed');
    pass(`registered in film_assets against project "${project.title}"`);

    if (!keep) {
        db.prepare('DELETE FROM film_assets WHERE id = ?').run(assetId);
        info('smoke-test asset row removed (pass --keep to retain it)');
    }

    console.log('─'.repeat(70));
    console.log(`${C.g}Runway is live end to end.${C.x} Auth, generation, polling, download and`);
    console.log(`asset registration all work — the path a real shot takes.`);
    if (!wantVideo) console.log(`${C.d}Re-run with --video to confirm the video model itself (~$0.60).${C.x}`);
    console.log();
}

main().catch(err => {
    console.error(`\n${C.r}smoke test crashed:${C.x} ${err.stack || err.message}\n`);
    process.exit(1);
});
