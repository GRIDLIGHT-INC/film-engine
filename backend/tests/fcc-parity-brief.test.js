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
        id: 'camera-has-no-remaining-manual-control',
        kind: 'gap',
        /*
         * DECLARED out of scope by PCC-011 (GRD-3662). It closed on "Phase B",
         * which names no task and never will: footage capture is struck from
         * this epic by the user's direction. Left as a bare `closes` it was a
         * gap pinned as permanent — the exact thing this epic's fidelity tests
         * exist to prevent, one level up. It is kept as a TRIPWIRE: if a log
         * colour space or an asset writer appears, the scope changed and
         * somebody should say so deliberately.
         */
        outOfScope: 'Phase B — footage capture and Log, struck from this epic by the user\'s '
            + 'direction; no PCC task will ever close it',
        why: 'the five manual-control APIs the brief calls absent that are STILL absent. Split '
            + 'from the original six when PCC-002 closed the exposure one, so this claim keeps '
            + 'saying something true instead of failing for succeeding',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            // setWhiteBalanceModeLocked removed from this list by PCC-003 (GRD-3654):
            // it is built, and is pinned by `wb-lock-landed` below.
            // setFocusModeLocked removed by PCC-004 (GRD-3655): built, and pinned
            // by `focus-lock-landed` below. Only the footage pair remains.
            // AVCaptureVideoDataOutput removed by PCC-007 (GRD-3658): frames are
            // read for MONITORING and written nowhere. Footage capture means
            // AVAssetWriter or a log colour space, both still absent.
            const landed = ['activeColorSpace', 'AVAssetWriter'].filter(x => cam.includes(x));
            return landed.length === 0
                || `the camera now uses ${landed.join(', ')} — reshape this claim to pin what was built`;
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
        id: 'camera-is-photo-only',
        kind: 'gap',
        // Same declaration, same reason: see camera-has-no-remaining-manual-control.
        outOfScope: 'Phase B — footage capture, gated on the transport decision and struck from '
            + 'this epic; a plate is a photograph, not a frame grab',
        why: 'the brief\'s footage recommendations rest on there being no AVAssetWriter path; the '
            + 'LENS half of this claim was split off and closed by PCC-001 (GRD-3652), which is '
            + 'why this now names only the half that is still true',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            if (!/AVCapturePhotoOutput/.test(cam)) return 'the camera is no longer photo-based';
            if (!/sessionPreset = \.photo/.test(cam)) return 'the session preset has changed';
            // See PCC-007: a data output for monitoring is not footage capture.
            const landed = ['AVAssetWriter'].filter(l => cam.includes(l));
            return landed.length === 0
                || `footage capture has landed (${landed.join(', ')}) — reshape this claim`;
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
    const bare = rows.filter(r => r.status === 'built' && !/PCC-\d{3}/.test(r.note))
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
    const gaps = CLAIMS.filter(c => c.kind === 'gap');
    assert.ok(gaps.length >= 1, 'no gaps left to police; re-derive this check');
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
