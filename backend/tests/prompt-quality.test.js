/**
 * Is the request we send actually a good one?
 *
 * The previous round proved a director's choice REACHES the request, and this
 * one raised Meshy's ceiling so the request stopped being amputated. Neither
 * asked whether what arrives is any good — and five things say it is not.
 *
 * They share a shape. Removing the truncation did not fix anything underneath
 * it; it revealed what the truncation had been accidentally covering. A budget
 * that stopped binding stopped enforcing priority. A payload built for one
 * provider started being handed to three others with far smaller ceilings. And
 * a pre-spend report that already omitted five of thirteen contributors began
 * omitting them at full length instead of trimmed to nothing.
 *
 *   A. one payload, four ceilings          (image-fallback)
 *   B. two ceiling resolvers               (route vs shared path)
 *   C. five of thirteen contributors unreported
 *   D. priority stops governing once the ceiling is generous
 *   E. the negative prompt is inert on most adapters
 *   +  the declared ceiling claims evidence it does not have
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const os = require('os');
const crypto = require('crypto');

/*
 * ISOLATE BEFORE ANY MODULE CAN OPEN A DATABASE.
 *
 * This must run before the database module is reached anywhere,
 * including transitively. An earlier version of this file set nothing and its
 * route-level test wrote nineteen throwaway projects straight into the live
 * production database. tests/test-isolation.test.js exists precisely to catch
 * that and it caught this.
 */
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-promptq-' + crypto.randomUUID().slice(0, 8));

// The isolated directory starts empty, so the schema has to be built before
// anything queries it. Without this the route tests failed with
// "no such table: film_projects" — reported as a bare SQLITE_ERROR, which
// looks like a product fault and is a missing line in the fixture.
require('../db/schema').ensureSchema();

const providers = require('../lib/providers');
const { PROMPT_PRIORITY } = require('../lib/storyboard-prompt');

const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = rel => strip(read(rel));

/** The image adapters, derived from the registry rather than named here. */
function imageAdapters() {
    return providers.list()
        .filter(a => (a.capabilities || []).includes('image'))
        .map(a => ({ id: a.id || a.provider || a.name, adapter: a }));
}

// ── A. One payload must not be sent to four different ceilings ─────────────

test('A: every hop gets a payload built for the adapter that will run', async () => {
    /*
     * generateImageWithFallback builds ONE payload for the LEAD and hands that
     * object to every hop. A Meshy-led project now builds 11,671-12,934
     * characters; openai declares 4000, runway and gridlight 1000. On a refusal
     * the fallback sends a prompt three to twelve times over the next
     * provider's ceiling — and a provider's "too long" rejection is not a
     * refusal, so the chain calls it OUR fault and stops. The fallback stops
     * working exactly when the lead is a long-prompt provider.
     *
     * THREE EARLIER VERSIONS OF THIS TEST WERE WRONG, in three different ways,
     * and the sequence is the lesson.
     *
     *  1. It executed the real chain with patched adapters. The patch bound to
     *     objects the metered chain never called: zero hops captured, an empty
     *     list satisfied the assertion, and a 12,000-character request was
     *     billed. It spent money and proved nothing.
     *  2. It asked for payloadForAdapter(adapter, flatPayload). By then the
     *     prompt is one string with its contributor boundaries and shot context
     *     gone, so any implementation could only SLICE — the mid-clause
     *     amputation this round exists to remove, reintroduced as its own fix.
     *  3. It grepped the function signature for factory words and then
     *     validated a factory the TEST supplied. An implementation could accept
     *     payloadFactory, ignore it, and send the lead's payload to every hop
     *     while this passed.
     *
     * So it is behavioural, over FAKE adapters, with no network and no
     * metering: the chain must ASK the factory for each adapter, and what each
     * adapter receives must fit its own ceiling. Ceilings are taken from the
     * real registry so the fakes cannot drift into a friendlier shape.
     */
    const fallback = require('../lib/image-fallback');
    const run = fallback.runImageFallbackChain;
    assert.ok(typeof run === 'function',
        'image-fallback exposes no injectable chain runner, so the only way to observe what '
        + 'each hop receives is to call real credentialed providers — which is how this test '
        + 'billed a live generation once already');

    // Fakes shaped by the real adapters' declared ceilings.
    const ceilings = imageAdapters().map(({ id, adapter }) => ({ id, limit: Number(adapter.promptLimit) || 0 }));
    assert.ok(ceilings.length >= 4, `expected 4 image adapters, found ${ceilings.length}`);

    const received = [];
    const askedFor = [];
    const fakes = ceilings.map(({ id, limit }) => ({
        id, promptLimit: limit,
        generate: async (_cap, payload) => {
            received.push({ id, chars: String((payload && payload.prompt) || '').length });
            return { ok: false, error: 'insufficient credits' };   // refuse, so the chain walks on
        },
    }));

    const factory = adapter => {
        askedFor.push(adapter.id);
        const room = Number(adapter.promptLimit) || 12000;
        return { prompt: 'x'.repeat(Math.min(12000, room)), width: 1024, height: 576 };
    };

    await run(fakes, factory, {});

    assert.deepStrictEqual(askedFor, fakes.map(f => f.id),
        'the chain did not ask the factory for a payload per adapter');
    assert.deepStrictEqual(received.map(r => r.id), fakes.map(f => f.id),
        `the chain attempted ${received.length} hops of ${fakes.length}`);

    const over = received
        .filter(r => { const c = ceilings.find(x => x.id === r.id); return c.limit && r.chars > c.limit; })
        .map(r => `${r.id}: received ${r.chars} against its ${ceilings.find(x => x.id === r.id).limit} ceiling`);
    assert.deepStrictEqual(over, [], 'a hop received a prompt built for a different provider');
});

test('A2: a legacy flat payload skips hops it cannot serve, and says why', async () => {
    /*
     * Callers that still hand over a single prebuilt payload cannot be
     * rebudgeted — the structure is gone. The honest degradation is to SKIP an
     * adapter whose ceiling the prompt exceeds and record the reason, rather
     * than send it something it will reject or silently truncate. That
     * sacrifices fallback coverage and lies about nothing.
     */
    const { runImageFallbackChain } = require('../lib/image-fallback');
    // No early return. A guard that skips when the seam is missing is the
    // "zero attempts satisfies the assertion" pattern that already let this
    // suite bill a live generation while proving nothing.
    assert.ok(typeof runImageFallbackChain === 'function',
        'no injectable chain runner, so the legacy flat-payload path cannot be observed');

    const received = [];
    const fakes = [
        { id: 'roomy', promptLimit: 16000, generate: async (_c, p) => { received.push('roomy'); return { ok: false, error: 'insufficient credits' }; } },
        { id: 'tight', promptLimit: 1000, generate: async (_c, p) => { received.push('tight'); return { ok: false, error: 'insufficient credits' }; } },
    ];
    const result = await runImageFallbackChain(fakes, { prompt: 'x'.repeat(9000) }, {});

    assert.ok(!received.includes('tight'),
        'a 9000-character prompt was handed to a provider declaring 1000');
    const chain = (result && result._chain) || [];
    const skipped = chain.find(c => c.provider === 'tight');
    assert.ok(skipped && /limit|too long|incompatible/i.test(String(skipped.error || skipped.skipped || '')),
        'the skipped hop is not reported with a reason a director could act on');
});

// ── B. One ceiling resolver, not two ───────────────────────────────────────

test('B: exactly one implementation resolves the image prompt ceiling', () => {
    /*
     * routes/storyboard.js defines imagePromptLimitFor — resolveGenerator,
     * promptLimit, same null fallback — a near-verbatim copy of
     * capability-payloads.js imagePromptLimit, and uses it at four call sites
     * including the one that appends the locked contracts.
     *
     * They agree today. Two copies of a rule is how a display comes to
     * disagree with a generator, which this codebase has now paid for with
     * effectiveCamera, markupToolbar and AUDIO_LANES. And the test that was
     * supposed to guarantee preview/purchase parity only counted builder calls,
     * so it certified a property it could not see.
     */
    const implementations = [];
    for (const rel of ['lib/capability-payloads.js', 'routes/storyboard.js', 'lib/image-fallback.js']) {
        const src = code(rel);
        for (const m of src.matchAll(/function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{([\s\S]{0,600}?)\n\}/g)) {
            const [, name, body] = m;
            if (/resolveGenerator\(\s*['"]image['"]/.test(body) && /promptLimit/.test(body)) {
                implementations.push(`${rel}:${name}`);
            }
        }
    }
    assert.strictEqual(implementations.length, 1,
        `the image ceiling is resolved in ${implementations.length} places: ${implementations.join(', ')}`);
});

// ── C. The pre-spend report must account for what is sent ──────────────────

test('C: what the report accounts for equals what is sent', async () => {
    /*
     * On a real shot the prompt is 11,671 characters and the budget a director
     * reads before spending accounts for 6,462 — 45% unreported. PROMPT_PRIORITY
     * declares thirteen contributors; the report lists eight. Absent: anchor,
     * staging, annotations, location, contracts — and the contracts are what
     * now dominates the prompt.
     *
     * Driven through the REAL handler, because the gap is not in the builder.
     * A first version passed a contracts item straight to buildStoryboardPrompt
     * and went green: the builder accounts for what it is given. The characters
     * that go missing are appended AFTER it, by applyConsistencyToImagePayload
     * on the route — so anything that does not exercise the route cannot see
     * the defect. A source-string search was worse still: it reported ten
     * missing rather than the measured five and could be satisfied with dead
     * literals.
     */
    const { handleStoryboard } = require('../routes/storyboard');
    const { db, generateId } = require('../db/database');
    const sp = require('../lib/storyboard-prompt');
    const ids = sp.PROMPT_PRIORITY.map(x => x.id);
    assert.ok(ids.length >= 13, `expected 13 contributors, found ${ids.length}`);

    // A shot with locked contracts, which is the state that exposes the gap.
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    try {
    db.prepare('INSERT INTO film_projects (id, title, provider_config, style_preset) VALUES (?,?,?,?)')
        .run(projectId, 'Accounting', JSON.stringify({ image: 'meshy' }), 'S'.repeat(500));
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?,?,?,?)')
        .run(sceneId, projectId, '1', 'STREET');
    db.prepare('INSERT INTO film_locations (id, project_id, name, description) VALUES (?,?,?,?)')
        .run(generateId(), projectId, 'STREET', 'L'.repeat(850));
    db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?,?,?,?)')
        .run(generateId(), projectId, 'MAYA', 'M'.repeat(800));
    db.prepare('INSERT INTO film_props (id, project_id, name, visual_prompt) VALUES (?,?,?,?)')
        .run(generateId(), projectId, 'SEDAN', 'P'.repeat(1900));
    // Each row carries its REAL type — the loop used to hardcode 'character',
    // which tested contract allocation against the wrong registry shape.
    // DISTINCT bodies. Identical 'C...' runs share prefixes, so the route's
    // longest-prefix attribution could credit one subject's surviving text to
    // the other and the assertion would pass or fail for the wrong reason.
    for (const [name, kind, text] of [['MAYA', 'character', 'MAYAWEARS ' + 'm'.repeat(790)],
        ['SEDAN', 'prop', 'SEDANPAINT ' + 's'.repeat(1889)]]) {
        db.prepare(`INSERT INTO film_consistency_profiles
            (id, project_id, profile_type, subject_name, status, prompt_contract)
            VALUES (?,?,?,?,'locked',?)`).run(generateId(), projectId, kind, name, text);
    }
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?,?,?,?,?)')
        .run(shotId, sceneId, 'Q1', JSON.stringify({
            shot_code: 'Q1',
            description: 'MAYA on the kerb, the SEDAN behind her.',
            camera: { shot_type: 'wide', lens: '35mm', movement: 'tracking-right', note: 'Camera far side.' },
            lighting: { type: 'blue-hour' },
            characters: ['MAYA'], props: ['SEDAN'],
        }), 4000);
    } catch (err) { assert.fail(`fixture insert failed: ${err.message}`); }

    const res = await new Promise(resolve => {
        const chunks = [];
        const r = new (require('stream').Writable)({ write(c, _e, n) { chunks.push(c); n(); } });
        r.statusCode = 200;
        r.writeHead = function (c) { this.statusCode = c; return this; };
        r.setHeader = function () {};
        r.on('finish', () => {
            let b = Buffer.concat(chunks).toString();
            try { b = JSON.parse(b); } catch (_) { /* not json */ }
            resolve(b);
        });
        Promise.resolve(handleStoryboard({ method: 'GET', body: {} }, r,
            ['film', 'shots', shotId, 'prompt'], {}))
            .catch(err => resolve({ error: err.message }));
    });

    assert.ok(res && typeof res.prompt === 'string', `no prompt from the preview: ${JSON.stringify(res).slice(0, 160)}`);
    const budget = res.budget || [];
    assert.ok(budget.length, 'the preview reported no budget at all');

    const unknown = budget.map(b => b.contributor).filter(c => !ids.includes(c));
    assert.deepStrictEqual(unknown, [], 'the report names contributors PROMPT_PRIORITY does not declare');

    // Not vacuous: the fixture HAS locked contracts, so the row that used to be
    // missing must be present. Without this the arithmetic below closes
    // trivially whenever no contributor is found at all.
    const contracts = budget.find(b => b.contributor === 'contracts');
    assert.ok(contracts && contracts.chars > 0,
        'the fixture has locked contracts and the report shows no contracts row — the 45% '
        + 'that used to be invisible is invisible again');

    const accounted = budget.reduce((n, b) => n + (Number(b.chars) || 0), 0);
    const sent = res.prompt.length;
    const separators = Math.max(0, budget.filter(b => b.chars > 0).length - 1) * 2;
    const gap = sent - accounted - separators;
    assert.ok(gap <= separators + 8,
        `the preview sends ${sent} characters and accounts for ${accounted} (+${separators} separators) — `
        + `${gap} unexplained, which is what a director cannot see before paying`);
});

// ── D. Priority must keep governing when the ceiling is generous ───────────

test('D: an incidental subject cannot outweigh what the shot is about', () => {
    /*
     * On a real shot the locked contracts land as SEDAN 1936, DRAGON 891,
     * location 856, MAYA 817 — a parked background car is the largest voice in
     * the prompt. Before the ceiling rose it was cut to 210: the TRIMMER was
     * accidentally the only thing enforcing priority, and removing the pressure
     * removed the policy.
     *
     * Prominence is derived from DECLARED DATA, never from a type hierarchy and
     * never from first textual mention. A car can be a hero object, and
     * screenplay prose routinely opens on foreground geography before the
     * protagonist — so "whoever is named first wins" would silently cap intent
     * as badly as "characters beat props" would.
     *
     * The order that IS defensible, because every term already exists in code:
     * the framing subject or blocking target first; then subjects the scene
     * card explicitly puts in shot; then profiles that are merely locked and
     * incidental to this frame. A camera note or direction naming a subject can
     * promote it.
     */
    const sp = require('../lib/storyboard-prompt');
    assert.ok(typeof sp.rankContributions === 'function',
        'nothing ranks contributions by what the shot is of, so whichever subject was '
        + 'described at greatest length dominates every frame it appears in');

    const shot = {
        framingSubject: 'MAYA',
        card: {
            characters: ['MAYA', 'DRAGON'],
            props: ['SEDAN'],
            camera: { note: 'Hold on MAYA as the DRAGON crosses behind her.' },
        },
    };
    const contributions = [
        { subject: 'SEDAN', kind: 'prop', chars: 1936 },
        { subject: 'DRAGON', kind: 'character', chars: 891 },
        { subject: 'MAYA', kind: 'character', chars: 817 },
        { subject: 'sewer plate', kind: 'prop', chars: 1457 },
    ];
    const ranked = sp.rankContributions(contributions, shot);
    const order = ranked.map(r => r.subject);

    assert.strictEqual(order[0], 'MAYA',
        `the framing subject ranked ${order.indexOf('MAYA') + 1} of ${order.length} (${order.join(' > ')})`);
    assert.ok(order.indexOf('sewer plate') > order.indexOf('SEDAN'),
        'a profile the card never puts in shot outranked one it does');

    const by = Object.fromEntries(ranked.map(r => [r.subject, r.chars]));
    assert.ok(by.MAYA >= by.SEDAN,
        `the framing subject keeps ${by.MAYA} characters against a secondary ${by.SEDAN} `
        + '(the sedan IS on the card — secondary, not incidental)');
});

// ── E. A negative that reaches nothing is not a negative ───────────────────

test('E: every image adapter either sends the negative or folds it in', async () => {
    /*
     * Probed through each adapter's REAL request builder rather than by
     * grepping, because the question is what the provider receives.
     *
     * Measured today: meshy emits { ai_model, prompt } and drops the negative
     * entirely; runway emits promptText and drops it; openai folds it into the
     * positive as "Avoid: ..."; gridlight passes the payload through. So on two
     * of four adapters — including the one this production runs — every
     * negative ever written is dead code. That includes the ones added to fix
     * expensive failures: recompose's "original background, unchanged
     * background" and the anchor's "different location, rebuilt set".
     *
     * The invariant is OUTCOME-based, as it must be: we have no endpoint
     * evidence that Meshy accepts a negative field, so an adapter may satisfy
     * this by sending it natively OR by folding it into the positive. What it
     * may not do is silently discard it.
     */
    const SENTINEL = 'ZQNEGATIVEPROBE';
    const payload = { prompt: 'a wet suburban street at dusk', negative_prompt: SENTINEL,
        width: 1024, height: 576 };

    const dropped = [];
    for (const { id, adapter } of imageAdapters()) {
        const declared = adapter.negativePromptSupport || adapter.supportsNegativePrompt;
        const builder = adapter.buildImageRequest
            || (() => { try { return require(`../lib/providers/${id === 'openai' ? 'openai-image' : id}`).buildImageRequest; } catch (_) { return null; } })();

        if (!builder) {
            // A pass-through adapter satisfies this only if it declares so.
            if (!declared) dropped.push(`${id}: no request builder to probe and no declared negative support`);
            continue;
        }
        const request = builder(payload);
        /*
         * A DECLARED drop is a decision, not dead code. MuAPI has no negative
         * field, and folding it in as "Avoid: …" named the excluded things to
         * the model; the director chose to send nothing there. Allowed only when
         * the adapter says so with its reason, and then the builder must really
         * not send it.
         */
        if (adapter.supportsNegativePrompt === false) {
            if (!String(adapter.negativePromptReason || '').trim()) {
                dropped.push(`${id}: declares no negative support and gives no reason`);
            } else if (JSON.stringify(request).includes(SENTINEL)) {
                dropped.push(`${id}: declares the negative is not sent, and its builder sends it`);
            }
            continue;
        }
        if (!JSON.stringify(request).includes(SENTINEL)) {
            dropped.push(`${id}: the negative reaches the provider in neither a native field nor the positive prompt`);
        }
    }
    assert.deepStrictEqual(dropped, [],
        'a negative prompt that reaches no provider field is dead code, and the shot-specific '
        + 'negatives written to stop known failures are the ones being discarded');
});

test('E2: a declared seed capability is proven through the real builder', () => {
    /*
     * Three of four image adapters drop `seed` — only gridlight passes the
     * payload through — and nothing says so, while the render ledger stores a
     * seed per generation as though it meant reproducibility. That is why a
     * proposed 4000-vs-16000 comparison was withdrawn: on Meshy it could never
     * have been controlled.
     *
     * A boolean alone is not enough. An adapter that declares support must be
     * able to SHOW it, or the declaration is the same guess in a new place.
     * Declaring false is legitimate and must stay visibly false.
     */
    const SEED = 987654;
    const undeclared = [];
    const lying = [];

    for (const { id, adapter } of imageAdapters()) {
        if (adapter.supportsSeed === undefined) { undeclared.push(id); continue; }
        if (adapter.supportsSeed !== true) continue;

        let builder = adapter.buildImageRequest;
        if (!builder) {
            try { builder = require(`../lib/providers/${id === 'openai' ? 'openai-image' : id}`).buildImageRequest; }
            catch (_) { builder = null; }
        }
        if (!builder) continue;   // pass-through adapters carry the whole payload
        if (!JSON.stringify(builder({ prompt: 'p', seed: SEED })).includes(String(SEED))) {
            lying.push(`${id}: declares supportsSeed but the seed never reaches the request`);
        }
    }
    assert.deepStrictEqual(undeclared, [],
        'these adapters do not declare whether a seed survives, so the ledger records a '
        + 'reproducibility guarantee nobody has checked');
    assert.deepStrictEqual(lying, [], 'a declared seed capability is not real');
});

// ── The declared ceiling must not claim evidence it lacks ──────────────────

test('the declared ceiling is backed by the length actually verified', () => {
    /*
     * meshy.js and the ceiling test present 16000 as established by generation.
     * What was established is 11,671 — one accepted request. The builder
     * already emits 12,934 on 3A, above the only length ever proven to work.
     *
     * The number may well be fine. The claim is what is wrong: a comment that
     * says "verified" about a figure nobody verified is how the next person
     * inherits a guess believing it is a measurement. Either the evidence
     * covers the declared ceiling, or the wording says what it really is.
     */
    const src = read('lib/providers/meshy.js');
    const block = src.slice(Math.max(0, src.indexOf('promptLimit: 16000') - 1600),
        src.indexOf('promptLimit: 16000'));
    const claimsVerified = /verified by generation|verified by a real|seen to work/i.test(block);
    const statesTheGap = /11,?671/.test(block) && /(not been (verified|tested)|above the|only length)/i.test(block);
    assert.ok(!claimsVerified || statesTheGap,
        'the ceiling comment claims verification for 16000 while the measured accepted '
        + 'length is 11,671 and the builder already emits 12,934 — say which is which');
});

// ── The four integration checks ────────────────────────────────────────────
//
// Every one of these exists because a fix passed its own test and changed
// nothing a director would ever see. The seam was built and never wired; the
// helper was written and never called. Testing the seam I had just built,
// rather than the path the money takes, is how four defects hid behind green.

test('A3: no hop is ever handed a prompt over its own ceiling', async () => {
    /*
     * BEHAVIOURAL, and rewritten after a false green that was entirely my
     * doing. The first A3 checked the SHAPE of the argument passed to
     * generateImageWithFallback, so a function named `buildFor` satisfied it —
     * and that function closed over the already-flat payload and called
     * trimToAllowance on it. A slicer with a better name. It passed the test
     * and shipped the exact defect the test existed to stop.
     *
     * What matters is not whether a factory is passed. It is what each provider
     * RECEIVES. So this drives the real chain runner over fakes with real
     * ceilings and asserts no hop is handed more than it declares — satisfied
     * today by skipping, and satisfied later by a genuine per-adapter rebuild,
     * without the test caring which.
     */
    const { runImageFallbackChain } = require('../lib/image-fallback');
    assert.ok(typeof runImageFallbackChain === 'function', 'no injectable chain runner');

    const ceilings = imageAdapters().map(({ id, adapter }) => ({ id, limit: Number(adapter.promptLimit) || 0 }));
    const received = [];
    const fakes = ceilings.map(({ id, limit }) => ({
        id, promptLimit: limit,
        generate: async (_c, payload) => {
            received.push({ id, chars: String((payload && payload.prompt) || '').length });
            return { ok: false, error: 'insufficient credits' };
        },
    }));

    // A Meshy-length prompt, the state a real project is now in.
    await runImageFallbackChain(fakes, { prompt: 'x'.repeat(12000), width: 1024, height: 576 }, {});

    const over = received
        .filter(r => { const c = ceilings.find(x => x.id === r.id); return c.limit && r.chars > c.limit; })
        .map(r => `${r.id}: received ${r.chars} against its ${ceilings.find(x => x.id === r.id).limit} ceiling`);
    assert.deepStrictEqual(over, [],
        'a provider was handed a prompt built for a different one');
});

test('A4: a flat payload is never silently cut to fit a smaller provider', () => {
    /*
     * The other half, and the reason A3 alone is not enough: "no hop exceeds
     * its ceiling" can be satisfied by slicing, which is how the false green
     * happened. Cutting a finished prompt discards whatever the priority order
     * had protected — the shot, the camera, the director's own words — because
     * by then nothing knows which characters those were.
     *
     * So the paid path must not apply a length trim to an assembled payload.
     * Skipping is honest; cutting is not.
     */
    const src = strip(read('routes/storyboard.js'));
    const fn = src.slice(src.indexOf('async function callImageGen'),
        src.indexOf('async function callImageGenStream'));
    assert.ok(fn.length, 'callImageGen is gone');
    assert.ok(!/trimToAllowance|\.slice\(0,\s*(room|ceiling|limit)/.test(fn),
        'the paid path cuts an assembled prompt to fit a provider, which throws away '
        + 'whatever priority had protected — skip the hop or rebuild it, do not slice it');
});

test('A5: paid storyboard payloads are rebuilt from structured context per adapter', () => {
    const { buildImagePayloadForAdapter } = require('../lib/capability-payloads');
    assert.strictEqual(typeof buildImagePayloadForAdapter, 'function',
        'there is no structured per-adapter image builder');

    const contract = 'LOW_CONTRACT clause describing background trim, '.repeat(90);
    const ctx = {
        sceneCard: {
            shot_code: 'A5', description: 'HERO_SENTINEL holds frame centre.',
            camera: { shot_type: 'wide', lens: '35mm', movement: 'static' },
            lighting: { type: 'natural' }, characters: [], props: [],
        },
        characters: [], location: null, props: [], references: [],
        project: { id: 'a5', provider_config: '{}', style_preset: 'cinematic' },
        consistency: {
            prompt_additions: [contract],
            prompt_addition_items: [{
                subject_name: 'BACKGROUND', profile_type: 'prop', text: contract,
            }],
        },
        overrides: { seed: 42 },
    };
    const adapters = imageAdapters().map(x => x.adapter)
        .filter(a => Number(a.promptLimit) > 0)
        .sort((a, b) => Number(b.promptLimit) - Number(a.promptLimit));
    const roomy = buildImagePayloadForAdapter(ctx, adapters[0]);
    const tight = buildImagePayloadForAdapter(ctx, adapters[adapters.length - 1]);

    assert.ok(roomy.prompt.length > tight.prompt.length,
        'the smaller adapter received the same assembled prompt instead of a rebudgeted one');
    assert.ok(tight.prompt.includes('HERO_SENTINEL') && tight.prompt.includes('masterpiece'),
        'rebudgeting discarded protected shot intent or closing quality before background prose');
    assert.ok(tight.prompt.length <= Number(adapters[adapters.length - 1].promptLimit),
        'the rebuilt tight payload still exceeds its adapter ceiling');

    const route = strip(read('routes/storyboard.js'));
    const wired = [...route.matchAll(/buildImagePayloadForAdapter\s*\(/g)].length;
    assert.ok(wired >= 3,
        `only ${wired} paid board path(s) rebuild from structured context; expected sync, stream, and regenerate`);
});

test('D2: the ranking is applied by production, not merely exported', () => {
    /*
     * rankContributions appeared at its definition, its export, and in a test —
     * nowhere else. It reordered metadata and touched no prompt, so the sedan
     * still shipped 1936 characters against Maya's 817. A helper nothing calls
     * is documentation with a test attached.
     */
    const callers = [];
    for (const rel of ['lib/storyboard-prompt.js', 'lib/capability-payloads.js',
        'lib/consistency-apply.js', 'routes/storyboard.js']) {
        const src = strip(read(rel));
        const uses = [...src.matchAll(/rankContributions\s*\(/g)].length;
        const defines = /function rankContributions\s*\(/.test(src) ? 1 : 0;
        if (uses - defines > 0) callers.push(rel);
    }
    assert.ok(callers.length > 0,
        'rankContributions is defined and exported and called by nothing, so priority still '
        + 'does not govern what survives into the prompt');
});

test('D3: on a real shot the framing subject outranks a secondary one', async () => {
    /*
     * The behavioural half. Driven through the real preview so it sees the
     * consistency application, where the contracts are actually allocated.
     */
    const { handleStoryboard } = require('../routes/storyboard');
    const { db, generateId } = require('../db/database');

    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?,?,?)')
        .run(projectId, 'Ranking', JSON.stringify({ image: 'meshy' }));
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?,?,?,?)')
        .run(sceneId, projectId, '1', 'STREET');
    db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?,?,?,?)')
        .run(generateId(), projectId, 'MAYA', 'M'.repeat(300));
    db.prepare('INSERT INTO film_props (id, project_id, name, visual_prompt) VALUES (?,?,?,?)')
        .run(generateId(), projectId, 'SEDAN', 'P'.repeat(300));
    // DISTINCT bodies. Identical 'C...' runs share prefixes, so the route's
    // longest-prefix attribution could credit one subject's surviving text to
    // the other and the assertion would pass or fail for the wrong reason.
    for (const [name, kind, text] of [['MAYA', 'character', 'MAYAWEARS ' + 'm'.repeat(790)],
        ['SEDAN', 'prop', 'SEDANPAINT ' + 's'.repeat(1889)]]) {
        db.prepare(`INSERT INTO film_consistency_profiles
            (id, project_id, profile_type, subject_name, status, prompt_contract)
            VALUES (?,?,?,?,'locked',?)`).run(generateId(), projectId, kind, name, text);
    }
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?,?,?,?,?)')
        .run(shotId, sceneId, 'R1', JSON.stringify({
            shot_code: 'R1', description: 'MAYA on the kerb, the SEDAN behind her.',
            framing_subject: 'MAYA',
            camera: { shot_type: 'close-up', lens: '85mm', movement: 'static' },
            characters: ['MAYA'], props: ['SEDAN'],
        }), 4000);

    const res = await new Promise(resolve => {
        const chunks = [];
        const r = new (require('stream').Writable)({ write(c, _e, n) { chunks.push(c); n(); } });
        r.statusCode = 200; r.writeHead = function (c) { this.statusCode = c; return this; };
        r.setHeader = function () {};
        r.on('finish', () => { let b = Buffer.concat(chunks).toString(); try { b = JSON.parse(b); } catch (_) {} resolve(b); });
        Promise.resolve(handleStoryboard({ method: 'GET', body: {} }, r, ['film', 'shots', shotId, 'prompt'], {}))
            .catch(e => resolve({ error: e.message }));
    });

    const by = Object.fromEntries((res.contributors || []).map(c => [c.subject, c.survived]));
    assert.ok(by.MAYA !== undefined && by.SEDAN !== undefined,
        `both subjects should be reported, got ${JSON.stringify(by)}`);
    assert.ok(by.MAYA >= by.SEDAN,
        `the framing subject survived ${by.MAYA} characters against a secondary ${by.SEDAN}`);
});

test('E3: the request a provider receives fits that provider ceiling', () => {
    /*
     * Folding the negative happens AFTER the prompt is budgeted, so a prompt
     * built to exactly the ceiling plus "Avoid: ..." exceeds it. The earlier
     * check inspected payload.prompt before the adapter built anything, so it
     * could not see the request that is actually sent.
     */
    const over = [];
    for (const { id, adapter } of imageAdapters()) {
        const limit = Number(adapter.promptLimit) || 0;
        if (!limit) continue;
        let builder = adapter.buildImageRequest;
        if (!builder) {
            try { builder = require(`../lib/providers/${id === 'openai' ? 'openai-image' : id}`).buildImageRequest; }
            catch (_) { builder = null; }
        }
        if (!builder) continue;

        const req = builder({ prompt: 'x'.repeat(limit), negative_prompt: 'y'.repeat(200),
            width: 1024, height: 576 });
        const body = (req && req.body) || req || {};
        /*
         * Not every provider puts the prompt in a field called `prompt`.
         * Gemini carries it as a text part inside an `input` array, so reading
         * only body.prompt found an empty string and passed VACUOUSLY — a
         * guard that reports green on an adapter it cannot see is worse than
         * no guard, because the next one inherits the blind spot.
         */
        const fromInput = Array.isArray(body.input)
            ? body.input.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n')
            : '';
        const sent = String(body.prompt || body.promptText || fromInput || '');
        if (!sent) {
            over.push(`${id}: its request carries no readable prompt, so this check cannot see what it sends`);
            continue;
        }
        if (sent.length > limit) {
            over.push(`${id}: sends ${sent.length} against its ${limit} ceiling once the negative is folded`);
        }
    }
    assert.deepStrictEqual(over, [], 'folding the negative pushed the request past the ceiling');
});

test('D4: priority still governs when no framing subject is declared', async () => {
    /*
     * THE FIFTH FALSE GREEN, AND THE ONE THAT SURVIVED INTO A COMMIT.
     *
     * rankContributions tiers on the framing subject first, then what the card
     * puts in shot, then incidentals — and the cap only binds BETWEEN tiers.
     * Both of D's fixtures set framing_subject, so both passed.
     *
     * No real card sets it. Checked every shot on a live production — 1A, 1B,
     * 1C, 2A, 3A, 3B — all `(none)`. So on real data the cast and the props all
     * land in tier 1 together, nothing is capped, and the longest contract wins
     * exactly as before. Measured on the running server after the fix shipped:
     *
     *   SEDAN:1936  DRAGON:891  SUBURBAN STREET:856  MAYA:817  Grocery bag:685
     *
     * A parked car, still the largest voice in the prompt. I wrote fixtures
     * that supplied the one field production never supplies.
     *
     * So this fixture deliberately OMITS framing_subject, which is the shape
     * every real card has.
     */
    const { handleStoryboard } = require('../routes/storyboard');
    const { db, generateId } = require('../db/database');

    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?,?,?)')
        .run(projectId, 'NoFraming', JSON.stringify({ image: 'meshy' }));
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?,?,?,?)')
        .run(sceneId, projectId, '1', 'STREET');
    db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?,?,?,?)')
        .run(generateId(), projectId, 'MAYA', 'm'.repeat(300));
    db.prepare('INSERT INTO film_props (id, project_id, name, visual_prompt) VALUES (?,?,?,?)')
        .run(generateId(), projectId, 'SEDAN', 's'.repeat(300));
    for (const [name, kind, text] of [['MAYA', 'character', 'MAYAWEARS ' + 'm'.repeat(790)],
        ['SEDAN', 'prop', 'SEDANPAINT ' + 's'.repeat(1889)]]) {
        db.prepare(`INSERT INTO film_consistency_profiles
            (id, project_id, profile_type, subject_name, status, prompt_contract)
            VALUES (?,?,?,?,'locked',?)`).run(generateId(), projectId, kind, name, text);
    }
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?,?,?,?,?)')
        .run(shotId, sceneId, 'N1', JSON.stringify({
            shot_code: 'N1',
            description: 'MAYA on the kerb, the SEDAN behind her.',
            // NO framing_subject — the shape of every real card.
            camera: { shot_type: 'close-up', lens: '85mm', movement: 'static' },
            characters: ['MAYA'], props: ['SEDAN'],
        }), 4000);

    const res = await new Promise(resolve => {
        const chunks = [];
        const r = new (require('stream').Writable)({ write(c, _e, n) { chunks.push(c); n(); } });
        r.statusCode = 200; r.writeHead = function (c) { this.statusCode = c; return this; };
        r.setHeader = function () {};
        r.on('finish', () => { let b = Buffer.concat(chunks).toString(); try { b = JSON.parse(b); } catch (_) {} resolve(b); });
        Promise.resolve(handleStoryboard({ method: 'GET', body: {} }, r, ['film', 'shots', shotId, 'prompt'], {}))
            .catch(e => resolve({ error: e.message }));
    });

    const by = Object.fromEntries((res.contributors || []).map(c => [c.subject, c.survived]));
    assert.ok(by.MAYA !== undefined && by.SEDAN !== undefined,
        `both subjects should be reported, got ${JSON.stringify(by)}`);
    assert.ok(by.SEDAN <= by.MAYA,
        `with no framing subject declared, the prop kept ${by.SEDAN} characters against the `
        + `character's ${by.MAYA} — the longest description still wins on every real card`);
});
