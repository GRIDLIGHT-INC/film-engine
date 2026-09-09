/**
 * THE MANUAL CONTROLS REACH VIDEO — GRD-3800 / FCC-004.
 *
 * The three locks the PCC epic built — exposure, white balance, focus — live
 * on the DEVICE, and a device's `activeFormat` is chosen by the session. So
 * anything that reconfigures the session releases them.
 *
 * `select()` has always known this. Swapping a lens re-applies all three, with
 * a comment saying exactly why: *"without this the UI reads LOCK while the next
 * plate is metered automatically."*
 *
 * FCC-002 THEN ADDED TWO MORE RECONFIGURATION SITES AND NEITHER RE-APPLIES
 * ANYTHING. `startRecording` swaps `sessionPreset` to the recording mode's, and
 * `restorePreset` swaps it back — so a director locks exposure, presses record,
 * and the take is metered automatically while the chip on screen still reads
 * LOCK HELD. That is the same sentence `select()` wrote, one capability over,
 * and it is worse here: a plate can be re-shot, a take cannot.
 *
 * THE FITTING ARITHMETIC IS REUSED, NEVER RE-DERIVED — the task says so, and
 * the reason is in `apply(_:to:)`: the exposure ranges belong to the FORMAT, so
 * a 1/30s exposure metered at the photo preset can be illegal at 4K60, where
 * the maximum frame duration is 1/60s. Passing it raises
 * NSInvalidArgumentException. `held.fitted(...)` already refits against
 * whatever format the device is on and already reports the shortfall in stops,
 * which is precisely what a preset change needs.
 *
 * SET-BASED OVER TWO REGISTRIES, BOTH DISCOVERED FROM THE SOURCE:
 *
 *   1. THE LOCKS — every function that applies a `*Lock` to a device, found by
 *      signature rather than listed. Three today. A test naming exposure alone
 *      passes while white balance drifts through every take, and a fourth lock
 *      added later is in the denominator with nothing to remember.
 *   2. THE RECONFIGURATION SITES — every function that changes
 *      `session.sessionPreset` or swaps a device input, found by walking the
 *      function bodies. Three today, and FCC-005 through FCC-009 all add more:
 *      Apple Log sets `activeColorSpace`, ProRes changes the format again,
 *      external recording changes where it goes. Every one of them will release
 *      these locks, so the denominator has to grow by itself.
 *
 * Nine checks. Six of them fail before this task.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');

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

/* ------------------------------------------------------------------ *
 * REGISTRY 1 — the locks, by the shape of the function that applies   *
 * ------------------------------------------------------------------ */

/**
 * Every function that pins a held lock onto a device.
 *
 * Discovered by SIGNATURE — `(_ x: SomethingLock, to device: AVCaptureDevice)`
 * — rather than by a list, because a list is only as complete as the afternoon
 * it was written and the next lock added would be the one silently released.
 */
function lockAppliers() {
    const found = [...code().matchAll(
        /func (\w+)\(_\s+\w+:\s*(\w+Lock),\s*to device:\s*AVCaptureDevice\)/g)]
        .map((m) => ({ fn: m[1], type: m[2] }));
    return found;
}

/** The property each lock is held in, so "is one held" can be asked. */
function heldProperties() {
    return Object.fromEntries(
        [...code().matchAll(/var (\w+):\s*(\w+Lock)\?/g)].map((m) => [m[2], m[1]]));
}

test('the lock registry is discovered, and covers all three controls', () => {
    const appliers = lockAppliers();
    assert.ok(appliers.length >= 3,
        `only ${appliers.length} lock applier(s) found (${appliers.map((a) => a.fn).join(', ')}). `
        + 'The scan is broken, and a set test over almost nothing reports a camera that loses two '
        + 'of its three locks as complete');

    const types = appliers.map((a) => a.type).sort();
    assert.deepStrictEqual(types, ['ExposureLock', 'FocusLock', 'WhiteBalanceLock'],
        `the locks this epic must carry into video are exposure, white balance and focus; the `
        + `camera applies ${types.join(', ')}`);

    const held = heldProperties();
    const unheld = appliers.filter((a) => !held[a.type]).map((a) => a.type);
    assert.deepStrictEqual(unheld, [],
        `${unheld.join(', ')} can be applied but is held nowhere, so nothing can ask whether it `
        + 'is set — and a lock that cannot be asked about cannot be re-applied');
});

/* ------------------------------------------------------------------ *
 * REGISTRY 2 — every site that reconfigures the session               *
 * ------------------------------------------------------------------ */

/**
 * `configure()` is exempt BY NAME, with a reason that is checkable rather than
 * a story: it runs before the camera reaches `.ready`, and both `lockExposure`
 * and `lockFocus` guard on `state == .ready`, so no lock can exist yet to be
 * released. An exemption matching on a pattern would quietly excuse the next
 * site that gets this wrong.
 */
const EXEMPT = { configure: 'runs before .ready, so no lock can be held yet' };

/** Every function whose body changes the active format under the locks. */
function reconfiguringFunctions() {
    const s = code();
    const out = [];
    for (const m of s.matchAll(/\bfunc (\w+)\s*\(/g)) {
        const name = m[1];
        if (out.some((o) => o.name === name)) continue;
        const body = extract(m[0], s);
        if (!body) continue;
        const changesPreset = /session\.sessionPreset\s*=/.test(body);
        const swapsInput = /session\.addInput\(/.test(body);
        if (changesPreset || swapsInput) out.push({ name, body, changesPreset });
    }
    return out;
}

/**
 * The shared re-apply, DISCOVERED rather than named.
 *
 * A function that calls every applier is the re-apply helper, whatever it is
 * called. Resolution FOLLOWS ONE CALL LEVEL into it — the rule
 * `screenplay-mutators` and `manual-edit` already follow here — because the
 * alternative is a copy of the same three lines at every site, which is exactly
 * how one of them comes to carry the focus lock and the others do not.
 *
 * One level, never an unbounded walk: an unbounded walk eventually finds an
 * `apply(` in something unrelated and reports a broken site as covered.
 */
function reapplyHelper() {
    const s = code();
    const appliers = lockAppliers().map((a) => a.fn);
    if (!appliers.length) return null;
    for (const m of s.matchAll(/\bfunc (\w+)\s*\(/g)) {
        const body = extract(m[0], s);
        if (!body) continue;
        if (appliers.every((fn) => new RegExp(`\\b${fn}\\(`).test(body))) {
            return { name: m[1], body };
        }
    }
    return null;
}

/** Where a site re-applies a lock: directly, or through the shared helper. */
function reapplySites(body) {
    const helper = reapplyHelper();
    const out = [body];
    if (helper && new RegExp(`\\b${helper.name}\\(`).test(body)) out.push(helper.body);
    return out;
}

test('EVERY function that reconfigures the session re-applies EVERY lock', () => {
    const sites = reconfiguringFunctions().filter((s) => !EXEMPT[s.name]);
    assert.ok(sites.length >= 3,
        `only ${sites.length} reconfiguration site(s) found (${sites.map((s) => s.name).join(', ')}). `
        + 'The scan is broken; a preset swap this test cannot see is one that silently releases '
        + 'every lock');

    const appliers = lockAppliers();
    const held = heldProperties();
    const missing = [];
    for (const site of sites) {
        const where = reapplySites(site.body);
        for (const { fn, type } of appliers) {
            const applied = where.some((b) => new RegExp(`\\b${fn}\\(`).test(b));
            if (!applied) {
                missing.push(`${site.name} never re-applies ${type} (${fn})`);
                continue;
            }
            // Applied unconditionally is its own defect: pinning a lock nobody
            // set fixes the camera to whatever it happened to be metering.
            const asked = where.some((b) => new RegExp(`\\b${held[type]}\\b`).test(b));
            if (!asked) {
                missing.push(`${site.name} applies ${fn} without asking whether ${held[type]} is held`);
            }
        }
    }
    assert.deepStrictEqual(missing, [],
        'a lock lives on the DEVICE and the session chooses the device\'s format, so every one of '
        + 'these releases a lock the director can still see on screen. A plate can be re-shot; a '
        + `take cannot:\n  ${missing.join('\n  ')}`);
});

test('EVERY exemption names a function that still exists', () => {
    const all = reconfiguringFunctions().map((s) => s.name);
    const stale = Object.keys(EXEMPT).filter((n) => !all.includes(n));
    assert.deepStrictEqual(stale, [],
        `these are exempted and no longer reconfigure anything: ${stale.join(', ')}. A stale `
        + 'exemption makes the whole list a story rather than a check');
});

/* ------------------------------------------------------------------ *
 * The ordering that makes a re-apply correct rather than decorative   *
 * ------------------------------------------------------------------ */

test('a preset change re-applies AFTER the configuration is committed', () => {
    /*
     * `apply(_:to:)` refits against `device.activeFormat`. Inside a
     * beginConfiguration/commitConfiguration block the new preset has not taken
     * effect yet, so the refit would read the OLD format's ranges — and then
     * set a custom exposure that is illegal in the new one, which
     * AVCaptureDevice raises on.
     *
     * An input swap is different and `select()` is deliberately not held to
     * this: there the format belongs to the device being added, which is
     * already correct before the commit.
     */
    const appliers = lockAppliers().map((a) => a.fn);
    const wrong = [];
    for (const site of reconfiguringFunctions()) {
        if (EXEMPT[site.name] || !site.changesPreset) continue;
        const commit = site.body.indexOf('commitConfiguration');
        assert.notStrictEqual(commit, -1, `${site.name} changes the preset outside a configuration block`);
        const helper = reapplyHelper();
        const names = helper ? [...appliers, helper.name] : appliers;
        for (const fn of names) {
            const at = site.body.search(new RegExp(`\\b${fn}\\(`));
            if (at !== -1 && at < commit) {
                wrong.push(`${site.name} re-applies ${fn} before commitConfiguration`);
            }
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the refit reads device.activeFormat, which the session has not changed yet inside the '
        + `configuration block — so it fits against the format being left behind:\n  ${wrong.join('\n  ')}`);
});

test('the fitting arithmetic is reused, never re-derived', () => {
    /*
     * The task says so outright. `fitted(...)` clamps a held value into the
     * format's own range AND reports how far short it fell — a second
     * implementation would be a second answer to "can this lens hold that
     * exposure", and the two would disagree quietly.
     */
    const cam = code();
    const fits = [...cam.matchAll(/\.fitted\(/g)].length;
    assert.ok(fits >= 2, `only ${fits} call(s) to fitted(); the refit is not being reused`);

    for (const kind of ['ExposureLock', 'WhiteBalanceLock']) {
        const s = extract(`struct ${kind}`);
        assert.ok(s && /static func fit\(/.test(s) && /func fitted\(/.test(s),
            `${kind} no longer carries its own fitting arithmetic`);
    }

    /*
     * And it is only called from the appliers. A preset change that clamped an
     * exposure itself would be exactly the re-derivation the task forbids.
     */
    const appliers = lockAppliers().map((a) => a.fn);
    for (const site of reconfiguringFunctions()) {
        if (EXEMPT[site.name]) continue;
        assert.ok(!/\.fitted\(/.test(site.body),
            `${site.name} fits a lock itself instead of calling ${appliers.join('/')} — a second `
            + 'answer to the same question, and the two will disagree');
    }
});

/* ------------------------------------------------------------------ *
 * What a director is told when the new format cannot hold the lock    *
 * ------------------------------------------------------------------ */

test('a lock the recording format cannot reach is reported, not silently dropped', () => {
    /*
     * 4K60's maximum frame duration is 1/60s, so an exposure metered at 1/30
     * on the photo preset cannot be held once recording starts. The refit
     * clamps it — correctly — and the DIFFERENCE is the thing a director needs,
     * because a take that is quietly a stop darker looks like the lock worked.
     * `apply` already writes that sentence into `exposureWarning`; this pins
     * that it still does, since the whole re-apply is pointless if the
     * shortfall goes unsaid.
     */
    const apply = extract('private func apply(_ held: ExposureLock');
    assert.ok(apply, 'the exposure applier is gone');
    assert.ok(/exposureWarning\s*=/.test(apply),
        'apply() no longer reports the shortfall, so a take metered a stop off from what the '
        + 'director locked looks exactly like one that held');
    assert.ok(/stopsOff/.test(apply),
        'the shortfall is not measured in stops, which is the only unit a director can act on');
});

test('the transport does not claim a lock the take is not holding', () => {
    /*
     * The exposure chip reads "LOCK · 1/50 · 5600K" from `camera.exposure`,
     * which is the HELD value rather than the device's state. That is correct
     * only while every reconfiguration re-applies it — which is what this file
     * exists to guarantee — so the guarantee is asserted rather than assumed.
     */
    const cam = code();
    assert.ok(/camera\.exposure/.test(cam),
        'the exposure chip no longer reads the held lock');
    const sites = reconfiguringFunctions().filter((s) => !EXEMPT[s.name]);
    assert.ok(sites.length > 0 && sites.every((s) => reapplySites(s.body).some((b) => /apply/.test(b))),
        'a reconfiguration site re-applies nothing while the chip still reads LOCK — the exact '
        + 'sentence select() wrote when it found this the first time');
});
