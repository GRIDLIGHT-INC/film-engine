/**
 * PREVIS SHOWS THE SHOT'S STORYBOARD FRAME AS WELL AS THE 3D SET.
 *
 * "In previz we should be able to look at the 2D storyboard shot if there is
 * one or the 3D previz set." The console's view switch is Shot (the set from
 * the camera), Board (the frame the board shows for this shot) and Plan. The
 * frame can also be laid over the set at half strength. A shot with no set
 * opens on its board; a shot with no frame cannot pick Board.
 *
 * Executed, not grepped: the page's own functions run against a fake WORLD.
 */

const test = require('node:test');
const assert = require('node:assert');
const { UI, declSource } = require('./console-render');

function load(world) {
    const names = ['PV_MODES', 'PV_MODE_NOTES', 'worldBoardSrc', 'worldViewMode', 'worldModeButtonsHtml',
        'worldOverlayMenuHtml', 'worldOverlays', 'worldToggleBoardOnion'];
    const src = names.map(n => {
        const s = declSource(n);
        assert.ok(s, `${n} is gone from the page`);
        return s;
    }).join('\n');
    const frame = { classes: new Set(), classList: { toggle(c, on) { on ? frame.classes.add(c) : frame.classes.delete(c); } } };
    const doc = { getElementById: id => (id === 'weFrame' ? frame : null) };
    const fn = new Function('WORLD', 'SPLAT', 'document', `
        const API_BASE = 'http://api'; const worldFlagOn = () => true; const esc = s => String(s == null ? '' : s);
        ${src}
        return { worldBoardSrc, worldViewMode, worldModeButtonsHtml, worldOverlayMenuHtml, worldToggleBoardOnion, PV_MODES, PV_MODE_NOTES };`);
    return { api: fn(world, { info: null }, doc), frame };
}

const KEY = { src: '/film/storyboards/p1/1A.png?v=4' };

test('Board is a view, with a note that says what it is', () => {
    const { api } = load({ blocking: { keyframe: KEY }, version: { id: 'v' } });
    assert.ok(api.PV_MODES.some(m => m.id === 'board'), 'no board mode');
    assert.match(api.PV_MODE_NOTES.board, /STORYBOARD FRAME/);
});

test('the switch offers Shot, Board and Plan; Board picks the board', () => {
    const W = { blocking: { keyframe: KEY }, version: { id: 'v' }, viewMode: 'board' };
    const { api } = load(W);
    const html = api.worldModeButtonsHtml();
    for (const label of ['Shot', 'Board', 'Plan']) assert.ok(html.includes(`>${label}</button>`), `no ${label}`);
    assert.match(html, /worldSetViewMode\('board'\)/);
    assert.match(html, /active[^>]*\s+onclick="worldSetViewMode\('board'\)"/, 'Board is not marked active in board mode');
    assert.strictEqual(api.worldBoardSrc(), 'http://api/film/storyboards/p1/1A.png?v=4', 'the frame URL is not the server one');
});

test('a shot with no set opens on its board; a shot with a set opens on the set', () => {
    assert.strictEqual(load({ blocking: { keyframe: KEY }, version: null }).api.worldViewMode(), 'board');
    assert.notStrictEqual(load({ blocking: { keyframe: KEY }, version: { id: 'v' } }).api.worldViewMode(), 'board');
});

test('with no storyboard frame, Board is disabled with why, and a board mode left over falls back', () => {
    const { api } = load({ blocking: { keyframe: null }, version: { id: 'v' }, viewMode: 'board' });
    assert.notStrictEqual(api.worldViewMode(), 'board', 'a shot with no frame stayed on an empty board');
    assert.match(api.worldModeButtonsHtml(), /disabled title="This shot has no storyboard frame yet"[^>]*\s+onclick="worldSetViewMode\('board'\)"/);
    assert.match(api.worldOverlayMenuHtml(), /no storyboard frame yet/);
});

test('with no set, Shot is disabled with why', () => {
    const html = load({ blocking: { keyframe: KEY }, version: null }).api.worldModeButtonsHtml();
    assert.match(html, /disabled title="This shot is not in a 3D set yet[^"]*"[^>]*\s+onclick="worldSetViewMode\('look'\)"/);
});

test('the frame can be laid over the set, and the toggle reaches the frame', () => {
    const W = { blocking: { keyframe: KEY }, version: { id: 'v' }, viewMode: 'look' };
    const { api, frame } = load(W);
    assert.match(api.worldOverlayMenuHtml(), /Board over the shot/);
    api.worldToggleBoardOnion();
    assert.ok(frame.classes.has('pv-onion'), 'turning it on did not mark the frame');
    api.worldToggleBoardOnion();
    assert.ok(!frame.classes.has('pv-onion'));
});

test('the frame picture is in the console markup and styled for both uses', () => {
    assert.match(UI, /<img class="pv-board-img" id="pvBoardImg"/);
    assert.match(UI, /\.pv-frame\.pv-mode-board \.pv-board-img \{[^}]*display:block/);
    assert.match(UI, /\.pv-frame\.pv-onion \.pv-board-img \{[^}]*opacity:0\.45/);
    assert.match(UI, /\.pv-mode-board \{/);
});
