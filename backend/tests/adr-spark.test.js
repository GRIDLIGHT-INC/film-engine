/**
 * THE DECISION ON SPARK, AND WHETHER IT IS STILL TRUE.
 *
 * A decision record is the one kind of document that is most dangerous when it
 * goes stale: it is read as the reason something is the way it is, long after
 * the reason stopped holding. So this holds ADR-006 two ways.
 *
 * THE SHAPE, derived from the five ADRs that already exist rather than typed —
 * every one carries Status, Context, Decision, Rationale and Consequences, and
 * a sixth that invents its own headings is a record nobody can scan.
 *
 * THE CLAIMS, each with a predicate that reads the repo. Every number the ADR
 * rests on — the page size, the vendored three.js revision, the build target,
 * the flag's default, the spike's own measurements — must still be true, and
 * the record fails here when one changes rather than misleading the person who
 * reaches for it. That is the mechanism ios-previz-brief already uses for the
 * research brief, pointed at a decision instead.
 *
 * It also holds the two acceptance criteria that are properties of the CODE
 * rather than of the prose: world_splats stays false, and no dependency is
 * added — a decision to defer that quietly adds the thing it defers is not a
 * deferral.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');
const ADR = path.join(ADR_DIR, '006-spark-and-the-splat-viewport.md');

const read = (p) => fs.readFileSync(p, 'utf8');
const doc = () => read(ADR);

/* ── the shape, from the records that already exist ─────────────────────── */

function existingAdrs() {
    return fs.readdirSync(ADR_DIR).filter(f => /^\d+-.*\.md$/.test(f) && !f.startsWith('006-'));
}

/** The sections EVERY existing ADR carries. */
function commonSections() {
    const sets = existingAdrs().map(f =>
        new Set([...read(path.join(ADR_DIR, f)).matchAll(/^## (.+)$/gm)].map(m => m[1].trim())));
    assert.ok(sets.length >= 4, `only ${sets.length} existing ADRs found — the scan is broken`);
    return [...sets[0]].filter(s => sets.every(set => set.has(s)));
}

test('the record exists where a reader would look for it', () => {
    assert.ok(fs.existsSync(ADR),
        `no ADR at ${path.relative(ROOT, ADR)} — the decision to defer is not recorded anywhere, `
        + 'so the next person re-derives it');
});

test('it carries every section the other records carry', () => {
    const want = commonSections();
    assert.ok(want.length >= 4, `only ${want.length} shared sections derived; re-check the scan`);
    const has = new Set([...doc().matchAll(/^## (.+)$/gm)].map(m => m[1].trim()));
    const missing = want.filter(s => !has.has(s));
    assert.deepStrictEqual(missing, [],
        `the record omits sections every other ADR carries: ${missing.join(', ')}`);
});

test('it takes a position, rather than describing one', () => {
    const d = doc();
    const status = /## Status\s*\n+([^\n]+)/.exec(d);
    assert.ok(status, 'the record has no status');
    assert.match(status[1], /Accepted|Superseded|Proposed/,
        `the status is "${status[1].trim()}", which is not one an ADR can be in`);
    // A decision section that does not decide is a summary.
    const decision = /## Decision\s*\n+([\s\S]*?)\n## /.exec(d);
    assert.ok(decision && decision[1].trim().length > 80, 'the Decision section says nothing');
    assert.match(decision[1], /\bnot\b|defer|decline|no\b/i,
        'the Decision does not say what is NOT being done, which is the whole content of a deferral');
});

/* ── the claims, each checkable against the repo ────────────────────────── */

/**
 * Every factual claim the record rests on.
 *
 * A claim with no predicate is a sentence; a claim with one is a fact that
 * fails when it stops being true. Each returns `true` or the reason it no
 * longer holds.
 */
const CLAIMS = [
    {
        id: 'page-is-megabytes',
        why: 'the cost of vendoring is the page weight, so the record must state the real one',
        holds() {
            const bytes = fs.statSync(path.join(ROOT, 'src', 'index.html')).size;
            const mb = (bytes / 1e6).toFixed(1);
            return doc().includes(mb) || `the page is ${mb} MB and the record does not say so`;
        },
    },
    {
        id: 'three-is-vendored-and-old',
        why: 'Spark 2.0 expects a modern three; the revision actually vendored is the constraint',
        holds() {
            const ui = read(path.join(ROOT, 'src', 'index.html'));
            if (!/r149/.test(ui)) return 'three.js r149 is no longer what the page vendors';
            return doc().includes('r149') || 'the record does not name the revision vendored';
        },
    },
    {
        id: 'build-target-is-single-html',
        why: 'it is the reason a dependency cannot simply be added, and it is a pinned setting',
        holds() {
            const manifest = JSON.parse(read(path.join(ROOT, 'gridlight.json')));
            const target = manifest.build && manifest.build.target;
            if (target !== 'single-html') return `build.target is now "${target}"`;
            return /single-html/.test(doc()) || 'the record does not name the build target';
        },
    },
    {
        id: 'flag-exists-and-is-off',
        why: 'the deferral IS the flag staying false; a record saying so while it defaults true is a lie',
        holds() {
            const { SETTINGS } = require('../routes/app-settings');
            if (!SETTINGS.world_splats) return 'world_splats has left app-settings';
            if (SETTINGS.world_splats.default !== false) return 'world_splats no longer defaults false';
            return /world_splats/.test(doc()) || 'the record does not name the flag it rests on';
        },
    },
    {
        id: 'panel-renders-without-a-splat',
        why: 'the record claims the panel already answers its question from geometry; if it stopped, '
            + 'the deferral has a different cost',
        holds() {
            const { renderConsole } = require('./console-render');
            const html = renderConsole({ world_engine: true, world_splats: true,
                marble_generation: true, cinematography_ai: true, reference_match: true,
                camera_explore: true });
            return html.includes('data-region="spatial-world"')
                || 'the Spatial World panel no longer renders at all';
        },
    },
    {
        id: 'flag-gates-the-panel-it-names',
        why: 'the record claims world_splats gates a region that EXISTS rather than gating nothing — '
            + 'which is the one cost it names about itself, so it must stay true',
        holds() {
            const { renderConsole } = require('./console-render');
            const base = { world_engine: true, marble_generation: true, cinematography_ai: true,
                           reference_match: true, camera_explore: true };
            const on = renderConsole({ ...base, world_splats: true });
            const off = renderConsole({ ...base, world_splats: false });
            if (!on.includes('data-region="spatial-world"')) return 'the panel does not render with the flag on';
            if (off.includes('data-region="spatial-world"')) {
                return 'the panel still renders with world_splats off — the flag gates nothing, which '
                     + 'is exactly what the record says it does not do';
            }
            return true;
        },
    },
    {
        id: 'spike-measured-the-collider',
        why: 'the record leans on the collider mesh being usable; the numbers came from a paid spike '
            + 'and must stay findable',
        holds() {
            const brief = read(path.join(ROOT, 'docs', 'plans', 'pipeline-readiness-brief.md'));
            if (!/53,841 triangles/.test(brief)) return 'the spike measurement has left the brief';
            return /53,841/.test(doc()) || 'the record cites no measurement for the collider mesh';
        },
    },
    {
        id: 'decimation-budget-is-real',
        why: 'the stage draws a decimated mesh; the budget is a number in the code, not an idea',
        holds() {
            const spike = read(path.join(ROOT, 'backend', 'spike-world.js'));
            if (!/decimate\(geo, 20000\)/.test(spike)) return 'the 20,000-triangle budget has changed';
            return /20,000|20000/.test(doc()) || 'the record does not state the budget';
        },
    },
];

test('EVERY claim the record rests on is still true of the code', () => {
    const broken = CLAIMS.map(c => [c.id, c.holds()]).filter(([, r]) => r !== true)
        .map(([id, r]) => `${id}: ${r}`);
    assert.deepStrictEqual(broken, [],
        'the record has drifted from the code:\n  ' + broken.join('\n  '));
});

test('every claim states why it is worth pinning', () => {
    // A claim with no reason is one nobody can judge the removal of.
    for (const c of CLAIMS) {
        assert.ok(c.why && c.why.length > 30, `${c.id}: states no real reason`);
    }
    assert.ok(CLAIMS.length >= 6, `only ${CLAIMS.length} claims pinned; the record rests on more`);
});

/* ── what would change the answer ───────────────────────────────────────── */

test('it says what would change the answer, in checkable terms', () => {
    /*
     * The half that makes a deferral revisitable. "If requirements change" is
     * not a trigger; "if the build target stops being single-html" is, because
     * somebody can look.
     */
    const d = doc();
    const at = d.search(/would change (the|this) answer/i);
    assert.ok(at > -1,
        'the record never says what would change the answer, so the deferral has no way back');
    const section = d.slice(at);
    const triggers = [...section.matchAll(/^\s*[-*]\s+(.+)$/gm)].map(m => m[1]);
    assert.ok(triggers.length >= 3,
        `only ${triggers.length} triggers listed — a deferral with one condition is a preference`);
    // Each must name something concrete enough to look at.
    const vague = triggers.filter(t => !/single-html|three|r1\d\d|Spark|splat|bundler|flag|world_splats|collider|mesh|occlusion|director/i.test(t));
    assert.deepStrictEqual(vague, [],
        `these triggers name nothing anybody could check: ${vague.join(' | ')}`);
});

/* ── the acceptance criteria that are properties of the code ────────────── */

test('NO dependency was added by this decision', () => {
    /*
     * A deferral that quietly adds the thing it defers is not a deferral. The
     * backend has exactly two, both deliberate and both recorded: better-sqlite3
     * (ADR-001) and ffmpeg-static, the exception CLAUDE.md documents because
     * Node cannot mux MP4.
     */
    const pkg = JSON.parse(read(path.join(ROOT, 'backend', 'package.json')));
    const deps = Object.keys(pkg.dependencies || {});
    assert.deepStrictEqual(deps.sort(), ['better-sqlite3', 'ffmpeg-static'],
        `the dependency set changed: ${deps.join(', ')}`);
    assert.deepStrictEqual(Object.keys(pkg.devDependencies || {}), [],
        'a devDependency was added; the build has none by design');
});

test('nothing in the page loads a splat renderer', () => {
    // The strongest form of "we did not do it": no code reaches for one.
    const ui = read(path.join(ROOT, 'src', 'index.html'));
    for (const marker of ['@sparkjsdev', 'SparkRenderer', 'SplatMesh']) {
        assert.ok(!ui.includes(marker),
            `the page references ${marker} — the ADR says splats are deferred and they are not`);
    }
});
