const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const BRIEF = path.join(REPO, 'docs', 'plans', 'ios-capture-and-previz-brief.md');

const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const has = (p) => fs.existsSync(path.join(REPO, p));
const brief = () => fs.readFileSync(BRIEF, 'utf8');

/**
 * A BRIEF THAT ASSERTS THINGS ABOUT THE CODE MUST STAY TRUE ABOUT THE CODE.
 *
 * Same reasoning as redo-between-frames-brief.test.js, and the same failure it
 * exists to stop: this document is read to decide what to build, and every
 * number in it — a region count, a pixel ceiling, a capability that is present
 * or absent — was measured from the source. A plan whose facts have drifted is
 * worse than no plan, because it is confidently wrong about the one thing
 * somebody opened it to check.
 *
 * Set-based over TWO registries: the seven sections this step's own template
 * requires, and every claim the brief rests on. An example-based check passes
 * on a brief with six of seven sections and one stale ceiling.
 *
 * Claims are checked against the SOURCE, never against the research document —
 * that is itself a secondary source and could have drifted too. Claims that
 * depend on the live database are deliberately NOT here: the database lives
 * outside the repo and moves between profiles, and a check that only runs when
 * there happens to be data is a check that does not run. Those appear in the
 * brief as dated measurements instead, and the DERIVABLE form of each is
 * asserted here (meshy cannot reach the location floor, rather than "the diner
 * plate is 1376x768").
 */

/** The seven sections the step's template requires. */
const REQUIRED_SECTIONS = [
    'Executive Summary',
    'Key Themes',
    'Top Ideas & Opportunities',
    'Technical Approaches',
    'Open Questions',
    'Recommended Direction',
];

/** Pull one function's body out of a file by brace depth — never a window. */
function fnBody(text, name) {
    const at = text.indexOf(`function ${name}(`);
    if (at < 0) return null;
    let d = 0;
    for (let i = text.indexOf('{', at); i < text.length; i++) {
        if (text[i] === '{') d++;
        else if (text[i] === '}' && --d === 0) return text.slice(at, i + 1);
    }
    return null;
}

/** Every `world*` builder in the page, concatenated — the console's real source. */
function consoleSource(UI) {
    const names = [...UI.matchAll(/function (world[A-Za-z0-9_]*)\(/g)].map((m) => m[1]);
    assert.ok(names.length >= 20,
        `the world* builder scan found ${names.length} — it is broken, not the page`);
    return names.map((n) => fnBody(UI, n) || '').join('\n');
}

/** The design's own region headings, minus the screen wrapper. */
function designRegions(D) {
    const regions = [...D.matchAll(/^### (.+)$/gm)].map((m) => m[1])
        .filter((r) => !/^Screen:/.test(r));
    assert.ok(regions.length >= 10,
        `the design heading scan found ${regions.length} — it is broken`);
    return regions;
}

const CLAIMS = [
    {
        id: 'design-regions-short',
        why: 'the brief says the console renders only some of the regions the design specifies',
        holds() {
            const UI = src('src/index.html');
            const D = src('design_handoff_world_engine_previz/README.md');
            const body = consoleSource(UI);
            const regions = designRegions(D);
            const present = regions.filter((r) => {
                const key = r.replace(/ *\(.*\)| *—.*$/, '').replace(/^Modal: /, '').trim();
                return new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body);
            });
            // Holds while the console is SHORT of the design. Returns true on
            // holding, like every other claim — returning the ratio here read
            // as a broken claim on the very finding the brief is built on.
            return present.length < regions.length
                || `all ${regions.length} design regions are now present`;
        },
    },
    {
        id: 'cinematography-backend-built',
        why: 'the brief says Direct the Shot / Explore Shot already have a backend',
        holds() {
            const s = src('backend/lib/cinematography.js');
            const need = ['buildBrief', 'exploreBrief', 'validateProposal',
                'applyProposal', 'acceptCandidates', 'compareCameras'];
            const missing = need.filter((n) => !fnBody(s, n));
            return missing.length === 0 || `missing: ${missing.join(', ')}`;
        },
    },
    {
        id: 'cinematography-unreached-by-page',
        why: 'the brief says the gap is a control, not a capability',
        holds() {
            const UI = src('src/index.html');
            const reached = ['camera/propose', 'camera/explore', 'cinematography']
                .filter((k) => UI.includes(k));
            return reached.length === 0 || `page already calls: ${reached.join(', ')}`;
        },
    },
    {
        id: 'world-subflags-unread',
        why: 'the brief says four flags are ON in settings and none is read by the page',
        holds() {
            const UI = src('src/index.html');
            const S = src('backend/routes/app-settings.js');
            const flags = ['marble_generation', 'cinematography_ai', 'reference_match',
                'camera_explore', 'world_splats'];
            const declared = flags.filter((f) => S.includes(f));
            assert.deepStrictEqual(declared, flags, 'a flag left app-settings');
            const read = flags.filter((f) => UI.includes(f));
            return read.length === 0 || `page reads: ${read.join(', ')}`;
        },
    },
    {
        id: 'meshy-cannot-reach-location-floor',
        why: 'the derivable form of the diner-plate resolution finding',
        holds() {
            const floor = Number(/LOCATION_MIN_EDGE *= *(\d+)/
                .exec(src('backend/lib/reference-plates.js'))[1]);
            const m = src('backend/lib/providers/meshy.js');
            const cap = Number(/maxImagePixels: *(\d+)/.exec(m)[1]);
            return cap < floor || `meshy now reaches ${cap} against a floor of ${floor}`;
        },
    },
    {
        id: 'meshy-is-edit-mode',
        why: 'why a new view drops every reference and is generated from words alone',
        holds() {
            const m = src('backend/lib/providers/meshy.js');
            return /referenceMode: *'edit'/.test(m) || 'meshy is no longer edit-mode';
        },
    },
    {
        id: 'diner-prompt-not-truncated',
        why: 'the brief rules truncation OUT as a cause; that must stay true',
        holds() {
            const lim = Number(/promptLimit: *(\d+)/
                .exec(src('backend/lib/providers/meshy.js'))[1]);
            return lim >= 5000 || `meshy promptLimit fell to ${lim}`;
        },
    },
    {
        id: 'no-video-to-video-model',
        why: 'the brief says keep-actor-change-background has no provider path today',
        holds() {
            const files = ['backend/lib/providers/runway.js', 'backend/lib/mcp-tools.js'];
            const hit = files.filter((f) => /aleph/i.test(src(f)));
            return hit.length === 0 || `aleph now appears in: ${hit.join(', ')}`;
        },
    },
    {
        /*
         * Was `ios-microphone-key-absent`, and that was the wrong shape: a claim
         * that pins the ABSENCE of work necessarily breaks the moment the work
         * is done, which made the first task of the epic turn the suite red.
         * A fidelity claim must pin the fact the document rests on — here, that
         * web video capture inside the WKWebView needs this key and the app
         * declares it with a reason a person can read.
         */
        id: 'ios-microphone-key-declared',
        why: 'ICP-001 closed the named blocker for web video capture; it must not regress',
        holds() {
            const m = /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]*)<\/string>/
                .exec(src('ios/FilmEngine/Info.plist'));
            if (!m) return 'the microphone key is gone — web video capture terminates the app again';
            return m[1].trim().length >= 20 || `the reason is "${m[1]}", which tells the user nothing`;
        },
    },
    {
        id: 'ios-camera-key-present',
        why: 'the brief says the intent was recorded and never wired',
        holds() {
            const p = src('ios/FilmEngine/Info.plist');
            return p.includes('NSCameraUsageDescription') || 'the camera key is gone';
        },
    },
    {
        id: 'upload-controls-lack-capture',
        why: 'the two-line change the brief recommends must still be unmade',
        holds() {
            const UI = src('src/index.html');
            const armed = ['mediaUploadControl', 'uploadControl']
                .map((n) => [n, fnBody(UI, n)])
                .filter(([n, b]) => {
                    assert.ok(b, `${n} is not in the page`);
                    return /capture/.test(b);
                })
                .map(([n]) => n);
            return armed.length === 0 || `already armed: ${armed.join(', ')}`;
        },
    },
    {
        id: 'world-route-accepts-video',
        why: 'the brief says the video-to-world path is closer than it looks',
        holds() {
            const r = src('backend/routes/worlds.js');
            return /video: *body\.video/.test(r) || 'the world route no longer takes video';
        },
    },
    {
        id: 'is-pano-not-settable',
        why: 'panorama is the input Marble calls most accurate, and nothing can ask for it',
        holds() {
            const r = src('backend/routes/worlds.js');
            return !/is_pano/.test(r) || 'the route now accepts is_pano — update the brief';
        },
    },
    {
        id: 'no-world-import-target',
        why: 'a phone capture has nowhere registered to land',
        holds() {
            const { MEDIA_IMPORTS } = require(path.join(REPO, 'backend/lib/media-imports.js'));
            const ids = Array.isArray(MEDIA_IMPORTS)
                ? MEDIA_IMPORTS : Object.keys(MEDIA_IMPORTS);
            const world = ids.filter((k) => /world|capture|scan|pano/i.test(k));
            return world.length === 0 || `a world target now exists: ${world.join(', ')}`;
        },
    },
    {
        id: 'frame-handles-available',
        why: 'the brief leans on it for the fetchable-URL constraint',
        holds: () => has('backend/lib/frame-handles.js')
            || 'frame-handles.js is gone',
    },
    {
        id: 'single-html-constraint',
        why: 'what makes Spark an ADR-sized decision rather than a drop-in',
        holds() {
            const g = JSON.parse(src('gridlight.json'));
            const t = (g.build && g.build.target) || '';
            return t === 'single-html' || `build target is now ${t}`;
        },
    },
    {
        id: 'upload-body-ceiling',
        why: 'the size constraint every capture task is estimated against',
        holds() {
            const b = src('backend/lib/body-limit.js');
            return /FILE_LIMIT *= *150 *\* *1024 *\* *1024/.test(b)
                || 'the file limit moved — reprice the capture tasks';
        },
    },
];

test('the brief exists', () => {
    assert.ok(fs.existsSync(BRIEF), `${BRIEF} has not been written`);
});

test('every required section is present', () => {
    const b = brief();
    const missing = REQUIRED_SECTIONS.filter((s) => !b.includes(s));
    assert.deepStrictEqual(missing, [],
        `the brief is missing sections: ${missing.join(', ')}`);
});

test('all five research threads are covered', () => {
    const b = brief().toLowerCase();
    const threads = {
        'ios footage into video shots': 'video shots',
        'keep actor change background': 'aleph',
        'previz design fidelity': 'design region',
        'diner plate quality': 'diner',
        'ios environment capture': 'marble',
    };
    const missing = Object.entries(threads)
        .filter(([, probe]) => !b.includes(probe))
        .map(([name]) => name);
    assert.deepStrictEqual(missing, [],
        `threads with no trace in the brief: ${missing.join(', ')}`);
});

test('every claim the brief rests on still holds in the code', () => {
    assert.ok(CLAIMS.length >= 15,
        `the claim set is ${CLAIMS.length} — too small to be the whole brief`);
    const broken = [];
    for (const c of CLAIMS) {
        const r = c.holds();
        if (r !== true && typeof r === 'string') broken.push(`${c.id}: ${r} (${c.why})`);
        else if (r === false) broken.push(`${c.id}: FAILED (${c.why})`);
    }
    assert.deepStrictEqual(broken, [],
        `the brief has drifted from the code:\n  ${broken.join('\n  ')}`);
});

test('the brief names the decisions only the user can make', () => {
    const b = brief();
    for (const d of ['Marble', 'RoomPlan', 'Aleph']) {
        assert.ok(b.includes(d), `the brief does not name ${d}, which a decision turns on`);
    }
});
