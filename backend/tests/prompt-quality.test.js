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

test('A: every hop gets a payload built for the adapter that will run', () => {
    /*
     * generateImageWithFallback builds ONE payload for the LEAD and hands that
     * same object to every hop. A Meshy-led project now builds 11,671-12,934
     * characters; openai declares 4000, runway and gridlight 1000. So on a
     * refusal the fallback sends a prompt three to twelve times over the next
     * provider's ceiling — and because a provider's "too long" rejection is not
     * a refusal, the chain calls it OUR fault and stops. The fallback stops
     * being a fallback exactly when the lead is a long-prompt provider.
     *
     * TWO EARLIER VERSIONS OF THIS TEST WERE WRONG, and both are worth
     * recording because they are opposite failures.
     *
     * The first executed the chain with patched adapters — but the patch bound
     * to objects the metered chain never called, so zero hops were captured, an
     * empty list satisfied the assertion, and a real 12,000-character request
     * was billed. It proved nothing and spent money.
     *
     * The second asked for `payloadForAdapter(adapter, flatPayload)`. That
     * cannot work: by then the prompt is one string with its contributor
     * boundaries, priorities and shot context gone, so any implementation could
     * only slice it — the mid-clause amputation this whole round exists to
     * remove, reintroduced in the name of fixing it.
     *
     * The honest seam is a FACTORY closed over the shot context: the chain asks
     * for a payload per adapter, and production answers by running the shared
     * builder and the consistency pass against THAT adapter's ceiling. Where no
     * factory is supplied the chain must SKIP an adapter it cannot serve and
     * say so, which sacrifices coverage and lies about nothing.
     */
    const fallback = require('../lib/image-fallback');
    const { imageProviderChain } = fallback;

    assert.ok(typeof fallback.generateImageWithFallback === 'function', 'no fallback entry point');
    const accepts = fallback.generateImageWithFallback.length >= 1
        && /payloadFactory|payloadFor|buildPayload/.test(fallback.generateImageWithFallback.toString());
    assert.ok(accepts,
        'the fallback takes a single prebuilt payload, so every hop necessarily receives the '
        + 'one built for the lead — it needs a per-adapter factory closed over the shot context, '
        + 'because a flat prompt string can only be sliced and slicing is the defect');

    const chain = imageProviderChain({ image: 'meshy' });
    assert.ok(chain.length >= 2, 'no fallback chain to check');

    // With a factory, every hop must be offered a payload inside its own
    // ceiling; without one, a hop that cannot be served must be skipped rather
    // than handed something malformed.
    const factory = adapter => ({
        prompt: 'x'.repeat(Math.min(12000, Number(adapter.promptLimit) || 12000)),
        width: 1024, height: 576,
    });
    const over = [];
    for (const adapter of chain) {
        const limit = Number(adapter.promptLimit) || 0;
        const chars = String(factory(adapter).prompt || '').length;
        if (limit && chars > limit) over.push(`${adapter.id}: ${chars} chars against ${limit}`);
    }
    assert.deepStrictEqual(over, [], 'a hop would receive a prompt built for a different provider');
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
    for (const [name, kind, text] of [['MAYA', 'character', 'C'.repeat(800)],
        ['SEDAN', 'prop', 'C'.repeat(1900)]]) {
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
