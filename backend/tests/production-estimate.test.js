/**
 * What the film will cost, before it is made.
 *
 *   - the work is COUNTED from the project: subjects x their views, one frame
 *     per shot, the footage at each shot's own length; with no shots, the
 *     running time cut into shots of the stated average;
 *   - every category is priced through the adapter's own meter, so a
 *     resolution or a generator changed here changes the figure exactly as it
 *     would change the bill (differential, not grepped);
 *   - a generator that cannot deliver the size asked is said, and the same work
 *     is priced on every connected generator;
 *   - the route, the tool and the Budget page's tab all serve it, free.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-prodest-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();
const providers = require('../lib/providers');
const E = require('../lib/production-estimate');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** A fake image and video provider with simple, known prices. */
const rates = require('../lib/provider-pricing').RATE_BOOK;
rates['testimg:image'] = { unit: 'image', native_unit: 'image', native_per_unit: 1, usd_per_native: 0.10,
    models: { 'img-hi': { usd_per_native: 0.30 } }, source: 'test', checked: '2026-09-30' };
rates['testvid:video'] = { unit: 'second', native_unit: 'second', native_per_unit: 1, usd_per_native: 0.20,
    models: { 'vid-720p': { usd_per_native: 0.20 }, 'vid-4k': { usd_per_native: 1.00 } }, source: 'test', checked: '2026-09-30' };
providers.register({
    id: 'testimg', label: 'Test images', kind: 'generator', requiresKey: false, capabilities: ['image'],
    sizeControl: 'exact', models: ['img-lo', 'img-hi'],
    supports: c => c === 'image', generate: async () => ({ ok: false }),
    meter: (cap, p) => ({ unit: 'image', quantity: 1, model: p.model || 'img-lo' }),
});
providers.register({
    id: 'testvid', label: 'Test video', kind: 'generator', requiresKey: false, capabilities: ['video'],
    models: ['vid-720p', 'vid-4k'],
    supports: c => c === 'video', generate: async () => ({ ok: false }),
    // The model is the tier, chosen from the size asked: 4K or 720p.
    meter: (cap, p) => ({ unit: 'second', quantity: p.duration_s,
        model: p.model || (/^3840x/.test(p.target_resolution) ? 'vid-4k' : 'vid-720p') }),
    deliverableFrame: p => ({ width: 1280, height: 720, downgraded: /^3840x/.test(p.target_resolution) && p.model === 'vid-720p',
        why: 'this model makes 720p' }),
});

function project({ shots = [], characters = 1, locations = 1, props = 1, target = 0 } = {}) {
    const id = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, target_resolution, aspect_ratio, provider_config, target_duration_ms)
        VALUES (?, ?, '1920x1080', '16:9', ?, ?)`).run(id, 'Estimate', JSON.stringify({ image: 'testimg', video: 'testvid' }), target);
    for (let i = 0; i < characters; i++) db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)').run(generateId(), id, 'C' + i);
    for (let i = 0; i < locations; i++) db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(generateId(), id, 'L' + i);
    for (let i = 0; i < props; i++) db.prepare('INSERT INTO film_props (id, project_id, name) VALUES (?, ?, ?)').run(generateId(), id, 'P' + i);
    if (shots.length) {
        const scene = generateId();
        db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, ?)').run(scene, id, 'L0');
        shots.forEach((ms, i) => db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, duration_ms) VALUES (?, ?, ?, ?)')
            .run(generateId(), scene, '1' + String.fromCharCode(65 + i), ms));
    }
    return id;
}

test('the work is counted from the project, and priced through the meters', () => {
    const id = project({ shots: [4000, 6000], characters: 2, locations: 1, props: 3 });
    const d = E.estimateProduction(id, { alternatives: false });
    assert.equal(d.generators.image.provider, 'testimg');
    assert.equal(d.generators.video.provider, 'testvid');
    const plates = d.lines.filter(l => l.category === 'plates');
    const by = k => plates.find(l => l.kind === k);
    assert.equal(by('character').count, 8, 'two characters at four views');
    assert.equal(by('location').count, 4);
    assert.equal(by('prop').count, 3);
    assert.equal(d.totals.plates, 1.5, '15 pictures at $0.10');
    assert.equal(d.totals.storyboard, 0.2, 'one frame per shot');
    assert.equal(d.counts.footage_seconds, 10);
    assert.equal(d.totals.footage, 2, '10 s at $0.20 (720p at the project\'s 1080p)');
    assert.equal(d.totals.total, 3.7);
});

test('a resolution or a generator changed here changes the figure exactly as the bill would', () => {
    const id = project({ shots: [5000] });
    const base = E.estimateProduction(id, { alternatives: false });
    const k4 = E.estimateProduction(id, { resolution: '4k_uhd', alternatives: false });
    assert.equal(k4.resolution.width, 3840);
    assert.equal(k4.totals.footage, 5, '5 s at the 4K rate');
    assert.ok(k4.totals.footage > base.totals.footage, 'the resolution reached the price');
    const hi = E.estimateProduction(id, { image_model: 'img-hi', alternatives: false });
    assert.ok(hi.totals.plates > base.totals.plates && hi.totals.storyboard > base.totals.storyboard, 'the model reached the price');
    // Takes multiply; views change the count.
    const more = E.estimateProduction(id, { takes: { footage: 3 }, views: { character: 1 }, alternatives: false });
    assert.equal(more.totals.footage, base.totals.footage * 3);
    assert.equal(more.lines.find(l => l.kind === 'character').count, 1);
});

test('a generator that cannot deliver the size is priced at what it makes, and said', () => {
    const id = project({ shots: [5000] });
    const d = E.estimateProduction(id, { resolution: '4k_uhd', video_model: 'vid-720p', alternatives: false });
    const foot = d.lines.find(l => l.category === 'footage');
    assert.equal(foot.downgraded, true);
    assert.equal(foot.delivered, '1280x720');
    assert.ok(d.notes.some(n => /cannot deliver 3840x2160/.test(n)), d.notes.join(' | '));
});

test('with no shots the running time is cut into shots; the screenplay or target length is the source', () => {
    const id = project({ target: 60000 });
    const d = E.estimateProduction(id, { alternatives: false });
    assert.equal(d.runtime.source, 'the project\'s target length');
    assert.equal(d.counts.frames, 15, '60 s in shots of 4 s');
    assert.equal(d.counts.footage_seconds, 60);
    const e = E.estimateProduction(id, { shot_seconds: 6, runtime_seconds: 120, alternatives: false });
    assert.equal(e.counts.frames, 20);
    assert.equal(e.runtime.source, 'entered here');
});

test('every connected generator is priced for the same work, and the chosen one is marked', () => {
    const id = project({ shots: [5000] });
    const d = E.estimateProduction(id);
    const img = d.alternatives.image.filter(a => a.provider === 'testimg');
    assert.deepEqual(img.map(a => a.model).sort(), ['img-hi', 'img-lo']);
    assert.ok(d.alternatives.video.some(a => a.provider === 'testvid' && a.current), 'the current generator is not marked');
    for (const cap of ['image', 'video']) {
        const usd = d.alternatives[cap].map(a => a.usd);
        assert.deepEqual(usd, [...usd].sort((a, b) => a - b), `${cap} alternatives are not cheapest first`);
    }
});

test('the route, the tool and the Budget tab serve it, free', async () => {
    const id = project({ shots: [5000] });
    const { handleBudget } = require('../routes/budget');
    const r = await new Promise(resolve => {
        const res = { statusCode: 200, writeHead(s) { this.statusCode = s; }, setHeader() {},
            end(c) { resolve({ status: this.statusCode, data: JSON.parse(String(c)) }); } };
        handleBudget({ method: 'GET', body: {} }, res, ['film', 'projects', id, 'budget', 'production'], { resolution: '4k_uhd', alternatives: 'false' });
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.free, true);
    assert.equal(r.data.resolution.id, '4k_uhd');
    const { callTool, isFailure, listTools } = require('../lib/mcp-tools');
    assert.ok(listTools().some(t => t.name === 'budget_production_estimate'));
    const t = await callTool('budget_production_estimate', { project_id: id, resolution: '720p' });
    assert.ok(!isFailure(t), JSON.stringify(t).slice(0, 300));
    assert.ok(/Film Estimate/.test(HTML) && /budget\/production/.test(HTML), 'no Film Estimate tab');
    assert.ok(/film: 'budgetTabFilm'/.test(HTML), 'the tab is not one of the Budget panels');
    assert.ok(/prodEstSet\('resolution'/.test(HTML) && /prodEstSet\('image'/.test(HTML) && /prodEstSet\('video'/.test(HTML),
        'the tab cannot change the resolution or a generator');
});
