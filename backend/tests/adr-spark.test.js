/**
 * THE DECISION ON SPARK, AND WHETHER IT IS STILL TRUE.
 *
 * ADR-006 deferred splats and named what would change the answer; a director
 * saying they could not judge a camera without them was one, and it happened.
 * ADR-008 replaces it: splats render in Previs from ONE lazily imported module,
 * the page's own three r149 is untouched, and no dependency is added.
 *
 * A decision record is most dangerous when it goes stale — it is read as the
 * reason something is the way it is long after the reason stopped holding. So
 * this holds ADR-008 two ways:
 *
 * THE SHAPE, derived from the records that already exist rather than typed.
 *
 * THE CLAIMS, each with a predicate that reads the repo. Every number and name
 * the record rests on — the page size, the module size, the pinned versions,
 * the flag's default, the lazy import, the server fallback, the geometric
 * plate — must still be true, and the record fails here when one changes.
 *
 * And ADR-006 must SAY it is superseded: a deferral left reading "Accepted"
 * beside the code that did the thing is the stale record in its purest form.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');
const ADR = path.join(ADR_DIR, '008-spark-lazy-splat-viewer.md');
const OLD = path.join(ADR_DIR, '006-spark-and-the-splat-viewport.md');
const MODULE = path.join(ROOT, 'src', 'vendor', 'splat-viewer.js');
const PAGE = path.join(ROOT, 'src', 'index.html');

const read = (p) => fs.readFileSync(p, 'utf8');
const doc = () => read(ADR);

/* ── the shape, from the records that already exist ─────────────────────── */

function otherAdrs() {
    return fs.readdirSync(ADR_DIR).filter(f => /^\d+-.*\.md$/.test(f) && !f.startsWith('008-'));
}

/** The sections EVERY other ADR carries. */
function commonSections() {
    const sets = otherAdrs().map(f =>
        new Set([...read(path.join(ADR_DIR, f)).matchAll(/^## (.+)$/gm)].map(m => m[1].trim())));
    assert.ok(sets.length >= 4, `only ${sets.length} existing ADRs found — the scan is broken`);
    return [...sets[0]].filter(s => sets.every(set => set.has(s)));
}

test('the record exists where a reader would look for it', () => {
    assert.ok(fs.existsSync(ADR), `no ADR at ${path.relative(ROOT, ADR)} — splats render with no recorded reason`);
});

test('it carries every section the other records carry', () => {
    const want = commonSections();
    assert.ok(want.length >= 4, `only ${want.length} shared sections derived; re-check the scan`);
    const has = new Set([...doc().matchAll(/^## (.+)$/gm)].map(m => m[1].trim()));
    const missing = want.filter(s => !has.has(s));
    assert.deepStrictEqual(missing, [], `the record omits sections every other ADR carries: ${missing.join(', ')}`);
});

test('it takes a position and names what it replaces', () => {
    const d = doc();
    const status = /## Status\s*\n+([^\n]+)/.exec(d);
    assert.ok(status, 'the record has no status');
    assert.match(status[1], /Accepted/, `the status is "${status[1].trim()}"`);
    assert.match(status[1], /ADR-006/, 'the status does not say which record it supersedes');
    const decision = /## Decision\s*\n+([\s\S]*?)\n## /.exec(d);
    assert.ok(decision && decision[1].trim().length > 80, 'the Decision section says nothing');
    assert.match(decision[1], /lazily|only when/i, 'the Decision does not say the renderer is loaded on demand');
});

test('ADR-006 says it was superseded, and by what', () => {
    const status = /## Status\s*\n+([^\n]+)/.exec(read(OLD));
    assert.ok(status, 'ADR-006 lost its status');
    assert.match(status[1], /Superseded by ADR-008/,
        `ADR-006 still reads "${status[1].trim()}" beside code that renders splats`);
});

/* ── the claims, each checkable against the repo ────────────────────────── */

const CLAIMS = [
    {
        id: 'page-is-megabytes',
        why: 'the whole argument is that the page does NOT carry the renderer, so the record states its real size',
        holds() {
            const mb = (fs.statSync(PAGE).size / 1e6).toFixed(1);
            return doc().includes(mb + ' MB') || `the page is ${mb} MB and the record does not say so`;
        },
    },
    {
        id: 'module-is-megabytes',
        why: 'the cost moved from every visitor to whoever opens Look; the record must state that cost truly',
        holds() {
            if (!fs.existsSync(MODULE)) return 'src/vendor/splat-viewer.js is missing — run scripts/build-splat-viewer.sh';
            const mb = (fs.statSync(MODULE).size / 1e6).toFixed(1);
            return doc().includes(mb + ' MB') || `the module is ${mb} MB and the record does not say so`;
        },
    },
    {
        id: 'versions-are-pinned-and-named',
        why: 'the module is a build output; the versions in it, the script and the record must be one set',
        holds() {
            const head = read(MODULE).slice(0, 400);
            const script = read(path.join(ROOT, 'scripts', 'build-splat-viewer.sh'));
            for (const v of ['three 0.180.0', 'spark 2.2.0']) if (!head.includes(v)) return `the module banner no longer says ${v}`;
            if (!/spark@2\.2\.0/.test(script) || !/three@0\.180\.0/.test(script)) return 'the build script pins other versions';
            return (/0\.180\.0/.test(doc()) && /2\.2\.0/.test(doc())) || 'the record does not name the pinned versions';
        },
    },
    {
        id: 'page-keeps-r149',
        why: 'the record says the GLB stage and its converted GLTFLoader are untouched; that is its safety claim',
        holds() {
            if (!/r149/.test(read(PAGE))) return 'the page no longer vendors three r149';
            return doc().includes('r149') || 'the record does not name the revision it leaves alone';
        },
    },
    {
        id: 'page-does-not-inline-spark',
        why: 'the page references the classes by name but must never carry the library — that is the whole design',
        holds() {
            const ui = read(PAGE);
            if (ui.includes('@sparkjsdev')) return 'the page inlines Spark';
            if (!ui.includes("import('./vendor/splat-viewer.js')")) return 'the page no longer lazy-imports the module';
            return true;
        },
    },
    {
        id: 'server-serves-the-fallback',
        why: 'a page not served from src/ (the iOS shell) finds the module through the API; the record promises it',
        holds() {
            const server = read(path.join(ROOT, 'backend', 'server.js'));
            if (!server.includes("'/film/vendor/splat-viewer.js'")) return 'the API no longer serves the module';
            return doc().includes('/film/vendor/splat-viewer.js') || 'the record does not name the fallback';
        },
    },
    {
        id: 'flag-exists-and-is-off',
        why: 'the default is what keeps a 25 MB-per-world download opt-in; the record rests on it',
        holds() {
            const { SETTINGS } = require('../routes/app-settings');
            if (!SETTINGS.world_splats) return 'world_splats has left app-settings';
            if (SETTINGS.world_splats.default !== false) return 'world_splats no longer defaults false';
            return /world_splats/.test(doc()) || 'the record does not name the flag';
        },
    },
    {
        id: 'splats-endpoint-exists',
        why: 'the record says the tiers are listed by one endpoint that prefers a local copy',
        holds() {
            const worlds = read(path.join(ROOT, 'backend', 'routes', 'worlds.js'));
            if (!/splats/.test(worlds) || !/servedUrlFor/.test(worlds)) return 'the splats endpoint or its local-copy preference is gone';
            return doc().includes('/film/world-versions/:vid/splats') || 'the record does not name the endpoint';
        },
    },
    {
        id: 'plate-stays-geometric',
        why: 'Look is a preview; if generation started receiving the splat render, the record would be describing a different system',
        holds() {
            if (!/GENERATION STILL RECEIVES THE GEOMETRIC PLATE/.test(read(PAGE))) return 'the Look view no longer says the plate is geometric';
            return /generation plate stays geometric/i.test(doc()) || 'the record does not state it';
        },
    },
];

test('EVERY claim the record rests on is still true of the code', () => {
    const broken = CLAIMS.map(c => [c.id, c.holds()]).filter(([, r]) => r !== true).map(([id, r]) => `${id}: ${r}`);
    assert.deepStrictEqual(broken, [], 'the record has drifted from the code:\n  ' + broken.join('\n  '));
});

test('every claim states why it is worth pinning', () => {
    for (const c of CLAIMS) assert.ok(c.why && c.why.length > 30, `${c.id}: states no real reason`);
    assert.ok(CLAIMS.length >= 6, `only ${CLAIMS.length} claims pinned; the record rests on more`);
});

test('it says what would change the answer, in checkable terms', () => {
    const d = doc();
    const at = d.search(/would change (the|this) answer/i);
    assert.ok(at > -1, 'the record never says what would change the answer');
    const triggers = [...d.slice(at).matchAll(/^\s*[-*]\s+(.+)$/gm)].map(m => m[1]);
    assert.ok(triggers.length >= 3, `only ${triggers.length} triggers listed`);
    const vague = triggers.filter(t => !/single-html|three|r1\d\d|Spark|splat|bundler|flag|world_splats|plate|\.spz/i.test(t));
    assert.deepStrictEqual(vague, [], `these triggers name nothing anybody could check: ${vague.join(' | ')}`);
});

/* ── the acceptance criteria that are properties of the code ────────────── */

test('NO dependency was added to render splats', () => {
    // The module is built from a throwaway folder; the backend keeps its two.
    const pkg = JSON.parse(read(path.join(ROOT, 'backend', 'package.json')));
    assert.deepStrictEqual(Object.keys(pkg.dependencies || {}).sort(), ['better-sqlite3', 'ffmpeg-static']);
    assert.deepStrictEqual(Object.keys(pkg.devDependencies || {}), [], 'a devDependency was added');
    const rootPkg = path.join(ROOT, 'package.json');
    if (fs.existsSync(rootPkg)) {
        const all = JSON.stringify(JSON.parse(read(rootPkg)));
        assert.ok(!/sparkjsdev|"three"/.test(all), 'the root package.json gained spark or three');
    }
});

test('the module exports exactly what the page reaches for', () => {
    const tail = read(MODULE).slice(-4000);
    for (const name of ['SparkRenderer', 'SplatMesh', 'THREE']) {
        assert.ok(new RegExp(`\\b${name}\\b`).test(tail) || read(MODULE).includes(` as ${name}`),
            `the module no longer exports ${name}`);
    }
});
