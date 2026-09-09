/**
 * THE FCC PARITY EPIC, HELD TO ITSELF AND TO THE CODE.
 *
 * The previous camera epic was held this way and it earned its keep: its gap
 * claims fired on contact in five separate tasks and named exactly what to
 * reshape. This one carries the same discipline plus two checks that exist
 * because of how that epic went WRONG rather than how it went right.
 *
 *   THE FRAMING GUARD. That epic phased "plates now, footage later" and shipped
 *   twelve tasks of the wrong medium. A phase plan that re-splits by medium is
 *   the specific failure being corrected, so it is refused here.
 *
 *   THE LABELLED-ASSUMPTION GUARD. The user answered a FORMAT question, not a
 *   SURFACE one. Two surface decisions had to be made by the architect, and an
 *   assumption presented as a finding is exactly what produced the last epic.
 *   Each must be marked as an assumption AND remain an open question.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EPIC = path.join(ROOT, 'docs', 'plans', 'fcc-parity-epic.md');
const doc = () => fs.readFileSync(EPIC, 'utf8');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments stripped — a mention is not a use. */
const code = (rel) => src(rel).split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const REQUIRED = ['Overview', 'Business Goals', 'Current State', 'Target State',
                  'Constraints', 'Task Breakdown', 'Open Questions', 'Success Metrics'];

/** One section's body, bounded by its own heading — never a character window. */
function section(name) {
    const m = doc().match(new RegExp(`^##+\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm'));
    assert.ok(m, `the epic has no ${name} section`);
    return m[1];
}

function tasks() {
    return [...doc().matchAll(/^\|\s*(FCC-\d{3})\s*\|([^|]*)\|([^|]*)\|\s*([SML])\s*\|([^|]*)\|/gm)]
        .map(m => ({ id: m[1], title: m[2].trim(), description: m[3].trim(),
                     size: m[4], deps: m[5].trim() }));
}

/* ── the epic's own shape ───────────────────────────────────────────────── */

test('the epic carries every section the format asks for', () => {
    const have = new Set([...doc().matchAll(/^##+\s+(.+)$/gm)].map(m => m[1].trim()));
    const missing = REQUIRED.filter(s => !have.has(s));
    assert.deepStrictEqual(missing, [], `the epic omits: ${missing.join(', ')}`);
});

test('EVERY task is well formed, uniquely numbered and unbroken', () => {
    const all = tasks();
    assert.ok(all.length >= 12,
        `only ${all.length} tasks parsed — the scan is broken, and one that finds too few reports `
        + 'the plan as smaller than it is');
    const bad = all.filter(t => !t.title || t.description.length < 40)
        .map(t => `${t.id}: title or description says nothing usable`);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));

    const ids = all.map(t => t.id);
    assert.deepStrictEqual([...new Set(ids)], ids, 'a task id is used twice');
    ids.forEach((id, i) => assert.strictEqual(Number(id.slice(4)), i + 1,
        `task numbering jumps at ${id} — a gap reads as a task that was dropped`));
});

test('EVERY dependency names a task that exists and comes earlier', () => {
    /*
     * A renamed task leaves a dependency pointing at nothing, and the plan
     * cannot be executed in order — discovered only when a dispatch picks up a
     * task whose prerequisite is a typo.
     */
    const order = new Map(tasks().map((t, i) => [t.id, i]));
    const bad = [];
    for (const t of tasks()) {
        if (/^none$/i.test(t.deps)) continue;
        for (const raw of (t.deps.match(/FCC-\d{3}(\.\.FCC-\d{3})?/g) || [])) {
            for (const dep of raw.split('..')) {
                if (!order.has(dep)) { bad.push(`${t.id} depends on ${dep}, which does not exist`); continue; }
                if (dep === t.id) bad.push(`${t.id} depends on itself`);
                else if (order.get(dep) > order.get(t.id)) bad.push(`${t.id} depends on later ${dep}`);
            }
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

/* ── the framing this epic exists to correct ────────────────────────────── */

test('the epic is NOT phased by medium', () => {
    /*
     * THE failure being corrected. "Plates now, footage later" looks prudent and
     * delivers the wrong half, because the spine has to change either way.
     */
    const phases = [...doc().matchAll(/^### (Phase \d+: .+)$/gm)].map(m => m[1]);
    assert.ok(phases.length >= 3, `only ${phases.length} phases; re-derive this check`);
    const byMedium = phases.filter(p => /\b(plates?|stills?|photo)\b/i.test(p));
    assert.deepStrictEqual(byMedium, [],
        `these phases split by MEDIUM, which is the mistake that produced twelve tasks of still `
        + `photography: ${byMedium.join(', ')}`);
    assert.match(doc(), /NOT phased by medium/,
        'the epic does not state that it refuses to phase by medium, so a later reader may '
        + 're-derive the split from the same evidence');
});

test('EVERY phase touches video, so none is a stills phase in disguise', () => {
    /*
     * Naming a phase something else while filling it with stills work would
     * pass the check above and reproduce the failure exactly.
     */
    const body = doc();
    const marks = [...body.matchAll(/^### Phase \d+: .+$/gm)];
    const bad = [];
    marks.forEach((m, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].index : body.indexOf('## Open Questions');
        const chunk = body.slice(m.index, end);
        if (!/video|record|footage|clip|transport|camera/i.test(chunk)) {
            bad.push(`${m[0]} contains no video-facing work`);
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('the user\'s direction is quoted, not paraphrased into something weaker', () => {
    /*
     * WHITESPACE-NORMALISED before matching. Markdown wraps, and the quote here
     * breaks as "Use the\n  hardware you actually have" — a phrase check that
     * assumes single spaces reports a correctly quoted document as unquoted.
     * The same wrapping hid a ceiling number from the brief's check one step
     * earlier, so it is worth stating as a rule: any multi-word check over prose
     * must collapse whitespace first.
     */
    const c = section('Constraints').replace(/\s+/g, ' ');
    assert.match(c, /Use the hardware you actually have/,
        'the direction is not quoted, so a later reader cannot check the paraphrase against it');
    assert.match(c, /Nothing is struck for hardware reasons|nothing is struck/i,
        'the epic does not record that nothing is excluded for hardware reasons');
    for (const f of ['ProRes RAW', 'Apple Log 2', 'open gate']) {
        assert.ok(c.includes(f), `${f} was chosen by the user and is not in Constraints`);
    }
});

test('genlock is the ONE exclusion, and says why', () => {
    const c = section('Constraints');
    assert.match(c, /[Gg]enlock[\s\S]{0,220}?ProDock/,
        'genlock is excluded without naming the ProDock, so it reads as unfinished work rather '
        + 'than a hardware purchase');
});

/* ── assumptions must be visible as assumptions ─────────────────────────── */

test('EVERY architect assumption is LABELLED and remains an open question', () => {
    /*
     * The user answered a FORMAT question. The surface decisions were mine, and
     * an assumption presented as a finding is what produced the last epic.
     */
    const c = section('Constraints');
    const labelled = [...c.matchAll(/ASSUMPTION, LABELLED/g)];
    assert.ok(labelled.length >= 2,
        `only ${labelled.length} labelled assumptions; the surface question alone is two — which `
        + 'targets, and what happens to the WebView');

    const qs = section('Open Questions');
    assert.match(qs, /WebView/,
        'the WebView assumption is made in Constraints and not offered back as a question');
    assert.match(qs, /storyboard-image|mood-board-image/,
        'the marginal camera targets are assumed and not offered back as a question');
});

test('the surface rule is DERIVABLE, not a hand-typed list', () => {
    /*
     * A list of targets goes stale the day a nineteenth is added. A rule can be
     * applied to whatever the registry holds.
     */
    const c = section('Constraints');
    assert.match(c, /PHOTOGRAPHED IN THE WORLD/,
        'the epic names targets without stating the rule that selects them');
    assert.match(c, /GENERATED|AUTHORED/,
        'the excluded targets are not classified, so the rule cannot be applied to a new target');
});

/* ── claims about the code ──────────────────────────────────────────────── */

const CLAIMS = [
    {
        id: 'import-target-count',
        kind: 'present',
        why: 'the surface rule is stated as "8 of 18 targets"; if the registry grows the fraction '
            + 'is wrong and the rule would be applied to a set the epic never saw',
        holds() {
            const { MEDIA_IMPORTS } = require('../lib/media-imports');
            const n = Object.keys(MEDIA_IMPORTS).length;
            return doc().includes(`of ${n} targets`)
                || `MEDIA_IMPORTS has ${n} targets and the epic states a different total`;
        },
    },
    {
        id: 'every-named-target-exists',
        kind: 'present',
        why: 'the epic names eight camera targets and five excluded ones; a name that matches no '
            + 'registry entry is a task nobody can execute',
        holds() {
            const { MEDIA_IMPORTS } = require('../lib/media-imports');
            /*
             * Every hyphenated backticked token is a candidate, minus an
             * explicit allow-list of non-targets. The first version filtered by
             * SUFFIX (-plate|-image|-ref|...) and a mutation renaming
             * `continuity-ref` to `continuity-refs` slipped straight through
             * unchecked — a near-miss on an identifier is exactly the shape a
             * typo takes, and the filter excused it.
             */
            // Named exclusions with a reason, never a suffix pattern: these are
            // a module and English, not import targets.
            const NOT_TARGETS = new Set([
                'capture-policy',       // a lib module, referenced by name in FCC-011
                'open-gate', 'sync-sound', 'read-only', 'byte-identical',
            ]);
            const named = [...doc().matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map(m => m[1])
                .filter(n => !NOT_TARGETS.has(n) && !n.endsWith('.js') && !n.includes('.'));
            const unknown = [...new Set(named)].filter(n => !MEDIA_IMPORTS[n]);
            return unknown.length === 0
                || `the epic names targets that are not in MEDIA_IMPORTS: ${unknown.join(', ')}`;
        },
    },
    {
        id: 'capture-policy-is-what-gets-extended',
        kind: 'present',
        why: 'FCC-011 extends this module rather than replacing it; if it lost maxSecondsFor the '
            + 'task would be proposing new work as an extension',
        holds() {
            const p = require('../lib/capture-policy');
            const missing = ['maxSecondsFor', 'checkCapture', 'MODES', 'CEILINGS']
                .filter(k => p[k] === undefined);
            return missing.length === 0
                || `capture-policy no longer exports: ${missing.join(', ')}`;
        },
    },
    {
        id: 'the-controlled-camera-replaced-the-system-one',
        kind: 'present',
        why: 'RESHAPED from `system-camera-is-still-there` when FCC-012 (GRD-3808) landed. The '
            + 'epic existed because shootControl rendered the OS picker, and that claim was '
            + 'written to break the day it stopped — "a gap pinned as permanent makes the epic '
            + 'fail for succeeding". It did NOT break: it asked only whether shootControl renders '
            + 'a `capture` attribute anywhere, and the browser fallback still does and should, so '
            + 'it passed while asserting the opposite of the code. Both arms are pinned here, '
            + 'because the pair IS the claim.',
        holds() {
            const page = code('src/index.html');
            const at = page.indexOf('function shootControl');
            if (at === -1) return 'shootControl is gone — reshape this claim to pin what replaced it';
            const body = page.slice(at, page.indexOf('\n    }', at));
            const missing = [];
            if (!/plateShootButton\(/.test(body)) missing.push('it never reaches the controlled camera');
            if (!/shootsWithCamera\(/.test(body)) missing.push('it does not ask which targets photograph the world');
            if (!/capture=/.test(body)) missing.push('the browser lost its only camera');
            return missing.length === 0
                || `shootControl no longer replaces the system camera: ${missing.join('; ')}`;
        },
    },
    {
        id: 'the-recording-transport-is-built',
        kind: 'present',
        why: 'RECORDS FCC-002 (GRD-3798). "A director must see the clip end coming, not discover '
            + 'it" — the transport is that sentence, and the countdown is the half that makes it '
            + 'true. Losing the remaining figure would leave a record button that runs until the '
            + 'ceiling stops it with no warning, which is the state the task removed',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['struct RecordingTransport', 'secondsRemaining', 'elapsedSeconds',
                'endInSight'].filter(s => !cam.includes(s));
            return missing.length === 0
                || `the recording transport has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'the-audio-track-is-built',
        kind: 'present',
        why: 'RECORDS FCC-003 (GRD-3799). A mute clip writes, plays and says nothing — it is '
            + 'indistinguishable from a working one until somebody listens, by which time the '
            + 'take is over. The sound capture and the fact that a MOS take SAYS so are one '
            + 'claim, because the second is what makes the first noticeable',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['AVCaptureAudioDataOutput', 'recordsAudio']
                .filter(s => !cam.includes(s));
            return missing.length === 0 || `the audio track has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'the-locks-reach-a-recording-session',
        kind: 'present',
        why: 'RECORDS FCC-004 (GRD-3800). A preset swap releases every lock the device holds, so '
            + 'a take metered automatically while the chip on screen reads LOCK HELD is worse '
            + 'than a bad plate — a plate can be re-shot. `reapplyLocks` is the one helper that '
            + 'puts them back, and it has to be REACHED from the recording path rather than '
            + 'merely existing',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            if (!cam.includes('func reapplyLocks')) return 'reapplyLocks is gone';
            const at = cam.indexOf('func startRecording');
            if (at === -1) return 'startRecording is gone';
            return /reapplyLocks\(/.test(cam.slice(at, cam.indexOf('\n    }', at)))
                || 'startRecording no longer re-applies the locks, so a take is metered live '
                 + 'while the chip says the exposure is held';
        },
    },
    {
        id: 'the-format-picker-is-built',
        kind: 'present',
        why: 'RECORDS FCC-006 (GRD-3802). "Every format shows MB/min, maximum duration and how it '
            + 'will travel" — two formats are equal buttons until those numbers are on them, and '
            + 'a format whose transport is absent must be REFUSED with the remedy rather than '
            + 'offered or hidden. The picker and the choices it renders are one claim',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            if (!cam.includes('struct FormatPicker')) return 'the format picker is gone';
            const p = require('../lib/capture-policy');
            if (typeof p.formatChoices !== 'function') return 'capture-policy no longer priced the choices';
            const choices = p.formatChoices();
            const priced = choices.filter(c => typeof c.mb_per_min === 'number' && c.mb_per_min > 0);
            if (priced.length !== choices.length) return 'a choice states no cost per minute';
            const refused = choices.filter(c => !c.offered);
            return refused.every(c => c.refusal && c.refusal.length > 30)
                || 'a refused format says nothing useful about why, so it is indistinguishable '
                 + 'from one that was never built';
        },
    },
    {
        id: 'prores-recording-is-built',
        kind: 'present',
        why: 'RECORDS FCC-007 (GRD-3803). ProRes is ~7 GB/min at 4K30, which is why the epic says '
            + 'it "must not be offered without FCC-009" — so the codecs existing and every ProRes '
            + 'mode declaring the external transport are the same claim. Losing the second would '
            + 'offer a director a format whose take nothing can carry',
        holds() {
            const p = require('../lib/capture-policy');
            const codecs = ['prores422', 'prores422hq'].filter(c => !p.CODECS[c]);
            if (codecs.length) return `the codec registry has lost: ${codecs.join(', ')}`;
            const prores = Object.entries(p.MODES).filter(([, m]) => /^prores/.test(m.codec));
            if (prores.length < 3) return `only ${prores.length} ProRes modes are declared`;
            const wrong = prores
                .filter(([, m]) => !(m.transports || []).includes('external'))
                .map(([id]) => id);
            return wrong.length === 0
                || `these ProRes modes no longer require a drive: ${wrong.join(', ')}`;
        },
    },
    {
        id: 'the-hardware-tier-is-gated-on-the-device',
        kind: 'present',
        why: 'RECORDS FCC-008 (GRD-3804). "Gated on the device reporting the capability rather '
            + 'than on a model string" is the whole task: a model string has never heard of the '
            + 'phone that shipped this morning, which is exactly the one with the feature. The '
            + 'capabilities and the report of what THIS phone lacks are one claim, because a '
            + 'capability the device lacks must be named rather than silently skipped',
        holds() {
            const p = require('../lib/capture-policy');
            const missing = ['apple_log2', 'prores_raw', 'open_gate']
                .filter(c => !p.CAPABILITIES[c]);
            if (missing.length) return `the capability registry has lost: ${missing.join(', ')}`;
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            return cam.includes('capabilityProblem')
                || 'nothing reports which advanced formats this phone cannot record, so a 15 Pro '
                 + 'Max meets an exception at the moment the director presses record';
        },
    },
    {
        id: 'external-storage-is-checked-before-the-take',
        kind: 'present',
        why: 'RECORDS FCC-009 (GRD-3805). "The drive is checked BEFORE recording starts" — a '
            + 'drive that turns out to be too slow four seconds into a ProRes take has not '
            + 'produced a shorter take, it has produced a corrupt one, and the moment is gone. '
            + 'Four of the five checks are the OS\'s own answers; the fifth is room for THIS '
            + 'take, which the OS cannot know',
        holds() {
            const p = require('../lib/capture-policy');
            if (Object.keys(p.DRIVE_CHECKS || {}).length < 5) {
                return `only ${Object.keys(p.DRIVE_CHECKS || {}).length} drive checks remain`;
            }
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['AVExternalStorageDevice', 'isNotRecommendedForCaptureUse', 'freeSize']
                .filter(s => !cam.includes(s));
            return missing.length === 0
                || `the drive pre-flight has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'the-resumable-upload-is-built',
        kind: 'present',
        why: 'RECORDS FCC-010 (GRD-3806). "A phone loses Wi-Fi mid-transfer and a restart from '
            + 'zero on a multi-gigabyte file is a transfer that never completes" — that is '
            + 'arithmetic rather than pessimism, and resuming is the whole point. The server '
            + 'holds the only authoritative answer to how much arrived, so `received` is derived '
            + 'from the file rather than stored beside it',
        holds() {
            const up = require('../lib/uploads');
            const missing = ['beginUpload', 'appendChunk', 'uploadStatus', 'completeUpload',
                'abandonUpload'].filter(f => typeof up[f] !== 'function');
            if (missing.length) return `the transfer has lost: ${missing.join(', ')}`;
            const lib = code('backend/lib/uploads.js');
            return /statSync\(part\)\.size|fs\.statSync/.test(lib)
                || 'the received count is no longer read from the file, so a counter and the '
                 + 'bytes can disagree — which is the state this exists to recover from';
        },
    },
    {
        id: 'the-walkthrough-is-budgeted-against-marble',
        kind: 'present',
        why: 'RECORDS FCC-013 (GRD-3809). A world is reconstructed from COVERAGE, so the budget '
            + 'is the feature: 4K60 gives a walkthrough fourteen seconds, which covers one corner '
            + 'of a room. `RecordingBudget` could answer that from FCC-011 and nothing asked — '
            + 'eight entry points declared and defaulted — so what this records is that a session '
            + 'REACHES them, and that a world take holds its exposure',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            if (!/forWorld:\s*(forWorld|camera\.forWorld|world)/.test(cam)) {
                return 'no session asks the budget about a world capture, so a walkthrough is '
                    + 'budgeted against the upload and Marble refuses the clip after the walk';
            }
            const at = cam.indexOf('func startRecording');
            if (at === -1) return 'startRecording is gone';
            const body = cam.slice(at, cam.indexOf('\n    }', at));
            return /lockExposure\(\)/.test(body)
                || 'a world take no longer holds its exposure, so the same wall reaches the '
                 + 'reconstruction at two brightnesses';
        },
    },
    {
        id: 'footage-attaches-to-a-shot',
        kind: 'present',
        why: 'RECORDS FCC-014 (GRD-3810). FCC-012 left this surface on the OS picker because the '
            + 'camera recorded a take and nothing delivered it. What closed it was the ROUTE: '
            + 'three sites decoded an upload and only one used the shared accessor, so the one '
            + 'built for the largest files refused raw bytes before reading one. That single '
            + 'caller is the load-bearing half',
        holds() {
            const m = require('../lib/media-imports');
            if (!m.shootsWithCamera('video-media')) {
                return 'footage no longer reaches the controlled camera';
            }
            if (m.MEDIA_IMPORTS['video-media'].camera_pending) {
                return 'footage is marked as waiting again, which is the gap this task closed';
            }
            const lib = code('backend/lib/media-imports.js');
            const callers = (lib.match(/decodeDataUri\(/g) || []).length;
            return callers === 2
                || `decodeDataUri has ${callers - 1} caller(s) besides bytesFrom — a site that `
                 + 'decodes directly cannot accept raw bytes, which is what stood between a take '
                 + 'on the phone and its shot';
        },
    },
    {
        id: 'the-recording-spine-is-built',
        kind: 'present',
        why: 'RESHAPED from the AVAssetWriter half of `no-recording-apis-yet` when FCC-001 '
            + '(GRD-3797) landed. Phase 1 rested on this being absent and it no longer is, so '
            + 'the claim now pins what was built — every later task in the epic is fed from this '
            + 'writer, and its removal would silently unbuild all of them',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['AVAssetWriter', 'RecordingMode', 'RecordingSink']
                .filter(s => !cam.includes(s));
            return missing.length === 0
                || `the recording spine FCC-001 built has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'the-log-colour-space-is-built',
        kind: 'present',
        why: 'RESHAPED when FCC-005 landed, which is the task this gap named. Phase 2 rested on '
            + 'the log colour space being absent and it no longer is, so the claim pins what was '
            + 'built — including the session flag, because assigning .appleLog without it is '
            + 'silently undone and the take records Rec.709',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['activeColorSpace', 'automaticallyConfiguresCaptureDeviceForWideColor',
                             'supportedColorSpaces']
                .filter(s => !cam.includes(s));
            return missing.length === 0
                || `the log colour space FCC-005 built has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'the-arithmetic-being-reused-exists',
        kind: 'present',
        why: 'the Overview promises these are reused rather than re-planned; if any were removed '
            + 'the epic would be sizing tasks against work that is not there',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['FrameAnalysis', 'FocusPeaking', 'ExposureWarning', 'PlateGuides',
                             'ExposureLock', 'WhiteBalanceLock', 'FocusLock']
                .filter(t => !new RegExp(`\\b(enum|struct) ${t}\\b`).test(cam));
            return missing.length === 0
                || `the epic reuses these and they are gone: ${missing.join(', ')}`;
        },
    },
    {
        id: 'photo-output-still-active',
        kind: 'present',
        why: 'FCC-001 says stills are not lost because both outputs may be active since iOS 16; '
            + 'that promise is only meaningful while the photo output is there',
        holds() {
            return code('ios/FilmEngine/PlateCamera.swift').includes('AVCapturePhotoOutput')
                || 'the photo output is gone — stills were lost, which FCC-001 said need not happen';
        },
    },
];

test('EVERY claim the epic rests on is still true of the code', () => {
    const broken = CLAIMS.map(c => [c.id, c.holds()]).filter(([, r]) => r !== true)
        .map(([id, r]) => `${id}: ${r}`);
    assert.deepStrictEqual(broken, [],
        'the epic has drifted from the code:\n  ' + broken.join('\n  '));
});

test('every claim states why, and every gap names the task that closes it', () => {
    const ids = new Set(tasks().map(t => t.id));
    for (const c of CLAIMS) {
        assert.ok(c.why && c.why.length > 40, `${c.id}: states no real reason`);
        if (c.kind !== 'gap') continue;
        if (c.outOfScope) {
            assert.ok(c.outOfScope.length > 30, `${c.id}: out of scope with no real reason`);
            continue;
        }
        assert.match(c.closes || '', /FCC-\d{3}/,
            `${c.id} is a gap and names no task that closes it — a gap pinned as permanent makes `
            + 'the epic fail for succeeding');
        for (const dep of c.closes.match(/FCC-\d{3}/g)) {
            assert.ok(ids.has(dep), `${c.id} says ${dep} closes it, and no such task exists`);
        }
    }
    assert.ok(CLAIMS.length >= 6, `only ${CLAIMS.length} claims; the epic rests on more`);
});

test('the format economics that justify the plan are stated with real numbers', () => {
    /*
     * "ProRes is bigger" is not a constraint; 7 GB/min against a 100 MB pipe is.
     * A plan that hides the ratio invites somebody to offer ProRes over the
     * JSON body.
     */
    const d = doc();
    assert.match(d, /200\s*MB\/min/i, 'the HEVC Log figure is missing');
    assert.match(d, /7\s*GB\/min/i, 'the ProRes figure is missing');
    const policy = require('../lib/capture-policy');
    // The ceiling a ProRes take would meet on the wire, not the smallest number
    // in the registry — that one is World Labs' and binds a world capture.
    const mb = Math.floor(policy.bindingBytesFor({
        transport: 'upload', destination: 'footage', kind: 'video',
    }) / 1048576);
    const mentions = [...d.matchAll(/(\d+)\s*MB\s+(?:pipe|ceiling)/g)].map(m => Number(m[1]));
    assert.ok(mentions.length >= 1, 'the binding ceiling is never stated');
    const wrong = mentions.filter(v => v !== mb);
    assert.deepStrictEqual(wrong, [],
        `the binding ceiling is ${mb}MB and the epic states ${wrong.join(', ')}`);
});
