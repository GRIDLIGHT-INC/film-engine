/**
 * Subtitle Format Library
 *
 * Generate and parse SRT and WebVTT subtitle formats.
 * Convert between formats.
 *
 * Cue format: { start_ms, end_ms, text, speaker?, position?, style?, is_cc? }
 */

// ── Timecode Helpers ─────────────────────────────────────────────────

/**
 * Format ms to SRT timecode: HH:MM:SS,mmm
 */
function msToSrtTime(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mil = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mil).padStart(3, '0')}`;
}

/**
 * Format ms to VTT timecode: HH:MM:SS.mmm
 */
function msToVttTime(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mil = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
}

/**
 * Parse SRT timecode (HH:MM:SS,mmm) to ms
 */
function srtTimeToMs(tc) {
    const m = String(tc).match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
    if (!m) return 0;
    return parseInt(m[1]) * 3600000 + parseInt(m[2]) * 60000 + parseInt(m[3]) * 1000 + parseInt(m[4]);
}

/**
 * Parse VTT timecode (HH:MM:SS.mmm) to ms
 */
function vttTimeToMs(tc) {
    const m = String(tc).match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!m) return 0;
    return parseInt(m[1]) * 3600000 + parseInt(m[2]) * 60000 + parseInt(m[3]) * 1000 + parseInt(m[4]);
}

// ── SRT Generation/Parsing ──────────────────────────────────────────

/**
 * Generate SRT subtitle file content.
 * @param {Array} cues - [{ start_ms, end_ms, text, speaker? }]
 * @returns {string} SRT content
 */
function generateSRT(cues) {
    if (!cues || cues.length === 0) return '';

    return cues.map((cue, i) => {
        const num = i + 1;
        const start = msToSrtTime(cue.start_ms || 0);
        const end = msToSrtTime(cue.end_ms || 0);
        const text = cue.speaker ? `<i>${cue.speaker}:</i> ${cue.text}` : cue.text;
        return `${num}\n${start} --> ${end}\n${text}`;
    }).join('\n\n') + '\n';
}

/**
 * Parse SRT content into cue array.
 * @param {string} srt
 * @returns {Array} [{ index, start_ms, end_ms, text }]
 */
function parseSRT(srt) {
    if (!srt || typeof srt !== 'string') return [];

    const blocks = srt.trim().split(/\n\n+/);
    const cues = [];

    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 3) continue;

        const index = parseInt(lines[0]);
        if (isNaN(index)) continue;

        const timeMatch = lines[1].match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
        if (!timeMatch) continue;

        const text = lines.slice(2).join('\n');

        cues.push({
            index,
            start_ms: srtTimeToMs(timeMatch[1]),
            end_ms: srtTimeToMs(timeMatch[2]),
            text,
        });
    }

    return cues;
}

// ── VTT Generation/Parsing ──────────────────────────────────────────

/**
 * VTT position map for cue settings
 */
const VTT_POSITIONS = {
    'top-left': 'position:10% line:5% align:start',
    'top-center': 'position:50% line:5% align:center',
    'top-right': 'position:90% line:5% align:end',
    'middle-center': 'position:50% line:50% align:center',
    'bottom-left': 'position:10% line:90% align:start',
    'bottom-center': 'position:50% line:90% align:center',
    'bottom-right': 'position:90% line:90% align:end',
};

/**
 * Generate WebVTT subtitle file content.
 * @param {Array} cues - [{ start_ms, end_ms, text, speaker?, position?, style?, is_cc? }]
 * @param {object} [options] - { language?, title? }
 * @returns {string} VTT content
 */
function generateVTT(cues, options = {}) {
    let vtt = 'WEBVTT';
    if (options.title) vtt += ` - ${options.title}`;
    vtt += '\n';
    if (options.language) vtt += `Language: ${options.language}\n`;
    vtt += '\n';

    if (!cues || cues.length === 0) return vtt;

    for (const cue of cues) {
        const start = msToVttTime(cue.start_ms || 0);
        const end = msToVttTime(cue.end_ms || 0);

        let settings = '';
        if (cue.position && VTT_POSITIONS[cue.position]) {
            settings = ' ' + VTT_POSITIONS[cue.position];
        }

        // CC styling: add speaker prefix for closed captions
        let text = cue.text || '';
        if (cue.is_cc && cue.speaker) {
            text = `>> ${cue.speaker}: ${text}`;
        } else if (cue.speaker) {
            text = `<v ${cue.speaker}>${text}</v>`;
        }

        // Apply style (bold, italic, color)
        let style = {};
        try { style = typeof cue.style === 'string' ? JSON.parse(cue.style) : (cue.style || {}); } catch (e) { console.error('[subtitle-generator] stored style is not valid JSON; using the default:', e.message); }
        if (style.bold) text = `<b>${text}</b>`;
        if (style.italic) text = `<i>${text}</i>`;
        if (style.color) text = `<c.${style.color}>${text}</c>`;

        vtt += `${start} --> ${end}${settings}\n`;
        vtt += `${text}\n\n`;
    }

    return vtt;
}

/**
 * Parse WebVTT content into cue array.
 * @param {string} vtt
 * @returns {Array} [{ start_ms, end_ms, text }]
 */
function parseVTT(vtt) {
    if (!vtt || typeof vtt !== 'string') return [];

    // Remove WEBVTT header and metadata
    const content = vtt.replace(/^WEBVTT[^\n]*\n/, '').replace(/^[A-Za-z]+:.*\n/gm, '');
    const blocks = content.trim().split(/\n\n+/);
    const cues = [];

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;

        // Find the timing line
        let timingLineIdx = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('-->')) {
                timingLineIdx = i;
                break;
            }
        }

        const timingLine = lines[timingLineIdx];
        const timeMatch = timingLine.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
        if (!timeMatch) continue;

        const text = lines.slice(timingLineIdx + 1).join('\n');

        cues.push({
            start_ms: vttTimeToMs(timeMatch[1]),
            end_ms: vttTimeToMs(timeMatch[2]),
            text,
        });
    }

    return cues;
}

// ── Format Conversion ───────────────────────────────────────────────

/**
 * Convert SRT to VTT
 * @param {string} srt
 * @returns {string} VTT content
 */
function srtToVtt(srt) {
    const cues = parseSRT(srt);
    return generateVTT(cues);
}

/**
 * Convert VTT to SRT
 * @param {string} vtt
 * @returns {string} SRT content
 */
function vttToSrt(vtt) {
    const cues = parseVTT(vtt);
    return generateSRT(cues);
}

module.exports = {    generateSRT,
    parseSRT,
    generateVTT,
    parseVTT,
    srtToVtt,
    vttToSrt,
    msToSrtTime,
    msToVttTime,
    srtTimeToMs,
    vttTimeToMs,};
