const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EPIC = path.join(REPO, 'docs', 'plans', 'ios-capture-and-previz-epic.md');

const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const has = (p) => fs.existsSync(path.join(REPO, p));
const epic = () => fs.readFileSync(EPIC, 'utf8');

/**
 * AN EPIC IS A REGISTRY, AND IT MUST BE HELD TO ITSELF AND TO THE CODE.
 *
 * Same reasoning as redo-between-frames-epic.test.js. Two independent ways this
 * document can be wrong, and both have been paid for here before:
 *
 *   1. It drifts from the code. Every number in it — 7 of 14 regions, 11 video
 *      models, a 150MB body ceiling — was measured. A task written against a
 *      fact that has since moved sends somebody to build the wrong thing.
 *   2. It is internally malformed. A task with no size, or a dependency naming
 *      a task that does not exist, reads as a plan and cannot be executed.
 *
 * Set-based over FOUR registries: the sections the template mandates, the tasks
 * the epic itself declares, the five milestones the user ratified, and the code
 * claims the tasks rest on. An example-based check passes on an epic with one
 * malformed row and one stale ceiling, which is exactly the state to catch.
 */

/** The eight sections this step's template mandates. */
const REQUIRED_SECTIONS = [
    'Overview',
    'Business Goals',
    'Current State',
    'Target State',
    'Constraints',
    'Task Breakdown',
    'Open Questions',
    'Success Metrics',
];

/**
 * The five milestones the user ratified by choosing "Follow the brief's order".
 * Each must be reachable in the epic — a sequence the user approved and the
 * epic silently drops a leg of is worse than no sequence.
 */
const RATIFIED = [
    { id: 'M1 capture unblock', probe: /NSMicrophoneUsageDescription/ },
    { id: 'M2 capture plumbing', probe: /is_pano/ },
    { id: 'M3 register Aleph', probe: /aleph2|Aleph/ },
    { id: 'M4 console wiring', probe: /Direct the Shot/ },
    { id: 'M5 Spark deferred behind an ADR', probe: /Spark/ },
];

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

function consoleSource(UI) {
    const names = [...UI.matchAll(/function (world[A-Za-z0-9_]*)\(/g)].map((m) => m[1]);
    assert.ok(names.length >= 20,
        `the world* builder scan found ${names.length} — the scan is broken, not the page`);
    return names.map((n) => fnBody(UI, n) || '').join('\n');
}

function designRegions(D) {
    const r = [...D.matchAll(/^### (.+)$/gm)].map((m) => m[1]).filter((x) => !/^Screen:/.test(x));
    assert.ok(r.length >= 10, `the design heading scan found ${r.length} — it is broken`);
    return r;
}

/** Claims the TASKS rest on. Each returns true when it holds, else a reason. */
const CLAIMS = [
    {
        id: 'console-short-of-design',
        why: 'Phase 4 exists because the console does not render every design region',
        holds() {
            const body = consoleSource(src('src/index.html'));
            const regions = designRegions(src('design_handoff_world_engine_previz/README.md'));
            const present = regions.filter((r) => {
                const k = r.replace(/ *\(.*\)| *—.*$/, '').replace(/^Modal: /, '').trim();
                return new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body);
            });
            return present.length < regions.length
                || `all ${regions.length} regions are now present — Phase 4 is moot`;
        },
    },
    {
        id: 'cinematography-backend-built',
        why: 'Phase 4 claims "no new backend"',
        holds() {
            const s = src('backend/lib/cinematography.js');
            const need = ['buildBrief', 'exploreBrief', 'validateProposal',
                'applyProposal', 'acceptCandidates', 'compareCameras'];
            const gone = need.filter((n) => !fnBody(s, n));
            return gone.length === 0 || `missing from cinematography.js: ${gone.join(', ')}`;
        },
    },
    {
        id: 'cinematography-unreached',
        why: 'the gap Phase 4 closes is a control, not a capability',
        holds() {
            const UI = src('src/index.html');
            /*
             * A CALL, not the WORD. `UI.includes('cinematography')` matched the
             * `cinematography_ai` FLAG KEY the moment ICP-017 wired it, and
             * reported the page as calling a route it does not call — the same
             * looseness that once matched `gridlight-client` in an import for a
             * column named `client`. A route is reached by being FETCHED.
             */
            const hit = ['camera/propose', 'camera/explore', 'shots/cinematography']
                .filter((k) => new RegExp(`api\\([^)]*${k.replace('/', '\\/')}`).test(UI));
            return hit.length === 0 || `the page already calls: ${hit.join(', ')}`;
        },
    },
    {
        /* Was `four-flags-live-and-unread`. Pinning a task as UNDONE makes the
         * epic's own task turn the suite red for SUCCEEDING, which is backwards
         * — the same reshape ios-mic-key-absent needed. It now pins what
         * ICP-017 delivered: every sub-flag gates a region, so the gap fails
         * here if it ever reopens. */
        id: 'sub-flags-gate-a-region',
        why: 'ICP-017 delivered it; a flag that gates nothing is declared and ignored again',
        holds() {
            const UI = src('src/index.html');
            const S = src('backend/routes/app-settings.js');
            const flags = ['marble_generation', 'cinematography_ai', 'reference_match',
                'camera_explore', 'world_splats'];
            const undeclared = flags.filter((f) => !S.includes(f));
            if (undeclared.length) return `left app-settings: ${undeclared.join(', ')}`;
            const map = /const WORLD_FLAG_REGIONS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(UI);
            if (!map) return 'the page declares no flag-to-region map, so no flag gates anything';
            const ungated = flags.filter((f) => !new RegExp(`${f}\\s*:`).test(map[1]));
            return ungated.length === 0 || `these flags gate nothing: ${ungated.join(', ')}`;
        },
    },
    {
        /* Was `ios-mic-key-absent`. Pinning a task as UNDONE makes the epic's own
         * first task turn the suite red, which is backwards — the claim now pins
         * what ICP-001 delivered, so a regression fails and progress does not. */
        id: 'ios-mic-key-declared',
        why: 'ICP-001 delivered it; losing it re-breaks web video capture',
        holds: () => src('ios/FilmEngine/Info.plist').includes('NSMicrophoneUsageDescription')
            || 'the microphone key is gone — ICP-001 has been reverted',
    },
    {
        id: 'ios-camera-key-present',
        why: 'the epic says the intent was recorded and never wired',
        holds: () => src('ios/FilmEngine/Info.plist').includes('NSCameraUsageDescription')
            || 'the camera key is gone',
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
        why: 'ICP-002 delivered the shoot affordance; losing it re-breaks phone capture',
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
            const parts = ['esc', 'captureFor', 'shootControl', 'uploadControl', 'mediaUploadControl'].map(grab);
            if (parts.some((x) => !x)) return 'an upload builder or its capture helper is gone';
            // eslint-disable-next-line no-new-func
            const b = new Function(`${parts.join('\n')}; return { uploadControl, mediaUploadControl };`)();
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
        id: 'ios-bundle-parity-enforced',
        why: 'ICP-002 must re-sync the bundled copy or ios-app.test.js fails',
        holds: () => has('backend/tests/ios-app.test.js') && has('ios/FilmEngine/Web/index.html')
            || 'the iOS bundle-parity guard is gone',
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
        id: 'world-route-takes-video',
        why: 'ICP-005 leans on this already working',
        holds: () => /video: *body\.video/.test(src('backend/routes/worlds.js'))
            || 'the world route no longer accepts video',
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
         * CORRECTED. The old claim asserted the adapter FLAGGED its video field
         * as guessed, and tested for the word "guess" appearing in the file —
         * which it did, inside a sentence saying the opposite: "read from the
         * API's own 422 rather than guessed". My research mis-read a wrapped
         * line and both documents inherited it. The real defect was subtler and
         * still worth ICP-004: the claim was true and RECORDED NOWHERE, so
         * nobody could re-check it. Now it pins the record instead.
         */
        id: 'marble-contract-recorded',
        why: 'ICP-004 verified the field names against the live API; the record must not go missing',
        holds() {
            const p = path.join(REPO, 'backend/tests/fixtures/marble-contract.json');
            if (!fs.existsSync(p)) return 'the Marble contract snapshot is gone';
            const c = JSON.parse(fs.readFileSync(p, 'utf8'));
            const video = (c.prompt_types || {}).video || {};
            if (!(video.fields || []).includes('video_prompt')) {
                return 'the snapshot no longer confirms world_prompt.video.video_prompt';
            }
            return /marble-contract\.json/.test(src('backend/lib/providers/worldlabs.js'))
                || 'the adapter no longer points at the record that proves its field name';
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
        id: 'runway-registry-is-the-target',
        why: 'ICP-008 adds a row to it',
        holds: () => /RUNWAY_VIDEO_MODELS *= *Object\.freeze/.test(src('backend/lib/providers/runway.js'))
            || 'RUNWAY_VIDEO_MODELS is no longer the registry',
    },
    {
        id: 'frame-handles-available',
        why: 'the fetchable-URL constraint is solved by it, not by new work',
        holds: () => has('backend/lib/frame-handles.js') || 'frame-handles.js is gone',
    },
    {
        id: 'meshy-cannot-reach-floor',
        why: 'ICP-006 moves the provider because of this',
        holds() {
            const floor = Number(/LOCATION_MIN_EDGE *= *(\d+)/.exec(src('backend/lib/reference-plates.js'))[1]);
            const cap = Number(/maxImagePixels: *(\d+)/.exec(src('backend/lib/providers/meshy.js'))[1]);
            return cap < floor || `meshy now reaches ${cap} against a floor of ${floor}`;
        },
    },
    {
        id: 'meshy-is-edit-mode',
        why: 'ICP-007 stops multi-view generation on an edit-mode provider',
        holds: () => /referenceMode: *'edit'/.test(src('backend/lib/providers/meshy.js'))
            || 'meshy is no longer edit-mode',
    },
    {
        id: 'body-ceiling',
        why: 'the size policy in ICP-004 is estimated against it',
        holds: () => /FILE_LIMIT *= *150 *\* *1024 *\* *1024/.test(src('backend/lib/body-limit.js'))
            || 'the file limit moved — reprice the capture tasks',
    },
    {
        id: 'single-html-constraint',
        why: 'why Spark is deferred behind an ADR rather than built',
        holds() {
            const t = (JSON.parse(src('gridlight.json')).build || {}).target;
            return t === 'single-html' || `build target is now ${t}`;
        },
    },
    {
        id: 'console-suite-is-behaviour-only',
        why: 'the placement-test constraint exists because of this',
        holds() {
            /*
             * COMMENTS STRIPPED FIRST. The bare word match fired on the word
             * "placement" inside a comment explaining that this file delegates
             * to the placement test's reader — reporting the constraint as
             * broken because it was being DESCRIBED. Third time in this
             * dispatch a word-match stood in for a real assertion; every
             * comment in these files is a whole-line one, so a line-based
             * strip never touches code.
             */
            const t = src('backend/tests/world-console.test.js').split('\n')
                .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
            return !/data-region|we-center|we-right|we-rail/i.test(t)
                || 'world-console.test.js now asserts placement — restate the constraint';
        },
    },
];

test('the epic exists', () => {
    assert.ok(fs.existsSync(EPIC), `no epic at ${path.relative(REPO, EPIC)}`);
});

test('every section the template mandates is present', () => {
    const e = epic();
    const missing = REQUIRED_SECTIONS.filter((s) => !e.includes(s));
    assert.deepStrictEqual(missing, [], `sections missing: ${missing.join(', ')}`);
});

test('Current State and Target State are real tables', () => {
    const e = epic();
    for (const h of ['Current State', 'Target State']) {
        const at = e.indexOf(`## ${h}`);
        assert.notStrictEqual(at, -1, `${h} is not a heading`);
        const block = e.slice(at, e.indexOf('\n## ', at + 4));
        const rows = block.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l));
        assert.ok(rows.length >= 6, `${h} has ${rows.length} table rows — too thin to be the real picture`);
    }
});

/* The tasks are the epic's OWN registry — read them out of it, never assume a count. */
test('every declared task is well formed and its dependencies resolve', () => {
    const e = epic();
    const phases = [...e.matchAll(/^### Phase \d+: (.+)$/gm)].map((m) => m[1]);
    assert.ok(phases.length >= 4, `only ${phases.length} phase(s); the ratified sequence has five legs`);

    const rows = [...e.matchAll(/^\|\s*(ICP-\d{3})\s*\|([^|]+)\|([^|]+)\|\s*([SML])\s*\|([^|]+)\|/gm)];

    /*
     * A malformed row simply stops matching and LEAVES the set rather than
     * failing it, so every assertion below would then hold over the rows that
     * happened to parse. Counting ids independently is what closes that.
     */
    const declared = [...e.matchAll(/^\|\s*(ICP-\d{3})\s*\|/gm)].map((m) => m[1]);
    assert.ok(declared.length >= 12, `only ${declared.length} tasks; this is not the whole epic`);
    assert.strictEqual(rows.length, declared.length,
        `${declared.length} rows declared, ${rows.length} parse — malformed: `
        + declared.filter((id) => !rows.some((r) => r[1] === id)).join(', '));

    const ids = rows.map((r) => r[1]);
    assert.deepStrictEqual(ids, [...new Set(ids)], 'duplicate task ids');

    for (const [, id, title, desc, size, deps] of rows) {
        assert.ok(title.trim().length > 3, `${id} has no title`);
        assert.ok(desc.trim().length > 30, `${id} has a description too thin to act on`);
        assert.ok(['S', 'M', 'L'].includes(size), `${id} has size "${size}"`);
        const d = deps.trim();
        assert.ok(d.length > 0, `${id} does not state its dependencies`);
        if (!/^none$/i.test(d)) {
            for (const dep of d.split(/[,+]/).map((x) => x.trim()).filter(Boolean)) {
                assert.ok(ids.includes(dep), `${id} depends on "${dep}", not a task in this epic`);
            }
        }
    }
});

test('the epic has no dependency cycle', () => {
    const e = epic();
    const rows = [...e.matchAll(/^\|\s*(ICP-\d{3})\s*\|[^|]+\|[^|]+\|\s*[SML]\s*\|([^|]+)\|/gm)];
    const dep = new Map(rows.map((r) => [r[1],
        /^none$/i.test(r[2].trim()) ? [] : r[2].split(/[,+]/).map((x) => x.trim()).filter(Boolean)]));
    const state = new Map();
    const walk = (n, trail) => {
        if (state.get(n) === 'done') return;
        assert.notStrictEqual(state.get(n), 'open', `dependency cycle: ${[...trail, n].join(' -> ')}`);
        state.set(n, 'open');
        for (const d of dep.get(n) || []) walk(d, [...trail, n]);
        state.set(n, 'done');
    };
    for (const n of dep.keys()) walk(n, []);
});

test('every milestone the user ratified is covered', () => {
    const e = epic();
    const missing = RATIFIED.filter((m) => !m.probe.test(e)).map((m) => m.id);
    assert.deepStrictEqual(missing, [],
        `the user approved a five-leg sequence; these legs are absent: ${missing.join(', ')}`);
});

test('every claim the epic rests on still holds in the code', () => {
    assert.ok(CLAIMS.length >= 18, `only ${CLAIMS.length} claims; this is not the real set`);
    const broken = [];
    for (const c of CLAIMS) {
        const r = c.holds();
        if (r !== true) broken.push(`${c.id}: ${r === false ? 'FAILED' : r} (${c.why})`);
    }
    assert.deepStrictEqual(broken, [], `the epic has drifted from the code:\n  - ${broken.join('\n  - ')}`);
});

/* The decisions that shape the work must be STATED, not merely true. */
test('the epic states the constraints that decide the design', () => {
    const e = epic();
    for (const [what, re] of [
        ['the placement-test rule', /placement/i],
        ['the two unverified provider contracts', /unverified|guessed/i],
        ['the base64 body ceiling', /150|112 ?MB/],
        ['the Marble 100MB video cap', /100 ?MB/],
        ['the Aleph duration window', /2[–-]30 ?s|2 to 30/],
        ['the Aleph price', /0\.28/],
        ['the 7-of-14 region measurement', /7 of 14|7\/14/],
        ['that capture precedes plates', /capture (?:comes )?(?:first|before)|before plates/i],
    ]) assert.match(e, re, `the epic never states ${what}`);
});

/* Questions the user's single selection did NOT settle must survive. */
test('the unsettled open questions are carried forward', () => {
    const e = epic();
    const at = e.indexOf('## Open Questions');
    assert.notStrictEqual(at, -1, 'no Open Questions section');
    const block = e.slice(at, e.indexOf('\n## ', at + 4) === -1 ? undefined : e.indexOf('\n## ', at + 4));
    for (const [what, re] of [
        ['Marble vs RoomPlan', /RoomPlan/i],
        ['capture size policy', /size polic|raw[- ]binary/i],
        ['the Spark ADR', /Spark/i],
        ['an Aleph cost gate', /cost gate|budget/i],
        ['the MCP database split', /MCP|FILM_DATA_DIR/],
    ]) assert.match(block, re, `Open Questions drops ${what}, which the user never settled`);
});
