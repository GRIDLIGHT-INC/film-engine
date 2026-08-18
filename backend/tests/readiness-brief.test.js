/**
 * Conformance test for the pipeline readiness brief.
 *
 * A brief is wrong in the way a plan is wrong: it omits part of the set and
 * reads as complete, because the gap is an absence rather than a false
 * statement. The same defence applies — iterate the registries the brief is
 * about rather than spot-checking that it mentions something.
 *
 * The specific failure this guards: a readiness document that lists the
 * capabilities that work and quietly drops the ones that do not is worse than
 * no document, because it is the thing someone reads the night before a shoot.
 *
 * Brief: docs/plans/pipeline-readiness-brief.md
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CAPABILITIES } = require('../lib/providers/base');
const providers = require('../lib/providers');
const { stages } = require('../lib/e2e-preflight');

const BRIEF = path.join(__dirname, '..', '..', 'docs', 'plans', 'pipeline-readiness-brief.md');
const brief = () => fs.readFileSync(BRIEF, 'utf8');

// The six sections the step asked for, verbatim.
const REQUIRED_SECTIONS = [
    'Executive Summary',
    'Key Themes',
    'Top Ideas & Opportunities',
    'Technical Approaches',
    'Open Questions',
    'Recommended Direction',
];

// Every source the research actually used. A brief that drops sources is a
// brief nobody can check.
const SOURCES = [
    'publicapi.dev/article/mcp-vs-rest-public-apis-2026',
    'sitepoint.com/model-context-protocol-mcp',
    'deep-image.ai/blog/model-context-protocol-mcp-image-processing-api',
    'storyflow.so/blog/best-ai-tools-for-filmmakers-2026',
    'frameo.ai/blog/ai-filmmaking-tool-overview-features',
    'docs.dev.runwayml.com/characters/concepts',
    'docs.dev.runwayml.com/api-details/sdks',
    'github.com/useapi/runway-api',
];

test('the brief exists and is substantial', () => {
    assert.ok(fs.existsSync(BRIEF), `brief is missing: ${BRIEF}`);
    assert.ok(brief().length > 3000, 'the brief is too short to have briefed anything');
});

test('every required section is present, under its own heading', () => {
    const md = brief();
    const missing = REQUIRED_SECTIONS.filter(s => !new RegExp(`^#{2,3}\\s*${s}`, 'm').test(md));
    assert.deepStrictEqual(missing, [], `sections missing: ${missing.join(', ')}`);
});

test('every capability is accounted for by name', () => {
    // Set-based over the provider registry's own list: a readiness brief that
    // covers eight of eleven capabilities has silently dropped three.
    const md = brief();
    const missing = CAPABILITIES.filter(c => !new RegExp(`\\b${c}\\b`).test(md));
    assert.deepStrictEqual(missing, [], `capabilities never mentioned: ${missing.join(', ')}`);
});

test('every registered adapter is named', () => {
    const md = brief();
    const missing = providers.list().map(a => a.id).filter(id => !md.includes(id));
    assert.deepStrictEqual(missing, [], `adapters never mentioned: ${missing.join(', ')}`);
});

test('the brief states the real stage counts, not a rounded story', () => {
    const md = brief();
    const total = stages().length;
    assert.ok(md.includes(String(total)), `the brief never states the ${total}-stage total`);
    // The three handed to the NLE and the one blocker are the numbers a reader
    // acts on; a brief that omits them is describing a different pipeline.
    for (const claim of ['11 ready', '3', '1 blocked']) {
        assert.ok(md.includes(claim), `the brief does not state '${claim}'`);
    }
});

test('the capabilities with no hosted adapter are named as gaps, not omitted', () => {
    // Derived, not listed: whichever capabilities have only the fallback are
    // the honest gaps, and the brief has to say so.
    const md = brief();
    const gaps = CAPABILITIES.filter(c =>
        !providers.list().some(a => a.id !== 'gridlight' && a.supports && a.supports(c)));
    assert.ok(gaps.length >= 2, `expected real gaps to exist, found ${gaps.length}`);

    const section = md.slice(md.search(/^#{2,3}\s*Open Questions/m));
    const unnamed = gaps.filter(c => !md.includes(c));
    assert.deepStrictEqual(unnamed, [], `gap capabilities not mentioned anywhere: ${unnamed.join(', ')}`);
    assert.ok(section.length > 200, 'Open Questions is empty');
});

test('every source the research used is cited', () => {
    const md = brief();
    const missing = SOURCES.filter(u => !md.includes(u));
    assert.deepStrictEqual(missing, [], `uncited sources: ${missing.join(', ')}`);
});

test('the reseller source is marked as not authoritative', () => {
    // The trap the research nearly fell into: useapi.net is a third-party
    // wrapper, and its endpoint list is not Runway's. A brief that cites it
    // without that caveat hands the trap to the next reader.
    const md = brief();
    const near = md.slice(Math.max(0, md.indexOf('useapi') - 600), md.indexOf('useapi') + 600);
    assert.ok(/third-party|reseller|not Runway|unofficial/i.test(near),
        'useapi.net is cited without flagging that it is not Runway');
});

test('the stated rabbit hole is answered explicitly', () => {
    const md = brief();
    assert.ok(/MCP/.test(md), 'MCP is never discussed');
    assert.ok(/agent|tools\/list|server-to-server|programmatic/i.test(md),
        'the brief does not say what MCP is and is not the right transport for');
});

test('the one blocker a reader must act on is unmissable', () => {
    const md = brief();
    assert.ok(/RUNWAY_API_KEY/.test(md), 'the brief never names the environment variable that unblocks the run');
    assert.ok(/Executive Summary[\s\S]{0,900}RUNWAY_API_KEY/.test(md),
        'the blocker is buried below the executive summary');
});

test('every deferred item from the research step is carried forward', () => {
    // Deferrals that vanish between steps are how a known gap becomes a
    // surprise. Each one has to survive into the brief.
    const md = brief();
    const carried = [
        /character_performance/,          // the unbuilt adapter
        /no live .*run|not been run|proven ready/i,   // nothing generated yet
        /Premiere|NLE/,                   // the lipsync/post/mix handoff
    ];
    const dropped = carried.filter(re => !re.test(md));
    assert.deepStrictEqual(dropped.map(String), [], 'a deferred item was dropped between steps');
});
