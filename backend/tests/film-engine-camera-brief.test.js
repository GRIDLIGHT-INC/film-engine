/**
 * THE CAMERA BRIEF, HELD TO THE CODE IT DESCRIBES.
 *
 * The brief this replaces went stale unnoticed: it claimed six AVFoundation
 * APIs were absent long after four were built, because its summary JUDGEMENT
 * was pinned by nothing while its line count was pinned carefully. A research
 * brief is a claim about the code, and an unpinned claim is one a later reader
 * plans against.
 *
 * Claims are TYPED. `present` must stay true. `gap` names what closes it, so
 * the claim is RESHAPED when the work lands rather than deleted — a gap pinned
 * as permanent makes a document fail for succeeding. `outOfScope` is the narrow
 * escape for a gap nothing will ever close, and it must give a reason.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BRIEF = path.join(ROOT, 'docs', 'plans', 'film-engine-camera-brief.md');
const doc = () => fs.readFileSync(BRIEF, 'utf8');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments stripped — a mention is not a use. */
const code = (rel) => src(rel).split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const REQUIRED = ['Executive Summary', 'Key Themes', 'Top Ideas & Opportunities',
                  'Technical Approaches', 'Open Questions', 'Recommended Direction'];

test('the brief exists and carries every section the format asks for', () => {
    assert.ok(fs.existsSync(BRIEF), `no brief at ${path.relative(ROOT, BRIEF)}`);
    const have = new Set([...doc().matchAll(/^#+\s+(.+)$/gm)].map(m => m[1].trim()));
    const missing = REQUIRED.filter(s => !have.has(s));
    assert.deepStrictEqual(missing, [], `the brief omits: ${missing.join(', ')}`);
});

/* ── claims about the code ──────────────────────────────────────────────── */

const CLAIMS = [
    {
        id: 'eighteen-import-targets',
        kind: 'present',
        why: 'the brief\'s scope argument rests on there being a countable set of places media '
            + 'can be added; if the registry grows, the "which targets" question changes shape',
        holds() {
            const { MEDIA_IMPORTS } = require('../lib/media-imports');
            const n = Object.keys(MEDIA_IMPORTS).length;
            return doc().includes(`${n} import targets`)
                || `MEDIA_IMPORTS has ${n} targets and the brief says otherwise`;
        },
    },
    {
        id: 'world-capture-is-the-only-video-accepting-picture-target',
        kind: 'present',
        why: 'the whole previz recommendation rests on this one target already accepting video; '
            + 'if another did, the argument would be about two paths rather than one',
        holds() {
            const { MEDIA_IMPORTS } = require('../lib/media-imports');
            const multi = Object.entries(MEDIA_IMPORTS)
                .filter(([, v]) => (v.kinds || []).includes('video') && v.kind === 'image')
                .map(([k]) => k);
            return (multi.length === 1 && multi[0] === 'world-capture')
                || `image-kind targets accepting video are now [${multi}], not just world-capture`;
        },
    },
    {
        id: 'capture-policy-already-computes-the-ceiling',
        kind: 'present',
        why: 'idea 3 says the budget is already answered rather than needing to be built; if '
            + 'maxSecondsFor went away the recommendation would be proposing new work as existing',
        holds() {
            const p = require('../lib/capture-policy');
            if (typeof p.maxSecondsFor !== 'function') return 'capture-policy no longer answers maxSecondsFor';
            /*
             * EVERY mention, not an alternation. The first version accepted
             * "${mb} MB ceiling" OR "${mb} MB pipe" and survived changing one of
             * them — the brief says 100 MB in three places, so one wrong number
             * hid behind two right ones. Same weakness that has now cost three
             * times in this session.
             */
            const mb = Math.floor(p.bindingBytes() / 1048576);
            // \s+ across the match, because markdown wraps: one mention is
            // "a real 100 MB\n  ceiling" and a space-only pattern missed it,
            // leaving a third of the numbers unpoliced.
            const mentions = [...doc().matchAll(/(\d+)\s*MB\s+(?:ceiling|pipe)/g)].map(m => Number(m[1]));
            if (mentions.length < 3) return `only ${mentions.length} ceiling mentions found; the scan is broken`;
            const wrong = mentions.filter(v => v !== mb);
            return wrong.length === 0
                || `the binding ceiling is ${mb}MB and the brief states ${wrong.join(', ')}`;
        },
    },
    {
        id: 'system-camera-is-still-what-shootControl-renders',
        kind: 'gap',
        closes: 'the task that replaces shootControl with the controlled camera',
        why: 'THE defect the brief is about. When it is fixed this must be RESHAPED to pin what '
            + 'was built — a gap pinned as permanent makes the brief fail for succeeding',
        holds() {
            const page = code('src/index.html');
            const at = page.indexOf('function shootControl');
            if (at === -1) return 'shootControl is gone — reshape this claim to pin what replaced it';
            const body = page.slice(at, page.indexOf('\n    }', at));
            return /capture="\$\{capture\}"|capture=/.test(body)
                || 'shootControl no longer renders a capture attribute — the system camera is out, '
                 + 'reshape this claim';
        },
    },
    {
        id: 'recording-spine-landed',
        kind: 'present',
        why: 'RESHAPED from the AVAssetWriter half of `no-video-recording-apis-yet` when FCC-001 '
            + '(GRD-3797) landed. The brief said the spine must change from photo capture to '
            + 'video capture; it has, and this records that rather than deleting the claim — so '
            + 'anything that removed the writer again would be noticed',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['AVAssetWriter', 'RecordingSink', 'startSession(atSourceTime:']
                .filter(s => !cam.includes(s));
            return missing.length === 0
                || `the recording spine has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'no-log-colour-space-yet',
        kind: 'gap',
        closes: 'FCC-005 (GRD-3801), which sets activeColorSpace to .appleLog',
        why: 'SPLIT from `no-video-recording-apis-yet` when FCC-001 landed. That claim covered '
            + 'two absences and only one closed, so it is split rather than deleted — the brief '
            + 'recommends a gradeable log format and that half is still genuinely unbuilt',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            return !cam.includes('activeColorSpace')
                || 'a log colour space has landed — reshape this claim to pin what was built';
        },
    },
    {
        id: 'the-arithmetic-that-carries-over-still-exists',
        kind: 'present',
        why: 'the recommendation explicitly rests on not rewriting these; if any were removed the '
            + 'brief would be promising a carry-over that is not there',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['FrameAnalysis', 'FocusPeaking', 'ExposureWarning', 'PlateGuides',
                             'ExposureLock', 'WhiteBalanceLock', 'FocusLock']
                .filter(t => !new RegExp(`\\b(enum|struct) ${t}\\b`).test(cam));
            return missing.length === 0
                || `the brief promises these carry over and they are gone: ${missing.join(', ')}`;
        },
    },
    {
        id: 'both-outputs-are-active',
        kind: 'present',
        why: 'RESHAPED when FCC-001 (GRD-3797) landed, which is the task this gap named as its '
            + 'closer. The brief said stills need not be lost because both outputs may be active '
            + 'since iOS 16 — the recording is now built and the photo output is still there, so '
            + 'the prediction held and this pins it instead of still asking for it',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['AVCapturePhotoOutput', 'AVCaptureVideoDataOutput', 'AVAssetWriter']
                .filter(s => !cam.includes(s));
            if (missing.length) {
                return `one output was traded for another: ${missing.join(', ')} is gone`;
            }
            return /func shoot\(/.test(cam)
                || 'the photo output survives but nothing can shoot a plate with it any more';
        },
    },
];

test('EVERY claim the brief rests on is still true of the code', () => {
    const broken = CLAIMS.map(c => [c.id, c.holds()]).filter(([, r]) => r !== true)
        .map(([id, r]) => `${id}: ${r}`);
    assert.deepStrictEqual(broken, [],
        'the brief has drifted from the code:\n  ' + broken.join('\n  '));
});

test('every claim states why, and every gap names what closes it', () => {
    for (const c of CLAIMS) {
        assert.ok(c.why && c.why.length > 40, `${c.id}: states no real reason`);
        assert.ok(['present', 'gap'].includes(c.kind), `${c.id}: unknown kind ${c.kind}`);
        if (c.kind !== 'gap') continue;
        if (c.outOfScope) {
            assert.ok(c.outOfScope.length > 30, `${c.id}: out of scope with no real reason`);
            continue;
        }
        assert.ok(c.closes && c.closes.length > 15,
            `${c.id} is a gap and names nothing that closes it — a gap pinned as permanent makes `
            + 'the brief fail for succeeding');
    }
    assert.ok(CLAIMS.length >= 6, `only ${CLAIMS.length} claims; the brief rests on more`);
});

/* ── the corrections that make this brief different from the last ───────── */

test('the brief states the framing error rather than burying it', () => {
    /*
     * The previous brief's plates-first split is what produced twelve tasks of
     * the wrong medium. A replacement that does not say so invites the next
     * reader to re-derive the same split from the same evidence.
     */
    const d = doc();
    assert.match(d, /Executive Summary[\s\S]{0,900}?(plates|split)/i,
        'the framing error is not stated in the Executive Summary, where a reader scanning for a '
        + 'conclusion would find it');
    assert.match(d, /does not phase by medium|not phase by medium/i,
        'the brief does not rule out re-phasing by medium, which is the specific mistake that '
        + 'produced the previous epic');
});

test('the size comparison that carries the recommendation is stated with BOTH numbers', () => {
    /*
     * "HEVC Log is smaller" is not a decision; a thirtieth is. A recommendation
     * resting on a ratio must show the ratio.
     */
    const d = doc();
    assert.match(d, /200\s*MB\/min/i, 'the HEVC Log figure is missing');
    assert.match(d, /6[–-]12\s*GB\/min|7\s*GB\/min/i, 'the ProRes figure is missing');
    assert.match(d, /thirtieth|30x|30×/i,
        'the ratio is not stated, so a reader cannot see why the default follows from it');
});

test('the open questions are DECISIONS, not tasks in disguise', () => {
    /*
     * The previous brief asked "is footage in scope at all?" and then answered
     * it with a phase plan. An open question that the brief quietly answers is
     * worse than none, because it looks like the reader was consulted.
     */
    const d = doc();
    const at = d.indexOf('## Open Questions');
    assert.notStrictEqual(at, -1, 'no Open Questions section');
    const qs = d.slice(at, d.indexOf('## Recommended Direction'));
    const numbered = (qs.match(/^\d+\. \*\*/gm) || []).length;
    assert.ok(numbered >= 4, `only ${numbered} open questions; the surface decision alone is two`);
    assert.match(qs, /which of the 18 targets|Which of the 18 targets/i,
        'the target-scope question is not asked, and inferring it is what produced the last epic');
    assert.match(qs, /WebView|33-page/i, 'the surface question is not asked');
});
