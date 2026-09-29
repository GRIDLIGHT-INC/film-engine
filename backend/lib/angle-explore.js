/**
 * FOUR ANGLES ON ONE SHOT, then "I love B" and B is the shot.
 *
 * "When generating shots we should be able to generate boards of 4 different
 *  angles to explore options… and then be able to say I love option B and this
 *  becomes the shot." The director chose four SEPARATE generations over one
 *  2x2 grid in a single image, because the picked one has to be ready for the
 *  board as it is: a panel cut out of a grid is a quarter of a picture, and it
 *  would need a second paid pass before a video model could use it.
 *
 * So each angle is one ordinary board generation — the same payload path, the
 * same references, the same anchor, at the project's own resolution — with the
 * CAMERA changed on a copy of the card. The four come back as candidates, not
 * frames: nothing reaches `{code}.png` until one is picked, because an
 * exploration that replaced the board frame four times would leave the shot
 * showing whichever angle happened to finish last. Film Engine joins them into
 * one contact sheet locally, for nothing, so the four can be compared at a
 * glance.
 *
 * Nano Banana Pro has no "give me four" field on any vendor, and the vendors
 * that return several images return variations of ONE prompt — four near-copies
 * of the same framing, which is the opposite of exploring angles. The variety
 * has to be asked for, one camera per request.
 */

const SLOTS = Object.freeze(['A', 'B', 'C', 'D']);

/**
 * The four angles a shot is explored with when nobody names them. Each is a
 * change to the CARD's camera, never to what the shot is about: the action,
 * the cast and the place stay exactly as written, which is what makes the four
 * comparable. `card` returns a new card; the original is not touched.
 *
 * A is the shot as written, because "is what I wrote the best of these" is
 * half of the question — an exploration with no control is four guesses.
 */
const DEFAULT_ANGLES = Object.freeze([
    Object.freeze({
        label: 'As written',
        direction: '',
        card: c => c,
    }),
    Object.freeze({
        label: 'Reverse angle',
        direction: 'Camera: the reverse angle — the camera on the opposite side of the action, '
            + 'looking back the way the written angle looks.',
        card: c => c,
    }),
    Object.freeze({
        label: 'Low angle, wider',
        direction: 'Camera: low, close to the ground, looking up at the subject; a wider frame '
            + 'that shows more of the place.',
        card: c => ({ ...c, camera: { ...(c.camera || {}), height_m: 0.4, shot_type: 'wide' } }),
    }),
    Object.freeze({
        label: 'High angle, tighter',
        direction: 'Camera: high, above eye level, looking down on the subject; a tighter frame.',
        card: c => ({ ...c, camera: { ...(c.camera || {}), height_m: 2.6, shot_type: 'medium' } }),
    }),
]);

const MAX_DIRECTION = 400;

/**
 * The angles for one exploration: the four defaults, or the ones a caller
 * named — a person on the page, or the connected model composing four cameras
 * it chose for this shot. A named angle is a sentence about the camera; fewer
 * than four are filled from the defaults so there are always four to compare.
 */
function resolveAngles(requested) {
    const given = Array.isArray(requested) ? requested.slice(0, SLOTS.length) : [];
    const out = [];
    for (let i = 0; i < SLOTS.length; i++) {
        const g = given[i];
        const text = typeof g === 'string' ? g : (g && (g.direction || g.label)) || '';
        const clean = String(text).trim().slice(0, MAX_DIRECTION);
        if (clean) {
            const label = (g && typeof g === 'object' && g.label) ? String(g.label).slice(0, 60) : clean.slice(0, 60);
            out.push({ slot: SLOTS[i], label, direction: clean.startsWith('Camera') ? clean : `Camera: ${clean}`,
                card: c => c, named: true });
        } else {
            const d = DEFAULT_ANGLES[i];
            out.push({ slot: SLOTS[i], label: d.label, direction: d.direction, card: d.card, named: false });
        }
    }
    return out;
}

/**
 * The card one angle generates from: the angle's camera change, and its
 * direction written AFTER whatever direction the director already gave — the
 * screenplay leads, the director's words follow, the camera for this angle is
 * last. Direction is the field the prompt builder already carries for exactly
 * this, so no second prompt path exists for an exploration.
 */
function cardForAngle(card, angle) {
    const base = angle.card({ ...(card || {}) });
    if (!angle.direction) return base;
    const prior = String(base.direction || '').trim();
    return { ...base, direction: prior ? `${prior} ${angle.direction}` : angle.direction };
}

/** A new exploration's token: one per press, so four candidates stay together. */
function newToken() {
    return require('crypto').randomBytes(4).toString('hex');
}

function candidateFileName(shotCode, token, slot) {
    return `${String(shotCode).replace(/[^A-Za-z0-9_-]/g, '_')}_angles_${token}_${slot}.png`;
}

function sheetFileName(shotCode, token) {
    return `${String(shotCode).replace(/[^A-Za-z0-9_-]/g, '_')}_angles_${token}_sheet.png`;
}

/**
 * The ffmpeg arguments that join four pictures into one 2x2 contact sheet, A
 * top-left, B top-right, C bottom-left, D bottom-right — the order the letters
 * are read in. Each tile is scaled to one tile size first, because xstack needs
 * equal inputs and a provider can answer a pixel or two off its grid. An array,
 * never a shell string: the paths come from the database.
 */
function sheetArgs(inputs, output, tile) {
    const w = Math.max(2, Math.round(tile.width / 2) * 2);
    const h = Math.max(2, Math.round(tile.height / 2) * 2);
    const args = ['-y'];
    for (const f of inputs) args.push('-i', f);
    const scaled = inputs.map((_, i) => `[${i}:v]scale=${w}:${h},setsar=1[t${i}]`).join(';');
    const pads = inputs.map((_, i) => `[t${i}]`).join('');
    const layout = ['0_0', `${w}_0`, `0_${h}`, `${w}_${h}`].slice(0, inputs.length).join('|');
    args.push('-filter_complex', `${scaled};${pads}xstack=inputs=${inputs.length}:layout=${layout}[out]`,
        '-map', '[out]', '-update', '1', output);
    return args;
}

/**
 * Join the candidates into one sheet. Free and local; never fails the
 * exploration — four candidates with no sheet are still four candidates.
 */
function buildSheet(inputs, output, tile) {
    if (!inputs.length) return { ok: false, reason: 'no candidates to join' };
    const { resolveFfmpeg } = require('./ffmpeg');
    const ff = resolveFfmpeg();
    if (!ff || !ff.available) return { ok: false, reason: (ff && ff.reason) || 'no encoder' };
    try {
        require('child_process').execFileSync(ff.bin, ['-nostdin', ...sheetArgs(inputs, output, tile)], { stdio: 'ignore', timeout: 60000 });
        return { ok: true, path: output };
    } catch (err) {
        return { ok: false, reason: `the sheet could not be joined: ${err.message}` };
    }
}

module.exports = {
    SLOTS, DEFAULT_ANGLES, resolveAngles, cardForAngle, newToken,
    candidateFileName, sheetFileName, sheetArgs, buildSheet,
};
