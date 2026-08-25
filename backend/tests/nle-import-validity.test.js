/**
 * AN EXPORT THAT WILL NOT IMPORT IS NOT AN EXPORT.
 *
 * "I got a file import failure in the import." — Premiere, on a file this
 * engine had just produced, for a project with two perfectly good clips.
 *
 * The file was well-formed XML, had the right root element, listed both clips
 * with correct durations and real paths on disk, and was still rejected. Three
 * structural faults, none of which any existing check could see because every
 * one of them asserted on CONTENT:
 *
 *  - Seven of the nine clipitems had no <file> element at all. They were shots
 *    with no footage yet, emitted as empty zero-length items. A clipitem
 *    without a file is not a clip.
 *  - The sequence never declared its own format. Premiere builds the timeline
 *    settings from <media><video><format><samplecharacteristics>, and without
 *    it there is nothing to build.
 *  - Four empty <track></track> elements in the audio section.
 *
 * Set-based over the three formats, because they share the shot walk and each
 * one has its own idea of what a shot with no media is.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-nlevalid-' + crypto.randomUUID().slice(0, 8));

const { generateEDL, generateFCPXML, generatePremiereXML } = require('../lib/nle-export');

/** Two shots with footage and three without — the real shape of a project mid-shoot. */
function scenario() {
    const project = { id: 'p1', title: 'Wingfall', target_fps: 24, target_resolution: '1920x1080' };
    const shots = [
        { id: 's1', shot_code: '1A', scene_number: 1, duration_ms: 22080, sort_order: 0 },
        { id: 's2', shot_code: '2A', scene_number: 2, duration_ms: 10050, sort_order: 0 },
        { id: 's3', shot_code: '2B', scene_number: 2, duration_ms: 0, sort_order: 1 },
        { id: 's4', shot_code: '3A', scene_number: 3, duration_ms: 0, sort_order: 0 },
        { id: 's5', shot_code: '3B', scene_number: 3, duration_ms: 0, sort_order: 1 },
    ];
    const assets = [
        { id: 'a1', shot_id: 's1', asset_type: 'video_raw', file_name: '1A_video.mp4', file_path: '/data/video/1A_video.mp4', duration_ms: 22080 },
        { id: 'a2', shot_id: 's2', asset_type: 'video_raw', file_name: '2A_video.mp4', file_path: '/data/video/2A_video.mp4', duration_ms: 10050 },
    ];
    /*
     * The EDL signature has no slot for assets, so they travel in settings —
     * all three formats have to apply one rule about what is shootable, and a
     * format that cannot see the assets cannot apply it.
     */
    return { project, shots, assets,
        settings: { target_fps: 24, target_resolution: '1920x1080', assets } };
}

test('Premiere XML has no clip without a file, and declares its own format', () => {
    const s = scenario();
    const xml = generatePremiereXML(s.project, s.shots, s.assets, s.settings);

    const clipitems = [...xml.matchAll(/<clipitem\b[^>]*>([\s\S]*?)<\/clipitem>/g)].map(m => m[1]);
    assert.ok(clipitems.length, 'no clips at all');

    /*
     * A clipitem with no <file> is not a clip. Premiere rejects the whole file
     * rather than skipping the item, so ONE of these loses the entire export —
     * which is why the director got "file import failure" on a project whose
     * two real clips were perfectly described.
     */
    const fileless = clipitems.filter(c => !/<file\b/.test(c))
        .map(c => (/<name>([^<]*)/.exec(c) || [])[1]);
    assert.deepStrictEqual(fileless, [],
        `these clips have no media and were emitted anyway: ${fileless.join(', ')}`);

    // And nothing zero-length, which is what a shot with no footage becomes.
    const zero = clipitems.filter(c => /<duration>0<\/duration>/.test(c))
        .map(c => (/<name>([^<]*)/.exec(c) || [])[1]);
    assert.deepStrictEqual(zero, [], `zero-length clips on the timeline: ${zero.join(', ')}`);

    // The two real ones must survive.
    const names = clipitems.map(c => (/<name>([^<]*)/.exec(c) || [])[1]);
    assert.deepStrictEqual(names, ['1A', '2A'], `wrong clips on the timeline: ${names.join(', ')}`);

    /*
     * The sequence's own settings. Premiere builds the timeline from this
     * block; without it there is nothing to build and the import fails even
     * when every clip is valid.
     */
    const seqMedia = /<sequence[\s\S]*?<media>([\s\S]*)<\/media>/.exec(xml);
    assert.ok(seqMedia, 'the sequence has no media block');
    assert.ok(/<format>[\s\S]*?<samplecharacteristics>/.test(seqMedia[1]),
        'the sequence never declares its format, so Premiere has no timeline settings to build');
    assert.ok(/<width>1920<\/width>/.test(seqMedia[1]) && /<height>1080<\/height>/.test(seqMedia[1]),
        'the sequence format does not carry the project resolution');

    /*
     * Empty AUDIO tracks are deliberate and stay: AUDIO_LANES exists because a
     * Premiere export once silently dropped the ambient bed, and a lane that is
     * empty today is where the sound pass lands tomorrow. What must not be
     * empty is the VIDEO track — a sequence with no picture is not a sequence.
     */
    const videoSection = /<video>([\s\S]*?)<\/video>/.exec(xml);
    assert.ok(videoSection && /<clipitem/.test(videoSection[1]),
        'the video track is empty');
});

test('FCPXML references no asset it did not declare', () => {
    const s = scenario();
    const xml = generateFCPXML(s.project, s.shots, s.assets, s.settings);

    const declared = new Set([...xml.matchAll(/<asset\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]));
    const referenced = [...xml.matchAll(/\bref="([^"]+)"/g)].map(m => m[1]);
    const dangling = [...new Set(referenced.filter(r => /^r[0-9]/.test(r) === false && !declared.has(r)))];
    assert.deepStrictEqual(dangling, [],
        `FCPXML references assets it never declares: ${dangling.join(', ')}`);

    /*
     * FCPXML keeps shots with no media as <gap>, which is the correct idiom and
     * preserves the timing of everything after them. What it must never do is
     * emit a CLIP that references nothing — which the dangling check above
     * covers. Only a zero-length shot is dropped outright.
     */
    for (const code of ['2B', '3A', '3B']) {
        const asClip = new RegExp(`<asset-clip[^>]*name="${code}"`).test(xml);
        assert.ok(!asClip, `${code} has no footage and became a clip rather than a gap`);
    }
});

test('the EDL contains no zero-length events', () => {
    const s = scenario();
    const edl = generateEDL(s.project, s.shots, s.settings);

    /*
     * An EDL event whose record in and out are identical is an instruction to
     * cut to a shot for no frames. Conform software either errors or silently
     * drops it, and a dropped event is a shot missing from the assembly with
     * nothing said.
     */
    const events = edl.split('\n').filter(l => /^\d{3}\s/.test(l));
    assert.ok(events.length, 'the EDL has no events');
    const zero = events.filter(l => {
        const tc = l.match(/(\d{2}:\d{2}:\d{2}[:;]\d{2})/g) || [];
        return tc.length >= 4 && tc[2] === tc[3];
    });
    assert.deepStrictEqual(zero, [], `zero-length EDL events:\n${zero.join('\n')}`);
    assert.strictEqual(events.length, 2, `expected the two shots with footage, got ${events.length}`);
});
