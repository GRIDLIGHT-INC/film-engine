/**
 * Every preview the gate can ask for has to ANSWER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reported twice, the second time with real irritation: pressing Generate on a
 * location showed no prompt and no details.
 *
 * The gate was wired, the route existed, and the URL was wrong by one segment.
 * `previewSubjectPlate` is dispatched INSIDE the `urlParts[3] === 'plate'`
 * block, so it only answers `/locations/:id/plate/plate-preview` — while
 * regeneratePlate built `${base}-preview`, i.e. `/locations/:id/plate-preview`.
 * That URL matched nothing in the plate block and fell through to the plain
 * location GET, which answered **HTTP 200** with the location row and no
 * `prompt` at all. The dialog opened, found nothing to show, and rendered an
 * empty prompt.
 *
 * THIS IS WHY THE TEST FETCHES. Every static check passes on that: the handler
 * exists, the caller calls it, the response is 200. Only reading the BODY
 * distinguishes "the preview answered" from "something else answered instead".
 * The same lesson servedUrlFor and the mood-board image URL both record.
 *
 * Set-based over the preview URLs the page actually builds, extracted from the
 * source, because the failure is per-URL: two of these were already on the
 * correct `/plate/plate-preview` shape while the one the button used was not.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Every previewUrl the confirmation gate can be handed, from the page itself. */
function previewUrlExpressions() {
    /*
     * Multi-line tolerant: one of these wraps across lines, and a `[^,\n]+`
     * match cut it mid-template and reported a route segment of `${`.
     */
    return [...new Set([...UI.matchAll(/previewUrl:\s*([\s\S]*?),\n/g)]
        .map(m => m[1].replace(/\s+/g, ' ').trim()))];
}

/**
 * The URL shapes, with the placeholders named.
 *
 * Derived from the expressions above by stripping the JS: what is left is the
 * route shape, which is the thing that can be wrong by a segment.
 */
function shapeOf(expr) {
    return expr
        .replace(/^[`'"]|[`'"],?$/g, '')
        .replace(/\$\{[^}]*\}/g, ':id')
        .replace(/'\s*\+\s*[A-Za-z_$][\w$.]*\s*\+\s*'/g, ':id')
        .replace(/^[`'"]|[`'"]$/g, '')
        .trim();
}

/**
 * Endpoints that legitimately answer with a PLAN rather than one prompt, each
 * with the reason. The gate renders these as facts with the prompt box
 * disabled, which is why they are exempt from carrying `prompt` — but they must
 * still answer, so they are fetched exactly like the rest.
 */
const PLAN_SHAPED = {
    '/locations/:id/plate/compass/plan': 'a sweep of sides, priced — each side has its own prompt',
    '/sequences/:id/plan': 'a list of segments; each is built from its own two shots',
    '/sequences/:id/plan?expand=inbetweens': 'the strip, station by station',
    '/scenes/:id/music/brief': 'the facts a cue is written from; the model writes the direction',
    '/scenes/:id/ambient/brief': 'the facts a bed is written from',
};

test('every preview URL the page builds is a route shape the server dispatches', () => {
    /*
     * Static half: the shape must appear in a route file. This alone would NOT
     * have caught the reported bug -- `/plate-preview` appears in locations.js,
     * inside a block that URL never reaches -- which is why the fetch below
     * exists too. It is kept because it names a typo instantly.
     */
    const routeSrc = fs.readdirSync(path.join(__dirname, '..', 'routes'))
        .map(f => fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8')).join('\n');

    const missing = [];
    for (const expr of previewUrlExpressions()) {
        const shape = shapeOf(expr);
        if (shape === 'null' || !shape.startsWith('/')) continue;
    /*
     * The route SEGMENT, taken before any inline conditional. One expression
     * appends `${view ? `?view=…` : ''}`, whose stripped remains trail after
     * the segment and are not part of the path.
     */
        /*
         * The LEADING PATH only. One expression nests a template inside its
         * placeholder -- `…/preview${ view ? `?view=…` : '' }` -- which the
         * placeholder substitution cannot unwind, leaving debris after the real
         * segment. Everything a route dispatches on is in the leading path.
         */
        const clean = (shape.match(/^\/[A-Za-z0-9:_\-/.]*/) || [''])[0];
        // A route segment never contains a colon; the placeholder substitution
        // can glue `:id` straight onto one (`preview:id`).
        const last = (clean.split('/').filter(Boolean).pop() || '').split(':')[0];
        if (!new RegExp(`'${last}'`).test(routeSrc)) missing.push(shape);
    }
    assert.deepStrictEqual(missing, [],
        `these preview URLs name a segment no route dispatches on: ${missing.join(', ')}`);
});

test('every preview ANSWERS with something the dialog can show', async () => {
    const dir = path.join(os.tmpdir(), 'fe-prev-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const port = 3800 + Math.floor(Math.random() * 150);
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
        { env: { ...process.env, PORT: String(port), FILM_DATA_DIR: dir }, stdio: 'pipe' });
    proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
    const base = `http://localhost:${port}`;
    const call = (m, p, b) => fetch(base + p, {
        method: m, headers: { 'Content-Type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

    try {
        for (let i = 0; i < 120; i++) {
            try { if ((await fetch(base + '/api/health')).ok) break; } catch (_) {}
            await new Promise(r => setTimeout(r, 100));
        }

        const proj = (await call('POST', '/film/projects', { title: 'Preview probe' })).body;
        const pid = (proj.project || proj).id;
        const loc = (await call('POST', `/film/projects/${pid}/locations`,
            { name: 'DINER', description: 'A chrome diner at night.' })).body;
        const lid = (loc.location || loc).id;
        const prop = (await call('POST', `/film/projects/${pid}/props`,
            { name: 'RADIO', visual_prompt: 'A bakelite radio.' })).body;
        const rid = (prop.prop || prop).id;

        /*
         * The cases are DERIVED FROM THE PAGE, not typed here.
         *
         * Hardcoding the correct URLs made this agree with the fix instead of
         * testing it: a mutation reverting the refine preview to its
         * unreachable shape passed, because the test was asking for the right
         * URL rather than the one the page asks for. Caught by mutation.
         */
        const IDS = { location: lid, prop: rid };
        const SEEDED = /^\/(locations|props)\/:id\//;

        const skipped = [];
        const cases = [];
        for (const expr of previewUrlExpressions()) {
            const shape = shapeOf(expr);
            if (!shape.startsWith('/')) { continue; }
            if (PLAN_SHAPED[shape]) { skipped.push(`${shape} (plan-shaped)`); continue; }
            if (!SEEDED.test(shape)) { skipped.push(`${shape} (needs a subject this probe does not seed)`); continue; }
            const kind = shape.split('/')[1].replace(/s$/, '');
            const path0 = (shape.match(/^\/[A-Za-z0-9:_\-/.]*/) || [''])[0];
            cases.push({ url: '/film' + path0.replace(':id', IDS[kind]), what: shape });
        }

        assert.ok(cases.length >= 2,
            `only ${cases.length} preview URLs could be probed — the derivation is broken, and a `
            + 'probe that checks nothing reports the gap as closed');

        for (const c of cases) {
            const r = await call('GET', c.url);
            assert.strictEqual(r.status, 200, `${c.what}: GET ${c.url} returned ${r.status}`);
            assert.ok(r.body && typeof r.body.prompt === 'string' && r.body.prompt.length > 0,
                `${c.what}: answered 200 with no prompt — keys were `
                + `[${Object.keys(r.body || {}).slice(0, 10).join(', ')}]. Something other than the `
                + 'preview handled this URL, and the gate would open with an empty prompt.');
            /*
             * The FIELD must be present. Its value may legitimately be empty on
             * a project with no credentials -- which this temp install is.
             */
            assert.ok('provider' in r.body,
                `${c.what}: the response carries no provider field at all`);
        }
    } finally {
        proc.kill('SIGKILL');
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
});

test('the plate preview URL the page builds is the one the route dispatches', () => {
    /*
     * Bound to regeneratePlate specifically, because that is the function every
     * plate button now delegates to -- one wrong segment there silently
     * un-previews five buttons at once.
     */
    const at = UI.indexOf('async function regeneratePlate(');
    assert.ok(at > -1, 'regeneratePlate is gone');
    const body = UI.slice(at, UI.indexOf('\n    }', at));
    assert.ok(!/\$\{base\}-preview/.test(body),
        'regeneratePlate still builds `${base}-preview`, which is /locations/:id/plate-preview — '
        + 'a URL the plate block never sees, so it falls through to the plain subject GET and the '
        + 'gate opens with an empty prompt');
    assert.match(body, /\$\{base\}\/plate-preview/,
        'regeneratePlate does not request /plate/plate-preview, the shape the route dispatches');
});

test('every plan-shaped preview is exempt BY NAME, with a reason', () => {
    for (const [shape, why] of Object.entries(PLAN_SHAPED)) {
        assert.ok(why && why.length > 20, `${shape}: the exemption states no real reason`);
    }
    // and a stale exemption fails: each must still be requested by the page
    const shapes = previewUrlExpressions().map(shapeOf);
    for (const shape of Object.keys(PLAN_SHAPED)) {
        assert.ok(shapes.some(s => s === shape),
            `${shape} is exempted and the page no longer asks for it — a stale exemption makes `
            + 'the whole list a lie');
    }
});
