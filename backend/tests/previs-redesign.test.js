/**
 * The approved Previs redesign keeps the shot large and moves the full toolset
 * into a top bar, an in-view tool rail, a compact move dock and a More menu.
 * These assertions execute the console template so controls cannot merely
 * exist in dead source.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { renderConsole } = require('./console-render');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const ON = { world_engine: true, previs_console: true, cinematography_ai: true,
    camera_explore: true, reference_match: true, marble_generation: true, world_splats: true };

test('Previs renders the approved view-first regions and keeps every tool reachable', () => {
    const html = renderConsole(ON);
    for (const cls of ['pv-topbar', 'pv-toolrail', 'pv-view', 'pv-inspector', 'pv-movedock', 'pv-more-menu']) {
        assert.match(html, new RegExp(`class="[^"]*${cls}`), `${cls} is missing from the rendered console`);
    }
    for (const label of ['Select', 'Walk', 'People', 'Edit set', 'Lights']) {
        assert.match(html, new RegExp(`>${label}<`), `${label} is missing from the in-view tool rail`);
    }
    for (const label of ['Render the frame', 'Match a reference', 'Risk check', 'Build or rebuild the set',
        'Other versions of this set', 'New world', 'Handover to the crew', 'Export previz video']) {
        assert.match(html, new RegExp(`>${label}<`), `${label} is missing from More`);
    }
});

test('the move starts as a compact dock and can open the full timeline drawer', () => {
    const html = renderConsole(ON);
    assert.match(html, /worldToggleTimeline\(\)/, 'the Timeline control has no open/close action');
    assert.match(html, />Timeline</, 'the compact dock has no Timeline button');
    assert.match(PAGE, /WORLD\.timelineOpen/, 'timeline open state is not modelled');
    assert.match(PAGE, /pv-timeline-open/, 'the open timeline has no layout state');
});

test('the redesign has a deliberate phone layout instead of desktop overflow', () => {
    assert.match(PAGE, /@media \(max-width:\s*720px\)[\s\S]*?\.pv-topbar/, 'no phone rule for the new top bar');
    assert.match(PAGE, /@media \(max-width:\s*720px\)[\s\S]*?\.pv-inspector/, 'no phone rule for the inspector');
    assert.match(PAGE, /@media \(max-width:\s*720px\)[\s\S]*?\.pv-toolrail/, 'no phone rule for the tool rail');
});
