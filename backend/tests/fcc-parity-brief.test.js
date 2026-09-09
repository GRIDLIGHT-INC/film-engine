/**
 * THE FINAL CUT CAMERA PARITY BRIEF, HELD TO THE CODE.
 *
 * A research brief is read as the reason an epic is shaped the way it is, long
 * after the facts it rests on have moved. This one rests on measurements —
 * a 100 MB ceiling, three seconds of ProRes, a camera with no manual control —
 * and every one of them is checkable. So each is a claim with a predicate
 * rather than a sentence, on the pattern ios-previz-brief.test.js already set.
 *
 * TWO CLAIM SHAPES, and the distinction is deliberate:
 *   `present`  — a fact that must STAY true; the brief is wrong if it changes.
 *   `gap`      — a fact the brief records as MISSING. When the epic closes it,
 *                the claim must be RESHAPED rather than deleted. Pinning a gap
 *                as permanent makes the epic's own success turn the suite red,
 *                which this codebase has already paid for six times.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BRIEF = path.join(ROOT, 'docs', 'plans', 'final-cut-camera-parity-brief.md');
const doc = () => fs.readFileSync(BRIEF, 'utf8');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Comments stripped — a brief that QUOTES a symbol must not count as using it. */
const code = (rel) => src(rel).split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const CLAIMS = [
    {
        id: 'binding-ceiling-is-what-the-brief-says',
        kind: 'present',
        why: 'the whole recommendation rests on this number; if the ceiling moves the '
            + 'ordering argument may no longer hold',
        holds() {
            /*
             * EVERY ceiling, not just the binding one. The first version checked
             * only `bindingBytes()`, and a mutation that raised FILE_LIMIT passed —
             * because the minimum is Marble's cap, not ours. The brief had
             * attributed the number to the upload transport, which would have sent
             * a reader to raise a limit that does not bind. Naming all three is
             * what makes the attribution checkable.
             */
            const p = require('../lib/capture-policy');
            const d = doc();
            const missing = Object.entries(p.CEILINGS)
                .map(([name, c]) => [name, Math.round(c.bytes / 1048576)])
                .filter(([, mb]) => !d.includes(`${mb} MB`))
                .map(([name, mb]) => `${name} (${mb} MB)`);
            return missing.length === 0
                || `the brief does not state these ceilings: ${missing.join(', ')}`;
        },
    },
    {
        id: 'hevc-modes-still-fit-as-quoted',
        kind: 'present',
        why: 'the brief quotes what fits TODAY as the contrast against ProRes; a changed '
            + 'mode table makes that contrast wrong',
        holds() {
            const p = require('../lib/capture-policy');
            const quoted = /1080p30 HEVC (\d+)s \/ 4k30 (\d+)s \/ 4k60 (\d+)s/.exec(doc());
            if (!quoted) return 'the brief no longer quotes what fits at each mode';
            const want = ['1080p30', '4k30', '4k60'].map(m => String(p.maxSecondsFor(m)));
            const got = quoted.slice(1, 4);
            return want.join(',') === got.join(',')
                || `the policy now says ${want.join('/')}s and the brief says ${got.join('/')}s`;
        },
    },
    {
        id: 'prores-arithmetic-is-reproducible',
        kind: 'present',
        why: 'the headline finding is 3 seconds; a reader must be able to recompute it '
            + 'rather than take it on trust',
        holds() {
            const p = require('../lib/capture-policy');
            // Apple's published iPhone figure: ProRes 422 HQ 1080p30 ~1.7 GB/min.
            const mbPerSecond = 1.7 * 1024 / 60;
            const secs = Math.floor((p.bindingBytes() / 1048576) / mbPerSecond);
            return doc().includes(`**${secs} seconds**`)
                || `ProRes 1080p30 now fits for ${secs}s and the brief does not say that`;
        },
    },
    {
        id: 'prores-is-delivery-only',
        kind: 'present',
        why: 'the brief claims the engine can export ProRes and cannot receive it — the '
            + 'asymmetry is an argument for the import route',
        holds() {
            const out = ['lib/project-presets.js', 'lib/qa-checker.js', 'lib/spot-package.js']
                .filter(f => /[Pp]ro[Rr]es/.test(code(`backend/${f}`)));
            if (out.length < 3) return `only ${out.length} of 3 delivery sites still mention ProRes`;
            const kinds = require('../lib/media-kinds');
            const video = (kinds.MEDIA_KINDS || kinds).video || {};
            return video.ext === 'mp4'
                || `an incoming shot video now accepts "${video.ext}", so the asymmetry has changed`;
        },
    },
    {
        id: 'exposure-lock-landed',
        kind: 'present',
        why: 'RESHAPED from the exposure sixth of `camera-has-no-manual-control` when PCC-002 '
            + 'landed (GRD-3653). The brief ranked exposure/WB lock as the highest-value camera '
            + 'feature for THIS product; the exposure half is built and must stay built',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            return cam.includes('setExposureModeCustom')
                || 'the exposure lock is gone; the brief\'s top recommendation is unbuilt again';
        },
    },
    {
        /*
         * THE LAST SPLIT OF THE ORIGINAL SIX, and the end of that claim.
         *
         * It began as "the six manual-control APIs the brief calls absent".
         * PCC-002 closed exposure, PCC-003 white balance, PCC-004 focus,
         * PCC-007 the data output, FCC-001 the asset writer, and FCC-005
         * (GRD-3801) the log colour space — so there is no absence left for it
         * to name. It was declared out of scope on "Phase B", which the
         * direction on GRD-3796 reversed; the tripwire fired exactly as it
         * asked somebody to make it. What replaces it pins the half that is
         * easiest to lose again.
         */
        id: 'log-colour-space-landed',
        kind: 'present',
        why: 'RESHAPED from the last of `camera-has-no-remaining-manual-control` when FCC-005 '
            + 'landed. The brief recommends a gradeable format; assigning .appleLog is only half '
            + 'of it, because the session configures the device for wide colour unless told not '
            + 'to and silently puts Rec.709 back — a take that looks normal and cannot be graded',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['activeColorSpace', 'automaticallyConfiguresCaptureDeviceForWideColor']
                .filter(x => !cam.includes(x));
            return missing.length === 0
                || `the log colour space has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'wb-lock-landed',
        kind: 'present',
        why: 'RESHAPED from the white-balance sixth of the original manual-control claim when '
            + 'PCC-003 landed. The brief ranked exposure/WB lock as the highest-value camera '
            + 'feature for this product; both halves are now built',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            return cam.includes('setWhiteBalanceModeLocked')
                || 'the white balance lock is gone; the brief\'s top recommendation is half unbuilt again';
        },
    },
    {
        id: 'focus-lock-landed',
        kind: 'present',
        why: 'RESHAPED from the focus sixth of the original manual-control claim when PCC-004 '
            + 'landed. The brief called manual focus with peaking a cheap high-value item; the '
            + 'focus half is built and peaking is PCC-008',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            return cam.includes('setFocusModeLocked')
                || 'the focus lock is gone; a brief recommendation is unbuilt again';
        },
    },
    {
        id: 'recording-landed',
        kind: 'present',
        why: 'RESHAPED from `camera-is-photo-only` when FCC-001 (GRD-3797) landed. That claim was '
            + 'declared out of scope on Phase B, and the direction on GRD-3796 reversed the '
            + 'exclusion — so the tripwire it left behind did its job. What replaces it pins the '
            + 'thing the brief actually cares about: the camera can shoot footage AND stills, '
            + 'rather than having traded one for the other',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            if (!/AVCapturePhotoOutput/.test(cam)) return 'the camera can no longer shoot a plate';
            /*
             * `.photo` is still the RESTING preset — a plate needs the full
             * sensor. Recording swaps to the mode's video preset for the take
             * and swaps back, so a permanent video preset here would mean every
             * plate had been quietly downgraded to record footage.
             */
            if (!/sessionPreset = \.photo/.test(cam)) {
                return 'the session no longer rests at the photo preset — plates lost the full sensor';
            }
            const missing = ['AVAssetWriter', 'RecordingMode'].filter(l => !cam.includes(l));
            return missing.length === 0
                || `footage capture has been removed again: ${missing.join(', ')}`;
        },
    },
    {
        id: 'lens-selection-landed',
        kind: 'present',
        why: 'RESHAPED from the lens half of `camera-is-photo-only-and-one-lens` when PCC-001 '
            + 'landed. The brief recommended it as the cheapest item on the list; it is built, '
            + 'and this records that rather than deleting the claim',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['builtInUltraWideCamera', 'builtInTelephotoCamera', 'DiscoverySession']
                .filter(l => !cam.includes(l));
            return missing.length === 0 || `lens selection has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'brief-states-the-line-count-it-measured',
        kind: 'present',
        why: 'a size quoted in prose is the first thing to rot, and it is load-bearing here '
            + '("a starting point, not a base")',
        holds() {
            const lines = src('ios/FilmEngine/PlateCamera.swift').split('\n').length - 1;
            return doc().includes(`${lines} lines`)
                || `PlateCamera.swift is ${lines} lines and the brief says otherwise`;
        },
    },
];

/* ── the brief's own shape ──────────────────────────────────────────────── */

const REQUIRED_SECTIONS = ['Executive Summary', 'Key Themes', 'Top Ideas & Opportunities',
                           'Technical Approaches', 'Open Questions', 'Recommended Direction'];

test('the brief exists where the plans live', () => {
    assert.ok(fs.existsSync(BRIEF), `no brief at ${path.relative(ROOT, BRIEF)}`);
});

test('it carries every section the brief format asks for', () => {
    const have = new Set([...doc().matchAll(/^###?\s+(.+)$/gm)].map(m => m[1].trim()));
    const missing = REQUIRED_SECTIONS.filter(s => !have.has(s));
    assert.deepStrictEqual(missing, [], `the brief omits: ${missing.join(', ')}`);
});

test('EVERY claim it rests on is still true of the code', () => {
    const broken = CLAIMS.map(c => [c.id, c.holds()]).filter(([, r]) => r !== true)
        .map(([id, r]) => `${id}: ${r}`);
    assert.deepStrictEqual(broken, [],
        'the brief has drifted from the code:\n  ' + broken.join('\n  '));
});

test('every claim says why it is worth pinning, and every gap says what closes it', () => {
    for (const c of CLAIMS) {
        assert.ok(c.why && c.why.length > 40, `${c.id}: states no real reason`);
        assert.ok(['present', 'gap'].includes(c.kind), `${c.id}: unknown claim kind`);
        if (c.kind === 'gap') {
            /*
             * `outOfScope` added by PCC-011 (GRD-3662), matching the escape
             * plate-camera-epic.test.js already has. A gap whose work was
             * STRUCK from scope can never name a task that closes it, and
             * without a declared exception the two guards in this file
             * contradict each other — one demanding a closer, the other
             * accepting a declaration.
             */
            if (c.outOfScope) {
                assert.ok(c.outOfScope.length > 30,
                    `${c.id} claims to be out of scope and gives no real reason`);
                continue;
            }
            assert.ok(c.closes && c.closes.length > 10,
                `${c.id} is a gap and does not name what closes it — a gap pinned as permanent `
                + 'makes the epic fail for succeeding');
        }
    }
    assert.ok(CLAIMS.length >= 6, `only ${CLAIMS.length} claims pinned; the brief rests on more`);
});

test('it recommends an ORDER, and the reason is the measurement', () => {
    /*
     * The one thing a brief must not be: a list of options with no position. The
     * recommendation here is a sequence, and it is argued from the ceiling
     * rather than from taste.
     */
    const rec = doc().slice(doc().indexOf('## Recommended Direction'));
    assert.ok(rec.length > 400, 'the recommendation is too short to be an argument');
    assert.match(rec, /Phase A[\s\S]*Phase B/, 'it does not recommend an order');
    assert.match(rec, /100 MB|three seconds|transport/i,
        'the ordering is not argued from the measurement, so it reads as preference');
});

test('the device tier is named, because four features are unreachable here', () => {
    const d = doc();
    for (const feature of ['ProRes RAW', 'Log 2', 'open gate', 'genlock']) {
        assert.ok(d.includes(feature), `the brief never mentions ${feature}`);
    }
    assert.match(d, /17 Pro/, 'the brief does not say which hardware those need');
    assert.match(d, /15 Pro Max/, 'the brief does not say what device this project actually has');
});

/* ── PCC-011: the brief must describe the camera that EXISTS ────────────── */

/**
 * THE BRIEF'S PROSE IS A CLAIM ABOUT THE CODE, AND IT WENT STALE.
 *
 * The research brief enumerated six AVFoundation APIs the camera did not use
 * and concluded "it is a starting point, not a base to extend". Four of those
 * six are now built. Nothing caught that: the CLAIMS registry pinned the line
 * count and the individual features, and the sentence that reads as the brief's
 * summary judgement was pinned by nothing at all.
 *
 * That is the same defect the epic guards from the other side. A gap pinned as
 * permanent makes an epic fail for SUCCEEDING; prose claiming absence after the
 * work landed makes a brief lie about succeeding — and the second is worse,
 * because nothing fails and a later reader plans against it.
 *
 * So the brief now carries a STATUS TABLE, one row per API, and this reads it
 * against the source. The denominator is the table itself, so a seventh API
 * added to the brief is checked with nothing to remember.
 */

const API_STATUS_RE = /^\|\s*`([A-Za-z]+)`\s*\|\s*(built|absent)\b([^|]*)\|/gm;

test('EVERY API the brief tabulates has the status the code actually has', () => {
    const brief = doc();
    const cam = code('ios/FilmEngine/PlateCamera.swift');
    const rows = [...brief.matchAll(API_STATUS_RE)]
        .map(m => ({ api: m[1], status: m[2], note: m[3].trim() }));

    assert.ok(rows.length >= 6,
        `only ${rows.length} API rows parsed from the brief; it enumerated six and the scan is `
        + 'broken — one that finds too few reports the brief as accurate by reading almost none of it');

    const wrong = rows.map(r => {
        /*
         * WORD-BOUNDARY, not includes(). `setWhiteBalanceModeLockedX` contains
         * `setWhiteBalanceModeLocked`, so a renamed-away API still satisfied a
         * substring test — the mention-for-use family in its narrowest form.
         */
        const present = new RegExp(`\\b${r.api}\\b`).test(cam);
        if (r.status === 'built' && !present) return `${r.api}: the brief says BUILT and it is absent`;
        if (r.status === 'absent' && present) {
            return `${r.api}: the brief says ABSENT and the camera uses it — reshape the row, `
                + 'because prose claiming absence after the work landed is a brief lying about '
                + 'its own epic succeeding';
        }
        return null;
    }).filter(Boolean);
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY built API names the task that built it', () => {
    /*
     * "Built" with no attribution is a claim nobody can chase. The task id is
     * what lets a later reader find the reasoning rather than re-deriving it.
     */
    const rows = [...doc().matchAll(API_STATUS_RE)]
        .map(m => ({ api: m[1], status: m[2], note: m[3].trim() }));
    // FCC accepted alongside PCC by FCC-001 (GRD-3797): this brief's own epic
    // now builds APIs in the same file, and a rule that only recognised the
    // PREVIOUS epic's ids would report a properly attributed row as bare.
    const bare = rows.filter(r => r.status === 'built' && !/(?:PCC|FCC)-\d{3}/.test(r.note))
        .map(r => r.api);
    assert.deepStrictEqual(bare, [], `built and unattributed: ${bare.join(', ')}`);
});

test('the brief no longer calls the camera a starting point', () => {
    /*
     * The sentence that carried the brief's judgement. It was true when
     * written and is the single most misleading line in the document now —
     * a reader scanning for a summary finds it and plans four tasks that exist.
     */
    const brief = doc();
    assert.ok(!/starting point, not a base to extend/.test(brief),
        'the brief still calls the camera "a starting point, not a base to extend" — four of the '
        + 'six APIs it names as absent are built');
    assert.ok(!/Zero occurrences of/.test(brief),
        'the brief still claims zero occurrences of the manual-control APIs');
});

test('EVERY gap in this file names what closes it, or is declared out of scope', () => {
    /*
     * The discipline plate-camera-epic.test.js has and this file did not.
     * Both remaining gaps here close on "Phase B", which is STRUCK from the
     * epic by the user's direction — so no task will ever close them, and
     * without a declared exception they are gaps pinned as permanent: the exact
     * thing PCC-011 exists to prevent, one level up.
     */
    /*
     * RE-DERIVED by FCC-005 (GRD-3801), which is what the guard here asked for.
     *
     * It used to refuse an empty set — correctly, because a rule policing
     * nothing reads as coverage. There is now nothing to police: every API this
     * brief recorded as absent has been built, the last of them being the log
     * colour space, so `gaps` is legitimately empty rather than broken.
     *
     * The rule is KEPT rather than deleted, because the shape it enforces
     * outlives the current set: a gap added to this file later must still name
     * a task that closes it or declare itself out of scope, or it is a gap
     * pinned as permanent — the thing that makes a document fail for its own
     * epic succeeding. An empty set is asserted explicitly so that "no gaps"
     * cannot quietly become "the scan is broken".
     */
    const gaps = CLAIMS.filter(c => c.kind === 'gap');
    const present = CLAIMS.filter(c => c.kind === 'present');
    assert.ok(present.length >= 6,
        `only ${present.length} present claims; the registry read is broken, and a file with no `
        + 'claims of either kind polices nothing');
    for (const g of gaps) {
        if (g.outOfScope) {
            assert.ok(g.outOfScope.length > 30,
                `${g.id} claims to be out of scope and gives no real reason`);
            continue;
        }
        assert.match(g.closes || '', /PCC-\d{3}/,
            `${g.id} is a gap, names no task that closes it, and is not declared out of scope — `
            + 'a gap nothing will ever close makes this file fail for succeeding');
    }
});
