/**
 * Sections that breathe, a ratio you can see, and a shot you can move
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Four things reported together, and three of them share a shape: a value the
 * engine already holds, with no way for a person to see or change it.
 *
 * 1. SECTION DESCRIPTIONS OVERLAP AND CLIP. `.ss-region-head` is a flex row and
 *    `.ss-what` inside it is `white-space:nowrap`, so a description physically
 *    CANNOT wrap. In a wide column that is the intended design; in the
 *    location sheet's three-up support row it runs straight over its
 *    neighbour, and in the prop sheet's 400px rail it is cut off mid-sentence.
 *    The `.snd-grid .ss-region-head { display:block }` override already in the
 *    stylesheet is the tell: this was diagnosed once and fixed only where it
 *    had been noticed.
 *
 * 2. SECTIONS ARE TIGHT. Reported as a recurring theme across all three
 *    subject sheets, and it is: the grids that hold them use 10-14px gaps.
 *
 * 3. THE PER-SHOT ASPECT RATIO SHOWS NOTHING. `film_shots.aspect_ratio` is a
 *    real column, the board has a picker for it, and `PUT /shots/:id` stores
 *    it — and the tile renders at whatever shape the picture happens to be. So
 *    a shot set to 9:16 is indistinguishable from one that was never set, on
 *    the one surface where the decision is made.
 *
 * 4. A SHOT CANNOT MOVE THROUGH THE BOARD. The cards are `draggable="true"`
 *    and `onShotDrop` calls `/shots/reorder` — dragging only REORDERS. The
 *    column element carries no `ondrop` at all, so a card can never cross
 *    columns, `PUT /shots/:id` does not accept `status`, and no control
 *    anywhere sets one. There is no way for a person to change a shot's
 *    status by any route. The board also renders FOUR columns against a CHECK
 *    that allows FIVE: a `failed` shot is filed under `pending`, which reads
 *    as "not started" rather than "this went wrong".
 *
 * Set-based over the registries rather than the examples reported: the status
 * vocabulary comes from the migration's own CHECK, and the sheet containers
 * are discovered from the stylesheet, so a sixth status or a fourth sheet grid
 * lands in the denominator with nothing to remember.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const SHOTS_ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shots.js'), 'utf8');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '004_film_shots.sql'), 'utf8');

/** The status vocabulary, from the CHECK that actually enforces it. */
function shotStatuses() {
    const m = /status[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\)/.exec(MIGRATION);
    assert.ok(m, 'the film_shots status CHECK is gone');
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

/**
 * Containers that hold SECTIONS, derived by walking back from each
 * `ssSection(` call to the nearest still-open element.
 *
 * Not a character window: a 900px window reports `ss-spec-grid` — the
 * Height/Width/Length input grid INSIDE a section, where a tight 8px gap is
 * correct — and demanding section spacing of it would be wrong. The immediate
 * parent is the only honest answer to "what lays these out".
 */
function sectionContainers() {
    const found = new Set();
    for (const call of [...UI.matchAll(/ssSection\(/g)]) {
        const before = UI.slice(0, call.index);
        let depth = 0;
        // Walk backwards over tags, counting closes, until an unmatched open.
        const tags = [...before.matchAll(/<(\/?)div\b([^>]*)>/g)].reverse();
        for (const t of tags) {
            if (t[1] === '/') { depth++; continue; }
            if (depth > 0) { depth--; continue; }
            const cls = /class="([^"]*)"/.exec(t[2]);
            if (cls) {
                cls[1].trim().split(/\s+/)
                    .filter(c => /grid$|^ss-col$|turntable/.test(c))
                    .forEach(c => found.add(c));
            }
            break;
        }
    }
    return [...found];
}

/* ── 1. descriptions must be able to wrap ─────────────────────────────── */

test('a section description can wrap, so it never runs over its neighbour', () => {
    const head = /\.ss-region-head\s*\{([^}]*)\}/.exec(UI);
    assert.ok(head, '.ss-region-head is gone');

    const what = /\.ss-region-head\s*>\s*\.ss-what\s*\{([^}]*)\}/.exec(UI);
    assert.ok(what, '.ss-region-head > .ss-what is gone');
    assert.ok(!/white-space\s*:\s*nowrap/.test(what[1]),
        'the description is white-space:nowrap inside a flex row, so it CANNOT wrap — in a narrow '
        + 'column it overflows onto whatever sits beside it, which is the overlap reported on the '
        + 'location sheet and the clipping on the prop rail');

    assert.match(head[1], /flex-wrap\s*:\s*wrap/,
        'the head does not wrap, so a description that will not fit beside its title has nowhere to go');
});

/* ── 2. sections breathe ──────────────────────────────────────────────── */

test('the section containers are discovered, not listed', () => {
    const grids = sectionContainers();
    assert.ok(grids.length >= 3,
        `found ${grids.length} section containers (${grids.join(', ')}); the scan is not walking the markup`);
    assert.ok(!grids.includes('ss-spec-grid'),
        'the scan picked up a FIELD grid inside a section — its tight gap is correct and demanding '
        + 'section spacing of it would be wrong');
});

test('every section container leaves room between sections', () => {
    const MIN = 16;
    for (const g of sectionContainers()) {
        const rule = new RegExp(`\\.${g}\\s*\\{([^}]*)\\}`).exec(UI);
        const gap = /gap\s*:\s*(\d+)px/.exec(rule[1]);
        assert.ok(gap, `.${g}: declares no gap, so its sections touch`);
        assert.ok(Number(gap[1]) >= MIN,
            `.${g}: ${gap[1]}px between sections — too tight to read as separate regions (want >= ${MIN}px)`);
    }
});

/* ── 3. the ratio you picked is the shape you see ─────────────────────── */

test('a shot with its own aspect ratio is SHOWN at that ratio on the board', () => {
    // The picker exists and stores; the question is whether anything renders it.
    assert.match(UI, /data-field="aspect_ratio"/, 'the per-shot ratio picker is gone');

    // Behavioural: run the board's own helper and require the chosen ratio to
    // become a drawn shape. A source check for a class name passes against a
    // helper that returns '' for every input.
    const m = /const ratioGuide = \(f\) => \{[\s\S]*?\n            \};/.exec(UI);
    assert.ok(m, 'nothing on the board turns a shot\'s aspect_ratio into a rendered shape');
    const esc = (x) => String(x == null ? '' : x);
    const state = { currentProject: { aspect_ratio: '16:9' } };
    const guide = new Function('esc', 'state', m[0] + '; return ratioGuide;')(esc, state);

    assert.match(guide({ aspect_ratio: '9:16' }), /aspect-ratio:9\/16/,
        'a shot set to 9:16 draws no 9:16 frame — the picker shows the director nothing');
    assert.match(guide({ aspect_ratio: '' }), /aspect-ratio:16\/9/,
        'a shot with no ratio of its own does not show the project ratio it inherits');
    assert.strictEqual(guide({ aspect_ratio: 'nonsense' }), '',
        'an unparseable ratio still draws a box, which would be a confident lie about the frame');
});

/* ── 4. a shot can be moved, and every status has a home ──────────────── */

test('every status the schema allows has a column on the board', () => {
    const statuses = shotStatuses();
    assert.ok(statuses.length >= 5, `only ${statuses.length} statuses parsed from the CHECK`);

    const decl = /const columns = \{([^}]*)\}/.exec(UI);
    assert.ok(decl, 'the kanban column set is gone');
    for (const s of statuses) {
        assert.ok(new RegExp(`\\b${s}\\s*:`).test(decl[1]),
            `'${s}' has no column, so such a shot is filed under whatever the fallback is — `
            + `a failed shot reading as "not started" is worse than either`);
    }
});

test('a column accepts a drop, so a card can cross columns', () => {
    const col = /<div class="kanban-column"([^>]*)>/.exec(UI);
    assert.ok(col, 'the kanban column element is gone');
    assert.match(col[1], /ondrop=/,
        'the column carries no ondrop, so dragging a card onto another column does nothing — '
        + 'onShotDrop only reorders');
});

test('the route accepts a status, or no control could ever set one', () => {
    /*
     * status is a COLUMN, not a card field, so it is deliberately NOT in
     * EDITABLE — that list writes into scene_card_yaml, and a status stored in
     * the card would be read by nothing and would mark the card stale for a
     * change no prompt can see. It follows the aspect_ratio precedent instead.
     * This assertion originally demanded EDITABLE and was wrong about the
     * mechanism.
     */
    const editable = /const EDITABLE = \[([\s\S]*?)\]/.exec(SHOTS_ROUTE);
    assert.ok(editable, 'EDITABLE is gone from routes/shots.js');
    assert.ok(!/'status'/.test(editable[1]),
        'status is in EDITABLE, so it would be written into the scene card rather than its own column');

    assert.match(SHOTS_ROUTE, /UPDATE film_shots SET status = \? WHERE id = \?/,
        'PUT /shots/:id never writes film_shots.status, so there is no route by which a person can '
        + 'move a shot through the board at all');
});

test('the status a caller sends is checked against the schema, not trusted', () => {
    const { SHOT_STATUSES } = require('../routes/shots');
    assert.ok(Array.isArray(SHOT_STATUSES), 'the route declares no status vocabulary');
    // The route's list and the CHECK that enforces it must agree, or a value
    // the route allows arrives as a SQLite 500 that reads as a broken server.
    assert.deepStrictEqual([...SHOT_STATUSES].sort(), [...shotStatuses()].sort(),
        'the route and the migration disagree about which statuses are legal');
});

test('a column-only edit is still an edit', () => {
    // The board's ratio picker sends exactly { aspect_ratio } and nothing else,
    // and the "Nothing to change" gate counted CARD fields alone — so it was
    // refused before reaching the UPDATE. The picker appeared to work and
    // stored nothing.
    const gate = /const COLUMN_FIELDS = \[([^\]]*)\]/.exec(SHOTS_ROUTE);
    assert.ok(gate, 'the route does not name its column fields');
    for (const f of ['aspect_ratio', 'status']) {
        assert.ok(gate[1].includes(`'${f}'`), `${f} is not counted as a change, so a ${f}-only PUT is refused`);
    }
    assert.match(SHOTS_ROUTE, /!changed\.length && !columnEdits\.length/,
        'the gate still refuses on card fields alone');
});
