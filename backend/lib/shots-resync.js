/**
 * RESYNC: the verb the drift system never had.
 *
 * `screenplay_drift` could REPORT that a scene had moved on without its shots,
 * and `screenplay_drift_accept` could DISMISS that. There was nothing in
 * between. A banner whose only affordance is "ignore" teaches the person to
 * ignore it, and the report's own `next` field pointed at `breakdown_run` — a
 * tool deliberately removed for calling a server-side LLM, so the instruction
 * named a button that does not exist.
 *
 * WHAT THIS DOES NOT DO IS THE POINT. It never rewrites the director's prose.
 * Splitting a rewritten scene into shots is a judgement about coverage, and a
 * judgement is not something to perform silently on somebody's film. So this
 * refreshes only what is mechanically derivable from the screenplay — who is
 * in the scene, what is in it, what is said — restamps the fingerprints so the
 * warning clears, and REPORTS everything that needs a person: descriptions
 * that no longer match, dialogue with no shot to carry it, shots whose lines
 * have gone.
 *
 * What is preserved is as deliberate as what is changed. The camera block, the
 * `direction` note, the duration, the shot code and the shot's identity are
 * the director's work and a reconciler must not touch them: the id in
 * particular, because `film_shots.scene_id` is ON DELETE CASCADE and losing it
 * takes the blocking, the annotations and the frames with it. That has already
 * happened once on this codebase and cost a full shot list.
 *
 * Dry run by default. An apply that cannot be previewed is how the last one
 * went wrong.
 */

const { db: database } = require('../db/database');

function parseCard(shot) {
    try { return JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { return {}; }
}

/** The scene as the screenplay has it now: its text and its dialogue, in order. */
function sceneFromScreenplay(db, scene) {
    const script = db.prepare(
        `SELECT fountain_content FROM film_scripts
          WHERE project_id = ? AND fountain_content IS NOT NULL
          ORDER BY version DESC LIMIT 1`).get(scene.project_id);
    if (!script || !script.fountain_content) return { text: '', dialogue: [] };

    const { sceneSpans } = require('./scene-splice');
    const fountain = String(script.fountain_content);
    const lines = fountain.split('\n');
    const full = [scene.int_ext, scene.location].filter(Boolean).join('. ')
        + (scene.time_of_day ? ' - ' + scene.time_of_day : '');
    const bare = [scene.int_ext, scene.location].filter(Boolean).join('. ');
    const spans = sceneSpans(fountain);
    // Position first when it agrees with the heading — two scenes here share
    // one heading, and a heading search hands both of them the first scene's
    // text. See the same note in lib/screenplay-drift.js.
    const atIndex = spans[Number(scene.scene_number) - 1];
    const headingOf = sp => String((sp && sp.heading) || '').toUpperCase();
    const span = (atIndex && (headingOf(atIndex) === full.toUpperCase() || headingOf(atIndex) === bare.toUpperCase()))
        ? atIndex
        : (spans.find(sp => headingOf(sp) === full.toUpperCase())
            || spans.find(sp => headingOf(sp) === bare.toUpperCase())
            || atIndex);
    if (!span) return { text: '', dialogue: [] };

    const text = lines.slice(span.start, span.end + 1).join('\n');
    const { parseFountain } = require('./fountain-parser');
    const dialogue = [];
    let who = '';
    let ext = '';
    for (const el of (parseFountain(text).elements || [])) {
        if (el.type === 'character') {
            who = String(el.text || '').trim();
            /*
             * V.O. AND O.S. TRAVEL WITH THE LINE.
             *
             * The parser has always captured the extension and the cards
             * dropped it, so a voice-over read on a card as ordinary speech.
             * That is not cosmetic: the motion prompt now tells a video model
             * whether a mouth in frame is moving, and the last two shots of a
             * film can be a voice over an empty street. Getting this wrong
             * puts a talking face where the director put nobody.
             */
            ext = String((el.meta && el.meta.extension) || '').trim();
        } else if (el.type === 'dialogue') {
            dialogue.push({
                character: who,
                line: String(el.text || '').trim(),
                ...(ext ? { extension: ext } : {}),
            });
        }
    }
    return { text, dialogue };
}

const sameLine = (a, b) =>
    String((a && a.character) || '').trim().toUpperCase() === String((b && b.character) || '').trim().toUpperCase()
    && String((a && a.line) || '').trim() === String((b && b.line) || '').trim();

/**
 * Plan, and optionally perform, a reconcile of one project's shots.
 *
 * `apply` false (the default) writes nothing at all — not the cards, not the
 * fingerprints.
 */
function resyncShots(projectId, opts) {
    const o = opts || {};
    const db = database;
    const apply = o.apply === true;
    const { resolveCardSubjects } = require('./shot-references');
    const { stampShot, stampScene, sceneFingerprint } = require('./screenplay-drift');

    const scenes = db.prepare(
        `SELECT * FROM film_scenes WHERE project_id = ? AND status != 'removed'
          ${o.scene_id ? 'AND id = ?' : ''} ORDER BY scene_number`)
        .all(...(o.scene_id ? [projectId, o.scene_id] : [projectId]));

    const plan = [];
    let changed = 0;

    for (const scene of scenes) {
        const shots = db.prepare(
            'SELECT * FROM film_shots WHERE scene_id = ? ORDER BY sort_order, shot_code').all(scene.id);
        if (!shots.length) continue;

        const screenplay = sceneFromScreenplay(db, scene);
        const carried = [];
        const sceneEntry = {
            scene_id: scene.id,
            scene_number: String(scene.scene_number),
            heading: [scene.int_ext, scene.location, scene.time_of_day].filter(Boolean).join('. '),
            shots: [],
            needs_a_person: [],
        };

        for (const shot of shots) {
            const card = parseCard(shot);
            const before = JSON.stringify(card);
            const change = { shot_id: shot.id, shot_code: shot.shot_code, updates: [], preserved: [] };

            // Derivable without judgement: who and what is in the frame.
            let resolved = null;
            try { resolved = resolveCardSubjects(db, projectId, card); } catch (_) { /* skip */ }
            if (resolved) {
                const wasChars = (card.characters || []).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
                const wasProps = (card.props || []).map(p => (typeof p === 'string' ? p : p && p.name)).filter(Boolean);
                if (JSON.stringify(wasChars) !== JSON.stringify(resolved.characters)) {
                    change.updates.push({ field: 'characters', from: wasChars, to: resolved.characters });
                    card.characters = resolved.characters.map(name => ({ name }));
                }
                if (JSON.stringify(wasProps) !== JSON.stringify(resolved.props)) {
                    change.updates.push({ field: 'props', from: wasProps, to: resolved.props });
                    card.props = resolved.props;
                }
                if (resolved.unresolved.length) {
                    sceneEntry.needs_a_person.push({
                        kind: 'unresolved_subject', shot_code: shot.shot_code,
                        subjects: resolved.unresolved,
                        why: 'Named on the card and matching nothing in the project — it will be invented.',
                    });
                }
            }

            // The scene's headings are facts about where the shot is.
            if ((card.location || scene.location) !== scene.location) {
                change.updates.push({ field: 'location', from: card.location, to: scene.location });
                card.location = scene.location;
            }

            /*
             * DIALOGUE IS MATCHED, NEVER REFLOWED.
             *
             * A card's lines are reconciled against the screenplay's by
             * position among the lines not yet claimed, so a rewritten line
             * updates in place and a MOVED line is reported rather than
             * silently reassigned to whichever shot happens to sit at its new
             * index. Guessing here would put somebody else's line in a
             * character's mouth, which is the one error nobody reviewing a
             * board would catch.
             */
            const cardLines = Array.isArray(card.dialogue) ? card.dialogue : [];
            if (cardLines.length) {
                const updated = [];
                for (const line of cardLines) {
                    const exact = screenplay.dialogue.find(
                        d => sameLine(d, line) && !carried.includes(d));
                    if (exact) {
                        carried.push(exact);
                        updated.push(exact);
                        // The words already matched; the CUE may not have. A
                        // card that gains V.O. here is the repair path for
                        // every card written before the extension was kept.
                        const had = String(line.extension || '').trim();
                        const now = String(exact.extension || '').trim();
                        if (had !== now) {
                            change.updates.push({ field: 'dialogue_extension',
                                from: had || '(none)', to: now || '(none)' });
                        }
                        continue;
                    }
                    /*
                     * NO FALLBACK. An exact match or nothing.
                     *
                     * The first version fell back to "the next unclaimed line
                     * by the same speaker", which in a single-speaker film --
                     * this one, and every direct-address commercial -- means
                     * "the next line". It quietly moved four of Manny's lines
                     * between shots on the first dry run. A reconciler that
                     * reassigns dialogue is worse than one that gives up,
                     * because a line in the wrong shot reads perfectly on the
                     * board and is only caught in the edit.
                     */
                    updated.push(line);
                    sceneEntry.needs_a_person.push({
                        kind: 'dialogue_changed_or_gone', shot_code: shot.shot_code,
                        line: `${line.character}: ${line.line}`,
                        why: 'This line is on the card and is not in the scene word for word any more. It may '
                            + 'have been rewritten, or moved. Nothing was changed and the shot was NOT deleted.',
                        fix: 'Compare the card against the scene and set the line with shot_update.',
                    });
                }
                if (JSON.stringify(cardLines) !== JSON.stringify(updated)) card.dialogue = updated;
            }

            /*
             * The description is the director's prose and is never rewritten.
             * Reported when the scene has moved under it, so the decision is
             * theirs and is visible.
             */
            /*
             * Asked of the FINGERPRINT, not of the text.
             *
             * The first version tested whether the card's opening words
             * appeared in the scene, and flagged all sixteen shots -- of
             * course it did: a shot description is the director's account of a
             * frame, not a quotation from the screenplay. The engine already
             * knows the real answer, because the drift stamp records which
             * draft this card was written from.
             */
            if (screenplay.text && card.description) {
                let current = true;
                try {
                    const { matchesScene } = require('./screenplay-drift');
                    current = matchesScene(scene, shot.scene_fingerprint);
                } catch (_) { current = true; }
                if (!current) {
                    sceneEntry.needs_a_person.push({
                        kind: 'description_may_be_stale', shot_code: shot.shot_code,
                        why: 'The scene text moved and this card describes the frame in the director’s own '
                            + 'words. Deciding what the new text should look like is a coverage judgement, '
                            + 'so it is left alone and named here.',
                        fix: 'Re-read the scene and edit this card with shot_update.',
                    });
                }
            }

            change.preserved = ['shot id', 'shot_code', 'camera', 'direction', 'duration',
                'blocking', 'annotations', 'generated frames'];
            if (JSON.stringify(card) !== before) {
                changed++;
                if (apply) {
                    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
                        .run(JSON.stringify(card, null, 2), shot.id);
                }
            }
            if (apply) { try { stampShot(shot.id, scene.id); } catch (_) { /* best effort */ } }
            if (change.updates.length) sceneEntry.shots.push(change);
        }

        // Lines in the scene that no shot carries: new material, needing coverage.
        for (const d of screenplay.dialogue) {
            if (carried.includes(d)) continue;
            sceneEntry.needs_a_person.push({
                kind: 'no_shot_covers_this', line: `${d.character}: ${d.line}`,
                why: 'In the screenplay and on no shot card. Nothing was created — how this is covered '
                    + 'is a directing decision.',
                fix: 'shot_create, or shot_insert after the shot it follows.',
            });
        }

        if (apply) { try { stampScene(scene.id); } catch (_) { /* best effort */ } }
        if (sceneEntry.shots.length || sceneEntry.needs_a_person.length) plan.push(sceneEntry);
    }

    /*
     * A resync CHANGES CARDS, and the audit is how you see what it did.
     *
     * Only on apply: a dry run wrote nothing, so auditing it would report the
     * board as it already is and read as a consequence of a plan that has not
     * happened. Never throws — reconciliation that succeeded must not be
     * reported as failed because the check afterwards could not run.
     */
    let audit = null;
    if (apply) {
        try {
            const report = require('./shot-audit').auditShots(projectId);
            audit = {
                counts: report.counts,
                blocking: !!report.blocking,
                errors: (report.findings || []).filter(f => f.severity === 'error'),
            };
        } catch (_) { audit = null; }
    }

    return {
        project_id: projectId,
        applied: apply,
        scenes_examined: scenes.length,
        cards_changed: changed,
        needs_a_person: plan.reduce((n, s) => n + s.needs_a_person.length, 0),
        ...(audit ? { audit } : {}),
        plan,
        note: apply
            ? 'Cards reconciled and fingerprints restamped. Nothing was deleted and no description was '
              + 'rewritten — anything under needs_a_person is still waiting for you.'
            : 'DRY RUN — nothing was written. Re-run with apply: true to reconcile. Descriptions are never '
              + 'rewritten and no shot is ever deleted, whatever you pass.',
    };
}

module.exports = { resyncShots };
