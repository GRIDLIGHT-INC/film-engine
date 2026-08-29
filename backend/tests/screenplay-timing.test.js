/**
 * Three numbers that are not each other.
 *
 * A production measures a scene three separate ways and this codebase had
 * none of them:
 *
 *   page_eighths  — how much printed page the scene occupies. Objective.
 *   screen_time   — how long the finished scene plays. An estimate.
 *   shoot_effort  — how hard it is to film. Independent of both.
 *
 * The whole value is in keeping them apart. `one page ≈ one minute` is a rule
 * of thumb that works across a whole screenplay and is badly wrong for a single
 * scene: "The armies collide." is 1/8 of a page and two minutes of film, and a
 * dense page of rapid dialogue plays in well under a minute. A tool that
 * multiplies eighths by 7.5 seconds and calls the answer a runtime is confidently
 * wrong exactly where it matters — and confidently wrong is worse than absent,
 * because a schedule gets built on it.
 *
 * So the estimator returns a RANGE with a confidence, and says which of the two
 * methods disagreed and why. Set-based over the ambiguous-duration phrases and
 * over the action classes, because the failure is per-class: an estimator that
 * handles dialogue and treats every action line as three seconds passes any test
 * written about dialogue.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../lib/screenplay-timing');
const { LINES_PER_PAGE } = require('../lib/screenplay-pagination');

/* ── page eighths ──────────────────────────────────────────────────────── */

test('an eighth is an eighth of a page, and is never zero', () => {
    // A scene smaller than one eighth is rounded UP: productions record 1/8 as
    // the floor, because a scene that occupies no page still gets a strip.
    assert.equal(T.eighthsFromLines(0), 1, 'a scene must never measure zero eighths');
    assert.equal(T.eighthsFromLines(1), 1);
    assert.equal(T.eighthsFromLines(LINES_PER_PAGE), 8, 'a full page is 8/8');
    assert.equal(T.eighthsFromLines(LINES_PER_PAGE * 2), 16, 'two pages is 16/8');
});

test('eighths are written the way a stripboard writes them', () => {
    // Productions keep the denominator: 4/8 not 1/2, 6/8 not 3/4, so that
    // scene totals and day totals add consistently down a column.
    assert.equal(T.formatEighths(1), '1/8');
    assert.equal(T.formatEighths(4), '4/8', 'simplified to 1/2 — a stripboard does not');
    assert.equal(T.formatEighths(6), '6/8', 'simplified to 3/4');
    assert.equal(T.formatEighths(8), '1');
    assert.equal(T.formatEighths(11), '1 3/8');
    assert.equal(T.formatEighths(12), '1 4/8', 'simplified to 1 1/2');
    assert.equal(T.formatEighths(16), '2');
});

/* ── screen time ───────────────────────────────────────────────────────── */

test('dialogue is timed from words at a stated rate, not from page space', () => {
    const rates = T.DELIVERY_RATES;
    assert.ok(Object.keys(rates).length >= 3, 'no delivery rates declared');
    for (const [name, wpm] of Object.entries(rates)) {
        assert.ok(wpm >= 80 && wpm <= 220, `${name}: ${wpm} wpm is not a human speaking rate`);
    }
    // 130 words at 130wpm is a minute, by construction.
    const secs = T.dialogueSeconds(130, 130);
    assert.ok(Math.abs(secs - 60) < 1, `130 words at 130wpm should be ~60s, got ${secs}`);
});

test('every action class carries its own duration behaviour', () => {
    // Set-based: an estimator that gets `atomic` right and treats a fight as
    // three seconds is wrong precisely where the page rule already fails.
    const classes = T.ACTION_CLASSES;
    assert.ok(Object.keys(classes).length >= 6, 'too few action classes to be useful');
    for (const [name, spec] of Object.entries(classes)) {
        assert.ok(spec.likely_seconds > 0, `${name}: no likely duration`);
        assert.ok(spec.min_seconds <= spec.likely_seconds && spec.likely_seconds <= spec.max_seconds,
            `${name}: min/likely/max are not ordered`);
        assert.ok(typeof spec.why === 'string' && spec.why.length > 10,
            `${name}: no reason — a duration with no reason is a magic number`);
    }
    // The spread must actually differ by class, or classifying buys nothing.
    const spreads = Object.values(classes).map(s => s.max_seconds - s.min_seconds);
    assert.ok(new Set(spreads).size > 1, 'every action class has the same uncertainty');
});

test('an action line is classified by what it describes', () => {
    const cases = [
        ['John opens the door.', 'atomic'],
        ['They fight.', 'fight'],
        ['A montage shows the city waking up.', 'montage'],
        ['Maya performs the entire song.', 'performance'],
        ['She searches everywhere.', 'sustained'],
        ['Time passes.', 'time_passage'],
    ];
    for (const [line, expected] of cases) {
        assert.equal(T.classifyAction(line).class, expected,
            `"${line}" should classify as ${expected}`);
    }
});

test('an ambiguous duration is flagged, with the phrase quoted', () => {
    // Not bad writing — it simply makes the estimate unreliable, and a director
    // reading "low confidence" needs to know WHICH line caused it.
    for (const phrase of T.AMBIGUOUS_PHRASES) {
        const line = `Then ${phrase} and the scene ends.`;
        const found = T.ambiguousDurations(line);
        assert.ok(found.length >= 1, `'${phrase}' was not flagged`);
        assert.ok(found[0].phrase.toLowerCase().includes(phrase.split(' ')[0].toLowerCase()),
            `the flag does not quote the phrase it fired on`);
    }
    assert.deepEqual(T.ambiguousDurations('John opens the door and sits down.'), [],
        'ordinary action was flagged as ambiguous');
});

/* ── the two estimates, kept apart ─────────────────────────────────────── */

test('a short action line can outrun its page count, and the tool says so', () => {
    // "The armies collide." — 1/8 of a page, minutes of film. This is the case
    // the page-per-minute rule gets wrong, and the reason the two numbers are
    // reported separately rather than reconciled into one.
    const scene = T.estimateScene({
        heading: 'EXT. BATTLEFIELD - DAY',
        blocks: [{ type: 'action', text: 'The armies collide.' }],
    });
    assert.ok(scene.page_eighths <= 2, 'the fixture is not a short scene');
    assert.ok(scene.screen_time.likely_seconds > scene.page_baseline_seconds,
        'a battle was estimated at its page length');
    assert.ok(scene.disagreement,
        'the two estimates diverge and nothing said so');
    assert.equal(scene.screen_time.confidence, 'low',
        'an unspecified battle is not a confident estimate');
});

test('an ordinary dialogue scene agrees with the page rule, and says it is confident', () => {
    const blocks = [];
    for (let i = 0; i < 8; i++) {
        blocks.push({ type: 'character', text: i % 2 ? 'MAYA' : 'RAY' });
        blocks.push({ type: 'dialogue', text: 'We should have left before the rain started, and you know it.' });
    }
    const scene = T.estimateScene({ heading: 'INT. KITCHEN - NIGHT', blocks });
    assert.ok(!scene.disagreement,
        'ordinary dialogue was reported as disagreeing with its page count');
    assert.notEqual(scene.screen_time.confidence, 'low');
    const ratio = scene.screen_time.likely_seconds / scene.page_baseline_seconds;
    assert.ok(ratio > 0.5 && ratio < 2,
        `dialogue estimate is ${ratio.toFixed(2)}x its page baseline — the page rule should roughly hold here`);
});

test('the range is ordered and the confidence is one of the declared ones', () => {
    const scene = T.estimateScene({
        heading: 'INT. ROOM - DAY',
        blocks: [{ type: 'action', text: 'She waits.' }],
    });
    const st = scene.screen_time;
    assert.ok(st.minimum_seconds <= st.likely_seconds && st.likely_seconds <= st.maximum_seconds,
        'the estimate range is not ordered');
    assert.ok(T.CONFIDENCE.includes(st.confidence), `unknown confidence '${st.confidence}'`);
});

/* ── shooting effort, which is not duration ────────────────────────────── */

test('shoot effort is independent of screen time', () => {
    // "The bridge explodes." is 1/8 of a page and can eat a shooting day. A
    // schedule built from page count alone budgets it like a doorway.
    const bridge = T.estimateScene({
        heading: 'EXT. BRIDGE - NIGHT',
        blocks: [{ type: 'action', text: 'The bridge explodes as the car leaps the gap.' }],
    });
    const talk = T.estimateScene({
        heading: 'INT. KITCHEN - DAY',
        blocks: Array.from({ length: 20 }, () => ({ type: 'dialogue', text: 'A long ordinary line of talk between two people.' })),
    });
    assert.ok(bridge.production.effort_score > talk.production.effort_score,
        'an exploding bridge scored no harder to shoot than a conversation');
    assert.ok(bridge.page_eighths < talk.page_eighths,
        'the fixture does not demonstrate the point: the bridge should be shorter on the page');
    assert.ok(bridge.production.reasons.length >= 2,
        'effort was scored with no reasons given');
    for (const r of bridge.production.reasons) {
        assert.ok(typeof r === 'string' && r.length > 3, 'a reason must be readable');
    }
});

test('every complexity factor can actually fire, and names itself', () => {
    // Set-based over the declared factors: one that no line can ever trigger is
    // a factor that looks like coverage and provides none.
    for (const [name, spec] of Object.entries(T.COMPLEXITY_FACTORS)) {
        assert.ok(spec.weight > 0, `${name}: zero weight — it can never change a score`);
        assert.ok(spec.label, `${name}: no label to show a director`);
        const probe = T.estimateScene({ heading: spec.probe_heading || 'INT. ROOM - DAY',
            blocks: [{ type: 'action', text: spec.probe }] });
        assert.ok(probe.production.reasons.includes(spec.label),
            `${name}: its own probe text '${spec.probe}' did not trigger it`);
    }
});

/* ── the whole screenplay ──────────────────────────────────────────────── */

test('a screenplay totals its scenes, and reports both runtimes', () => {
    const report = T.estimateScreenplay([
        { heading: 'INT. A - DAY', blocks: [{ type: 'dialogue', text: 'Hello there my friend.' }] },
        { heading: 'EXT. B - NIGHT', blocks: [{ type: 'action', text: 'They fight.' }] },
    ]);
    assert.equal(report.scenes.length, 2);
    assert.equal(report.total_eighths,
        report.scenes.reduce((n, s) => n + s.page_eighths, 0),
        'the total is not the sum of its scenes');
    assert.ok(report.page_runtime_seconds > 0 && report.likely_runtime_seconds > 0);
    assert.ok(report.pages > 0, 'no page count');
    // Both numbers, never one blended one: they answer different questions and
    // a single figure hides which method produced it.
    assert.notEqual(report.page_runtime_seconds, undefined);
    assert.notEqual(report.likely_runtime_seconds, undefined);
});

/* ── the two spellings ─────────────────────────────────────────────────── */

test('the stored spelling and the editor spelling measure the same', () => {
    /*
     * The editor writes `scene-heading` and film_script_elements stores
     * `scene_heading`. Both are in the build. Nothing noticed, because
     * pagination only ever ran on the editor's DOM — until this module started
     * measuring screenplays out of the DATABASE, where every heading fell
     * through to the default and was billed as a paragraph of action.
     *
     * Set-based over the real stored vocabulary rather than over the one case
     * that bit: `dual_dialogue` and `page_break` have the same shape.
     */
    const { elementLines, ELEMENT_TYPES } = require('../lib/screenplay-pagination');
    for (const hyphen of ELEMENT_TYPES) {
        const underscore = hyphen.replace(/-/g, '_');
        assert.equal(elementLines(underscore, 120), elementLines(hyphen, 120),
            `'${underscore}' and '${hyphen}' measure differently — one of them is falling to the default`);
    }
    // And the scene estimator must handle a stored screenplay, which is the
    // form it will actually be given.
    const stored = T.estimateScene({
        heading: 'INT. KITCHEN - DAY',
        blocks: [{ type: 'scene_heading', text: 'INT. KITCHEN - DAY' },
                 { type: 'dialogue', text: 'Hello there.' }],
    });
    assert.ok(stored.page_eighths >= 1);
});
