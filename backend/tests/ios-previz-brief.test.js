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
            /*
             * A CALL, not the WORD. `UI.includes('cinematography')` matched the
             * `cinematography_ai` FLAG KEY the moment ICP-017 wired it, and
             * reported the page as already calling a route it does not call —
             * the same looseness that once matched `gridlight-client` in an
             * import for a column named `client`. A route is reached by being
             * fetched.
             */
            const reached = ['camera/propose', 'camera/explore', 'shots/cinematography']
                .filter((k) => new RegExp(`api\\([^)]*${k.replace('/', '\\/')}`).test(UI));
            return reached.length === 0 || `page already calls: ${reached.join(', ')}`;
        },
    },
    {
        /* Was `world-subflags-unread`, which asserted that NO flag was read —
         * true when the brief was written and false the moment ICP-017 landed,
         * so a fidelity test failed for the work SUCCEEDING. It pins the
         * outcome instead: every sub-flag gates a region of the design. */
        id: 'world-subflags-read-and-gating',
        why: 'ICP-017 closed the gap the brief recorded; a flag gating nothing has reopened it',
        holds() {
            const UI = src('src/index.html');
            const S = src('backend/routes/app-settings.js');
            const flags = ['marble_generation', 'cinematography_ai', 'reference_match',
                'camera_explore', 'world_splats'];
            const declared = flags.filter((f) => S.includes(f));
            assert.deepStrictEqual(declared, flags, 'a flag left app-settings');
            const map = /const WORLD_FLAG_REGIONS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(UI);
            if (!map) return 'the page declares no flag-to-region map, so no flag gates anything';
            const ungated = flags.filter((f) => !new RegExp(`${f}\\s*:`).test(map[1]));
            return ungated.length === 0 || `these flags gate nothing: ${ungated.join(', ')}`;
        },
    },
    {
        id: 'meshy-cannot-reach-location-floor',
        why: 'the derivable form of the diner-plate resolution finding',
        holds() {
            // The module's own value: the floor is now the house plate standard
            // (lib/image-standard.js), so a literal in the source is not where it lives.
            const floor = Number(require('../lib/reference-plates').LOCATION_MIN_EDGE);
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
        /*
         * Was `no-video-to-video-model`, the sixth claim in this epic to pin the
         * ABSENCE of work. It now pins what ICP-012 delivered — and pins it
         * against the CONTRACT ICP-011 recorded from Runway's own spec, not a
         * list typed here, because the epic's own constraints section is wrong
         * about this endpoint.
         */
        id: 'video-to-video-registered',
        why: 'ICP-012 gave the engine its first video-to-video path; losing it re-breaks background replacement',
        holds() {
            const runway = require(path.join(REPO, 'backend/lib/providers/runway'));
            const c = JSON.parse(fs.readFileSync(
                path.join(REPO, 'backend/tests/fixtures/aleph-contract.json'), 'utf8'));
            const e = runway.RUNWAY_VIDEO_MODELS[c.schema.model];
            if (!e) return `${c.schema.model} has left RUNWAY_VIDEO_MODELS`;
            if (e.endpoint !== 'video_to_video') return 'the model no longer declares video_to_video';
            const req = runway.buildVideoRequest({
                model: c.schema.model, videoUri: 'https://x/c.mp4', promptText: 'x',
            });
            return /\/video_to_video$/.test(req.url)
                || `an aleph request now goes to ${req.url}`;
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
        /*
         * Was a claim that both controls LACKED capture. Same wrong shape as
         * ios-mic-key-absent: it pinned the absence of work, so ICP-002 landing
         * would have turned the suite red — and worse, once the builders called
         * a `shootControl` helper the word `capture` left their bodies, so the
         * old claim went VACUOUS rather than failing. It now pins the outcome,
         * by running the builder rather than reading it.
         */
        id: 'upload-controls-offer-capture',
        why: 'ICP-002 armed them; the shoot affordance must not regress',
        holds() {
            const page = src('src/index.html');
            const grab = (n) => {
                const at = page.indexOf(`function ${n}(`);
                if (at < 0) return null;
                let d = 0;
                for (let i = page.indexOf('{', at); i < page.length; i++) {
                    if (page[i] === '{') d++;
                    else if (page[i] === '}' && --d === 0) return page.slice(at, i + 1);
                }
                return null;
            };
            /*
             * The named five are a STARTING POINT; anything else they reach
             * for is resolved by following the ReferenceError. A fixed list is
             * correct only until the page gains one more helper, and then this
             * claim fails as "the builder is gone" — blaming the page for the
             * extraction. Four files in this codebase learned it at once.
             */
            const need = new Set(['esc', 'captureFor', 'shootControl', 'uploadControl',
                                  'mediaUploadControl']);
            let b = null;
            for (let i = 0; i < 40; i++) {
                const parts = [...need].map(grab);
                if (parts.some((x) => !x)) return 'an upload builder or its capture helper is gone';
                try {
                    // eslint-disable-next-line no-new-func
                    b = new Function(`${parts.join('\n')}; return { uploadControl, mediaUploadControl };`)();
                    b.uploadControl('character-plate', '/x', {});
                    break;
                } catch (err) {
                    const m = /(\w+) is not defined/.exec(err.message);
                    if (m && grab(m[1]) && !need.has(m[1])) { need.add(m[1]); continue; }
                    return `the upload builder could not be run: ${err.message}`;
                }
            }
            const armed = (html) => /<input\b[^>]*\bcapture=/.test(html)
                && /<input\b(?![^>]*\bcapture=)[^>]*>/.test(html);
            if (!armed(b.uploadControl('character-plate', '/x', {}))) {
                return 'the plate control no longer offers both an upload and a shoot';
            }
            if (!armed(b.mediaUploadControl('video', 'video', 'shot', 's1', {}))) {
                return 'the media control no longer offers both an upload and a shoot';
            }
            return true;
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
        /*
         * Was `is-pano-not-settable`, the fifth claim in this epic to pin the
         * ABSENCE of work. It now pins the outcome, and pins it against the
         * RECORDED contract rather than a list typed here — ICP-004 established
         * that Marble accepts 'auto', True or False, and a domain invented in a
         * test is one that drifts from the provider silently.
         */
        id: 'is-pano-settable',
        why: 'ICP-006 made the panorama flag reachable; a caller must still be able to set it',
        holds() {
            const wl = require(path.join(REPO, 'backend/lib/providers/worldlabs'));
            if (!Array.isArray(wl.PANO_VALUES)) return 'the adapter no longer declares the is_pano domain';
            const one = wl.buildWorldPrompt({ images: [{ uri: 'https://x/a.jpg' }], is_pano: false });
            if (one.prompt.is_pano !== false) {
                return 'a caller can no longer ask for is_pano:false — a falsy default is eating it';
            }
            return /is_pano:\s*body\.is_pano/.test(src('backend/routes/worlds.js'))
                || 'the generate route no longer forwards is_pano';
        },
    },
    {
        /*
         * Was `no-world-import-target`, pinning the ABSENCE of the thing ICP-005
         * builds — the fourth claim of that shape in this epic. It now pins what
         * the task delivered: one target accepting all three media a capture
         * arrives as, because three separate targets would mean three routes and
         * three controls to keep in step.
         */
        id: 'world-import-target-registered',
        why: 'ICP-005 registered it; a capture with nowhere to land reaches no world',
        holds() {
            const { MEDIA_IMPORTS } = require(path.join(REPO, 'backend/lib/media-imports'));
            const spec = MEDIA_IMPORTS['world-capture'];
            if (!spec) return 'world-capture has left MEDIA_IMPORTS';
            const missing = ['image', 'video', 'model'].filter((k) => !(spec.kinds || []).includes(k));
            return missing.length === 0
                || `the capture target no longer accepts: ${missing.join(', ')}`;
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
