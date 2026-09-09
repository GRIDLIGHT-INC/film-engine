/**
 * PREVIZ SHOOTS PROPERLY — GRD-3809 / FCC-013.
 *
 * "`world-capture` records with exposure locked and the duration budget
 * visible, against the ceiling `capture-policy` computes. A world is
 * reconstructed from coverage, so the budget is the feature."
 *
 * A WORLD IS RECONSTRUCTED FROM COVERAGE, WHICH IS WHY THE BUDGET IS THE
 * FEATURE RATHER THAN A WARNING. Marble takes ONE walkthrough of a room and
 * builds a place a camera can stand in from it. The clip is capped at 100MB by
 * World Labs, so a director shooting 4K60 has FOURTEEN SECONDS — and a
 * fourteen-second walk covers one corner of a room. 1080p30 gives 133, which
 * covers it. That difference is not a limit to be warned about at the end; it
 * is the shot-planning fact the whole surface exists to state, and until now it
 * was discovered at upload, after the walk.
 *
 * `RecordingBudget` HAS ANSWERED THIS SINCE FCC-011 AND NOTHING ASKED. Eight
 * functions take `forWorld:` — the parameter that swaps the upload's 150MB for
 * Marble's 100MB — and every call site in the app takes the default. That is
 * the `NEVER_WRITES` / `scope` / `describeResolution` shape this codebase has
 * paid for four times: a rule declared, exported, and consumed by nobody, which
 * reads as coverage while the camera quotes 200 seconds for a walkthrough that
 * can only be 133.
 *
 * AND EXPOSURE. A walkthrough panned across a window meters down, then back up
 * on the far wall — so the SAME wall arrives at two brightnesses and the
 * reconstruction has to reconcile them. Locking is not a nicety here, it is the
 * difference between coverage that solves and coverage that does not, and it
 * must happen for the TAKE rather than being something a director remembers.
 *
 * SET-BASED OVER THREE REGISTRIES:
 *
 *   1. `RecordingBudget`'s `forWorld` entry points — 8, parsed from the Swift.
 *      Every one must be REACHED by a world session. Seven of eight consumed is
 *      a camera that shows the right number and enforces the wrong one.
 *   2. `MODES` — 10. The world budget must be right for every format, not for
 *      the recommended one: a rule that fixes 1080p30 and leaves 4K60 is wrong
 *      on precisely the mode where the ceiling bites hardest.
 *   3. `MEDIA_IMPORTS` — 18 targets, each resolving to a destination, so which
 *      ceiling binds a capture is derived rather than a string typed into the
 *      page.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SWIFT_PATH = path.join(ROOT, 'ios', 'FilmEngine', 'PlateCamera.swift');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

const policy = require('../lib/capture-policy');
const { MODES } = policy;
const media = require('../lib/media-imports');
const { MEDIA_IMPORTS } = media;

const src = () => fs.readFileSync(SWIFT_PATH, 'utf8');
/** Comments stripped — a mention is not a use. */
const code = () => src().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH — never a character window. */
function extract(header) {
    const s = src();
    const at = s.indexOf(header);
    assert.notStrictEqual(at, -1,
        `PlateCamera.swift declares no '${header}'. If it was renamed this test cannot see the `
        + 'arithmetic it exists to check, and would pass by finding nothing');
    /*
     * Skip the SIGNATURE before looking for the body: a default argument that
     * is a closure puts a `{` inside the parentheses, and taking the first one
     * cuts the declaration in half.
     */
    let i = at;
    if (s.slice(at, s.indexOf('{', at)).includes('(')) {
        let p = 0;
        for (i = s.indexOf('(', at); i < s.length; i++) {
            if (s[i] === '(') p++;
            else if (s[i] === ')' && --p === 0) break;
        }
    }
    let d = 0;
    for (let j = s.indexOf('{', i); j < s.length; j++) {
        if (s[j] === '{') d++;
        else if (s[j] === '}' && --d === 0) return s.slice(at, j + 1);
    }
    throw new Error(`${header} does not close`);
}

/** A Swift function body, by brace depth from its declaration. */
function swiftFunc(name) {
    const s = code();
    const at = s.indexOf(`func ${name}(`);
    assert.notStrictEqual(at, -1, `PlateCamera.swift declares no ${name}`);
    let p = 0;
    let i = s.indexOf('(', at);
    for (; i < s.length; i++) {
        if (s[i] === '(') p++;
        else if (s[i] === ')' && --p === 0) break;
    }
    let d = 0;
    for (let j = s.indexOf('{', i); j < s.length; j++) {
        if (s[j] === '{') d++;
        else if (s[j] === '}' && --d === 0) return s.slice(at, j + 1);
    }
    throw new Error(`${name} does not close`);
}

/**
 * Compile the two pure structs and ASK them, rather than reading the numbers.
 *
 * There is no Swift test target in this repo, so the budget is checked by
 * running it — the arrangement `fcc-transport.test.js` established. Reading the
 * arithmetic and agreeing with it is how two documents come to state one wrong
 * number confidently.
 */
let cached;
function swiftBudget() {
    if (cached) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-previz-'));
    const file = path.join(dir, 'main.swift');
    fs.writeFileSync(file, `${extract('struct RecordingMode')}
${extract('enum RecordingBudget')}
for m in RecordingMode.all {
    let film = RecordingBudget.maxSeconds(m)
    let world = RecordingBudget.maxSeconds(m, forWorld: true)
    let warn = RecordingBudget.warnSeconds(m, forWorld: true)
    let left = RecordingBudget.remaining(m, elapsed: 1, forWorld: true)
    let offered = RecordingBudget.isOffered(m, forWorld: true) ? 1 : 0
    print("MODE=\\(m.id)|\\(film)|\\(world)|\\(warn)|\\(left)|\\(offered)")
}
print("REC=\\(RecordingBudget.recommended(forWorld: true).id)")
`);
    const out = execFileSync('swift', [file], { encoding: 'utf8', timeout: 180000 });
    const modes = {};
    for (const l of out.trim().split('\n').filter((x) => x.startsWith('MODE='))) {
        const [id, film, world, warn, left, offered] = l.slice('MODE='.length).split('|');
        modes[id] = {
            film: +film, world: +world, warn: +warn, left: +left, offered: offered === '1',
        };
    }
    const rec = (out.match(/REC=(.+)/) || [, ''])[1].trim();
    cached = { modes, rec };
    return cached;
}

/* ------------------------------------------------------------------ *
 * SET 1 — the budget, for every format, against Marble                *
 * ------------------------------------------------------------------ */

test('EVERY mode gets the WORLD budget the server computes, not the footage one', () => {
    const ids = Object.keys(MODES);
    assert.ok(ids.length >= 10, `only ${ids.length} modes; the registry read is broken`);

    const wrong = [];
    for (const [id, m] of Object.entries(MODES)) {
        const swift = swiftBudget().modes[id];
        if (!swift) { wrong.push(`${id}: the camera has no budget for it`); continue; }
        const expected = Math.floor(
            policy.bindingBytesFor(policy.routeFor(m, { destination: 'world' })) / m.bytes_per_second);
        if (swift.world !== expected) {
            wrong.push(`${id}: the camera allows ${swift.world}s for a world capture and the `
                + `server allows ${expected}s`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera and the server disagree about how long a WALKTHROUGH may be. A director is '
        + 'shown one number and Marble enforces another, so a walk made on that promise is '
        + `refused after it was shot:\n  ${wrong.join('\n  ')}`);
});

test('a walkthrough is SHORTER than the same mode shot for the cut', () => {
    /*
     * The whole point of the destination reaching the number. If these are
     * equal the parameter is being declared and defaulted — which is exactly
     * the state FCC-011 left and this task closes.
     */
    const wrong = [];
    for (const [id, m] of Object.entries(MODES)) {
        const t = (m.transports || [])[0];
        if (t !== 'upload') continue;    // a drive is bound by the drive, not by Marble
        const s = swiftBudget().modes[id];
        if (!s) continue;
        if (!(s.world < s.film)) {
            wrong.push(`${id}: ${s.world}s for a world capture and ${s.film}s for the cut — `
                + 'equal means Marble\'s cap is not reaching the walkthrough budget');
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
    // And the headline the surface exists to state.
    assert.strictEqual(swiftBudget().modes['4k60'].world, 14,
        '4K60 no longer gives a walkthrough 14 seconds, which is the number that makes this a '
        + 'shot-planning fact rather than a warning');
    assert.strictEqual(swiftBudget().modes['1080p30'].world, 133);
});

test('the recommendation for a WORLD capture is chosen against Marble', () => {
    /*
     * A world is reconstructed from COVERAGE, so the longest usable clip is the
     * right default — and "longest" is a different answer under a different
     * ceiling. Asking without the destination recommends against the upload.
     */
    const rec = swiftBudget().rec;
    assert.ok(MODES[rec] || /^opengate/.test(rec), `recommended mode ${rec} is not declared`);
    const server = policy.recommended({ destination: 'world' });
    assert.strictEqual(rec, server.mode,
        `the camera recommends ${rec} for a walkthrough and the server recommends ${server.mode}`);
});

/* ------------------------------------------------------------------ *
 * SET 2 — every forWorld entry point is REACHED, not merely declared  *
 * ------------------------------------------------------------------ */

test('EVERY forWorld entry point is actually asked with it', () => {
    /*
     * FCC-011 added the parameter to eight functions and no call site passed
     * it. Declared, exported, consumed by nobody — the shape `NEVER_WRITES`,
     * `scope` on PIPELINE_STEPS, `describeResolution` and `voice_id` each cost
     * this codebase once. A budget that answers correctly when asked and is
     * never asked is worse than none, because it reads as covered.
     */
    const s = code();
    /*
     * Comment-stripped on BOTH sides. `extract` reads the raw source while this
     * scan reads the stripped copy, so replacing one in the other matched
     * NOTHING and the whole file was treated as "outside" — which the budget's
     * own internal calls then satisfied. The detector reported eight entry
     * points reached while two had no consumer at all. Second time in two
     * tasks that a scan went quiet in the direction that passes.
     */
    const budget = code().slice(...(() => {
        const at = code().indexOf('enum RecordingBudget');
        assert.notStrictEqual(at, -1, 'RecordingBudget is gone');
        let d = 0;
        for (let i = code().indexOf('{', at); i < code().length; i++) {
            if (code()[i] === '{') d++;
            else if (code()[i] === '}' && --d === 0) return [at, i + 1];
        }
        throw new Error('RecordingBudget does not close');
    })());
    const declared = [...budget.matchAll(/static func (\w+)\([^)]*forWorld: Bool/g)].map((m) => m[1]);
    assert.ok(declared.length >= 6,
        `only ${declared.length} forWorld entry points found; the scan is broken and every `
        + 'assertion below would pass over nothing');

    const outside = s.replace(budget, '');
    assert.ok(outside.length < s.length - 1000,
        'the budget was not removed from the scan, so its own internal calls would satisfy every '
        + 'entry point and this check would pass over a camera that never asks');

    /*
     * REACHABILITY, not a direct call, and the distinction is the honest one.
     * `ceilingBytes` and `warnSeconds` have no reason to be called from a view
     * — `maxSeconds` and `isEndInSight` are what a session asks, and they carry
     * the route down. Demanding a direct external call for those two would ask
     * for calls that should not exist. What must be true is that no entry point
     * is left answering the DEFAULT for a world session.
     */
    const called = (from, name) =>
        new RegExp(`(?<!func )\\b${name}\\([^)]*forWorld:`).test(from);
    const bodyOf = (name) => {
        const at = budget.indexOf(`func ${name}(`);
        if (at === -1) return '';
        let p = 0;
        let i = budget.indexOf('(', at);
        for (; i < budget.length; i++) {
            if (budget[i] === '(') p++;
            else if (budget[i] === ')' && --p === 0) break;
        }
        const brace = budget.indexOf('{', i);
        if (brace === -1) return budget.slice(at, budget.indexOf('\n', i));
        let d = 0;
        for (let j = brace; j < budget.length; j++) {
            if (budget[j] === '{') d++;
            else if (budget[j] === '}' && --d === 0) return budget.slice(at, j + 1);
        }
        return '';
    };

    const reached = new Set(declared.filter((n) => called(outside, n)));
    for (let pass = 0; pass < declared.length; pass++) {
        for (const n of declared) {
            if (reached.has(n)) continue;
            if ([...reached].some((r) => called(bodyOf(r), n))) reached.add(n);
        }
    }

    const wrong = declared.filter((n) => !reached.has(n)).map((n) =>
        `${n}: no session ever reaches it with a world route — directly or through one that does `
        + '— so a walkthrough is budgeted against the upload ceiling and Marble refuses the clip '
        + 'after the walk');
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('the camera knows whether THIS session is a world capture', () => {
    const s = code();
    assert.match(s, /let destination: String\?/,
        'PlateCaptureRequest cannot be told where the capture is going, so the camera must guess '
        + 'which ceiling binds it');
    assert.match(s, /forWorld/,
        'the model carries no notion of a world session');

    // withBase() rebuilds the request field by field, and a field it forgets is
    // dropped on EVERY request — the page sends apiBase empty, so every one.
    const bridge = fs.readFileSync(path.join(ROOT, 'ios', 'FilmEngine', 'ContentView.swift'), 'utf8');
    const at = bridge.indexOf('func withBase(');
    assert.notStrictEqual(at, -1, 'withBase is gone');
    /*
     * The FIELD'S OWN VALUE, not merely the label. `destination: nil` satisfies
     * a check for `destination:` and drops it on every request — caught by a
     * mutation, not by reading, which is the second declaration-not-value trap
     * this task turned up.
     */
    assert.match(bridge.slice(at, bridge.indexOf('\n    }', at)), /destination:\s*destination\b/,
        'withBase() rebuilds the request without carrying the destination through, so it is '
        + 'dropped on every request the app injects its address into — which is all of them, '
        + 'because the page always sends apiBase empty');
});

/* ------------------------------------------------------------------ *
 * SET 3 — exposure is held for the take                               *
 * ------------------------------------------------------------------ */

test('a world take LOCKS exposure, rather than hoping a director remembered', () => {
    /*
     * A walk past a window meters down and back up, so the same wall arrives at
     * two brightnesses and the reconstruction has to reconcile them. The lock
     * has existed since PCC-001 and was a thing to remember; for a walkthrough
     * it is the difference between coverage that solves and coverage that does
     * not.
     */
    const body = swiftFunc('startRecording');
    assert.match(body, /lockExposure\(\)/,
        'starting a take never establishes the exposure lock, so a walkthrough is metered live '
        + 'and the same wall comes back at two brightnesses');
    assert.match(body, /forWorld|destination/,
        'the lock is not scoped to a world capture — a plate session must keep its own choice, '
        + 'since re-metering a dark back against a bright wall is a real thing to want');

    /*
     * BEFORE the writer opens. Locking after the first frames are written
     * leaves the start of the walk metered live, which is the half of the clip
     * a reconstruction leans on hardest.
     */
    const lockAt = body.indexOf('lockExposure()');
    const beginAt = body.search(/sink\.begin\(/);
    assert.notStrictEqual(beginAt, -1, 'startRecording no longer opens the writer');
    assert.ok(lockAt !== -1 && lockAt < beginAt,
        'the exposure lock is established AFTER the writer opens, so the first seconds of the '
        + 'walk are metered live');
});

test('a lens that cannot hold exposure is NAMED, and the take still runs', () => {
    /*
     * Refusing would strand a director who has walked to the location. The
     * existing lock already reports `exposureWarning` for that case, and the
     * transport has to be able to say it — a walkthrough shot on auto is
     * usable, and one shot on auto WITHOUT anybody saying so is a
     * reconstruction that fails for a reason nobody can see.
     */
    const s = code();
    assert.match(s, /exposureWarning/, 'nothing reports a lens that cannot hold exposure');
    const body = swiftFunc('startRecording');
    assert.ok(!/guard .*exposure.*else \{[\s\S]{0,120}return/.test(body),
        'a take is refused when exposure cannot be locked, which strands a director who has '
        + 'already walked to the location');
});

/* ------------------------------------------------------------------ *
 * SET 4 — the take is delivered, or the walk was for nothing          *
 * ------------------------------------------------------------------ */

test('a finished walkthrough is DELIVERED to the route the page named', () => {
    /*
     * The take is written to disk and `lastTake` holds the URL. Until something
     * sends it, a director walks the room, watches the budget, stops on time —
     * and the clip exists only on the phone. That is the silent-loss failure
     * this codebase refuses, and it is why FCC-012 deliberately left
     * `video-media` on the system camera rather than shipping a Shoot that
     * records and drops the file.
     */
    const s = code();
    assert.match(s, /func sendTake\(/,
        'nothing uploads a finished take, so a walkthrough never leaves the phone');

    const send = swiftFunc('sendTake');
    assert.match(send, /request\.url/,
        'the take is posted somewhere other than the route the page named — native must never '
        + 'construct one');
    assert.match(send, /httpBody|uploadTask|fromFile/,
        'sendTake builds no body');
    assert.ok(!/base64EncodedString\(\)/.test(send),
        'the take travels base64-encoded, which is a third larger than the file and is exactly '
        + 'what FCC-010 removed from this path');

    /*
     * A CALL, never the declaration. `/sendTake\(/` matches `func sendTake(`
     * itself, so deleting every call left this green — the declaration-not-call
     * trap, caught here by a mutation rather than by reading.
     */
    const calls = [...s.matchAll(/PlateUploader\.sendTake\(/g)];
    assert.ok(calls.length >= 1,
        'sendTake is declared and nothing calls it — a take uploaded by nothing, which is the '
        + 'silent loss this whole delivery exists to prevent');

    /*
     * And the take REACHES it from the transport. `stopRecording`'s completion
     * is the only moment the file's URL exists; a stop that drops it loses the
     * walk however well the uploader works.
     */
    const transport = extract('struct RecordingTransport');
    assert.match(transport, /stopRecording\s*\{|stopRecording\(/,
        'the transport no longer stops the take');
    assert.match(transport, /onTake/,
        'the transport discards the finished take rather than handing it on, so the URL that '
        + 'exists only in that completion is lost');
    /*
     * The world capture still delivers — through the GENERAL mechanism now.
     * This asserted `onTake: request.forWorld`, which was the destination
     * (a CEILING question) standing in for whether a take is wanted. FCC-014
     * added a second recording surface and separated the two, so the claim is
     * re-derived rather than relaxed: what must hold is that a session which
     * can record hands its take on, and that a world capture is such a session.
     */
    assert.match(code(), /onTake:\s*request\.recordsTakes/,
        'the view does not hand a finished take to the delivery, so a walkthrough is recorded and '
        + 'stays on the phone');
    assert.match(code(), /recordsTakes: Bool \{[^}]*contains\("video"\)/,
        'nothing derives "this session can record" from what the target accepts, so which '
        + 'surfaces deliver a take is decided by a flag somebody remembered to set');
});

test('a delivery that fails NAMES itself and keeps the take', () => {
    /*
     * The rule the still path already follows: losing a photograph because an
     * upload failed makes a director shoot it twice. A walkthrough is worse —
     * they have to walk the room again.
     */
    const s = code();
    const send = swiftFunc('sendTake');
    assert.match(send, /throw|Failure/,
        'sendTake cannot report a failure, so a refused upload is indistinguishable from a '
        + 'delivered one');
    assert.match(s, /result\.failed\[/,
        'nothing records which capture failed to upload');
});

/* ------------------------------------------------------------------ *
 * SET 5 — which ceiling binds is DERIVED, on both sides of the wire   *
 * ------------------------------------------------------------------ */

test('EVERY import target resolves to a destination the policy declares', () => {
    const ids = Object.keys(MEDIA_IMPORTS);
    assert.ok(ids.length >= 18, `only ${ids.length} targets; the registry read is broken`);
    assert.strictEqual(typeof media.captureDestination, 'function',
        'nothing says where a target\'s capture is going, so which ceiling binds it is decided '
        + 'by a string typed into the page');

    const wrong = [];
    for (const id of ids) {
        const d = media.captureDestination(id);
        if (!policy.DESTINATIONS[d]) {
            wrong.push(`${id}: resolves to "${d}", which capture-policy does not declare`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);

    assert.strictEqual(media.captureDestination('world-capture'), 'world',
        'a world capture is not bound to Marble, so its walkthrough is budgeted against the '
        + 'upload and refused after the walk');
    assert.strictEqual(media.captureDestination('character-plate'), 'footage',
        'a plate is bound to World Labs, which it never reaches');
    assert.strictEqual(media.captureDestination('nonsense'), 'footage',
        'an unknown target resolves to the world ceiling, so a typo silently shortens a take');
});

test('the page sends the SAME destination the registry resolves', () => {
    /*
     * The page cannot require a node module (build.target: single-html), so the
     * rule exists twice and the two are held equal over every target — the
     * arrangement body-limit.js and shootsWithCamera already have.
     *
     * ASKED, never read: comparing two literals proves the lists match and says
     * nothing about what the page's own predicate answers, and the predicate is
     * what travels to the camera.
     */
    const at = UI.indexOf('function captureDestination(');
    assert.notStrictEqual(at, -1, 'the page has no destination rule to send');
    let d = 0;
    let end = at;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') d++;
        else if (UI[i] === '}' && --d === 0) { end = i + 1; break; }
    }
    // eslint-disable-next-line no-new-func
    const page = new Function(`${UI.slice(at, end)} return captureDestination;`)();

    const wrong = [];
    for (const id of Object.keys(MEDIA_IMPORTS)) {
        if (page(id) !== media.captureDestination(id)) {
            wrong.push(`${id}: the page says ${page(id)} and the registry says `
                + `${media.captureDestination(id)}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);

    // And it reaches the request, or the camera is told nothing.
    const at2 = UI.indexOf('function shootPlate(');
    assert.notStrictEqual(at2, -1, 'shootPlate is gone');
    const body = UI.slice(at2, UI.indexOf('\n    }', at2));
    assert.match(body, /destination/,
        'the page never tells the camera where the capture is going, so every session budgets '
        + 'against the upload');
});

test('the iOS bundle is re-synced, or the phone runs a page without the change', () => {
    const bundled = fs.readFileSync(path.join(ROOT, 'ios/FilmEngine/Web/index.html'), 'utf8');
    assert.strictEqual(bundled, UI,
        'ios/FilmEngine/Web/index.html has drifted from src/index.html — '
        + '`cp src/index.html ios/FilmEngine/Web/index.html`');
});
