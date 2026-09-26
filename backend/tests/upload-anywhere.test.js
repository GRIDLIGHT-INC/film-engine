/**
 * Anywhere a picture can be GENERATED, one can be UPLOADED
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "I'd like to be able to upload my own pictures in any places where a picture
 * can be generated."
 *
 * The routes have accepted uploads for every reference kind since the plate
 * upload work — `importSubjectPlateRoute` even reads `body.view`, so a
 * PARTICULAR view has always been uploadable. What the page offered was a
 * single Upload button per subject, which fills the default view.
 *
 * The subject sheets and the character sheet both draw their plates as
 * NUMBERED SLOTS, and every empty slot says `generate →` and nothing else. So
 * on the one surface where a director works view by view — front, side, back;
 * 01 Master, 02, 03 — the only way to fill a slot was to buy it, while the
 * photograph they already had could only be dropped on the subject as a whole.
 *
 * Set-based over two registries, because the failure is per-registry:
 *   1. the IMAGE targets the import routes accept, each of which needs a
 *      control on the page or it is a capability nobody can reach;
 *   2. the slot renderers that offer `generate →`, each of which must offer an
 *      upload for the SAME view.
 *
 * A test written against the character sheet alone passes while both subject
 * sheets are still generate-only, which is exactly the state being reported.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-upl-' + crypto.randomUUID().slice(0, 8));

const RAW = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/*
 * Comments blanked, positions preserved.
 *
 * A comment explaining the front-plate rule quotes "generate →", and the scan
 * matched it -- attributing a slot to ssPlateMeta, which renders a line of
 * metadata. Line-based, because a `/*` inside a string opens a block comment
 * that runs to the next close and eats real code; and same-length replacement
 * so every reported line number still points at the truth.
 */
const UI = RAW.split('\n')
    .map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? ' '.repeat(l.length) : l))
    .join('\n');
const { MEDIA_IMPORTS } = require('../lib/media-imports');

/** Derived: every target the routes accept a PICTURE for. */
const IMAGE_TARGETS = Object.entries(MEDIA_IMPORTS)
    .filter(([, spec]) => spec.kind === 'image')
    .map(([id]) => id);

/**
 * Targets with no control, named with the reason.
 *
 * Exempt BY NAME so a stale entry fails: if a page appears for one of these it
 * must come back into the denominator rather than staying quietly excused.
 */
const NO_CONTROL = {
    'previs-image': 'the old previs stage was removed; the route and the previs_image_upload tool remain',
    'continuity-ref': 'the continuity board was one of the nine pages removed; the route and the '
        + 'table stayed, so this is reachable over HTTP and by an agent and has no page to sit on',
};

/**
 * Every renderer that draws a plate SLOT with a generate affordance.
 *
 * Derived by finding the affordance in the source rather than listing the
 * sheets: a fourth sheet added later draws its slots the same way and is in
 * the denominator with nothing to remember.
 */
function slotRenderers() {
    /*
     * Per OCCURRENCE, not per function.
     *
     * Checking the enclosing function for an upload passes on a technicality:
     * characterSheetHtml renders a subject-level Upload button hundreds of
     * lines from its plate slots, so the function contains `uploadControl(`
     * while every slot in it offers only `generate →`. Caught by mutation of
     * the reading, not of the code -- the first version reported that sheet as
     * correct while it was the one being complained about.
     *
     * The window is the slot's own markup: an upload that fills a DIFFERENT
     * view is not an upload for this slot.
     */
    const out = [];
    for (const m of UI.matchAll(/generate\s*&rarr;|generate\s*→/g)) {
        const before = UI.slice(0, m.index);
        const fn = [...before.matchAll(/(?:async\s+)?function ([A-Za-z_$][\w$]*)\s*\(/g)].pop();
        const line = before.split('\n').length;
        out.push({
            name: fn ? fn[1] : '(top level)',
            line,
            slot: UI.slice(Math.max(0, m.index - 900), m.index + 900),
        });
    }
    return out;
}

test('the registries are visible, and larger than one example', () => {
    assert.ok(IMAGE_TARGETS.length >= 6,
        `only ${IMAGE_TARGETS.length} image import targets found — the registry read is broken`);
    const slots = slotRenderers();
    assert.ok(slots.length >= 2,
        `only ${slots.length} slot renderer(s) found (${slots.map(s => s.name).join(', ')}) — a `
        + 'check that sees one sheet passes while the others are still generate-only');
});

test('every image the routes accept has a way in from the page', () => {
    const missing = [];
    for (const target of IMAGE_TARGETS) {
        if (NO_CONTROL[target]) continue;
        // either the shared control, or a bespoke uploader posting to its route
        const shared = new RegExp(`uploadControl\\('${target}'`).test(UI);
        const bespoke = new RegExp(`data-import-target="${target}"`).test(UI);
        const byRoute = new RegExp(`${target.replace(/-/g, '[-/]')}`).test(UI)
            && /\/import`/.test(UI);
        if (!shared && !bespoke && !byRoute) missing.push(target);
    }
    assert.deepStrictEqual(missing, [],
        `the routes accept these pictures and the page offers no way to send one: ${missing.join(', ')}`);
});

test('every exemption names a target that still exists and still has no page', () => {
    for (const [target, why] of Object.entries(NO_CONTROL)) {
        assert.ok(IMAGE_TARGETS.includes(target),
            `${target} is exempted and is no longer an image import target`);
        assert.ok(why && why.length > 30, `${target}: the exemption states no real reason`);
        assert.ok(!new RegExp(`uploadControl\\('${target}'`).test(UI),
            `${target} is exempted and now HAS a control — the exemption is stale and hides it `
            + 'from the denominator');
    }
});

test('the shared slot uploader forwards the view it is given', () => {
    /*
     * The slots pass a view; this is the other half -- it has to reach the
     * request. `importSubjectPlateRoute` reads `body.view`, so a helper that
     * accepted a view and dropped it would fill the DEFAULT plate while every
     * slot appeared to work.
     */
    const i = UI.indexOf('function slotUpload(');
    assert.ok(i > -1, 'slotUpload is gone — the slots have no shared uploader');
    let j = UI.indexOf('{', i), d = 0, e = -1;
    for (let k = j; k < UI.length; k++) {
        if (UI[k] === '{') d++;
        else if (UI[k] === '}') { d--; if (!d) { e = k + 1; break; } }
    }
    const body = UI.slice(i, e);
    assert.match(body, /extra:\s*view\s*\?\s*\{\s*view/,
        'slotUpload does not put the view into the request body, so every slot upload fills the '
        + 'default plate');
    assert.match(body, /import/, 'slotUpload does not post to an import route');
});

test('every plate slot that offers generate also offers upload, for that same view', () => {
    const offenders = [];
    for (const r of slotRenderers()) {
        /*
         * The upload must sit in the SLOT and carry its view. A subject-level
         * Upload button fills the default plate, which is a different picture
         * from the one this slot is asking for.
         */
        /*
         * One call level, the rule the paid-gate check already follows: a slot
         * may render the control directly or delegate to a helper that does.
         * Refusing to follow the call reports a correct slot as bare.
         */
        const direct = /uploadControl\(|data-import-target=/.test(r.slot);
        let viaHelper = false;
        for (const call of r.slot.matchAll(/\b([A-Za-z_$][\w$]*[Uu]pload[A-Za-z_$]*)\s*\(/g)) {
            const i = UI.indexOf(`function ${call[1]}(`);
            if (i < 0) continue;
            let j = UI.indexOf('{', i), d = 0, e = -1;
            for (let k = j; k < UI.length; k++) {
                if (UI[k] === '{') d++;
                else if (UI[k] === '}') { d--; if (!d) { e = k + 1; break; } }
            }
            const body = UI.slice(i, e < 0 ? i + 8000 : e);
            if (/uploadControl\(|data-import-target=/.test(body)) { viaHelper = true; break; }
        }
        const hasUpload = direct || viaHelper;
        /*
         * STRUCTURAL, not textual.
         *
         * Requiring the literal word `view` in the slot fails a correct one:
         * the character tiles pass `v.id`, which IS the view for that slot.
         * What must be true is that the upload is given a view ARGUMENT at all
         * -- so the shared helper is called with its third parameter, or the
         * control carries `extra: { view }` directly.
         */
        const direct3 = /extra:\s*\{[^}]*view/.test(r.slot);
        const helper3 = [...r.slot.matchAll(/slotUpload\(([^)]*)\)/g)]
            .some(m => m[1].split(',').length >= 3 && m[1].split(',')[2].trim().length > 0);
        const carriesView = direct3 || helper3;
        if (!hasUpload) offenders.push(`${r.name}:${r.line} — no upload beside the generate`);
        else if (!carriesView) offenders.push(`${r.name}:${r.line} — the upload does not name the view`);
    }
    assert.deepStrictEqual(offenders, [],
        'these draw a plate slot whose only way to fill it is to buy one:\n  ' + offenders.join('\n  '));
});
