/**
 * Board <-> previs decision parity.
 *
 * The director's ask: "whatever choices I make in either they're reflected
 * across". Today they are not, and the shape of the gap is what makes an
 * example-based test useless here -- SOME decisions already cross. Camera
 * facets round-trip through /previs/apply and /previs/from-card, so a test
 * written against "the lens reaches previs" passes right now, while direction,
 * location_view, anchor, keep_plates and annotation_feedback appear ZERO times
 * in routes/previs.js. Half the surface works. That is exactly the state a
 * worked example cannot see.
 *
 * So this is set-based over a DERIVED union of director decisions, and every
 * decision is held to five links:
 *
 *   (1) operable    -- there is a control for it on BOTH surfaces
 *   (2) persists    -- it is written to its canonical home
 *   (3a) rehydrates -- an APPLIED decision reappears on the other surface
 *   (3b) discloses  -- UNAPPLIED staged intent is visibly marked as staged,
 *                      in the surface AND in the pre-spend confirmation
 *   (4) previews    -- it appears in the pre-spend preview
 *   (5) reaches     -- it reaches both the image and the video payload
 *
 * (3) is split into 3a/3b deliberately. With a single "rehydrates" link, the
 * cheapest way to turn this suite green is to auto-apply every previs drag
 * straight onto the scene card -- which passes, and destroys the thing the
 * director actually asked for. Previs is where you TRY an angle; if trying it
 * commits it, you stop trying. So staged-and-unapplied is a legal state, and
 * what the code owes it is disclosure, not persistence.
 *
 * THE DENOMINATOR IS DERIVED, NEVER TYPED. A hand-written list of "the
 * decisions" is a second copy of the truth and rots the first time somebody
 * adds a field -- and it rots silently, because the test keeps passing on the
 * decisions it still remembers. The union comes from three code sources:
 *
 *   A. routes/shots.js EDITABLE     -- what a director may change on a card
 *   B. film_previs_blocking columns -- what the stage stores, minus bookkeeping
 *   C. film_projects switches read by the generation path
 *
 * WHAT THIS TEST EXPECTS TO EXIST (the contract codex is drafting):
 *
 *   lib/decision-contract.js
 *     module.exports = { DECISIONS, EXCEPTIONS }
 *
 *   DECISIONS: [{
 *     id:        'camera.lens',           // stable id
 *     covers:    ['camera'],              // which derived candidates it accounts for
 *     canonical: 'scene_card',            // 'scene_card' | 'film_projects' | 'request'
 *     previs:    'camera_json.focal_mm',  // where it lives on the stage, or null
 *     surfaces:  ['board', 'previs'],
 *     staged_disclosure: true,            // 3b applies (it can be staged)
 *     payloads:  ['image', 'video'],
 *   }]
 *
 *   EXCEPTIONS: [{ id: 'staging.unnamed', covers: [...], why: '<non-empty>' }]
 *
 * An exception with an empty `why` is a silent omission wearing a label, so it
 * is rejected here. That is the rule that stops a gap being retro-declared a
 * boundary once fixing it turns out to be work.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '..', 'src', 'index.html');

// ── Comment stripping ───────────────────────────────────────────────────────
//
// This codebase has paid for this three times. Function.toString() and a plain
// file read both include comments, so a prose sentence that merely MENTIONS a
// field makes a substring check pass while nothing in the code reads it. Every
// match below runs against stripped source.

function stripComments(src) {
    let out = '';
    let i = 0;
    let mode = null; // 'line' | 'block' | 'str' | 'tpl'
    let quote = '';
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
        if (mode === 'str') {
            out += c;
            if (c === '\\') { out += d; i += 2; continue; }
            if (c === quote) mode = null;
            i++; continue;
        }
        if (mode === 'tpl') {
            out += c;
            if (c === '\\') { out += d; i += 2; continue; }
            if (c === '`') mode = null;
            i++; continue;
        }
    }
    return out;
}

function readCode(rel) {
    return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// HTML: strip <!-- --> and then JS comments inside <script>.
function readUi() {
    const raw = fs.readFileSync(SRC, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    return stripComments(raw);
}

// ── A. Card decisions, derived from routes/shots.js ─────────────────────────

function deriveCardDecisions() {
    const src = readCode('routes/shots.js');
    const m = src.match(/EDITABLE\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(m, 'routes/shots.js no longer declares EDITABLE — the denominator source moved');
    return m[1].split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
}

// ── B. Stage decisions, derived from the live schema ────────────────────────
//
// Bookkeeping is excluded by an explicit, stated rule rather than by taste:
// identity, foreign keys, timestamps and approval bookkeeping are not things a
// director decides about a shot. Anything else the stage stores IS a decision
// and has to be accounted for.

const STAGE_BOOKKEEPING = /^(id|shot_id|created_at|updated_at|approved_fingerprint|approved_at)$/;

function deriveStageDecisions() {
    const sql = fs.readFileSync(path.join(ROOT, 'db/migrations/058_previs_blocking.sql'), 'utf8');
    const body = sql.match(/CREATE TABLE IF NOT EXISTS film_previs_blocking\s*\(([\s\S]*?)\n\);/);
    assert.ok(body, 'migration 058 no longer declares film_previs_blocking');
    const cols = new Set();
    for (const line of body[1].split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('--')) continue;
        const cm = t.match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)/i);
        if (cm) cols.add(cm[1]);
    }
    // Columns added later carry the same weight as columns present at creation.
    for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations'))) {
        const s = fs.readFileSync(path.join(ROOT, 'db/migrations', f), 'utf8');
        const re = /ALTER TABLE film_previs_blocking ADD COLUMN ([a-z_]+)/g;
        let a;
        while ((a = re.exec(s))) cols.add(a[1]);
    }
    return [...cols].filter(c => !STAGE_BOOKKEEPING.test(c));
}

// ── C. Project switches the generation path actually reads ──────────────────
//
// Derived from use, not from the migration list: a column nothing reads is not
// a director decision, it is storage. So the candidate set is the film_projects
// columns that the board's own generation code names.

function deriveProjectSwitches() {
    const files = ['routes/storyboard.js', 'lib/shot-anchor.js', 'lib/shot-references.js'];
    const known = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations'))) {
        const s = fs.readFileSync(path.join(ROOT, 'db/migrations', f), 'utf8');
        const re = /ALTER TABLE film_projects ADD COLUMN ([a-z_]+)/g;
        let a;
        while ((a = re.exec(s))) known.add(a[1]);
    }
    const used = new Set();
    for (const f of files) {
        const src = readCode(f);
        for (const col of known) {
            if (new RegExp(`\\b${col}\\b`).test(src)) used.add(col);
        }
    }
    // Locks and pointers are project state, not per-shot creative decisions.
    return [...used].filter(c => !/^(board_locked_at|current_frame_version)$/.test(c));
}

// ── The derived union ───────────────────────────────────────────────────────

function deriveCandidates() {
    const out = [];
    for (const id of deriveCardDecisions()) out.push({ id, origin: 'scene_card' });
    for (const id of deriveStageDecisions()) out.push({ id, origin: 'previs_blocking' });
    for (const id of deriveProjectSwitches()) out.push({ id, origin: 'film_projects' });
    return out;
}

// ── Link probes, run against the real code ──────────────────────────────────
//
// Each probe answers one question about one candidate by looking at the code
// that would have to change for the answer to become yes. They are deliberately
// generous -- a token appearing anywhere in the stripped source counts -- so a
// FAILURE here is a strong signal: the field is not mentioned at all.

const PREVIS = readCode('routes/previs.js');
const SHOTS = readCode('routes/shots.js');
const STORYBOARD = readCode('routes/storyboard.js');
const PAYLOADS = readCode('lib/capability-payloads.js');
const PROMPT = readCode('lib/storyboard-prompt.js');
const VIDEO = readCode('lib/video-prompt.js');
const UI = readUi();

// A stage column named `foo_json` is decided as `foo` in every surface that is
// not SQL, so both spellings count as the same decision.
function tokensFor(id) {
    const t = new Set([id]);
    if (id.endsWith('_json')) t.add(id.slice(0, -5));
    if (id === 'subjects_json' || id === 'subject_json') { t.add('subjects'); t.add('subject'); }
    if (id === 'path_json') { t.add('path'); }
    if (id === 'moves_json') { t.add('moves'); }
    if (id === 'camera_json') { t.add('camera'); }
    if (id === 'stage_json') { t.add('stage'); }
    return [...t];
}

function mentions(src, id) {
    return tokensFor(id).some(t => new RegExp(`\\b${t}\\b`).test(src));
}

function probe(cand) {
    const id = cand.id;
    return {
        // (1) operable on both surfaces
        board: mentions(SHOTS, id) || mentions(STORYBOARD, id) || mentions(UI, id),
        previs: mentions(PREVIS, id),
        // (3a) applied decisions rehydrate: it must cross in BOTH directions.
        // Direction is the identity -- apply(blocking->card) existing says
        // nothing about from-card(card->blocking), and it was the second that
        // was missing while the pair was being called a round trip.
        apply: (() => {
            const m = PREVIS.match(/function applyBlockingToCard[\s\S]*?\n}/);
            return !!m && mentions(m[0], id);
        })(),
        seed: (() => {
            const m = PREVIS.match(/function fromCard[\s\S]*?\n}/);
            return !!m && mentions(m[0], id);
        })(),
        // (4) pre-spend preview
        preview: mentions(STORYBOARD, id) && /confirm|preview|shot_prompt|prompt_preview/i.test(STORYBOARD),
        // (5) reaches both payloads
        image: mentions(PAYLOADS, id) || mentions(PROMPT, id),
        video: mentions(PAYLOADS, id) || mentions(VIDEO, id),
    };
}

// ── The matrix ──────────────────────────────────────────────────────────────

function loadContract() {
    try {
        return require('../lib/decision-contract');
    } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND' && /decision-contract/.test(e.message)) return null;
        throw e;
    }
}

test('every derived director decision is accounted for by the contract', () => {
    const candidates = deriveCandidates();
    const contract = loadContract();

    if (!contract) {
        const lines = candidates.map(c => `  ${c.origin.padEnd(16)} ${c.id}`);
        assert.fail(
            `lib/decision-contract.js does not exist.\n\n`
            + `${candidates.length} director decisions derived from code and accounted for by nothing:\n`
            + lines.join('\n')
            + `\n\nEach must appear in DECISIONS (with its five links) or in EXCEPTIONS `
            + `(with a non-empty why).`);
    }

    const { DECISIONS = [], EXCEPTIONS = [] } = contract;
    const covered = new Set();
    for (const d of DECISIONS) for (const c of d.covers || []) covered.add(c);
    for (const e of EXCEPTIONS) for (const c of e.covers || []) covered.add(c);

    const orphans = candidates.filter(c => !covered.has(c.id));
    assert.deepStrictEqual(orphans.map(o => `${o.origin}:${o.id}`), [],
        'derived decisions the contract does not account for');
});

test('every exception states a non-empty why', () => {
    const contract = loadContract();
    if (!contract) { assert.fail('lib/decision-contract.js does not exist'); }
    const bad = (contract.EXCEPTIONS || [])
        .filter(e => !e.why || !String(e.why).trim())
        .map(e => e.id);
    assert.deepStrictEqual(bad, [],
        'an exception with no why is a silent omission wearing a label');
});

test('the five links hold for every contracted decision', () => {
    const candidates = deriveCandidates();
    const contract = loadContract();
    const excepted = new Set();
    if (contract) for (const e of contract.EXCEPTIONS || []) for (const c of e.covers || []) excepted.add(c);

    const rows = [];
    const broken = [];
    for (const cand of candidates) {
        if (excepted.has(cand.id)) continue;
        const p = probe(cand);
        const gaps = [];
        if (!p.board) gaps.push('1:board');
        if (!p.previs) gaps.push('1:previs');
        if (!p.apply) gaps.push('3a:blocking->card');
        if (!p.seed) gaps.push('3a:card->blocking');
        if (!p.preview) gaps.push('4:preview');
        if (!p.image) gaps.push('5:image');
        if (!p.video) gaps.push('5:video');
        rows.push(`  ${cand.origin.padEnd(16)} ${cand.id.padEnd(18)} ${gaps.length ? gaps.join(' ') : 'ok'}`);
        if (gaps.length) broken.push(cand.id);
    }

    assert.deepStrictEqual(broken, [],
        `decisions that do not cross both surfaces:\n${rows.join('\n')}\n`);
});

test('unapplied previs staging is disclosed as staged (3b)', () => {
    // The Apply boundary is the constraint most likely to be eroded while the
    // other links are being fixed: auto-applying every previs drag turns links
    // 1-5 green and deletes exploration. So staged-and-unapplied must be a
    // state the code can NAME -- in what previs returns, and in the pre-spend
    // confirmation, which is the last screen before money is spent.
    //
    // Deliberately NOT a search for the word "staged". This suite has already
    // caught itself passing on a validation string about framing subjects, and
    // that is the whole failure mode: a word in the source is not a disclosure
    // to a director. Each probe below names a structure that must exist.
    const gaps = [];

    // The previs previews (/to-storyboard, /to-video) must report whether what
    // they just described has been applied, or a director reads a preview of
    // uncommitted staging as a preview of the shot.
    for (const fn of ['toStoryboard', 'toVideo']) {
        const m = PREVIS.match(new RegExp(`function ${fn}[\\s\\S]*?\\n}`));
        if (!m) { gaps.push(`routes/previs.js has no ${fn}`); continue; }
        if (!/\b(staged|applied|unapplied|is_applied)\b\s*:/.test(m[0])) {
            gaps.push(`${fn}() previews staged intent without reporting whether it is applied`);
        }
    }

    // The pre-spend confirmation is where money is committed. It must be able
    // to say the blocking behind this frame is staged and not applied.
    if (!/staged/.test(STORYBOARD)) {
        gaps.push('the pre-spend path cannot tell a director the blocking is staged');
    }

    // Unnamed staging is a declared eligibility rule, not a silent omission:
    // anonymous helpers are scaffolding, and serialising them puts literal
    // boxes and markers in the image. The rule is right; the silence is not --
    // a director stages a wall, it never appears, and nothing says why.
    const uiDiscloses = /unnamed[^;]{0,80}(not sent|won't be sent|will not be sent|excluded|ignored)/i.test(UI)
        || /(not sent|excluded)[^;]{0,60}unnamed/i.test(UI);
    if (!uiDiscloses) {
        gaps.push('the surface never counts or warns about unnamed staging objects that generation drops');
    }

    assert.deepStrictEqual(gaps, [], 'the Apply boundary is not disclosed');
});

// ── Behavioural: a previs round trip must not destroy board decisions ───────
//
// The probes above are mention-based, which makes a FAILURE strong and a PASS
// weak: `camera` reads ok partly because the word appears everywhere in these
// files. That asymmetry is fine for finding gaps and useless for confirming
// they are closed -- and this suite exists to be believed once it goes green.
//
// So the round-trip link is also checked by running it. A director sets a value
// on the board, opens previs, and applies an angle. Every decision they had
// already made must still be there. This is the failure that costs real work:
// applying a camera angle silently dropping the direction, the location view or
// the dialogue, discovered later as a frame generated from a card that quietly
// lost half of itself.
//
// Sample values are DISCOVERED, not typed: each field is offered a ladder of
// candidate shapes and the first one the real validator accepts is used. A
// hand-written fixture per field is a second copy of the schema and goes stale
// the first time a rule changes -- silently, because the test keeps passing on
// the shape it still remembers.

const os = require('os');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-parity-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();
const { handlePrevis } = require('../routes/previs');
const { validateSceneCards } = require('../lib/scene-card-schema');

const CANDIDATES = [
    'parity-probe-value',
    ['PARITY_PROBE'],
    [{ character: 'PARITY_PROBE', line: 'Mark.' }],
    { type: 'day', notes: 'parity probe' },
    { shot_type: 'wide' },
    4,
];

function sampleFor(field) {
    for (const v of CANDIDATES) {
        const card = { shot_code: 'P1', description: 'Probe.' , [field]: v };
        if (validateSceneCards([card]).valid) return v;
    }
    return undefined;
}

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

function seedShot(card) {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Parity');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, ?)')
        .run(shotId, sceneId, 'P1', JSON.stringify(card), 4000);
    return shotId;
}

test('a previs round trip preserves every board decision', async () => {
    const fields = deriveCardDecisions();
    const lost = [];
    const unsampled = [];

    for (const field of fields) {
        const sample = sampleFor(field);
        if (sample === undefined) { unsampled.push(field); continue; }

        const card = { shot_code: 'P1', description: 'Probe.',
            camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' },
            [field]: sample };
        if (!validateSceneCards([card]).valid) { unsampled.push(field); continue; }

        const shotId = seedShot(card);
        const seeded = await callPrevis('POST', `/film/shots/${shotId}/previs/from-card`);
        if (seeded.status >= 400) { lost.push(`${field}: from-card refused (${seeded.status})`); continue; }
        const applied = await callPrevis('POST', `/film/shots/${shotId}/previs/apply`);
        if (applied.status >= 400) { lost.push(`${field}: apply refused (${applied.status})`); continue; }

        const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
        const after = JSON.parse(row.scene_card_yaml || '{}');
        if (JSON.stringify(after[field]) !== JSON.stringify(sample)) {
            lost.push(`${field}: ${JSON.stringify(sample)} -> ${JSON.stringify(after[field])}`);
        }
    }

    assert.deepStrictEqual(unsampled, [],
        'no value could be found that the validator accepts for these fields — the '
        + 'candidate ladder needs a shape, or the field is not settable at all');
    assert.deepStrictEqual(lost, [],
        'board decisions destroyed or altered by a previs round trip');
});

// ── Approval is about the ANGLE ─────────────────────────────────────────────
//
// blockingFingerprint() hashes camera_json WHOLESALE. So any decision routed
// through previs by stashing it inside camera_json silently joins the approval
// fingerprint, and editing a sentence of direction on a shot whose camera never
// moved marks the approval stale -- which /to-video and /to-storyboard turn
// into a 409 STALE_APPROVAL.
//
// That failure is worth a test rather than a comment because it is invisible
// until it is expensive: the director approves a framing, adjusts a word, and
// is refused at generation time for a shot they never restaged. Approval means
// "this is the angle I signed off". A non-camera decision must not revoke it.
//
// Set-based over exactly the contract entries that reach previs but are not
// camera optics -- derived from the contract, so a decision routed this way
// tomorrow is covered with nothing to remember.

test('a non-camera decision does not stale a previs approval', async () => {
    const contract = loadContract();
    if (!contract) { assert.fail('lib/decision-contract.js does not exist'); }

    const { approvalState } = require('../routes/previs');
    const routed = (contract.DECISIONS || [])
        .filter(d => d.previs && d.id !== 'shot.camera' && !/^camera_json$/.test(d.previs));
    if (!routed.length) return; // nothing routed through previs yet

    const stales = [];
    for (const d of routed) {
        const card = { shot_code: 'P1', description: 'Probe.',
            camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' } };
        const shotId = seedShot(card);
        const saved = await callPrevis('PUT', `/film/shots/${shotId}/previs`, {
            camera: { position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50,
                sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
            subject: { position: [0, 0, 0], heightM: 1.7 },
            stage: { widthM: 12, depthM: 12 }, rig: 'dolly', movement: 'dolly-in',
        });
        if (saved.status >= 400) { stales.push(`${d.id}: fixture blocking refused`); continue; }
        const ok = await callPrevis('POST', `/film/shots/${shotId}/previs/approve`);
        if (ok.status >= 400) { stales.push(`${d.id}: approve refused`); continue; }
        if (approvalState(shotId).stale) { stales.push(`${d.id}: stale before any edit`); continue; }

        // Write the decision where the contract says it lives, and change
        // NOTHING about the camera.
        const [col, ...rest] = d.previs.split('.');
        const row = db.prepare(`SELECT ${col} FROM film_previs_blocking WHERE shot_id = ?`).get(shotId);
        let blob = {};
        try { blob = JSON.parse(row[col] || '{}'); } catch (_) { blob = {}; }
        let cursor = blob;
        for (const k of rest.slice(0, -1)) { cursor[k] = cursor[k] || {}; cursor = cursor[k]; }
        if (rest.length) cursor[rest[rest.length - 1]] = 'parity probe';
        db.prepare(`UPDATE film_previs_blocking SET ${col} = ? WHERE shot_id = ?`)
            .run(JSON.stringify(blob), shotId);

        if (approvalState(shotId).stale) {
            stales.push(`${d.id} (stored at ${d.previs}) revokes an approval the camera never changed`);
        }
    }

    assert.deepStrictEqual(stales, [],
        'approval means "this is the angle I signed off" — these decisions revoke it');
});
