/**
 * The plan for the first finished film, held to the code it describes.
 *
 * The acceptance criterion for this whole project is one sentence: write a
 * screenplay and take it through every stage until a final movie. Preflight
 * says every stage CAN run; no project has ever run them. A plan for that is
 * only worth its coverage, so the denominator is derived from
 * `lib/e2e-preflight` — the same registry preflight itself walks — and from
 * the rate book, never from a list typed into the plan.
 *
 * A plan that names 12 of 15 stages reads as complete and leaves the film
 * unfinished at exactly the point nobody checked.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '../../docs/plans/e2e-first-film.md');
const doc = () => fs.readFileSync(DOC, 'utf8');

const e2e = require('../lib/e2e-preflight');
const STAGES = typeof e2e.stages === 'function' ? e2e.stages() : e2e.stages;
const HANDOFF = e2e.HANDOFF;

/** Capabilities that actually spend money, derived from the stage list. */
const SPENDING = [...new Set(STAGES.map(s => s.capability).filter(Boolean))]
    .filter(c => c !== 'llm');   // the LLM is a subscription window, not a bill

test('the plan exists and is a plan, not a sketch', () => {
    assert.ok(fs.existsSync(DOC), 'docs/plans/e2e-first-film.md does not exist');
    const d = doc();
    assert.ok(d.length > 6000, `the plan is ${d.length} bytes — too short to cover 15 stages`);
    for (const word of ['milestone', 'acceptance', 'dependenc'])
        assert.match(d, new RegExp(word, 'i'), `the plan never mentions ${word}`);
});

test('every stage in the preflight registry is named with a disposition', () => {
    assert.strictEqual(STAGES.length, 15, `the stage registry changed: ${STAGES.length}`);
    const d = doc();
    for (const s of STAGES) {
        assert.ok(d.includes(s.id), `stage "${s.id}" is not named in the plan`);
    }
});

test('the three NLE hand-offs are named as hand-offs, not as engine work', () => {
    // Planning to "generate the lip-sync" would be planning work no adapter
    // does — Gridlight is the only provider for lipsync/post/mix and it does
    // not implement them. The plan must say where they really happen.
    const ids = Object.keys(HANDOFF);
    assert.strictEqual(ids.length, 3, `HANDOFF changed: ${ids.join(', ')}`);
    const d = doc();
    for (const id of ids) {
        assert.ok(d.includes(id), `hand-off stage ${id} is missing`);
    }
    assert.match(d, /NLE/, 'the plan never mentions the NLE, where three stages finish');
});

test('every spending capability carries a measured cost basis', () => {
    const d = doc();
    assert.ok(SPENDING.length >= 6, `expected the spending capabilities, got ${SPENDING.join(',')}`);
    for (const cap of SPENDING) {
        assert.ok(new RegExp(`\\b${cap}\\b`, 'i').test(d), `capability ${cap} has no cost line`);
    }
    // The number must be grounded in what this install has actually been
    // billed, not in a list price. 93 meshy calls at 7.61 credits each is the
    // only honest basis available for an image.
    assert.match(d, /7\.61|0\.15|13\.92|14\.12/,
        'the plan quotes no measured figure from film_usage_events / film_cost_entries');
});

test('the LLM stage goes through MCP, which is the standing rabbit hole', () => {
    const d = doc();
    assert.match(d, /MCP/, 'the plan never mentions MCP');
    assert.match(d, /subscription|no API key|costs nothing|\$0/i,
        'the plan does not say the LLM stage is a subscription window rather than a bill');
});

test('every milestone states how it is verified, with a runnable command', () => {
    const d = doc();
    const milestones = [...d.matchAll(/^### (M\d+)[^\n]*/gm)];
    assert.ok(milestones.length >= 5, `only ${milestones.length} milestones found`);
    for (let i = 0; i < milestones.length; i++) {
        const start = milestones[i].index;
        const end = i + 1 < milestones.length ? milestones[i + 1].index : d.length;
        const body = d.slice(start, end);
        assert.match(body, /\*\*Verify\*\*/,
            `${milestones[i][1]} has no **Verify** line`);
        assert.match(body, /\*\*Done when\*\*/,
            `${milestones[i][1]} has no **Done when** acceptance criterion`);
        assert.ok(/`[^`]*(node|curl|npm)[^`]*`/.test(body),
            `${milestones[i][1]} names no runnable command`);
    }
});

test('the plan is honest about what the engine cannot deliver', () => {
    const d = doc();
    // Both are measured facts about this install and change what "final movie"
    // can mean. A plan that promises 4K would be planning a disappointment.
    assert.match(d, /ratio-only|1376|no 2K|cannot.*2K/i,
        'the plan does not state the image provider ignores the requested resolution');
    assert.match(d, /720|1280|Runway.*ratio|upscale/i,
        'the plan does not state the video ceiling');
});

test('the plan starts from the cheapest thing that proves the claim', () => {
    const d = doc();
    assert.match(d, /thirty-second\.fountain/,
        'the plan does not use the fixture built for exactly this run');
    // Finishing an existing 13-shot project would cost several times more and
    // prove the same thing.
    assert.match(d, /Wingfall|Glass Harbour|existing project/i,
        'the plan does not say why it is not finishing an existing project');
});

test('the current state is measured, not assumed', () => {
    const d = doc();
    for (const fact of ['15', '12', '0 blocked'])
        assert.ok(d.includes(fact), `the plan omits the preflight result "${fact}"`);
    assert.match(d, /ffmpeg/i,
        'the plan does not confirm an encoder exists — without one there is no single file');
});
