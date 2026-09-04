/**
 * An approval is a decision about a SPECIFIC set of inputs.
 *
 * Between the moment somebody says yes and the moment the work runs, a plate
 * can be regenerated, a card edited, a strip changed. Without a re-check,
 * "I approved that" and "that is what ran" are two different claims, and
 * nothing in the system can tell them apart afterwards.
 *
 * SO THE RE-CHECK LIVES HERE, AND ONLY HERE.
 *
 * Only this repo knows what its own inputs are — the fingerprint IS the
 * payload a provider would receive — so only this repo can say whether they
 * still match. Anything outside that tried to validate an approval would be
 * comparing two numbers it did not compute and could not re-derive, which is
 * guessing with extra steps.
 *
 * The contract is the one `previs_approve` already carries: refuse with
 * 409 STALE_APPROVAL, name what moved, and hand back a fresh envelope rather
 * than proceeding. A refusal that cannot be acted on is worse than none, so it
 * says which artefact changed and what to call to get a current packet.
 */

const { fingerprintFor, ARTEFACT_KINDS } = require('./artefact-fingerprint');

/** The field a request carries to say "this was approved". */
const FIELD = 'approval_fingerprint';

/** And the kind it was approved against, when it is not the default. */
const KIND_FIELD = 'approval_kind';

/**
 * The default artefact a shot-scoped approval is about.
 *
 * `keyframe` because a pre-spend decision on a shot is overwhelmingly about
 * the frame — and because a wrong default here fails CLOSED: the fingerprint
 * simply will not match, and the caller is told to re-raise rather than being
 * waved through against the wrong artefact.
 */
const DEFAULT_KIND = 'keyframe';

/**
 * Re-derive and compare.
 *
 * @returns {{ok:true}} or {{ok:false, code, error, ...}} — never throws. A
 *   guard that throws on an unreadable input would take down a request that
 *   carried a perfectly good approval, which is the opposite of protecting it.
 */
function checkApproval(body, subject) {
    const b = body || {};
    const approved = b[FIELD];
    // No claim, nothing to check. This is the ordinary path for every request
    // that was never approved remotely, and it must stay free.
    if (!approved) return { ok: true, checked: false };

    const s = subject || {};
    const kind = String(b[KIND_FIELD] || s.kind || DEFAULT_KIND);
    if (!ARTEFACT_KINDS[kind]) {
        return {
            ok: false, code: 'STALE_APPROVAL', status: 409,
            error: `this approval names artefact kind '${kind}', which this engine does not know`,
            remedy: 'raise a fresh envelope with approval_envelope',
        };
    }
    if (!s.shotId && !s.sceneId) {
        return {
            ok: false, code: 'STALE_APPROVAL', status: 409,
            error: 'this request carries an approval and does not name what it is about',
            remedy: 'raise a fresh envelope with approval_envelope',
        };
    }

    let current = null;
    try {
        current = fingerprintFor(kind, { shotId: s.shotId, sceneId: s.sceneId });
    } catch (err) {
        // The inputs cannot be read — a deleted subject, an unbuildable
        // payload. That is not a match, and treating it as one would honour an
        // approval for something that no longer exists.
        return {
            ok: false, code: 'STALE_APPROVAL', status: 409,
            error: 'the inputs this was approved against can no longer be read',
            detail: String(err && err.message || err),
            remedy: 'raise a fresh envelope with approval_envelope',
        };
    }

    if (current && current === approved) return { ok: true, checked: true, fingerprint: current };

    return {
        ok: false, code: 'STALE_APPROVAL', status: 409,
        error: 'the inputs changed after this was approved, so it no longer describes what would run',
        approved_fingerprint: approved,
        current_fingerprint: current,
        artefact_kind: kind,
        // Named, because "stale" with no next step is a dead end at the exact
        // moment somebody is trying to get work done.
        remedy: 'raise a fresh envelope with approval_envelope and approve that one',
    };
}

/**
 * What a URL is about, read from its own shape.
 *
 * Derived rather than declared per route: an approval guard that had to be
 * wired into each paid endpoint would be wired into most of them, and the one
 * it missed is the one that runs unapproved work. Every generating route in
 * this codebase names its subject in the path.
 */
function subjectOf(urlParts) {
    const parts = urlParts || [];
    for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === 'shots') return { shotId: parts[i + 1] };
        if (parts[i] === 'scenes') return { sceneId: parts[i + 1] };
    }
    return {};
}

module.exports = { checkApproval, subjectOf, FIELD, KIND_FIELD, DEFAULT_KIND };
