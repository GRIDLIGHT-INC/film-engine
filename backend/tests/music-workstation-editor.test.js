const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * THE NATIVE MULTITRACK EDITOR: EVERY FIELD THE CONTRACT VALIDATES HAS A
 * CONTROL, AND EVERY CONTROL WRITES BACK.
 *
 * MUS-007. The score session had a route (MUS-004) and thirty tools (MUS-005)
 * and no page: every track, clip, range and marker could be written by an
 * agent and by curl and by nobody at a keyboard. `manual-edit.test.js` cannot
 * see the gap — it derives editable fields from handlers that read `body.x`,
 * and this route goes through validators — so the denominator here is the
 * validators themselves: the value keys each one returns are exactly the
 * fields the database will take, and each must have a control on the
 * workstation that saves through the route.
 *
 * Set-based over the contract's tables and over the workstation's jobs, since
 * the failure would be partial: a track mixer that saves gain and drops pan,
 * an emotion lane that draws ranges and edits none.
 *
 * There is no jsdom here (ADR-002), so page helpers are EXECUTED from their
 * own source where the check is behavioural — an enum picker fed the real
 * VOCABULARY, the mix arithmetic fed real tracks — and the rest is bound to
 * function bodies by brace depth, never a character window.
 */

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const contracts = require('../lib/music-session');
const { CHILD_KINDS } = require('../routes/music-sessions');
const { NAV_FLOW, phaseOf } = require('../lib/nav-flow');

const PAGE = 'musicws';

/** A function's whole body, by brace depth from its declaration. */
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('{', m.index), depth = 0;
    for (let j = i; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
/** A top-level `const NAME = …;` — an arrow helper or a declared registry. */
function constSource(name) {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(SPA);
    if (!m) return null;
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) {
        const ch = SPA[j];
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}

/*
 * Line-based, because a `/*` inside a string opens a comment that runs to the
 * next `*​/` — and the import control's accept="audio/*" is exactly that, so a
 * block-comment regex ate the session selector and reported it missing.
 * Every comment in this page is a whole-line one.
 */
const strip = s => s.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

/** Every `mw*` function the page declares — the workstation's whole surface. */
function workstationFunctions() {
    const names = [...new Set(['loadMusicWorkstation', ...[...SPA.matchAll(/(?:async\s+)?function\s+(mw[A-Z][\w$]*)\s*\(/g)].map(m => m[1])])];
    assert.ok(names.length >= 10, `only ${names.length} mw* functions found — the workstation is not on the page`);
    return names;
}
const workstationSource = () => workstationFunctions().map(fnSource).join('\n');

// ── The page exists everywhere a page has to ───────────────────────────────

test('the workstation is a page: menu, panel, loader, and one group on both copies of the map', () => {
    assert.ok(new RegExp(`data-page="${PAGE}"`).test(SPA), 'no nav button');
    assert.ok(new RegExp(`id="page-${PAGE}"`).test(SPA), 'no page panel');
    const loaders = fnSource('navigateTo');
    assert.ok(loaders && new RegExp(`\\b${PAGE}\\s*:\\s*load\\w+`).test(loaders), 'nothing registered to fill the page');
    assert.strictEqual(phaseOf(PAGE), 'production', 'the server map does not place the workstation in Production');
    const mirror = /pages\s*:\s*\[([^\]]*)\]/g;
    const groups = [...SPA.matchAll(/\{\s*id\s*:\s*'(\w+)'[^}]*pages\s*:\s*\[([^\]]*)\]/g)].map(m => [m[1], m[2]]);
    const prod = groups.find(g => g[0] === 'production');
    assert.ok(prod && prod[1].includes(`'${PAGE}'`), 'the page\'s own copy of the menu does not carry the workstation');
    assert.deepStrictEqual(prod[1].match(/'(\w+)'/g).map(s => s.replace(/'/g, '')), NAV_FLOW.production.pages, 'the two copies of the Production group differ');
    void mirror;
});

// ── Every validated field has a control that saves ─────────────────────────

/** The fields each validator returns: the database's own field set, derived. */
const SEEDS = { film_music_clips: { duration_ms: 1000 }, film_music_emotion_ranges: { end_ms: 1000 } };
function fieldsOf(table) {
    const v = contracts.VALIDATORS[table](SEEDS[table] || {});
    assert.ok(v.ok, `${table}: the seed does not validate: ${JSON.stringify(v.errors)}`);
    return Object.keys(v.value);
}

/**
 * The inspector and the lane heads, EXECUTED over a fixture session with one
 * row of every kind. The controls are built as `data-mw="${table}:${field}"`
 * at run time, so a grep for the literal reports a working editor as broken
 * — the same reason the blocking panels are executed rather than grepped.
 */
function renderedControls() {
    const parts = ['mwInspectorHtml', 'mwControl', 'mwEnumOptions', 'mwFindRow', 'mwTakeGroupHtml', 'mwTrackOfAutomation',
        'mwTime', 'mwStatusHtml', 'mwTrackHtml', 'mwClipHtml', 'mwEmotionHtml',
        'mwInstrumentControl', 'mwTrackPlayHtml', 'mwTrackDetailsHtml', 'mwTrackSections',
        'mwPartPaneHtml', 'mwRollHtml', 'mwNotesOf', 'mwRollRange', 'mwTempoBpm', 'mwSnapMs',
        'mwLengthMs', 'mwHeard'].map(n => {
        const f = fnSource(n); assert.ok(f, `no ${n} on the page`); return f;
    });
    // The roll is built from declared registries and arrow helpers too.
    for (const n of ['MW_TRACK_TABS', 'MW_ROW_H', 'MW_BLACK', 'MW_PITCH_NAMES', 'mwPitchName', 'mwSnap']) {
        const c = constSource(n); assert.ok(c, `no ${n} on the page`); parts.push(c);
    }
    const kindTable = /const MW_KIND_TABLE = \{[^}]*\};/.exec(SPA);
    assert.ok(kindTable, 'no MW_KIND_TABLE');
    const track = { id: 'T1', name: 'cello', role_kind: 'instrument', role: 'cello', sort_order: 0, color: '#ff0000', gain_db: 0, pan: 0, muted: false, soloed: false, output_track_id: null,
        instrument_id: 'I1', notes: { program: 42, drums: false, notes: [{ start_ms: 0, duration_ms: 500, pitch: 60, velocity: 100 }] },
        clips: [{ id: 'C1', name: 'take 1', asset_id: 'A1', source_operation_id: null, source_kind: 'imported', start_ms: 0, duration_ms: 1000, source_offset_ms: 0, gain_db: 0, fade_in_ms: 0, fade_out_ms: 0, loop_policy: 'none', warp_policy: 'none', take_group: 'g', take_status: 'selected' }],
        automation: [{ id: 'U1', clip_id: null, parameter: 'gain', interpolation: 'linear', points: [] }] };
    const model = {
        session: { id: 'S1', name: 'S', status: 'draft', sample_rate: 48000, frame_rate: 24, sequence_id: null, scene_id: null, script_id: null, notes: '', tempo_map: [] },
        tracks: [track],
        markers: [{ id: 'M1', kind: 'hit', position_ms: 10, label: 'hit', shot_id: null }],
        emotion_ranges: [{ id: 'E1', start_ms: 0, end_ms: 500, label: 'dread', valence: -0.5, arousal: 0.5, intensity: 0.5, source: 'ai_proposal', status: 'proposed', confidence: 0.8 }],
        operations: [], duration_ms: 1000, warnings: [],
    };
    const sandbox = `
        function esc(s) { return String(s === undefined || s === null ? '' : s); }
        const mwX = ms => Math.round((Number(ms) || 0) / 1000 * 40);
        ${kindTable[0]}
        const MW = { model: ${JSON.stringify(model)}, session: ${JSON.stringify(model.session)}, brief: null, selection: null, playheadMs: 0,
            instruments: [{ id: 'I1', name: 'Vortex Bells', library: 'Ethereal Earth', available: true }], instrumentsError: null, rendering: null,
            // A track is edited UNDER ITS LANE, so the audit reads it there:
            // the side inspector no longer carries a track's controls at all.
            open: { T1: true }, tab: {}, rollSel: null, snapDiv: 2, audition: null,
            vocab: { vocabulary: ${JSON.stringify(contracts.VOCABULARY)}, ranges: ${JSON.stringify(contracts.RANGES)}, transitions: ${JSON.stringify(contracts.TRANSITIONS)} } };
        ${parts.join('\n')}
        const out = {};
        for (const kind of ['session', 'tracks', 'clips', 'markers', 'emotion-ranges', 'automation']) {
            const id = { session: 'S1', tracks: 'T1', clips: 'C1', markers: 'M1', 'emotion-ranges': 'E1', automation: 'U1' }[kind];
            MW.selection = { kind, id };
            out[kind] = mwInspectorHtml();
        }
        out.lanes = mwTrackHtml(MW.model.tracks[0]) + mwStatusHtml(MW.session) + mwEmotionHtml(MW.model);
        return out;`;
    // eslint-disable-next-line no-new-func
    return new Function(sandbox)();
}

test('every field every validator accepts has a control on the workstation, per table', () => {
    const rendered = renderedControls();
    const all = Object.values(rendered).join('\n');
    const controls = new Set([...all.matchAll(/data-mw="([^"]+)"/g)].map(m => m[1]));
    assert.ok(controls.size >= 20, `only ${controls.size} controls rendered — the inspector is not being executed`);
    const tables = [...Object.values(CHILD_KINDS).map(k => k.table), 'film_music_sessions'];
    const missing = [];
    for (const table of tables) {
        for (const field of fieldsOf(table)) {
            if (!controls.has(`${table}:${field}`)) missing.push(`${table}.${field}`);
        }
    }
    assert.deepStrictEqual(missing, [], `these fields the route accepts have no control a person can operate:\n  ${missing.join('\n  ')}`);
    // And every rendered control is bound to the change handler, or it is decoration.
    for (const m of all.matchAll(/<(input|select|textarea|button)[^>]*data-mw="[^"]+"[^>]*>/g)) {
        assert.match(m[0], /mwFieldChanged\(this\)/, `a control is not wired to the autosave: ${m[0].slice(0, 120)}`);
    }
});

test('every child kind can be created and deleted from the page, and every control saves through the route', () => {
    const src = strip(workstationSource());
    const rendered = renderedControls();
    const all = Object.values(rendered).join('\n') + src;
    for (const kind of Object.keys(CHILD_KINDS)) {
        assert.ok(all.includes(`data-mw-create="${kind}"`), `nothing on the page creates a ${kind} row`);
        assert.ok(rendered[kind].includes(`data-mw-delete="${kind}"`), `the ${kind} inspector offers no delete`);
    }
    // One save path: a control's change reaches mwSave, and mwSave PUTs the
    // child through the session route with the value the control holds.
    const save = strip(fnSource('mwSave') || '');
    assert.match(save, /music-sessions\/\$\{[^}]+\}\/\$\{[^}]+\}\/\$\{[^}]+\}/, 'mwSave does not PUT /music-sessions/:id/:kind/:childId');
    assert.match(save, /method:\s*'PUT'/, 'mwSave is not a PUT');
    assert.match(save, /Save failed|could not be saved/i, 'a failed autosave says nothing');
    const change = strip(fnSource('mwFieldChanged') || '');
    assert.match(change, /mwSave\(/, 'a changed control does not reach the autosave');
    assert.match(change, /data-mw|dataset\.mw/, 'the change handler does not read which field changed');
});

// ── Enums come from the served vocabulary, never a second list ─────────────

test('an enum control offers exactly the vocabulary the database enforces', () => {
    const src = fnSource('mwEnumOptions');
    assert.ok(src, 'no mwEnumOptions');
    // eslint-disable-next-line no-new-func
    const fn = new Function(`function esc(s){return String(s);} ${src}; return mwEnumOptions;`)();
    for (const [key, values] of Object.entries(contracts.VOCABULARY)) {
        const [table, column] = key.split('.');
        if (column === 'muted' || column === 'soloed' || table === 'film_music_operations' || column === 'sample_rate') continue;
        const html = fn(table, column, values[0], contracts.VOCABULARY);
        const offered = [...html.matchAll(/value="([^"]*)"/g)].map(m => m[1]);
        assert.deepStrictEqual(offered, values, `${key}: the picker offers ${offered.join(',')} against the contract's ${values.join(',')}`);
        assert.match(html, new RegExp(`value="${values[0]}"[^>]*selected`), `${key}: the current value is not selected`);
    }
    // And no enum list is typed into the page beside the served one.
    for (const [key, values] of Object.entries(contracts.VOCABULARY)) {
        if (values.length < 4 || typeof values[0] !== 'string') continue;
        const literal = values.map(v => `'${v}'`).join(',\\s*');
        assert.ok(!new RegExp(literal).test(workstationSource()), `${key}'s vocabulary is typed into the workstation as a second copy`);
    }
});

// ── The mix: mute, solo, gain, pan and fades reach what is heard ───────────

test('mute, solo, gain and pan decide what a clip plays at, and a fade is a ramp inside the clip', () => {
    const src = fnSource('mwClipLevel');
    assert.ok(src, 'no mwClipLevel');
    // eslint-disable-next-line no-new-func
    const level = new Function(`${src}; return mwClipLevel;`)();
    const t = (o) => ({ id: 't1', gain_db: 0, pan: 0, muted: false, soloed: false, ...o });
    const c = (o) => ({ gain_db: 0, fade_in_ms: 0, fade_out_ms: 0, duration_ms: 4000, ...o });
    assert.strictEqual(level(t(), c(), [t()]).gain, 1, 'unity is not 1');
    assert.strictEqual(level(t({ muted: true }), c(), [t({ muted: true })]).gain, 0, 'a muted track is heard');
    assert.strictEqual(level(t(), c(), [t(), t({ id: 't2', soloed: true })]).gain, 0, 'a track is heard while another is soloed');
    assert.ok(level(t({ soloed: true }), c(), [t({ soloed: true }), t({ id: 't2' })]).gain > 0, 'the soloed track itself is silent');
    assert.ok(Math.abs(level(t({ gain_db: -6 }), c(), [t({ gain_db: -6 })]).gain - 0.501) < 0.01, '-6 dB is not half amplitude');
    assert.ok(Math.abs(level(t({ gain_db: -6 }), c({ gain_db: -6 }), [t({ gain_db: -6 })]).gain - 0.251) < 0.01, 'track and clip gain do not sum');
    assert.strictEqual(level(t({ pan: -1 }), c(), [t({ pan: -1 })]).pan, -1, 'pan does not reach the clip');
    const f = level(t(), c({ fade_in_ms: 500, fade_out_ms: 1000 }), [t()]);
    assert.deepStrictEqual([f.fade_in_s, f.fade_out_s], [0.5, 1], 'fades are not in seconds inside the clip');
});

test('playback never generates or spends: no workstation function reaches a paid endpoint', () => {
    const src = strip(workstationSource());
    assert.ok(!/\/generate\b|\/regenerate\b|gen\.|flow_run|\/run\b/.test(src), 'the workstation reaches a generating endpoint');
    const play = fnSource('mwPlay');
    assert.ok(play, 'no mwPlay');
    assert.match(play, /AudioContext/, 'playback does not use the audio graph the mix needs');
    assert.match(strip(play), /source_offset_ms/, 'playback ignores where in the file a clip starts');
    assert.match(strip(play), /loop_policy/, 'playback ignores the loop policy');
});

// ── Waveforms, ruler, markers, emotion lane, drift, context ────────────────

test('a clip on a lane carries the waveform canvas the sound library already paints', () => {
    const lane = fnSource('mwClipHtml');
    assert.ok(lane, 'no mwClipHtml');
    assert.match(lane, /canvas class="snd-wave" data-asset=/, 'a clip has no waveform canvas');
    const render = strip(fnSource('mwRender') || '');
    assert.match(render, /paintWaveforms\(/, 'the render never paints the waveforms it drew canvases for');
});

test('the ruler is shared: shot boundaries from the brief, hit markers from the session, one playhead', () => {
    const ruler = strip(fnSource('mwRulerHtml') || '');
    assert.ok(ruler, 'no mwRulerHtml');
    assert.match(ruler, /picture|shots/, 'the ruler does not draw the shots');
    assert.match(ruler, /markers/, 'the ruler does not draw the markers');
    assert.match(ruler, /mwSeek\(/, 'clicking the ruler does not move the playhead');
    const seek = strip(fnSource('mwSeek') || '');
    assert.match(seek, /playheadMs|playhead_ms/, 'mwSeek moves no playhead');
});

test('the emotion lane is editable and a proposal is accepted by a person, never by the lane', () => {
    const lane = strip(fnSource('mwEmotionHtml') || '');
    assert.ok(lane, 'no mwEmotionHtml');
    assert.match(lane, /emotion_ranges/, 'the lane does not read the ranges');
    assert.match(lane, /mwSelect\(\s*'emotion-ranges'/, 'a range cannot be opened for editing');
    const rendered = renderedControls();
    assert.ok(/data-mw="film_music_emotion_ranges:status"/.test(rendered['emotion-ranges']), 'a range\'s status (proposed → accepted) has no control');
    assert.match(rendered['emotion-ranges'], /value="proposed"[^>]*selected/, 'the range is not shown as the proposal it is');
    const src = strip(workstationSource());
    assert.ok(!/status:\s*'accepted'/.test(src), 'the page accepts a proposal on its own');
});

test('drift is shown with the rebase beside it, and the brief is shown as the context panel', () => {
    const load = strip(fnSource('mwLoadSession') || '');
    assert.ok(load, 'no mwLoadSession');
    assert.match(load, /\/drift/, 'the loader never asks whether the session drifted');
    assert.match(load, /\/brief/, 'the loader never reads the brief');
    const drift = strip(fnSource('mwDriftHtml') || '');
    assert.match(drift, /drifted/, 'the banner does not read the drift verdict');
    assert.match(drift, /mwRebase\(/, 'the banner offers no rebase');
    const ctx = strip(fnSource('mwContextHtml') || '');
    for (const field of ['shots', 'screenplay', 'characters', 'cues', 'emotion']) {
        assert.match(ctx, new RegExp(`\\b${field}\\b`), `the context panel does not show the brief's ${field}`);
    }
});

// ── Aligned import by drag and drop ─────────────────────────────────────────

test('dropping files imports them aligned at the playhead through the stems route, refusing oversize files first', () => {
    const imp = strip(fnSource('mwImportFiles') || '');
    assert.ok(imp, 'no mwImportFiles');
    assert.match(imp, /\/stems/, 'the drop does not reach the stem importer');
    assert.match(imp, /start_ms/, 'the import does not align at a start');
    assert.match(imp, /normalize_48k/, 'the 48 kHz working copy cannot be asked for');
    assert.match(imp, /checkUploadSize\(/, 'an oversize stem is sent and refused as a dead server');
    assert.match(imp, /readAsDataURL|data:/, 'files are not read as data URIs');
    assert.match(imp, /\.files\s*(?:&&|\[)/, 'the importer does not read the dropped files');
    const root = strip(workstationSource());
    assert.match(root, /ondrop=|addEventListener\('drop'/, 'nothing on the page accepts a drop');
});

// ── Session lifecycle and selection ────────────────────────────────────────

test('a session can be chosen, created, and moved through its lifecycle from the page', () => {
    const src = strip(workstationSource());
    assert.match(src, /music-sessions\?|\/music-sessions'|\/music-sessions`/, 'the page never lists sessions');
    assert.match(src, /mwCreateSession\(/, 'a session cannot be created');
    const status = strip(fnSource('mwStatusHtml') || '');
    assert.match(status, /TRANSITIONS|transitions|next/, 'the lifecycle control does not read the allowed moves');
    assert.match(renderedControls().lanes, /data-mw="film_music_sessions:status"/, 'the status has no control');
});

test('the workstation loader survives a session that will not load, and says so on the page', () => {
    const load = fnSource('mwLoadSession');
    assert.match(load, /catch/, 'a failed load leaves the page as it was');
    assert.match(strip(load), /innerHTML\s*=/, 'the failure is not written where the session would have been');
});
