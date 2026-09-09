/**
 * PRORES RECORDING — GRD-3803 / FCC-007.
 *
 * ProRes 422 and 422 HQ through the writer FCC-001 built. The container was
 * chosen `.mov` there for exactly this reason: ProRes cannot be written into
 * an mp4.
 *
 * "IT MUST NOT BE OFFERED WITHOUT FCC-009" IS THE WHOLE CONSTRAINT, and it is
 * the reason FCC-006 built a refusal mechanism before there was anything to
 * refuse. ProRes 422 HQ at 4K30 is 6.8 GiB a minute — 116MB a SECOND against a
 * 100MB ceiling, so it does not fit one frame that can travel. A picker with no
 * way to say that would either offer it, producing takes nothing can carry, or
 * drop it, which is indistinguishable from never having built it. Every ProRes
 * mode therefore travels only by `external`, and is SHOWN refused with the
 * remedy that FCC-009 is what closes it.
 *
 * THE RATES ARE ANCHORED, AND WHERE THEY ARE NOT THEY SAY SO.
 *
 * One figure is pinned by an existing test: the brief states ProRes 422 HQ at
 * 1080p30 as 1.7 GB/min, and `fcc-parity-brief.test.js` recomputes its
 * "3 seconds" headline from it. That is the anchor. The rest are DERIVED and
 * marked `inferred`, on the precedent `provider-pricing.js` already sets in
 * this codebase — a figure that is not published is flagged rather than quietly
 * averaged, because a rate presented as fact is one a later task will trust.
 * 4K is four times the pixels of 1080p at the same rate, which gives 6.8
 * GiB/min and corroborates the epic's own "~7 GB/min at 4K30" independently.
 *
 * SET-BASED OVER TWO REGISTRIES, ONE OF WHICH IS NEW:
 *
 *   1. `CODECS` — what the writer can encode. One before this task, three
 *      after. Every mode must name a declared codec, and every codec must map
 *      to a real AVFoundation type: a mode naming a codec the writer cannot
 *      build is a format that fails at the moment the director presses record.
 *   2. The PRORES MODES — every one must be refused, priced, and shown. A rule
 *      that catches 422 HQ and lets plain 422 through is the half-done fix, and
 *      plain 422 is the more dangerous one because it fits for one second and
 *      therefore looks almost usable.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const { MODES, CODECS, TRANSPORTS, formatChoices, maxSecondsFor } = require('../lib/capture-policy');

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

/** Compile the REAL mode table and read what each format says it is. */
let cached;
function swiftModes() {
    if (cached) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-prores-'));
    const file = path.join(dir, 'main.swift');
    fs.writeFileSync(file, `${extract('struct RecordingMode')}
${extract('enum RecordingBudget')}
for m in RecordingMode.all {
    let t = m.transports.map { $0.rawValue }.joined(separator: ",")
    print("\\(m.id)|\\(m.bytesPerSecond)|\\(m.codec.rawValue)|\\(RecordingBudget.isOffered(m))|\\(t)")
}
`);
    const out = execFileSync('swift', [file], { encoding: 'utf8', timeout: 180000 });
    cached = out.trim().split('\n').map((r) => {
        const [id, bytes, codec, offered, transports] = r.split('|');
        return {
            id,
            bytesPerSecond: +bytes,
            codec,
            offered: offered === 'true',
            transports: transports.split(',').filter(Boolean),
        };
    });
    return cached;
}

/** Every ProRes mode, discovered by its codec rather than by its name. */
const proResIds = () => Object.entries(MODES)
    .filter(([, m]) => /prores/i.test(m.codec || ''))
    .map(([id]) => id);

/* ------------------------------------------------------------------ *
 * SET 1 — the codec registry                                          *
 * ------------------------------------------------------------------ */

test('the codec registry exists and carries both ProRes variants', () => {
    assert.ok(CODECS && typeof CODECS === 'object', 'capture-policy declares no CODECS');
    const ids = Object.keys(CODECS);
    assert.ok(ids.length >= 3,
        `only ${ids.length} codec(s) declared (${ids.join(', ')}). The task names ProRes 422 AND `
        + '422 HQ; shipping one of them is the half-done fix, and it is the plain 422 that gets '
        + 'left out because HQ is the one everybody thinks of');
    const prores = ids.filter((c) => /prores/i.test(c));
    assert.ok(prores.length >= 2, `only ${prores.length} ProRes codec(s): ${prores.join(', ')}`);
});

test('EVERY codec states what it is and how it is written', () => {
    const wrong = [];
    for (const [id, c] of Object.entries(CODECS)) {
        if (!c.label) wrong.push(`${id}: has no label, so a picker cannot name it`);
        if (!c.container) {
            wrong.push(`${id}: names no container. ProRes cannot be written into an mp4, and a `
                + 'writer that discovers that at record time has already lost the take');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY mode names a codec the registry declares', () => {
    const wrong = Object.entries(MODES)
        .filter(([, m]) => !m.codec || !CODECS[m.codec])
        .map(([id, m]) => `${id}: codec "${m.codec || 'none'}" is not declared`);
    assert.deepStrictEqual(wrong, [],
        'a mode naming a codec the writer cannot build is a format that fails at the moment the '
        + `director presses record:\n  ${wrong.join('\n  ')}`);
});

test('EVERY ProRes codec is written into a container that can hold it', () => {
    const wrong = Object.entries(CODECS)
        .filter(([id, c]) => /prores/i.test(id) && c.container !== 'mov')
        .map(([id, c]) => `${id}: container "${c.container}"`);
    assert.deepStrictEqual(wrong, [],
        `ProRes requires QuickTime; an mp4 cannot carry it:\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 2 — every ProRes mode, refused                                  *
 * ------------------------------------------------------------------ */

test('ProRes modes exist at all', () => {
    const ids = proResIds();
    assert.ok(ids.length >= 2,
        `only ${ids.length} ProRes mode(s) in the registry. A codec nothing can select is a codec `
        + 'that was not added');
});

test('EVERY ProRes mode is REFUSED, because FCC-009 has not landed', () => {
    /*
     * The epic's constraint, stated as a rule rather than remembered. Offering
     * any of them produces takes that cannot travel — and plain 422 at 4K30 is
     * the dangerous one, because it fits for a single second and therefore
     * looks almost usable rather than obviously impossible.
     */
    const offered = formatChoices()
        .filter((c) => proResIds().includes(c.id) && c.offered)
        .map((c) => `${c.id} (${c.mb_per_min}MB/min, ${c.max_seconds}s)`);
    assert.deepStrictEqual(offered, [],
        'these ProRes formats are offered while there is nowhere to put the file. The epic says '
        + `ProRes "must not be offered without FCC-009":\n  ${offered.join('\n  ')}`);
});

test('EVERY ProRes refusal names the remedy, rather than just saying no', () => {
    const external = TRANSPORTS.external;
    assert.ok(external && external.remedy, 'the external transport declares no remedy');
    const wrong = formatChoices()
        .filter((c) => proResIds().includes(c.id))
        .filter((c) => !c.refusal || !c.refusal.includes(external.remedy))
        .map((c) => `${c.id}: "${c.refusal || 'no refusal'}"`);
    assert.deepStrictEqual(wrong, [],
        'a director is told ProRes is unavailable and not told that a drive is what fixes it:\n  '
        + wrong.join('\n  '));
});

test('EVERY ProRes mode travels ONLY by external storage', () => {
    const wrong = proResIds()
        .filter((id) => (MODES[id].transports || []).some((t) => t !== 'external'))
        .map((id) => `${id}: also declares ${MODES[id].transports.join(', ')}`);
    assert.deepStrictEqual(wrong, [],
        'a ProRes mode that declares the upload as a transport would be OFFERED the moment the '
        + `upload is available, which is now:\n  ${wrong.join('\n  ')}`);
});

test('EVERY ProRes mode is still SHOWN, not dropped from the list', () => {
    const shown = formatChoices().map((c) => c.id);
    const missing = proResIds().filter((id) => !shown.includes(id));
    assert.deepStrictEqual(missing, [],
        `these are priced and never shown: ${missing.join(', ')}. A format that silently `
        + 'disappears is indistinguishable from one that was never built, and the director never '
        + 'learns a drive would fix it');
});

/* ------------------------------------------------------------------ *
 * SET 3 — the rates, anchored or flagged                              *
 * ------------------------------------------------------------------ */

test('the anchor rate reproduces the figure the brief already pins', () => {
    /*
     * `fcc-parity-brief.test.js` recomputes its "3 seconds" headline from
     * 1.7 GB/min for ProRes 422 HQ at 1080p30. If the registry disagrees with
     * that, two documents state two different costs for the same format and
     * only one of them is what the app would record.
     */
    const anchor = Object.entries(MODES)
        .find(([id, m]) => m.codec === 'prores422hq' && id.startsWith('1080p30'));
    assert.ok(anchor, 'there is no ProRes 422 HQ mode at 1080p30 to anchor the rates to');
    const [id] = anchor;
    assert.strictEqual(maxSecondsFor(id), 3,
        `${id} fits ${maxSecondsFor(id)}s and the brief's pinned headline is 3 seconds. The rate `
        + 'has drifted from the figure another test recomputes');
});

test('EVERY rate that is not published says so', () => {
    /*
     * The `provider-pricing.js` precedent, which CLAUDE.md records: a figure
     * that is not published is FLAGGED rather than quietly averaged. These
     * rates are not load-bearing today — every ProRes mode is refused — but
     * FCC-009 and FCC-011 will trust them, and a derived number presented as
     * fact is one nobody re-checks.
     */
    const wrong = [];
    for (const id of proResIds()) {
        const m = MODES[id];
        if (!m.source) { wrong.push(`${id}: states no source for its rate`); continue; }

        /*
         * BOTH DIRECTIONS, because only one of them was checked at first and a
         * mutation walked straight through the gap: dropping `inferred: true`
         * from a derived rate passed, since the rule only asked that a FLAGGED
         * rate explain itself. A derived figure that has quietly lost its flag
         * is the exact thing `provider-pricing.js` records paying for — an
         * over-reported number wearing the appearance of diligence.
         */
        const saysDerived = /\bderived\b|\bratio\b|times the pixels/i.test(m.source);
        if (m.inferred && !saysDerived) {
            wrong.push(`${id}: is flagged inferred and does not say what it was derived from`);
        }
        if (saysDerived && !m.inferred) {
            wrong.push(`${id}: its source says the rate was DERIVED and it is not flagged `
                + 'inferred, so a later task reads a computed number as a published one');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('exactly one ProRes rate is the anchor, and it is the one another test pins', () => {
    /*
     * The counted form of the rule above. Every derived figure hangs off one
     * measured one; two un-flagged rates means a second figure is being
     * presented as published when nothing publishes it, and zero means the
     * whole table floats.
     */
    const anchored = proResIds().filter((id) => !MODES[id].inferred);
    assert.deepStrictEqual(anchored, ['1080p30-prores422hq'],
        `${anchored.length} ProRes rate(s) claim to be published: ${anchored.join(', ') || 'none'}. `
        + 'Exactly one is — 422 HQ at 1080p30, which the brief states and fcc-parity-brief '
        + 'recomputes its 3-second headline from. Everything else is derived from it');
});

test('at least one ProRes rate is anchored rather than every one inferred', () => {
    const anchored = proResIds().filter((id) => !MODES[id].inferred);
    assert.ok(anchored.length >= 1,
        'every ProRes rate is inferred, so the whole table floats — there is nothing measured for '
        + 'the derivations to hang on');
});

/* ------------------------------------------------------------------ *
 * SET 4 — the writer can actually encode them                         *
 * ------------------------------------------------------------------ */

test('the writer maps EVERY codec to a real AVFoundation type', () => {
    const cam = code();
    const wrong = [];
    for (const id of Object.keys(CODECS)) {
        const swiftCase = id.replace(/[^a-z0-9]/gi, '').toLowerCase();
        const found = new RegExp(`case\\s+\\.?${swiftCase}\\b`, 'i').test(cam)
            || new RegExp(`\\b${swiftCase}\\b`, 'i').test(cam.replace(/[^A-Za-z0-9\s.]/g, ''));
        if (!found) wrong.push(`${id}: the camera knows no such codec`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));

    for (const t of ['AVVideoCodecType.proRes422', 'AVVideoCodecType.proRes422HQ']) {
        assert.ok(cam.includes(t),
            `the writer never asks for ${t}. A ProRes mode that encodes HEVC is a format that `
            + 'lies about what it recorded, and the file plays perfectly');
    }
});

test('the codec is read from the MODE, not hardcoded in the writer', () => {
    const begin = extract('func begin');
    assert.ok(begin, 'the writer has no begin()');
    assert.ok(/mode\.codec/.test(begin),
        'begin() does not consult the mode\'s codec, so choosing ProRes would still write HEVC — '
        + 'a take that says ProRes in its name and is not');
    assert.ok(!/AVVideoCodecKey:\s*AVVideoCodecType\.hevc\b/.test(begin),
        'the codec is still hardwired to HEVC in the writer');
});

test('the container follows the codec, since ProRes cannot live in an mp4', () => {
    const cam = code();
    const begin = extract('func begin');
    assert.ok(/fileType:\s*\.mov|fileType:\s*mode\.|fileType:\s*\w*[Cc]ontainer/.test(begin + cam),
        'the writer names no container that can carry ProRes');
});

/* ------------------------------------------------------------------ *
 * SET 5 — the camera and the budget agree about all of it             *
 * ------------------------------------------------------------------ */

test('EVERY mode agrees with the camera about its rate, codec and refusal', () => {
    const swift = swiftModes();
    assert.deepStrictEqual(swift.map((m) => m.id).sort(), Object.keys(MODES).sort(),
        `the camera records ${swift.map((m) => m.id).join(', ')} and the budget prices `
        + `${Object.keys(MODES).join(', ')}`);

    const wrong = [];
    for (const m of swift) {
        const js = MODES[m.id];
        const choice = formatChoices().find((c) => c.id === m.id);
        if (m.bytesPerSecond !== js.bytes_per_second) {
            wrong.push(`${m.id}: camera records ${m.bytesPerSecond} B/s, budget prices `
                + `${js.bytes_per_second} B/s`);
        }
        if (m.codec !== js.codec) {
            wrong.push(`${m.id}: camera encodes "${m.codec}", budget prices "${js.codec}"`);
        }
        if (m.offered !== choice.offered) {
            wrong.push(`${m.id}: camera ${m.offered ? 'offers' : 'refuses'} it and the picker `
                + `${choice.offered ? 'offers' : 'refuses'} it`);
        }
        const declared = (js.transports || []).join(',');
        if (m.transports.join(',') !== declared) {
            wrong.push(`${m.id}: camera travels by [${m.transports.join(',')}], budget says [${declared}]`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera would record something the budget does not price, or offer something it '
        + `refuses — two answers to "can I shoot this":\n  ${wrong.join('\n  ')}`);
});
