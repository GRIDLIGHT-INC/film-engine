/**
 * The Marble request this engine would actually send
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `backend/spike-world.js` answers the three unknowns that decide the World
 * Engine overhaul, and it costs ~$0.20 to run. This pins the parts that can be
 * checked without spending anything: the request shape against World Labs'
 * documented contract, and the compass→azimuth mapping.
 *
 * The mapping is the reusable finding, not an implementation detail. Marble's
 * Direction Control takes up to FOUR images each tagged with an azimuth
 * documented as 0/90/180/270 for front/right/back/left — and Film Engine's
 * compass sweep produces exactly four direction-named plates of one location,
 * at one aspect ratio, because a plate carries no information about what is
 * behind its own camera. North is the plate the others turn from, so north is
 * front. Getting that backwards would build every world facing the wrong way,
 * and nothing downstream would say so.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPIKE = fs.readFileSync(path.join(__dirname, '..', 'spike-world.js'), 'utf8');

test('the compass maps onto Marble azimuths, north as front', () => {
    const m = /const AZIMUTH = \{([^}]*)\}/.exec(SPIKE);
    assert.ok(m, 'the compass mapping is gone');
    const map = {};
    for (const pair of m[1].matchAll(/'?([a-z]*)'?\s*:\s*(\d+)/g)) map[pair[1]] = Number(pair[2]);

    // Documented: 0/90/180/270 = front/right/back/left.
    assert.strictEqual(map.north, 0, 'north is the plate the others turn from, so it is front (0)');
    assert.strictEqual(map.east, 90, 'east is a quarter turn right of north');
    assert.strictEqual(map.south, 180, 'south is the reverse of north');
    assert.strictEqual(map.west, 270, 'west is a quarter turn left of north');
    assert.strictEqual(map[''], 0, 'a view-less plate is the default and reads as front');

    const angles = Object.values(map);
    assert.ok(angles.every(a => [0, 90, 180, 270].includes(a)),
        `an azimuth outside the documented set: ${angles.join(', ')}`);
});

test('it sends no more images than Direction Control accepts', () => {
    assert.match(SPIKE, /slice\(0, 4\)/,
        'Direction Control takes at most four images; sending more is a refusal that costs a request');
});

test('the request matches the documented contract', () => {
    // Endpoint, auth header and polling, exactly as documented.
    assert.match(SPIKE, /\/marble\/v1\/worlds:generate/, 'wrong generate endpoint');
    assert.match(SPIKE, /\/marble\/v1\/operations\//, 'does not poll the operation');
    assert.match(SPIKE, /'WLT-Api-Key'/, 'wrong auth header');

    // The three documented world_prompt shapes it can build.
    assert.match(SPIKE, /type: 'multi-image'[\s\S]{0,200}multi_image_prompt/,
        'multi-image prompt is not built as documented');
    assert.match(SPIKE, /type: 'image'[\s\S]{0,120}image_prompt/,
        'single-image prompt is not built as documented');
    // Base64 is a documented media source, which is why no upload step is needed.
    assert.match(SPIKE, /source: 'data_base64'[\s\S]{0,120}extension/,
        'media reference is not the documented base64 shape');
});

test('the key never has a default and is never printed', () => {
    assert.ok(!/WORLDLABS_API_KEY\s*\|\|\s*['"][^'"]/.test(SPIKE),
        'a hardcoded fallback key');
    const printsKey = /console\.log\([^)]*key\(\)/.test(SPIKE);
    assert.ok(!printsKey, 'the key is printed to stdout');
});

test('a dry run spends nothing', () => {
    // The dry-run branch must return BEFORE the generate call, or "--dry-run"
    // is a promise the script does not keep.
    const dryAt = SPIKE.indexOf('DRY RUN');
    const callAt = SPIKE.indexOf("call('/marble/v1/worlds:generate'");
    assert.ok(dryAt > -1 && callAt > -1, 'dry run or generate call is gone');
    assert.ok(dryAt < callAt, 'the dry run does not return before the request that spends');
    assert.match(SPIKE.slice(dryAt, callAt), /return;/, 'the dry-run branch falls through to the spend');
});

test('it reports the extent, which is the whole point', () => {
    /*
     * Bound to the REPORTING block, not the whole file: "EXTENT" also appears
     * in the header comment explaining why the spike exists, so a file-wide
     * match stayed green with the reported line deleted.
     */
    const report = SPIKE.slice(SPIKE.indexOf('THE THREE ANSWERS'));
    assert.ok(report.length > 200, 'the answers block is gone');
    assert.match(report, /EXTENT/, 'the extent is computed and never reported');
    assert.match(report, /geo\.size|bounds/, 'the reported extent does not come from the parsed geometry');
    assert.match(SPIKE, /parseGlb/, 'the collider mesh is not measured with the existing parser');
    assert.match(SPIKE, /decimate\(geo, 20000\)/,
        'it does not check the mesh survives the stage budget it would be drawn at');
    assert.match(SPIKE, /uncalibrated|not promise metres/i,
        'it reports a size without saying the scale is uncalibrated, which would be a false measurement');
});
