/**
 * PGN-011 — the queue strip under the canvas.
 *
 * A collapsible strip over PGN-010's one queue read: every bucket, each item
 * clickable to pan to its node, "Collect" on a job a provider still holds, and
 * "Re-run" on a failed one — which goes through the node's own run, and so
 * through the one spend confirmation. Collapsed, it still says the counts.
 *
 * Set-based over the server's QUEUE_BUCKETS: the page labels exactly those,
 * and each bucket offers exactly its own actions. The renderer is executed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { QUEUE_BUCKETS } = require('../lib/generation-queue');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') parens++; else if (SPA[i] === ')' && --parens === 0) { i++; break; } }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) { if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1); }
    return null;
}
function constSource(name) {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(SPA);
    if (!m) return null;
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) {
        const ch = SPA[j];
        if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
function render() {
    for (const n of ['PG_QUEUE_LABELS', 'pgQueueHtml']) assert.ok(fnSource(n) || constSource(n), `the page has no ${n}`);
    return new Function(`const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
        const pgSrc = u => u; ${fnSource('pgThumb')} ${constSource('PG_QUEUE_LABELS')} ${fnSource('pgQueueHtml')}; return { pgQueueHtml, PG_QUEUE_LABELS };`)();
}

const item = (b, i) => ({ job_id: `${b}-${i}`, key: 'shot:s' + i, stage: 'video', provider: 'runway', capability: 'video',
    percent: b === 'running' ? 42 : null, phase: b === 'running' ? 'generating' : null,
    error: b === 'failed' ? 'declined by the provider' : null, thumb: i === 0 ? '/film/storyboards/p/1A.png' : null });
const full = () => {
    const q = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, [item(b, 0), item(b, 1)]]));
    q.counts = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, 2]));
    return q;
};
const label = key => 'Shot ' + key.slice(-2).toUpperCase();

test('the page labels exactly the server\'s buckets', () => {
    const { PG_QUEUE_LABELS } = render();
    assert.deepEqual(Object.keys(PG_QUEUE_LABELS).sort(), [...QUEUE_BUCKETS].sort());
});

test('open: every bucket shows its items, each clickable to its node, with only its own actions', () => {
    const { pgQueueHtml } = render();
    const html = pgQueueHtml(full(), true, label);
    for (const b of QUEUE_BUCKETS) {
        const section = html.split(`data-bucket="${b}"`)[1];
        assert.ok(section, `${b} is not drawn`);
        const own = section.split('data-bucket=')[0];
        assert.match(own, /pgQueueGo\('shot:s0'\)/, `${b}: an item does not pan to its node`);
        assert.equal(/pgQueueCollect\(/.test(own), b === 'awaiting_collection', `${b}: Collect offered where it should not be, or missing`);
        assert.equal(/pgQueueRerun\(/.test(own), b === 'failed', `${b}: Re-run offered where it should not be, or missing`);
    }
    assert.match(html, /42%/, 'a running item shows its percentage');
    assert.match(html, /declined by the provider/, 'a failed item shows why');
    assert.match(html, /1A\.png/, 'a thumbnail is drawn when there is one');
    assert.match(html, /Shot S0/, 'items are named by their node');
});

test('collapsed: the counts per bucket and a way to open it, nothing else', () => {
    const { pgQueueHtml } = render();
    const html = pgQueueHtml(full(), false, label);
    for (const b of QUEUE_BUCKETS) assert.ok(html.includes(`2`), b);
    assert.doesNotMatch(html, /pgQueueGo\(/, 'items are drawn while collapsed');
    assert.match(html, /pgToggleQueue\(\)/);
});

test('empty, and an item with no node: said plainly, and not clickable into nothing', () => {
    const { pgQueueHtml } = render();
    const empty = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, []]));
    empty.counts = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, 0]));
    assert.match(pgQueueHtml(empty, true, label), /nothing running/i);
    const loose = Object.assign({}, empty, { running: [{ job_id: 'j', key: null, provider: 'runway', percent: null }] });
    const html = pgQueueHtml(loose, true, label);
    assert.doesNotMatch(html, /pgQueueGo\(null|pgQueueGo\(''\)/);
    assert.match(html, /runway/);
    assert.equal(pgQueueHtml(null, true, label), '', 'no queue read yet draws nothing');
});

test('the strip is wired: a slot, loaded with the graph and on every poll, collect posts, re-run goes through the node\'s own run', () => {
    assert.match(SPA, /id="pgQueue"/, 'no strip slot');
    assert.match(fnSource('pgLoad'), /pgLoadQueue\(/, 'loading the graph does not load the queue');
    assert.match(fnSource('pgPollRunning'), /pgLoadQueue\(/, 'the poll does not refresh the queue');
    const load = fnSource('pgLoadQueue');
    assert.match(load, /production-graph\/queue/);
    const collect = fnSource('pgQueueCollect');
    assert.match(collect, /generation-jobs\/.*collect/);
    assert.match(collect, /method: 'POST'/);
    assert.match(fnSource('pgQueueRerun'), /pgRunNode\(/, 're-run bypasses the node\'s own run (and its confirmation)');
    assert.match(fnSource('pgQueueGo'), /pgPanTo\(/);
});
