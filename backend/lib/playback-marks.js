/**
 * TWO MARKS ON THE FILM, TURNED INTO TWO OFFSETS IN A FILE.
 *
 * THIS IS A UNIT CONVERSION, and that is the whole reason it is a module.
 * Playback thinks in TIMELINE-ABSOLUTE milliseconds — `pb.localMs` plus the
 * entry's `start_ms` — while every repair takes CLIP-RELATIVE seconds, because
 * ffmpeg seeks within one file. A mark at 00:41 of the film is 3.2 seconds into
 * shot 2B, and handing 41 to the trim cuts a completely different piece of
 * footage. Nothing about that failure announces itself: it produces a valid,
 * playable, wrong repair.
 *
 * MIRRORED INTO THE SPA rather than imported by it. The page ships as one file
 * with no bundler (`build.target: single-html`), so it cannot require this —
 * and two rules that disagree is how a fix survives in the tests and not on the
 * screen. The two copies are held equal by test over a case table, because a
 * drifted mirror looks identical in source and differs only in an offset.
 */

const { MIN_DURATION } = require('./providers/seedance');

/** The provider's own floor, never a copy of the number. */
const MARK_FLOOR_S = MIN_DURATION;

/**
 * What the surface must let a person do.
 *
 * Declared so an operation with no control is visible — a handler wired to
 * nothing looks exactly like a working page until somebody clicks it, which is
 * the failure `previs-explore-ui` exists to catch.
 */
const MARK_OPERATIONS = Object.freeze([
    { id: 'mark_in', handler: 'pbMarkIn',
      why: 'sets the point the repair starts from, at the playhead — a director marks while watching' },
    { id: 'mark_out', handler: 'pbMarkOut',
      why: 'sets the point it must arrive at; the two together are the range that gets regenerated' },
    { id: 'clear', handler: 'pbClearMarks',
      why: 'marks are set by eye and got wrong constantly; without a way back the only remedy is reloading' },
]);

const MARK_REFUSALS = Object.freeze([
    { code: 'no_timeline', why: 'there is nothing to mark against, so any offset would be invented' },
    { code: 'marks_reversed', why: 'out before in runs the repair backwards and reads as a model fault' },
    { code: 'marks_empty', why: 'a zero-length range would spend on a generation nobody sees' },
    { code: 'marks_outside', why: 'a mark past the end of the film resolves to no clip at all' },
    { code: 'marks_too_far', why: 'the epic scopes this to one clip or two; three means the director '
        + 'is re-cutting rather than repairing, and joining across them silently would produce a film '
        + 'shorter than the one they were watching' },
]);

const refuse = (code, reason) => ({ ok: false, code, reason });
/* Milliseconds are the timeline's unit and seconds are the file's. Rounded to
 * the millisecond so a float does not turn 3 into 2.9999999999999996. */
const secs = (ms) => Math.round(ms) / 1000;

/**
 * Resolve two timeline positions to the clip offsets a repair can act on.
 * Never throws — playback calls this on every drag.
 */
function resolveMarks(entries, inMs, outMs) {
    const list = Array.isArray(entries) ? entries.filter(e => e && Number.isFinite(Number(e.start_ms))) : [];
    if (!list.length) return refuse('no_timeline', 'there is no timeline loaded to mark against');

    const a = Number(inMs);
    const b = Number(outMs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return refuse('marks_empty', 'both marks must be positions on the timeline');
    }
    if (b < a) return refuse('marks_reversed',
        'the out-mark is before the in-mark — reversed, the repair would run backwards');
    if (b === a) return refuse('marks_empty',
        'the two marks are at the same point, so there is nothing between them to replace');

    const total = Math.max(...list.map(e => Number(e.end_ms) || 0));
    if (a < 0 || b > total) {
        return refuse('marks_outside',
            `the marks run from ${secs(a)}s to ${secs(b)}s and the film is ${secs(total)}s long`);
    }

    /*
     * The clips the range actually touches. A mark exactly ON a cut belongs to
     * the clip it starts, which is what `pbSeekAbsolute` already does with its
     * half-open `>= start_ms && < end_ms` — matching it means the marks land on
     * the shot the playhead was showing.
     */
    const touched = list.filter(e => Number(e.end_ms) > a && Number(e.start_ms) < b);
    if (!touched.length) return refuse('marks_outside', 'the marks fall between clips, on no footage at all');
    if (touched.length > 2) {
        return refuse('marks_too_far',
            `the marks span ${touched.length} shots (${touched.map(e => e.shot_code).join(', ')}). `
            + 'A repair covers one shot or two; more than that is a re-cut rather than a repair.');
    }

    const spans = touched.map(e => {
        const from = Math.max(a, Number(e.start_ms));
        const to = Math.min(b, Number(e.end_ms));
        return {
            shot_id: e.shot_id || null,
            shot_code: e.shot_code || null,
            // THE CONVERSION. Relative to the clip's own start, in seconds.
            startSec: secs(from - Number(e.start_ms)),
            endSec: secs(to - Number(e.start_ms)),
            seconds: secs(to - from),
        };
    });

    const seconds = secs(b - a);
    return {
        ok: true,
        spans,
        crossClip: spans.length > 1,
        seconds,
        floor: MARK_FLOOR_S,
        meetsFloor: seconds >= MARK_FLOOR_S,
        inMs: a,
        outMs: b,
    };
}

module.exports = { resolveMarks, MARK_FLOOR_S, MARK_OPERATIONS, MARK_REFUSALS };
