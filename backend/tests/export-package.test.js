'use strict';

/**
 * -- Handing the film to somebody else ---------------------------------------
 *
 * An export references media by ABSOLUTE PATH. On the machine that made it,
 * that works and looks finished. Hand it to an editor -- a different Mac, a
 * shared drive, a zip -- and every clip is offline: the timeline opens, the
 * cuts are right, and there is no picture. That is the failure this pair
 * closes, and it is the same shape as everything else recorded here, in that
 * nothing errors.
 *
 * Two pieces, and the preflight matters more than the package:
 *
 *   preflight  what is wrong with this export BEFORE it is handed over
 *   package    the XML plus the media it names, with the paths rewritten
 *
 * The preflight exists because the first real project this was run against
 * exported ZERO clips -- every shot on it has duration_ms = 0, so shootableShots
 * disqualified all of them -- and the export was a perfectly well-formed file
 * describing nothing. A blank timeline is not something an editor can report
 * back usefully; it just looks like the tool does not work.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { preflightExport, packageExport, RELATIVE_MEDIA_DIR } = require('../lib/export-package');
const { AUDIO_LANES } = require('../lib/nle-export');

/** A temp media root with real files, so "missing on disk" means what it says. */
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-pkg-'));
    const media = path.join(root, 'media');
    fs.mkdirSync(media);
    const write = (name, bytes) => {
        const p = path.join(media, name);
        fs.writeFileSync(p, Buffer.alloc(bytes || 64, 1));
        return p;
    };
    return { root, media, write };
}

test('an export with no shootable shot is REFUSED, not handed over empty', () => {
    /*
     * The real case: every shot has duration_ms = 0, so the export is a
     * well-formed file with no clips in it. Silently handing that over is worse
     * than refusing, because the editor cannot tell an empty film from a broken
     * exporter.
     */
    const shots = [
        { id: 's1', shot_code: '1A', duration_ms: 0, scene_id: 'sc1' },
        { id: 's2', shot_code: '1B', duration_ms: 0, scene_id: 'sc1' },
    ];
    const out = preflightExport({ title: 'Empty' }, shots, [], {});
    assert.equal(out.ready, false, 'an export describing nothing was reported as ready');
    const blocking = out.blocking.map(b => b.code);
    assert.ok(blocking.includes('NO_SHOOTABLE_SHOTS'),
        `the empty export is not named as the blocker: ${JSON.stringify(out.blocking)}`);
    // And it says WHY, in terms of the thing the director can act on.
    assert.ok(/duration/i.test(out.blocking.find(b => b.code === 'NO_SHOOTABLE_SHOTS').detail),
        'the refusal does not say that the shots have no duration');
});

test('media named by the export but missing on disk blocks the handover', () => {
    const fx = fixture();
    const there = fx.write('1A.mp4', 128);
    const shots = [{ id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' }];
    const assets = [
        { id: 'v1', shot_id: 's1', asset_type: 'video_raw', file_path: there, file_name: '1A.mp4', duration_ms: 4000 },
        { id: 'd1', shot_id: 's1', asset_type: 'audio_dialogue',
          file_path: path.join(fx.media, 'gone.wav'), file_name: 'gone.wav', duration_ms: 4000 },
    ];
    const out = preflightExport({ title: 'Gap' }, shots, assets, {});
    assert.equal(out.ready, false, 'an export naming a file that is not there was reported as ready');
    const missing = out.blocking.find(b => b.code === 'MEDIA_MISSING');
    assert.ok(missing, 'a missing file is not reported as blocking');
    assert.ok(/gone\.wav/.test(JSON.stringify(missing)), 'the missing file is not named');
    assert.ok(!/1A\.mp4/.test(JSON.stringify(missing)), 'a file that IS there was reported missing');
});

test('an empty audio lane is a warning, never a blocker', () => {
    /*
     * AUDIO_LANES is the guarantee that every element leaves on its own track,
     * and a lane that is empty TODAY is where the sound pass lands tomorrow.
     * Blocking on it would make the export unusable for exactly the workflow it
     * exists to serve -- but saying nothing is how a missing bed reads as a
     * creative choice.
     */
    const fx = fixture();
    const p = fx.write('1A.mp4', 64);
    const shots = [{ id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' }];
    const assets = [{ id: 'v1', shot_id: 's1', asset_type: 'video_raw', file_path: p, file_name: '1A.mp4', duration_ms: 4000 }];
    const out = preflightExport({ title: 'Quiet' }, shots, assets, {});
    assert.equal(out.ready, true, 'an export with no audio yet was refused');
    const empty = out.warnings.filter(w => w.code === 'LANE_EMPTY').map(w => w.lane);
    assert.deepEqual(empty.sort(), AUDIO_LANES.map(l => l.type).sort(),
        'the empty lanes are not reported, or not all of them');
});

test('shots that will not reach the timeline at all are named', () => {
    /*
     * Measured on the real project: Wingfall reports READY with 13 shots and
     * TWO of them shootable, so the export is a two-clip film and the other
     * eleven vanish without a word. That is worse than the blocked case,
     * because it looks like it worked.
     *
     * A warning rather than a blocker: exporting the part of a film that
     * exists is a legitimate thing to do — it is how you cut as you go — but
     * it has to be said out loud.
     */
    const fx = fixture();
    const p = fx.write('1A.mp4', 64);
    const shots = [
        { id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' },
        { id: 's2', shot_code: '1B', duration_ms: 0, scene_id: 'sc1' },
        { id: 's3', shot_code: '1C', duration_ms: 0, scene_id: 'sc1' },
    ];
    const assets = [{ id: 'v1', shot_id: 's1', asset_type: 'video_raw', file_path: p,
                      file_name: '1A.mp4', duration_ms: 4000 }];
    const out = preflightExport({ title: 'Thin' }, shots, assets, {});
    assert.equal(out.ready, true, 'a partly-shot film cannot be exported at all');
    const dropped = out.warnings.find(w => w.code === 'SHOTS_DROPPED');
    assert.ok(dropped, 'eleven shots can vanish from an export with nothing said');
    assert.deepEqual(dropped.shots.sort(), ['1B', '1C'],
        'the dropped shots are not named — a count sends you to the database');
});

test('the package carries the media and the XML points at it relatively', async () => {
    /*
     * The whole point: absolute paths are what make a handed-over export open
     * with everything offline. After packaging, no path in the XML may leave
     * the folder.
     */
    const fx = fixture();
    const v = fx.write('1A.mp4', 256);
    const a = fx.write('scene1.mp3', 128);
    const shots = [{ id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' }];
    const assets = [
        { id: 'v1', shot_id: 's1', asset_type: 'video_raw', file_path: v, file_name: '1A.mp4', duration_ms: 4000 },
        { id: 'm1', shot_id: null, scene_id: 'sc1', asset_type: 'audio_music', file_path: a,
          file_name: 'scene1.mp3', duration_ms: 4000 },
    ];
    const dest = path.join(fx.root, 'out');
    const res = await packageExport({ title: 'Handover' }, shots, assets, { format: 'premiere', dest });

    assert.ok(fs.existsSync(res.xml_path), 'the package has no XML');
    const xml = fs.readFileSync(res.xml_path, 'utf8');
    const {pathToFileURL,fileURLToPath}=require('url');
    const refs=[...xml.matchAll(/<pathurl>([^<]+)<\/pathurl>/g)].map(m=>m[1]);
    assert.ok(refs.length >= 2, 'check every picture and sound media URI');
    for (const ref of refs) {
        const resolved=fileURLToPath(new URL(ref,pathToFileURL(res.xml_path)));
        assert.ok(resolved.startsWith(dest+path.sep), 'media URI resolves outside the package: '+ref);
        assert.ok(fs.existsSync(resolved), 'XML media URI does not resolve to copied file: '+ref);
    }
    assert.ok(!xml.includes(fx.media), 'the original absolute media path is still in the XML');
    assert.ok(xml.includes(RELATIVE_MEDIA_DIR), 'the XML does not reference the packaged media at all');

    // Every file it names is actually in the folder.
    for (const name of ['1A.mp4', 'scene1.mp3']) {
        assert.ok(fs.existsSync(path.join(dest, RELATIVE_MEDIA_DIR, name)),
            `${name} is named by the XML and was not copied into the package`);
    }
    assert.equal(res.copied.length, 2, `expected 2 media files copied, got ${res.copied.length}`);

    // Copies, never moves: the project's own media must survive being packaged.
    assert.ok(fs.existsSync(v), 'packaging MOVED the project\'s media instead of copying it');
});

test('packaging refuses what the preflight blocks', () => {
    /*
     * One rule, not two. A package that builds happily from an export the
     * preflight would refuse makes the preflight advisory, and an advisory
     * check is one people skip.
     */
    const shots = [{ id: 's1', shot_code: '1A', duration_ms: 0, scene_id: 'sc1' }];
    assert.rejects(
        () => packageExport({ title: 'No' }, shots, [], { format: 'premiere', dest: os.tmpdir() }),
        /NO_SHOOTABLE_SHOTS|nothing to hand over/i,
        'a package was built from an export with no clips in it');
});

test('the preflight and the package are reachable, and the preflight is free', () => {
    /*
     * A capability with no way in is indistinguishable from one that does not
     * exist — and this one is the LAST step of the only workflow that matters,
     * so it has to be reachable from the app and from an agent.
     */
    const fs_ = require('fs');
    const route = fs_.readFileSync(path.join(__dirname, '..', 'routes', 'nle-export.js'), 'utf8');
    assert.ok(/format === 'preflight'/.test(route), 'the preflight has no route');
    assert.ok(/format === 'package'/.test(route), 'the package has no route');
    // Listed, or nobody discovers it: the formats endpoint is how a caller
    // finds out what this project can produce.
    assert.ok(/id: 'preflight'/.test(route), 'the preflight is not listed among the export formats');
    assert.ok(/id: 'package'/.test(route), 'the package is not listed among the export formats');

    const tools = require('../lib/mcp-tools').listTools();
    for (const name of ['export_preflight', 'export_package']) {
        const tool = tools.find(t => t.name === name);
        assert.ok(tool, `${name} is not an MCP tool — an agent cannot reach the last step of the pipeline`);
    }
    assert.ok(/FREE/.test(tools.find(t => t.name === 'export_preflight').description),
        'the preflight does not say it is free, so it will be treated as if it spends');

    // The package must say what it refuses, or a 409 reads as a broken export.
    assert.ok(/[Rr]efuses/.test(tools.find(t => t.name === 'export_package').description),
        'export_package does not say that it refuses what the preflight blocks');
});


test('FCPXML packaged media URIs resolve beside the XML after relocation',async()=>{
    const fx=fixture();const source=fx.write('picture #1.mp4',256);
    const res=await packageExport({title:'Relative URI'},[{id:'s',shot_code:'S',duration_ms:2000}],[{id:'v',shot_id:'s',asset_type:'video_raw',file_path:source,file_name:'picture #1.mp4',duration_ms:2000}],{format:'fcpxml',dest:path.join(fx.root,'before')});
    const moved=path.join(fx.root,'after');fs.renameSync(path.dirname(res.xml_path),moved);
    const xmlPath=path.join(moved,path.basename(res.xml_path)),xml=fs.readFileSync(xmlPath,'utf8');
    const {pathToFileURL,fileURLToPath}=require('url');
    const refs=[...xml.matchAll(/src="([^"]+)"/g)].map(m=>m[1]);assert.ok(refs.length);
    for(const ref of refs) {const resolved=fileURLToPath(new URL(ref,pathToFileURL(xmlPath)));assert.ok(resolved.startsWith(moved+path.sep));assert.ok(fs.existsSync(resolved),ref);}
});
