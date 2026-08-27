/**
 * The plates a shot is generated with, gathered once for every path.
 *
 * This lived in routes/storyboard.js, which meant only the board paths could
 * use it — and the divergence that produced was exactly the bug it had already
 * been through once. `regenerateShot` did not call it, so regenerating ONE shot
 * ran text-to-image with no plate conditioning while regenerating the whole
 * board conditioned correctly; nothing failed and nothing was logged, because
 * the full prose contracts were carrying the subjects until the day they were
 * shortened on the correct assumption that a picture was attached.
 *
 * The orchestrated path had the same shape of gap and never closed it: the
 * shared capability payload gathered no references at all, so a pipeline run
 * generated keyframes unconditioned, and every reference feature added since —
 * plates, mood-board style images, the scene anchor — reached three paths out
 * of four. `lib/capability-payloads.js` exists precisely so "the per-domain
 * routes, the pipeline orchestrator and the flow canvas cannot describe the
 * same generation differently", and it could not honour that while the gatherer
 * lived behind an HTTP route.
 *
 * Pure of the payload builder, deliberately. `loadShotContext` does the reading
 * and hands the result over as `ctx.references`, so building a payload from an
 * already-loaded context still needs no database — the property that makes the
 * whole parity suite testable without I/O.
 */

const { orderByViewSql, headlinePlate } = require('./plate-views');
const { selectReferences } = require('./reference-images');

/**
 * The database, required on first use rather than at module load.
 *
 * lib/capability-payloads.js requires this file and is deliberately free of a
 * module-scope database so that building a payload from an already-loaded
 * context needs no I/O at all. A top-level `require('../db/database')` here
 * would open the database the moment that file was imported and undo it.
 */
let _db = null;
function database() {
    if (!_db) _db = require('../db/database').db;
    return _db;
}

/**
 * @param {object} [opts] - { limit } the ceiling of the provider that will
 *   actually run. Absent falls back to the strict default, because a made-up
 *   higher number produces a rejection at the provider, which is worse than
 *   sending fewer plates.
 */
function gatherShotReferences(projectId, matchedChars, matchedLocation, sceneCardProps, anchor, opts) {
    // Subjects whose plate must travel even though the anchor names them: the
    // director's explicit choice, plus whatever this shot's own framing demands.
    const keepPlates = (opts && opts.keepPlates) || [];
    const candidates = [];

    // The scene as it was actually rendered — location, dressing and subjects
    // in the positions they ended up in. Ranked FIRST by lib/reference-images,
    // because the new shot is a different camera pointed at that world rather
    // than a fresh assembly of the same ingredients.
    const sceneAnchor = require('./shot-anchor');
    const anchorRef = sceneAnchor.anchorCandidate(anchor);
    if (anchorRef) candidates.push(anchorRef);

    // Whatever the anchor already shows needs no plate. Three slots is the
    // whole budget, so a plate of a character standing in the attached frame is
    // a slot taken from a subject that is not in it — which is exactly the
    // subject that still needs establishing.
    const covered = anchorRef ? sceneAnchor.subjectsCoveredBy(database(), anchor, keepPlates) : new Set();
    const isCovered = name => covered.has(String(name || '').trim().toUpperCase());

    for (const ch of matchedChars || []) {
        if (!ch || !ch.id) continue;
        if (isCovered(ch.name)) continue;
        /*
         * THE FRONT VIEW IS THE ONE THAT CARRIES IDENTITY.
         *
         * This ordered by `created_at DESC`, and a turnaround is generated
         * front, side, back — so the newest row is always the BACK, and every
         * frame a character appeared in was conditioned on the back of their
         * head. Generating three views cost three times as much as one and
         * made the result worse than not bothering, and the symptom was a
         * plausible stranger in the frame, which reads as weak conditioning
         * rather than as the wrong picture being sent.
         */
        const plate = database().prepare(
            `SELECT file_path, file_name FROM film_assets
             WHERE project_id = ? AND character_id = ?
               AND asset_type IN ('character_sheet', 'reference_image')
             ORDER BY ${orderByViewSql()}, version DESC, created_at DESC LIMIT 1`
        ).get(projectId, ch.id);
        if (plate) candidates.push({ name: ch.name, kind: 'character', file_path: plate.file_path });
    }

    // The anchor IS the location, rendered, so its plate is the most redundant
    // of all when one is attached.
    /*
     * The anchor normally stands in for the location plate — it IS that place,
     * rendered, which is better than a plate of it.
     *
     * Unless the director has explicitly chosen a VIEW. That is the case the
     * views feature exists for: the anchor shows one side of the street and the
     * shot is pointed at the other, so the anchor carries the light, the
     * dressing and where people stand, and the view carries the half of the
     * place the anchor cannot see. Choosing a view is a deliberate act; leaving
     * it silently overridden would make the whole picker decorative.
     */
    const explicitView = (opts && opts.locationView) ? String(opts.locationView).trim() : '';
    if (matchedLocation && matchedLocation.id && (!anchorRef || explicitView)) {
        /*
         * The view this shot is looking at, not simply the newest plate.
         *
         * A location had one plate and every shot got it, whichever way the
         * camera pointed — so a reverse angle was handed a photograph of what
         * was behind it and invented the rest.
         *
         * An unknown or unset view falls back to the default plate rather than
         * to nothing: a card naming a view someone deleted must still get its
         * location, or a silent gap replaces a wrong reference with no
         * reference, which is worse.
         */
        const locationView = explicitView;
        const all = database().prepare(
            `SELECT file_path, file_name, metadata FROM film_assets
             WHERE project_id = ? AND location_id = ?
               AND asset_type IN ('reference_image', 'character_sheet')
             ORDER BY version DESC, created_at DESC`
        ).all(projectId, matchedLocation.id);
        /*
         * Shared with the locations route rather than repeated here. This
         * logic was right and the LIST route's was not — it took the newest
         * row, so after a compass sweep the card showed the last side written
         * while generation still used the master. Two answers to one question
         * is how a display comes to disagree with the generator.
         */
        const viewOf = row => {
            try { return String((JSON.parse(row.metadata || '{}').view) || '').trim(); }
            catch (_) { return ''; }
        };
        const plate = headlinePlate(all, { view: locationView });
        if (plate) {
            candidates.push({
                name: matchedLocation.name, kind: 'location', file_path: plate.file_path,
                view: viewOf(plate) || null,
            });
        }
    }

    // The film's look, as a picture. lib/reference-images has had a `style`
    // rank since it was written and nothing ever filled it, so a frame pinned
    // to the mood board changed no output anywhere. Ranked below character and
    // location, so with three slots a look plate never displaces the actor — a
    // viewer notices a different face long before a different grade.
    try {
        for (const ref of require('./look-development').styleReferences(db, projectId, 1)) {
            candidates.push(ref);
        }
    } catch (_) { /* a project with no board generates exactly as before */ }

    // Props named on the scene card. Ranked below character and location by
    // lib/reference-images, so with the 3-reference cap they only claim a slot
    // when there is one free — a prop displacing the actor would be the wrong
    // trade every time.
    const propNames = Array.isArray(sceneCardProps) ? sceneCardProps : [];
    for (const raw of propNames) {
        const name = typeof raw === 'string' ? raw : (raw && raw.name);
        if (!name || isCovered(name)) continue;
        const prop = database().prepare(
            'SELECT id, name FROM film_props WHERE project_id = ? AND UPPER(name) = UPPER(?) LIMIT 1'
        ).get(projectId, name);
        if (!prop) continue;
        const plate = database().prepare(
            `SELECT file_path FROM film_assets
             WHERE project_id = ? AND prop_id = ? AND asset_type IN ('reference_image', 'character_sheet')
             ORDER BY version DESC, created_at DESC LIMIT 1`
        ).get(projectId, prop.id);
        if (plate) candidates.push({ name: prop.name, kind: 'prop', file_path: plate.file_path });
    }

    // The ceiling belongs to the provider about to receive this, not to a
    // constant chosen from the strictest one wired here.
    return selectReferences(candidates, { limit: opts && opts.limit });
}

function matchProps(sceneCard, dbProps) {
    const card = sceneCard || {};
    const all = dbProps || [];
    const chosen = new Map();

    const take = (name) => {
        if (!name) return;
        const hit = all.find(p => p.name && p.name.toUpperCase() === String(name).toUpperCase());
        if (hit) chosen.set(hit.id || hit.name, hit);
    };

    for (const entry of (Array.isArray(card.props) ? card.props : [])) {
        take(typeof entry === 'string' ? entry : (entry && entry.name));
    }

    const text = String(card.description || card.action || '');
    if (text) {
        for (const prop of all) {
            if (!prop.name) continue;
            const escaped = String(prop.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) chosen.set(prop.id || prop.name, prop);
        }
    }
    return [...chosen.values()];
}

function matchCharacters(cardCharacters, dbCharacters) {
    if (!cardCharacters || !Array.isArray(cardCharacters)) return [];
    return cardCharacters
        .map(ch => {
            const name = typeof ch === 'string' ? ch : ch.name;
            if (!name) return null;
            return (dbCharacters || []).find(
                c => c.name && c.name.toUpperCase() === name.toUpperCase()
            );
        })
        .filter(Boolean);
}

function matchLocation(locationName, dbLocations) {
    if (!locationName) return null;
    return (dbLocations || []).find(
        l => l.name && l.name.toUpperCase() === locationName.toUpperCase()
    ) || null;
}


/**
 * What the provider that will actually run can do with a picture.
 *
 * Two different questions, and conflating them cost a real frame. `canAttach`
 * is whether it takes reference images at all; `canTag` is whether the PROMPT
 * can address them as @maya. Meshy conditions on a plain untagged array, so
 * emitting "@maya" there replaced 240 characters of appearance with a token
 * meaning nothing to the model.
 */
function providerReferenceSupport(providerConfig) {
    try {
        const { imageProviderChain } = require('./image-fallback');
        const lead = imageProviderChain(providerConfig || {})[0];
        return {
            canAttach: !!(lead && lead.supportsReferenceImages),
            canTag: !!(lead && lead.supportsReferenceTags),
            // How many plates this provider actually takes. Undefined falls
            // back to the strict default rather than to unlimited.
            maxReferenceImages: lead && lead.maxReferenceImages,
            promptLimit: lead && Number(lead.promptLimit) > 0 ? Number(lead.promptLimit) : undefined,
        };
    } catch (_) {
        return { canAttach: false, canTag: false, promptLimit: undefined, maxReferenceImages: undefined };
    }
}

/**
 * Everything a shot's prompt and payload need to know about pictures.
 *
 * One call, so a path cannot gather the plates and forget the anchor, or attach
 * references and fail to say whether the prompt may name them.
 */
function shotReferencesFor(db, opts) {
    const o = opts || {};
    const support = providerReferenceSupport(o.providerConfig);
    if (!support.canAttach) {
        return { references: [], tagged: false, anchorTag: null, support };
    }
    const references = gatherShotReferences(
        o.projectId, o.characters || [], o.location || null, o.props || [], o.anchor || null,
        // eslint-disable-next-line no-multi-spaces
        // The ceiling of the provider this config resolves to, so the shared
        // path agrees with the per-route ones about how many plates fit.
        { limit: support.maxReferenceImages, keepPlates: o.keepPlates || [],
          locationView: o.locationView || '' });
    const anchorRef = references.find(r => r && r.kind === 'anchor');
    return {
        references,
        tagged: support.canTag,
        // Two separate facts, because they gate different things.
        //
        // `anchorAttached` is whether the frame claimed one of the three slots
        // — it ranks first, so it does whenever the provider takes pictures at
        // all. That is what licenses the prompt to talk about it.
        //
        // `anchorTag` is only set where the provider can READ a tag. Without
        // one the prompt says "the first reference image" instead, which is
        // unambiguous precisely because the anchor ranks first. Emitting "@1a"
        // to a provider that cannot resolve it puts a literal token in the
        // prompt and leaves the picture unexplained.
        anchorAttached: !!anchorRef,
        anchorTag: (support.canTag && anchorRef) ? anchorRef.tag : null,
        support,
    };
}


/**
 * Which subjects in a project actually have a plate.
 *
 * Derived from the SAME asset query the gatherer uses to attach one, because
 * the two answers must agree: a picker that says "no plate" while the generator
 * cheerfully attaches one is misinformation in the worst direction — it tells a
 * director their subject will be invented fresh in every frame when it will
 * not, and the honest response to that is to go and generate plates that
 * already exist.
 *
 * This existed as three invented field names on the client (`plate_asset_id`,
 * `has_plate`, `refsheet_asset_id`), none of which any route returns, so every
 * subject in every project reported no plate.
 */
const PLATE_TYPES = "('character_sheet', 'reference_image')";

function platedSubjects(db, projectId) {
    const has = (column, table) => {
        const rows = db.prepare(
            `SELECT t.id, t.name,
                    (SELECT COUNT(*) FROM film_assets a
                      WHERE a.project_id = ? AND a.${column} = t.id
                        AND a.asset_type IN ${PLATE_TYPES}) n
               FROM ${table} t WHERE t.project_id = ?`).all(projectId, projectId);
        return rows.map(r => ({ id: r.id, name: r.name, has_plate: r.n > 0 }));
    };
    return {
        characters: has('character_id', 'film_characters'),
        props: has('prop_id', 'film_props'),
        locations: has('location_id', 'film_locations'),
    };
}

module.exports = {
    platedSubjects,
    gatherShotReferences,
    matchProps,
    matchCharacters,
    matchLocation,
    providerReferenceSupport,
    shotReferencesFor,
};
