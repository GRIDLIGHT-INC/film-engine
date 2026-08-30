'use strict';

/**
 * -- A spot is a length, not an approximate length -------------------------
 *
 * A film runs as long as it runs. A commercial is BOUGHT by the second: a :30
 * that arrives at 30.4s is rejected by the station, and one that arrives at
 * 29.6s has paid for airtime it did not use. So the runtime is a hard target
 * rather than an outcome, and the engine's job is to refuse a plan that misses
 * it — on this file's own doctrine, the one `planConform` already follows for
 * missing shots: REFUSE rather than silently shorten.
 *
 * The frame count is the thing that has to be exact, and it is where the
 * frame-rate bug lived: `nle-export.js` carried `const FPS = 24` as the default
 * of every conversion helper, so any caller that forgot to pass a rate got a
 * 24fps timecode for a 29.97 broadcast spot. Every call site did pass one, which
 * is why nothing was wrong today — and is exactly the shape of defect that
 * arrives with the next caller and is invisible when it does.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'fe-spotdur-'));

const test = require('node:test');
const assert = require('node:assert');

const { msToFrames, timecodeToFrames, msToTimecode } = require('../lib/nle-export');

/*
 * The plan's own table, and the reason it is a table: 30s at 29.97 drop-frame
 * is 900 frames, not 899. Drop-frame drops NUMBERS, never frames, so the count
 * is the same as at 30fps — getting that backwards produces a spot one frame
 * short and a station rejection.
 */
const EXACT = [
    { ms: 30000, fps: 29.97, frames: 900 },
    { ms: 30000, fps: 25,    frames: 750 },
    { ms: 30000, fps: 30,    frames: 900 },
    { ms: 15000, fps: 29.97, frames: 450 },
    { ms: 15000, fps: 25,    frames: 375 },
    { ms: 15000, fps: 30,    frames: 450 },
    { ms: 10000, fps: 29.97, frames: 300 },
    { ms: 10000, fps: 25,    frames: 250 },
    { ms:  6000, fps: 29.97, frames: 180 },
    { ms:  6000, fps: 25,    frames: 150 },
    { ms:  6000, fps: 30,    frames: 180 },
];

test('every broadcast runtime resolves to its exact frame count', () => {
    for (const c of EXACT) {
        assert.equal(msToFrames(c.ms, c.fps), c.frames,
            `${c.ms / 1000}s at ${c.fps} is ${c.frames} frames, got ${msToFrames(c.ms, c.fps)}`);
    }
});

test('no conversion silently assumes 24fps when it is not told a rate', () => {
    /*
     * The bug, stated as a rule. A helper that defaults to 24 turns "the caller
     * forgot" into "this :30 is 720 frames" — which is a well-formed file, a
     * plausible number, and a rejected delivery.
     *
     * Refusing is the only safe answer: there is no rate that is right for an
     * unstated one, and 24 is right for exactly the medium a commercial is not.
     */
    for (const fn of [msToFrames, msToTimecode]) {
        assert.throws(() => fn(30000), /frame rate/i,
            `${fn.name}() accepted no frame rate — it will produce a 24fps answer for a 29.97 spot`);
    }
    assert.throws(() => timecodeToFrames('00:00:30:00'), /frame rate/i,
        'timecodeToFrames() accepted no frame rate');
});

test('the exported constant is gone, not merely unused', () => {
    /*
     * Left exported, it is available to the next module that wants "the fps"
     * and does not have one — which is how a default becomes a decision.
     */
    const nle = require('../lib/nle-export');
    assert.equal(nle.FPS, undefined,
        'nle-export still exports a hardcoded FPS; a rate belongs to a project, not to a module');
});
