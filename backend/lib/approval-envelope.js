/**
 * The decision packet: everything a person needs to say yes or no, as data.
 *
 * Two moments need one, and they are not the same decision.
 *
 *   PRE-SPEND     — "may I run this?" No picture exists. What decides it is
 *                   numbers and words: the prompt that will actually be sent,
 *                   which references are attached, the tier, the estimate.
 *   TAKE SELECTION — "is this the take?" The pictures exist and ARE the
 *                   decision, and every attempt is already archived.
 *
 * NOTHING HERE IS NEW COMPUTATION. Every number in a pre-spend envelope is
 * already produced, for free, by a tool that exists — the prompt preview, the
 * video preview, the plan. This is one shape over them, and it is assembled
 * from their real answers rather than recomputed, because a packet that
 * disagrees with the tool it claims to summarise is worse than no packet.
 *
 * `warnings` IS WHAT MAKES A DECISION INFORMED. A stale plate, a subject with
 * no declared size, a prompt whose tail is being cut — none of that is visible
 * in a picture, and all of it changes the answer. An envelope with no warnings
 * array is a yes/no button with the reasoning removed.
 *
 * MEDIA TRAVELS AS ABSOLUTE PATHS, and says so. A serving URL only resolves on
 * the LAN, which is exactly where the person deciding is not. `transport` is
 * carried explicitly so the day this has to become bytes or a fetchable URL is
 * a one-line change rather than a silent set of broken attachments.
 *
 * Pure: shapes what it is given. The route does the reading, which is what
 * keeps this testable with nothing else on the machine.
 */

const path = require('path');

/** The two kinds of decision, named so a consumer never guesses from shape. */
const ENVELOPE_KINDS = Object.freeze(['pre_spend', 'take_selection']);

/**
 * How media reaches whoever is deciding.
 *
 * One value today. It is a field rather than an assumption precisely because
 * the assumption — same machine, readable path — is the one thing here that a
 * change of deployment breaks silently.
 */
const MEDIA_TRANSPORT = 'path';

/** How long an envelope is worth acting on without re-raising it. A HINT. */
const EXPIRES_HINT_S = 3600;

/**
 * Every warning this can carry, declared.
 *
 * A registry rather than strings built at the call site, because the failure is
 * partial by nature: emitting four of five reads as a clean envelope, and the
 * missing one is the reason the frame comes back wrong. Each says what it
 * means and what to do, since a warning nobody can act on is one people learn
 * to scroll past.
 */
const WARNINGS = Object.freeze([
    {
        id: 'missing_plate', severity: 'warn',
        why: 'a subject in this shot has no reference plate, so the model will invent it — '
            + 'and invent it differently in every shot it appears in',
    },
    {
        id: 'stale_inputs', severity: 'warn',
        why: 'something this was generated from has changed since; the result will not match '
            + 'what is on the board',
    },
    {
        id: 'prompt_truncated', severity: 'warn',
        why: 'the composed prompt is over the provider\'s ceiling, so its tail will not be sent',
    },
    {
        id: 'no_subject_scale', severity: 'info',
        why: 'a subject has no declared size, so nothing in the prompt says how big it is',
    },
    {
        id: 'no_keyframe', severity: 'warn',
        why: 'no storyboard frame is attached, so the clip is built from words alone and will '
            + 'not match the board',
    },
    {
        id: 'style_not_applied', severity: 'info',
        why: 'the film\'s look was refused or absent for this request, so this will not carry it',
    },
    {
        id: 'fallback_provider', severity: 'warn',
        why: 'nobody chose this provider — it is where resolution fell through to',
    },
    {
        id: 'reference_dropped', severity: 'warn',
        why: 'a reference will not travel — the provider takes fewer than this shot wants, or '
            + 'refused one — so the frame is conditioned on less than the shot names',
    },
    {
        id: 'over_budget', severity: 'block',
        why: 'this run\'s projection exceeds the ceiling it was given, and it will be refused',
    },
]);

const WARNING_IDS = new Set(WARNINGS.map(w => w.id));

function warning(id, detail) {
    const spec = WARNINGS.find(w => w.id === id);
    // An undeclared warning id is a bug, not a message: it would render as
    // an unexplained string and no consumer could rank it.
    if (!spec) throw new Error(`undeclared warning '${id}' — add it to WARNINGS with its reason`);
    return { id, severity: spec.severity, why: spec.why, detail: detail || null };
}

const MIME_BY_EXT = Object.freeze({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
    '.glb': 'model/gltf-binary',
});

function mimeFor(p) {
    return MIME_BY_EXT[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream';
}

/**
 * A media item, or nothing.
 *
 * A path that does not resolve is DROPPED rather than carried: an item whose
 * file is absent produces a broken attachment at the far end, which reads as
 * the packet being wrong rather than the file being missing.
 */
function mediaItem(role, filePath, statFn) {
    if (!filePath) return null;
    let bytes = null;
    try { bytes = statFn(filePath).size; } catch (_) { return null; }
    return { role, path: filePath, bytes, mime: mimeFor(filePath) };
}

/**
 * The pre-spend envelope.
 *
 * @param {object} input  the answers the free tools already gave
 */
function preSpendEnvelope(input) {
    const o = input || {};
    const stat = o.statFn || require('fs').statSync;
    const prompt = o.prompt || {};
    const cost = o.cost || {};
    const warnings = [];

    // ── what a picture cannot show ──────────────────────────────────────────
    const missingPlates = (o.missingPlates || []).filter(Boolean);
    if (missingPlates.length) {
        warnings.push(warning('missing_plate',
            `no plate for ${missingPlates.join(', ')}`));
    }
    if (o.staleInputs && o.staleInputs.length) {
        warnings.push(warning('stale_inputs', o.staleInputs.join(', ')));
    }
    if (prompt.truncated_tail) {
        warnings.push(warning('prompt_truncated',
            `${String(prompt.truncated_tail).length} characters will not be sent`));
    }
    const noScale = (o.subjectsWithoutScale || []).filter(Boolean);
    if (noScale.length) {
        warnings.push(warning('no_subject_scale', `no declared size for ${noScale.join(', ')}`));
    }
    if (o.keyframeAttached === false) warnings.push(warning('no_keyframe'));
    if (o.styleApplied === false) warnings.push(warning('style_not_applied'));
    if (o.providerExplicit === false && o.action && o.action.provider) {
        warnings.push(warning('fallback_provider',
            `resolved to ${o.action.provider}, which this project does not pin`));
    }
    const dropped = (o.droppedReferences || []).filter(Boolean);
    if (dropped.length) warnings.push(warning('reference_dropped', dropped.join('; ')));
    if (o.overBudget) {
        warnings.push(warning('over_budget',
            `projected ${o.overBudget.projected} against a ceiling of ${o.overBudget.ceiling}`));
    }

    /*
     * The source preview's own warnings, carried through verbatim.
     *
     * It already computes things this cannot — an unverified model, a duration
     * clamped by the provider. Dropping them here would make the packet LESS
     * informed than the tool it summarises, which is the one thing it must
     * never be.
     */
    for (const w of (o.previewWarnings || [])) {
        if (typeof w === 'string' && w.trim()) {
            warnings.push({ id: 'from_preview', severity: 'warn', why: 'reported by the free preview this packet is built from', detail: w });
        } else if (w && w.message) {
            warnings.push({ id: 'from_preview', severity: 'warn', why: 'reported by the free preview this packet is built from', detail: String(w.message) });
        }
    }

    const items = (o.media || [])
        .map(m => mediaItem(m.role, m.path, stat))
        .filter(Boolean);

    return {
        kind: 'pre_spend',
        project: o.project || null,
        subject: o.subject || null,
        action: o.action || null,
        prompt: {
            text: prompt.text || '',
            chars: Number(prompt.chars) || (prompt.text ? String(prompt.text).length : 0),
            ceiling: prompt.ceiling !== undefined ? prompt.ceiling : null,
            // The tail that will NOT be sent, quoted. A count says a prompt is
            // over; the words say whether what is being lost matters.
            truncated_tail: prompt.truncated_tail || null,
        },
        references: (o.references || []).map(r => ({
            role: r.role || r.kind || null,
            subject_name: r.subject_name || r.name || r.subject || null,
            weight: r.weight !== undefined ? r.weight : null,
            path: r.path || null,
        })),
        style_applied: o.styleApplied === undefined ? null : o.styleApplied,
        cost: {
            credits: cost.credits !== undefined ? cost.credits : null,
            usd: cost.usd !== undefined ? cost.usd : null,
            minimum_applies: cost.minimum_applies === true,
        },
        warnings,
        media: { transport: MEDIA_TRANSPORT, items },
        // What this decision is ABOUT. Re-derived before anything acts on it.
        fingerprint: o.fingerprint || null,
        expires_hint_s: EXPIRES_HINT_S,
        free: true,
    };
}

/**
 * The take-selection envelope.
 *
 * Reads what is already archived. `source` and `instruction` are what separate
 * two near-identical frames — a number alone does not say why an attempt
 * exists, which is most of what a person is choosing between.
 */
function takeEnvelope(input) {
    const o = input || {};
    const stat = o.statFn || require('fs').statSync;

    const candidates = (o.versions || []).map((v) => {
        const item = mediaItem('candidate', v.path, stat);
        return {
            version: v.version,
            is_current: !!v.is_current,
            created_at: v.created_at || null,
            // Why this attempt exists.
            source: v.source || v.origin || null,
            instruction: v.instruction || null,
            refined_from: v.refined_from || null,
            path: item ? item.path : null,
            bytes: item ? item.bytes : null,
            mime: item ? item.mime : null,
            // Derived review files, when the caller made them. Null is honest:
            // a proxy that could not be built must not look like one that was.
            proxy_path: v.proxy_path || null,
            still_path: v.still_path || null,
            // A candidate whose own picture was never archived cannot be chosen,
            // and saying so is the difference between a short list and a list
            // with a dead entry in it.
            selectable: item !== null && v.selectable !== false,
            reason: item === null ? 'this attempt\'s picture is no longer on disk' : (v.reason || null),
        };
    });

    return {
        kind: 'take_selection',
        project: o.project || null,
        subject: o.subject || null,
        current_version: o.currentVersion !== undefined ? o.currentVersion : null,
        candidates,
        media: { transport: MEDIA_TRANSPORT },
        fingerprint: o.fingerprint || null,
        expires_hint_s: EXPIRES_HINT_S,
        free: true,
        // Resolution goes back through the selection that already exists. A
        // second selection concept would be a second answer to "which is the
        // take", and the two would disagree the first time one was used.
        resolve_with: 'POST /film/versions/:version_id/select',
    };
}

module.exports = {
    ENVELOPE_KINDS, WARNINGS, WARNING_IDS, MEDIA_TRANSPORT, EXPIRES_HINT_S,
    preSpendEnvelope, takeEnvelope, warning, mimeFor, mediaItem,
};
