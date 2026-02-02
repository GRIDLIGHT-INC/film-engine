const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    QA_CHECKS, SEVERITY, ACCEPTANCE_RUBRIC,
} = require('../lib/qa-checker');

describe('qa-checker', () => {
    describe('QA_CHECKS', () => {
        it('has at least 10 checks', () => {
            assert.ok(QA_CHECKS.length >= 10);
        });

        it('all checks have required fields', () => {
            for (const check of QA_CHECKS) {
                assert.ok(check.id, `Missing id`);
                assert.ok(check.scope, `Missing scope for ${check.id}`);
                assert.ok(check.severity, `Missing severity for ${check.id}`);
                assert.ok(check.label, `Missing label for ${check.id}`);
            }
        });

        it('has checks for all scopes', () => {
            const scopes = QA_CHECKS.map(c => c.scope);
            assert.ok(scopes.includes('shot'));
            assert.ok(scopes.includes('scene'));
            assert.ok(scopes.includes('project'));
        });

        it('uses valid severity levels', () => {
            const validSeverities = [SEVERITY.error, SEVERITY.warning, SEVERITY.info];
            for (const check of QA_CHECKS) {
                assert.ok(validSeverities.includes(check.severity), `Invalid severity for ${check.id}: ${check.severity}`);
            }
        });
    });

    describe('SEVERITY', () => {
        it('has three levels', () => {
            assert.equal(SEVERITY.error, 'error');
            assert.equal(SEVERITY.warning, 'warning');
            assert.equal(SEVERITY.info, 'info');
        });
    });

    describe('ACCEPTANCE_RUBRIC', () => {
        it('has resolution criteria', () => {
            assert.ok(ACCEPTANCE_RUBRIC.resolution);
            assert.equal(ACCEPTANCE_RUBRIC.resolution.min_width, 1024);
            assert.equal(ACCEPTANCE_RUBRIC.resolution.min_height, 576);
        });

        it('has frame rate criteria', () => {
            assert.ok(ACCEPTANCE_RUBRIC.frame_rate);
            assert.ok(ACCEPTANCE_RUBRIC.frame_rate.min_fps > 0);
        });

        it('has audio level criteria', () => {
            assert.ok(ACCEPTANCE_RUBRIC.audio_levels);
            assert.ok(ACCEPTANCE_RUBRIC.audio_levels.min_lufs < 0);
            assert.ok(ACCEPTANCE_RUBRIC.audio_levels.max_lufs < 0);
        });

        it('has codec criteria', () => {
            assert.ok(ACCEPTANCE_RUBRIC.codec);
            assert.ok(ACCEPTANCE_RUBRIC.codec.video.includes('h264'));
            assert.ok(ACCEPTANCE_RUBRIC.codec.audio.includes('wav'));
        });

        it('has coverage criteria', () => {
            assert.ok(ACCEPTANCE_RUBRIC.dialogue_coverage);
            assert.ok(ACCEPTANCE_RUBRIC.shot_coverage);
            assert.ok(ACCEPTANCE_RUBRIC.shot_coverage.min_pct === 100);
        });

        it('all criteria have labels', () => {
            for (const [key, val] of Object.entries(ACCEPTANCE_RUBRIC)) {
                assert.ok(val.label, `Missing label for rubric ${key}`);
            }
        });
    });
});
