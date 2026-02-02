const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    ASPECT_RATIOS,
    ASPECT_RATIO_IDS,
    RESOLUTIONS,
    RESOLUTION_IDS,
    COLOR_SPACES,
    COLOR_SPACE_IDS,
    FRAME_RATES,
    FRAME_RATE_VALUES,
    DELIVERY_PRESETS,
    DELIVERY_PRESET_IDS,
    validateProjectSettings,
    resolveDeliveryPreset,
    computeResolution,
    parseResolution,
} = require('../lib/project-presets');

describe('project-presets', () => {
    describe('ASPECT_RATIOS', () => {
        it('has 12 presets', () => {
            assert.equal(ASPECT_RATIOS.length, 12);
        });

        it('includes IMAX formats', () => {
            assert.ok(ASPECT_RATIO_IDS.includes('1.43:1'), 'Missing IMAX Full Frame');
            assert.ok(ASPECT_RATIO_IDS.includes('1.90:1'), 'Missing IMAX Digital');
        });

        it('includes standard cinema formats', () => {
            assert.ok(ASPECT_RATIO_IDS.includes('2.39:1'), 'Missing Anamorphic Scope');
            assert.ok(ASPECT_RATIO_IDS.includes('2.35:1'), 'Missing Panavision Scope');
            assert.ok(ASPECT_RATIO_IDS.includes('1.85:1'), 'Missing Flat Widescreen');
        });

        it('includes social/mobile formats', () => {
            assert.ok(ASPECT_RATIO_IDS.includes('9:16'), 'Missing Vertical');
            assert.ok(ASPECT_RATIO_IDS.includes('1:1'), 'Missing Square');
        });

        it('includes custom option', () => {
            assert.ok(ASPECT_RATIO_IDS.includes('custom'));
        });

        it('each preset has required fields', () => {
            for (const ar of ASPECT_RATIOS) {
                assert.ok(ar.id, `Missing id on ${JSON.stringify(ar)}`);
                assert.ok(ar.label, `Missing label on ${ar.id}`);
                assert.ok(ar.ratio, `Missing ratio on ${ar.id}`);
                if (ar.id !== 'custom') {
                    assert.equal(typeof ar.decimal, 'number', `decimal should be number on ${ar.id}`);
                    assert.ok(ar.decimal > 0, `decimal should be positive on ${ar.id}`);
                }
            }
        });
    });

    describe('RESOLUTIONS', () => {
        it('has 8 presets', () => {
            assert.equal(RESOLUTIONS.length, 8);
        });

        it('includes standard resolutions', () => {
            assert.ok(RESOLUTION_IDS.includes('1080p'));
            assert.ok(RESOLUTION_IDS.includes('4k_uhd'));
            assert.ok(RESOLUTION_IDS.includes('4k_dci'));
        });

        it('includes IMAX resolutions', () => {
            assert.ok(RESOLUTION_IDS.includes('imax_5.6k'));
            assert.ok(RESOLUTION_IDS.includes('imax_12k'));
        });

        it('each preset has valid dimensions', () => {
            for (const r of RESOLUTIONS) {
                assert.ok(r.width > 0, `width should be positive on ${r.id}`);
                assert.ok(r.height > 0, `height should be positive on ${r.id}`);
                assert.ok(r.width >= r.height || r.id === '9:16', `width >= height on ${r.id}`);
            }
        });
    });

    describe('COLOR_SPACES', () => {
        it('has 5 color spaces', () => {
            assert.equal(COLOR_SPACES.length, 5);
        });

        it('includes professional color spaces', () => {
            assert.ok(COLOR_SPACE_IDS.includes('DCI-P3'));
            assert.ok(COLOR_SPACE_IDS.includes('Rec.2020'));
            assert.ok(COLOR_SPACE_IDS.includes('ACES'));
        });
    });

    describe('FRAME_RATES', () => {
        it('has 8 frame rates', () => {
            assert.equal(FRAME_RATES.length, 8);
        });

        it('includes cinema standard 24fps', () => {
            assert.ok(FRAME_RATE_VALUES.includes(24));
        });

        it('includes drop-frame rates', () => {
            assert.ok(FRAME_RATE_VALUES.includes(23.976));
            assert.ok(FRAME_RATE_VALUES.includes(29.97));
        });

        it('marks drop-frame rates correctly', () => {
            const df = FRAME_RATES.filter(f => f.dropFrame);
            assert.equal(df.length, 2);
            assert.ok(df.some(f => f.fps === 23.976));
            assert.ok(df.some(f => f.fps === 29.97));
        });

        it('includes HFR rates', () => {
            assert.ok(FRAME_RATE_VALUES.includes(48));
            assert.ok(FRAME_RATE_VALUES.includes(60));
            assert.ok(FRAME_RATE_VALUES.includes(120));
        });
    });

    describe('DELIVERY_PRESETS', () => {
        it('has 6 presets', () => {
            assert.equal(DELIVERY_PRESETS.length, 6);
        });

        it('includes theatrical DCP', () => {
            const dcp = DELIVERY_PRESETS.find(p => p.id === 'theatrical_dcp');
            assert.ok(dcp);
            assert.equal(dcp.color_space, 'DCI-P3');
            assert.equal(dcp.aspect_ratio, '2.39:1');
        });

        it('includes IMAX preset', () => {
            const imax = DELIVERY_PRESETS.find(p => p.id === 'imax');
            assert.ok(imax);
            assert.equal(imax.aspect_ratio, '1.43:1');
            assert.equal(imax.color_space, 'DCI-P3');
        });

        it('includes social media preset', () => {
            const social = DELIVERY_PRESETS.find(p => p.id === 'social_media');
            assert.ok(social);
            assert.equal(social.aspect_ratio, '9:16');
            assert.equal(social.target_resolution, '1080x1920');
        });

        it('each preset has required fields', () => {
            for (const p of DELIVERY_PRESETS) {
                assert.ok(p.id, 'Missing id');
                assert.ok(p.label, `Missing label on ${p.id}`);
                assert.ok(p.target_resolution, `Missing target_resolution on ${p.id}`);
                assert.ok(p.aspect_ratio, `Missing aspect_ratio on ${p.id}`);
                assert.ok(p.target_fps > 0, `target_fps should be positive on ${p.id}`);
                assert.ok(p.color_space, `Missing color_space on ${p.id}`);
                assert.ok(p.codec, `Missing codec on ${p.id}`);
            }
        });
    });

    describe('validateProjectSettings', () => {
        it('accepts valid settings', () => {
            const result = validateProjectSettings({
                target_resolution: '1920x1080',
                target_fps: 24,
                aspect_ratio: '16:9',
                color_space: 'Rec.709',
                timecode_start: '01:00:00:00',
            });
            assert.equal(result.valid, true);
            assert.equal(result.errors.length, 0);
        });

        it('accepts empty object (all defaults)', () => {
            const result = validateProjectSettings({});
            assert.equal(result.valid, true);
        });

        it('rejects invalid resolution format', () => {
            const result = validateProjectSettings({ target_resolution: 'not-valid' });
            assert.equal(result.valid, false);
            assert.ok(result.errors[0].includes('target_resolution'));
        });

        it('rejects invalid fps', () => {
            const result = validateProjectSettings({ target_fps: -1 });
            assert.equal(result.valid, false);
            assert.ok(result.errors[0].includes('target_fps'));
        });

        it('rejects fps > 240', () => {
            const result = validateProjectSettings({ target_fps: 500 });
            assert.equal(result.valid, false);
        });

        it('rejects unknown aspect ratio', () => {
            const result = validateProjectSettings({ aspect_ratio: '3:2' });
            assert.equal(result.valid, false);
            assert.ok(result.errors[0].includes('aspect_ratio'));
        });

        it('rejects unknown color space', () => {
            const result = validateProjectSettings({ color_space: 'ProPhoto' });
            assert.equal(result.valid, false);
            assert.ok(result.errors[0].includes('color_space'));
        });

        it('rejects unknown delivery format', () => {
            const result = validateProjectSettings({ delivery_format: 'blu-ray' });
            assert.equal(result.valid, false);
        });

        it('accepts empty delivery format', () => {
            const result = validateProjectSettings({ delivery_format: '' });
            assert.equal(result.valid, true);
        });

        it('rejects invalid timecode format', () => {
            const result = validateProjectSettings({ timecode_start: '1:00:00:00' });
            assert.equal(result.valid, false);
            assert.ok(result.errors[0].includes('timecode_start'));
        });

        it('validates custom aspect ratio format', () => {
            const result = validateProjectSettings({
                aspect_ratio: 'custom',
                aspect_ratio_custom: '2.20:1',
            });
            assert.equal(result.valid, true);
        });

        it('rejects invalid custom aspect ratio', () => {
            const result = validateProjectSettings({
                aspect_ratio: 'custom',
                aspect_ratio_custom: 'wide',
            });
            assert.equal(result.valid, false);
        });

        it('collects multiple errors', () => {
            const result = validateProjectSettings({
                target_fps: -1,
                color_space: 'invalid',
                timecode_start: 'bad',
            });
            assert.equal(result.valid, false);
            assert.equal(result.errors.length, 3);
        });
    });

    describe('resolveDeliveryPreset', () => {
        it('resolves known preset', () => {
            const preset = resolveDeliveryPreset('imax');
            assert.ok(preset);
            assert.equal(preset.id, 'imax');
            assert.equal(preset.aspect_ratio, '1.43:1');
        });

        it('returns null for unknown preset', () => {
            const preset = resolveDeliveryPreset('nonexistent');
            assert.equal(preset, null);
        });

        it('resolves all 6 presets', () => {
            for (const id of DELIVERY_PRESET_IDS) {
                const preset = resolveDeliveryPreset(id);
                assert.ok(preset, `Failed to resolve ${id}`);
            }
        });
    });

    describe('computeResolution', () => {
        it('computes 16:9 at 1080 height', () => {
            const width = computeResolution('16:9', 1080);
            assert.equal(width, 1920);
        });

        it('computes 2.39:1 at 1080 height', () => {
            const width = computeResolution('2.39:1', 1080);
            assert.ok(width > 2500);
            assert.equal(width % 2, 0, 'Width should be even');
        });

        it('computes 1.43:1 at 4096 height (IMAX)', () => {
            const width = computeResolution('1.43:1', 4096);
            assert.ok(width > 5000);
            assert.equal(width % 2, 0);
        });

        it('computes 1:1 at 1080 height', () => {
            const width = computeResolution('1:1', 1080);
            assert.equal(width, 1080);
        });

        it('returns null for invalid ratio', () => {
            assert.equal(computeResolution('invalid', 1080), null);
        });

        it('returns null for zero denominator', () => {
            assert.equal(computeResolution('16:0', 1080), null);
        });

        it('always returns even numbers', () => {
            const width = computeResolution('2.35:1', 1080);
            assert.equal(width % 2, 0);
        });
    });

    describe('parseResolution', () => {
        it('parses valid resolution', () => {
            const r = parseResolution('1920x1080');
            assert.deepEqual(r, { width: 1920, height: 1080 });
        });

        it('parses 4K', () => {
            const r = parseResolution('3840x2160');
            assert.deepEqual(r, { width: 3840, height: 2160 });
        });

        it('returns null for invalid format', () => {
            assert.equal(parseResolution('1080p'), null);
            assert.equal(parseResolution(''), null);
            assert.equal(parseResolution(null), null);
        });
    });
});
