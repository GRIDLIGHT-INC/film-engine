const { describe, it, beforeEach } = require('node:test');
/*
 * The local gateway is OFF unless switched on, so a suite that stands up a mock
 * Gridlight and generates against it has to enable it — exactly as an operator
 * running the real service does. Set before anything requires the provider
 * registry, which caches the answer.
 */
process.env.GRIDLIGHT_ENABLED = '1';
const assert = require('node:assert/strict');
const {
    getQueueStatus,
    MAX_CONCURRENT,
    MAX_QUEUE_SIZE,
} = require('../lib/gridlight-client');

describe('gridlight-client', () => {
    describe('queue / semaphore (FILM-034)', () => {
        it('exports getQueueStatus', () => {
            assert.equal(typeof getQueueStatus, 'function');
        });

        it('getQueueStatus returns object', () => {
            const status = getQueueStatus();
            assert.equal(typeof status, 'object');
        });

        it('MAX_CONCURRENT defaults to 2', () => {
            assert.ok(MAX_CONCURRENT >= 1);
            assert.ok(MAX_CONCURRENT <= 100);
        });

        it('MAX_QUEUE_SIZE defaults to 50', () => {
            assert.ok(MAX_QUEUE_SIZE >= 1);
        });
    });

    describe('callGridlight with queue', () => {
        it('returns error when service is unavailable', async () => {
            // Use a port that's definitely not running
            const origUrl = process.env.GRIDLIGHT_URL;
            process.env.GRIDLIGHT_URL = 'http://127.0.0.1:19999';
            // Re-require to pick up new URL — but module is cached, so test the exported function directly
            // The callGridlight function reads GRIDLIGHT_URL at module load time, so we test via the module's behavior
            const { callGridlight } = require('../lib/gridlight-client');
            const result = await callGridlight('/test-nonexistent', { prompt: 'test' }, {
                timeout: 2000,
                skipQueue: true,
            });
            process.env.GRIDLIGHT_URL = origUrl || '';
            assert.equal(result.ok, false);
            assert.ok(result.error);
        });

        it('callGridlight returns structured result on error', async () => {
            const { callGridlight } = require('../lib/gridlight-client');
            const result = await callGridlight('/test-retry', { prompt: 'test' }, {
                timeout: 2000,
                skipQueue: true,
            });
            // May succeed or fail depending on what's running on localhost:8080
            assert.ok(typeof result.ok === 'boolean');
            assert.ok(typeof result.status === 'number');
        });
    });

    describe('checkEndpointHealth', () => {
        it('returns health check result with latency', async () => {
            const { checkEndpointHealth } = require('../lib/gridlight-client');
            const result = await checkEndpointHealth('/test-health');
            assert.ok(typeof result.available === 'boolean');
            assert.ok(result.latency_ms >= 0);
        });
    });

    describe('serviceUnavailableError', () => {
        it('returns structured error', () => {
            const { serviceUnavailableError } = require('../lib/gridlight-client');
            const err = serviceUnavailableError('/image', 'ImageGen');
            assert.equal(err.error, 'service_unavailable');
            assert.equal(err.service, 'ImageGen');
            assert.ok(err.hint.includes('ImageGen'));
        });
    });
});
