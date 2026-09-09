/**
 * THE BUDGET KNOWS EVERY FORMAT AND TRANSPORT — GRD-3807 / FCC-011.
 *
 * "The number a director sees must be the number that binds."
 *
 * IT IS NOT, AND THE GAP IS A THIRD OF THE TAKE. `bindingBytes()` takes a blind
 * minimum across all three ceilings, and the smallest is World Labs' 100MB cap
 * on a video handed to Marble. So a shot recorded for the CUT — which never
 * goes near Marble — is priced against Marble's cap:
 *
 *     4K60      14s shown      22s actually fit
 *     4K30      44s            66s
 *     1080p30  133s           200s
 *     4K30 Log  30s            45s
 *
 * A director is told to stop eight seconds early on every 4K60 take, by a limit
 * belonging to a service the footage will never reach. The brief already said so
 * in words — "for a plain shot video the binding number is 113 MB" — and the
 * code went on applying 100.
 *
 * A CEILING IS NOT A PROPERTY OF THE ENGINE, IT IS A PROPERTY OF A ROUTE. Three
 * numbers sit in `CEILINGS` and they answer three different questions: how big a
 * body this server accepts, how big that body is once base64-inflated, and what
 * Marble will take. The first two are about a TRANSPORT; the third is about a
 * DESTINATION, and it binds only when the destination is Marble. Taking a blind
 * minimum treats them as interchangeable, which is exactly how a world capture's
 * cap came to shorten every take in the film.
 *
 * TWO OF THE THREE HAVE ALREADY MOVED UNDER IT. FCC-009 made an external
 * transfer price against the drive's free space rather than any of these, and
 * FCC-010 made media travel RAW — so `transport_base64` is no longer the number
 * a director experiences on the path it was written for. A ceiling that is
 * quietly no longer the binding one is worse than a wrong number: it is a right
 * number applied to the wrong thing.
 *
 * SET-BASED OVER TWO REGISTRIES:
 *
 *   1. `CEILINGS` — three. Every one must say what it APPLIES TO. A ceiling
 *      that declares nothing is a ceiling that applies to everything, which is
 *      the blind minimum this task exists to remove.
 *   2. `TRANSPORTS` — two. Every one must resolve to its own ceiling, and the
 *      duration every mode reports must come from the transport it will
 *      actually travel by. Getting `upload` right and leaving `external` on the
 *      old number would re-break what FCC-009 just fixed.
 */

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../lib/capture-policy');
const { CEILINGS, TRANSPORTS, MODES, formatChoices, maxSecondsFor } = policy;
const { FILE_LIMIT } = require('../lib/body-limit');

/* ------------------------------------------------------------------ *
 * SET 1 — every ceiling says what it binds                            *
 * ------------------------------------------------------------------ */

test('EVERY ceiling declares what it applies to, rather than applying to everything', () => {
    const ids = Object.keys(CEILINGS);
    assert.ok(ids.length >= 3, `only ${ids.length} ceilings; the registry read is broken`);

    const wrong = [];
    for (const [id, c] of Object.entries(CEILINGS)) {
        const scope = c.applies_to;
        if (!scope || typeof scope !== 'object') {
            wrong.push(`${id}: says nothing about what it binds, so a blind minimum applies it to `
                + 'everything — which is how Marble\'s cap came to shorten every take in the film');
            continue;
        }
        if (!Array.isArray(scope.transports) && !Array.isArray(scope.destinations)) {
            wrong.push(`${id}: names neither a transport nor a destination`);
        }
        if (!c.source || c.source.length < 15) wrong.push(`${id}: does not say where its number comes from`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('the Marble cap is a DESTINATION, not a transport', () => {
    /*
     * The whole misattribution in one assertion. Marble's limit is a fact about
     * what World Labs accepts, and it binds a capture handed to World Labs —
     * not a shot that goes into the cut.
     */
    const marble = CEILINGS.marble_video;
    assert.ok(marble, 'the Marble ceiling is gone');
    assert.ok(Array.isArray(marble.applies_to && marble.applies_to.destinations)
        && marble.applies_to.destinations.includes('world'),
        'the Marble cap does not declare itself a destination limit, so it goes on binding '
        + 'footage that never reaches World Labs');
    assert.ok(!(marble.applies_to.transports || []).length,
        'the Marble cap claims to bind a transport. It is not a pipe — a world capture and a shot '
        + 'video travel the same way and only one of them is capped by World Labs');
});

test('a ceiling resolves only when it actually applies', () => {
    assert.strictEqual(typeof policy.bindingBytesFor, 'function',
        'nothing resolves a ceiling for a given route; the blind minimum is still the only answer');

    const footage = policy.bindingBytesFor({ transport: 'upload', destination: 'footage' });
    const world = policy.bindingBytesFor({ transport: 'upload', destination: 'world' });

    assert.strictEqual(world, CEILINGS.marble_video.bytes,
        `a world capture is bound by ${world} bytes and Marble accepts `
        + `${CEILINGS.marble_video.bytes}. That cap must still bind the thing it is about`);
    assert.ok(footage > world,
        `footage is bound by ${footage} bytes and a world capture by ${world}. If they are the `
        + 'same, Marble\'s cap is still being applied to shots that never go there');
    assert.strictEqual(footage, FILE_LIMIT,
        `footage over the upload transport is bound by ${footage} and the body this engine `
        + `accepts is ${FILE_LIMIT}. Since FCC-010 media travels RAW, so the base64 ceiling is no `
        + 'longer the number a director experiences on this path');
});

/* ------------------------------------------------------------------ *
 * SET 2 — every transport carries its own ceiling                     *
 * ------------------------------------------------------------------ */

test('EVERY transport resolves to a ceiling of its own', () => {
    const wrong = [];
    for (const [id, t] of Object.entries(TRANSPORTS)) {
        if (t.device_reported) {
            /*
             * A drive's ceiling is what the drive reports, which is why FCC-009
             * had to move it off the body limit. It has no static number and
             * must say so rather than silently inheriting one.
             */
            if (!t.ceiling_is) wrong.push(`${id}: reports its availability from the device and does `
                + 'not say where its ceiling comes from');
            continue;
        }
        const bytes = policy.bindingBytesFor({ transport: id, destination: 'footage' });
        if (!Number.isFinite(bytes) || bytes <= 0) {
            wrong.push(`${id}: resolves to no ceiling, so a duration cannot be computed for it`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY mode is priced against the transport it will actually travel by', () => {
    /*
     * The set-based form of the headline defect. A rule that fixes 4K60 and
     * leaves 1080p30 on the old ceiling is the half-done fix, and 1080p30 is
     * the recommended mode — the one most takes are shot on.
     */
    const wrong = [];
    for (const [id, m] of Object.entries(MODES)) {
        const transport = (m.transports || [])[0];
        if (!transport || !TRANSPORTS[transport] || TRANSPORTS[transport].device_reported) continue;
        const expected = Math.floor(
            policy.bindingBytesFor({ transport, destination: 'footage' }) / m.bytes_per_second);
        const got = maxSecondsFor(id);
        if (got !== expected) {
            wrong.push(`${id}: reports ${got}s and ${expected}s fit on ${transport}`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'a director is told to stop before the take has to end, by a limit belonging to something '
        + `the footage never reaches:\n  ${wrong.join('\n  ')}`);
});

test('the footage durations really did move — this is not a no-op', () => {
    /*
     * Pinned as NUMBERS because the whole task is that a number changed. If
     * these still read 133/44/14 the ceilings were reorganised and nothing a
     * director sees is different.
     */
    const got = ['1080p30', '4k30', '4k60'].map((m) => maxSecondsFor(m));
    assert.deepStrictEqual(got, [200, 66, 22],
        `footage now fits ${got.join('/')}s. Against Marble's cap it was 133/44/14 — the eight `
        + 'seconds of every 4K60 take that were being thrown away by a limit belonging to a '
        + 'service the shot never reaches');
});

test('a world capture is STILL held to Marble, which is what that cap is for', () => {
    /*
     * The other half, and the one it would be easy to break while fixing the
     * first. Both production callers of checkCapture are world-capture paths;
     * loosening them would send a clip to World Labs that it then refuses,
     * which is a paid round trip to learn something knowable here.
     */
    const over = CEILINGS.marble_video.bytes + 1;
    const verdict = policy.checkCapture({ kind: 'video', bytes: over });
    assert.strictEqual(verdict.ok, false, 'a clip over the Marble cap was accepted');
    assert.match(verdict.why, /100 ?MB|Marble/i, 'the refusal does not name the ceiling it hit');

    const world = policy.bindingBytesFor({ transport: 'upload', destination: 'world' });
    assert.strictEqual(world, CEILINGS.marble_video.bytes,
        'a world capture is no longer held to Marble, so it will be refused by World Labs after '
        + 'the upload rather than before it');
});

test('an external transfer is still priced against the DRIVE, not any body ceiling', () => {
    // What FCC-009 built, which this task must not undo while moving the rest.
    const terabyte = 1024 ** 4;
    const drive = { transports: ['upload', 'external'], external_free_bytes: terabyte };
    const external = Object.entries(MODES)
        .filter(([, m]) => (m.transports || []).every((t) => t === 'external'))
        .map(([id]) => id);
    assert.ok(external.length >= 5, `only ${external.length} external-only modes`);

    const wrong = [];
    for (const id of external) {
        const on = formatChoices([], drive).find((c) => c.id === id);
        const expected = Math.floor(terabyte / MODES[id].bytes_per_second);
        if (on.max_seconds !== expected) wrong.push(`${id}: ${on.max_seconds}s, expected ${expected}s`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

/* ------------------------------------------------------------------ *
 * SET 3 — every format, which is the other half of the task           *
 * ------------------------------------------------------------------ */

test('EVERY codec the writer can encode has a mode that costs something', () => {
    /*
     * "From 3 HEVC modes to every format above." A codec declared and priced
     * by no mode is a format the camera can encode and the budget cannot
     * quote — so it is offered with no duration, or not offered at all while
     * looking built.
     */
    const wrong = [];
    for (const id of Object.keys(policy.CODECS)) {
        const modes = Object.values(MODES).filter((m) => m.codec === id);
        if (!modes.length) { wrong.push(`${id}: no mode records in it, so nothing prices it`); continue; }
        for (const m of modes) {
            if (!(m.bytes_per_second > 0)) wrong.push(`${id}: ${m.label} costs nothing per second`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY capability is either recorded by a mode or says why it has none', () => {
    /*
     * The exclusion that has to stay a DECISION. Open gate has no fixed mode
     * because its raster is the sensor's own and nothing published gives a
     * pixel count — inventing one would put a duration nobody measured in
     * front of a director. Stated, that is a judgement; silent, it is a gap,
     * and the two are indistinguishable a month later.
     */
    const wrong = [];
    for (const [id, c] of Object.entries(policy.CAPABILITIES)) {
        const used = Object.values(MODES).some((m) => (m.requires || []).includes(id));
        if (used) {
            if (c.no_fixed_mode) wrong.push(`${id}: is recorded by a mode AND claims to have none`);
            continue;
        }
        if (!c.no_fixed_mode || c.no_fixed_mode.length < 40) {
            wrong.push(`${id}: no mode records it and it does not say why — which is how a `
                + 'format that was deliberately left out becomes one nobody remembers to add');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY mode declares a transport that exists, and a derived rate says so', () => {
    const wrong = [];
    for (const [id, m] of Object.entries(MODES)) {
        const declared = m.transports || [];
        if (!declared.length) wrong.push(`${id}: declares no way to leave the phone`);
        for (const t of declared) if (!TRANSPORTS[t]) wrong.push(`${id}: names transport ${t}, which is not declared`);
        if (!m.source || m.source.length < 20) wrong.push(`${id}: does not say where its rate comes from`);
        // The provider-pricing precedent: a figure nobody published is flagged,
        // never quietly averaged, because the budget below trusts it.
        if (/derived/i.test(m.source || '') && !m.inferred) {
            wrong.push(`${id}: its rate is derived and it is not flagged inferred, so a computed `
                + 'number is presented as a measured one');
        }
        if (m.inferred && !/derived/i.test(m.source || '')) {
            wrong.push(`${id}: is flagged inferred and its source does not say what it was derived from`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

/* ------------------------------------------------------------------ *
 * SET 4 — the recommendation follows the numbers that moved           *
 * ------------------------------------------------------------------ */

test('the recommendation is recomputed from the ceiling that binds, not from a memory', () => {
    const rec = policy.recommended();
    assert.ok(MODES[rec.mode], `recommended mode ${rec.mode} is not declared`);
    assert.strictEqual(rec.max_seconds, maxSecondsFor(rec.mode),
        'the recommendation quotes a duration the budget no longer agrees with');
    assert.ok(String(rec.why).includes(String(maxSecondsFor('4k60'))),
        'the recommendation still quotes the old 4K60 figure, so its argument rests on a number '
        + 'that has changed');
});

test('nothing computes a duration from the blind minimum any more', () => {
    /*
     * The defect itself, refused structurally. `bindingBytes()` may survive as
     * the answer to "what is the smallest ceiling anywhere" — a real question —
     * but nothing that prices a TAKE may use it, because the smallest ceiling
     * anywhere belongs to a destination most takes never reach.
     */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'lib', 'capture-policy.js'), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    const at = src.indexOf('function maxSecondsFor');
    assert.notStrictEqual(at, -1, 'maxSecondsFor is gone');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(!/bindingBytes\s*\(\s*\)/.test(body),
        'maxSecondsFor still takes the blind minimum across every ceiling, so a shot is priced '
        + 'against whichever unrelated service happens to have the smallest cap');
});
