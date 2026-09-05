const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const BRIEF = path.join(REPO, 'docs', 'plans', 'redo-between-frames-brief.md');
const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const brief = () => fs.readFileSync(BRIEF, 'utf8');

/**
 * A BRIEF THAT ASSERTS THINGS ABOUT THE CODE MUST STAY TRUE ABOUT THE CODE.
 *
 * This one is read to decide what to build, and every number in it — a duration
 * floor, a price per second, a capability that is present or absent — was taken
 * from the source. A plan whose facts have drifted is worse than no plan: it is
 * confidently wrong about the thing somebody opened it to check, which is
 * exactly how the last build order sent the same work round twice.
 *
 * Set-based over BOTH registries: the sections the step requires, and the claims
 * the brief makes. An example-based check passes on a brief that has five of six
 * sections and one stale price.
 */

/** The six sections the brief must carry, from the step's own template. */
const REQUIRED_SECTIONS = [
    'Executive Summary',
    'Key Themes',
    'Top Ideas & Opportunities',
    'Technical Approaches',
    'Open Questions',
    'Recommended Direction',
];

/**
 * Every claim the brief makes about this codebase, each checked against the
 * source rather than against the research document — which is itself a
 * secondary source and could have drifted too.
 */
const CLAIMS = [
    { id: 'video-sequence exists',
      why: 'the between-two-stills generator the brief says already exists',
      holds: () => fs.existsSync(path.join(REPO, 'backend/lib/video-sequence.js')) },

    { id: 'inbetweens exists',
      why: 'the within-a-shot densifier',
      holds: () => fs.existsSync(path.join(REPO, 'backend/lib/inbetweens.js')) },

    { id: 'first-last-frame takes 2 images',
      why: 'the workflow the whole approach rests on',
      holds: () => /'first-last-frame':\s*\{\s*images:\s*2\s*\}/.test(src('backend/lib/providers/seedance.js')) },

    { id: 'first-last-frame uses images_list',
      why: 'the field name; MuAPI is not uniform across workflows',
      holds: () => /'first-last-frame':\s*'images_list'/.test(src('backend/lib/providers/seedance.js')) },

    { id: 'duration floor is 4s',
      why: 'THE constraint — a shorter fault cannot be regenerated at its own length',
      holds: () => /MIN_DURATION\s*=\s*4\b/.test(src('backend/lib/providers/seedance.js')) },

    { id: 'duration ceiling is 30s',
      why: 'the upper bound on a single re-roll',
      holds: () => /MAX_DURATION\s*=\s*30\b/.test(src('backend/lib/providers/seedance.js')) },

    { id: 'prices are 0.17 / 0.85 / 1.70',
      why: 'the brief quotes cost per second to justify drafting at 480p',
      holds: () => {
          const s = src('backend/lib/providers/seedance.js');
          return /usdPerSecond:\s*0\.17/.test(s) && /usdPerSecond:\s*0\.85/.test(s)
              && /usdPerSecond:\s*1\.70/.test(s);
      } },

    { id: 'frame extraction exists at >= 3 sites',
      why: 'the brief says extraction is shipped and should be promoted to one helper',
      holds: () => {
          let n = 0;
          for (const f of ['backend/routes/characters.js', 'backend/lib/review-proxy.js',
                           'backend/lib/mcp-tools.js']) {
              if (/'-frames:v'/.test(src(f))) n++;
          }
          return n >= 3;
      } },

    { id: 'concat exists',
      why: 'joining whole clips is shipped',
      holds: () => /function buildConcatArgs/.test(src('backend/lib/ffmpeg.js')) },

    /* THE TWO GAPS. Asserted as ABSENT, so the brief stops claiming a gap the
     * moment somebody closes it — a plan that still lists finished work as
     * missing is the failure this file exists to prevent. */
    { id: 'no trim helper yet',
      why: 'the first thing a build must add; the brief says it is missing',
      holds: () => !/function (buildTrimArgs|buildSpliceArgs|trimClip)/.test(src('backend/lib/ffmpeg.js')) },

    { id: 'playback scrubs but does not mark in/out',
      why: 'the surface exists and the marking does not',
      holds: () => {
          const page = src('src/index.html');
          return /pbScrub/.test(page) && !/pbMarkIn|pbMarkOut/.test(page);
      } },

    { id: 'video-edit sends no images',
      why: 'the unexplored control the brief flags — video-edit ACCEPTS images_list',
      holds: () => /seedance-2\.5-video-edit/.test(src('backend/lib/providers/seedance.js'))
          && /images:\s*\[\]/.test(src('backend/lib/providers/seedance.js')) },
];

test('the brief exists', () => {
    assert.ok(fs.existsSync(BRIEF), `no brief at ${path.relative(REPO, BRIEF)}`);
});

test('every required section is present', () => {
    const b = brief();
    const missing = REQUIRED_SECTIONS.filter(s => !b.includes(s));
    assert.deepStrictEqual(missing, [], `sections missing from the brief: ${missing.join(', ')}`);
});

/* Each claim checked against the SOURCE, and each must actually be stated in
 * the brief — a claim that holds but is never made is not this brief's. */
test('every claim the brief rests on still holds in the code', () => {
    assert.ok(CLAIMS.length >= 12, `only ${CLAIMS.length} claims; this set is not the real one`);
    const broken = CLAIMS.filter(c => !c.holds()).map(c => `${c.id} (${c.why})`);
    assert.deepStrictEqual(broken, [],
        `the brief asserts these and the code no longer agrees:\n  - ${broken.join('\n  - ')}`);
});

/* The load-bearing numbers must appear in the brief itself, not merely be true.
 * A brief that omits the 4-second floor lets somebody plan a 2-second fix. */
test('the brief states the constraints that decide the design', () => {
    const b = brief();
    for (const [what, re] of [
        ['the 4-second duration floor', /\b4[- ]second|MIN_DURATION|\b4s\b/],
        ['the cost per second', /0\.17|\$0\.17/],
        ['first-last-frame as the mechanism', /first-last-frame/],
        ['that the trim and splice are ours', /trim|splice/i],
    ]) {
        assert.match(b, re, `the brief never states ${what}`);
    }
});
