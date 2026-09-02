/**
 * The two ways a paid generation gets lost, and the fixes that close them.
 *
 * 1. THE RESULT IS THERE AND THE PARSER LOOKS IN THE WRONG PLACE.
 *    MuAPI answers `{ status: 'completed', outputs: [url] }`. The poll read
 *    `data.output`, singular, so a finished clip reported "completed with no
 *    video" and the engine settled the job as FAILED. The money left, the file
 *    existed, and nothing pointed at it.
 *
 * 2. A JOB THIS ENGINE CALLS FAILED IS NOT A JOB THE PROVIDER FAILED.
 *    `collect` refused any non-pending handle, so the clip above could never be
 *    recovered — only re-bought. Re-polling is free; refusing to is not.
 *
 * Deliberately DB-free: these are the parts that must be assertable without a
 * database or a provider account, which is exactly why the original defect
 * survived a test suite that has both.
 */

const test = require('node:test');
const assert = require('node:assert');

const seedance = require('../lib/providers/seedance');

/** A fetch that answers every poll with one canned result body. */
function stubFetch(body) {
    const prior = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
    return () => { global.fetch = prior; };
}

test('the poll reads the shape MuAPI documents: outputs, plural, an array', async () => {
    const restore = stubFetch({ id: 'x', status: 'completed', outputs: ['https://cdn.muapi.ai/a.mp4'] });
    try {
        const out = await seedance.awaitResult('req-1', 'k', Date.now() + 8000);
        assert.strictEqual(out.ok, true);
        assert.strictEqual(out.url, 'https://cdn.muapi.ai/a.mp4');
    } finally { restore(); }
});

test('an object output still yields its URL, and the singular form still works', async () => {
    for (const [body, want] of [
        [{ status: 'completed', outputs: [{ url: 'https://cdn/b.mp4' }] }, 'https://cdn/b.mp4'],
        [{ status: 'completed', outputs: [{ video_url: 'https://cdn/c.mp4' }] }, 'https://cdn/c.mp4'],
        [{ status: 'succeeded', output: 'https://cdn/d.mp4' }, 'https://cdn/d.mp4'],
    ]) {
        const restore = stubFetch(body);
        try {
            const out = await seedance.awaitResult('req', 'k', Date.now() + 8000);
            assert.strictEqual(out.url, want);
        } finally { restore(); }
    }
});

test('a completed result with no URL anywhere names the keys it did get', async () => {
    const restore = stubFetch({ status: 'completed', cost: { usd: 1.7 } });
    try {
        const out = await seedance.awaitResult('req', 'k', Date.now() + 8000);
        assert.strictEqual(out.ok, false);
        // The message has to carry the evidence: "no video" sent the reader to
        // the provider, when the answer was in the payload the whole time.
        assert.match(out.error, /keys: status, cost/);
    } finally { restore(); }
});

/*
 * SOURCE-LEVEL CONTRACTS.
 *
 * Read from the source because the behaviour they protect needs a database and
 * a provider account to exercise, and a rule that can only be checked by
 * spending money is a rule that goes unchecked.
 */
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('a failed handle is re-polled, not refused', () => {
    const src = read('lib/generation-jobs.js');
    assert.ok(!/job\.status !== 'pending'/.test(src),
        'collect must not treat every non-pending handle as final — that is what made a '
        + 'mis-parsed result unrecoverable');
    assert.ok(/job\.status === 'completed'/.test(src),
        'only a COMPLETED job is finished: its bytes are filed and re-polling would file them twice');
});

test('a collected result is filed from bytes OR a URL', () => {
    const src = read('lib/generation-jobs.js');
    assert.ok(/out\.data \|\| out\.url/.test(src),
        'every MuAPI adapter answers with a CDN URL and no buffer; gating on bytes alone '
        + 'silently files nothing');
});

test('the sequence route does not hardcode a raster', () => {
    const src = read('routes/sequences.js');
    // The literal, not the comment that explains why it is gone.
    const code = src.split('\n').filter(l => !/^\s*[*/]/.test(l)).join('\n');
    assert.ok(!/width:\s*1280,\s*height:\s*720/.test(code),
        'the one path that spends per second must take its frame from the project and the '
        + 'draft floor, never a literal — a hardcoded 720p is double the draft rate on every leg');
    assert.ok(/jobMeta/.test(src),
        'a leg must stamp what it is onto its handle, or a recovered clip cannot be filed as the leg');
});

test('there is exactly one definition of a leg clip filename', () => {
    const routes = read('routes/sequences.js');
    assert.ok(!/function sequenceFileName/.test(routes),
        'the live road and the collect road must read the name from lib/sequence-delivery; two '
        + 'definitions is how a recovered leg becomes invisible to the sequence that bought it');
    const shared = read('lib/sequence-delivery.js');
    assert.ok(/function clipFileName/.test(shared));
});


/*
 * THE RESOLUTION ASKED FOR IS THE RESOLUTION SENT.
 *
 * The leg that was lost was also generated at 720p on a 1080p project set to
 * draft, because the route sent `width`/`height` and this adapter resolves its
 * tier from `resolution`, then `model`, then `target_resolution` — and reads
 * width/height for nothing at all. Omission reached a provider DEFAULT, which
 * on the one road billed per second is the most expensive kind of silence.
 */
test('a frame with no tier keyword still resolves the asked raster, not a default', () => {
    const shot = { prompt: 'x', duration_s: 5,
        keyframes: [{ uri: 'https://a/b.png', position: 'first' }] };

    // What the route used to send: a frame and nothing else.
    const blind = seedance.describeVideoRequest({ ...shot, width: 1920, height: 1080 });
    assert.strictEqual(blind.resolution, '720p',
        'this is the defect, pinned: a raster the adapter cannot see falls to its default');

    // What it sends now: the raster travels as well.
    const stated = seedance.describeVideoRequest({
        ...shot, width: 1920, height: 1080, target_resolution: '1920x1080' });
    assert.strictEqual(stated.resolution, '1080p');

    // And an explicit tier — what the draft floor supplies — outranks both.
    const drafted = seedance.describeVideoRequest({
        ...shot, width: 854, height: 480, target_resolution: '854x480', resolution: '480p' });
    assert.strictEqual(drafted.resolution, '480p');
    assert.strictEqual(drafted.estimated_usd, 0.85);
});

test('an ask this provider has no tier for is snapped DOWN and said out loud', () => {
    const twoK = seedance.describeVideoRequest({
        prompt: 'x', duration_s: 5, target_resolution: '2560x1440',
        keyframes: [{ uri: 'https://a/b.png', position: 'first' }] });

    // Never up: 4K is five times the price of 1080p and nobody asked for it.
    assert.strictEqual(twoK.resolution, '1080p');
    assert.strictEqual(twoK.resolution_snapped, true);
    assert.ok(twoK.notes.some(n => /2560x1440/.test(n) && /1080p/.test(n)),
        'the note must name BOTH what was asked for and what will render — a snap nobody is '
        + 'told about is a 2K project delivered at 1080p that nobody catches until they measure');

    // A tier it does have is not reported as a snap.
    const hd = seedance.describeVideoRequest({
        prompt: 'x', duration_s: 5, target_resolution: '1920x1080',
        keyframes: [{ uri: 'https://a/b.png', position: 'first' }] });
    assert.strictEqual(hd.resolution_snapped, false);
});

test('the sequence route sends the raster on every road, drafting or not', () => {
    const src = read('routes/sequences.js');
    const fn = src.slice(src.indexOf('function sequenceFrame'), src.indexOf('async function generateSequence'));
    const returns = fn.split('return ').slice(1);
    assert.ok(returns.length >= 3, 'sequenceFrame has a draft road, a no-draft road and a failure road');
    for (const r of returns) {
        assert.ok(/target_resolution/.test(r.slice(0, 400)),
            'every road out of sequenceFrame must carry the raster — the one that does not is the '
            + 'one that reaches a provider default');
    }
});

test('the plan prices through the adapter that will be billed', () => {
    const src = read('routes/sequences.js');
    assert.ok(/describeVideoRequest/.test(src),
        'estimated_credits comes from a Runway credit policy and is ZERO on a Seedance project — '
        + 'a plan that quotes nothing for a road billed per second is not a plan');
});


/*
 * AUDIO. The provider's default is the opposite of this engine's.
 *
 * Seedance 2.5 sets `generate_audio: true` unless told otherwise, and it
 * synthesises speech, effects AND a music bed. Film Engine commissions those
 * separately and mixes them to a delivery spec, so a clip that arrives already
 * scored is a second soundtrack nobody asked for — most obviously on a studio
 * ident that has its own cue.
 */
test('video generates silent unless audio is asked for', () => {
    const shot = { prompt: 'x', duration_s: 5,
        keyframes: [{ uri: 'https://a/b.png', position: 'first' }] };
    assert.strictEqual(seedance.buildVideoRequest(shot).body.generate_audio, false,
        'the field must be SENT as false, not merely omitted — omitting it takes the provider default, '
        + 'which is on');
    assert.strictEqual(seedance.buildVideoRequest({ ...shot, audio: true }).body.generate_audio, true);
    assert.strictEqual(seedance.buildVideoRequest({ ...shot, generate_audio: true }).body.generate_audio, true);
});

test('asking for the provider bed is said out loud', () => {
    const d = seedance.describeVideoRequest({ prompt: 'x', duration_s: 5, audio: true,
        keyframes: [{ uri: 'https://a/b.png', position: 'first' }] });
    assert.strictEqual(d.audio, true);
    assert.ok(d.notes.some(n => /two scores/i.test(n)));
});

test('the settings that decide what a second costs are writable', () => {
    const routes = read('routes/projects.js');
    assert.ok(/video_draft = \?/.test(routes),
        'video_draft has governed the largest variable cost in the pipeline since migration 100 and '
        + 'was writable from nowhere');
    const tools = read('lib/mcp-tools.js');
    assert.ok(/target_resolution: \{/.test(tools) && /video_draft: \{/.test(tools),
        'both must be reachable from the tool surface, or the answer to "can I have 2K" is no');
});


/*
 * SPEND. A generation the host abandoned is still a generation that was paid for.
 *
 * The meter fires on a RESULT, and video never returns one inside the 60-second
 * window — it comes back through generation_collect, which calls the adapter
 * directly and outside the metering wrapper. So every video ever bought recorded
 * $0, in the one report an agency uses to bill a client.
 */
test('a handle carries the price of the thing it is a handle for', () => {
    const src = read('lib/providers/index.js');
    assert.ok(/adapter\.meter\(cap \|\| capability, payload, null\)/.test(src),
        'the payload is only in scope at handle time — the meter must be worked out there, not '
        + 'left to a collect that never sees it');
    assert.ok(/meterPlan \? \{ meter: meterPlan \} : \{\}/.test(src));
});

test('collecting posts the spend exactly once', () => {
    const src = read('lib/generation-jobs.js');
    assert.ok(/recordUsage/.test(src), 'a collected generation must reach the ledger');
    // The guard against double-billing is structural, not a flag: a job that
    // succeeded live is settled `completed` and short-circuits before here.
    const collectBody = src.slice(src.indexOf('async function collect'));
    assert.ok(collectBody.indexOf("job.status === 'completed'") < collectBody.indexOf('recordUsage'),
        'the completed short-circuit must come BEFORE the spend post, or a delivered job could be '
        + 'billed twice by re-collecting it');
});


/*
 * SILENCE IS ENFORCED, NOT REQUESTED.
 *
 * The adapter asks MuAPI for a silent render and MuAPI ignores it — the
 * delivered clip carried a 32kHz stereo AAC track of model-generated speech,
 * effects and music at -34.7 dB mean. A flag whose effect cannot be verified is
 * not a control, so the engine settles it locally with a stream copy.
 */
test('every saved video is stripped of audio unless sound was asked for', () => {
    const src = read('lib/provider-media.js');
    assert.ok(/subdir === 'video' && !asked/.test(src),
        'the strip belongs on the ONE funnel every saved video passes through, not on each caller');
    assert.ok(/'-c', 'copy', '-an'/.test(src),
        'stream copy — the picture must be bit-identical; a re-encode would degrade footage that '
        + 'was just paid for');
    assert.ok(/data\.audio === true/.test(src) && /opts && opts\.keepAudio/.test(src),
        'an explicit ask for sound must survive: silence is the default, not an override');
});

test('the adapter reports whether sound was asked for', () => {
    const src = read('lib/providers/seedance.js');
    assert.ok(/audio: !!req\.body\.generate_audio/.test(src),
        'the persist step must not have to guess what the request wanted');
});


/*
 * THE ASPECT RATIO THE ENGINE ASKS FOR IS THE ONE IT MEANS.
 *
 * `dimensionsForAspect` rounded each edge to a multiple of eight
 * INDEPENDENTLY, which does not preserve a ratio: 16:9 came out 1368x768, or
 * 1.781:1. The function named for the aspect ratio was the thing breaking it —
 * and it did not stay a rounding error, because the board frame is the keyframe
 * the video model derives its output raster from.
 */
const cp = require('../lib/capability-payloads');

test('every aspect the presets offer resolves to that aspect exactly', () => {
    for (const a of ['16:9', '4:3', '1:1', '9:16', '2.39:1', '1.85:1', '21:9']) {
        const d = cp.dimensionsForAspect(a, 1024, 1024);
        const [x, y] = a.split(':').map(Number);
        assert.ok(Math.abs((d.width / d.height) - (x / y)) < 1e-9,
            `${a} produced ${d.width}x${d.height} = ${(d.width / d.height).toFixed(5)}:1`);
        assert.strictEqual(d.width % 2, 0, `${a}: width must be even for any real codec`);
        assert.strictEqual(d.height % 2, 0, `${a}: height must be even for any real codec`);
    }
});

test('the clamped frame keeps the shape too, and stays under the cap', () => {
    // The old code rounded UP, so a 1-megapixel cap produced 1368x768 —
    // 1,050,624 pixels. A clamp that exceeds its own ceiling is not a clamp.
    const b = cp.imageBudget('16:9', '2560x1440', 1048576);
    assert.ok(Math.abs((b.width / b.height) - (16 / 9)) < 1e-9);
    assert.ok(b.width * b.height <= 1048576,
        `clamped to ${b.width}x${b.height} = ${b.width * b.height}px, over the 1048576 cap`);
    assert.strictEqual(b.clamped, true);
});

test('off-ratio and mismatched keyframes are reported before anything is bought', () => {
    const { keyframeRasterReport } = require('../lib/image-raster');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-'));
    // A PNG header is all this reads, so a header is all the fixture needs.
    const png = (w, h) => {
        const b = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
        b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
        const f = path.join(dir, `${w}x${h}.png`);
        fs.writeFileSync(f, b);
        return f;
    };
    const report = keyframeRasterReport('16:9', [
        { uri: png(1376, 768), shot_code: '1A' },   // what this project actually had
        { uri: png(1920, 1080), shot_code: '1C' },
    ]);
    assert.ok(report, 'a 1.792:1 frame in a 16:9 project must not pass silently');
    assert.ok(report.notes.some(n => /1376x768/.test(n) && /keyframe/i.test(n)));
    assert.ok(report.notes.some(n => /not all the same size/.test(n)),
        'two rasters in one sequence will not stitch — that has to be said, not discovered in the NLE');

    // Same ratio, different SIZE, still worth saying: the legs would come back
    // at two rasters and need a rescale to join.
    assert.ok(keyframeRasterReport('16:9', [
        { uri: png(1920, 1080) }, { uri: png(1280, 720) },
    ]));

    // A matched set says nothing at all.
    assert.strictEqual(keyframeRasterReport('16:9', [
        { uri: png(1920, 1080) }, { uri: png(1920, 1080) },
    ]), null);
});


/*
 * A GENERATED BOARD IS STORED AT THE SIZE IT WAS ASKED FOR.
 *
 * The engine asks; the provider answers on its own grid. Asked 1368x768, Nano
 * Banana returned 1376x768. A board is the keyframe a video model is pinned to,
 * and Seedance takes its output raster from the frame rather than from the
 * aspect_ratio beside it — so eight pixels on a board became a sequence whose
 * legs came back at 1926x1076 and 1920x1080 and would not stitch.
 */
test('board bytes are conformed on the one path every board write uses', () => {
    const src = read('routes/storyboard.js');
    assert.ok(/conformBoardBuffer/.test(src),
        'five call sites write a board to disk and all five take their bytes from callImageGen — '
        + 'the conform belongs there, not five times');
    // The buffer is fixed BEFORE it is written, so the archived versions carry
    // the same raster as the live board and a restore cannot put an off-spec
    // frame back on it.
    assert.ok(src.indexOf('conformBoardBuffer') < src.indexOf('fs.writeFileSync'),
        'conform must happen before any write, or shot_frames restore reintroduces the defect');
});

/*
 * THE SHAPE DECIDES THE CORRECTION.
 *
 * Two providers get a raster wrong two different ways. Meshy snaps to its own
 * 32px grid and returns 1376x768 for a 1368x768 ask — ratio drift, crop it off.
 * MuAPI serves a TIER: ask 2560x1440 and its 4k tier returns 4096x2304 — same
 * shape, more pixels, and cropping that to 2560x1440 would throw away 60% of
 * the frame and hand back a punched-in shot nobody composed. The first version
 * of this file did exactly that.
 */
test('ratio drift is cropped, extra size is scaled, and neither is confused for the other', () => {
    const { conformFilter } = require('../lib/board-raster');
    const f = (g, w) => conformFilter({ width: g[0], height: g[1] }, { width: w[0], height: w[1] });

    // Meshy: eight pixels of drift. Crop, no scale — a resample here would
    // soften a board for nothing.
    assert.strictEqual(f([1376, 768], [1368, 768]), 'crop=1368:768');

    // MuAPI 4k tier down to 2K. Scale, NO crop — this is the one that matters.
    assert.strictEqual(f([4096, 2304], [2560, 1440]), 'scale=2560:1440:flags=lanczos');

    // Both wrong: get the SHAPE right first, then the size.
    assert.strictEqual(f([4096, 2304], [2560, 1600]), 'crop=3686:2304,scale=2560:1600:flags=lanczos');

    // Nothing to do.
    assert.strictEqual(f([2560, 1440], [2560, 1440]), null);
    // Never upscale: a frame smaller than the ask is left honest.
    assert.strictEqual(f([2048, 1152], [2560, 1440]), null);
});

test('a board is never upscaled and never stretched', () => {
    const src = read('lib/board-raster.js');
    assert.ok(/got\.width < w \|\| got\.height < h/.test(src),
        'a frame SMALLER than the ask must be left alone — upscaling a board invents detail');
    assert.ok(/flags=lanczos/.test(src),
        'a board is the keyframe a video model is pinned to; softness here becomes softness in '
        + 'every frame of the clip');
    assert.ok(!/setsar|scale=\$\{w\}:\$\{h\}(?!:flags)/.test(src.replace(/scale=\$\{w\}:\$\{h\}:flags=lanczos/g, '')),
        'no unqualified rescale that could change the pixel aspect');
});


/*
 * A CUE SOMEBODY WROTE BEATS THE DERIVATION.
 *
 * `buildAmbientPrompt` appended the location's generic ambience, the INT/EXT
 * modifier and a time-of-day modifier on top of whatever the director wrote,
 * unconditionally. A diegetic radio playing out of a drive-in speaker was sent
 * as "...carrier hiss., ambient sounds of DRIVE-IN THEATRE - LOT, outdoor,
 * nighttime atmosphere" — the generator asked for a tinny radio AND the open
 * lot at once, while the cue's own negative prompt was excluding crickets.
 */
const { buildAmbientPrompt } = require('../lib/music-prompt');
const SCENE = { location: 'DRIVE-IN THEATRE - LOT', int_ext: 'EXT', time_of_day: 'NIGHT',
                estimated_duration: 0 };

test('a written ambient direction is sent as written', () => {
    const written = 'A 1950s radio commercial through a tinny drive-in speaker.';
    const out = buildAmbientPrompt(SCENE, null, { direction: written, bed_ms: 5000 });
    assert.strictEqual(out.prompt, written,
        'the derivation must not argue with the brief — the location bed is a separate cue');
    assert.ok(!/outdoor|nighttime/.test(out.prompt));
});

test('with nothing written, the derivation still fills the gap', () => {
    const out = buildAmbientPrompt(SCENE, null, { bed_ms: 5000 });
    assert.ok(/DRIVE-IN THEATRE/.test(out.prompt) && /outdoor/.test(out.prompt),
        'an unbriefed bed is exactly what the derivation is for');
});

test("the provider's 450-character ceiling is enforced here, not discovered as a 400", () => {
    const out = buildAmbientPrompt(SCENE, null, { direction: 'x'.repeat(600), bed_ms: 5000 });
    assert.ok(out.prompt.length <= 450);
    assert.strictEqual(out.prompt_trimmed, true,
        'a silently trimmed prompt is a prompt the author cannot debug');
});


/*
 * THE PROMPT BUDGET IS THE PROVIDER'S, NOT A CONSTANT.
 *
 * 1200 characters per shot was invented in routes/sequences.js. Seedance
 * declares promptLimit 16000, so the route discarded more than ninety per cent
 * of the room the model offers — from the END, which is where a director's
 * negative instructions live. Measured on this ident's 1D: a 1552-character
 * direction was cut to 853, losing the third stage of the title build, every
 * anti-warping guard, and the instruction that the logo must not come apart.
 */
test('the per-shot prompt budget is derived from the resolved adapter', () => {
    const src = read('routes/sequences.js');
    assert.ok(/adapter && adapter\.promptLimit/.test(src),
        'the ceiling must come from the provider that will be sent the prompt');
    assert.ok(!/SHOT_PROMPT_CEILING/.test(src),
        'no ceiling invented here: the look is carried by the keyframes, and the text budget '
        + 'belongs to camera, action and performance — the material that was being cut');
    assert.ok(/limit - String\(preamble \|\| ''\)\.length/.test(src),
        'the preamble is MEASURED, not reserved — reserving a guess is the same mistake one size '
        + 'smaller: a short preamble wastes room and a long one overruns');
    assert.ok(/function shotDirection\(card, budget\)/.test(src),
        'shotDirection must take the budget rather than closing over a constant');
    assert.ok(/shotPromptBudget\(row\.project_id/.test(src),
        'resolved once per sequence — it is the same provider for every shot in it');
});

test('a provider that declares nothing keeps the old floor', () => {
    const src = read('routes/sequences.js');
    // An unresolvable provider must never be the reason a prompt is built
    // differently — that would make a wiring fault look like a creative choice.
    const fn = src.slice(src.indexOf('function shotPromptBudget'),
                         src.indexOf('function trimToSentence'));
    assert.ok(/return floor;/.test(fn) && (fn.match(/return floor;/g) || []).length >= 2,
        'both the no-limit path and the throw path fall back to the documented floor');
});

test('seedance still declares the limit this budget is derived from', () => {
    // Pinned because the budget is now a function of it: a provider that stops
    // declaring promptLimit silently reverts every sequence to 1200.
    assert.ok(Number(seedance.seedanceAdapter.promptLimit) > 4000,
        'if this drops, sequence prompts quietly shrink back and nobody is told');
});


/*
 * A GLOBAL SETTING THAT NOTHING OBEYS IS NOT A SETTING.
 *
 * Two defects made the account-level provider choice unreachable in practice.
 */
test('a new project pins no provider', () => {
    const src = read('routes/projects.js');
    assert.ok(!/JSON\.stringify\(defaultProviderConfig\(\)\)/.test(src),
        'stamping a full pin at creation makes every project override the one global setting '
        + 'that exists, with a choice nobody made');
    assert.ok(/JSON\.stringify\(\{\}\)/.test(src));
});

test('the account-default cache is cleared by its own key', () => {
    const src = read('routes/app-settings.js');
    assert.ok(/changed\.includes\('default_image_provider'\)/.test(src),
        'the refresh was gated on gridlight_enabled, so changing the image provider cached the '
        + 'old answer until restart — the setting appeared not to work');
    assert.ok(/changed\.includes\('default_video_provider'\)/.test(src));
});

test('the image preference order and the standard tier both lead with the provider that has size tiers', () => {
    // Meshy caps nano-banana at ~1MP with no size control; MuAPI serves the
    // same model at 1k/2k/4k. A project that expresses no opinion must land on
    // the one that can actually deliver the project's raster.
    const idx = read('lib/providers/index.js');
    const tiers = read('lib/quality-tiers.js');
    assert.match(idx, /image: \['muapi'/);
    assert.match(tiers, /order: \['muapi', 'google', 'meshy'/);
});


/*
 * A ROUTE TOOL THAT POSTS NOTHING.
 *
 * `callRouteTool` builds its body from `t.body(args)` or from `t.bodyKeys`, and
 * a POST tool declaring NEITHER sends `{}` — so the route refuses its own
 * arguments as missing while the schema, the description and the call all look
 * correct. Caught on `spend_record`, whose first live call came back "provider
 * and capability are required" with both supplied.
 */
test('every POST route tool actually sends its arguments', () => {
    const src = read('lib/mcp-tools.js');
    // Each production tool object, sliced on the name key.
    const chunks = src.split(/\n    \{\n        name: '/).slice(1);
    const offenders = [];
    for (const c of chunks) {
        const name = c.slice(0, c.indexOf("'"));
        const spec = c.slice(0, c.search(/\n    \},/) + 1 || c.length);
        if (!/method: 'POST'|method: 'PUT'/.test(spec)) continue;
        if (/body:/.test(spec) || /bodyKeys/.test(spec)) continue;
        // A tool whose only inputs are path parameters legitimately has no body.
        const schema = (spec.match(/schema: \{([\s\S]*?)\n        \}/) || [])[1] || '';
        const fields = (schema.match(/^\s{12}([a-z_]+):/gm) || [])
            .map(x => x.trim().replace(':', ''));
        const nonPath = fields.filter(f => !/_id$/.test(f));
        if (nonPath.length) offenders.push(`${name} (drops ${nonPath.join(', ')})`);
    }
    assert.deepStrictEqual(offenders, [],
        'these POST/PUT tools declare body fields that never reach the route');
});


/*
 * THE STRIP COULD NOT REACH THE MODEL IT WAS WRITTEN FOR.
 *
 * Every pinned keyframe is a moment of ZERO motion and an approximate landing,
 * so chained first/last legs freeze and re-pose at every join. The engine's
 * answer is the bundle: the stations travel as `inbetween` REFERENCES on one
 * longer generation. `contractFor()` is keyed by Runway's model catalogue, so a
 * project reaching Seedance through MuAPI got a null model, fell to
 * keyframe-only, and had every station dropped — silently degrading a bundle
 * into an ordinary leg on the one provider whose contract says "the only model
 * that documents room for a strip".
 */
test('the seedance adapter declares a contract that carries a strip', () => {
    const c = seedance.seedanceAdapter.referenceContract;
    assert.ok(c, 'without this the route falls to Runway-keyed lookup and drops the strip');
    assert.ok(c.roles.includes('inbetween'));
    assert.strictEqual(c.maxImages, 30);
});

test('a strip survives the adapter contract and is destroyed by the fallback', () => {
    const { selectReferences, contractFor } = require('../lib/video-reference');
    const refs = [{ role: 'keyframe', uri: 'a' },
        ...Array.from({ length: 12 }, (_, i) => ({ role: 'inbetween', uri: 's' + i }))];

    const withAdapter = selectReferences(refs, seedance.seedanceAdapter.referenceContract);
    assert.strictEqual(withAdapter.selected.length, 13);
    assert.strictEqual((withAdapter.dropped || []).length, 0);

    // The defect, pinned: this is what a Seedance project was actually getting.
    const fallback = selectReferences(refs, contractFor(null));
    assert.strictEqual(fallback.selected.length, 1);
    assert.strictEqual((fallback.dropped || []).length, 12);
});

test('the sequence route prefers the adapter contract', () => {
    const src = read('routes/sequences.js');
    assert.ok(/provider && provider\.referenceContract/.test(src),
        'the provider that will be billed is the one whose limits decide what travels');
});


/*
 * FOOTAGE KEEPS ITS TAKES, THE WAY THE BOARD KEEPS ITS FRAMES.
 *
 * `archiveExistingFrame` has copied the outgoing picture into `versions/` since
 * the storyboard was written, because — `shot_frames`' own words — "generation
 * is a coin flip you already paid for, so an earlier attempt is often the one
 * you wanted". Video had no equivalent: a leg re-shot to the same filename
 * overwrote the previous take and UPDATEd its row in place. Same coin flip at
 * forty times the price. It happened here: a reshoot of 1A-1B destroyed a take
 * that then existed only on the provider's CDN.
 */
test('the previous take is archived before a clip is overwritten', () => {
    const { archivePreviousTake } = require('../lib/provider-media');
    const fs = require('fs'); const path = require('path'); const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takes-'));
    const live = path.join(dir, 'sequence_x_1A_1B.mp4');

    fs.writeFileSync(live, 'TAKE ONE');
    assert.strictEqual(path.basename(archivePreviousTake(live)), 'sequence_x_1A_1B.v1.mp4');
    fs.writeFileSync(live, 'TAKE TWO');
    assert.strictEqual(path.basename(archivePreviousTake(live)), 'sequence_x_1A_1B.v2.mp4');

    // The archived bytes are the OLD take, not a second copy of the new one.
    assert.strictEqual(
        fs.readFileSync(path.join(dir, 'takes', 'sequence_x_1A_1B.v1.mp4'), 'utf8'), 'TAKE ONE');
    // Nothing to archive is not a failure.
    assert.strictEqual(archivePreviousTake(path.join(dir, 'nope.mp4')), null);
});

test('the archive happens BEFORE the write, on the one funnel every clip passes', () => {
    const src = read('lib/provider-media.js');
    assert.ok(/archivePreviousTake\(getFilePath/.test(src),
        'saveFile overwrites — by the time the returned path is in hand the old take is gone');
    // Comments stripped: the first `saveFile` in this function is inside the
    // comment EXPLAINING the ordering, and matching prose instead of code is
    // how a green test comes to mean nothing.
    const body = src.slice(src.indexOf('async function persistProviderMedia'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(body.indexOf('archivePreviousTake') < body.indexOf('saveFile'),
        'archiving after the save would copy the NEW take and still lose the old one');
});
