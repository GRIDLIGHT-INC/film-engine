/**
 * What a director chose for THIS generation, rather than for the project.
 *
 * The quality tier is a project setting, which is the right default and the
 * wrong granularity for the moment that matters: someone looking at one frame
 * that came back badly wants to spend more on that frame, and someone trying
 * three compositions wants to spend less — neither wants to change a setting
 * and remember to put it back, which is how a whole board ends up shot on the
 * expensive tier because of one difficult shot.
 *
 * Read in ONE place because it is read by seven routes across four files, and
 * seven hand-written readings is how three of them come to accept `quality`
 * while a fourth silently ignores it.
 */

const { IMAGE_TIERS } = require('./quality-tiers');

/**
 * @param {object} body   the request body
 * @returns {object|null} a provider-config overlay, or null when nothing was asked
 */
function imageOverride(body) {
    const b = body || {};
    const out = {};

    const q = String(b.quality || '').toLowerCase();
    if (IMAGE_TIERS[q] || q === 'auto') out.image_quality = q;

    // The advanced escape hatch, per call. Validated against the provider by
    // withTierModel rather than here: a model only means anything relative to
    // one, and this function does not know which will run.
    if (typeof b.provider === 'string' && b.provider.trim()) out.image = b.provider.trim();
    if (typeof b.model === 'string' && b.model.trim()) out.image_model = b.model.trim().slice(0, 80);

    return Object.keys(out).length ? out : null;
}

/**
 * The prompt a director edited, or null.
 *
 * An override is the WHOLE prompt: nothing is appended after it, so a caller
 * sending back the unedited text would silently drop the references and the
 * style preset. That is the caller's decision to make deliberately, which is
 * why this only reads the field and never fills it in.
 */
function promptOverride(body) {
    const p = (body || {}).prompt_override;
    if (typeof p !== 'string') return null;
    const trimmed = p.trim();
    return trimmed ? trimmed : null;
}

module.exports = { imageOverride, promptOverride };
