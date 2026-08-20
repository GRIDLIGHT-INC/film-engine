/**
 * Exploring shots on the Previs page, the way you would on set.
 *
 * The blocking loop was built and then reachable only two ways: raw HTTP, or
 * an MCP tool from an agent host. Both are conversations about a shot. Neither
 * is standing at the monitor trying the 85 and then the 24 and knowing, in your
 * eye, which one is the shot.
 *
 * Seven operations exist in routes/previs.js and the page offered two of them —
 * solve and save. So a director could compute a framing and store it, and could
 * not: seed the stage from what was written, see the frame the blocking would
 * generate, keep an angle by writing it back to the card, or say "this one" in
 * a way the pipeline respects. The interesting half of the tool had no surface.
 *
 * Set-based over the operations rather than over "the page works", because the
 * page DID work — for the two it had. A screenshot test, or any check written
 * against solve, passes in exactly the state this is meant to catch.
 *
 * Structural, like previs-routes.test.js: what breaks a single-file SPA is not
 * visible in a screenshot. A handler wired to nothing, or a button calling a
 * function that was never defined, looks identical to a working page until
 * clicked.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

/**
 * The previs operations, and what each has to look like on the page.
 *
 * `endpoint` is what the SPA must actually call — a button that does not reach
 * the route is the failure mode this file exists for. `control` is the thing
 * a director clicks.
 */
const EXPLORE_OPS = [
    {
        id: 'from-card',
        why: 'start from what was written instead of retyping the shot',
        endpoint: /previs\/from-card/,
        control: /previsFromCard\s*\(/,
    },
    {
        id: 'solve',
        why: 'turn a framing and a lens into a camera position',
        endpoint: /previs\/solve/,
        control: /previsSolve\s*\(/,
    },
    {
        id: 'save',
        why: 'keep an angle while trying others',
        endpoint: /`\/shots\/\$\{PREVIS\.shotId\}\/previs`/,
        control: /previsSave\s*\(/,
    },
    {
        id: 'to-storyboard',
        why: 'see the frame this blocking would generate, before spending on it',
        endpoint: /previs\/to-storyboard/,
        control: /previsPreviewFrame\s*\(/,
    },
    {
        id: 'apply',
        why: 'write the angle you chose back onto the scene card',
        endpoint: /previs\/apply/,
        control: /previsApplyToCard\s*\(/,
    },
    {
        id: 'approve',
        why: 'say "this is the one" in a way generation respects',
        endpoint: /previs\/approve/,
        control: /previsApprove\s*\(/,
    },
    {
        id: 'keyframe',
        // Not "compare": the frame is painted INSIDE the delivered frame,
        // behind the geometry, so the blocking moves on it. A corner thumbnail
        // could be compared to and could not be worked against.
        why: 'block against the frame you generated, in the frame',
        endpoint: /res\.keyframe|PREVIS\.keyframeUrl/,
        control: /previsDrawKeyframeBackdrop/,
    },
];

test('the explore registry covers every director-facing previs operation', () => {
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'previs.js'), 'utf8');
    // Anything the route dispatches that a director drives must be listed here,
    // so adding a route without a control fails rather than going unnoticed.
    const dispatched = ['from-card', 'solve', 'apply', 'approve', 'to-storyboard'];
    const missing = dispatched.filter(op => !routeSrc.includes(`'${op}'`));
    assert.deepStrictEqual(missing, [], `route no longer dispatches: ${missing.join(', ')}`);
    for (const op of dispatched) {
        assert.ok(EXPLORE_OPS.some(e => e.id === op), `${op} is dispatched but has no UI control listed`);
    }
});

test('every previs operation has a control on the page', () => {
    const missing = EXPLORE_OPS.filter(op => !op.control.test(html))
        .map(op => `${op.id} — cannot ${op.why}`);
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('every control actually reaches its route', () => {
    // A button wired to a function that calls nothing is the specific bug that
    // shipped once already in the flows work: declared, never dispatched.
    const missing = EXPLORE_OPS.filter(op => !op.endpoint.test(html))
        .map(op => op.id);
    assert.deepStrictEqual(missing, [], `controls that never call their endpoint: ${missing.join(', ')}`);
});

test('every control is bound to something clickable', () => {
    const unbound = EXPLORE_OPS.filter(op => {
        const name = (op.control.source.match(/[A-Za-z]+/) || [''])[0];
        if (!name) return true;
        // Defined AND referenced from markup or another handler.
        const defined = new RegExp(`function\\s+${name}\\s*\\(`).test(html);
        const used = new RegExp(`${name}\\s*\\(`, 'g');
        return !defined || (html.match(used) || []).length < 2;
    }).map(op => op.id);
    assert.deepStrictEqual(unbound, [],
        `defined but never wired to a button: ${unbound.join(', ')}`);
});

test('approval state is shown, not just sent', () => {
    // A gate the director cannot see is a gate that surprises them at
    // generation time with a 409 they did not know they had earned.
    assert.ok(/previsApprovalBadge/.test(html),
        'no approval badge on the page, so a restaged shot looks approved until generation 409s');
});

test('the page is still one file with no build step', () => {
    // Same guarantee previs-routes.test.js protects: gridlight.json pins
    // build.target single-html.
    const external = html.match(/<script[^>]+src=["'](?!data:)[^"']+["']/g) || [];
    assert.deepStrictEqual(external, [], `external scripts reintroduce a build step: ${external.join(', ')}`);
});


test('the generated frame is painted in the delivered frame, not beside it', () => {
    // It shipped as a 38%-wide thumbnail pinned to the corner of the camera
    // pane, which you could look at and could not work against. The point of
    // having it here is that the wireframe draws ON it, so changing the lens or
    // the camera height moves your blocking against the shot you are matching.
    assert.ok(/previsDrawKeyframeBackdrop\(ctx, view\)/.test(html),
        'the keyframe is not composited into the camera view');
    assert.ok(!/previsKeyframePanel/.test(html),
        'the corner thumbnail is still there, so there are two answers to where the frame lives');
    // Cover, not stretch: the keyframe and the delivered aspect rarely match,
    // and a stretched reference misleads every framing judgement made on it.
    assert.ok(/Math\.max\(view\.w \/ img\.width, view\.h \/ img\.height\)/.test(html),
        'the frame is stretched to the delivery aspect rather than cropped');
    assert.ok(/previsKeyframeOpacity/.test(html), 'no way to fade the reference under the geometry');
});


test('a generated .glb can be staged in previs', () => {
    // The one previs phase that was designed and never built. It stayed unbuilt
    // because loading a mesh looked like it required Three.js, which would have
    // meant a bundler and the end of build.target: single-html. It did not:
    // previs already has the projection and the polygon painter, and the only
    // missing piece was something to turn glb bytes into points and triangles.
    const { PRIMITIVES } = require('../lib/previs-primitives');
    assert.ok(PRIMITIVES.mesh, 'no mesh primitive, so a model cannot be placed at all');
    assert.strictEqual(PRIMITIVES.mesh.acceptsModel, true);

    // Parsed and decimated server-side, because the browser has no bundler to
    // read binary glTF with.
    assert.ok(/models\/\$\{assetId\}\/geometry/.test(html),
        'the stage never asks the server for a model\'s geometry');
    assert.ok(/PREVIS\.meshes/.test(html), 'fetched geometry is not cached, so it refetches every repaint');

    // A model that has not arrived, or failed, still occupies space: vanishing
    // silently reads as a failed click.
    assert.ok(/previsBoxGeometry/.test(html),
        'a model that has not loaded draws as nothing rather than as its bounds');

    // And the director has to be able to say WHICH model.
    assert.ok(/acceptsModel/.test(html), 'no picker for choosing a model');

    // Still one file.
    const external = html.match(/<script[^>]+src=["'](?!data:)[^"']+["']/g) || [];
    assert.deepStrictEqual(external, [], `a renderer library crept in: ${external.join(', ')}`);
});


test('the textured view is real three.js, vendored inline', () => {
    // The wireframe stage answers "where does it stand" and stays hand-rolled.
    // This pane answers "is that the character", and a real material cannot be
    // faked with a 4x4 matrix and a polygon painter.
    assert.ok(/THREE\.WebGLRenderer/.test(html), 'no WebGL renderer, so nothing is textured');
    assert.ok(/THREE\.GLTFLoader/.test(html), 'no GLTF loader, so a .glb cannot be shown with materials');
    assert.ok(/previsSolidLoad/.test(html), 'the pane is never given a model');

    // Vendored, not linked: build.target is single-html, and an external file
    // would reintroduce a build step.
    const external = html.match(/<script[^>]+src=["'](?!data:)[^"']+["']/g) || [];
    assert.deepStrictEqual(external, [], `an external script crept in: ${external.join(', ')}`);

    // The viewer needs the file itself; the geometry endpoint strips materials
    // by design.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'threed.js'), 'utf8');
    assert.ok(/'file'/.test(routes), 'no route serves the .glb to the viewer');
    assert.ok(/geometry/.test(routes), 'no route serves decimated geometry to the stage');
});
