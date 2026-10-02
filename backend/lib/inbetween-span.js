'use strict';

/**
 * IN-BETWEENS BETWEEN TWO KEY SHOTS.
 *
 * "Say we have a storyboard shot 1A and then 1B, and in between those shots we
 * have 10 seconds. I connect the two nodes, add an in-betweens node, say 4 shots
 * every 2 seconds, and direct each one: more smile, tears. And decide where the
 * changes apply: between second 2 and 4 the head turns quickly, from 4 to 10 the
 * character starts crying."
 *
 * lib/inbetweens.js densifies ONE shot from its camera move. This is the other
 * thing a director means by in-betweens: the seconds BETWEEN two approved
 * pictures, with a frame placed wherever they choose and directed by hand. It is
 * pure: the route reads rows and buys pictures, this decides what each frame is
 * and what it is asked for.
 *
 * Time is milliseconds from 1A (0) to 1B (gap_ms). A frame sits strictly inside.
 * Ranges are what happens over a stretch of that time, on a LANE (movement,
 * emotion, camera, other), so "the head turns" and "she starts crying" can
 * overlap without one overwriting the other.
 */

const crypto = require('crypto');

const LANES = Object.freeze(['movement', 'emotion', 'camera', 'other']);
const LANE_LABEL = Object.freeze({ movement: 'Movement', emotion: 'Emotion', camera: 'Camera', other: 'Also' });
const MAX_FRAMES = 29;          // Seedance 2.5's 30 pictures, less the first key
const MAX_RANGES = 24;
const MAX_TEXT = 500;
const MIN_SPACING_MS = 100;     // two frames closer than this are one moment

const secs = ms => (Math.round(Number(ms) / 100) / 10).toFixed(1);

function bad(message, field) {
    const e = new Error(message);
    e.status = 400; e.code = 'INVALID'; if (field) e.field = field;
    return e;
}

/** N frames spread evenly across the gap: 10 s with 4 is 2, 4, 6, 8. */
function evenTimes(gapMs, count) {
    const n = Math.max(0, Math.min(MAX_FRAMES, Math.floor(Number(count) || 0)));
    return Array.from({ length: n }, (_, i) => Math.round(gapMs * (i + 1) / (n + 1)));
}

/** "One every 2 s" over 10 s is 4 frames: the keys sit at 0 and 10. */
function countForEvery(gapMs, everyMs) {
    const e = Number(everyMs);
    if (!(e > 0)) throw bad('every_s must be more than zero', 'every_s');
    return Math.max(1, Math.min(MAX_FRAMES, Math.round(gapMs / e) - 1));
}

/** Frames as stored: in time order, inside the gap, not on top of each other. */
function validateFrames(frames, gapMs) {
    if (!Array.isArray(frames)) throw bad('frames must be a list', 'frames');
    if (frames.length > MAX_FRAMES) throw bad(`at most ${MAX_FRAMES} in-betweens fit one clip`, 'frames');
    const out = frames.map((f, i) => {
        const at = Math.round(Number(f && f.at_ms));
        if (!Number.isFinite(at) || at <= 0 || at >= gapMs) {
            throw bad(`frame ${i + 1} must sit between 0 and ${secs(gapMs)} s (it says ${secs(f && f.at_ms)} s)`, 'frames');
        }
        const direction = String((f && f.direction) || '').trim();
        if (direction.length > MAX_TEXT) throw bad(`frame ${i + 1}'s direction is over ${MAX_TEXT} characters`, 'frames');
        return { at_ms: at, direction };
    }).sort((a, b) => a.at_ms - b.at_ms);
    for (let i = 1; i < out.length; i++) {
        if (out[i].at_ms - out[i - 1].at_ms < MIN_SPACING_MS) {
            throw bad(`two frames at ${secs(out[i].at_ms)} s are the same moment; move one`, 'frames');
        }
    }
    return out;
}

/** Ranges as stored: on a lane, inside the gap, with words. */
function validateRanges(ranges, gapMs) {
    if (!Array.isArray(ranges)) throw bad('ranges must be a list', 'ranges');
    if (ranges.length > MAX_RANGES) throw bad(`at most ${MAX_RANGES} ranges`, 'ranges');
    return ranges.map((r, i) => {
        const lane = String((r && r.lane) || '');
        if (!LANES.includes(lane)) throw bad(`range ${i + 1}: lane must be one of ${LANES.join(', ')}`, 'ranges');
        const start = Math.round(Number(r.start_ms)), end = Math.round(Number(r.end_ms));
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > gapMs || end <= start) {
            throw bad(`range ${i + 1} must run forwards inside 0–${secs(gapMs)} s`, 'ranges');
        }
        const text = String(r.text || '').trim();
        if (!text) throw bad(`range ${i + 1} says nothing; give it a direction`, 'ranges');
        if (text.length > MAX_TEXT) throw bad(`range ${i + 1} is over ${MAX_TEXT} characters`, 'ranges');
        return { id: String(r.id || crypto.randomBytes(4).toString('hex')), lane, start_ms: start, end_ms: end, text };
    }).sort((a, b) => a.start_ms - b.start_ms || LANES.indexOf(a.lane) - LANES.indexOf(b.lane));
}

/** The ranges a moment falls in. A range's end belongs to it: 2–4 s covers the frame at 4 s. */
function rangesAt(ranges, atMs) {
    return (ranges || []).filter(r => atMs >= r.start_ms && atMs <= r.end_ms);
}

/** The ranges that act on a stretch, for a leg of footage between two pictures. */
function rangesOver(ranges, fromMs, toMs) {
    return (ranges || []).filter(r => r.start_ms < toMs && r.end_ms > fromMs);
}

function rangeLine(r) {
    return `${LANE_LABEL[r.lane] || r.lane} (${secs(r.start_ms)}–${secs(r.end_ms)} s): ${r.text}`;
}

/**
 * What one frame is asked for.
 *
 * Two pictures go with it, and each is named by its JOB, because two pictures
 * with no jobs named leave the model to guess which to reproduce: the FIRST is
 * the moment just before (1A or the previous in-between), the SECOND is where
 * the move arrives (1B). The frame is said as a fraction of the way between
 * them, so 4 s of a 10 s move after a frame at 2 s is a quarter of the way on.
 */
function frameInstruction(span, index) {
    const f = span.frames[index];
    const prevAt = index === 0 ? 0 : span.frames[index - 1].at_ms;
    const prevName = index === 0 ? span.from_code : `the in-between at ${secs(prevAt)} s`;
    const along = Math.round(((f.at_ms - prevAt) / Math.max(1, span.gap_ms - prevAt)) * 100);
    const acting = rangesAt(span.ranges, f.at_ms);
    const parts = [
        `In-between ${index + 1} of ${span.frames.length} in a ${secs(span.gap_ms)} s move from ${span.from_code} to ${span.to_code}: `
        + `the moment ${secs(f.at_ms)} s in.`,
        `The FIRST picture is the moment just before (${prevName} at ${secs(prevAt)} s). `
        + `The SECOND picture is where the move arrives (${span.to_code} at ${secs(span.gap_ms)} s). `
        + `Make the frame about ${along}% of the way from the first to the second.`,
        'Keep the same place, the same people, the same wardrobe and the same light, and do not copy the second picture: this moment comes before it.',
    ];
    for (const r of acting) parts.push(rangeLine(r) + '.');
    if (f.direction) parts.push(`This frame: ${f.direction}.`);
    return parts.join(' ');
}

/** What the footage is asked for between two neighbouring pictures (one leg). */
function legPrompt(span, fromMs, toMs, base) {
    const lines = [base || `Continuous action from ${span.from_code} to ${span.to_code}.`];
    lines.push(`This stretch runs from ${secs(fromMs)} s to ${secs(toMs)} s of the move; begin exactly on the first frame and end exactly on the last.`);
    for (const r of rangesOver(span.ranges, fromMs, toMs)) lines.push(rangeLine(r) + '.');
    const arriving = span.frames.find(f => f.at_ms === toMs);
    if (arriving && arriving.direction) lines.push(`By ${secs(toMs)} s: ${arriving.direction}.`);
    return lines.join(' ');
}

/** What the footage is asked for when every picture goes in one generation. */
function wholePrompt(span, base) {
    const lines = [base || `One continuous ${secs(span.gap_ms)} s shot from ${span.from_code} to ${span.to_code}.`];
    lines.push(`It starts on ${span.from_code} and ends on ${span.to_code}. The in-between pictures are moments along the way, in order:`);
    span.frames.forEach((f, i) => lines.push(`picture ${i + 1} at ${secs(f.at_ms)} s${f.direction ? ` (${f.direction})` : ''};`));
    for (const r of span.ranges) lines.push(rangeLine(r) + '.');
    return lines.join(' ');
}

/**
 * The strip as one value: each frame's moment, its direction and the picture
 * standing there, plus every range. Changing any of it changes what the footage
 * would be, so an approval is checked against this.
 */
function spanFingerprint(span, assetIds) {
    const material = JSON.stringify({
        gap: span.gap_ms,
        frames: span.frames.map((f, i) => [f.at_ms, f.direction, (assetIds || [])[i] || '']),
        ranges: span.ranges.map(r => [r.lane, r.start_ms, r.end_ms, r.text]),
    });
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Which frames a regeneration redoes. A frame is made FROM the one before it,
 * so redoing frame 2 leaves frames 3 and on built on a picture that is gone,
 * unless the director says to keep them.
 */
function framesToRun(count, fromIndex, only) {
    const from = Math.max(0, Math.min(count, Number.isFinite(Number(fromIndex)) ? Number(fromIndex) : 0));
    if (only) return from < count ? [from] : [];
    return Array.from({ length: Math.max(0, count - from) }, (_, i) => from + i);
}

module.exports = {
    LANES, MAX_FRAMES, MAX_RANGES, MIN_SPACING_MS,
    evenTimes, countForEvery, validateFrames, validateRanges, rangesAt, rangesOver,
    frameInstruction, legPrompt, wholePrompt, spanFingerprint, framesToRun,
};
