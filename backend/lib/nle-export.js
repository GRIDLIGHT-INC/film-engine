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

// ── Timecode Helpers ─────────────────────────────────────────────────

/**
 * Convert milliseconds to SMPTE timecode string at given fps.
 * @param {number} ms - Duration in milliseconds
 * @param {number} fps - Frames per second (default 24)
 * @returns {string} "HH:MM:SS:FF"
 */
function msToTimecode(ms, fps = FPS) {
    if (ms < 0) ms = 0;
    const totalFrames = Math.round((ms / 1000) * fps);
    const ff = totalFrames % fps;
    const totalSeconds = Math.floor(totalFrames / fps);
    const ss = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const mm = totalMinutes % 60;
    const hh = Math.floor(totalMinutes / 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
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
 * @returns {string} EDL text
 */
function generateEDL(project, shots) {
    const lines = [];

    lines.push(`TITLE: ${project.title || 'Untitled'}`);
    lines.push('FCM: NON-DROP FRAME');
    lines.push('');

    let recordOffsetMs = 0;

    shots.forEach((shot, i) => {
        const eventNum = String(i + 1).padStart(3, '0');
        const reel = (shot.shot_code || `SHOT${i + 1}`).substring(0, 8).padEnd(8, ' ');
        const durationMs = shot.duration_ms || 0;

        const srcIn = '00:00:00:00';
        const srcOut = msToTimecode(durationMs);
        const recIn = msToTimecode(recordOffsetMs);
        const recOut = msToTimecode(recordOffsetMs + durationMs);

        lines.push(`${eventNum}  ${reel} V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);

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
 * @returns {string} FCPXML XML string
 */
function generateFCPXML(project, shots, assets = []) {
    const title = escapeXml(project.title || 'Untitled');
    const totalDurationMs = shots.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
    const totalFrames = msToFrames(totalDurationMs);

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
    xml += `    <format id="r1" name="FFVideoFormat1080p24" frameDuration="100/2400s" width="1920" height="1080"/>\n`;

    // Asset entries for media files
    let assetIndex = 1;
    const assetIdMap = {}; // asset.id → ref id
    for (const shot of shots) {
        const shotAssets = assetsByShot[shot.id] || [];
        // Video asset
        const videoAsset = shotAssets.find(a =>
            a.asset_type === 'video_final' || a.asset_type === 'video_synced' || a.asset_type === 'video_raw'
        );
        if (videoAsset) {
            const refId = `a${assetIndex++}`;
            assetIdMap[`${shot.id}_video`] = refId;
            const durFrames = msToFrames(videoAsset.duration_ms || shot.duration_ms || 0);
            xml += `    <asset id="${refId}" name="${escapeXml(videoAsset.file_name || shot.shot_code)}" src="${escapeXml(videoAsset.file_path)}" start="0/1s" duration="${durFrames * 100}/2400s" format="r1"/>\n`;
        }

        // Audio assets
        for (const audioType of ['audio_dialogue', 'audio_music', 'audio_sfx', 'audio_ambient']) {
            const audioAsset = shotAssets.find(a => a.asset_type === audioType);
            if (audioAsset) {
                const refId = `a${assetIndex++}`;
                assetIdMap[`${shot.id}_${audioType}`] = refId;
                const durFrames = msToFrames(audioAsset.duration_ms || shot.duration_ms || 0);
                xml += `    <asset id="${refId}" name="${escapeXml(audioAsset.file_name || audioType)}" src="${escapeXml(audioAsset.file_path)}" start="0/1s" duration="${durFrames * 100}/2400s"/>\n`;
            }
        }
    }

    xml += `  </resources>\n`;

    // Library → Event → Project → Sequence → Spine
    xml += `  <library>\n`;
    xml += `    <event name="${title}">\n`;
    xml += `      <project name="${title}">\n`;
    xml += `        <sequence format="r1" duration="${totalFrames * 100}/2400s" tcStart="0/1s" tcFormat="NDF">\n`;
    xml += `          <spine>\n`;

    let currentScene = null;

    for (const shot of shots) {
        const durationMs = shot.duration_ms || 0;
        const durFrames = msToFrames(durationMs);
        const durRational = `${durFrames * 100}/2400s`;
        const clipName = escapeXml(shot.shot_code || shot.id);

        // Scene boundary marker
        if (shot.scene_number !== currentScene) {
            currentScene = shot.scene_number;
        }

        const videoRef = assetIdMap[`${shot.id}_video`];

        if (videoRef) {
            xml += `            <clip name="${clipName}" duration="${durRational}" start="0/1s" format="r1">\n`;
            xml += `              <video ref="${videoRef}" duration="${durRational}"/>\n`;

            // Audio lanes
            let lane = 1;
            for (const audioType of ['audio_dialogue', 'audio_music', 'audio_sfx', 'audio_ambient']) {
                const audioRef = assetIdMap[`${shot.id}_${audioType}`];
                if (audioRef) {
                    xml += `              <audio ref="${audioRef}" lane="${lane}" duration="${durRational}"/>\n`;
                    lane++;
                }
            }

            // Scene boundary marker
            if (shot.scene_number !== undefined) {
                xml += `              <marker start="0/1s" duration="100/2400s" value="${escapeXml(`Scene ${shot.scene_number}`)}"/>\n`;
            }

            xml += `            </clip>\n`;
        } else {
            // Gap clip (no media yet)
            xml += `            <gap name="${clipName}" duration="${durRational}">\n`;
            if (shot.scene_number !== undefined) {
                xml += `              <marker start="0/1s" duration="100/2400s" value="${escapeXml(`Scene ${shot.scene_number}`)}"/>\n`;
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
 * @returns {string} xmeml XML string
 */
function generatePremiereXML(project, shots, assets = []) {
    const title = escapeXml(project.title || 'Untitled');
    const totalDurationMs = shots.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
    const totalFrames = msToFrames(totalDurationMs);

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
    xml += `      <timebase>${FPS}</timebase>\n`;
    xml += `      <ntsc>FALSE</ntsc>\n`;
    xml += `    </rate>\n`;
    xml += `    <media>\n`;

    // Video track
    xml += `      <video>\n`;
    xml += `        <track>\n`;

    let fileIndex = 1;
    let videoOffset = 0;

    for (const shot of shots) {
        const durationMs = shot.duration_ms || 0;
        const durFrames = msToFrames(durationMs);
        const clipName = escapeXml(shot.shot_code || shot.id);
        const shotAssets = assetsByShot[shot.id] || [];
        const videoAsset = shotAssets.find(a =>
            a.asset_type === 'video_final' || a.asset_type === 'video_synced' || a.asset_type === 'video_raw'
        );

        xml += `          <clipitem id="clipitem-${fileIndex}">\n`;
        xml += `            <name>${clipName}</name>\n`;
        xml += `            <duration>${durFrames}</duration>\n`;
        xml += `            <rate>\n`;
        xml += `              <timebase>${FPS}</timebase>\n`;
        xml += `              <ntsc>FALSE</ntsc>\n`;
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
            xml += `                <timebase>${FPS}</timebase>\n`;
            xml += `                <ntsc>FALSE</ntsc>\n`;
            xml += `              </rate>\n`;
            xml += `              <media>\n`;
            xml += `                <video>\n`;
            xml += `                  <samplecharacteristics>\n`;
            xml += `                    <width>1920</width>\n`;
            xml += `                    <height>1080</height>\n`;
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
            const durFrames = msToFrames(durationMs);
            const shotAssets = assetsByShot[shot.id] || [];
            const audioAsset = shotAssets.find(a => a.asset_type === audioTrack.type);

            if (audioAsset) {
                xml += `          <clipitem>\n`;
                xml += `            <name>${escapeXml(audioAsset.file_name || audioTrack.label)}</name>\n`;
                xml += `            <duration>${durFrames}</duration>\n`;
                xml += `            <rate>\n`;
                xml += `              <timebase>${FPS}</timebase>\n`;
                xml += `              <ntsc>FALSE</ntsc>\n`;
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
    msToFrames,
    escapeXml,
    FPS,
};
