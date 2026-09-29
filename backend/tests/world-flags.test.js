/**
 * A FLAG TURNED OFF MUST HIDE ITS REGION.
 *
 * Six boolean settings gate the World Engine. `world_engine` is the master and
 * is wired. The other FIVE — marble_generation, cinematography_ai,
 * reference_match, camera_explore, world_splats — are declared in
 * app-settings.js, returned by GET /settings, fetched by the page into
 * WORLD_FLAGS, and read by NOTHING. A director can switch off the one flag
 * that unlocks spending and watch the button that spends stay exactly where it
 * was.
 *
 * That is the declared-and-unread shape this codebase has paid for repeatedly:
 * NEVER_WRITES consumed by no code, `scope` on PIPELINE_STEPS read by no
 * runner, describeResolution exported with zero callers, voice_id read by a
 * builder against a column that did not exist. Every one of them looked like a
 * working feature from the outside.
 *
 * SET-BASED OVER THE FLAGS THEMSELVES, derived from the exported SETTINGS
 * rather than typed here, so a seventh flag is in the denominator with nothing
 * to remember — and CROSSED WITH THE DESIGN, so a flag cannot gate a region
 * the handoff does not draw.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const DESIGN = fs.readFileSync(
    path.join(ROOT, 'design_handoff_world_engine_previz', 'README.md'), 'utf8');

/* ── the denominator, from the settings registry ────────────────────────── */

/** Every boolean setting, read from the module that declares them. */
function booleanFlags() {
    const { SETTINGS } = require('../routes/app-settings');
    return Object.entries(SETTINGS)
        .filter(([, d]) => typeof d.default === 'boolean')
        .map(([k]) => k);
}

/** The master gates the whole console; the rest gate one region each. */
const MASTER = 'world_engine';
/*
 * Boolean settings that are NOT World Engine flags, each with what it gates and
 * where that is held. Named rather than filtered by pattern: a pattern would
 * quietly excuse the next world flag that forgets its region.
 */
const NOT_WORLD = {
    production_graph: 'gates the Production phase (one graph vs eight pages) — held by tests/production-graph.test.js',
    previs_console: 'lays the SAME console regions out as one screen — a layout, not a region — held by tests/previs-decisions.test.js',
    backup_projects: 'whether a scheduled backup also writes each project as JSON — not a screen at all — held by tests/backup-folder.test.js',
};
const subFlags = () => booleanFlags().filter(f => f !== MASTER && !NOT_WORLD[f]);

/* ── the design's regions, so a flag cannot gate something imaginary ────── */

const slug = (s) => s.toLowerCase()
    .replace(/\(.*?\)/g, ' ').replace(/[—–-].*$/, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function designRegionSlugs() {
    const from = DESIGN.indexOf('## Screens / Views');
    const to = DESIGN.indexOf('## Interactions & Behavior');
    return DESIGN.slice(from, to).split('\n')
        .filter(l => l.startsWith('### ')).map(l => l.slice(4).trim())
        .filter(h => !/^Screen:/.test(h))
        .map(h => slug(h.replace(/^Modal:\s*/, '')));
}

/* ── the page's own registry and builder, executed ──────────────────────── */

const { declSource: fnSource, renderConsole } = require('./console-render');

/** The flag → region map the page declares, read out of the page. */
function pageFlagRegions() {
    const m = /const WORLD_FLAG_REGIONS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(UI);
    assert.ok(m, 'the page declares no flag-to-region map, so no flag can gate anything');
    const out = {};
    for (const line of m[1].split('\n')) {
        const kv = /^\s*([a-z_]+)\s*:\s*'([a-z-]+)'/.exec(line);
        if (kv) out[kv[1]] = kv[2];
    }
    return out;
}

const renderWith = (flags) => renderConsole(flags);

// Every WORLD flag on. The NOT_WORLD flags stay at their defaults: a layout
// flag changes where regions sit, not whether they exist, and the one-screen
// layout is held by its own test (previs-decisions) with these same checks.
const allOn = () => Object.fromEntries(booleanFlags().filter(f => !NOT_WORLD[f]).map(f => [f, true]));

/**
 * Regions whose flag is wired and whose REGION is not built yet, each naming
 * the task that builds it. Named rather than dropped: a gap written down is
 * work, and a stale entry fails below the moment its region appears.
 */
const REGION_NOT_BUILT = {
};

/* ── the tests ──────────────────────────────────────────────────────────── */

test('the flag set is derived from the settings registry, not typed here', () => {
    const bools = booleanFlags();
    assert.ok(bools.length >= 6,
        `only ${bools.length} boolean settings found — the scan is broken, and a scan that finds `
        + 'too few reports the gap as closed');
    assert.ok(bools.includes(MASTER), 'the master flag is gone from the registry');
    assert.ok(subFlags().length >= 5, `only ${subFlags().length} sub-flags — re-derive this`);
});

test('EVERY sub-flag gates a region, and it is a region the DESIGN draws', () => {
    /*
     * Both halves matter. A flag with no region is declared and unread — the
     * shape this task exists to close. A flag pointing at a region the design
     * does not draw is a gate on something nobody will ever build.
     */
    const map = pageFlagRegions();
    const designed = new Set(designRegionSlugs());
    const bad = [];
    for (const f of subFlags()) {
        if (!map[f]) { bad.push(`${f}: gates nothing`); continue; }
        if (!designed.has(map[f])) bad.push(`${f}: gates "${map[f]}", which the design does not draw`);
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('the map does not gate a region with two different flags', () => {
    // Two flags on one region means turning either off hides it, and a
    // director switching the other back on watches nothing happen.
    const map = pageFlagRegions();
    const seen = new Map();
    for (const [f, r] of Object.entries(map)) {
        assert.ok(!seen.has(r), `${r} is gated by both ${seen.get(r)} and ${f}`);
        seen.set(r, f);
    }
});

test('EVERY sub-flag is actually CONSULTED, not merely mapped', () => {
    /*
     * A map nothing reads is the same defect one level up. The console must go
     * through the shared reader, and the reader must consult the map.
     */
    const reader = fnSource('worldRegionOn');
    assert.ok(reader, 'there is no shared region gate; each region would check its own flag');
    assert.match(reader, /WORLD_FLAG_REGIONS/,
        'the region gate does not consult the flag map, so the map gates nothing');
    assert.match(reader, /worldFlagOn/,
        'the region gate does not read the flag value, so it cannot be off');

    const console_ = fnSource('worldConsoleHtml');
    assert.match(console_, /worldRegionOn\s*\(/,
        'the console never asks whether a region is enabled');
});

test('a BUILT region disappears when its flag is off, and returns when it is on', () => {
    /*
     * The behavioural half, and the only one that can catch a gate wired to
     * the wrong flag. Rendered twice per flag: a check that only looks at the
     * "off" render passes against a console that renders nothing at all.
     */
    const map = pageFlagRegions();
    const on = renderWith(allOn());
    const failures = [];

    for (const f of subFlags()) {
        const region = map[f];
        if (!region || REGION_NOT_BUILT[region]) continue;
        const off = renderWith({ ...allOn(), [f]: false });
        if (off.length >= on.length) {
            failures.push(`${f}: turning it off changed nothing in the console (${region})`);
        }
    }
    assert.ok(subFlags().some(f => map[f] && !REGION_NOT_BUILT[map[f]]),
        'no sub-flag gates a region that exists, so this test proves nothing — if every region '
        + 'is genuinely unbuilt, say so here rather than letting it pass silently');
    assert.deepStrictEqual(failures, [], failures.join('\n  '));
});

test('the flag that unlocks SPENDING hides the button that spends', () => {
    /*
     * Named specifically because it is the one with money behind it.
     * marble_generation is documented as "the only World Engine flag that
     * unlocks spending", and NEW WORLD is what spends.
     */
    const map = pageFlagRegions();
    assert.strictEqual(map.marble_generation, 'create-spatial-world',
        'marble_generation no longer gates world creation');
    const on = renderWith(allOn());
    const off = renderWith({ ...allOn(), marble_generation: false });
    assert.match(on, /NEW WORLD/, 'the console offers no way to create a world even with the flag on');
    assert.ok(!/NEW WORLD/.test(off),
        'the world-creation button is still offered with marble_generation switched off — the one '
        + 'flag that gates spending gates nothing');
});

test('every unbuilt region is named with the task that builds it, and is really absent', () => {
    const on = renderWith(allOn());
    const designed = new Set(designRegionSlugs());
    const stale = [];
    for (const [region, why] of Object.entries(REGION_NOT_BUILT)) {
        assert.ok(designed.has(region), `REGION_NOT_BUILT names "${region}", which the design does not draw`);
        assert.match(why, /ICP-\d+/, `${region}: names no task that will build it`);
        const label = region.replace(/-/g, ' ').toUpperCase();
        if (on.toUpperCase().includes(`WE-LABEL">${label}`)) stale.push(region);
    }
    assert.deepStrictEqual(stale, [],
        `these now render and are still excused from the flag check — delete their entry so the `
        + `gate is exercised: ${stale.join(', ')}`);
});

test('the master flag still gates the whole console', () => {
    const src = fnSource('worldEngineOn');
    assert.ok(src && /world_engine/.test(src), 'the master flag reader is gone');
    // It must gate the RENDER, not merely exist.
    assert.ok(/if \(!worldEngineOn\(\)\) return/.test(UI),
        'nothing refuses to render the console when the master flag is off');
});

test('a boolean survives being switched off — the pin the gates rest on', () => {
    /*
     * Every gate here is `!!flag`. film_app_settings stores TEXT, so a `false`
     * written through String() comes back as "false", which is truthy — and
     * every gate reads OFF as ON. Fixed at the store; pinned here because this
     * task makes five more gates depend on it.
     */
    const { SETTINGS } = require('../routes/app-settings');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'app-settings.js'), 'utf8');
    assert.match(src, /function castLike/, 'the type cast on read is gone');
    assert.match(src, /function serialiseLike/, 'the type cast on write is gone');
    // On by decision, not by accident: ADR-008 turned these on for every
    // project. Every other gate still ships off.
    const ON_BY_DECISION = new Set(['world_splats', 'previs_console']);
    for (const f of booleanFlags()) {
        assert.strictEqual(SETTINGS[f].default, ON_BY_DECISION.has(f),
            ON_BY_DECISION.has(f) ? `${f} is on by ADR-008 and now defaults off`
                : `${f} defaults to true, so the feature is on for every existing install`);
    }
    // The page's own reader must treat the string "false" as off too, for rows
    // written before the store was fixed.
    const reader = fnSource('worldFlagOn');
    assert.match(reader, /'false'/,
        'the page reads a stored flag with plain truthiness, so a row written before the store '
        + 'was fixed reads OFF as ON');
});
