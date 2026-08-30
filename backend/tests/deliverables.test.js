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

test('a package decides the project\'s technical settings, derived from its own profiles', () => {
    /*
     * "When we select commercial does it automatically set all the formats we
     * need? This needs to be done automatically."
     *
     * It set the client, the campaign, the brand, the runtime and the
     * deliverables — and left aspect_ratio, target_resolution and target_fps at
     * whatever a FILM defaults to. Those three decide the shape and rate every
     * frame is generated at, and getting the rate wrong is the one mistake that
     * cannot be fixed in the grade.
     *
     * DERIVED from the package's own profiles rather than written down twice: a
     * package that gains a UK broadcast profile must move the project to 25fps
     * with nothing to remember.
     */
    const { settingsForPackage } = require('../lib/deliverables');

    for (const name of Object.keys(PACKAGES)) {
        const out = settingsForPackage(name);
        assert.ok(out, `${name} produced no settings`);
        assert.ok(out.target_fps > 0, `${name} sets no frame rate`);
        assert.ok(/^\d+x\d+$/.test(out.target_resolution), `${name} sets no resolution`);
        assert.ok(out.aspect_ratio, `${name} sets no aspect ratio`);
        assert.ok(out.why, `${name} does not say why it chose those`);

        // The settings must MATCH one of the package's own profiles — not be
        // an average of them, which is a shape nobody delivers.
        const rows = planDeliverables(name);
        const matched = rows.some(r =>
            r.fps === out.target_fps
            && `${r.width}x${r.height}` === out.target_resolution
            && r.aspect_ratio === out.aspect_ratio);
        assert.ok(matched,
            `${name}: the project would be set to ${out.target_resolution} @ ${out.target_fps} `
            + `${out.aspect_ratio}, which is not any deliverable in the package`);
    }

    /*
     * Broadcast is CONTRACTUAL, so where a package contains an air profile its
     * rate wins. A spot generated at 30fps for a 29.97 buy cannot be conformed
     * afterwards — the one mistake this whole area exists to prevent.
     */
    const air = settingsForPackage('broadcast');
    assert.equal(air.target_fps, 29.97,
        `a package containing NA broadcast must set 29.97, got ${air.target_fps}`);
    assert.ok(/broadcast/i.test(air.why), `the reason does not mention the air profile: ${air.why}`);

    // Social-only: no air profile, so the social rate stands.
    const rapid = settingsForPackage('rapid');
    assert.ok(rapid.target_fps === 29.97 || rapid.target_fps === 30,
        `rapid set an unexpected rate: ${rapid.target_fps}`);

    // An unknown package refuses rather than inventing a format.
    assert.throws(() => settingsForPackage('platinum'), /package/i);

    /*
     * THE AIR RATE WINS, proven over an explicit set.
     *
     * Every package that ships today has a master at the same rate as its
     * broadcast profile, so this rule is invisible against all three — and a
     * rule nothing can distinguish is one nobody can trust. It decides whether
     * a spot is generated at a rate it can be AIRED at, which cannot be
     * conformed afterwards.
     */
    const { settingsFromProfiles } = require('../lib/deliverables');
    const mixed = settingsFromProfiles([
        // The master is longer and social-rated…
        { id: 'yt_60', label: 'YouTube :60', aspect: '16:9', width: 1920, height: 1080,
          fps: 30, duration_ms: 60000, platform: 'youtube' },
        // …and a UK air cut-down is in the same package.
        { id: 'uk_15', label: 'UK broadcast :15', aspect: '16:9', width: 1920, height: 1080,
          fps: 25, duration_ms: 15000, platform: 'broadcast' },
    ]);
    assert.equal(mixed.target_fps, 25,
        'a package whose master is 30fps and which carries a 25fps AIR profile must generate at 25 — '
        + 'an air rate is contractual and cannot be conformed afterwards');
    assert.equal(mixed.target_resolution, '1920x1080', 'the master still sets the frame');
});

/**
 * An NTSC rate is an AIR requirement, not a house style
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 29.97 exists for one reason: NTSC colour needed the 1000/1001 pulldown, and
 * North American linear broadcast delivery specs still carry it. That is
 * contractual — a :30 delivered at 30fps to a station cut for 29.97 is a spot
 * that gets rejected — so `bcast_na_*` keeps it and must.
 *
 * Nothing else inherits it. YouTube accepts 24/25/30/48/50/60 and asks for none
 * of them specifically; a CTV programmatic file is a file, and where a buy
 * genuinely demands 29.97 that is a per-buy override rather than the default
 * every digital deliverable is built at.
 *
 * The table said otherwise, and contradicted itself doing it: meta, reels and
 * square were declared at a clean 30 while youtube and ctv carried 29.97. The
 * consequence was not cosmetic. `rapid` is YouTube + Reels + Square, contains
 * NO broadcast profile at all, and resolved to:
 *
 *     -> fps: 29.97   preset: spot_broadcast_na
 *     why: "No broadcast profile in this package, so the master (YouTube :30)
 *           sets both the rate (29.97fps)..."
 *
 * — an all-digital campaign generated at a pulldown rate, and labelled a North
 * American broadcast delivery, for no reason any destination asked for.
 *
 * Set-based over the profile table by PLATFORM, because the failure is
 * partial by nature: four social profiles were already right, and any test
 * written against those passes in exactly the state this catches.
 */

test('only a broadcast profile may carry an NTSC rate', () => {
    const ntsc = fps => Math.abs(Number(fps) - Math.round(Number(fps))) > 1e-9;

    const offenders = DELIVERY_PROFILES
        .filter(p => p.platform !== 'broadcast' && ntsc(p.fps))
        .map(p => `${p.id} (${p.platform}) at ${p.fps}`);

    assert.deepStrictEqual(offenders, [],
        'these profiles carry a 1000/1001 NTSC rate that their destination does not require, so '
        + 'every spot built for them is generated with a pulldown inherited from analogue '
        + `television: ${offenders.join('; ')}`);
});

test('a broadcast profile keeps the rate its region actually airs at', () => {
    /*
     * The other half of the same rule, and the reason this is not simply
     * "integers everywhere": NA air IS 29.97 and UK air IS 25. Removing the
     * fractional rate to tidy the table would produce a file a station rejects.
     */
    const air = DELIVERY_PROFILES.filter(p => p.platform === 'broadcast');
    assert.ok(air.length >= 2, 'expected both NA and UK broadcast profiles in the table');

    for (const p of air) {
        const expected = /uk|au/i.test(p.id) ? 25 : 29.97;
        assert.strictEqual(p.fps, expected,
            `${p.id} airs at ${expected}fps; declared ${p.fps}`);
    }
});

test('an all-digital package is not built at a broadcast rate, or labelled as one', () => {
    const { settingsForPackage, PACKAGES } = require('../lib/deliverables');
    /*
     * The behavioural half. The profile table being right means nothing if the
     * package that reads it still resolves to 29.97 — and this assertion used
     * to accept `29.97 || 30`, which is why the defect survived: a rule loose
     * enough to admit the bug is not a rule.
     */
    const rapid = settingsForPackage('rapid');
    // PACKAGES maps an id straight to its list of profile ids.
    const profiles = PACKAGES.rapid.map(id => DELIVERY_PROFILES.find(p => p.id === id));
    assert.ok(!profiles.some(p => p.platform === 'broadcast'),
        "this test's reading is stale: the rapid package now contains a broadcast profile");

    assert.ok(Number.isInteger(rapid.target_fps),
        `an all-digital package resolved to ${rapid.target_fps}fps — nothing it delivers to `
        + 'requires a pulldown rate');
    assert.ok(!/broadcast/.test(String(rapid.delivery_preset)),
        `an all-digital package was labelled "${rapid.delivery_preset}" — it never airs, so a `
        + 'broadcast delivery preset misstates both its loudness target and its rate');
});

test('a package that DOES contain air still follows the air rate', () => {
    const { settingsForPackage } = require('../lib/deliverables');
    // Unchanged, and it must be: an air rate is contractual and outranks the
    // convention every digital profile in the same package follows.
    for (const [id, expected] of [['campaign', 29.97], ['broadcast', 29.97]]) {
        assert.strictEqual(settingsForPackage(id).target_fps, expected,
            `${id} contains a NA broadcast profile and must resolve to ${expected}`);
    }
});

/**
 * A package PROPOSES a rate; the director chooses one
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Applying a package ran an unconditional
 *
 *     UPDATE film_projects SET aspect_ratio = ?, target_resolution = ?, target_fps = ?
 *
 * so a director who had deliberately set 24fps had it silently replaced by
 * whatever the package's air profile said. That is a real constraint on real
 * work, and it rests on a conflation: `target_fps` is read by conform.js and
 * the three NLE exporters and BY NOTHING ELSE. No generator takes it — Seedance
 * has no fps field at all — so the rate is how the film is LAID OUT, not what
 * it is generated at. Choosing 24 was never unsafe; it was just overwritten.
 *
 * And 24 for television is not a workaround, it is how cinema has always
 * reached a broadcast schedule: a 24fps master is pulled down 2:3 for a 29.97
 * air, or run 4% fast for a 25fps one. The air rate is a fact about the
 * DELIVERABLE, not about the timeline that produced it.
 *
 * So the rule is: a package fills a rate that has not been chosen, and never
 * replaces one that has. Where a chosen rate differs from an air profile in the
 * package, that is REPORTED with the conversion named — never blocked. Blocking
 * would make the engine refuse the single commonest look in advertising, and a
 * warning nobody can act on is one they learn to dismiss.
 *
 * Set-based over the three packages crossed with "has the director already
 * decided", because the failure is asymmetric: filling an empty rate is
 * correct and replacing a chosen one is the bug, and a test that only checks
 * the empty case passes in exactly the state this catches.
 */

test('a package fills an unset rate but never replaces a chosen one', () => {
    const { settingsForPackage, PACKAGES } = require('../lib/deliverables');

    for (const id of Object.keys(PACKAGES)) {
        // No opinion yet: the package's derived rate is what you get.
        const fresh = settingsForPackage(id, { target_fps: null });
        assert.ok(Number(fresh.target_fps) > 0,
            `${id}: a project with no rate must be given the package's own`);

        // Already decided: 24fps, deliberately, for the film look.
        const chosen = settingsForPackage(id, { target_fps: 24 });
        assert.strictEqual(chosen.target_fps, 24,
            `${id}: applying a package overwrote a deliberately chosen 24fps with `
            + `${chosen.target_fps} — the director's rate is not the package's to replace`);
    }
});

test('a chosen rate that differs from an air profile is reported, not refused', () => {
    const { settingsForPackage } = require('../lib/deliverables');

    // `broadcast` contains NA air at 29.97; the director wants the film look.
    const s = settingsForPackage('broadcast', { target_fps: 24 });
    assert.strictEqual(s.target_fps, 24, 'the chosen rate did not survive');
    assert.ok(s.rate_note,
        'a 24fps timeline against a 29.97 air profile produced no note at all — the director is '
        + 'not told a conversion is needed at delivery');
    assert.match(String(s.rate_note), /29\.97/,
        `the note is "${s.rate_note}" — it must name the air rate the deliverable needs`);
    assert.match(String(s.rate_note), /pulldown|2:3|convert/i,
        `the note is "${s.rate_note}" — it must name the conversion, or it is an observation `
        + 'the director cannot act on');

    // And it is a NOTE, not a refusal.
    assert.ok(!s.error && !s.refused,
        'a 24fps master for a broadcast buy was refused — that is how cinema has always reached '
        + 'a broadcast schedule, and refusing it makes the engine unusable for the commonest '
        + 'look in advertising');
});

test('a chosen rate matching the package says nothing', () => {
    /*
     * A warning that fires when there is nothing to do is one people learn to
     * dismiss, taking the real one with it — the rule screenplay drift and the
     * style subject check both already follow.
     */
    const { settingsForPackage } = require('../lib/deliverables');
    const s = settingsForPackage('broadcast', { target_fps: 29.97 });
    assert.ok(!s.rate_note,
        `a rate identical to the air profile produced the note "${s.rate_note}"`);
});

test('24fps is offered as a rate a person can actually pick', () => {
    const { FRAME_RATES } = require('../lib/project-presets');
    const ids = FRAME_RATES.map(r => String(r.fps));
    for (const wanted of ['24', '23.976', '25', '29.97', '30']) {
        assert.ok(ids.includes(wanted),
            `${wanted}fps is not selectable — a rate the engine cannot be told is not a preference`);
    }
});

/**
 * ...and the ROUTE has to pass the choice in.
 *
 * Caught by mutation: replacing `settingsForPackage(body.package, current)`
 * with `settingsForPackage(body.package)` failed nothing at all. The library
 * honoured a chosen rate and the one call site that applies a package never
 * told it what had been chosen — the exact shape where a fix exists and the
 * caller ignores it, which this codebase has paid for repeatedly.
 *
 * So this drives the real route against a real database, because that is the
 * only thing that can see the argument actually being passed.
 */
test('applying a package over HTTP keeps the rate the project already chose', async () => {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const os2 = require('os');
    const path2 = require('path');

    const dir = path2.join(os2.tmpdir(), 'fe-fps-' + require('crypto').randomUUID().slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const port = 3400 + Math.floor(Math.random() * 300);

    const proc = spawn(process.execPath, [path2.join(__dirname, '..', 'server.js')],
        { env: { ...process.env, PORT: String(port), FILM_DATA_DIR: dir }, stdio: 'pipe' });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});

    const base = `http://localhost:${port}`;
    const call = (m, p, b) => fetch(base + p, {
        method: m, headers: { 'Content-Type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

    try {
        for (let i = 0; i < 100; i++) {
            try { const h = await fetch(base + '/api/health'); if (h.ok) break; } catch (_) {}
            await new Promise(r => setTimeout(r, 100));
        }

        const made = await call('POST', '/film/projects', { title: 'FPS probe', target_fps: 24 });
        const pid = (made.body && (made.body.project || made.body).id);
        assert.ok(pid, `could not create a project: ${JSON.stringify(made).slice(0, 200)}`);

        // Deliberately the package whose air profile is 29.97.
        const applied = await call('POST', `/film/projects/${pid}/deliverables/plan`, { package: 'broadcast' });
        assert.ok(applied.status < 400, `apply failed: ${JSON.stringify(applied).slice(0, 200)}`);

        const after = await call('GET', `/film/projects/${pid}`);
        const fps = Number((after.body.project || after.body).target_fps);
        assert.strictEqual(fps, 24,
            `applying a broadcast package overwrote a deliberately chosen 24fps with ${fps} — `
            + 'the route is not passing the project into settingsForPackage');
    } finally {
        proc.kill('SIGKILL');
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
});
