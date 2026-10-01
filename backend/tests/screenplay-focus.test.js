/**
 * Distraction-free writing, and the typewriter.
 *
 *   - focus mode lifts the editor's own container over the page and hides the
 *     app's chrome; it beats the inline position the gutter sets; Esc,
 *     Ctrl+Shift+F, leaving full screen and leaving the page all end it;
 *   - the typewriter is EXECUTED against a fake Web Audio: a letter, the
 *     space bar, Backspace and Enter each make a sound (Enter rings the bell),
 *     a shortcut or an arrow makes none, and it is silent when switched off;
 *   - it only listens: nothing in it writes the screenplay.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function fnSrc(name) {
    const i = HTML.indexOf(`function ${name}(`);
    assert.ok(i > 0, `${name} missing`);
    let j = HTML.indexOf(')', i); j = HTML.indexOf('{', j);
    for (let d = 0, k = j; k < HTML.length; k++) {
        if (HTML[k] === '{') d++;
        else if (HTML[k] === '}' && --d === 0) return HTML.slice(i, k + 1);
    }
    return '';
}

/** The typewriter in a sandbox with a fake audio engine that counts what it makes. */
function sandbox(prefOn) {
    const made = { oscillators: [], bursts: 0 };
    class Node { connect(n) { return n || this; } }
    class Param { setValueAtTime() {} exponentialRampToValueAtTime() {} set value(v) { this.v = v; } }
    class Osc extends Node { constructor() { super(); this.frequency = new Param(); } start() { made.oscillators.push(this.frequency.v); } stop() {} }
    class Src extends Node { start() { made.bursts++; } stop() {} }
    class Ctx {
        constructor() { this.sampleRate = 8000; this.currentTime = 1; this.state = 'running'; this.destination = new Node(); }
        createBuffer(c, len) { return { getChannelData: () => new Float32Array(len) }; }
        createBufferSource() { return new Src(); }
        createBiquadFilter() { const f = new Node(); f.frequency = new Param(); f.Q = new Param(); return f; }
        createGain() { const g = new Node(); g.gain = new Param(); return g; }
        createOscillator() { return new Osc(); }
        resume() {}
    }
    const store = { sp_typewriter: prefOn ? '1' : '0' };
    const ctx = {
        window: {}, Math, setTimeout: () => {},
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
        document: { body: { classList: { contains: () => false } }, getElementById: () => null },
    };
    ctx.window.AudioContext = Ctx;
    vm.createContext(ctx);
    const tw = HTML.slice(HTML.indexOf('const TYPEWRITER = {'), HTML.indexOf('function twBurst('));
    vm.runInContext(tw.replace('const TYPEWRITER', 'var TYPEWRITER') + fnSrc('twBurst') + fnSrc('twThump') + fnSrc('twBell')
        + fnSrc('typewriterKey') + 'function focusWordCount(){}', ctx);
    const press = (key, mods = {}) => { ctx.TYPEWRITER.last = -1; ctx.typewriterKey({ key, ...mods }); };
    return { made, press, ctx };
}

test('every kind of key makes its own sound; shortcuts and arrows make none', () => {
    const { made, press } = sandbox(true);
    press('a');
    assert.ok(made.bursts >= 1 && made.oscillators.length >= 1, 'a letter is the type bar and the platen');
    const before = { b: made.bursts, o: made.oscillators.length };
    press(' ');
    assert.ok(made.oscillators.length > before.o, 'the space bar is a thump');
    press('Backspace');
    const bell = made.oscillators.length;
    press('Enter');
    assert.ok(made.oscillators.slice(bell).includes(2093), 'Enter does not ring the bell');
    const quiet = { b: made.bursts, o: made.oscillators.length };
    press('s', { metaKey: true }); press('z', { ctrlKey: true }); press('ArrowLeft'); press('Shift');
    assert.deepEqual({ b: made.bursts, o: made.oscillators.length }, quiet, 'a shortcut or an arrow made a sound');
});

test('switched off, the typewriter is silent', () => {
    const { made, press } = sandbox(false);
    press('a'); press('Enter');
    assert.equal(made.bursts + made.oscillators.length, 0);
});

test('focus mode covers the page, hides the chrome, and every way out ends it', () => {
    assert.ok(/body\.sp-focus #editorViewContainer \{[^}]*position: fixed !important/.test(HTML),
        'the editor is not lifted over the page, or loses to the gutter\'s inline position');
    assert.ok(/body\.sp-focus \.fe-top, body\.sp-focus \.fe-panel, body\.sp-focus #statusBar \{ display: none !important; \}/.test(HTML),
        'the app\'s chrome is not hidden');
    assert.ok(/onclick="toggleWriterFocus\(\)"/.test(HTML), 'no Focus button');
    assert.ok(/onclick="toggleTypewriterSound\(\)"/.test(HTML), 'no Typewriter switch');
    const key = fnSrc('onEditorKeydown');
    assert.ok(/'Escape'[\s\S]*toggleWriterFocus\(false\)/.test(key), 'Esc does not leave focus');
    assert.ok(/shiftKey[\s\S]*'f'[\s\S]*toggleWriterFocus\(\)/.test(key), 'Ctrl+Shift+F does not toggle focus');
    assert.ok(/typewriterKey\(event\)/.test(key), 'the editor does not sound its keys');
    assert.ok(/fullscreenchange[\s\S]{0,200}toggleWriterFocus\(false\)/.test(HTML), 'leaving full screen leaves focus');
    assert.ok(/sp-focus[\s\S]{0,120}toggleWriterFocus\(false\)/.test(fnSrc('navigateTo')), 'another page keeps the chrome hidden');
});

test('the typewriter only listens: nothing in it writes the screenplay', () => {
    for (const name of ['typewriterKey', 'toggleTypewriterSound', 'toggleWriterFocus', 'twBurst', 'twThump', 'twBell']) {
        const src = fnSrc(name);
        assert.ok(!/innerHTML\s*=|insertAdjacent|execCommand|normalizeEditor|appendChild|\.textContent\s*=/.test(src),
            `${name} writes to the page`);
    }
});
