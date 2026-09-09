/**
 * THE CLAIMS RECORD WHAT WAS BUILT — GRD-3811 / FCC-015.
 *
 * "`film-engine-camera-brief.test.js` pins the system camera and the absent
 * recording APIs as gaps. When they close, the claims record what was BUILT — a
 * gap pinned as permanent makes a document fail for succeeding."
 *
 * THE TWO CLAIMS THAT SENTENCE NAMES ARE ALREADY RESHAPED, and that is the
 * shallow reading of this task. `no-recording-apis-yet` became
 * `recording-spine-landed` when FCC-001 landed; `system-camera-is-still-what-
 * shootControl-renders` became `controlled-camera-replaced-the-system-one` when
 * FCC-012 did. Stopping there would make this task a no-op.
 *
 * WHAT IS ACTUALLY WRONG IS THE OTHER HALF OF THE SAME SENTENCE. The claims are
 * the epic's own record of what is still true of the code, and they record FOUR
 * of the fourteen tasks that have landed. FCC-002, 003, 004, 006, 007, 008,
 * 009, 010, 013 and 014 are built, shipped and named by NOTHING here — so the
 * document that exists to say "this is still true" is silent about ten of the
 * things it is now true of. Deleting the recording transport, the audio track,
 * the format picker, ProRes, the hardware gate, the drive checks or the
 * resumable upload would leave every claim in this epic green.
 *
 * That is the same failure as a gap pinned as permanent, pointed the other way:
 * one asserts something false, the other asserts nothing at all. A record with
 * a hole in it is not a record.
 *
 * AND ONE GAP FAILS TO FAIL. `system-camera-is-still-there` was written to
 * break the day FCC-012 landed — "a gap pinned as permanent makes the epic fail
 * for succeeding" is its own `why`. It did not break, because its predicate
 * asks only whether `shootControl` renders a `capture` attribute ANYWHERE, and
 * the browser fallback still does and should. So it passes while asserting the
 * opposite of the code: the worst of the three states, because it looks like
 * coverage.
 *
 * SET-BASED OVER THE EPIC'S OWN TASK TABLE — 16 tasks, parsed from the
 * markdown. Every one must be recorded: as BUILT by a present claim, as NOT YET
 * by a gap claim that names what closes it, or exempt by name with a reason. A
 * registry that covers fifteen is indistinguishable from one that works.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EPIC = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'fcc-parity-epic.md'), 'utf8');

/**
 * The files that carry this epic's claims.
 *
 * DERIVED — any test that declares claims and talks about FCC tasks — so a
 * fourth document added later is in the denominator with nothing to remember.
 */
const CLAIM_FILES = fs.readdirSync(__dirname)
    .filter((f) => /\.test\.js$/.test(f))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(__dirname, f), 'utf8') }))
    .filter(({ file, src }) => file !== path.basename(__filename)
        && /kind: '(present|gap)'/.test(src) && /FCC-\d/.test(src));

/**
 * Every claim, as {file, id, kind, tasks}.
 *
 * Cut by BRACE DEPTH from each `id:` back to its own opening brace — never a
 * character window, and never a regex bounded by an indent that a reformat
 * would move.
 */
function claims() {
    const out = [];
    for (const { file, src } of CLAIM_FILES) {
        for (const m of src.matchAll(/id: '([^']+)'/g)) {
            // Back to the object this id belongs to.
            let open = src.lastIndexOf('{', m.index);
            if (open === -1) continue;
            let d = 0;
            let close = -1;
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') d++;
                else if (src[i] === '}' && --d === 0) { close = i + 1; break; }
            }
            if (close === -1) continue;
            const body = src.slice(open, close);
            const kind = (/kind: '(present|gap)'/.exec(body) || [])[1];
            if (!kind) continue;
            out.push({
                file,
                id: m[1],
                kind,
                tasks: [...new Set([...body.matchAll(/FCC-(\d{3})/g)].map((t) => `FCC-${t[1]}`))],
            });
        }
    }
    return out;
}

/** The epic's own task table — the denominator, read from the document. */
function epicTasks() {
    return [...EPIC.matchAll(/^\|\s*(FCC-\d{3})\s*\|\s*([^|]+?)\s*\|/gm)]
        .map((m) => ({ id: m[1], title: m[2] }));
}

/**
 * Tasks that changed no code, named with the reason.
 *
 * Exempt BY NAME rather than by pattern, and a stale entry fails: an exemption
 * claiming a task that does not exist makes the whole list a story.
 */
const NO_CODE = Object.freeze({
    'FCC-015': 'this task IS the claim registry — a claim recording that the claims record things '
        + 'would be the registry asserting its own existence, which nothing can falsify',
    'FCC-016': 'on-device evidence. Nothing in this repository changes when a phone shoots in each '
        + 'format, so there is no code for a claim to read — it is proven by a person with the '
        + 'hardware, and pinning it here would make a record of an event look like a check',
});

/* ------------------------------------------------------------------ *
 * SET 1 — every task the epic declares is recorded                    *
 * ------------------------------------------------------------------ */

test('the denominators are real, or every assertion below passes over nothing', () => {
    const tasks = epicTasks();
    assert.ok(tasks.length >= 16,
        `only ${tasks.length} tasks parsed from the epic; the table read is broken`);
    assert.ok(CLAIM_FILES.length >= 2,
        `only ${CLAIM_FILES.length} claim files found; the derivation is broken`);
    const all = claims();
    assert.ok(all.length >= 20, `only ${all.length} claims parsed; the extraction is broken`);
});

test('EVERY task the epic declares is recorded as built, as pending, or exempt', () => {
    /*
     * The claims are this epic's own record of what is still true of the code.
     * A task that landed and is named by no claim is one whose removal would
     * leave every claim green — the record has a hole exactly where the work
     * was done.
     */
    const all = claims();
    const named = new Map();
    for (const c of all) for (const t of c.tasks) {
        if (!named.has(t)) named.set(t, []);
        named.get(t).push(c);
    }

    const wrong = [];
    for (const { id, title } of epicTasks()) {
        if (NO_CODE[id]) continue;
        const mine = named.get(id) || [];
        if (!mine.length) {
            wrong.push(`${id} (${title}): built and recorded by no claim, so deleting what it `
                + 'built would leave every claim in this epic green');
        }
    }
    assert.deepStrictEqual(wrong, [],
        `the epic's record is silent about work it has done:\n  ${wrong.join('\n  ')}`);
});

test('EVERY exemption names a task that exists and says why', () => {
    const ids = new Set(epicTasks().map((t) => t.id));
    const wrong = [];
    for (const [id, why] of Object.entries(NO_CODE)) {
        if (!ids.has(id)) wrong.push(`${id}: exempted and is not a task in the epic`);
        if (!why || why.length < 40) wrong.push(`${id}: exempted without a real reason`);
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 2 — a gap says it is a gap, and stops when it closes            *
 * ------------------------------------------------------------------ */

test('no task is recorded as BOTH built and not yet built', () => {
    /*
     * A contradiction the registry cannot notice on its own: each claim passes
     * in isolation while the document says two opposite things about one task.
     */
    const byTask = new Map();
    for (const c of claims()) for (const t of c.tasks) {
        if (!byTask.has(t)) byTask.set(t, new Set());
        byTask.get(t).add(c.kind);
    }
    const wrong = [...byTask.entries()]
        .filter(([, kinds]) => kinds.has('gap') && kinds.has('present'))
        .map(([t]) => `${t}: recorded as a gap AND as built`);
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('no gap in THIS epic survives the task that closes it', () => {
    /*
     * The sentence this task is written from. A gap claim exists to break the
     * day its work lands, so the document cannot go on describing a camera that
     * no longer exists — and `system-camera-is-still-there` did not break,
     * because it asked only whether `shootControl` renders a `capture`
     * attribute anywhere. The browser fallback still does, and should, so the
     * claim passed while asserting the opposite of the code.
     *
     * Every FCC task named by a gap here is one this epic has completed, so a
     * gap naming one is stale by construction.
     */
    const wrong = [];
    for (const c of claims()) {
        if (c.kind !== 'gap') continue;
        for (const t of c.tasks) {
            if (NO_CODE[t]) continue;
            wrong.push(`${c.file} :: ${c.id}: still pins ${t} as a GAP. That work has landed — `
                + 'reshape it to record what was BUILT, or the epic fails for succeeding while '
                + 'this claim quietly passes');
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('a gap that remains names what closes it, and it is not this epic', () => {
    /*
     * `preview-is-a-layer` belongs to the PREVIOUS epic (PCC-007) and is
     * genuinely open — the preview is still an AVCaptureVideoPreviewLayer. A
     * gap outside this epic is a real record and must be left alone; what it
     * must not do is go unnamed.
     */
    const wrong = [];
    for (const c of claims()) {
        if (c.kind !== 'gap') continue;
        const src = CLAIM_FILES.find((f) => f.file === c.file).src;
        const at = src.indexOf(`id: '${c.id}'`);
        const body = src.slice(at, src.indexOf('holds()', at));
        if (!/closes:/.test(body)) {
            wrong.push(`${c.file} :: ${c.id}: is a gap and does not name what closes it`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 3 — the record is a record, not a list of names                 *
 * ------------------------------------------------------------------ */

test('EVERY claim recording a task actually READS the code', () => {
    /*
     * A claim that names a task in its prose and asserts nothing about the code
     * is a citation, not a check — it would stay green through the removal of
     * everything it describes. Each must reach for a real file.
     */
    const wrong = [];
    for (const { file, src } of CLAIM_FILES) {
        for (const m of src.matchAll(/id: '([^']+)'/g)) {
            let open = src.lastIndexOf('{', m.index);
            let d = 0;
            let close = -1;
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') d++;
                else if (src[i] === '}' && --d === 0) { close = i + 1; break; }
            }
            if (close === -1) continue;
            const body = src.slice(open, close);
            if (!/kind: '(present|gap)'/.test(body)) continue;
            const holds = body.slice(body.indexOf('holds()'));
            if (!/require\(|code\(|doc\(|src\(|readFileSync/.test(holds)) {
                wrong.push(`${file} :: ${m[1]}: its holds() reads no file, so it cannot notice `
                    + 'the thing it describes being removed');
            }
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('the epic document still carries the task table these rest on', () => {
    /*
     * The precondition every assertion above depends on. If the table were
     * reformatted out of recognition the parse would return nothing and the
     * whole file would pass over an empty set — the failure mode this codebase
     * records as "a green test whose subject count has quietly gone to zero".
     */
    const tasks = epicTasks();
    const ids = tasks.map((t) => t.id);
    assert.deepStrictEqual(ids, [...new Set(ids)], 'the epic lists a task twice');
    for (let i = 1; i <= 16; i++) {
        const id = `FCC-${String(i).padStart(3, '0')}`;
        assert.ok(ids.includes(id), `${id} is not in the epic's task table any more`);
    }
});
