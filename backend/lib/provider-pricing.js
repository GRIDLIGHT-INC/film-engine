/**
 * What a generation actually costs, per provider, in the provider's own units.
 *
 * The budget area was built for a live-action production — day rates, catering,
 * shooting days, a 10% contingency. None of that is what this pipeline spends.
 * It spends TOKENS at Anthropic, CREDITS at Meshy and Runway, CHARACTERS and
 * SECONDS at ElevenLabs, and per-image charges at OpenAI. Those are the line
 * items, and `lib/flow-cost.js` was the only thing in the repo that carried a
 * price at all — eleven round numbers, deliberately on the high side, existing
 * solely to refuse a run before it starts. It says so itself: "nothing here
 * claims to be a price list". This is the price list.
 *
 * Two units per capability, and the distinction is the whole design:
 *
 *   `unit`         what the ADAPTER can measure from a real request/response —
 *                  tokens returned in `usage`, characters of text sent, seconds
 *                  of media asked for, or (when a provider charges flat per
 *                  request) the call itself.
 *   `native_unit`  what the PROVIDER bills in, which is what the user tops up
 *                  and watches drain. Runway meters in seconds and bills in
 *                  credits; ElevenLabs meters in characters and bills in
 *                  credits. Reporting only dollars hides the number that
 *                  actually runs out.
 *
 * Keeping them separate means an adapter never has to know a price, and the
 * book never has to guess at a quantity. Neither can drift into the other's job.
 *
 * Every rate carries its SOURCE and the date it was checked. A rate with no
 * source cannot be re-verified when a provider changes its pricing, and an
 * un-recheckable number does not stay approximately right — it decays into a
 * confident lie, which is worse than no tracking at all because it gets
 * budgeted against. `film_provider_rates` (migration 076) overrides any entry
 * here per install, so a user on a different plan corrects their own book
 * without editing code and without losing the researched default underneath.
 */

const { CAPABILITIES } = require('./providers/base');

/** Units an adapter may meter in. A unit outside this list cannot be priced. */
// 'megapixel' is here because FLUX.2 genuinely bills that way: a 4MP frame
// costs four times a 1MP one, and pricing it per image would under-report every
// large board by exactly that factor. A unit is added when a provider bills in
// it, never to make a number fit.
const BILLING_UNITS = ['token', 'character', 'second', 'image', 'megapixel', 'call'];

const M = 1 / 1_000_000;   // per-million-token rates, expressed per token

/**
 * Published rates, keyed `provider:capability`.
 *
 * `models` overrides any field of the parent entry for one model id. A model
 * the table does not name falls back to the parent — never to zero, because a
 * model that prices at nothing is indistinguishable from one nobody used.
 */
/**
 * WHAT A SUBSCRIPTION COSTS, AND WHY IT IS NOT A PER-TOKEN RATE.
 *
 * Anthropic publishes a PRICE for these plans and does not publish a token
 * allowance. The limits are expressed as prompts in a rolling five-hour window
 * and weekly model-hours — the figures circulating for Max 20x (~200-900
 * prompts per 5h, 240-480 Sonnet hours and 24-40 Opus hours a week) come from
 * independent testing, not from Anthropic, and they are not token counts.
 *
 * So "how many tokens does the plan include" HAS NO PUBLISHED ANSWER, and
 * inventing one to divide into would be the worst kind of number: precise,
 * confident and made up. This engine has been burned by exactly that shape
 * before -- a "2048x1152" plate that arrived 1376x768 because a ceiling was
 * over-claimed.
 *
 * What is true instead, and is worth reporting:
 *
 *   1. The subscription is a FIXED monthly cost. It is spent whether this
 *      project uses it or not.
 *   2. The MARGINAL cost of a token on a subscription is ZERO. A project that
 *      runs one more breakdown is billed nothing more.
 *   3. What an agency actually needs is ATTRIBUTION, not price: this project
 *      consumed X% of the tokens metered this period, so it carries X% of the
 *      monthly fee.
 *
 * (3) is measured, not assumed -- the engine already counts every token it
 * sends. It is reported separately from `measured_usd` and never added to it,
 * because a sunk monthly fee is not a variable cost of a shot and adding it
 * would make the per-shot figure lie in both directions at once.
 */
const SUBSCRIPTION_PLANS = Object.freeze({
    none:    { label: 'API pay-as-you-go',      usd_per_month: 0 },
    pro:     { label: 'Claude Pro',             usd_per_month: 20 },
    max_5x:  { label: 'Claude Max 5x',          usd_per_month: 100 },
    max_20x: { label: 'Claude Max 20x',         usd_per_month: 200 },
    team:    { label: 'Claude Team (per seat)', usd_per_month: 30 },
});

const SUBSCRIPTION_SOURCE = Object.freeze({
    checked: '2026-09-01',
    note: 'Anthropic publishes plan PRICES; it does not publish token allowances. Plan limits '
        + 'are prompts per rolling 5-hour window and weekly model-hours. Any token-per-dollar '
        + 'figure here is DERIVED from tokens this install actually metered, never from a '
        + 'published allowance.',
});

/**
 * This project's share of a fixed monthly fee, by the tokens it actually used.
 *
 * Returns a null share rather than zero when there is nothing to divide by: a
 * period with no metered tokens gives 0/0, and reporting that as $0.00 would
 * read as "the subscription cost this project nothing" rather than "there is
 * not enough information yet".
 */
function subscriptionAttribution(o) {
    const key = String((o && o.plan) || 'none');
    const plan = SUBSCRIPTION_PLANS[key];
    if (!plan || !(plan.usd_per_month > 0)) return null;
    const mine = Number(o && o.project_tokens) || 0;
    const all = Number(o && o.period_tokens) || 0;
    if (!(all > 0) || !(mine > 0)) {
        return { plan: key, plan_label: plan.label, usd_per_month: plan.usd_per_month,
                 share: null, attributed_usd: null,
                 note: 'No tokens metered in this period yet, so there is nothing to attribute against.',
                 ...SUBSCRIPTION_SOURCE };
    }
    const share = Math.min(1, mine / all);
    return {
        plan: key, plan_label: plan.label, usd_per_month: plan.usd_per_month,
        project_tokens: mine, period_tokens: all,
        share: Number(share.toFixed(4)),
        attributed_usd: Number((plan.usd_per_month * share).toFixed(2)),
        marginal_usd: 0,
        inferred: true,
        note: `This project used ${Math.round(share * 1000) / 10}% of the tokens this install `
            + `metered in the period, so it carries that share of the ${plan.label} fee. The `
            + 'MARGINAL cost of these tokens was zero -- the fee is paid whether the project runs '
            + 'or not -- so this is an attribution for billing a client, not a cost of the shot. '
            + 'Never added to measured spend.',
        ...SUBSCRIPTION_SOURCE,
    };
}

const RATE_BOOK = {

    // ── Anthropic ─────────────────────────────────────────────────────────
    // Billed per token, input and output at different rates, so the price is
    // in `components` and the meter reports the split. A blended rate would be
    // wrong by 5x in either direction depending on the shape of the call.
    'anthropic:llm': {
        unit: 'token', native_unit: 'token', native_per_unit: 1,
        // Billed to a Claude SUBSCRIPTION, not per call.
        //
        // This pipeline reaches an LLM through an agent host — Claude Desktop
        // connected to backend/mcp-server.js — and the host IS the model. That
        // is the whole reason `tests/mcp-no-server-llm.test.js` exists: a tool
        // that hands reasoning back to a server-side LLM asks the user to hold
        // a second key for a question the connected model has already read.
        //
        // So the project is charged nothing. Pricing a feature-length
        // breakdown at API list rates would invent thousands of dollars that
        // were never billed, and it would be the LARGEST line in the report —
        // a number confidently wrong in the direction that makes AI filmmaking
        // look unaffordable.
        //
        // Tokens are still metered, because "how much reasoning did this film
        // take" is a real question and the subscription has its own limits.
        // The published rates below are kept, not deleted, so an install that
        // genuinely pays per token can switch this off with one rate override
        // rather than having to find the numbers again.
        subscription: true,
        subscription_note: 'Runs on your Claude subscription through the MCP host, not a metered API. Tokens are counted; dollars are not charged to the project.',
        components: { input: 5.00 * M, output: 25.00 * M },
        models: {
            'claude-opus-5':    { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-opus-4-8':  { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-opus-4-7':  { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-opus-4-6':  { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-fable-5':   { components: { input: 10.00 * M, output: 50.00 * M } },
            'claude-sonnet-5':  { components: { input: 3.00 * M,  output: 15.00 * M } },
            'claude-sonnet-4-6':{ components: { input: 3.00 * M,  output: 15.00 * M } },
            'claude-haiku-4-5': { components: { input: 1.00 * M,  output: 5.00 * M } },
        },
        source: 'https://docs.claude.com/en/docs/about-claude/pricing',
        checked: '2026-09-07',
        note: 'Not charged to the project: the LLM runs on a Claude subscription through the MCP host. The per-million-token list rates are kept for installs that pay per token — clear the subscription flag with a rate override to apply them. Cache reads bill at ~0.1x and cache writes at ~1.25x.',
    },

    // ── OpenAI ────────────────────────────────────────────────────────────
    'openai:llm': {
        unit: 'token', native_unit: 'token', native_per_unit: 1,
        components: { input: 2.00 * M, output: 8.00 * M },
        models: {
            'gpt-4.1':      { components: { input: 2.00 * M, output: 8.00 * M } },
            'gpt-4.1-mini': { components: { input: 0.40 * M, output: 1.60 * M } },
            'gpt-4o':       { components: { input: 2.50 * M, output: 10.00 * M } },
        },
        source: 'https://platform.openai.com/docs/pricing',
        checked: '2026-08-22',
        note: 'Not on the preferred path for this install — llm resolves to Anthropic.',
    },
    // Charged per image, by quality and size, not per token.
    /*
     * Google — Nano Banana 2 and Nano Banana Pro.
     *
     * Priced PER IMAGE and per output size, because that is how the model
     * bills: a 4K frame from Pro is not the same purchase as a 1K draft, and
     * averaging them would make the precision tier look free on a board that
     * used it once and cheap on one that used it everywhere.
     */
    /*
     * The Nano Banana family bought from MuAPI rather than from Google.
     *
     * CHEAPER THAN THE SOURCE, which is the opposite of the Meshy line below
     * and is why the preference walk tries this first. MuAPI lists Nano Banana
     * 2 at $0.06 for a 1K frame against Google's published $0.067, and the same
     * key already pays for Seedance footage — one vendor, one invoice, and no
     * second billing relationship to go wrong.
     */
    'muapi:image': {
        unit: 'image', native_unit: 'image', native_per_unit: 1,
        usd_per_native: 0.06,
        /*
         * Read from MuAPI's own /models catalogue rather than from a blog post,
         * which corrected two figures and deleted five rows that never existed.
         *
         * Nano Banana Pro was held at Google's $0.134 and flagged inferred on
         * the belief that MuAPI quotes rather than lists it. MuAPI lists it, at
         * $0.12 -- so the ceiling was over-reporting every Pro board, and the
         * `inferred` flag made that look like diligence.
         *
         * The `-2k` and `-4k` rows were fiction. Resolution on MuAPI is a FIELD
         * on one endpoint, not a separate product, so nothing could ever be
         * priced under those names -- and the code that would have produced them
         * compared a lowercase tier against uppercase literals, so it never
         * fired either. Two mistakes cancelling is not a working price list.
         */
        models: {
            'nano-banana-pro':    { usd_per_native: 0.12 },
            'nano-banana-2':      { usd_per_native: 0.06 },
            'nano-banana-2-lite': { usd_per_native: 0.03 },
            'nano-banana':        { usd_per_native: 0.03 },
        },
        source: 'https://api.muapi.ai/api/v1/models',
        checked: '2026-08-31',
        note: 'Per-image list prices from MuAPI\'s own catalogue endpoint. The editing '
            + 'endpoints (-edit) are listed at the same rate as their text-to-image twins, '
            + 'so a referenced frame costs what an unreferenced one does. Refresh with '
            + 'backend/tests/refresh-muapi-contract.js.',
    },

    'google:image': {
        unit: 'image', native_unit: 'image', native_per_unit: 1,
        usd_per_native: 0.067,
        models: {
            'gemini-3.1-flash-image':      { usd_per_native: 0.067 },  // Nano Banana 2, 1K
            'gemini-3.1-flash-image-2k':   { usd_per_native: 0.067 },
            // Google does not publish a separate 4K figure for the flash model.
            // Held at the Pro 1K rate as a FLOOR and flagged, rather than
            // quietly inheriting the 1K price — which would under-report every
            // 4K board by however much the real multiplier turns out to be.
            'gemini-3.1-flash-image-4k':   { usd_per_native: 0.134, inferred: true },
            'gemini-3.1-flash-lite-image': { usd_per_native: 0.034 },
            'gemini-3-pro-image':          { usd_per_native: 0.134 },  // Nano Banana Pro, 1K-2K
            'gemini-3-pro-image-4k':       { usd_per_native: 0.24 },
        },
        source: 'https://ai.google.dev/gemini-api/docs/pricing',
        checked: '2026-08-25',
        note: 'Nano Banana 2 ~$0.067 per 1K image; Nano Banana Pro ~$0.134 at 1K-2K. The 4K Pro figure is the published tier for the larger output.',
    },

    /*
     * Black Forest Labs — FLUX.2.
     *
     * Billed PER MEGAPIXEL rather than per image, which is why the rate carries
     * a megapixel unit: a 4MP frame genuinely costs four times a 1MP one, and
     * pricing per image would under-report every large board by that factor.
     * Klein is the exception and is quoted flat per image.
     */
    'bfl:image': {
        unit: 'megapixel', native_unit: 'megapixel', native_per_unit: 1,
        usd_per_native: 0.03,
        models: {
            'flux-2-klein': { unit: 'image', native_unit: 'image', usd_per_native: 0.015 },
            'flux-2-flex':  { usd_per_native: 0.02 },
            'flux-2-pro':   { usd_per_native: 0.03 },   // editing with references: $0.045/MP
            'flux-2-max':   { usd_per_native: 0.045 },
        },
        source: 'https://bfl.ai/pricing',
        checked: '2026-08-25',
        note: 'FLUX.2 Pro $0.03/MP generating, $0.045/MP when editing with reference images. Klein 4B from $0.014 and 9B $0.015 per image. API usage includes commercial rights.',
    },

    /*
     * Seedance 2.5, via MuAPI.
     *
     * Per SECOND, and the resolution multiplies it fivefold from 720p to 4K —
     * which is the single most expensive dial in this engine and the reason the
     * adapter never rounds a resolution upward.
     */
    'seedance:video': {
        unit: 'second', native_unit: 'second', native_per_unit: 1,
        usd_per_native: 0.34,
        models: {
            'seedance-2.5-480p':  { usd_per_native: 0.17 },
            'seedance-2.5':       { usd_per_native: 0.34 },   // 720p, the unsuffixed default
            'seedance-2.5-1080p': { usd_per_native: 0.85 },
            'seedance-2.5-4k':    { usd_per_native: 1.70 },
        },
        source: 'https://muapi.ai/',
        checked: '2026-08-25',
        note: 'Per second of output: 480p $0.17, 720p $0.34, 1080p $0.85, 4K $1.70. A 10s 1080p clip is $8.50. Reached through MuAPI rather than ByteDance Ark directly.',
    },

    /*
     * The finishing pass, priced from the SAME table as the footage.
     *
     * An upscale is the `video-edit` workflow at a larger tier, so it is billed
     * per second at that tier's rate exactly as a generation is -- there is no
     * separate post rate card, and inventing one is how the draft saving and
     * the finishing cost come to disagree about what Seedance charges.
     *
     * Defaulted at the 4K rate because that is what the finishing pass is FOR.
     * Anything cheaper as the default would under-report the one line a
     * director most needs to see before committing to it: finishing 30 seconds
     * at 4K is $51.
     *
     * A SECOND HERE IS A SECOND OF SOURCE, not of output, and RBF-001 measured
     * that for real money (docs/plans/rbf-001-video-edit-probe.md): this
     * endpoint IGNORES the requested duration and bills the clip handed in —
     * 4s was asked for and 9.7s came back and was charged. A FAILED job is
     * billed too: $1.658 of the probe's $3.205 bought nothing. So an estimate
     * built from a requested duration is not the price, and the adapter
     * refuses to quote an unmeasured source rather than guess one.
     *
     * The same probe is why `video-edit` is NOT offered as an edit: its
     * `images_list` entries are style references rather than keyframes. Use
     * Runway `aleph2`. These rows price the UPSCALE, which is a different act.
     */
    'seedance:post': {
        unit: 'second', native_unit: 'second', native_per_unit: 1,
        usd_per_native: 1.70,
        models: {
            'seedance-2.5-video-edit-480p':  { usd_per_native: 0.17 },
            'seedance-2.5-video-edit':       { usd_per_native: 0.34 },   // 720p, unsuffixed
            'seedance-2.5-video-edit-1080p': { usd_per_native: 0.85 },
            'seedance-2.5-video-edit-4k':    { usd_per_native: 1.70 },
        },
        source: 'https://muapi.ai/',
        checked: '2026-08-25',
        note: 'The upscale is the video-edit workflow at a larger tier, billed per second at that '
            + "tier's rate. Defaulted at 4K ($1.70/s), which is what a finishing pass is for. "
            + 'The second is a second of SOURCE, not of output: RBF-001 measured that this endpoint '
            + 'ignores the requested duration and bills the clip handed in, and that a failed job '
            + 'is charged.',
    },

    'openai:image': {
        unit: 'image', native_unit: 'image', native_per_unit: 1,
        usd_per_native: 0.042,
        models: {
            'gpt-image-1':      { usd_per_native: 0.042 },   // 1024x1024 medium
            'gpt-image-1-low':  { usd_per_native: 0.011 },
            'gpt-image-1-high': { usd_per_native: 0.167 },
        },
        source: 'https://platform.openai.com/docs/pricing',
        checked: '2026-08-22',
        note: 'gpt-image-1 at 1024x1024: low $0.011, medium $0.042, high $0.167 per image. Defaults to medium, which is what the adapter requests.',
    },

    // ── Runway ────────────────────────────────────────────────────────────
    // Video is credits per SECOND of output; images are credits per image. One
    // credit is one cent in the developer portal, which is a different pool
    // from a Runway app subscription.
    'runway:video': {
        unit: 'second', native_unit: 'credit', native_per_unit: 12, usd_per_native: 0.01,
        models: {
            'gen4.5':       { native_per_unit: 12 },
            'gen4_turbo':   { native_per_unit: 5 },
            'gen4':         { native_per_unit: 5 },
            'gen3a_turbo':  { native_per_unit: 5 },
            'act_two':      { native_per_unit: 5 },
            'veo3':         { native_per_unit: 12 },
            /*
             * The first VIDEO-TO-VIDEO row, and the only one with a minimum.
             * It bills by the length of the SOURCE clip rather than the clip
             * produced — there is no duration field on that endpoint — so a
             * careless 30-second input is $8.40, not the $1.40 a five-second
             * request would suggest.
             */
            'aleph2':       { native_per_unit: 28, minimum_native: 56 },
        },
        source: 'https://docs.dev.runwayml.com/guides/pricing/',
        checked: '2026-08-22',
        note: 'aleph2 is 28 credits/second of SOURCE with a 56-credit minimum, verified first-party in backend/tests/fixtures/aleph-contract.json. gen4.5 is 12 credits/second — a 5s clip is $0.60. gen3a_turbo and veo3 are not in the published table; they inherit their tier and are flagged as inferred.',
        inferred_models: ['gen3a_turbo', 'veo3'],
    },
    'runway:image': {
        unit: 'image', native_unit: 'credit', native_per_unit: 5, usd_per_native: 0.01,
        models: {
            'gen4_image':        { native_per_unit: 5 },    // 720p; 1080p is 8
            'gen4_image_1080p':  { native_per_unit: 8 },
            'gen4_image_turbo':  { native_per_unit: 2 },
            'gemini_2.5_flash':  { native_per_unit: 5 },
        },
        source: 'https://docs.dev.runwayml.com/guides/pricing/',
        checked: '2026-08-22',
        note: 'gen4_image: 5 credits at 720p, 8 at 1080p. gemini_2.5_flash is unpublished and inherits the base rate.',
        inferred_models: ['gemini_2.5_flash'],
    },

    // ── Meshy ─────────────────────────────────────────────────────────────
    // Flat credits per call, by model. The USD value of a credit is not
    // published per-call; it comes from the plan — Pro is $20/mo for 1,000
    // credits, so $0.02. A user on another plan overrides it in
    // film_provider_rates rather than reading a wrong number forever.
    'meshy:image': {
        unit: 'call', native_unit: 'credit', native_per_unit: 9, usd_per_native: 0.02,
        models: {
            'nano-banana':     { native_per_unit: 3 },
            // SIX, not three. This was priced at 3 and it is 6, which made the
            // Standard tier look half its real cost and put Meshy in front of
            // buying the same model from Google direct — a routing decision
            // taken on a wrong number.
            'nano-banana-2':   { native_per_unit: 6 },
            'nano-banana-pro': { native_per_unit: 9 },
            'gpt-image-2':     { native_per_unit: 9 },
            /*
             * IMAGE-TO-IMAGE IS NOT THE SAME PRICE.
             *
             * Meshy prices gpt-image-2 at 9 credits for text-to-image and 12
             * for image-to-image, and this engine's board generation ALWAYS
             * attaches references — so the path a real frame takes is the
             * dearer one. The nano-banana family costs the same either way.
             */
            'gpt-image-2-i2i': { native_per_unit: 12 },
        },
        source: 'https://docs.meshy.ai/en/api/pricing',
        checked: '2026-08-26',
        note: 'Credit costs are published; the USD value of a credit is not. $0.02 is the Pro plan rate ($20 / 1,000 credits). Override in Budget → Rates if you are on another plan. nano-banana 3, nano-banana-2 6, nano-banana-pro 9, gpt-image-2 9 text-to-image and 12 image-to-image.',
    },
    'meshy:model3d': {
        unit: 'call', native_unit: 'credit', native_per_unit: 20, usd_per_native: 0.02,
        models: {
            'meshy-5': { native_per_unit: 10 },
            'meshy-6': { native_per_unit: 20 },
            'meshy-7': { native_per_unit: 20 },
        },
        source: 'https://docs.meshy.ai/en/webapp/pricing',
        checked: '2026-08-22',
        note: 'Text-to-3D and image-to-3D: 20 credits on Meshy 6/7, 10 on Meshy 5. Remesh, rigging and animation are free.',
    },

    /*
     * World Labs Marble — spatial worlds for previs.
     *
     * $1.00 per 1,250 credits, so a credit is $0.0008. Draft is the previs
     * model and the one this engine defaults to: 250 credits is $0.20, which is
     * about what ONE storyboard frame costs here, and the whole point is that
     * camera exploration must be cheaper than re-rolling frames.
     *
     * Verified against a live generation rather than the price list alone: a
     * two-plate draft world billed exactly 250 credits and returned in 37s.
     */
    'worldlabs:world': {
        // One call, one world — the same unit meshy bills 3D in. There is no
        // 'world' billing unit and inventing one would put a value in the ledger
        // that nothing else can compare against.
        unit: 'call', native_unit: 'credit', native_per_unit: 250, usd_per_native: 0.0008,
        models: {
            'marble-1.0-draft': { native_per_unit: 250 },
            'marble-1.0': { native_per_unit: 1600 },
            'marble-1.1': { native_per_unit: 1600 },
            'marble-1.1-plus': { native_per_unit: 3100 },
        },
        source: 'https://docs.worldlabs.ai/api/pricing',
        checked: '2026-09-04',
        note: 'Draft 150-250 credits by input type, standard 1,500-1,600, plus up to 3,100. '
            + 'Splat and collider-mesh artefacts are included; HQ mesh export is 3,500 extra. '
            + 'The operation returns cost.total_credits, so the metered figure is the billed one.',
    },

    // ── ElevenLabs ────────────────────────────────────────────────────────
    // Speech bills per character; sound and music bill per second of output.
    'elevenlabs:voice': {
        unit: 'character', native_unit: 'credit', native_per_unit: 1, usd_per_native: 0.0001,
        models: {
            'eleven_multilingual_v2': { native_per_unit: 1,   usd_per_native: 0.0001 },
            'eleven_v3':              { native_per_unit: 1,   usd_per_native: 0.0001 },
            'eleven_flash_v2_5':      { native_per_unit: 0.5, usd_per_native: 0.0001 },
            'eleven_turbo_v2_5':      { native_per_unit: 0.5, usd_per_native: 0.0001 },
        },
        source: 'https://elevenlabs.io/pricing/api',
        checked: '2026-08-22',
        note: '$0.10 per 1,000 characters on Multilingual v2/v3 (1 credit per character); Flash and Turbo bill half a credit per character.',
    },
    'elevenlabs:sfx': {
        unit: 'second', native_unit: 'credit', native_per_unit: 40, usd_per_native: 0.00005,
        source: 'https://elevenlabs.io/docs/capabilities/sound-effects',
        checked: '2026-08-22',
        note: '40 credits per second when a duration is given, 200 flat when the model chooses. $0.12 per minute on the API.',
    },
    'elevenlabs:ambient': {
        unit: 'second', native_unit: 'credit', native_per_unit: 40, usd_per_native: 0.00005,
        source: 'https://elevenlabs.io/docs/capabilities/sound-effects',
        checked: '2026-08-22',
        note: 'Ambient is a looping sound-effect bed, billed as sound generation. The bed is at most 30s regardless of the shot length it is tiled across, so cost does not scale with shot duration.',
    },
    'elevenlabs:music': {
        unit: 'second', native_unit: 'credit', native_per_unit: 15, usd_per_native: 0.00016667,
        source: 'https://elevenlabs.io/pricing/api',
        checked: '2026-08-22',
        note: '$0.15 per minute on the API — about 900 credits per minute, i.e. 15 credits per second.',
    },

    // ── FluidSynth ────────────────────────────────────────────────────────
    // Instruments on this machine: a cue's notes rendered through a SoundFont.
    // Zero DELIBERATELY, flagged self_hosted, so a free render reads as local
    // rather than as a pair somebody forgot to price.
    'fluidsynth:music': {
        unit: 'second', native_unit: 'second', native_per_unit: 1, usd_per_native: 0,
        self_hosted: true,
        source: 'https://www.fluidsynth.org/',
        checked: '2026-09-13',
        note: 'Runs locally (LGPL). No per-render charge; the sample library carries its own licence, recorded on each render.',
    },

    // ── Gridlight ─────────────────────────────────────────────────────────
    // A local/self-hosted gateway. It bills nothing per call; the cost is the
    // machine it runs on. Priced at zero DELIBERATELY and said out loud, so a
    // zero in the report reads as "self-hosted" rather than "we forgot to
    // price this" — the two are indistinguishable otherwise, and the second
    // is the failure this whole file exists to prevent.
    'gridlight:*': {
        unit: 'call', native_unit: 'call', native_per_unit: 1, usd_per_native: 0,
        self_hosted: true,
        source: 'https://github.com/gridlight/film-engine#providers',
        checked: '2026-08-22',
        note: 'Self-hosted gateway: no per-call charge. Compute cost is the GPU it runs on, recorded as gpu_seconds rather than as a provider rate.',
    },
};

/**
 * The published rate for a pair, with a model override applied.
 *
 * Returns null when the pair is unpriced, so the caller can report the gap
 * rather than silently bill it at zero.
 */
function rateFor(provider, capability, model, overrides) {
    const base = RATE_BOOK[`${provider}:${capability}`] || RATE_BOOK[`${provider}:*`];
    if (!base) return null;

    const perModel = (model && base.models && base.models[model]) || {};
    const override = lookupOverride(provider, capability, model, overrides);
    const rate = { ...base, ...perModel, ...override, provider, capability, model: model || null };

    // An install that stores a real rate for a subscription-billed capability
    // is saying it pays per call after all. Honour that rather than making the
    // flag unclearable — a waiver you cannot switch off is a bug the day
    // someone moves to an API key.
    if (rate.subscription && override && override.usd_per_native > 0) rate.subscription = false;

    // The single figure the gate and the estimator want: USD per metered unit.
    // Component-priced entries (input/output tokens) have no single rate, so
    // the higher of the two stands in — an estimate that leans expensive fails
    // closed, which is the safe direction for a budget guard.
    rate.usd_per_unit = rate.components
        ? Math.max(rate.components.input, rate.components.output)
        : (rate.native_per_unit || 1) * (rate.usd_per_native || 0);

    rate.inferred = Array.isArray(base.inferred_models) && base.inferred_models.includes(model);
    return rate;
}

/** A per-install rate override from film_provider_rates, if one is stored. */
function lookupOverride(provider, capability, model, overrides) {
    if (!overrides) return {};
    const exact = overrides[`${provider}:${capability}:${model}`];
    const any = overrides[`${provider}:${capability}`];
    return exact || any || {};
}

/**
 * Turn one metered call into money and into the provider's own units.
 *
 * `parts` carries an input/output token split where a capability has one; a
 * usage without it is priced at the flat rate. Everything returned is stored,
 * because a row that keeps only dollars cannot answer "how many credits did
 * that burn", which is the number a prepaid account actually runs out of.
 */
function priceUsage({ provider, capability, model, unit, quantity, parts, native_charged, provider_confirmed: providerConfirmed }, overrides) {
    const rate = rateFor(provider, capability, model, overrides);
    if (!rate) {
        return { amount_usd: 0, native_unit: null, native_quantity: 0, unit_rate: 0,
                 priced: false, reason: `no published rate for ${provider}:${capability}` };
    }

    const qty = Math.max(0, Number(quantity) || 0);
    let amount;

    if (rate.components && parts) {
        // Input and output are different prices. Charging the whole token
        // count at either one is wrong by up to 5x.
        amount = (Number(parts.input) || 0) * rate.components.input
               + (Number(parts.output) || 0) * rate.components.output
               + (Number(parts.cache_read) || 0) * rate.components.input * 0.1
               + (Number(parts.cache_write) || 0) * rate.components.input * 1.25;
    } else if (Number.isFinite(Number(native_charged)) && Number(native_charged) > 0) {
        /*
         * A RECEIPT beats the rate book.
         *
         * Everything else here is our reading of a published price list, and
         * that reading was wrong about one Meshy model by a factor of two for
         * days without anything noticing. Where a provider tells us what a call
         * actually cost in its own units, that is the number — the book is only
         * needed to turn those units into money.
         */
        amount = Number(native_charged) * rate.usd_per_native;
    } else {
        amount = qty * rate.usd_per_unit;
    }

    // Consumption is recorded either way; only the money is waived. A zero
    // that carries no reason is indistinguishable from a pair nobody priced,
    // which is the exact confusion this file exists to end — so the flag
    // travels with the result and the report prints it.
    if (rate.subscription || rate.self_hosted) amount = 0;

    return {
        amount_usd: round6(amount),
        native_unit: rate.native_unit,
        native_quantity: Number.isFinite(Number(native_charged)) && Number(native_charged) > 0
            ? round6(Number(native_charged))
            : round6(qty * (rate.native_per_unit || 1)),
        // Whether that figure came from the provider or from our rate book.
        // "we measured $41" and "we think it was about $41" are different
        // claims and only one should be defended in a meeting.
        // NOT called `measured`: the spend report already uses measured_usd to mean
        // "not reconstructed by the backfill", and two meanings of one word in
        // one report is how a number gets read as the opposite of what it says.
        provider_confirmed: !!providerConfirmed,
        unit_rate: rate.usd_per_unit,
        unit,
        priced: true,
        self_hosted: !!rate.self_hosted,
        subscription: !!rate.subscription,
        billing_note: rate.subscription_note || null,
        inferred: !!rate.inferred,
        source: rate.source,
    };
}

function round6(n) {
    return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/** The whole book, flattened for the settings UI and the rates endpoint. */
function listRates(overrides) {
    const out = [];
    for (const key of Object.keys(RATE_BOOK)) {
        const [provider, capability] = key.split(':');
        const base = RATE_BOOK[key];
        const rate = rateFor(provider, capability, null, overrides);
        out.push({
            provider, capability,
            unit: rate.unit, native_unit: rate.native_unit,
            native_per_unit: rate.native_per_unit,
            usd_per_native: rate.usd_per_native,
            usd_per_unit: rate.usd_per_unit,
            components: rate.components || null,
            models: Object.entries(base.models || {}).map(([id, m]) => ({
                model: id,
                native_per_unit: m.native_per_unit != null ? m.native_per_unit : rate.native_per_unit,
                usd_per_native: m.usd_per_native != null ? m.usd_per_native : rate.usd_per_native,
                components: m.components || null,
                inferred: (base.inferred_models || []).includes(id),
            })),
            self_hosted: !!base.self_hosted,
            subscription: !!base.subscription,
            source: base.source, checked: base.checked, note: base.note,
            overridden: !!lookupOverride(provider, capability, null, overrides).usd_per_native,
        });
    }
    return out;
}

/**
 * A capability nobody priced bills at zero, and a report of zero is read as
 * "this stage is free" rather than "this stage is untracked". Fail at load,
 * the way flow-cost.js does, rather than at the end of a month.
 */
(function assertCoverage() {
    const providers = require('./providers');
    const gaps = [];
    for (const adapter of providers.list()) {
        for (const capability of adapter.capabilities || []) {
            if (!rateFor(adapter.id, capability)) gaps.push(`${adapter.id}:${capability}`);
        }
    }
    if (gaps.length) throw new Error(`provider-pricing: no rate for ${gaps.join(', ')}`);
})();

module.exports = { BILLING_UNITS, RATE_BOOK, rateFor, priceUsage, listRates, CAPABILITIES,
    SUBSCRIPTION_PLANS, subscriptionAttribution, SUBSCRIPTION_SOURCE };
