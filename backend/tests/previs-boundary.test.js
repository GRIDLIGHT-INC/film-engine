/**
 * The Apply boundary, pressure-tested.
 *
 * The parity matrix proved that a director's choices CAN cross between the
 * board and previs. This file asks the two questions that survive that: does
 * what the provider receives match what the director was shown, and can the
 * boundary be got around.
 *
 * Six findings from the critique of 1db640b, three raised by codex and three by
 * Claude, every one reproduced against live routes before being written down.
 * They share one shape: the surfaces AGREE while the requests DIVERGE, so
 * nothing on screen is visibly wrong and the frame comes back built from
 * something else.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '..', 'src', 'index.html');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-boundary-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handlePrevis } = require('../routes/previs');
const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
const { validateSceneCards } = require('../lib/scene-card-schema');

// Comments are not code. This suite has caught itself passing on a prose
// sentence more than once, so every source match runs against stripped text.
function stripComments(src) {
    let out = ''; let i = 0; let mode = null; let quote = '';
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (mode === null) {
            if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
            if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
            if (c === '"' || c === "'") { mode = 'str'; quote = c; out += c; i++; continue; }
            if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (mode === 'line') { if (c === '\n') { mode = null; out += c; } i++; continue; }
        if (mode === 'block') { if (c === '*' && d === '/') { mode = null; i += 2; } else i++; continue; }
        if (mode === 'str') { out += c; if (c === '\\') { out += d; i += 2; continue; } if (c === quote) mode = null; i++; continue; }
        out += c; if (c === '\\') { out += d; i += 2; continue; } if (c === '`') mode = null; i++;
    }
    return out;
}
const readCode = rel => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readUi = () => stripComments(fs.readFileSync(SRC, 'utf8').replace(/<!--[\s\S]*?-->/g, ''));

// ── Fixtures ────────────────────────────────────────────────────────────────

const SENTINEL = 'zqboundaryprobe';
const BLOCKING = {
    camera: { position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 137,
        sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
    subject: { position: [0, 0, 0], heightM: 1.7 },
    stage: { widthM: 12, depthM: 12 }, rig: 'dolly', movement: 'dolly-in',
};

function callPrevis(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const req = { method, body: body || {} };
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            const raw = Buffer.concat(chunks).toString();
            let parsed = raw;
            try { parsed = JSON.parse(raw); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handlePrevis(req, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function seedShot(card, extra) {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Boundary');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, ?)')
        .run(shotId, sceneId, 'P1', JSON.stringify(card), 4000);
    if (extra) extra(projectId);
    return { projectId, shotId };
}

const baseCard = () => ({ shot_code: 'P1', description: 'Probe.',
    camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' } });
const cardOf = shotId => JSON.parse(
    db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId).scene_card_yaml || '{}');
const directorOf = shotId => {
    const row = db.prepare('SELECT director_json FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    try { return JSON.parse((row && row.director_json) || '{}'); } catch (_) { return {}; }
};

// ── #1 The preview and the purchase must be built the same way ──────────────

test('#1 no paid route builds a prompt outside the shared capability path', () => {
    /*
     * routes/storyboard.js calls buildStoryboardPrompt directly for generate-all,
     * the streaming generate and per-shot regenerate, and routes/video-gen.js
     * defines its OWN loadShotContext and calls buildVideoPayload directly in
     * four places. Neither file mentions previs at all in those paths, while
     * /shots/:id/prompt and /previs/to-{storyboard,video} go through
     * loadShotContext + buildCapabilityPayload and DO carry it.
     *
     * So the free preview is not merely different from the purchase, it is
     * BETTER than it: the director is shown their staging honoured and pays for
     * a frame that never received it. That is the refine-preview lie one level
     * up, and the reason the fix is "share the builder" rather than "pass previs
     * into three more calls" — a fourth call site added later would diverge
     * again with nothing failing.
     *
     * Structural by necessity: exercising the paid routes means paying a
     * provider. What it derives is the call graph, which is exactly where the
     * divergence lives.
     */
    const BUILDERS = ['buildStoryboardPrompt', 'buildVideoPayload'];
    const PAID_ROUTES = ['routes/storyboard.js', 'routes/video-gen.js'];

    const offences = [];
    for (const rel of PAID_ROUTES) {
        const src = readCode(rel);
        for (const b of BUILDERS) {
            const calls = (src.match(new RegExp(`\\b${b}\\s*\\(`, 'g')) || []).length;
            if (calls) offences.push(`${rel}: ${calls} direct ${b}() call(s) outside buildCapabilityPayload`);
        }
        // A private context loader is how a route comes to know less than the
        // shared one without anybody noticing.
        if (/function loadShotContext\s*\(/.test(src)) {
            offences.push(`${rel}: defines its own loadShotContext`);
        }
    }
    assert.deepStrictEqual(offences, [],
        'a paid route builds its request by a different path than the preview the director approved');
});

// ── #2 Durable generation uses APPLIED blocking; preview opts in ────────────

test('#2 unapplied staging does not reach a durable payload unless asked for', async () => {
    /*
     * loadShotContext attaches the blocking row as ctx.previs regardless of
     * application state, and both the image and video builders read it. So an
     * experiment a director never committed conditions paid generation through
     * the shared path — the Apply boundary is disclosure-only for anything that
     * is not the previs preview.
     *
     * Set-based over the capabilities whose builder actually reads ctx.previs,
     * derived from the source rather than named here, so a capability that
     * starts consuming blocking later is covered with nothing to remember.
     */
    const payloadSrc = readCode('lib/capability-payloads.js');
    const consumers = ['image', 'video'].filter(cap => {
        const m = payloadSrc.match(new RegExp(`${cap}\\s*[:(][\\s\\S]{0,4000}?ctx\\.previs`));
        return !!m;
    });
    assert.ok(consumers.length, 'no capability reads ctx.previs — the derivation is wrong, not the code');

    const { shotId } = seedShot(baseCard());
    const saved = await callPrevis('PUT', `/film/shots/${shotId}/previs`,
        { ...BLOCKING, director: { direction: SENTINEL } });
    assert.ok(saved.status < 400, 'fixture blocking did not save');

    const leaked = [];
    for (const cap of consumers) {
        const ctx = await loadShotContext(shotId);
        let payload;
        try {
            const built = await buildCapabilityPayload(cap, ctx);
            payload = JSON.stringify(built && built.payload !== undefined ? built.payload : built);
        } catch (err) {
            if (err && err.code === 'PRECONDITION') continue;
            throw err;
        }
        // 137mm is not on the card; it exists only on the unapplied stage.
        if (payload.includes(SENTINEL)) leaked.push(`${cap}: unapplied director intent reached the payload`);
        if (/137\s*mm/.test(payload)) leaked.push(`${cap}: unapplied staged lens reached the payload`);
    }
    assert.deepStrictEqual(leaked, [],
        'durable generation consumed an experiment the director never committed');
});

// ── #3 The fingerprint must match what Apply actually does ──────────────────

test('#3 only a change Apply would carry marks the stage staged', async () => {
    /*
     * applicationFingerprints hashes every named staged object, in order and
     * case-sensitively. Apply keeps only names matching registered characters
     * or props, and unions them case-insensitively and order-independently. So
     * reordering the stage, changing MAYA to Maya, or dropping in a named
     * set-piece all report `staged` while Apply would change nothing.
     *
     * That is the warning-noise failure this codebase has written down twice —
     * a warning that fires on work nobody needs to redo is one people learn to
     * dismiss, and then the real one is dismissed too.
     *
     * Set-based over the mutations, because they fail independently: a
     * normalisation that sorts but does not lowercase passes the reorder case
     * and still fires on a rename.
     */
    const MUTATIONS = [
        { id: 'reorder', expect: 'applied',
            why: 'Apply unions names, so their order on the stage cannot change the card',
            mutate: subs => [...subs].reverse() },
        { id: 'recase', expect: 'applied',
            why: 'Apply matches case-insensitively, so MAYA and Maya are the same subject',
            mutate: subs => subs.map(o => ({ ...o, name: String(o.name).toLowerCase() })) },
        { id: 'unregistered-helper', expect: 'applied',
            why: 'an unnamed-to-the-project helper is scaffolding and never reaches the card',
            mutate: subs => [...subs, { kind: 'cube', name: 'PROXY WALL', position: [2, 0, 1] }] },
        { id: 'registered-cast', expect: 'staged',
            why: 'a cast member the card does not have IS a change Apply would carry',
            mutate: subs => [...subs, { kind: 'human', name: 'DRAGON', position: [1, 0, 2], heightM: 4 }] },
    ];

    const wrong = [];
    for (const m of MUTATIONS) {
        const { projectId, shotId } = seedShot(baseCard(), pid => {
            for (const n of ['MAYA', 'DRAGON']) {
                db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)')
                    .run(generateId(), pid, n);
            }
        });
        void projectId;
        const subjects = [
            { kind: 'human', name: 'MAYA', position: [0, 0, 0], heightM: 1.7 },
            { kind: 'cube', name: 'CRATE', position: [1, 0, 1] },
        ];
        const put = await callPrevis('PUT', `/film/shots/${shotId}/previs`, { ...BLOCKING, subjects });
        if (put.status >= 400) { wrong.push(`${m.id}: fixture blocking refused`); continue; }
        const applied = await callPrevis('POST', `/film/shots/${shotId}/previs/apply`);
        if (applied.status >= 400) { wrong.push(`${m.id}: apply refused`); continue; }

        const after = await callPrevis('PUT', `/film/shots/${shotId}/previs`,
            { ...BLOCKING, subjects: m.mutate(subjects) });
        if (after.status >= 400) { wrong.push(`${m.id}: restage refused`); continue; }

        const got = (await callPrevis('GET', `/film/shots/${shotId}/previs`)).body || {};
        const state = (got.application && got.application.state) || 'unknown';
        if (state !== m.expect) wrong.push(`${m.id}: expected ${m.expect}, got ${state} — ${m.why}`);
    }
    assert.deepStrictEqual(wrong, [], 'the applied fingerprint does not match what Apply carries');
});

// ── #4 The internal seed flag must not be settable by a caller ──────────────

test('#4 no public writer can forge the applied state', async () => {
    /*
     * putBlocking reads `_seededFromCard` off the REQUEST BODY, while fromCard
     * sets it server-side on the same object. putBlocking is a public route and
     * MCP previs_set forwards its arguments verbatim, so any caller — including
     * an agent host that passes a field through by accident — can mark staging
     * as applied without the card ever receiving it. Everything built for this
     * boundary is bypassed by one body key.
     *
     * Enumerated over every public writer rather than tested on PUT alone: the
     * flag is read in one place today, and the fix has to be "the body cannot
     * carry internal fields", which is a property of every route.
     */
    const previsSrc = readCode('routes/previs.js');
    const HTTP_WRITERS = [];
    const dispatch = previsSrc.match(/urlParts\[4\] === '([a-z-]+)'[\s\S]{0,200}?req\.method !== '(POST|PUT)'/g) || [];
    for (const d of dispatch) {
        const seg = d.match(/urlParts\[4\] === '([a-z-]+)'/);
        const method = d.match(/req\.method !== '(POST|PUT)'/);
        if (seg && method) HTTP_WRITERS.push({ id: seg[1], method: method[1], suffix: `/${seg[1]}` });
    }
    HTTP_WRITERS.push({ id: 'previs', method: 'PUT', suffix: '' });

    // listTools() returns only the wire shape (name/description/inputSchema),
    // so the HTTP method lives on the registry rather than the listing. Reading
    // the wrong one silently derived an empty set, which the guard below caught.
    // ALL_ROUTE_TOOLS, not ROUTE_TOOLS: the previs tools live in the production
    // set, and reading the flows-only registry derived an empty list.
    const { ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');
    const MCP_WRITERS = (ALL_ROUTE_TOOLS || [])
        .filter(t => /^previs_/.test(t.name) && /^(POST|PUT)$/.test(t.method || ''))
        .map(t => t.name);
    assert.ok(HTTP_WRITERS.length && MCP_WRITERS.length, 'no writers derived — the derivation is wrong');

    /*
     * DIFFERENTIAL, not absolute. from-card legitimately sets the flag
     * server-side and legitimately reports applied, so asking "did this route
     * end up applied" flags it as a forgery. The real question is narrower and
     * exact: does supplying the field in the BODY change anything? If the two
     * runs differ, an internal field rode in on a request.
     */
    const stateAfter = async (write, shotId) => {
        const r = await write(shotId);
        if (r && r.status >= 400) return null;
        const got = (await callPrevis('GET', `/film/shots/${shotId}/previs`)).body || {};
        return (got.application && got.application.state) || 'none';
    };

    const forged = [];
    for (const w of HTTP_WRITERS) {
        const body = { ...BLOCKING, director: { direction: SENTINEL } };
        const clean = await stateAfter(
            id => callPrevis(w.method, `/film/shots/${id}/previs${w.suffix}`, { ...body }),
            seedShot(baseCard()).shotId);
        const spiked = await stateAfter(
            id => callPrevis(w.method, `/film/shots/${id}/previs${w.suffix}`,
                { ...body, _seededFromCard: true }),
            seedShot(baseCard()).shotId);
        if (clean === null || spiked === null) continue;   // not a writer for this body
        if (clean !== spiked) {
            forged.push(`HTTP ${w.method} …/previs${w.suffix}: body flag changed ${clean} -> ${spiked}`);
        }
    }

    const { callTool } = require('../lib/mcp-tools');
    for (const name of MCP_WRITERS) {
        const run = async spike => {
            const { shotId } = seedShot(baseCard());
            try {
                await callTool(name, { shot_id: shotId, ...BLOCKING,
                    director: { direction: SENTINEL }, ...(spike ? { _seededFromCard: true } : {}) });
            } catch (_) { return null; }
            const got = (await callPrevis('GET', `/film/shots/${shotId}/previs`)).body || {};
            return (got.application && got.application.state) || 'none';
        };
        const clean = await run(false);
        const spiked = await run(true);
        if (clean === null || spiked === null) continue;
        if (clean !== spiked) forged.push(`MCP ${name}: body flag changed ${clean} -> ${spiked}`);
    }

    assert.deepStrictEqual(forged, [],
        'the applied state is forgeable from the request body — internal fields must not ride in on it');
});

// ── #5 A write about the camera must not delete the director's words ───────

test('#5 a partial write preserves staged director intent', async () => {
    /*
     * putBlocking writes `director: body.director || {}` and the upsert sets
     * director_json = excluded.director_json, so any save that omits director
     * replaces it with {}. The SPA always sends it, which is exactly what makes
     * this dangerous: invisible in the UI, live for MCP previs_set and any
     * partial save written against the API later.
     *
     * Same class as the board-ahead revert already fixed this round — a
     * director's words destroyed by an action about the camera.
     */
    const { listTools, callTool } = require('../lib/mcp-tools');
    const writers = [
        { id: 'HTTP PUT /previs',
            write: (shotId, body) => callPrevis('PUT', `/film/shots/${shotId}/previs`, body) },
        ...listTools().filter(t => t.name === 'previs_set').map(t => ({
            id: `MCP ${t.name}`,
            write: (shotId, body) => callTool(t.name, { shot_id: shotId, ...body }),
        })),
    ];

    const lost = [];
    for (const w of writers) {
        const { shotId } = seedShot(baseCard());
        const staged = { direction: SENTINEL, location_view: 'north' };
        await w.write(shotId, { ...BLOCKING, director: staged });
        if (JSON.stringify(directorOf(shotId)) !== JSON.stringify(staged)) {
            lost.push(`${w.id}: could not stage director intent at all`); continue;
        }
        // A save about the CAMERA only.
        await w.write(shotId, { ...BLOCKING, camera: { ...BLOCKING.camera, focalMm: 85 } });
        const after = directorOf(shotId);
        for (const [k, v] of Object.entries(staged)) {
            if (after[k] !== v) lost.push(`${w.id}: ${k} ${JSON.stringify(v)} -> ${JSON.stringify(after[k])}`);
        }
    }
    assert.deepStrictEqual(lost, [],
        'a camera-only save deleted staged director intent');
});

// ── #6 The screen that spends money must disclose staged intent ────────────

test('#6 every paid confirmation that can read previs discloses staged intent', () => {
    /*
     * Link 3b was "disclosed in the surface AND in the pre-spend confirmation".
     * The server returns staged_notice from the board's own prompt preview, and
     * src/index.html reads it in exactly one place — previs's free preview. The
     * board's confirmGeneration fetches the very endpoint that carries it and
     * renders nothing, so the one screen between a director and a purchase is
     * silent about unapplied staging.
     *
     * The set is DERIVED FROM THE CALL GRAPH rather than from the word
     * "confirm": refine and recompose operate on an existing frame with their
     * own contracts and do not consume scene-card blocking, so demanding a
     * staged notice from them would assert a dependency they do not have.
     * A confirmation is in scope exactly when it fetches an endpoint whose
     * route emits staged_notice.
     */
    /*
     * Derived precisely: find the FUNCTIONS whose response carries
     * staged_notice, then the dispatch segment that routes to each. A looser
     * derivation — every url segment mentioned anywhere in a file that contains
     * the word — matched 'projects' and 'shots' and so flagged the project
     * delete dialog as owing a staging warning. A derivation that over-matches
     * produces confident nonsense, which is worse than one that under-matches
     * because somebody acts on it.
     */
    const emitting = [];
    for (const rel of ['routes/storyboard.js', 'routes/previs.js']) {
        const src = readCode(rel);
        for (const fn of src.matchAll(/function ([A-Za-z0-9_]+)\s*\([\s\S]*?\n}/g)) {
            if (!/staged_notice/.test(fn[0])) continue;
            const name = fn[1];
            for (const d of src.matchAll(new RegExp(`urlParts\\[\\d\\] === '([a-z-]+)'[\\s\\S]{0,220}?\\b${name}\\s*\\(`, 'g'))) {
                emitting.push(d[1]);
            }
        }
    }
    assert.ok(emitting.length, 'no route emits staged_notice — the derivation is wrong');

    const ui = readUi();
    const fns = [...ui.matchAll(/async function (confirm[A-Za-z0-9_]*)\s*\([\s\S]*?\n    \}/g)];
    assert.ok(fns.length, 'no confirmation functions found in the SPA');

    const silent = [];
    for (const [body, name] of fns.map(m => [m[0], m[1]])) {
        const reads = emitting.some(seg => new RegExp(`/${seg}\\b`).test(body));
        if (!reads) continue;                       // cannot carry previs state
        if (!/staged_notice/.test(body)) {
            silent.push(`${name}() fetches an endpoint carrying staged_notice and never shows it`);
        }
    }
    assert.deepStrictEqual(silent, [],
        'a paid confirmation is silent about staging the director has not applied');
});

// ── #7 A refusal a director cannot get past ─────────────────────────────────

test('#7 every generation gate can be overridden deliberately', () => {
    /*
     * This codebase refuses a paid action in five places, and until now every
     * one of them could be got past on purpose: the board lock takes
     * ignore_lock, a stale previs approval takes ignore_approval, the budget
     * gate takes ignore_budget, stale inputs take ignore_stale. The reasoning
     * is written down in each: "a refusal you cannot get past is a reason never
     * to lock at all".
     *
     * The staged gate added this round has no override, and it is the only one
     * that DISABLES THE BUTTON rather than refusing with an explanation. So a
     * shot carrying blocking somebody staged and never applied — which is the
     * normal resting state of exploration, and the state this whole boundary
     * exists to make safe — can no longer be generated from the board at all.
     * Not from the stage, not from the card that is sitting there valid and
     * unchanged. Exploring in previs now costs you the ability to generate.
     *
     * That inverts the Apply boundary. The point was that trying an angle must
     * not commit it; the cost of that must not become "and now you cannot shoot
     * the shot as written".
     *
     * Derived from the gates themselves rather than listed, so a sixth added
     * later is held to the same rule.
     */
    const sources = ['routes/storyboard.js', 'routes/previs.js'];
    const gates = new Set();
    for (const rel of sources) {
        for (const m of readCode(rel).matchAll(/\bignore_([a-z_]+)\b/g)) gates.add(m[1]);
    }
    assert.ok(gates.size >= 3, 'no override gates derived — the derivation is wrong');

    // The staged refusal is a gate in exactly the same sense: it stops a paid
    // action on a condition the director may legitimately disagree with.
    const ui = readUi();
    const board = ui.match(/async function confirmGeneration\([\s\S]*?\n    \}/);
    assert.ok(board, 'confirmGeneration is gone');

    const refuses = /confirmGenArm\(false\)[^\n]*\n|if \([^)]*staged[^)]*\)\s*confirmGenArm\(false\)/.test(board[0])
        && /staged/.test(board[0]);
    if (!refuses) return;   // no staged refusal to override

    const overridable = gates.has('staged') || gates.has('previs')
        || /generate anyway|ignore_staged|ignore_previs/i.test(board[0]);
    assert.ok(overridable,
        'the staged gate refuses a paid action with no way past it, while every other '
        + `gate here (${[...gates].map(g => 'ignore_' + g).join(', ')}) can be overridden deliberately`);
});
