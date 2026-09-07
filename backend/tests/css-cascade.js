/**
 * WHAT DOES THIS PROPERTY COMPUTE TO AT WIDTH W?
 *
 * There is no jsdom and no bundler here (ADR-002), so a rendered-DOM assertion
 * is unavailable and the alternative is grepping for a declaration — which
 * passes the moment one exists and says nothing about whether it WINS. That is
 * the bug mobile-shell shipped once: `.fe-burger { display:none }` written
 * AFTER the media query beat the query on source order, and a grep reported the
 * breakpoint as working.
 *
 * ONE EVALUATOR, NOT A COPY PER TEST. It lived inline in mobile-shell.test.js
 * and the console layout needs exactly the same question answered; a third copy
 * is where two of them come to disagree about `!important` or source order.
 */

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/*
 * Every real <style> block, comments stripped. Slicing one span from the first
 * <style> to the last </style> sweeps up the vendored three.js blob and the
 * page markup between them, so selectors arrive carrying HTML and `:root` never
 * matches `:root`.
 */
const CSS = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map(m => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/* ── a small cascade evaluator ───────────────────────────────────────────
 * Enough CSS to answer "what does this property compute to at width W":
 * media-query filtering, !important, and source order. Specificity is not
 * modelled because every selector this asks about is a single class.
 */
function parseRules(css) {
    const rules = [];
    // Walk top-level blocks, tracking @media nesting one level deep.
    const re = /@media([^{]+)\{|([^{}@]+)\{([^{}]*)\}|\}/g;
    let media = null, depth = 0, m;
    while ((m = re.exec(css))) {
        if (m[1] !== undefined) { media = m[1].trim(); depth = 1; continue; }
        if (m[0] === '}') { if (depth === 1) { media = null; depth = 0; } continue; }
        if (m[2] === undefined) continue;
        const selectors = m[2].split(',').map(s => s.trim()).filter(Boolean);
        const decls = [];
        for (const d of m[3].split(';')) {
            const i = d.indexOf(':');
            if (i < 0) continue;
            let value = d.slice(i + 1).trim();
            const important = /!important\s*$/.test(value);
            value = value.replace(/!important\s*$/, '').trim();
            if (!value) continue;
            decls.push({ prop: d.slice(0, i).trim(), value, important });
        }
        rules.push({ media, selectors, decls, order: rules.length });
    }
    return rules;
}

function mediaApplies(media, width) {
    if (!media) return true;
    if (/print/.test(media)) return false;
    const max = media.match(/max-width:\s*(\d+)px/);
    const min = media.match(/min-width:\s*(\d+)px/);
    if (max && width > Number(max[1])) return false;
    if (min && width < Number(min[1])) return false;
    return true;
}

const RULES = parseRules(CSS);

function declared(selector, prop, width) {
    let win = null;
    for (const r of RULES) {
        if (!mediaApplies(r.media, width)) continue;
        if (!r.selectors.includes(selector)) continue;
        for (const d of r.decls) {
            if (d.prop !== prop) continue;
            if (!win || d.important || (!win.important && !d.important)) {
                if (win && win.important && !d.important) continue;
                win = { ...d, order: r.order };
            }
        }
    }
    return win ? win.value : null;
}

function varValue(name, width) {
    // :root wins over html/body-scoped redefinitions of the same var here.
    return declared(':root', name, width);
}

/** Substitute var()s and evaluate a length expression to a number of px. */
function px(value, width, seen = 0) {
    if (value == null) return null;
    let v = String(value);
    while (/var\(\s*(--[\w-]+)\s*\)/.test(v)) {
        if (seen++ > 20) throw new Error('var() cycle in ' + value);
        v = v.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, n) => {
            const got = varValue(n, width);
            if (got == null) throw new Error('undefined var ' + n);
            return got;
        });
    }
    v = v.replace(/calc\(/g, '(')
        .replace(/(\d+(?:\.\d+)?)vw/g, (_, n) => String(Number(n) * width / 100))
        .replace(/px/g, '').trim();
    if (!/^[\d\s+\-*/().]+$/.test(v)) return NaN;   // not a plain length
    try {
        // eslint-disable-next-line no-new-func
        return Function('"use strict";return (' + v + ')')();
    } catch (_) {
        return NaN;   // a shorthand (`16px 14px 40px`), not one value
    }
}

module.exports = { CSS, RULES, parseRules, mediaApplies, declared, varValue, px };
