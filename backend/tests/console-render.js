/**
 * RENDER THE WORLD ENGINE CONSOLE, FOR TESTS THAT ASK WHERE THINGS ARE.
 *
 * There is no jsdom and no bundler here (ADR-002), so a rendered-DOM assertion
 * is unavailable. What is available is better than a source scan: the console
 * is a pure template function, so this EXECUTES it and hands back the HTML it
 * actually produces. A region omitted at runtime — because its flag is off, or
 * because it was never built — is genuinely absent from that string, which a
 * source scan cannot tell.
 *
 * ONE MODULE RATHER THAN A COPY PER TEST. Two resolvers is exactly how one of
 * them acquires const support and the other keeps reporting a working console
 * as broken — which is what happened the moment the flag map was added: the
 * placement test's own copy followed functions only and died on
 * `WORLD_FLAG_REGIONS is not defined`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

/** A top-level declaration in the page, bounded by brace/paren depth. */
function declSource(name) {
    for (const start of [`function ${name}(`, `const ${name} =`, `let ${name} =`]) {
        const at = UI.indexOf(start);
        if (at < 0) continue;
        if (start.startsWith('function')) {
            let depth = 0;
            for (let i = UI.indexOf('{', at); i < UI.length; i++) {
                if (UI[i] === '{') depth++;
                else if (UI[i] === '}' && --depth === 0) return UI.slice(at, i + 1);
            }
            return null;
        }
        /*
         * A const runs to the semicolon at depth zero. Stopping at the first
         * semicolon is wrong the moment the value is an object or a call
         * containing one — `Object.freeze({ a: 1 })` has none inside it today
         * and would the day somebody adds a function member.
         */
        let depth = 0;
        for (let i = at; i < UI.length; i++) {
            const c = UI[i];
            if (c === '{' || c === '(' || c === '[') depth++;
            else if (c === '}' || c === ')' || c === ']') depth--;
            else if (c === ';' && depth === 0) return UI.slice(at, i + 1);
        }
        return null;
    }
    return null;
}

/**
 * The console's HTML, with a chosen set of world flags on.
 *
 * The dependency closure is resolved by FOLLOWING ReferenceErrors rather than
 * by a hand-written list: a list goes stale the first time the console reaches
 * for one more helper, and the failure then reads as the console being broken.
 */
function renderConsole(flags) {
    const need = new Set(['worldConsoleHtml']);
    const pre = `const WORLD_FLAGS = ${JSON.stringify(flags || {})};`
        + 'const WORLD = { overlays:null, lens:35, mode:"keep", pinned:null, world:null, '
        + 'version:null, move:null, moves:[] }; const esc = s => String(s == null ? "" : s);';
    for (let i = 0; i < 60; i++) {
        const src = [...need].map(declSource).filter(Boolean).join('\n');
        try {
            return new Function(`${pre}\n${src}\nreturn worldConsoleHtml(`
                + '{ id:"p1", aspect_ratio:"16:9" }, { name:"Maple Street", locked:0 }, { version:3 });')();
        } catch (err) {
            const m = /(\w+) is not defined/.exec(err.message);
            if (m && declSource(m[1]) && !need.has(m[1])) { need.add(m[1]); continue; }
            throw new Error(`the console could not be rendered: ${err.message}`);
        }
    }
    throw new Error('the console has more than 60 dependencies; the resolver gave up');
}

module.exports = { UI, ROOT, declSource, renderConsole };
