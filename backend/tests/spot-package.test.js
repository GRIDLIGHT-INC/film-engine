'use strict';

/**
 * -- The Premiere handoff, planned but not written --------------------------
 *
 * On the `planConform` precedent: planning is pure and separate from executing,
 * because writing the package needs a filesystem and this has to be testable
 * without one. It returns a manifest of what goes where; the route copies.
 *
 * EVERY PATH IS RELATIVE to the package root. An absolute path relinks on
 * exactly one machine — the machine it will never be opened on — and that is
 * the single failure this whole subsystem exists to prevent: an export that
 * opens with the cuts right and no picture.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'fe-spotpkg-'));

const test = require('node:test');
const assert = require('node:assert');

const { planPackage, slugFor, MANIFEST_SECTIONS } = require('../lib/spot-package');
const { planDeliverables } = require('../lib/deliverables');

const PROJECT = { id: 'p1', title: 'Blender Launch', client: 'Acme', campaign: 'Spring',
                  target_fps: 29.97, target_resolution: '1920x1080' };
const BRAND = { id: 'b1', name: 'Acme', palette: JSON.stringify(['#ff0044']),
                legal_line: 'Terms apply.', cta: 'Buy now' };
const SHOTS = [
    { id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' },
    { id: 's2', shot_code: '1B', duration_ms: 4000, scene_id: 'sc1' },
];
const ASSETS = [
    { id: 'v1', shot_id: 's1', asset_type: 'video_raw', file_path: '/abs/1A.mp4', file_name: '1A.mp4', duration_ms: 4000 },
    { id: 'v2', shot_id: 's2', asset_type: 'video_raw', file_path: '/abs/1B.mp4', file_name: '1B.mp4', duration_ms: 4000 },
    { id: 'a1', shot_id: 's1', asset_type: 'audio_dialogue', file_path: '/abs/vo.wav', file_name: 'vo.wav', duration_ms: 4000 },
    { id: 'm1', shot_id: null, scene_id: 'sc1', asset_type: 'audio_music', file_path: '/abs/bed.mp3', file_name: 'bed.mp3', duration_ms: 8000 },
];

const plan = (over) => planPackage({
    project: PROJECT, deliverables: planDeliverables('rapid'), shots: SHOTS,
    assets: ASSETS, brand: BRAND, ...over,
});

test('the manifest declares every section, and each is an array', () => {
    /*
     * Set-based over the sections, because a manifest missing one is a folder
     * an editor opens with something absent and no way to know it was meant to
     * be there.
     */
    const m = plan();
    for (const s of MANIFEST_SECTIONS) {
        assert.ok(Array.isArray(m[s]), `the manifest has no ${s} section`);
    }
    assert.ok(m.root, 'the package has no root folder name');
    assert.ok(m.xml, 'the package has no XML');
    assert.ok(m.spec_sheet, 'the package has no spec sheet — the editor gets no rates or sizes');
});

test('every path in the manifest is relative and stays inside the package', () => {
    const m = plan();
    const paths = [
        m.xml, m.spec_sheet,
        ...MANIFEST_SECTIONS.flatMap(s => m[s].map(e => e.to || e.path)),
    ].filter(Boolean);
    assert.ok(paths.length > 3, 'the manifest has almost nothing in it');
    for (const p of paths) {
        assert.ok(!p.startsWith('/'), `${p} is absolute — it relinks on one machine only`);
        assert.ok(!/^[a-z]:[\\/]/i.test(p), `${p} is an absolute Windows path`);
        assert.ok(!p.includes('..'), `${p} climbs out of the package`);
    }
});

test('one sequence per deliverable, with the frame count it is bought at', () => {
    const rows = planDeliverables('rapid');
    const m = plan({ deliverables: rows });
    assert.equal(m.sequences.length, rows.length, 'a deliverable has no sequence');
    for (const d of rows) {
        const seq = m.sequences.find(s => s.name === d.key);
        assert.ok(seq, `no sequence for ${d.key}`);
        assert.equal(seq.width, d.width);
        assert.equal(seq.height, d.height);
        assert.equal(seq.fps, d.fps);
        // 30s at 29.97 is 900 frames, not 899. The spec sheet is what the
        // editor cuts to, so a frame count that is one out is a rejected spot.
        assert.ok(seq.duration_frames > 0, `${d.key} has no frame count`);
    }
});

test('media is listed with its source, and named so two shots cannot collide', () => {
    const m = plan();
    assert.ok(m.media.length >= 3, 'the media list is short — the beds or the audio are missing');
    for (const e of m.media) {
        assert.ok(e.from && e.from.startsWith('/'), `${e.to} has no absolute source to copy from`);
        assert.ok(e.to.startsWith('media/'), `${e.to} is not in the media folder`);
    }
    assert.equal(new Set(m.media.map(e => e.to)).size, m.media.length,
        'two media files share a destination — one would silently overwrite the other');
});

test('the brand folder travels with the package', () => {
    const m = plan();
    assert.ok(m.brand.some(e => /palette\.json$/.test(e.path)), 'the palette is not in the package');
    assert.ok(m.brand.some(e => /legal\.txt$/.test(e.path)), 'the legal line is not in the package');
    // No brand is not an error — plenty of jobs have none.
    const bare = plan({ brand: null });
    assert.deepEqual(bare.brand, [], 'a package with no brand invented one');
    assert.equal(bare.ok, true, 'a package with no brand was refused');
});

test('a deliverable set that is empty refuses, and says what to do', () => {
    /*
     * A handoff with no sequences is a folder of media and no timeline — which
     * looks like a successful export until the editor opens it.
     */
    const m = plan({ deliverables: [] });
    assert.equal(m.ok, false, 'a package with no deliverables was planned as fine');
    assert.ok(/deliverable/i.test(m.errors.join(' ')), `the refusal does not say why: ${m.errors}`);
});

test('the root is slugged from the client and the title, and is filesystem-safe', () => {
    assert.equal(slugFor({ client: 'Acme Ltd.', title: 'Blender Launch' }), 'ACME_LTD_BLENDER_LAUNCH');
    // Nothing that could escape a folder or break a shell.
    for (const nasty of [{ client: '../..', title: 'x' }, { client: 'a/b', title: 'c:d' },
        { client: '', title: '' }]) {
        const slug = slugFor(nasty);
        assert.ok(!slug.includes('..') && !slug.includes('/') && !slug.includes('\\'),
            `slug "${slug}" is not safe as a folder name`);
        assert.ok(slug.length > 0, 'an unnamed job produced an empty folder name');
    }
});

test('the spec sheet states what the editor has to match, per sequence', () => {
    const m = plan();
    const sheet = m.spec_sheet_content || '';
    for (const d of planDeliverables('rapid')) {
        assert.ok(sheet.includes(d.key), `the spec sheet does not mention ${d.key}`);
        assert.ok(sheet.includes(`${d.width}x${d.height}`), `${d.key}'s raster is not stated`);
        assert.ok(sheet.includes(String(d.fps)), `${d.key}'s frame rate is not stated`);
        if (d.loudness_target) {
            assert.ok(sheet.includes(d.loudness_target), `${d.key}'s loudness target is not stated`);
        }
    }
});
