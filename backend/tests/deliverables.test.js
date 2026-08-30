'use strict';

/**
 * -- A commercial is a fan-out, not a short film ----------------------------
 *
 * A film has ONE shape. A commercial resolves to fourteen to twenty-two files:
 * a broadcast master, cut-downs, three or four ratios, captions burned and
 * sidecar, a textless version, stems and end-frame stills. The engine's data
 * model could not represent that at all — a project carried exactly one
 * aspect_ratio, one resolution and one delivery preset.
 *
 * The set is decided BEFORE anything is generated, and that ordering is the
 * whole point rather than a convenience: it is what says which shots must be
 * shot vertical rather than cropped later. A 9:16 centre crop of a 16:9 frame
 * keeps 32% of its width, 1:1 keeps 56%, 4:5 keeps 45% — and Premiere's Auto
 * Reframe follows a subject inside available pixels, it cannot invent the
 * two-thirds that were never generated.
 *
 * Set-based over DELIVERY_PROFILES because the failure is per-profile: a
 * planner that handles 16:9 perfectly and mis-sizes 9:16 passes any test
 * written against the broadcast master.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'fe-deliv-'));

const test = require('node:test');
const assert = require('node:assert');

const {
    DELIVERY_PROFILES, PACKAGES, planDeliverables, nativeRatiosFor,
    frameCount, validateDeliverable,
} = require('../lib/deliverables');
const { ASPECT_RATIO_IDS } = require('../lib/project-presets');

test('every profile is internally consistent, and its ratio is one the engine knows', () => {
    /*
     * A profile naming a ratio the project settings cannot express is a
     * deliverable nothing can be generated for — and it would be discovered at
     * generation time, after the board is paid for.
     */
    for (const p of DELIVERY_PROFILES) {
        assert.ok(p.id && p.label, `a profile has no id or label: ${JSON.stringify(p)}`);
        assert.ok(ASPECT_RATIO_IDS.includes(p.aspect),
            `${p.id} wants ${p.aspect}, which is not a ratio this engine can set`);
        assert.ok(p.width > 0 && p.height > 0, `${p.id} has no raster`);
        assert.equal(p.width % 2, 0, `${p.id} has an odd width — h.264 refuses it`);
        assert.equal(p.height % 2, 0, `${p.id} has an odd height — h.264 refuses it`);
        assert.ok(p.fps > 0, `${p.id} has no frame rate`);
        assert.ok(p.duration_ms > 0, `${p.id} has no runtime`);

        // The raster must BE the ratio it claims, or a "4:5 deliverable" is a
        // 16:9 file with a label on it.
        const want = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 }[p.aspect];
        assert.ok(want, `${p.id}: this test does not know the shape of ${p.aspect}`);
        assert.ok(Math.abs((p.width / p.height) - want) < 0.01,
            `${p.id} claims ${p.aspect} and its raster is ${p.width}x${p.height}`);
    }
});

test('a vertical or near-vertical profile must be generated native, never cropped', () => {
    /*
     * The number that justifies the whole module. Any profile narrower than
     * 16:9 loses width that a crop cannot recover, so it carries native:true
     * and the board shoots it twice. A 1:1 is the deliberate exception — 56% of
     * the width survives, which is a usable crop of a centred composition.
     */
    for (const p of DELIVERY_PROFILES) {
        const shape = p.width / p.height;
        if (shape < 0.9) {
            assert.equal(p.native, true,
                `${p.id} is ${p.aspect} and is not marked native — a crop to it keeps a third of `
                + 'the frame, so the product and the CTA leave the shot');
        }
    }
});

test('every package names profiles that exist', () => {
    const ids = new Set(DELIVERY_PROFILES.map(p => p.id));
    for (const [name, list] of Object.entries(PACKAGES)) {
        assert.ok(list.length, `the ${name} package is empty`);
        for (const id of list) {
            assert.ok(ids.has(id), `the ${name} package names ${id}, which is not a profile`);
        }
    }
});

test('planning a package produces one ordered row per file, ready to persist', () => {
    const rows = planDeliverables('campaign');
    assert.equal(rows.length, PACKAGES.campaign.length,
        'the campaign package did not produce one row per profile');
    rows.forEach((r, i) => {
        assert.equal(r.sort_order, i, 'rows are not ordered — the package is a sequence, not a set');
        assert.ok(r.key, `${r.profile_id} has no key; the key IS the sequence name in the NLE`);
        assert.equal(validateDeliverable(r).valid, true,
            `a planned row does not validate: ${JSON.stringify(validateDeliverable(r).errors)}`);
    });
    // The key has to be unique, or two sequences collide in one XML.
    assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'two deliverables share a key');
});

test('an unknown package is refused rather than silently planned empty', () => {
    /*
     * Empty would be indistinguishable from "this package has no files", and a
     * project would proceed to generation with no deliverables and no warning.
     */
    assert.throws(() => planDeliverables('platinum'), /package/i,
        'an unknown package planned something instead of refusing');
});

test('native ratios are derived from the set, deduplicated, and exclude the croppable', () => {
    const rows = planDeliverables('campaign');
    const native = nativeRatiosFor(rows);
    assert.ok(native.includes('9:16'), 'the campaign package needs vertical and does not say so');
    assert.ok(native.includes('4:5'), 'the Meta feed ratio is not reported as native');
    assert.ok(!native.includes('16:9'), '16:9 is the master — it is not a native EXTRA');
    assert.ok(!native.includes('1:1'), 'square is croppable at 56% and must not force a second shoot');
    assert.equal(new Set(native).size, native.length, 'the same ratio is reported twice');

    assert.deepEqual(nativeRatiosFor([]), [], 'an empty set demands a native shoot');
});

test('frame counts are exact at every rate a spot is delivered at', () => {
    // The plan's own table. 30s at 29.97 is 900 frames, not 899.
    const EXACT = [
        [30000, 29.97, 900], [30000, 25, 750], [30000, 30, 900],
        [15000, 29.97, 450], [15000, 25, 375], [15000, 30, 450],
        [10000, 29.97, 300], [10000, 25, 250],
        [6000, 29.97, 180], [6000, 25, 150], [6000, 30, 180],
    ];
    for (const [ms, fps, want] of EXACT) {
        assert.equal(frameCount(ms, fps), want, `${ms / 1000}s at ${fps} should be ${want} frames`);
    }
    // Every profile's own runtime resolves exactly, or a deliverable cannot be
    // cut to length.
    for (const p of DELIVERY_PROFILES) {
        assert.ok(Number.isInteger(frameCount(p.duration_ms, p.fps)),
            `${p.id} does not land on a whole frame`);
    }
});

test('validation refuses what the schema would refuse, before the insert', () => {
    const ok = planDeliverables('rapid')[0];
    assert.equal(validateDeliverable(ok).valid, true);

    // Each of these is a CHECK constraint in migration 098. Caught here, the
    // caller gets a sentence; caught there, it is a 500 on a save.
    const bad = [
        [{ ...ok, platform: 'billboard' }, /platform/i],
        [{ ...ok, caption_mode: 'engraved' }, /caption/i],
        [{ ...ok, status: 'nearly' }, /status/i],
        [{ ...ok, width: 0 }, /width/i],
        [{ ...ok, fps: 0 }, /fps|rate/i],
        [{ ...ok, duration_ms: 0 }, /duration/i],
        [{ ...ok, aspect_ratio: '7:3' }, /aspect/i],
    ];
    for (const [row, pattern] of bad) {
        const out = validateDeliverable(row);
        assert.equal(out.valid, false, `${JSON.stringify(row).slice(0, 60)} was accepted`);
        assert.ok(out.errors.some(e => pattern.test(e)),
            `the error does not name the problem: ${JSON.stringify(out.errors)}`);
    }
});

test('the frame-rate rule here and in the exporter cannot disagree', () => {
    /*
     * `countingRate` exists in both this module and nle-export.js. That is
     * deliberate — importing the exporter would drag the whole XML generator
     * and its database-touching neighbours into a pure module the tests load
     * without a database — but two copies of one rule is precisely what this
     * codebase keeps paying for, so they are held equal rather than trusted.
     *
     * Over the rates a spot is actually delivered at, plus the NTSC family,
     * because the disagreement that matters is at 29.97 and it only shows at
     * exactly thirty seconds.
     */
    const nle = require('../lib/nle-export');
    for (const fps of [23.976, 24, 25, 29.97, 30, 48, 59.94, 60]) {
        for (const ms of [6000, 10000, 15000, 30000, 45000, 60000]) {
            assert.equal(frameCount(ms, fps), nle.msToFrames(ms, fps),
                `the two frame counts disagree at ${ms / 1000}s @ ${fps}`);
        }
    }
});

test('an override retimes the deliverable it names and no other', () => {
    /*
     * A campaign that runs :20 on social and :30 on air is the normal case. A
     * flat override would silently retime the broadcast master, whose length is
     * the one that is contractual.
     */
    const rows = planDeliverables('campaign', { reels_15: { duration_ms: 20000 } });
    const reels = rows.find(r => r.profile_id === 'reels_15');
    const air = rows.find(r => r.profile_id === 'bcast_na_15');
    assert.equal(reels.duration_ms, 20000, 'the override did not reach the deliverable it names');
    assert.equal(air.duration_ms, 15000, 'the override retimed the broadcast master as well');
});

test('the exporter emits one named sequence per deliverable', () => {
    /*
     * M2's acceptance. A commercial is fourteen to twenty-two files and an
     * editor should open ONE project containing a sequence per placement,
     * already the right size and rate — not one timeline they reshape six times
     * by hand, which is where the wrong frame rate gets baked in.
     *
     * Each sequence is named by the deliverable's key, because the key IS how
     * the editor identifies it, and Media Encoder queues by sequence name.
     */
    const { generatePremiereXML } = require('../lib/nle-export');
    const shots = [{ id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' }];
    const assets = [{ id: 'v1', shot_id: 's1', asset_type: 'video_raw',
                      file_path: '/m/1A.mp4', file_name: '1A.mp4', duration_ms: 4000 }];
    const rows = planDeliverables('campaign');

    const xml = generatePremiereXML({ title: 'Spot' }, shots, assets, {}, rows);
    const blocks = xml.split('<sequence>').slice(1);
    assert.equal(blocks.length, rows.length,
        `expected ${rows.length} sequences, got ${blocks.length}`);

    for (const d of rows) {
        const block = blocks.find(b => b.includes(`<name>${d.key}</name>`));
        assert.ok(block, `no sequence named ${d.key} — the editor cannot find this placement`);
        const head = block.slice(0, block.indexOf('<media>') + 2000);
        assert.ok(new RegExp(`<width>${d.width}</width>`).test(head),
            `${d.key} is not ${d.width} wide — a 9:16 placement in a 16:9 raster is the whole failure`);
        assert.ok(new RegExp(`<height>${d.height}</height>`).test(head), `${d.key} is not ${d.height} tall`);
        assert.ok(new RegExp(`<timebase>${Math.round(d.fps)}</timebase>`).test(head),
            `${d.key} is not at ${d.fps} — a rate conformed after generation cannot be fixed in the grade`);
    }
});

test('an export with no deliverables is byte-identical to what it always was', () => {
    /*
     * The safety rule this whole codebase runs on: a feature that changes what
     * an existing project produces the moment it ships is one nobody can adopt
     * deliberately. Every film in this tool has no deliverable rows.
     */
    const { generatePremiereXML } = require('../lib/nle-export');
    const shots = [{ id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' }];
    const assets = [{ id: 'v1', shot_id: 's1', asset_type: 'video_raw',
                      file_path: '/m/1A.mp4', file_name: '1A.mp4', duration_ms: 4000 }];
    const before = generatePremiereXML({ title: 'Film' }, shots, assets, {});
    for (const empty of [undefined, null, []]) {
        assert.equal(generatePremiereXML({ title: 'Film' }, shots, assets, {}, empty), before,
            'passing an empty deliverable set changed the export');
    }
});

test('a project says whether it is a film or a spot, and the choice is made at creation', () => {
    /*
     * Reported as "where and when do I select a commercial project vs a regular
     * film project, so it shows the appropriate items?" — and the honest answer
     * was that there was nowhere: the fields existed and only Settings and an
     * agent could set them.
     *
     * The type is DERIVED, not stored. A project is a spot when it carries the
     * facts that make it one — a client, a bought runtime, a brand, a
     * deliverable set — because those are what change behaviour. A `type`
     * column would be a second source of truth that could disagree with the
     * fields the engine actually reads.
     *
     * And the pages are NOT hidden for a film: a film becomes a spot the day a
     * client asks for one, and a menu that hides the way in makes that a
     * support question. What was missing was knowing which you are in.
     */
    const fs_ = require('fs');
    const page = fs_.readFileSync(require('path').join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

    // The choice, at creation, before anything else is typed.
    assert.ok(/id="newProjectType"/.test(page), 'the New Project modal offers no Film/Spot choice');
    const modal = page.slice(page.indexOf('id="newProjectModal"'), page.indexOf('id="newProjectModal"') + 6000);
    assert.ok(modal.indexOf('newProjectType') < modal.indexOf('data-field="title"'),
        'the type is asked for after the title — it sets the frame rate, the runtime and the '
        + 'deliverables, so it is the first question, not a detail');

    // A spot's own facts, and the deliverable set, in the same action.
    for (const control of ['newProjectClient', 'newProjectCampaign', 'newProjectBrand',
        'newProjectLength', 'newProjectPackage']) {
        assert.ok(new RegExp(`id="${control}"`).test(page), `the spot form has no ${control}`);
    }

    // Creating a spot must actually write those, not just collect them.
    const create = page.slice(page.indexOf('async function createProject()'));
    const body = create.slice(0, create.indexOf('\n    /**', 10));
    assert.ok(/target_duration_ms/.test(body), 'the chosen length never reaches the project');
    assert.ok(/deliverables\/plan/.test(body), 'the chosen package never becomes deliverables');
    assert.ok(/client:/.test(body) && /campaign:/.test(body), 'the client and campaign are not saved');

    /*
     * A failure applying the package must NOT undo the project. The project
     * exists and is usable; losing it because a preset could not be applied is
     * the worse outcome by a wide margin.
     */
    assert.ok(/Project created, but/.test(body),
        'a failure while setting up the spot is not reported as partial — it either silently '
        + 'succeeds or takes the project with it');

    // And the mode is visible afterwards, derived from the facts.
    assert.ok(/function paintProjectType/.test(page), 'nothing says which mode a project is in');
    assert.ok(/p\.client \|\| p\.campaign \|\| p\.brand_id \|\| Number\(p\.target_duration_ms\)/.test(page),
        'the type is not derived from the fields that actually change behaviour');
});
