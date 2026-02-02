/**
 * NLE Export Format Generators
 *
 * Pure functions for generating timeline export formats:
 * - FCPXML 1.11 (Final Cut Pro)
 * - EDL CMX 3600 (universal)
 * - Premiere Pro XML (FCP 7 / xmeml v5)
 *
 * All functions accept data objects (no DB dependency) and return strings.
 */

const FPS = 24;

/** Default project settings for backward compatibility */
const DEFAULT_SETTINGS = {
    target_fps: 24,
    target_resolution: '1920x1080',
    timecode_start: '01:00:00:00',
    aspect_ratio: '16:9',
    color_space: 'Rec.709',
};

/** Check if an fps value is NTSC (29.97, 23.976, 59.94) */
function isNtscFps(fps) {
    return [23.976, 29.97, 59.94].includes(fps);
}

/** Convert fps to rational frame duration for FCPXML (e.g. 24 → "100/2400s", 23.976 → "1001/24000s") */
function fpsToRational(fps) {
    // Standard rational representations
    const rationals = {
        23.976: { num: 1001, den: 24000 },
        24: { num: 100, den: 2400 },
        25: { num: 100, den: 2500 },
        29.97: { num: 1001, den: 30000 },
        30: { num: 100, den: 3000 },
        48: { num: 100, den: 4800 },
        60: { num: 100, den: 6000 },
        59.94: { num: 1001, den: 60000 },
        120: { num: 100, den: 12000 },
    };
    if (rationals[fps]) {
        return rationals[fps];
    }
    // Fallback: approximate with 100/fps*100
    const den = Math.round(fps * 100);
    return { num: 100, den };
}

/** Parse "WIDTHxHEIGHT" string into { width, height } */
function parseResolution(res) {
    const m = String(res || '').match(/^(\d+)x(\d+)$/);
    if (!m) return { width: 1920, height: 1080 };
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/** Build a FCPXML format name like "FFVideoFormat1080p24" */
function fcpxmlFormatName(width, height, fps) {
    return `FFVideoFormat${height}p${fps === 23.976 ? '2397' : Math.round(fps)}`;
}

// ── Timecode Helpers ─────────────────────────────────────────────────

/**
 * Convert milliseconds to SMPTE timecode string at given fps.
 * Automatically uses drop-frame for NTSC rates (29.97, 59.94).
 * @param {number} ms - Duration in milliseconds
 * @param {number} fps - Frames per second (default 24)
 * @returns {string} "HH:MM:SS:FF" (NDF) or "HH:MM:SS;FF" (DF)
 */
function msToTimecode(ms, fps = FPS) {
    if (ms < 0) ms = 0;

    // Use drop-frame for 29.97 and 59.94
    if (fps === 29.97 || fps === 59.94) {
        return msToTimecodeDF(ms, fps);
    }

    const roundedFps = Math.round(fps);
    const totalFrames = Math.round((ms / 1000) * fps);
    const ff = totalFrames % roundedFps;
    const totalSeconds = Math.floor(totalFrames / roundedFps);
    const ss = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const mm = totalMinutes % 60;
    const hh = Math.floor(totalMinutes / 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

/**
 * Convert milliseconds to drop-frame SMPTE timecode.
 * Drop-frame skips frame numbers 0 and 1 at the start of each minute,
 * except every 10th minute, to compensate for 29.97 not being exactly 30.
 * Uses semicolon separator for the frame field (industry standard).
 * @param {number} ms - Duration in milliseconds
 * @param {number} fps - 29.97 or 59.94
 * @returns {string} "HH:MM:SS;FF"
 */
function msToTimecodeDF(ms, fps = 29.97) {
    if (ms < 0) ms = 0;
    const roundedFps = Math.round(fps);  // 30 or 60
    const dropFrames = roundedFps === 60 ? 4 : 2;

    // Total real frames elapsed
    let frameCount = Math.round((ms / 1000) * fps);

    // Drop-frame algorithm: convert real frame count to DF display
    // Frames per 10-minute chunk (accounting for drops)
    const framesPerMin = roundedFps * 60;  // nominal frames per minute (1800 for 30fps)
    const framesPer10Min = framesPerMin * 10;  // nominal 18000

    // Actual frames in 10 min for 29.97: 17982
    const actualPer10Min = framesPer10Min - (9 * dropFrames);
    // Actual frames per non-10th minute: 1798
    const actualPerMin = framesPerMin - dropFrames;

    const tenMinChunks = Math.floor(frameCount / actualPer10Min);
    let remainder = frameCount % actualPer10Min;

    // Within a 10-min chunk: first minute has no drop, remaining 9 do
    let minuteInChunk;
    if (remainder < framesPerMin) {
        // First minute of the 10-min chunk (no drop)
        minuteInChunk = 0;
    } else {
        remainder -= framesPerMin;
        minuteInChunk = 1 + Math.floor(remainder / actualPerMin);
        remainder = remainder % actualPerMin;
        // Add back skipped frames for display
        remainder += dropFrames;
    }

    const totalMinutes = tenMinChunks * 10 + minuteInChunk;
    const displayFrameInMinute = (minuteInChunk === 0 && tenMinChunks === 0 && totalMinutes === 0)
        ? frameCount
        : remainder;

    // Now convert the remaining frames to SS:FF within this minute
    // But we need a simpler approach — use the standard DF formula
    // Standard formula: add back dropped frames to get display frame number
    const totalDropped = dropFrames * (
        Math.floor(frameCount / actualPer10Min) * 9 +
        (function() {
            const rem = frameCount % actualPer10Min;
            if (rem < framesPerMin) return 0;
            return Math.floor((rem - framesPerMin) / actualPerMin) + 1;
        })()
    );

    const displayFrame = frameCount + totalDropped;

    const ff = displayFrame % roundedFps;
    const totalSecs = Math.floor(displayFrame / roundedFps);
    const ss = totalSecs % 60;
    const totalMins = Math.floor(totalSecs / 60);
    const mm = totalMins % 60;
    const hh = Math.floor(totalMins / 60);

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')};${String(ff).padStart(2, '0')}`;
}

/**
 * Convert milliseconds to frame count at given fps.
 * @param {number} ms
 * @param {number} fps
 * @returns {number}
 */
function msToFrames(ms, fps = FPS) {
    return Math.round((ms / 1000) * fps);
}

/**
 * Convert SMPTE timecode string to frame count.
 * @param {string} tc - "HH:MM:SS:FF"
 * @param {number} fps
 * @returns {number}
 */
function timecodeToFrames(tc, fps = FPS) {
    const m = String(tc || '').match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return 0;
    const roundedFps = Math.round(fps);
    return parseInt(m[1]) * 3600 * roundedFps +
           parseInt(m[2]) * 60 * roundedFps +
           parseInt(m[3]) * roundedFps +
           parseInt(m[4]);
}

// ── Transition Helpers ───────────────────────────────────────────────

/** Map transition type to FCPXML effect UID */
const FCPXML_TRANSITION_EFFECTS = {
    'dissolve': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
    'cross-dissolve': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
    'fade-from-black': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
    'fade-from-white': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
    'dip-to-black': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
    'dip-to-white': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
    'wipe-left': 'FxPlug:Wipe',
    'wipe-right': 'FxPlug:Wipe',
};

/** Map transition type to EDL event type: C=cut, D=dissolve, W=wipe */
function edlTransitionType(type) {
    if (!type || type === 'cut') return 'C';
    if (type.includes('wipe')) return 'W001';
    return 'D';
}

/** Map transition type to Premiere XML effect name */
function premiereTransitionName(type) {
    if (type === 'dissolve' || type === 'cross-dissolve') return 'Cross Dissolve';
    if (type === 'fade-from-black' || type === 'dip-to-black') return 'Dip to Black';
    if (type === 'fade-from-white' || type === 'dip-to-white') return 'Dip to White';
    if (type === 'wipe-left' || type === 'wipe-right') return 'Wipe';
    return 'Cross Dissolve';
}

// ── XML Helpers ──────────────────────────────────────────────────────

function escapeXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ── EDL (CMX 3600) ──────────────────────────────────────────────────

/**
 * Generate CMX 3600 EDL.
 * @param {object} project - { id, title }
 * @param {Array} shots - [{ id, shot_code, duration_ms, scene_number, location }]
 * @param {object} [settings] - Project settings (target_fps, timecode_start, etc.)
 * @returns {string} EDL text
 */
function generateEDL(project, shots, settings = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const fps = s.target_fps;
    const lines = [];

    lines.push(`TITLE: ${project.title || 'Untitled'}`);
    lines.push(isNtscFps(fps) ? 'FCM: DROP FRAME' : 'FCM: NON-DROP FRAME');
    lines.push('');

    let recordOffsetMs = 0;

    shots.forEach((shot, i) => {
        const eventNum = String(i + 1).padStart(3, '0');
        const reel = (shot.shot_code || `SHOT${i + 1}`).substring(0, 8).padEnd(8, ' ');
        const durationMs = shot.duration_ms || 0;

        const srcIn = '00:00:00:00';
        const srcOut = msToTimecode(durationMs, fps);
        const recIn = msToTimecode(recordOffsetMs, fps);
        const recOut = msToTimecode(recordOffsetMs + durationMs, fps);

        // Determine edit type from transition_in
        const transType = edlTransitionType(shot.transition_in_type);
        let editField = transType.padEnd(9, ' ');
        if (transType !== 'C' && shot.transition_in_duration_ms > 0) {
            const transDurFrames = String(msToFrames(shot.transition_in_duration_ms, fps)).padStart(3, '0');
            editField = `${transType}    ${transDurFrames}`;
        }

        lines.push(`${eventNum}  ${reel} V     ${editField}${srcIn} ${srcOut} ${recIn} ${recOut}`);

        // Comment line with scene info
        if (shot.scene_number !== undefined || shot.location) {
            const sceneParts = [];
            if (shot.scene_number !== undefined) sceneParts.push(`Scene ${shot.scene_number}`);
            if (shot.location) sceneParts.push(shot.location);
            lines.push(`* FROM CLIP NAME: ${shot.shot_code || ''}`);
            if (sceneParts.length) {
                lines.push(`* COMMENT: ${sceneParts.join(' - ')}`);
            }
        }

        lines.push('');
        recordOffsetMs += durationMs;
    });

    return lines.join('\n');
}

// ── FCPXML 1.11 ─────────────────────────────────────────────────────

/**
 * Generate FCPXML 1.11 for Final Cut Pro.
 * @param {object} project - { id, title }
 * @param {Array} shots - [{ id, shot_code, duration_ms, scene_number, location }]
 * @param {Array} assets - [{ id, asset_type, file_path, file_name, duration_ms }]
 * @param {object} [settings] - Project settings (target_fps, target_resolution, timecode_start, etc.)
 * @returns {string} FCPXML XML string
 */
function generateFCPXML(project, shots, assets = [], settings = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const fps = s.target_fps;
    const { num: frameDurNum, den: frameDurDen } = fpsToRational(fps);
    const { width, height } = parseResolution(s.target_resolution);
    const formatName = fcpxmlFormatName(width, height, fps);
    const tcFormat = isNtscFps(fps) ? 'DF' : 'NDF';

    // Convert timecode_start to rational (parse SMPTE → frames → rational)
    const tcStartFrames = timecodeToFrames(s.timecode_start, fps);
    const tcStartRational = `${tcStartFrames * frameDurNum}/${frameDurDen}s`;

    const title = escapeXml(project.title || 'Untitled');
    const totalDurationMs = shots.reduce((sum, sh) => sum + (sh.duration_ms || 0), 0);
    const totalFrames = msToFrames(totalDurationMs, fps);

    // Build asset lookup: shot_id → assets by type
    const assetsByShot = {};
    for (const a of assets) {
        if (!a.shot_id) continue;
        if (!assetsByShot[a.shot_id]) assetsByShot[a.shot_id] = [];
        assetsByShot[a.shot_id].push(a);
    }

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<!DOCTYPE fcpxml>\n`;
    xml += `<fcpxml version="1.11">\n`;

    // Resources
    xml += `  <resources>\n`;
    xml += `    <format id="r1" name="${formatName}" frameDuration="${frameDurNum}/${frameDurDen}s" width="${width}" height="${height}"/>\n`;

    // Asset entries for media files
    let assetIndex = 1;
    const assetIdMap = {};
    for (const shot of shots) {
        const shotAssets = assetsByShot[shot.id] || [];
        const videoAsset = shotAssets.find(a =>
            a.asset_type === 'video_final' || a.asset_type === 'video_synced' || a.asset_type === 'video_raw'
        );
        if (videoAsset) {
            const refId = `a${assetIndex++}`;
            assetIdMap[`${shot.id}_video`] = refId;
            const durFrames = msToFrames(videoAsset.duration_ms || shot.duration_ms || 0, fps);
            xml += `    <asset id="${refId}" name="${escapeXml(videoAsset.file_name || shot.shot_code)}" src="${escapeXml(videoAsset.file_path)}" start="0/1s" duration="${durFrames * frameDurNum}/${frameDurDen}s" format="r1"/>\n`;
        }

        for (const audioType of ['audio_dialogue', 'audio_music', 'audio_sfx', 'audio_ambient']) {
            const audioAsset = shotAssets.find(a => a.asset_type === audioType);
            if (audioAsset) {
                const refId = `a${assetIndex++}`;
                assetIdMap[`${shot.id}_${audioType}`] = refId;
                const durFrames = msToFrames(audioAsset.duration_ms || shot.duration_ms || 0, fps);
                xml += `    <asset id="${refId}" name="${escapeXml(audioAsset.file_name || audioType)}" src="${escapeXml(audioAsset.file_path)}" start="0/1s" duration="${durFrames * frameDurNum}/${frameDurDen}s"/>\n`;
            }
        }
    }

    xml += `  </resources>\n`;

    // Library → Event → Project → Sequence → Spine
    xml += `  <library>\n`;
    xml += `    <event name="${title}">\n`;
    xml += `      <project name="${title}">\n`;
    xml += `        <sequence format="r1" duration="${totalFrames * frameDurNum}/${frameDurDen}s" tcStart="${tcStartRational}" tcFormat="${tcFormat}">\n`;
    xml += `          <spine>\n`;

    let currentScene = null;

    for (let si = 0; si < shots.length; si++) {
        const shot = shots[si];
        const durationMs = shot.duration_ms || 0;
        const durFrames = msToFrames(durationMs, fps);
        const durRational = `${durFrames * frameDurNum}/${frameDurDen}s`;
        const clipName = escapeXml(shot.shot_code || shot.id);

        if (shot.scene_number !== currentScene) {
            currentScene = shot.scene_number;
        }

        // Insert transition element before this clip (if not a cut)
        const transIn = shot.transition_in_type;
        const transInMs = shot.transition_in_duration_ms || 0;
        if (transIn && transIn !== 'cut' && transInMs > 0 && si > 0) {
            const transFrames = msToFrames(transInMs, fps);
            const transRational = `${transFrames * frameDurNum}/${frameDurDen}s`;
            const effectUid = FCPXML_TRANSITION_EFFECTS[transIn] || FCPXML_TRANSITION_EFFECTS['dissolve'];
            xml += `            <transition name="${escapeXml(transIn)}" duration="${transRational}">\n`;
            xml += `              <filter-video ref="${effectUid}"/>\n`;
            xml += `            </transition>\n`;
        }

        const videoRef = assetIdMap[`${shot.id}_video`];

        if (videoRef) {
            xml += `            <clip name="${clipName}" duration="${durRational}" start="0/1s" format="r1">\n`;
            xml += `              <video ref="${videoRef}" duration="${durRational}"/>\n`;

            let lane = 1;
            for (const audioType of ['audio_dialogue', 'audio_music', 'audio_sfx', 'audio_ambient']) {
                const audioRef = assetIdMap[`${shot.id}_${audioType}`];
                if (audioRef) {
                    xml += `              <audio ref="${audioRef}" lane="${lane}" duration="${durRational}"/>\n`;
                    lane++;
                }
            }

            if (shot.scene_number !== undefined) {
                xml += `              <marker start="0/1s" duration="${frameDurNum}/${frameDurDen}s" value="${escapeXml(`Scene ${shot.scene_number}`)}"/>\n`;
            }

            xml += `            </clip>\n`;
        } else {
            xml += `            <gap name="${clipName}" duration="${durRational}">\n`;
            if (shot.scene_number !== undefined) {
                xml += `              <marker start="0/1s" duration="${frameDurNum}/${frameDurDen}s" value="${escapeXml(`Scene ${shot.scene_number}`)}"/>\n`;
            }
            xml += `            </gap>\n`;
        }
    }

    xml += `          </spine>\n`;
    xml += `        </sequence>\n`;
    xml += `      </project>\n`;
    xml += `    </event>\n`;
    xml += `  </library>\n`;
    xml += `</fcpxml>\n`;

    return xml;
}

// ── Premiere Pro XML (xmeml v5 / FCP 7 format) ──────────────────────

/**
 * Generate Premiere Pro-compatible XML (xmeml v5).
 * @param {object} project - { id, title }
 * @param {Array} shots - [{ id, shot_code, duration_ms, scene_number, location }]
 * @param {Array} assets - [{ id, asset_type, file_path, file_name, shot_id, duration_ms }]
 * @param {object} [settings] - Project settings (target_fps, target_resolution, etc.)
 * @returns {string} xmeml XML string
 */
function generatePremiereXML(project, shots, assets = [], settings = {}) {
    const se = { ...DEFAULT_SETTINGS, ...settings };
    const fps = se.target_fps;
    const timebase = Math.round(fps);
    const ntsc = isNtscFps(fps) ? 'TRUE' : 'FALSE';
    const { width, height } = parseResolution(se.target_resolution);

    const title = escapeXml(project.title || 'Untitled');
    const totalDurationMs = shots.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
    const totalFrames = msToFrames(totalDurationMs, fps);

    // Build asset lookup
    const assetsByShot = {};
    for (const a of assets) {
        if (!a.shot_id) continue;
        if (!assetsByShot[a.shot_id]) assetsByShot[a.shot_id] = [];
        assetsByShot[a.shot_id].push(a);
    }

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<xmeml version="5">\n`;
    xml += `  <sequence>\n`;
    xml += `    <name>${title}</name>\n`;
    xml += `    <duration>${totalFrames}</duration>\n`;
    xml += `    <rate>\n`;
    xml += `      <timebase>${timebase}</timebase>\n`;
    xml += `      <ntsc>${ntsc}</ntsc>\n`;
    xml += `    </rate>\n`;
    xml += `    <media>\n`;

    // Video track
    xml += `      <video>\n`;
    xml += `        <track>\n`;

    let fileIndex = 1;
    let videoOffset = 0;
    let transIndex = 1;

    for (let si = 0; si < shots.length; si++) {
        const shot = shots[si];
        const durationMs = shot.duration_ms || 0;
        const durFrames = msToFrames(durationMs, fps);
        const clipName = escapeXml(shot.shot_code || shot.id);
        const shotAssets = assetsByShot[shot.id] || [];
        const videoAsset = shotAssets.find(a =>
            a.asset_type === 'video_final' || a.asset_type === 'video_synced' || a.asset_type === 'video_raw'
        );

        // Insert transitionitem before this clip (if not a cut and not first shot)
        const transIn = shot.transition_in_type;
        const transInMs = shot.transition_in_duration_ms || 0;
        if (transIn && transIn !== 'cut' && transInMs > 0 && si > 0) {
            const transFrames = msToFrames(transInMs, fps);
            xml += `          <transitionitem>\n`;
            xml += `            <name>${escapeXml(premiereTransitionName(transIn))}</name>\n`;
            xml += `            <rate>\n`;
            xml += `              <timebase>${timebase}</timebase>\n`;
            xml += `              <ntsc>${ntsc}</ntsc>\n`;
            xml += `            </rate>\n`;
            xml += `            <start>${videoOffset - transFrames}</start>\n`;
            xml += `            <end>${videoOffset}</end>\n`;
            xml += `            <alignment>center</alignment>\n`;
            xml += `          </transitionitem>\n`;
            transIndex++;
        }

        xml += `          <clipitem id="clipitem-${fileIndex}">\n`;
        xml += `            <name>${clipName}</name>\n`;
        xml += `            <duration>${durFrames}</duration>\n`;
        xml += `            <rate>\n`;
        xml += `              <timebase>${timebase}</timebase>\n`;
        xml += `              <ntsc>${ntsc}</ntsc>\n`;
        xml += `            </rate>\n`;
        xml += `            <start>${videoOffset}</start>\n`;
        xml += `            <end>${videoOffset + durFrames}</end>\n`;
        xml += `            <in>0</in>\n`;
        xml += `            <out>${durFrames}</out>\n`;

        if (videoAsset) {
            xml += `            <file id="file-${fileIndex}">\n`;
            xml += `              <name>${escapeXml(videoAsset.file_name || shot.shot_code)}</name>\n`;
            xml += `              <pathurl>file:///${escapeXml(videoAsset.file_path)}</pathurl>\n`;
            xml += `              <duration>${durFrames}</duration>\n`;
            xml += `              <rate>\n`;
            xml += `                <timebase>${timebase}</timebase>\n`;
            xml += `                <ntsc>${ntsc}</ntsc>\n`;
            xml += `              </rate>\n`;
            xml += `              <media>\n`;
            xml += `                <video>\n`;
            xml += `                  <samplecharacteristics>\n`;
            xml += `                    <width>${width}</width>\n`;
            xml += `                    <height>${height}</height>\n`;
            xml += `                  </samplecharacteristics>\n`;
            xml += `                </video>\n`;
            xml += `              </media>\n`;
            xml += `            </file>\n`;
        }

        // Scene marker
        if (shot.scene_number !== undefined) {
            xml += `            <marker>\n`;
            xml += `              <name>Scene ${shot.scene_number}</name>\n`;
            xml += `              <in>0</in>\n`;
            xml += `              <out>-1</out>\n`;
            xml += `            </marker>\n`;
        }

        xml += `          </clipitem>\n`;

        videoOffset += durFrames;
        fileIndex++;
    }

    xml += `        </track>\n`;
    xml += `      </video>\n`;

    // Audio tracks (dialogue, music, SFX)
    const audioTypes = [
        { type: 'audio_dialogue', label: 'Dialogue' },
        { type: 'audio_music', label: 'Music' },
        { type: 'audio_sfx', label: 'SFX' },
    ];

    xml += `      <audio>\n`;

    for (const audioTrack of audioTypes) {
        xml += `        <track>\n`;

        let audioOffset = 0;
        for (const shot of shots) {
            const durationMs = shot.duration_ms || 0;
            const durFrames = msToFrames(durationMs, fps);
            const shotAssets = assetsByShot[shot.id] || [];
            const audioAsset = shotAssets.find(a => a.asset_type === audioTrack.type);

            if (audioAsset) {
                xml += `          <clipitem>\n`;
                xml += `            <name>${escapeXml(audioAsset.file_name || audioTrack.label)}</name>\n`;
                xml += `            <duration>${durFrames}</duration>\n`;
                xml += `            <rate>\n`;
                xml += `              <timebase>${timebase}</timebase>\n`;
                xml += `              <ntsc>${ntsc}</ntsc>\n`;
                xml += `            </rate>\n`;
                xml += `            <start>${audioOffset}</start>\n`;
                xml += `            <end>${audioOffset + durFrames}</end>\n`;
                xml += `            <in>0</in>\n`;
                xml += `            <out>${durFrames}</out>\n`;
                xml += `            <file>\n`;
                xml += `              <name>${escapeXml(audioAsset.file_name || audioTrack.label)}</name>\n`;
                xml += `              <pathurl>file:///${escapeXml(audioAsset.file_path)}</pathurl>\n`;
                xml += `            </file>\n`;
                xml += `          </clipitem>\n`;
            }

            audioOffset += durFrames;
        }

        xml += `        </track>\n`;
    }

    xml += `      </audio>\n`;
    xml += `    </media>\n`;
    xml += `  </sequence>\n`;
    xml += `</xmeml>\n`;

    return xml;
}

module.exports = {
    generateEDL,
    generateFCPXML,
    generatePremiereXML,
    msToTimecode,
    msToTimecodeDF,
    msToFrames,
    timecodeToFrames,
    escapeXml,
    fpsToRational,
    isNtscFps,
    FPS,
    DEFAULT_SETTINGS,
};
