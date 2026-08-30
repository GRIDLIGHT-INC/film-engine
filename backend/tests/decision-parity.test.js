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
/*
 * The local gateway is OFF unless switched on, so a suite that stands up a mock
 * Gridlight and generates against it has to enable it — exactly as an operator
 * running the real service does. Set before anything requires the provider
 * registry, which caches the answer.
 */
process.env.GRIDLIGHT_ENABLED = '1';
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

const STAGE_BOOKKEEPING = /^(id|shot_id|created_at|updated_at|approved_(fingerprint|at)|applied_.*)$/;

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
    /*
     * Matched as a COLUMN, not as a word.
     *
     * A bare `\bclient\b` finds `gridlight-client` in an import and the English
     * word "client" in a comment, and then reports `film_projects:client` as a
     * director decision the contract has failed to account for. A column is
     * read as `project.x`, `row.x`, `.x` off some record, or named in SQL — and
     * nothing else counts, because everything else is prose.
     */
    const used = new Set();
    for (const f of files) {
        const src = readCode(f);
        for (const col of known) {
            const asProperty = new RegExp(`\\.\\s*${col}\\b`);
            const inSql = new RegExp(`(SELECT|,|\\s)\\s*${col}\\s*(,|\\s+FROM|=)`, 'i');
            const asKey = new RegExp(`(^|[^\\w.])${col}\\s*:`, 'm');
            if (asProperty.test(src) || inSql.test(src) || asKey.test(src)) used.add(col);
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

/*
 * Ordered MOST STRUCTURED FIRST, and that order is load-bearing.
 *
 * The card validator does not type-check every field: `{ props: 'a string' }`
 * validates. Taking the first accepted candidate therefore handed `props` a
 * string, which the seeder then iterated CHARACTER BY CHARACTER and created
 * twelve props called z, q, p, r, o... The payload naturally did not change,
 * and the probe reported prop plates as unreachable when the fixture had never
 * built one. A probe that manufactures its own failure costs more than no probe.
 *
 * Preferring the richest shape a field accepts also just describes reality:
 * props and characters are lists, camera and lighting are blocks, direction is
 * prose. Where the schema is loose, the realistic shape is the right guess.
 */
const CANDIDATES = [
    { type: 'day', notes: 'parity probe' },
    { shot_type: 'wide' },
    [{ character: 'PARITY_PROBE', line: 'Mark.' }],
    ['PARITY_PROBE'],
    'parity-probe-value',
    4,
];

/*
 * Fields the board MERGES rather than replaces, derived from routes/shots.js
 * rather than named here. This matters to the ladder: the card validator
 * checks `typeof card.camera !== 'object'`, and an ARRAY is an object, so
 * ["PARITY_PROBE"] validates as a camera and then merges into one, producing a
 * spliced hybrid that looks exactly like previs having corrupted the card.
 *
 * That is a probe defect, not a product defect, and it nearly went out as a
 * finding. A test that manufactures its own bug is worse than no test: it
 * spends someone's afternoon and teaches them to distrust the suite.
 */
const MERGED_BLOCKS = (() => {
    const m = SHOTS.match(/MERGED_BLOCKS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    if (!m) return new Set();
    return new Set(m[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
})();

function sampleFor(field) {
    for (const v of CANDIDATES) {
        if (MERGED_BLOCKS.has(field) && (Array.isArray(v) || typeof v !== 'object')) continue;
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

/*
 * Facets that applying a stage LEGITIMATELY writes onto the card, derived from
 * applyBlockingToCard's own assignments. Apply is not meant to be a no-op: it
 * solves an angle and writes it down, so demanding byte-exact equality after it
 * would report the feature working as the feature broken. What must survive is
 * what the director DECLARED and the stage does not decide.
 */
const PROJECTED_CAMERA = (() => {
    const m = PREVIS.match(/function applyBlockingToCard[\s\S]*?\n}/);
    if (!m) return new Set();
    const out = new Set();
    const re = /card\.camera\.([a-z_]+)\s*=/g;
    let a;
    while ((a = re.exec(m[0]))) out.add(a[1]);
    return out;
})();

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
        const declared = JSON.parse(JSON.stringify(card[field]));

        const shotId = seedShot(card);
        const seeded = await callPrevis('POST', `/film/shots/${shotId}/previs/from-card`);
        if (seeded.status >= 400) { lost.push(`${field}: from-card refused (${seeded.status})`); continue; }
        const applied = await callPrevis('POST', `/film/shots/${shotId}/previs/apply`);
        if (applied.status >= 400) { lost.push(`${field}: apply refused (${applied.status})`); continue; }

        const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
        const after = (JSON.parse(row.scene_card_yaml || '{}'))[field];

        if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
            // A merged block: every facet the director declared must still be
            // there, except the ones the stage is entitled to decide.
            for (const [k, v] of Object.entries(declared)) {
                if (field === 'camera' && PROJECTED_CAMERA.has(k)) continue;
                if (!after || JSON.stringify(after[k]) !== JSON.stringify(v)) {
                    lost.push(`${field}.${k}: ${JSON.stringify(v)} -> ${JSON.stringify(after && after[k])}`);
                }
            }
        } else if (JSON.stringify(after) !== JSON.stringify(declared)) {
            lost.push(`${field}: ${JSON.stringify(declared)} -> ${JSON.stringify(after)}`);
        }
    }

    assert.deepStrictEqual(unsampled, [],
        'no value could be found that the validator accepts for these fields');
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

// ── Does the model actually receive the choice? ─────────────────────────────
//
// The other half of the director's ask is not "do the two screens agree" but
// "is the AI fed what I decided". Those are different questions and the second
// is the one that costs money to get wrong: a decision can round-trip between
// board and previs perfectly and still never reach a provider, which looks
// exactly like the model ignoring you.
//
// This codebase has shipped that failure repeatedly -- mood-board specs that
// validated and were consumed nowhere; camera height validated on the card
// since previs phase 0 and read only from blocking; a keyframe path that
// gathered plates and put them on no payload. Every one was invisible, because
// a stored choice and an applied choice look identical from the outside.
//
// DIFFERENTIAL, not sentinel-matching. The first version of this probe looked
// for a magic string in the payload and reported four decisions as unreachable
// that were nothing of the kind: `characters: ['zqparityprobe']` names a
// character that does not exist in the project, so of course no plate and no
// description resolved. The probe had manufactured its own failure. Changing
// the value and asserting the payload CHANGES asks the real question and works
// for enums, objects and name lists alike -- the same shape as the mood-board
// spec-consumption suite, for the same reason.
//
// Named entities are seeded, because an unknown name is a fair thing for the
// builder to ignore and an unfair thing to test it on.

const { VALID_LIGHTING } = require('../lib/scene-card-schema');

/*
 * Two valid, meaningfully different values for one card field.
 *
 * Validation-driven rather than shape-guessed: each candidate PAIR is offered
 * to the real validator and the first pair both halves of which are accepted is
 * used. Guessing from a single sampled shape is what produced the last two
 * fixture bugs -- the schema is loose in places, so "what validates" and "what
 * the field means" are not the same question, and only trying pairs closes it.
 */
function variantPair(field) {
    const PAIRS = [
        [{ note: 'hold on the door' }, { note: 'drift past the window' }],          // camera
        [{ type: VALID_LIGHTING[0], notes: 'alpha' }, { type: VALID_LIGHTING[1], notes: 'beta' }],
        [['ZQALPHA'], ['ZQBETA']],                                                   // name lists
        [[{ character: 'ZQALPHA', line: 'Alpha.' }], [{ character: 'ZQBETA', line: 'Beta.' }]],
        ['zqprobealpha', 'zqprobebeta'],                                             // prose
    ];
    // The view picker can only choose between plates that exist, and the
    // fixture seeds these two.
    if (field === 'location_view') return ['north', 'south'];

    /*
     * A merged block takes object pairs; everything else takes list-or-prose.
     * MERGED_BLOCKS is derived from routes/shots.js, so this is the card's own
     * distinction rather than a second opinion about it -- and without it the
     * loose validator hands `characters` a { note } object, which the seeder
     * then cannot iterate.
     */
    const shaped = PAIRS.filter(([v]) => {
        const isObj = v && typeof v === 'object' && !Array.isArray(v);
        return MERGED_BLOCKS.has(field) ? isObj : !isObj;
    });

    /*
     * Among object pairs, prefer the one whose KEYS this field's validator
     * actually constrains. The loose schema accepts { note } on lighting as
     * readily as on camera, and a probe that sets lighting.note is asking
     * whether a field nothing reads reaches the model -- the answer is no, and
     * it says nothing about whether LIGHTING reaches it. Derived from the
     * schema source so it tracks the validator rather than describing it.
     */
    const SCHEMA_SRC = readCode('lib/scene-card-schema.js');
    const constrained = pair => {
        const [v] = pair;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
        return Object.keys(v).filter(k => SCHEMA_SRC.includes(`card.${field}.${k}`)).length;
    };
    shaped.sort((a, b) => constrained(b) - constrained(a));

    for (const pair of shaped) {
        const ok = pair.every(v => {
            const card = { shot_code: 'P1', description: 'Probe.',
                camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' } };
            card[field] = (v && typeof v === 'object' && !Array.isArray(v))
                ? { ...(card[field] || {}), ...v } : v;
            return validateSceneCards([card]).valid;
        });
        // A name list is only meaningful for a field the builder reads as one.
        if (ok) return pair;
    }
    return null;
}

function seedNamed(projectId, table, names) {
    const col = table === 'film_characters' ? 'appearance_prompt' : 'visual_prompt';
    for (const n of names) {
        const id = generateId();
        db.prepare(`INSERT INTO ${table} (id, project_id, name, ${col}) VALUES (?, ?, ?, ?)`)
            .run(id, projectId, n, `distinctive look for ${n}`);
        // A prop's prose reaches an image prompt only through a locked contract
        // or a declared size; what a props change actually moves is its PLATE.
        if (table === 'film_props') {
            db.prepare(`INSERT INTO film_assets (id, project_id, prop_id, asset_type, file_name, file_path)
                        VALUES (?, ?, ?, 'reference_image', ?, ?)`)
                .run(generateId(), projectId, id, `${n}.png`, plateFile(`${n}.png`));
        }
    }
}

/*
 * location_view selects WHICH plate of a place travels with the shot, so it can
 * only change a payload where more than one plate exists. Seeding both views is
 * what makes the question askable at all; without them the probe would report
 * a working feature as broken because it had staged nothing to choose between.
 */
function plateFile(name) {
    // A real file, because reference gathering inlines local plates as data
    // URIs and a path that does not exist throws -- which the gatherer catches
    // and turns into "no references at all". A probe seeding a phantom path
    // would report the view picker broken when it was the fixture that was.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-plate-'));
    const file = path.join(dir, name);
    // 1x1 PNG, with bytes that DIFFER per plate. Identical bytes would make two
    // different plates inline to the same data URI, and a differential probe
    // would then report a working picker as broken -- the fixture proving the
    // fixture.
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
        Buffer.from(name),
    ]));
    return file;
}

function seedLocationWithViews(projectId, sceneId, views) {
    const locId = generateId();
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(locId, projectId, 'PROBE LOCATION');
    db.prepare('UPDATE film_scenes SET location = ? WHERE id = ?').run('PROBE LOCATION', sceneId);
    for (const v of views) {
        db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, metadata)
                    VALUES (?, ?, ?, 'reference_image', ?, ?, ?)`)
            .run(generateId(), projectId, locId, `plate_${v}.png`,
                plateFile(`plate_${v}.png`), JSON.stringify({ view: v }));
    }
}

function seedShotIn(projectId, card, onScene) {
    const sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    if (onScene) onScene(sceneId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, ?)')
        .run(shotId, sceneId, 'P1', JSON.stringify(card), 4000);
    return shotId;
}

test('a contracted decision reaches the payloads it claims', async () => {
    const contract = loadContract();
    if (!contract) { assert.fail('lib/decision-contract.js does not exist'); }
    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
    const cardFields = deriveCardDecisions();

    const missing = [];
    const unprobeable = [];

    for (const d of contract.DECISIONS || []) {
        for (const cand of d.covers || []) {
            if (!cardFields.includes(cand)) continue;
            const pair = variantPair(cand);
            if (!pair) { unprobeable.push(`${d.id}:${cand} (no two valid values)`); continue; }

            const built = [];
            for (const value of pair) {
                const card = { shot_code: 'P1', description: 'Probe.',
                    camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' } };
                card[cand] = (value && typeof value === 'object' && !Array.isArray(value))
                    ? { ...(card[cand] || {}), ...value } : value;
                if (!validateSceneCards([card]).valid) { built.push(null); continue; }

                const projectId = generateId();
                db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Parity');
                // A name only means something if the project has that subject.
                if (cand === 'characters') seedNamed(projectId, 'film_characters', value);
                if (cand === 'props') seedNamed(projectId, 'film_props', value);
                const shotId = seedShotIn(projectId, card, sceneId => {
                    if (cand === 'location_view') seedLocationWithViews(projectId, sceneId, pair);
                });

                const perCap = {};
                for (const cap of d.payloads || []) {
                    try {
                        const ctx = await loadShotContext(shotId);
                        const out = await buildCapabilityPayload(cap, ctx);
                        perCap[cap] = JSON.stringify(out && out.payload !== undefined ? out.payload : out);
                    } catch (err) {
                        perCap[cap] = err && err.code === 'PRECONDITION' ? `__precondition__${err.message}` : `__threw__${err && err.message}`;
                    }
                }
                built.push(perCap);
            }

            if (built.some(b => !b)) { unprobeable.push(`${d.id}:${cand} (a variant did not validate)`); continue; }
            for (const cap of d.payloads || []) {
                const [a, b] = [built[0][cap], built[1][cap]];
                if (String(a).startsWith('__precondition__')) {
                    // A clip needs a keyframe nobody has generated. Not a parity
                    // failure, but not a proven claim either -- so it is named.
                    unprobeable.push(`${d.id}:${cand}:${cap} ${String(a).slice(16)}`);
                    continue;
                }
                if (String(a).startsWith('__threw__')) {
                    missing.push(`${d.id}:${cand} -> ${cap} ${String(a).slice(9)}`);
                    continue;
                }
                if (a === b) missing.push(`${d.id}:${cand} changes nothing in the ${cap} payload (${String(a).slice(0, 240)})`);
            }
        }
    }

    assert.deepStrictEqual(missing, [],
        'the contract claims these decisions reach a payload, and changing them changes nothing in it:');
    assert.deepStrictEqual(unprobeable, [],
        'these could not be probed, so the claim is untested rather than true');
});

// ── The Apply boundary, exercised ───────────────────────────────────────────
//
// Staged-vs-applied is carried by a marker (`director_json._applied`) rather
// than by a fingerprint of what Apply wrote. A maintained flag is normally the
// weaker choice -- it records that somebody pressed Apply once, not that the
// stage still matches the card, and it goes wrong the moment a write path
// forgets to clear it. It goes wrong in the DANGEROUS direction too: it reports
// applied when it is not, so the confirmation tells a director their staging is
// committed, they spend, and the frame is built from a card that never got it.
//
// It is sound here for one specific reason: film_previs_blocking has exactly
// ONE insert path, so there is only one place that can forget. That is a real
// property of the code rather than a hope about it, so the test below pins it.
// The moment a second writer appears, the marker needs to become a fingerprint
// of the projected subset -- the shape migration 062 already chose for approval,
// for the same "X" versus "X as it is now" reason.

test('save stages, apply applies, and saving again stages', async () => {
    const card = { shot_code: 'P1', description: 'Probe.',
        camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' } };
    const shotId = seedShot(card);
    const blocking = {
        camera: { position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50,
            sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
        subject: { position: [0, 0, 0], heightM: 1.7 },
        stage: { widthM: 12, depthM: 12 }, rig: 'dolly', movement: 'dolly-in',
    };

    const preview = async () => {
        const r = await callPrevis('POST', `/film/shots/${shotId}/previs/to-storyboard`);
        return r.body || {};
    };

    assert.ok((await callPrevis('PUT', `/film/shots/${shotId}/previs`, blocking)).status < 400,
        'fixture blocking did not save');
    const afterSave = await preview();
    assert.strictEqual(afterSave.staged, true, 'a saved-but-unapplied stage must preview as staged');
    assert.strictEqual(afterSave.applied, false, 'nothing has been applied yet');

    assert.ok((await callPrevis('POST', `/film/shots/${shotId}/previs/apply`)).status < 400,
        'apply refused');
    const afterApply = await preview();
    assert.strictEqual(afterApply.applied, true, 'after Apply the stage IS the card');
    assert.strictEqual(afterApply.staged, false, 'nothing is outstanding after Apply');

    // Restaging is the common case and the one the boundary exists for: a
    // director keeps trying angles after applying one, and the board must not
    // go on claiming the card holds what is now on screen.
    assert.ok((await callPrevis('PUT', `/film/shots/${shotId}/previs`,
        { ...blocking, camera: { ...blocking.camera, focalMm: 85 } })).status < 400,
        'restage did not save');
    const afterRestage = await preview();
    assert.strictEqual(afterRestage.staged, true, 'restaging after Apply must go back to staged');
    assert.strictEqual(afterRestage.applied, false, 'the card no longer holds what is staged');
});

test('staged is derived from what Apply wrote, never stored as a flag', () => {
    /*
     * "Applied" and "applied AS IT IS NOW" are different questions, and a
     * boolean can only answer the first. A stored flag records that somebody
     * pressed Apply once; it says nothing about whether the stage still matches
     * the card, and it goes wrong the moment any write path forgets to clear
     * it -- in the dangerous direction, reporting applied when it is not, so
     * the confirmation tells a director their staging is committed, they spend,
     * and the frame is generated from a card that never received it.
     *
     * Migration 062 already chose this shape for approval, for this reason.
     * The second use should be cheaper than the first.
     */
    const gaps = [];
    if (/_applied/.test(PREVIS)) {
        gaps.push('routes/previs.js still reads a stored _applied flag');
    }
    if (!/applied_fingerprint/.test(PREVIS)) {
        gaps.push('nothing compares an applied fingerprint, so staged cannot be derived');
    }

    /*
     * The fingerprint must cover only what Apply actually WRITES to the card.
     * Fingerprinting the whole blocking would make dragging a background cube
     * report the card as out of date when it is not -- and a warning that fires
     * on work nobody needs to redo is one people learn to dismiss, which is
     * exactly why the screenplay-drift fingerprint was narrowed to four fields.
     */
    const applyFn = PREVIS.match(/function applyBlockingToCard[\s\S]*?\n}/);
    if (!applyFn) gaps.push('no applyBlockingToCard to derive the projected subset from');
    else {
        // Follow the WRITER rather than the string: whichever functions write
        // applied_fingerprint are the recorders, and Apply must either be one
        // or call one. Matching the column name inside Apply would fail the
        // moment somebody factors the write out into a helper, which is the
        // better code and would have looked like the feature missing.
        const recorders = new Set();
        const re = /function ([A-Za-z0-9_]+)\s*\([\s\S]*?\n}/g;
        let f;
        while ((f = re.exec(PREVIS))) {
            if (/UPDATE film_previs_blocking SET applied_fingerprint/.test(f[0])) recorders.add(f[1]);
        }
        const records = /applied_fingerprint/.test(applyFn[0])
            || [...recorders].some(n => new RegExp(`\\b${n}\\s*\\(`).test(applyFn[0]));
        if (!recorders.size) gaps.push('nothing writes applied_fingerprint');
        else if (!records) gaps.push('Apply does not record what it applied');
    }

    assert.deepStrictEqual(gaps, [], 'the applied state is not derived');
});

// ── Which side moved? ───────────────────────────────────────────────────────
//
// applicationFingerprint covers the stage AND the card, so it goes stale when
// EITHER moves. That is right for detecting disagreement and wrong for naming
// it, because the two cases need opposite actions:
//
//   the stage moved ahead  -> Apply. The stage is the newer intent.
//   the card moved ahead   -> do NOT apply. Applying reverts the newer edit.
//
// Both currently report `staged: true`, which is a sentence about the stage,
// and the surface offers Apply. So a director who applies an angle, then
// rewrites the direction on the board, is told their previs is unapplied and
// invited to press the button that silently throws their rewrite away.
//
// Set-based over the contract's own previs-projected card decisions, because
// the failure is per-field: direction, lighting and location_view each travel
// through director_json independently, and a test written against one passes
// while another is being reverted.

test('a board edit made after Apply is not silently reverted by applying again', async () => {
    const contract = loadContract();
    if (!contract) { assert.fail('lib/decision-contract.js does not exist'); }
    const cardFields = deriveCardDecisions();

    const routed = (contract.DECISIONS || []).filter(d =>
        d.canonical === 'scene_card' && d.previs && (d.covers || []).some(c => cardFields.includes(c)));

    const lost = [];
    for (const d of routed) {
        for (const cand of (d.covers || []).filter(c => cardFields.includes(c))) {
            const pair = variantPair(cand);
            if (!pair) continue;
            const [staged, onBoard] = pair;

            const card = { shot_code: 'P1', description: 'Probe.',
                camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' } };
            const shotId = seedShot(card);

            // 1. Stage it in previs and apply, so the two agree.
            const blocking = {
                camera: { position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50,
                    sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
                subject: { position: [0, 0, 0], heightM: 1.7 },
                stage: { widthM: 12, depthM: 12 }, rig: 'dolly', movement: 'dolly-in',
                director: { [cand]: staged },
            };
            if ((await callPrevis('PUT', `/film/shots/${shotId}/previs`, blocking)).status >= 400) continue;
            if ((await callPrevis('POST', `/film/shots/${shotId}/previs/apply`)).status >= 400) continue;

            // 2. The director then changes their mind ON THE BOARD.
            const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
            const edited = JSON.parse(row.scene_card_yaml || '{}');
            edited[cand] = onBoard;
            if (!validateSceneCards([edited]).valid) continue;
            db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
                .run(JSON.stringify(edited), shotId);

            // 3. The surface says "staged", so they press Apply.
            await callPrevis('POST', `/film/shots/${shotId}/previs/apply`);
            const after = JSON.parse(
                db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId).scene_card_yaml || '{}');

            // A merged block legitimately gains the facets Apply solves, so only
            // the keys the director actually typed are checked -- otherwise the
            // feature working reads as the feature reverting.
            if (onBoard && typeof onBoard === 'object' && !Array.isArray(onBoard)) {
                for (const [k, v] of Object.entries(onBoard)) {
                    if (JSON.stringify((after[cand] || {})[k]) !== JSON.stringify(v)) {
                        lost.push(`${cand}.${k}: board edit ${JSON.stringify(v)} reverted to ${JSON.stringify((after[cand] || {})[k])}`);
                    }
                }
            } else if (JSON.stringify(after[cand]) !== JSON.stringify(onBoard)) {
                lost.push(`${cand}: board edit ${JSON.stringify(onBoard)} reverted to ${JSON.stringify(after[cand])}`);
            }
        }
    }

    assert.deepStrictEqual(lost, [],
        'applying reverted a newer board edit — the surface must distinguish "the stage '
        + 'moved" from "the card moved", because only the first is an invitation to Apply');
});
