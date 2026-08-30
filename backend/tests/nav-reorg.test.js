/**
 * The sidebar the director asked for.
 *
 * The nav was derived from PROJECT_PHASES — nine groups, matching the status
 * machine — and that derivation is deliberately GIVEN UP here, because the
 * requested grouping cuts across phases: Consistency is pre-production and sits
 * under Plan; Milestones and Budget are production and sit under Plan; Assets
 * is an export surface and sits under Post beside the job queue. No merge of
 * the nine produces these four. Pretending otherwise would mean bending either
 * the menu or the status machine to fit the other.
 *
 * What is NOT given up is the invariant that was doing the work: every page the
 * SPA has is placed in exactly one group, and the map never names a page that
 * does not exist. That is the check that catches an orphan — a page still in
 * the build, unreachable from the menu, which looks exactly like a deleted
 * feature until someone asks where it went.
 *
 * Removal is checked as a SET over every surface a page occupies — nav button,
 * panel, loader, reload map, nav map — because a page removed from four of five
 * is still in the build: the button is gone and the panel is still rendered
 * under 'Other' by the stray-catcher in applyNavFlow, which exists precisely so
 * that nothing vanishes silently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { NAV_FLOW, ALWAYS_AVAILABLE, orderedPhases } = require('../lib/nav-flow');
const HTML = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

/** Every page the SPA actually has, read from the markup rather than listed. */
const SPA_PAGES = new Set(
    [...HTML.matchAll(/data-page="([a-z0-9-]+)"/g)].map(m => m[1])
);

/**
 * Gone completely, each for the reason it was asked for.
 *
 * `production` is not a deletion — it is a MOVE. Its panels are the ones worth
 * seeing first, so they belong on the page you land on rather than behind a
 * menu item you have to know to click.
 */
const REMOVED = {
    continuity:    'a reference board nothing reads at generation time',
    selects:       'circle-takes, with nothing generating multiple takes to circle',
    dubbing:       'localisation, not part of making the film',
    provenance:    'delivery paperwork',
    rights:        'delivery paperwork',
    broadcastqc:   'delivery paperwork',
    colorgrading:  'grading happens in the NLE',
    colorpipeline: 'ACES chains describe a step AI generation does not have',
    production:    'folded into the home page',
};

/**
 * The menu, exactly as asked for: four labels, in this order, these pages.
 *
 * `titles` and `subtitles` were NOT in the original request and are added
 * deliberately: their routes shipped with the delivery work and neither had a
 * page, so a credit's role, a card's hold and a cue's language could only be
 * written by curl. Adding a page to this list is a decision, which is why the
 * list is written down rather than derived from the menu it checks — a derived
 * one would agree with any page anybody added.
 */
const WANTED = [
    ['Write & Design', ['screenplay', 'scenes', 'notes', 'moodboard',
        'characters', 'locations', 'props', 'threed']],
    ['Plan',           ['storyboard', 'previs', 'consistency', 'milestones', 'budget']],
    ['Production',     ['shotboard', 'videoshots', 'music', 'musiccues', 'playback',
        'pipeline', 'flows']],
    ['Post',           ['exportpage', 'titles', 'subtitles', 'marketing', 'assets',
        'jobsqueue', 'renderhistory']],
];

/**
 * The menu the page actually builds.
 *
 * The chrome carries its OWN copy of the grouping (`var PHASES` in the redesign
 * block), because the page cannot require a node module and the chrome is built
 * synchronously at load. That copy is what a person sees; nav-flow.js feeds the
 * sidebar the chrome then empties. So the first reorganisation of this menu
 * changed the server map, passed every check written against it, and left the
 * visible menu on its old six phases — a test blind to the surface it was about.
 */
function spaPhases() {
    const start = HTML.indexOf('  var PHASES = [');
    assert.ok(start > -1, 'the redesign chrome no longer declares PHASES');
    const end = HTML.indexOf('  var RAIL = [', start);
    const body = HTML.slice(start, end);
    return [...body.matchAll(/\{\s*id:'([a-z]+)',\s*label:'([^']+)',[\s\S]*?pages:\[([^\]]*)\]/g)]
        .map(m => ({
            id: m[1],
            label: m[2].replace(/&amp;/g, '&'),
            pages: m[3].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean),
        }));
}

test('the visible menu and the server map are the same menu', () => {
    // Element by element: a copy that agrees on labels and differs on one page
    // is the drift this exists to catch.
    const spa = spaPhases();
    const server = orderedPhases();
    assert.deepEqual(spa.map(p => p.label), server.map(p => p.label),
        'the chrome and lib/nav-flow.js disagree about the groups or their order');
    for (const group of server) {
        const mine = spa.find(p => p.label === group.label);
        assert.deepEqual(mine.pages, group.pages,
            `'${group.label}' holds different pages in the page than on the server`);
    }
});

test('every group the page shows has a blurb that says what it is for', () => {
    for (const group of spaPhases()) {
        const m = HTML.match(new RegExp(`label:'${group.label.replace('&', '&')}',\\s*blurb:'([^']+)'`));
        assert.ok(m && m[1].length > 10, `'${group.label}' has no blurb — the panel header would be blank`);
    }
});

test('the four groups are the ones asked for, in order', () => {
    const got = orderedPhases().map(p => [p.label, p.pages]);
    assert.deepEqual(got.map(g => g[0]), WANTED.map(g => g[0]),
        'group labels or their order do not match the requested menu');
    for (const [label, pages] of WANTED) {
        const group = got.find(g => g[0] === label);
        assert.deepEqual(group[1], pages,
            `'${label}' does not carry exactly the requested pages in the requested order`);
    }
});

test('every removed page is gone from every surface it occupied', () => {
    // Set-based over all nine: a page removed from the nav map but still
    // rendered is reachable through applyNavFlow's stray-catcher, and one
    // removed from the SPA but left in the map makes the map name a page that
    // does not exist. Both look like success from the other side.
    for (const [page, why] of Object.entries(REMOVED)) {
        assert.ok(!SPA_PAGES.has(page),
            `page '${page}' is still in the SPA (${why})`);
        assert.ok(!ALWAYS_AVAILABLE.includes(page),
            `'${page}' is still always-available`);
        for (const [id, phase] of Object.entries(NAV_FLOW)) {
            assert.ok(!phase.pages.includes(page),
                `'${page}' is still in nav group '${id}'`);
        }
        assert.ok(!new RegExp(`navigateTo\\(['"]${page}['"]`).test(HTML),
            `something still navigates to '${page}' — a button that goes nowhere`);
        // The chrome's own copy: the surface a person actually sees.
        for (const group of spaPhases()) {
            assert.ok(!group.pages.includes(page),
                `'${page}' is still in the visible menu under '${group.label}'`);
        }
    }
});

test('no page is orphaned: everything in the build is reachable from the menu', () => {
    const placed = new Set([...ALWAYS_AVAILABLE, ...Object.values(NAV_FLOW).flatMap(p => p.pages)]);
    const orphans = [...SPA_PAGES].filter(p => !placed.has(p));
    assert.deepEqual(orphans, [],
        `these pages exist and no menu group contains them: ${orphans.join(', ')}`);
});

test('the menu never names a page the SPA does not have', () => {
    const named = [...ALWAYS_AVAILABLE, ...Object.values(NAV_FLOW).flatMap(p => p.pages)];
    for (const page of named) {
        assert.ok(SPA_PAGES.has(page), `menu names '${page}', which the SPA does not have`);
    }
});

test('a page appears in exactly one group', () => {
    const seen = new Map();
    for (const [id, phase] of Object.entries(NAV_FLOW)) {
        for (const page of phase.pages) {
            assert.ok(!seen.has(page),
                `'${page}' is in both '${seen.get(page)}' and '${id}' — the menu would show it twice`);
            seen.set(page, id);
        }
    }
    for (const page of ALWAYS_AVAILABLE) {
        assert.ok(!seen.has(page),
            `'${page}' is always-available AND in group '${seen.get(page)}'`);
    }
});

test('Plan & Shoot moved to the home page, and every panel there goes somewhere', () => {
    // "ONLY add the things that are clickable and bring me to the other
    // section" — a read-only stat on a landing page is something to look at;
    // this list is meant to be the way in.
    const m = HTML.match(/const HOME_PANELS\s*=\s*\[([\s\S]*?)\n\s*\];/);
    assert.ok(m, 'no HOME_PANELS on the home page — Plan & Shoot has nowhere to have moved to');
    const entries = m[1].split('\n').filter(l => /\{\s*id:/.test(l));
    assert.ok(entries.length >= 5,
        `home carries only ${entries.length} panel(s) — the useful reports did not come across`);
    for (const line of entries) {
        const id = (line.match(/id:\s*'([^']+)'/) || [])[1];
        assert.ok(/go:\s*'[a-z]+'/.test(line),
            `home panel '${id}' has no destination — it is a stat, not a way in`);
    }
    assert.ok(/HOME_PANELS/.test(HTML.slice(HTML.indexOf('function loadHome'))),
        'the home page loader never reads HOME_PANELS');
});

test('the home progress block never links to a page that was removed', () => {
    /*
     * The six progress phases are NOT the menu and are deliberately kept at
     * six: they measure six distinct real things — scenes broken down, shots
     * carded, keyframed, filmed, approved, delivered — and collapsing them to
     * match the four menu groups would throw information away. But each one
     * carries a `page` and is clickable, so it is navigation too, and a phase
     * pointing at a deleted page is a dead link on the first screen you see.
     */
    const { PHASES } = require('../lib/home');
    for (const phase of PHASES) {
        assert.ok(SPA_PAGES.has(phase.page),
            `home phase '${phase.label}' links to '${phase.page}', which no longer exists`);
        for (const [removed] of Object.entries(REMOVED)) {
            assert.notEqual(phase.page, removed,
                `home phase '${phase.label}' still points at removed page '${removed}'`);
        }
    }
    // And its wording must not name a feature that is gone: the note beside a
    // number is read as describing that number.
    const src = fs.readFileSync(path.join(__dirname, '../lib/home.js'), 'utf8');
    for (const removed of ['takes circled', 'circle the takes', 'continuity ref']) {
        assert.ok(!new RegExp(removed, 'i').test(src),
            `home still describes progress in terms of '${removed}', which the app no longer has`);
    }
});
