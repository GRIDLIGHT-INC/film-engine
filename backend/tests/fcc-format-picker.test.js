/**
 * A FORMAT PICKER THAT STATES ITS COST — GRD-3802 / FCC-006.
 *
 * FCC-002 built the transport and recorded at `RecordingBudget.recommended`,
 * with a comment saying FCC-006 would make it a choice. There is still no
 * choice: four formats exist and a director can reach one of them.
 *
 * THE COST IS THE POINT, NOT THE LIST. A picker that offers "4K60" and "4K30
 * Apple Log" as two equal-looking buttons hides the only fact that separates
 * them — 14 seconds against 30, on the same phone, for the same ceiling. Every
 * choice has to carry its own price: what it costs a minute, how long a take
 * may be, and how the file will leave the phone.
 *
 * AND A FORMAT WHOSE TRANSPORT IS ABSENT IS REFUSED WITH THE REMEDY. That
 * sentence is in the task because of FCC-007: ProRes is roughly seven
 * gigabytes a minute, which is under a second of the 100MB ceiling, and the
 * epic says it "must not be offered without FCC-009". A picker with no way to
 * express that would either offer ProRes and produce files nothing can carry,
 * or drop it from the list — and a format that silently disappears is
 * indistinguishable from one that was never built. So a refused format is
 * SHOWN, with the reason and what would close it.
 *
 * SET-BASED OVER TWO REGISTRIES, BOTH DERIVED FROM CODE:
 *
 *   1. `MODES` — 4 formats. Every one must state its own cost. A picker that
 *      prices three and leaves the fourth blank looks complete, and the blank
 *      one is exactly where a director gets caught: the most expensive format
 *      is the one whose number they most needed.
 *   2. `TRANSPORTS` — the ways footage can leave the phone. Every one declares
 *      whether it is available, and an unavailable one declares the REMEDY.
 *      A refusal with no remedy is a dead end; the whole value of refusing is
 *      telling the director what would make it work.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const policy = require('../lib/capture-policy');
const { MODES, TRANSPORTS, formatChoices, maxSecondsFor } = policy;

const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use. */
const code = () => src().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH, skipping the signature's own braces. */
function extract(header, from) {
    const s = from || src();
    const at = s.indexOf(header);
    if (at === -1) return null;
    const paren = s.indexOf('(', at);
    const brace = s.indexOf('{', at);
    let open;
    if (paren !== -1 && (brace === -1 || paren < brace)) {
        let p = 0, j = paren;
        for (; j < s.length; j++) {
            if (s[j] === '(') p++;
            else if (s[j] === ')' && --p === 0) break;
        }
        open = s.indexOf('{', j);
    } else {
        open = brace;
    }
    let depth = 0, i = open;
    for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) break;
    }
    return s.slice(at, i + 1);
}

/** Compile the REAL mode table out of the app and read its transports. */
let cached;
function swiftModes() {
    if (cached) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-picker-'));
    const file = path.join(dir, 'main.swift');
    /*
     * BOTH declarations. `RecordingMode` states what a format IS; whether it
     * FITS is `RecordingBudget`'s question, because it depends on the ceiling —
     * which is not a property of the format. Compiling only the first one is
     * what caught that layering being the wrong way round.
     */
    fs.writeFileSync(file, `${extract('struct RecordingMode')}
${extract('enum RecordingBudget')}
for t in RecordingMode.Transport.allCases {
    print("TRANSPORT|\\(t.rawValue)|\\(t.isAvailable)")
}
for m in RecordingMode.all {
    let t = m.transports.map { "\\($0.rawValue):\\($0.isAvailable)" }.joined(separator: ",")
    print("MODE|\\(m.id)|\\(m.megabytesPerMinute)|\\(RecordingBudget.isOffered(m))|\\(t)")
}
`);
    const out = execFileSync('swift', [file], { encoding: 'utf8', timeout: 180000 });
    const lines = out.trim().split('\n');
    cached = {
        transports: lines.filter((l) => l.startsWith('TRANSPORT|')).map((l) => {
            const [, name, available] = l.split('|');
            return { name, available: available === 'true' };
        }),
        modes: lines.filter((l) => l.startsWith('MODE|')).map((l) => {
            const [, id, mb, offered, transports] = l.split('|');
            return {
                id,
                megabytesPerMinute: +mb,
                offered: offered === 'true',
                transports: transports.split(',').filter(Boolean).map((t) => {
                    const [name, available] = t.split(':');
                    return { name, available: available === 'true' };
                }),
            };
        }),
    };
    return cached;
}

/* ------------------------------------------------------------------ *
 * SET 1 — the transports, and what a refusal owes the director        *
 * ------------------------------------------------------------------ */

test('the transport registry exists and covers more than one way out', () => {
    assert.ok(TRANSPORTS && typeof TRANSPORTS === 'object', 'capture-policy declares no TRANSPORTS');
    const ids = Object.keys(TRANSPORTS);
    assert.ok(ids.length >= 2,
        `only ${ids.length} transport(s) declared. A refusal mechanism needs at least one absent `
        + 'transport to refuse against, or "refused with the remedy" is a rule nothing can ever '
        + 'exercise and the first format that needs it ships offered');
});

test('EVERY transport says whether it is available, and an absent one names the remedy', () => {
    const wrong = [];
    for (const [id, t] of Object.entries(TRANSPORTS)) {
        if (typeof t.available !== 'boolean') {
            wrong.push(`${id}: does not say whether it is available`);
            continue;
        }
        if (!t.label) wrong.push(`${id}: has no label, so a picker cannot say how a file travels`);
        if (t.available) continue;
        if (!t.remedy || t.remedy.length < 30) {
            wrong.push(`${id}: is unavailable and gives no real remedy — a refusal with no way `
                + 'forward is a dead end, and the whole value of refusing is saying what would work');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('at least one transport is available, or nothing can be recorded at all', () => {
    const live = Object.entries(TRANSPORTS).filter(([, t]) => t.available);
    assert.ok(live.length >= 1,
        'no transport is available, so every format would be refused. That is not a picker, it is '
        + 'a camera that cannot be used');
});

/* ------------------------------------------------------------------ *
 * SET 2 — every format states its own cost                            *
 * ------------------------------------------------------------------ */

test('EVERY mode appears in the picker exactly once', () => {
    assert.ok(typeof formatChoices === 'function', 'capture-policy exports no formatChoices()');
    const choices = formatChoices();
    const ids = choices.map((c) => c.id).sort();
    assert.deepStrictEqual(ids, Object.keys(MODES).sort(),
        `the picker offers ${ids.join(', ')} and the budget prices ${Object.keys(MODES).join(', ')}. `
        + 'A format the picker cannot show is one a director cannot choose; a format it shows and '
        + 'the budget does not price has no cost to state');
});

test('EVERY choice states what it costs a minute, and the number is real', () => {
    const wrong = [];
    for (const c of formatChoices()) {
        const expected = Math.round(MODES[c.id].bytes_per_second * 60 / 1048576);
        if (typeof c.mb_per_min !== 'number') {
            wrong.push(`${c.id}: states no MB/min — the fact the task exists to show`);
        } else if (c.mb_per_min !== expected) {
            wrong.push(`${c.id}: states ${c.mb_per_min} MB/min and costs ${expected}`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY choice states how long a take may be, agreeing with the budget', () => {
    const wrong = [];
    for (const c of formatChoices()) {
        const expected = maxSecondsFor(c.id);
        if (c.max_seconds !== expected) {
            wrong.push(`${c.id}: the picker says ${c.max_seconds}s and the budget allows ${expected}s`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the picker and the transport would show a director two different durations for the same '
        + `format, and only one of them binds:\n  ${wrong.join('\n  ')}`);
});

test('EVERY choice names how the file will travel, or why it cannot', () => {
    const wrong = [];
    for (const c of formatChoices()) {
        if (c.offered) {
            if (!c.transport) { wrong.push(`${c.id}: is offered and names no transport`); continue; }
            if (!TRANSPORTS[c.transport]) {
                wrong.push(`${c.id}: travels by "${c.transport}", which is not a declared transport`);
            } else if (!TRANSPORTS[c.transport].available) {
                wrong.push(`${c.id}: is offered on "${c.transport}", which is not available`);
            }
        } else if (!c.refusal || c.refusal.length < 30) {
            wrong.push(`${c.id}: is refused and says nothing useful about why — a format that `
                + 'silently disappears is indistinguishable from one that was never built');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

/* ------------------------------------------------------------------ *
 * SET 3 — the refusal, which is what FCC-007 will rest on             *
 * ------------------------------------------------------------------ */

test('a format whose only transport is absent is REFUSED, with the remedy carried through', () => {
    /*
     * Built now because FCC-007 depends on it. ProRes is ~7GB/min — under a
     * second of the 100MB ceiling — and the epic says it must not be offered
     * without FCC-009. Without this mechanism the only options are offering it
     * (files nothing can carry) or hiding it (indistinguishable from unbuilt).
     */
    const absent = Object.entries(TRANSPORTS).find(([, t]) => !t.available);
    assert.ok(absent, 'no absent transport exists, so the refusal path cannot be exercised');
    const [id, transport] = absent;

    const probe = formatChoices([{
        id: 'probe-format', label: 'a probe', bytes_per_second: 1024 * 1024,
        color_space: 'rec709', transports: [id],
    }]).find((c) => c.id === 'probe-format');

    assert.ok(probe, 'formatChoices() cannot be asked about a format outside the registry, so the '
        + 'refusal rule can only be tested by adding one — which is how a probe becomes a shipped mode');
    assert.strictEqual(probe.offered, false,
        `a format that can only travel by "${id}" is offered while that transport is absent`);
    assert.ok(probe.refusal && probe.refusal.includes(transport.remedy),
        'the refusal does not carry the transport\'s remedy, so a director is told no and not told '
        + 'what would make it yes');
});

test('a format that does not fit even one second is refused, whatever its transport', () => {
    /*
     * The arithmetic floor, and it is a different rule from the one above. A
     * transport can be perfectly available and still be far too small: at
     * ~7GB/min ProRes is 117MB a second against a 100MB ceiling, so "offered
     * with 0 seconds" would be a button that cannot produce a single usable
     * frame.
     */
    const live = Object.entries(TRANSPORTS).find(([, t]) => t.available)[0];
    const huge = formatChoices([{
        id: 'too-big', label: 'far too big', bytes_per_second: 1024 * 1024 * 1024,
        color_space: 'rec709', transports: [live],
    }]).find((c) => c.id === 'too-big');

    assert.strictEqual(huge.max_seconds, 0, 'a gigabyte a second should fit for no seconds');
    assert.strictEqual(huge.offered, false,
        'a format that fits for zero seconds is offered. That is a button which cannot produce a '
        + 'single frame that travels');
    assert.ok(huge.refusal && huge.refusal.length >= 30, 'refused with no reason');
});

test('every format that IS offered fits for at least one second', () => {
    const wrong = formatChoices().filter((c) => c.offered && c.max_seconds < 1)
        .map((c) => `${c.id}: offered and fits ${c.max_seconds}s`);
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

/* ------------------------------------------------------------------ *
 * SET 4 — the camera agrees, and the choice actually reaches a take   *
 * ------------------------------------------------------------------ */

test('the camera and the budget agree about EVERY declared transport', () => {
    /*
     * THE WHOLE REGISTRY, not only the transports some mode happens to
     * reference. A mutation making the camera believe `external` is available
     * survived the per-mode check, because every shipped mode declares
     * `upload` — so the one transport whose absence FCC-007 depends on was
     * never compared. That is the shape of vacuous check this file exists to
     * refuse, and it was found by mutating rather than by reading.
     */
    const swift = swiftModes().transports;
    assert.ok(swift.length >= 2,
        `the camera enumerates ${swift.length} transport(s); the probe is broken`);

    const wrong = [];
    for (const t of swift) {
        const js = TRANSPORTS[t.name];
        if (!js) { wrong.push(`the camera knows transport "${t.name}" and the budget does not`); continue; }
        if (t.available !== js.available) {
            wrong.push(`"${t.name}": the camera says ${t.available ? 'available' : 'absent'} and `
                + `the budget says ${js.available ? 'available' : 'absent'}`);
        }
    }
    for (const name of Object.keys(TRANSPORTS)) {
        if (!swift.some((t) => t.name === name)) {
            wrong.push(`the budget knows transport "${name}" and the camera does not`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera would offer a format the upload refuses, or refuse one it accepts. FCC-007 '
        + `rests on both agreeing that external storage is absent:\n  ${wrong.join('\n  ')}`);
});

test('the camera and the budget agree about every format and its transports', () => {
    const wrong = [];
    for (const m of swiftModes().modes) {
        const js = formatChoices().find((c) => c.id === m.id);
        if (!js) { wrong.push(`${m.id}: the camera records it and the picker cannot show it`); continue; }
        if (m.megabytesPerMinute !== js.mb_per_min) {
            wrong.push(`${m.id}: camera says ${m.megabytesPerMinute} MB/min, picker says ${js.mb_per_min}`);
        }
        if (m.offered !== js.offered) {
            wrong.push(`${m.id}: camera ${m.offered ? 'offers' : 'refuses'} it and the picker `
                + `${js.offered ? 'offers' : 'refuses'} it`);
        }
        for (const t of m.transports) {
            const declared = TRANSPORTS[t.name];
            if (!declared) { wrong.push(`${m.id}: camera names transport "${t.name}", undeclared`); continue; }
            if (t.available !== declared.available) {
                wrong.push(`${m.id}: camera thinks "${t.name}" is `
                    + `${t.available ? 'available' : 'absent'} and the budget disagrees`);
            }
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera would let a director choose something the budget refuses, or refuse something '
        + `it prices. Two answers to "can I shoot this":\n  ${wrong.join('\n  ')}`);
});

test('the picker is DERIVED from the registry, not a list somebody typed', () => {
    const cam = code();
    assert.ok(/ForEach\(RecordingMode\.all|RecordingMode\.all\.filter|ForEach\(offered/.test(cam),
        'the picker does not iterate RecordingMode.all. A typed list is only as complete as the '
        + 'afternoon it was written, and the format added next is the one nobody can reach');
    /*
     * SCOPED TO THE VIEW. The first version scanned the whole file and reported
     * `RecordingMode.all` — the registry the picker is supposed to be derived
     * FROM — as a hardcoded list. A check that flags the correct implementation
     * is one that gets switched off.
     */
    const view = extract('struct FormatPicker') || '';
    assert.ok(view, 'there is no FormatPicker');
    const typed = [...view.matchAll(/"(\d+(?:p|k)\d+(?:-\w+)?)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(typed, [],
        `the picker names formats itself: ${typed.join(', ')}. A typed list is only as complete `
        + 'as the afternoon it was written, and the format added next is the one nobody can reach');
});

test('choosing a format reaches the take, rather than the recommended one', () => {
    /*
     * FCC-002 recorded at RecordingBudget.recommended and said FCC-006 would
     * make it a choice. A picker whose selection does not reach startRecording
     * is a control that changes a label and nothing else — the shape this
     * codebase calls "a button wired to nothing".
     */
    const cam = code();
    assert.ok(/@Published[^\n]*var selectedMode|var selectedMode/.test(cam),
        'nothing on the model holds the chosen format, so a selection has nowhere to live');
    assert.ok(!/RecordingTransport\(camera:\s*camera,\s*mode:\s*RecordingBudget\.recommended\)/.test(cam),
        'the transport is still hardwired to RecordingBudget.recommended, so whatever the picker '
        + 'shows, every take records the same format');
});

test('a refused format is SHOWN with its reason, not quietly missing', () => {
    const view = extract('struct RecordingTransport') || '';
    const cam = code();
    assert.ok(/isOffered|refusal|refused/i.test(view + cam),
        'nothing distinguishes a refused format from an offered one on the surface. Dropping it '
        + 'from the list is the failure: a format that silently disappears looks exactly like one '
        + 'that was never built, and the director never learns a drive would fix it');
});
