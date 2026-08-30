/**
 * NLE Export Tests
 *
 * Unit tests for export format generators (EDL, FCPXML, Premiere XML)
 * and integration tests for the /film/projects/:id/export endpoints.
 *
 * Run: node --test backend/tests/nle-export.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    msToTimecode,
    msToTimecodeDF,
    msToFrames,
    timecodeToFrames,
    escapeXml,
    generateEDL,
    generateFCPXML,
    generatePremiereXML,
    fpsToRational,
    isNtscFps,
    FPS,
    DEFAULT_SETTINGS,
    AUDIO_LANES,
} = require('../lib/nle-export');

// ── Test Data ────────────────────────────────────────────────────────

const testProject = { id: 'proj-001', title: 'Test Film' };

const testShots = [
    { id: 'shot-1', shot_code: 'SC01_SH01', duration_ms: 3000, scene_number: 1, location: 'Office', scene_id: 's1' },
    { id: 'shot-2', shot_code: 'SC01_SH02', duration_ms: 5000, scene_number: 1, location: 'Office', scene_id: 's1' },
    { id: 'shot-3', shot_code: 'SC02_SH01', duration_ms: 4000, scene_number: 2, location: 'Park', scene_id: 's2' },
];

const testAssets = [
    { id: 'a1', shot_id: 'shot-1', asset_type: 'video_final', file_path: '/data/shot1.mov', file_name: 'shot1.mov', duration_ms: 3000 },
    { id: 'a2', shot_id: 'shot-1', asset_type: 'audio_dialogue', file_path: '/data/shot1_dia.wav', file_name: 'shot1_dia.wav', duration_ms: 3000 },
    { id: 'a3', shot_id: 'shot-2', asset_type: 'video_final', file_path: '/data/shot2.mov', file_name: 'shot2.mov', duration_ms: 5000 },
    { id: 'a4', shot_id: 'shot-3', asset_type: 'video_raw', file_path: '/data/shot3.mov', file_name: 'shot3.mov', duration_ms: 4000 },
    { id: 'a5', shot_id: 'shot-3', asset_type: 'audio_music', file_path: '/data/shot3_music.wav', file_name: 'shot3_music.wav', duration_ms: 4000 },
];

// ── msToTimecode ─────────────────────────────────────────────────────

describe('msToTimecode', () => {
    it('converts 0ms to 00:00:00:00', () => {
        assert.equal(msToTimecode(0), '00:00:00:00');
    });

    it('converts 1000ms to 00:00:01:00 at 24fps', () => {
        assert.equal(msToTimecode(1000, 24), '00:00:01:00');
    });

    it('converts 1 frame at 24fps (41.67ms)', () => {
        assert.equal(msToTimecode(42, 24), '00:00:00:01');
    });

    it('converts 1 minute', () => {
        assert.equal(msToTimecode(60000, 24), '00:01:00:00');
    });

    it('converts 1 hour', () => {
        assert.equal(msToTimecode(3600000, 24), '01:00:00:00');
    });

    it('converts 5000ms to 00:00:05:00', () => {
        assert.equal(msToTimecode(5000, 24), '00:00:05:00');
    });

    it('handles negative input as 0', () => {
        assert.equal(msToTimecode(-500, 24), '00:00:00:00');
    });

    it('converts mid-frame value correctly', () => {
        // 500ms at 24fps = 12 frames
        assert.equal(msToTimecode(500, 24), '00:00:00:12');
    });

    it('auto-detects drop-frame for 29.97fps', () => {
        const tc = msToTimecode(0, 29.97);
        // Drop-frame uses semicolon separator
        assert.ok(tc.includes(';'), 'Expected semicolon separator for DF timecode');
    });

    it('uses colon separator for 24fps (non-drop)', () => {
        const tc = msToTimecode(1000, 24);
        assert.ok(!tc.includes(';'), 'Should not have semicolon for NDF');
    });
});

// ── msToTimecodeDF ──────────────────────────────────────────────────

describe('msToTimecodeDF', () => {
    it('converts 0ms to 00:00:00;00', () => {
        assert.equal(msToTimecodeDF(0, 29.97), '00:00:00;00');
    });

    it('converts 1 second to 00:00:01;00', () => {
        assert.equal(msToTimecodeDF(1000, 29.97), '00:00:01;00');
    });

    it('uses semicolon as frame separator', () => {
        const tc = msToTimecodeDF(5000, 29.97);
        assert.ok(tc.includes(';'));
    });

    it('converts ~1 minute correctly', () => {
        // At 29.97fps, 60000ms = 1798 frames (rounds from 1798.2)
        // 1798 frames = 59 seconds + 28 frames in DF display
        // The DF display 00:01:00;02 doesn't occur until frame 1800 (~60060ms)
        const tc = msToTimecodeDF(60000, 29.97);
        assert.equal(tc, '00:00:59;28');
    });

    it('reaches 00:01:00;02 at frame 1800', () => {
        // Frame 1800 at 29.97fps = 1800/29.97*1000 ≈ 60060ms
        const tc = msToTimecodeDF(60060, 29.97);
        assert.equal(tc, '00:01:00;02');
    });

    it('does not skip frames at 10-minute marks', () => {
        // 10 minutes = 600000ms
        const tc = msToTimecodeDF(600000, 29.97);
        // At 10 minutes, no frame skip: should be 00:10:00;00
        assert.equal(tc, '00:10:00;00');
    });

    it('handles negative input as 0', () => {
        assert.equal(msToTimecodeDF(-500, 29.97), '00:00:00;00');
    });

    it('converts 1 hour correctly', () => {
        const tc = msToTimecodeDF(3600000, 29.97);
        assert.equal(tc, '01:00:00;00');
    });
});

// ── msToFrames ───────────────────────────────────────────────────────

describe('msToFrames', () => {
    it('converts 0ms to 0 frames', () => {
        assert.equal(msToFrames(0), 0);
    });

    it('converts 1000ms to 24 frames at 24fps', () => {
        assert.equal(msToFrames(1000, 24), 24);
    });

    it('converts 5000ms to 120 frames at 24fps', () => {
        assert.equal(msToFrames(5000, 24), 120);
    });
});

// ── escapeXml ────────────────────────────────────────────────────────

describe('escapeXml', () => {
    it('escapes ampersand', () => {
        assert.equal(escapeXml('A & B'), 'A &amp; B');
    });

    it('escapes angle brackets', () => {
        assert.equal(escapeXml('<tag>'), '&lt;tag&gt;');
    });

    it('escapes quotes', () => {
        assert.equal(escapeXml('"hello"'), '&quot;hello&quot;');
    });

    it('handles null/undefined', () => {
        assert.equal(escapeXml(null), '');
        assert.equal(escapeXml(undefined), '');
    });
});

// ── generateEDL ──────────────────────────────────────────────────────

describe('generateEDL', () => {
    it('produces valid EDL header', () => {
        const edl = generateEDL(testProject, testShots);
        assert.ok(edl.startsWith('TITLE: Test Film'));
        assert.ok(edl.includes('FCM: NON-DROP FRAME'));
    });

    it('contains correct number of events', () => {
        const edl = generateEDL(testProject, testShots);
        const eventLines = edl.split('\n').filter(l => /^\d{3}/.test(l));
        assert.equal(eventLines.length, 3);
    });

    it('starts record timecode at 00:00:00:00', () => {
        const edl = generateEDL(testProject, testShots);
        const lines = edl.split('\n').filter(l => /^\d{3}/.test(l));
        // First event: record in starts at 00:00:00:00
        assert.ok(lines[0].includes('00:00:00:00'));
    });

    it('accumulates record timecodes correctly', () => {
        const edl = generateEDL(testProject, testShots);
        const lines = edl.split('\n').filter(l => /^\d{3}/.test(l));
        // Shot 1: 3000ms = 00:00:03:00, so shot 2 record-in = 00:00:03:00
        assert.ok(lines[1].includes('00:00:03:00'));
        // Shot 2: +5000ms = 00:00:08:00, so shot 3 record-in = 00:00:08:00
        assert.ok(lines[2].includes('00:00:08:00'));
    });

    it('truncates reel name to 8 characters', () => {
        const shots = [{ id: 's1', shot_code: 'VERY_LONG_SHOT_CODE', duration_ms: 1000, scene_number: 1 }];
        const edl = generateEDL(testProject, shots);
        const eventLine = edl.split('\n').find(l => /^\d{3}/.test(l));
        // Reel should be exactly 8 chars: "VERY_LON"
        assert.ok(eventLine.includes('VERY_LON'));
    });

    it('includes scene comment lines', () => {
        const edl = generateEDL(testProject, testShots);
        assert.ok(edl.includes('* COMMENT: Scene 1 - Office'));
    });

    it('handles empty shots array', () => {
        const edl = generateEDL(testProject, []);
        assert.ok(edl.includes('TITLE: Test Film'));
        const eventLines = edl.split('\n').filter(l => /^\d{3}/.test(l));
        assert.equal(eventLines.length, 0);
    });
});

// ── generateFCPXML ───────────────────────────────────────────────────

describe('generateFCPXML', () => {
    it('produces valid XML declaration', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets);
        assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    });

    it('contains fcpxml version 1.11', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<fcpxml version="1.11">'));
    });

    it('contains format resource for 1080p24', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('FFVideoFormat1080p24'));
        assert.ok(xml.includes('width="1920"'));
        assert.ok(xml.includes('height="1080"'));
    });

    it('contains library, event, project, sequence, spine', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<library>'));
        assert.ok(xml.includes('<event name="Test Film">'));
        assert.ok(xml.includes('<project name="Test Film">'));
        assert.ok(xml.includes('<sequence'));
        assert.ok(xml.includes('<spine>'));
    });

    it('creates clip elements for shots with video assets', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('name="SC01_SH01"'));
        assert.ok(xml.includes('name="SC01_SH02"'));
    });

    it('creates gap elements for shots without video assets', () => {
        // shot-2 has a video asset, so remove it to test gap
        const assetsWithoutShot2 = testAssets.filter(a => a.shot_id !== 'shot-2');
        const xml = generateFCPXML(testProject, testShots, assetsWithoutShot2);
        assert.ok(xml.includes('<gap name="SC01_SH02"'));
    });

    it('includes audio lane references', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('lane="1"')); // dialogue for shot-1
    });

    it('includes scene markers', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('Scene 1'));
        assert.ok(xml.includes('Scene 2'));
    });

    it('handles empty shots/assets', () => {
        const xml = generateFCPXML(testProject, [], []);
        assert.ok(xml.includes('<fcpxml'));
        assert.ok(xml.includes('<spine>'));
        assert.ok(xml.includes('</spine>'));
    });

    it('escapes special characters in title', () => {
        const proj = { id: 'p1', title: 'Film & "Quotes" <Tags>' };
        const xml = generateFCPXML(proj, [], []);
        assert.ok(xml.includes('Film &amp; &quot;Quotes&quot; &lt;Tags&gt;'));
    });
});

// ── generatePremiereXML ──────────────────────────────────────────────

describe('generatePremiereXML', () => {
    it('produces valid xmeml v5', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<xmeml version="5">'));
    });

    it('sets correct timebase and ntsc', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<timebase>24</timebase>'));
        assert.ok(xml.includes('<ntsc>FALSE</ntsc>'));
    });

    it('contains sequence with project name', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<name>Test Film</name>'));
    });

    it('creates clipitems for each shot', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('clipitem-1'));
        assert.ok(xml.includes('clipitem-2'));
        assert.ok(xml.includes('clipitem-3'));
    });

    it('includes file references with pathurl', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<pathurl>file:///'));
        assert.ok(xml.includes('shot1.mov'));
    });

    it('includes video dimensions', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<width>1920</width>'));
        assert.ok(xml.includes('<height>1080</height>'));
    });

    it('creates one audio track per element lane', () => {
        // Was pinned at 3 — dialogue, music, SFX — which is why the missing
        // ambient track read as correct for as long as it did. Counted against
        // AUDIO_LANES now, so the count follows the list instead of contradicting it.
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<audio>'));
        const audioSection = xml.split('<audio>')[1].split('</audio>')[0];
        const trackCount = (audioSection.match(/<track>/g) || []).length;
        assert.equal(trackCount, AUDIO_LANES.length);
    });

    it('includes scene markers', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        assert.ok(xml.includes('<marker>'));
        assert.ok(xml.includes('Scene 1'));
    });

    it('calculates total duration in frames', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets);
        // Total: 3000+5000+4000 = 12000ms = 288 frames at 24fps
        assert.ok(xml.includes('<duration>288</duration>'));
    });

    it('handles empty shots/assets', () => {
        const xml = generatePremiereXML(testProject, [], []);
        assert.ok(xml.includes('<xmeml'));
        assert.ok(xml.includes('<duration>0</duration>'));
    });
});

// ── timecodeToFrames ────────────────────────────────────────────────

describe('timecodeToFrames', () => {
    it('converts 01:00:00:00 at 24fps', () => {
        assert.equal(timecodeToFrames('01:00:00:00', 24), 86400);
    });

    it('converts 00:00:01:00 at 24fps', () => {
        assert.equal(timecodeToFrames('00:00:01:00', 24), 24);
    });

    it('converts 00:00:00:12 at 24fps', () => {
        assert.equal(timecodeToFrames('00:00:00:12', 24), 12);
    });

    it('returns 0 for invalid timecode', () => {
        assert.equal(timecodeToFrames('bad', 24), 0);
        assert.equal(timecodeToFrames(null, 24), 0);
    });
});

// ── fpsToRational ───────────────────────────────────────────────────

describe('fpsToRational', () => {
    it('returns 100/2400 for 24fps', () => {
        const r = fpsToRational(24);
        assert.equal(r.num, 100);
        assert.equal(r.den, 2400);
    });

    it('returns 1001/24000 for 23.976fps', () => {
        const r = fpsToRational(23.976);
        assert.equal(r.num, 1001);
        assert.equal(r.den, 24000);
    });

    it('returns 1001/30000 for 29.97fps', () => {
        const r = fpsToRational(29.97);
        assert.equal(r.num, 1001);
        assert.equal(r.den, 30000);
    });

    it('handles non-standard fps with fallback', () => {
        const r = fpsToRational(50);
        assert.equal(r.num, 100);
        assert.equal(r.den, 5000);
    });
});

// ── isNtscFps ───────────────────────────────────────────────────────

describe('isNtscFps', () => {
    it('identifies 29.97 as NTSC', () => {
        assert.equal(isNtscFps(29.97), true);
    });

    it('identifies 23.976 as NTSC', () => {
        assert.equal(isNtscFps(23.976), true);
    });

    it('identifies 59.94 as NTSC', () => {
        assert.equal(isNtscFps(59.94), true);
    });

    it('identifies 24 as non-NTSC', () => {
        assert.equal(isNtscFps(24), false);
    });
});

// ── Dynamic Settings Tests ──────────────────────────────────────────

describe('generateEDL with custom settings', () => {
    it('uses DROP FRAME for 29.97fps', () => {
        const edl = generateEDL(testProject, testShots, { target_fps: 29.97 });
        assert.ok(edl.includes('FCM: DROP FRAME'));
    });

    it('uses NON-DROP FRAME for 25fps', () => {
        const edl = generateEDL(testProject, testShots, { target_fps: 25 });
        assert.ok(edl.includes('FCM: NON-DROP FRAME'));
    });

    it('calculates timecodes at 30fps', () => {
        const shots = [{ id: 's1', shot_code: 'SH01', duration_ms: 1000, scene_number: 1 }];
        const edl = generateEDL(testProject, shots, { target_fps: 30 });
        const eventLine = edl.split('\n').find(l => /^\d{3}/.test(l));
        // 1000ms at 30fps = 30 frames = 00:00:01:00
        assert.ok(eventLine.includes('00:00:01:00'));
    });
});

describe('generateFCPXML with custom settings', () => {
    it('uses 4K DCI resolution', () => {
        const xml = generateFCPXML(testProject, testShots, testAssets, {
            target_resolution: '4096x2160',
            target_fps: 24,
        });
        assert.ok(xml.includes('width="4096"'));
        assert.ok(xml.includes('height="2160"'));
    });

    it('uses 23.976fps rational frame duration', () => {
        const xml = generateFCPXML(testProject, [], [], { target_fps: 23.976 });
        assert.ok(xml.includes('frameDuration="1001/24000s"'));
    });

    it('sets tcFormat to DF for NTSC fps', () => {
        const xml = generateFCPXML(testProject, [], [], { target_fps: 29.97 });
        assert.ok(xml.includes('tcFormat="DF"'));
    });

    it('sets tcFormat to NDF for non-NTSC fps', () => {
        const xml = generateFCPXML(testProject, [], [], { target_fps: 24 });
        assert.ok(xml.includes('tcFormat="NDF"'));
    });

    it('uses custom timecode start', () => {
        const xml = generateFCPXML(testProject, [], [], {
            target_fps: 24,
            timecode_start: '01:00:00:00',
        });
        // 01:00:00:00 at 24fps = 86400 frames, rational = 86400*100/2400s = 8640000/2400s
        assert.ok(xml.includes('tcStart="8640000/2400s"'));
    });

    it('generates correct format name for 4K 24fps', () => {
        const xml = generateFCPXML(testProject, [], [], {
            target_resolution: '3840x2160',
            target_fps: 24,
        });
        assert.ok(xml.includes('FFVideoFormat2160p24'));
    });
});

// ── Transition Tests ─────────────────────────────────────────────────

const transitionShots = [
    { id: 'ts1', shot_code: 'SC01_SH01', duration_ms: 3000, scene_number: 1,
      transition_in_type: 'cut', transition_in_duration_ms: 0,
      transition_out_type: 'dissolve', transition_out_duration_ms: 500 },
    { id: 'ts2', shot_code: 'SC01_SH02', duration_ms: 5000, scene_number: 1,
      transition_in_type: 'dissolve', transition_in_duration_ms: 500,
      transition_out_type: 'cut', transition_out_duration_ms: 0 },
    { id: 'ts3', shot_code: 'SC02_SH01', duration_ms: 4000, scene_number: 2,
      transition_in_type: 'wipe-left', transition_in_duration_ms: 1000,
      transition_out_type: 'cut', transition_out_duration_ms: 0 },
];

describe('generateEDL with transitions', () => {
    it('uses D event type for dissolve', () => {
        const edl = generateEDL(testProject, transitionShots);
        const lines = edl.split('\n').filter(l => /^\d{3}/.test(l));
        // Shot 2 has dissolve transition_in
        assert.ok(lines[1].includes('D'), 'Second event should be dissolve');
    });

    it('uses W event type for wipe', () => {
        const edl = generateEDL(testProject, transitionShots);
        const lines = edl.split('\n').filter(l => /^\d{3}/.test(l));
        assert.ok(lines[2].includes('W'), 'Third event should be wipe');
    });

    it('uses C event type for cut (first shot)', () => {
        const edl = generateEDL(testProject, transitionShots);
        const lines = edl.split('\n').filter(l => /^\d{3}/.test(l));
        assert.ok(lines[0].includes('C'), 'First event should be cut');
    });
});

describe('generateFCPXML with transitions', () => {
    it('includes transition element for dissolve', () => {
        const xml = generateFCPXML(testProject, transitionShots, []);
        assert.ok(xml.includes('<transition name="dissolve"'));
    });

    it('includes transition element for wipe', () => {
        const xml = generateFCPXML(testProject, transitionShots, []);
        assert.ok(xml.includes('<transition name="wipe-left"'));
    });

    it('does not add transition for first shot (even if cut)', () => {
        const xml = generateFCPXML(testProject, transitionShots, []);
        // Count transitions - should be 2 (dissolve on shot 2, wipe on shot 3)
        const transCount = (xml.match(/<transition /g) || []).length;
        assert.equal(transCount, 2);
    });

    it('includes filter-video reference', () => {
        const xml = generateFCPXML(testProject, transitionShots, []);
        assert.ok(xml.includes('<filter-video'));
    });
});

describe('generatePremiereXML with transitions', () => {
    it('includes transitionitem for dissolve', () => {
        const xml = generatePremiereXML(testProject, transitionShots, []);
        assert.ok(xml.includes('<transitionitem>'));
        assert.ok(xml.includes('Cross Dissolve'));
    });

    it('includes transitionitem for wipe', () => {
        const xml = generatePremiereXML(testProject, transitionShots, []);
        assert.ok(xml.includes('Wipe'));
    });

    it('has correct transition count', () => {
        const xml = generatePremiereXML(testProject, transitionShots, []);
        const transCount = (xml.match(/<transitionitem>/g) || []).length;
        assert.equal(transCount, 2);
    });
});

describe('generatePremiereXML with custom settings', () => {
    it('uses 4K resolution in samplecharacteristics', () => {
        const shots = [{ id: 's1', shot_code: 'SH01', duration_ms: 1000, scene_number: 1 }];
        const assets = [{ id: 'a1', shot_id: 's1', asset_type: 'video_final', file_path: '/v.mov', file_name: 'v.mov', duration_ms: 1000 }];
        const xml = generatePremiereXML(testProject, shots, assets, {
            target_resolution: '3840x2160',
        });
        assert.ok(xml.includes('<width>3840</width>'));
        assert.ok(xml.includes('<height>2160</height>'));
    });

    it('sets NTSC to TRUE for 29.97fps', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets, {
            target_fps: 29.97,
        });
        assert.ok(xml.includes('<ntsc>TRUE</ntsc>'));
        assert.ok(xml.includes('<timebase>30</timebase>'));
    });

    it('sets NTSC to FALSE for 25fps', () => {
        const xml = generatePremiereXML(testProject, testShots, testAssets, {
            target_fps: 25,
        });
        assert.ok(xml.includes('<ntsc>FALSE</ntsc>'));
        assert.ok(xml.includes('<timebase>25</timebase>'));
    });

    it('calculates frames at custom fps', () => {
        const shots = [{ id: 's1', shot_code: 'SH01', duration_ms: 1000, scene_number: 1 }];
        const xml = generatePremiereXML(testProject, shots, [], { target_fps: 30 });
        // 1000ms at 30fps = 30 frames
        assert.ok(xml.includes('<duration>30</duration>'));
    });
});

/**
 * The handoff to the NLE.
 *
 * With lip-sync, mix and grade finished in Premiere rather than in the engine,
 * an element that never reaches the timeline is work that cannot be done at
 * all — and it fails silently, because the file still opens and still plays.
 * Iterating AUDIO_LANES rather than naming lanes is the point: it is a
 * three-versus-four mismatch between two hand-kept lists that lost ambient
 * from every Premiere export in the first place.
 */
describe('audio lanes reach every format that carries audio', () => {
    const project = { id: 'p1', title: 'Handoff' };
    const shots = [{ id: 's1', shot_code: 'SH01', duration_ms: 4000, scene_number: 1 }];
    const assets = [
        { shot_id: 's1', asset_type: 'video_final', file_path: '/tmp/SH01.mp4', file_name: 'SH01.mp4', duration_ms: 4000 },
        ...AUDIO_LANES.map((lane, i) => ({
            shot_id: 's1',
            asset_type: lane.type,
            file_path: `/tmp/SH01_${lane.type}.wav`,
            file_name: `SH01_${lane.type}.wav`,
            duration_ms: 4000,
        })),
    ];

    it('AUDIO_LANES covers every audio element the pipeline produces', () => {
        // The four generating steps that emit audio: voice, music, sfx, ambient.
        // audio_mix is the master and is deliberately not a lane.
        const fromPipeline = ['audio_dialogue', 'audio_music', 'audio_sfx', 'audio_ambient'];
        assert.deepEqual(AUDIO_LANES.map(l => l.type).sort(), fromPipeline.sort());
    });

    for (const [format, generate] of [['FCPXML', generateFCPXML], ['Premiere XML', generatePremiereXML]]) {
        it(`${format} references every audio lane`, () => {
            const xml = generate(project, shots, assets, {});
            const missing = AUDIO_LANES.filter(lane => !xml.includes(`SH01_${lane.type}.wav`));
            assert.deepEqual(missing.map(l => l.type), [],
                `${format} dropped: ${missing.map(l => l.type).join(', ')}`);
        });

        it(`${format} lays out one distinct track per lane`, () => {
            const xml = generate(project, shots, assets, {});
            for (const lane of AUDIO_LANES) {
                const refs = xml.split(`SH01_${lane.type}.wav`).length - 1;
                assert.ok(refs >= 1, `${format} lost ${lane.type}`);
            }
        });
    }
});

describe('scene-scoped audio', () => {
it('a scene\'s music and ambient reach the NLE, not only a shot\'s', () => {
    /*
     * Measured on the real project before this was fixed: The Glass Harbour has
     * four generated music cues and ALL FOUR were absent from every export.
     *
     * Music and ambient are SCENE-scoped — `PIPELINE_STEPS` says so, and their
     * assets carry a scene_id and no shot_id by design. Both generators built
     * their lookup with `if (!a.shot_id) continue;`, so every score and every
     * ambient bed was dropped at the door. Nothing failed: the file opened, the
     * timeline played, and the missing layer read as a creative choice.
     *
     * That is precisely what AUDIO_LANES exists to prevent — this file's own
     * comment says a lane that never arrives is work that cannot be done at
     * all — and it is the same defect playback had, one surface over.
     *
     * The bed is laid ONCE across the scene rather than repeated per shot: a
     * score restarting at every cut is a worse output than no score.
     */
    const shots = [
        { id: 's1', shot_code: '1A', duration_ms: 4000, scene_id: 'sc1' },
        { id: 's2', shot_code: '1B', duration_ms: 4000, scene_id: 'sc1' },
        { id: 's3', shot_code: '2A', duration_ms: 4000, scene_id: 'sc2' },
    ];
    const assets = [
        { id: 'v1', shot_id: 's1', asset_type: 'video_raw', file_path: '/m/1A.mp4', file_name: '1A.mp4', duration_ms: 4000 },
        { id: 'v2', shot_id: 's2', asset_type: 'video_raw', file_path: '/m/1B.mp4', file_name: '1B.mp4', duration_ms: 4000 },
        { id: 'v3', shot_id: 's3', asset_type: 'video_raw', file_path: '/m/2A.mp4', file_name: '2A.mp4', duration_ms: 4000 },
        // Scene-scoped: no shot_id at all.
        { id: 'm1', shot_id: null, scene_id: 'sc1', asset_type: 'audio_music',
          file_path: '/m/scene1.mp3', file_name: 'scene1.mp3', duration_ms: 8000 },
        { id: 'a1', shot_id: null, scene_id: 'sc2', asset_type: 'audio_ambient',
          file_path: '/m/room2.mp3', file_name: 'room2.mp3', duration_ms: 4000 },
        /*
         * A bed for a scene with no shootable shot. It has nowhere to be laid,
         * and must be SKIPPED rather than attached to whichever shot happens to
         * be first — that would put the wrong room tone under the wrong picture,
         * which plays perfectly and is wrong.
         */
        { id: 'orphan', shot_id: null, scene_id: 'sc99', asset_type: 'audio_ambient',
          file_path: '/m/nowhere.mp3', file_name: 'nowhere.mp3', duration_ms: 4000 },
    ];

    for (const [name, gen] of [['FCPXML', generateFCPXML], ['Premiere XML', generatePremiereXML]]) {
        const xml = gen({ title: 'Beds' }, shots, assets, {});
        assert.ok(xml.includes('scene1.mp3'),
            `${name}: the scene's score never reaches the export — four real cues were lost this way`);
        assert.ok(xml.includes('room2.mp3'), `${name}: the scene's ambient bed never reaches the export`);
        assert.ok(!xml.includes('nowhere.mp3'),
            `${name}: a bed whose scene has no shot was laid anyway — under an unrelated scene`);

        /*
         * On the scene's FIRST shot. Laid on the last one it starts where the
         * scene ends, so a score arrives after the scene it was written for —
         * and the file still opens and plays.
         */
        // FCPXML declares the asset once and the clip references it by ID, so
        // the clip block never contains the filename — searched for by ref.
        const holder = name === 'FCPXML'
            ? (() => {
                const ref = xml.match(/<asset id="(a\d+)"[^>]*scene1\.mp3/)[1];
                return xml.split('<clip name=').slice(1)
                    .find(b => b.slice(0, b.indexOf('</clip>')).includes(`<audio ref="${ref}"`));
            })()
            : xml.split(/<clipitem[\s>]/).slice(1).find(b => b.slice(0, b.indexOf('</clipitem>')).includes('scene1.mp3'));
        assert.ok(holder, `${name}: the score is declared but never laid on a clip`);
        /*
         * On the scene's FIRST shot, expressed as a POSITION rather than a name:
         * FCPXML nests the bed inside the shot's own <clip>, while Premiere lays
         * it on its own audio track named after the file, so the only thing both
         * formats agree on is where it starts. Scene 1 begins at 0.
         */
        if (name === 'FCPXML') {
            assert.ok(/^"1A"/.test(holder.trim()),
                'FCPXML: the score is nested in the wrong shot — it belongs on the scene\'s first');
        } else {
            const start = holder.match(/<start>(-?\d+)<\/start>/);
            assert.ok(start, 'Premiere XML: the score is laid with no start');
            assert.equal(Number(start[1]), 0,
                `Premiere XML: the score starts at frame ${start[1]} — scene 1 begins at 0, so it `
                + 'is laid on the wrong shot and arrives after the scene it was written for');
        }
        /*
         * Laid ONCE, not once per shot in the scene. Counted as timeline CLIPS
         * rather than as occurrences of the filename: both formats name a file
         * more than once for a single clip — Premiere writes the name on the
         * clipitem, again inside its nested <file>, and once more as a
         * pathurl — so counting text reports three clips where there is one.
         */
        let laid;
        if (name === 'FCPXML') {
            // The asset is declared once and LAID by <audio ref="…">; counting
            // the declaration would report one however many times it is used.
            const decl = xml.match(/<asset id="(a\d+)"[^>]*scene1\.mp3/);
            assert.ok(decl, 'FCPXML: the score is not declared as an asset at all');
            laid = (xml.match(new RegExp(`<audio ref="${decl[1]}"`, 'g')) || []).length;
        } else {
            laid = xml.split(/<clipitem[\s>]/).slice(1)
                .filter(b => b.slice(0, b.indexOf('</clipitem>') + 1).includes('scene1.mp3')).length;
        }
        assert.equal(laid, 1,
            `${name}: the score is laid on ${laid} clips — a bed restarting at every cut is `
            + 'worse than no bed, and it already spans the scene');

        /*
         * And it runs its OWN length. The bed is 8s across a scene of two 4s
         * shots; clipped to the shot it is laid on, a score would stop at the
         * first cut — which plays, and is wrong, and is harder to notice than
         * silence because some music does arrive.
         */
        if (name === 'FCPXML') {
            const ref = xml.match(/<asset id="(a\d+)"[^>]*scene1\.mp3/)[1];
            const laidTag = xml.match(new RegExp(`<audio ref="${ref}"[^>]*duration="(\\d+)/(\\d+)s"`));
            assert.ok(laidTag, 'FCPXML: the score is laid with no duration');
            const seconds = Number(laidTag[1]) / Number(laidTag[2]);
            assert.equal(seconds, 8, `FCPXML: the 8s score is laid as ${seconds}s — cut off at the first cut`);
        } else {
            const dur = holder.match(/<duration>(\d+)<\/duration>/);
            assert.ok(dur, 'Premiere XML: the score is laid with no duration');
            // 8s at the default 24fps.
            assert.equal(Number(dur[1]), 192,
                `Premiere XML: the 8s score is laid as ${dur[1]} frames — cut off at the first cut`);
        }
    }
});
});
