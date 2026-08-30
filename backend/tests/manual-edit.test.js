/**
 * If the app stores it, a person can type it.
 *
 * "I should be able to edit everything in the app manually (text) like the
 * character description."
 *
 * A field a route ACCEPTS and the database STORES, with no control on any
 * page, is settable only from an agent or curl. That is the same failure this
 * codebase has paid for repeatedly under a different name — camera mode built,
 * tested and then removed from the page; eight regenerate parameters reachable
 * only from an agent host; `previs/apply` with no button. A capability with no
 * control is indistinguishable from one that does not exist.
 *
 * Measured before the fix, against the routes' own field lists:
 *
 *   character  9/13   no ethnicity, build, hair, distinguishing
 *   location   6/7    no sound_notes
 *   prop       7/8    no notes
 *   project    5/6    NO STYLE_PRESET
 *
 * The last one is the serious one. `style_preset` is appended to EVERY image
 * prompt in a production, including the reference plates, and it could only be
 * set by the mood board's Apply look — which COMPOSES it, so a director could
 * not hand-correct the string. This is the field that once put a flayed
 * quadruped in an establishing shot whose card reads "Empty, ordinary, still."
 * The person responsible for how the film looks could not read it.
 *
 * THE DENOMINATOR IS DERIVED FROM THE ROUTES. A list typed here would be as
 * complete as the afternoon it was written; the next field added to a route
 * would be unreachable again with nothing failing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SPA = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const ROUTES = path.join(ROOT, 'backend', 'routes');

/*
 * Fields that are not prose a person types. Excluded by SHAPE, and the shapes
 * are named: identifiers, timestamps, durations, percentages, orderings, and
 * arrays the app assembles from something the user did elsewhere (an upload,
 * a picker, a drag). Every one of these is set by an interaction rather than
 * by typing, so demanding a text box for them would be wrong.
 */
const MACHINE_SHAPES = [
    /_id$/, /^id$/,                       // identifiers — chosen, not typed
    /_ms$/, /_date$/, /_on$/, /_at$/,     // times and durations
    /_pct$/,                              // percentages
    /^sort_order$/, /^position_in_timeline$/,   // ordering — set by dragging
    /^resolved$/, /^is_cc$/,              // flags — set by a checkbox elsewhere
    /^reference_images$/, /^line_items$/, /^shot_ids$/,  // arrays the app assembles
    /^assumptions$/, /^missing_data$/,    // computed by the estimator
    /^image_path$/, /^asset_id$/,         // set by an upload, never typed
    /^at$/,                               // a beat's position in the story, a number
    /^provider_config$/,                  // an object of capability -> provider, set by pickers
];
const MACHINE = { test: f => MACHINE_SHAPES.some(re => re.test(f)) };

/**
 * Surfaces that genuinely have no editor yet, named with what is missing.
 *
 * Named rather than deleted from the denominator: a gap that is written down
 * is work, and a gap that is silently excluded is a gap nobody will find
 * again. Removing an entry here is what "we built that screen" looks like.
 */
const NAMED_DIFFERENTLY = {
    /*
     * A control does not have to be named after its field, and these are not.
     * Each was opened in the running page and operated before being listed
     * here — a heuristic wide enough to match them automatically is also wide
     * enough to pass a hardcoded value, which is the failure this kind of
     * check exists to catch.
     */
    'budget-estimate.js updateEstimate': {
        template: { control: 'budgetTemplateSelect', why: 'sent as a query param, not a body key' },
    },
    'budget.js setBudgetLimit': {
        budget_total: { control: 'budget_limit', why: 'the control is named for the limit; saveBudgetLimit remaps it' },
    },
    'projects.js updateProject': {
        annotation_feedback: { control: 'annotFeedbackToggle', why: 'a toggle on the storyboard, not in settings' },
    },
    /*
     * The sheets edit their structured half through real editors rather than
     * one input each: a list of flags, a plan of a room, six folding sections.
     * Named with the control that writes each, because a heuristic wide enough
     * to match them automatically is also wide enough to pass a hardcoded
     * value — the failure this check exists to catch.
     */
    'locations.js updateProp': {
        continuity_states: { control: 'addPropState',
            why: 'a repeating list, not one input — the prop sheet\'s states region adds and removes them' },
        materials_json: { control: 'ssAddMaterial',
            why: 'rows of name, role and colour; a comma string cannot carry a hex' },
        constraints_json: { control: 'ssAddConstraint', why: 'a list of things to hold true' },
        keywords: { control: 'ssAddKeyword', why: 'a list of words that must survive into every frame' },
    },
    'locations.js updateLocation': {
        description_sections: { control: 'saveSheetSection',
            why: 'six named folding sections, each with its own length' },
        continuity_flags: { control: 'ssAddFlag', why: 'a list of things to hold true in every plate' },
        plate_plan: { control: 'ssEditPlatePlan', why: 'the views this location is meant to have' },
        orientation_plan: { control: 'ssEditPlan', why: 'the room by compass edge, not one field' },
    },
};

/*
 * Empty, and kept rather than deleted: this is where a gap goes when one is
 * found, and the test above fails an entry that no longer describes reality —
 * so an empty object is a claim that every field a route accepts can be typed
 * by a person, checked on every run.
 */
const NOT_BUILT = {};

/** Every update handler in every route, with the text fields it accepts. */
function updateHandlers() {
    const out = [];
    for (const file of fs.readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
        for (const m of src.matchAll(/function\s+(update|edit|patch|set)([A-Z]\w*)\s*\(/g)) {
            const next = src.indexOf('\nfunction ', m.index + 10);
            const body = src.slice(m.index, next > 0 ? next : m.index + 4000);

            const fields = new Set();
            // `if (body.x !== undefined)`
            for (const t of body.matchAll(/body\.([a-z_][a-z0-9_]*)\s*!==\s*undefined/g)) fields.add(t[1]);
            // `const textFields = { name: 200, description: 5000, ... }`
            for (const t of body.matchAll(/\{\s*((?:[a-z_][a-z0-9_]*:\s*\d+,?\s*)+)\}/g)) {
                for (const k of t[1].matchAll(/([a-z_][a-z0-9_]*):/g)) fields.add(k[1]);
            }
            for (const t of body.matchAll(/^\s*([a-z_][a-z0-9_]*):\s*\d+,?\s*$/gm)) fields.add(t[1]);

            const text = [...fields].filter(f => !MACHINE.test(f)).sort();
            if (text.length) out.push({ file, fn: `${m[1]}${m[2]}`, key: `${file} ${m[1]}${m[2]}`, fields: text });
        }
    }
    return out;
}

/**
 * Is there a control on the page a person can set this with?
 *
 * TWO WAYS, because a control does not have to be NAMED after its field and
 * four real ones are not. The first version of this check only looked for the
 * field name and reported four working controls as missing: the transition
 * <select> is built at runtime with no data-field, `budget_total` is sent from
 * a control called `budget_limit`, `template` comes from `budgetTemplateSelect`
 * and `annotation_feedback` from `annotFeedbackToggle`. A detector that cries
 * wolf four times out of five gets switched off, and then the one real gap goes
 * with it.
 *
 * So a field also passes if the page SENDS it from something it read out of the
 * DOM. Read out of the DOM specifically — not merely mentioned — because a
 * hardcoded value in a request body is exactly the "sending a constant is not
 * the same as offering control over it" failure direct-shot-ui.test.js exists
 * to catch.
 */
function hasControl(field) {
    if (SPA.includes(`data-field="${field}"`)) return true;

    /*
     * A control BUILT at runtime.
     *
     * The location and prop sheets emit `data-field="${field}"` from a helper,
     * so the attribute name appears nowhere in the source and a text search
     * reports a working editor as missing — the same reason
     * plate-upload.test.js executes uploadControl rather than grepping for an
     * attribute that is produced rather than written.
     */
    if (new RegExp(`ssField\\('${field}'`).test(SPA)) return true;

    const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (new RegExp(`id="[A-Za-z]*${camel[0].toUpperCase()}${camel.slice(1)}"`).test(SPA)) return true;

    // `field: <something read from the page>`
    const READS_DOM = /getElementById|getModalData|querySelector|\.value|\.checked/;
    for (const m of SPA.matchAll(new RegExp(`\\b${field}\\s*:`, 'g'))) {
        if (READS_DOM.test(SPA.slice(m.index, m.index + 160))) return true;
    }
    return false;
}

/** The exact markup of one modal, by walking its own <div> nesting. */
function modalMarkup(id) {
    const at = SPA.indexOf(`id="${id}"`);
    if (at === -1) return null;
    const start = SPA.lastIndexOf('<div', at);
    let depth = 0;
    for (let i = start; i < SPA.length; i++) {
        if (SPA.startsWith('<div', i)) depth++;
        else if (SPA.startsWith('</div>', i)) { depth--; if (depth === 0) return SPA.slice(start, i + 6); }
    }
    return null;
}

test('the entity a director edits most has every field the route accepts', () => {
    /*
     * Character, location and prop are the ones the request named, and the ones
     * whose descriptions condition every frame their subject appears in. They
     * carry NO exemption: if the route takes it, the modal offers it.
     *
     * SCOPED TO EACH MODAL, not to the page. `data-field="notes"` exists in
     * more than one modal, so an app-wide search reports the PROP modal as
     * having a notes control when the control belongs to continuity — and a
     * mutation deleting the prop one passed happily.
     */
    /*
     * A subject may be edited in more than one place, and both count.
     *
     * The location and prop SHEETS are where a director now works — the modal
     * is the quick create/edit and the sheet is the workspace, exactly as the
     * character card and the character sheet already divide it. Scoping to the
     * modal alone would report a field as unreachable when it is on the sheet;
     * scoping to the whole page would report the PROP modal as having a notes
     * control when the control belongs to continuity. So each entity names the
     * regions it may be edited in, and a field must appear in one of them.
     */
    const wanted = {
        'characters.js updateCharacter': ['characterModal'],
        'locations.js updateLocation': ['locationModal', { fn: 'renderLocationSheet', span: 12000 }],
        'locations.js updateProp': ['propModal', { fn: 'renderPropSheet', span: 12000 }],
    };
    const handlers = updateHandlers();

    for (const [key, places] of Object.entries(wanted)) {
        const h = handlers.find(x => x.key === key);
        assert.ok(h, `${key} is gone — the denominator cannot be derived`);

        const present = new Set();
        const where = [];
        for (const place of places) {
            let markup;
            if (typeof place === 'string') {
                markup = modalMarkup(place);
                assert.ok(markup, `${place} is not in the page at all`);
                where.push(place);
            } else {
                const at = SPA.indexOf(`function ${place.fn}(`);
                assert.notStrictEqual(at, -1, `${place.fn} is not in the page at all`);
                markup = SPA.slice(at, at + place.span);
                where.push(place.fn);
            }
            for (const m of markup.matchAll(/data-field="([a-z_0-9]+)"/g)) present.add(m[1]);
            /*
             * A sheet builds its controls at RUNTIME, so `data-field="${field}"`
             * is what the source contains and the attribute name appears
             * nowhere in it. Read the call sites instead — the same reason
             * plate-upload.test.js executes uploadControl rather than grepping
             * for an attribute that is produced, not written.
             */
            for (const m of markup.matchAll(/ssField\('([a-z_0-9]+)'/g)) present.add(m[1]);
        }

        // A control named differently is still a control — the same allowance
        // the audit below makes, and for the same reason: a repeating list is
        // not one input, and refusing to say so would push a real editor into
        // the not-built list.
        const aliased = NAMED_DIFFERENTLY[key] || {};
        const missing = h.fields.filter(f => !present.has(f) && !aliased[f]);
        assert.deepStrictEqual(missing, [],
            `${key}: accepted by the route and stored, with no control in ${where.join(' or ')} — `
            + 'only an agent or curl can set them');
        for (const [field, spec] of Object.entries(aliased)) {
            assert.ok(h.fields.includes(field),
                `${key} claims ${field} is named differently and the route no longer takes it`);
            assert.ok(SPA.includes(spec.control),
                `${key}/${field} claims the control is ${spec.control}, which is not on the page`);
        }
    }
});

test('the style preset can be read and edited by hand', () => {
    /*
     * Pinned on its own because of what it is: appended to every image prompt
     * in the production, and previously settable only by a composer that
     * overwrites it wholesale. A director who cannot read this string cannot
     * find out why every frame looks the way it does.
     */
    assert.ok(hasControl('style_preset'),
        'style_preset has no control — the look of every frame is unreadable and unfixable by hand');
    assert.match(SPA, /id="settingsStylePreset"/);
    assert.match(SPA, /settingsStylePreset'\)\.value/,
        'the field is rendered but never read, so editing it does nothing');
    assert.match(SPA, /style_preset:\s*document\.getElementById\('settingsStylePreset'\)/,
        'the save does not send style_preset');
});

test('the subject warning is rendered as prose, not as an object', () => {
    // The route returns {subjects, detail}. Rendering it directly prints
    // "[object Object]" — a warning that teaches the reader to ignore warnings.
    const at = SPA.indexOf("settingsStyleWarning');");
    assert.notStrictEqual(at, -1, 'nothing renders the style warning');
    const region = SPA.slice(at, at + 900);
    assert.match(region, /style_warning\.detail/,
        'the warning is rendered without reading .detail, so it prints [object Object]');
});

test('every remaining gap is named, and nothing is silently missing', () => {
    /*
     * The audit, as a standing list. A handler with a gap must either have no
     * gap or appear in NOT_BUILT with a reason — so a field added to a route
     * without a control fails here rather than being discovered by someone
     * trying to type it.
     */
    const undocumented = [];
    for (const h of updateHandlers()) {
        const aliased = NAMED_DIFFERENTLY[h.key] || {};
        const missing = h.fields.filter(f => !hasControl(f) && !aliased[f]);
        if (missing.length && !NOT_BUILT[h.key]) {
            undocumented.push(`${h.key} — ${missing.join(', ')}`);
        }
    }
    assert.deepStrictEqual(undocumented, [],
        'these fields are accepted by a route, stored, and have no control and no stated reason');
});

test('a stale exemption is removed rather than left to rot', () => {
    // An entry claiming a gap that no longer exists makes the list a lie, and
    // the next reader stops trusting any of it.
    const handlers = updateHandlers();
    for (const key of Object.keys(NOT_BUILT)) {
        const h = handlers.find(x => x.key === key);
        assert.ok(h, `NOT_BUILT names ${key}, which is no longer a route handler`);
        const aliased = NAMED_DIFFERENTLY[h.key] || {};
        const missing = h.fields.filter(f => !hasControl(f) && !aliased[f]);
        assert.ok(missing.length,
            `${key} is listed as not built and every field now has a control — remove the entry`);
    }
});

test('a control claimed under another name actually exists on the page', () => {
    /*
     * NAMED_DIFFERENTLY is prose, and prose is not evidence. Each entry names
     * the control that serves the field, so the control has to be findable —
     * otherwise the list becomes a place to park a gap by describing it.
     */
    for (const [key, aliases] of Object.entries(NAMED_DIFFERENTLY)) {
        for (const [field, entry] of Object.entries(aliases)) {
            assert.ok(entry.control && entry.why,
                `${key}.${field}: an exemption must name its control AND say why`);
            assert.ok(SPA.includes(entry.control),
                `${key}.${field} claims control "${entry.control}", which is nowhere in the page`);
        }
    }
});
