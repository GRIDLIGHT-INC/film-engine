const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    generateSRT,
    parseSRT,
    generateVTT,
    parseVTT,
    srtToVtt,
    vttToSrt,
    msToSrtTime,
    msToVttTime,
    srtTimeToMs,
    vttTimeToMs,
} = require('../lib/subtitle-generator');

// ── Timecode Helpers ────────────────────────────────────────────────

describe('msToSrtTime', () => {
    it('converts 0 to 00:00:00,000', () => {
        assert.equal(msToSrtTime(0), '00:00:00,000');
    });

    it('converts 1500ms', () => {
        assert.equal(msToSrtTime(1500), '00:00:01,500');
    });

    it('converts 1 hour', () => {
        assert.equal(msToSrtTime(3600000), '01:00:00,000');
    });

    it('handles negative as 0', () => {
        assert.equal(msToSrtTime(-100), '00:00:00,000');
    });
});

describe('msToVttTime', () => {
    it('converts 0 to 00:00:00.000', () => {
        assert.equal(msToVttTime(0), '00:00:00.000');
    });

    it('uses period instead of comma', () => {
        assert.equal(msToVttTime(1500), '00:00:01.500');
    });
});

describe('srtTimeToMs', () => {
    it('parses valid SRT timecode', () => {
        assert.equal(srtTimeToMs('00:01:30,500'), 90500);
    });

    it('returns 0 for invalid', () => {
        assert.equal(srtTimeToMs('bad'), 0);
    });
});

describe('vttTimeToMs', () => {
    it('parses valid VTT timecode', () => {
        assert.equal(vttTimeToMs('00:01:30.500'), 90500);
    });

    it('returns 0 for invalid', () => {
        assert.equal(vttTimeToMs('bad'), 0);
    });
});

// ── SRT ─────────────────────────────────────────────────────────────

describe('generateSRT', () => {
    it('generates valid SRT with numbering', () => {
        const cues = [
            { start_ms: 0, end_ms: 2000, text: 'Hello world' },
            { start_ms: 3000, end_ms: 5000, text: 'Second line' },
        ];
        const srt = generateSRT(cues);
        assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:02,000\nHello world'));
        assert.ok(srt.includes('2\n00:00:03,000 --> 00:00:05,000\nSecond line'));
    });

    it('returns empty string for no cues', () => {
        assert.equal(generateSRT([]), '');
        assert.equal(generateSRT(null), '');
    });

    it('includes speaker as italic prefix', () => {
        const cues = [{ start_ms: 0, end_ms: 1000, text: 'Hello', speaker: 'John' }];
        const srt = generateSRT(cues);
        assert.ok(srt.includes('<i>John:</i> Hello'));
    });
});

describe('parseSRT', () => {
    it('parses valid SRT content', () => {
        const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n2\n00:00:03,000 --> 00:00:05,000\nSecond line\n';
        const cues = parseSRT(srt);
        assert.equal(cues.length, 2);
        assert.equal(cues[0].start_ms, 0);
        assert.equal(cues[0].end_ms, 2000);
        assert.equal(cues[0].text, 'Hello world');
        assert.equal(cues[1].start_ms, 3000);
    });

    it('handles multiline text', () => {
        const srt = '1\n00:00:00,000 --> 00:00:02,000\nLine 1\nLine 2\n';
        const cues = parseSRT(srt);
        assert.equal(cues[0].text, 'Line 1\nLine 2');
    });

    it('returns empty for invalid input', () => {
        assert.deepEqual(parseSRT(''), []);
        assert.deepEqual(parseSRT(null), []);
    });
});

// ── VTT ─────────────────────────────────────────────────────────────

describe('generateVTT', () => {
    it('starts with WEBVTT header', () => {
        const vtt = generateVTT([]);
        assert.ok(vtt.startsWith('WEBVTT'));
    });

    it('includes title in header', () => {
        const vtt = generateVTT([], { title: 'My Subs' });
        assert.ok(vtt.includes('WEBVTT - My Subs'));
    });

    it('includes language metadata', () => {
        const vtt = generateVTT([], { language: 'en' });
        assert.ok(vtt.includes('Language: en'));
    });

    it('generates valid cues', () => {
        const cues = [
            { start_ms: 0, end_ms: 2000, text: 'Hello' },
        ];
        const vtt = generateVTT(cues);
        assert.ok(vtt.includes('00:00:00.000 --> 00:00:02.000'));
        assert.ok(vtt.includes('Hello'));
    });

    it('adds position settings', () => {
        const cues = [
            { start_ms: 0, end_ms: 1000, text: 'Top', position: 'top-center' },
        ];
        const vtt = generateVTT(cues);
        assert.ok(vtt.includes('line:5%'));
    });

    it('formats CC speaker with >> prefix', () => {
        const cues = [
            { start_ms: 0, end_ms: 1000, text: 'Hello', speaker: 'John', is_cc: true },
        ];
        const vtt = generateVTT(cues);
        assert.ok(vtt.includes('>> John: Hello'));
    });

    it('formats non-CC speaker with voice tag', () => {
        const cues = [
            { start_ms: 0, end_ms: 1000, text: 'Hello', speaker: 'John', is_cc: false },
        ];
        const vtt = generateVTT(cues);
        assert.ok(vtt.includes('<v John>Hello</v>'));
    });

    it('applies bold style', () => {
        const cues = [
            { start_ms: 0, end_ms: 1000, text: 'Bold text', style: { bold: true } },
        ];
        const vtt = generateVTT(cues);
        assert.ok(vtt.includes('<b>Bold text</b>'));
    });
});

describe('parseVTT', () => {
    it('parses valid VTT content', () => {
        const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n\n00:00:03.000 --> 00:00:05.000\nWorld\n';
        const cues = parseVTT(vtt);
        assert.equal(cues.length, 2);
        assert.equal(cues[0].start_ms, 0);
        assert.equal(cues[0].end_ms, 2000);
        assert.equal(cues[0].text, 'Hello');
    });

    it('handles metadata headers', () => {
        const vtt = 'WEBVTT - Title\nLanguage: en\n\n00:00:00.000 --> 00:00:01.000\nText\n';
        const cues = parseVTT(vtt);
        assert.equal(cues.length, 1);
        assert.equal(cues[0].text, 'Text');
    });

    it('returns empty for invalid input', () => {
        assert.deepEqual(parseVTT(''), []);
        assert.deepEqual(parseVTT(null), []);
    });
});

// ── Format Conversion ───────────────────────────────────────────────

describe('srtToVtt', () => {
    it('converts SRT to VTT format', () => {
        const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:05,000\nWorld\n';
        const vtt = srtToVtt(srt);
        assert.ok(vtt.startsWith('WEBVTT'));
        assert.ok(vtt.includes('00:00:00.000 --> 00:00:02.000'));
        assert.ok(vtt.includes('Hello'));
    });
});

describe('vttToSrt', () => {
    it('converts VTT to SRT format', () => {
        const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n\n00:00:03.000 --> 00:00:05.000\nWorld\n';
        const srt = vttToSrt(vtt);
        assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:02,000\nHello'));
        assert.ok(srt.includes('2\n00:00:03,000 --> 00:00:05,000\nWorld'));
    });
});

// ── Round-trip ──────────────────────────────────────────────────────

describe('round-trip', () => {
    const cues = [
        { start_ms: 1000, end_ms: 3500, text: 'First subtitle' },
        { start_ms: 4000, end_ms: 6000, text: 'Second subtitle' },
        { start_ms: 7000, end_ms: 10000, text: 'Third subtitle' },
    ];

    it('SRT generate → parse preserves timings', () => {
        const srt = generateSRT(cues);
        const parsed = parseSRT(srt);
        assert.equal(parsed.length, 3);
        assert.equal(parsed[0].start_ms, 1000);
        assert.equal(parsed[0].end_ms, 3500);
        assert.equal(parsed[0].text, 'First subtitle');
        assert.equal(parsed[2].start_ms, 7000);
    });

    it('VTT generate → parse preserves timings', () => {
        const vtt = generateVTT(cues);
        const parsed = parseVTT(vtt);
        assert.equal(parsed.length, 3);
        assert.equal(parsed[0].start_ms, 1000);
        assert.equal(parsed[0].end_ms, 3500);
        assert.equal(parsed[0].text, 'First subtitle');
    });

    it('SRT → VTT → SRT preserves content', () => {
        const original = generateSRT(cues);
        const vtt = srtToVtt(original);
        const backToSrt = vttToSrt(vtt);
        const parsed = parseSRT(backToSrt);
        assert.equal(parsed.length, 3);
        assert.equal(parsed[0].start_ms, 1000);
        assert.equal(parsed[1].text, 'Second subtitle');
    });
});
