/**
 * What one change breaks, all the way down.
 *
 * The chain is: screenplay → scene card → keyframe → clip → lip-sync → post →
 * assembly, with plates and entity descriptions feeding the keyframe from the
 * side. Every link was already tracked and none of them were tracked TOGETHER:
 * `staleInputs` looks exactly one level up and only at generation time, so it
 * answers "may I generate this" and never "you just changed the storyboard, and
 * shot 1B's footage was built on the old frame".
 *
 * One level is not enough, and the reason is precise. Change a keyframe and the
 * clip's inputs are visibly stale. The lip-sync's inputs are NOT — its input is
 * the clip, and the clip has not been regenerated yet, so its fingerprint has
 * not moved. Every step below the second one looks current right up until the
 * moment you fix the step above it, at which point the next warning appears.
 * A director discovers the work one layer at a time, in the worst possible
 * order, having already re-run half of it.
 *
 * So impact is computed transitively and reported in two states, which is the
 * whole value of the report:
 *
 *   redo    — out of date, and everything it is built from is current.
 *             Do this now.
 *   waiting — out of date only because something above it is. Do not touch it
 *             yet; regenerating now would build on the same old inputs and cost
 *             money to produce something that is still wrong.
 *
 * Without that split a rewrite of one scene reports forty red items and reads
 * as "start again", which is both wrong and the fastest way to get the warnings
 * switched off.
 *
 * WARNS, never blocks. `executeStep`'s STALE_INPUTS gate is the thing that
 * refuses; this is the map.
 */

const { ARTEFACT_KINDS, fingerprintFor, isStale } = require('./artefact-fingerprint');
const { drift } = require('./screenplay-drift');

function database() {
    return require('../db/database').db;
}

/**
 * The stages a shot passes through, in order, with what each is built from.
 *
 * Derived from the orchestrator's own graph. `scene_card` is prepended as the
 * root because it is what every generated stage ultimately reads, and it is not
 * in PIPELINE_STEPS — nothing generates it, a person writes it.
 */
function chain() {
    const steps = require('./pipeline-engine').PIPELINE_STEPS
        .filter(s => ARTEFACT_KINDS[s.id])
        .map(s => ({ id: s.id, depends: s.depends.slice() }));
    // Everything with no pipeline dependency still depends on the card: that is
    // where its prompt comes from. Stated here rather than added to
    // PIPELINE_STEPS, because the orchestrator sequences GENERATION and the
    // card is not generated.
    for (const step of steps) if (!step.depends.length) step.depends = ['scene_card'];
    return [{ id: 'scene_card', depends: [] }, ...steps];
}

/** The stamped assets of one kind for one shot. */
function assetsFor(db, kind, shotId) {
    try {
        return db.prepare(
            `SELECT id, input_fingerprint, file_name FROM film_assets
              WHERE artefact_kind = ? AND shot_id = ? AND input_fingerprint IS NOT NULL`).all(kind, shotId);
    } catch (_) { return []; }
}

/**
 * Everything a change has left behind, per shot, in the order to fix it.
 *
 * `sceneBehind` seeds the walk: a shot whose screenplay moved on has a bad card
 * at the root, so every generated stage under it is waiting rather than
 * separately broken. That is the difference between "your script changed, fix
 * the card, then redo these five things in this order" and five unrelated
 * alarms.
 */
function impact(projectId) {
    const db = database();
    const steps = chain();

    const sceneBehind = new Set();
    for (const scene of drift(projectId)) {
        for (const s of scene.shots_behind) sceneBehind.add(s.shot_id);
    }

    const shots = db.prepare(
        `SELECT sh.id, sh.shot_code, sc.scene_number FROM film_shots sh
           JOIN film_scenes sc ON sc.id = sh.scene_id
          WHERE sc.project_id = ? AND sc.status != 'removed'
          ORDER BY CAST(sc.scene_number AS INTEGER), sh.sort_order, sh.shot_code`).all(projectId);

    const out = [];
    for (const shot of shots) {
        const state = {};
        const rows = [];

        for (const step of steps) {
            // Waiting is inherited first: if anything this is built from needs
            // redoing, this does too, whatever its own fingerprint says.
            const upstreamBusy = step.depends.some(d => state[d] === 'redo' || state[d] === 'waiting');

            if (step.id === 'scene_card') {
                state[step.id] = sceneBehind.has(shot.id) ? 'redo' : 'current';
                if (state[step.id] === 'redo') {
                    rows.push({
                        stage: 'scene_card', state: 'redo',
                        why: 'the screenplay was revised after this card was written',
                        action: 'Edit the card to match the new scene, or delete the shot and break that scene down again.',
                    });
                }
                continue;
            }

            const assets = assetsFor(db, step.id, shot.id);
            if (!assets.length) {
                // Never generated, or generated before fingerprinting existed.
                // Neither is a problem to report: there is nothing to redo.
                state[step.id] = upstreamBusy ? 'absent' : 'absent';
                continue;
            }

            let own = false;
            let current = null;
            try { current = fingerprintFor(step.id, { shotId: shot.id }); } catch (_) { current = null; }
            if (current !== null) own = assets.some(a => isStale(a, current));

            if (upstreamBusy) {
                state[step.id] = 'waiting';
                rows.push({
                    stage: step.id, state: 'waiting',
                    why: `built on ${step.depends.join(' and ')}, which ${step.depends.length > 1 ? 'are' : 'is'} being redone`,
                    action: `Wait until ${step.depends.join(' and ')} ${step.depends.length > 1 ? 'are' : 'is'} regenerated, then redo this.`,
                    assets: assets.map(a => a.file_name).filter(Boolean),
                });
            } else if (own) {
                state[step.id] = 'redo';
                rows.push({
                    stage: step.id, state: 'redo',
                    why: 'what it was generated from has changed',
                    action: 'Regenerate this now — everything it is built from is current.',
                    assets: assets.map(a => a.file_name).filter(Boolean),
                });
            } else {
                state[step.id] = 'current';
            }
        }

        if (rows.length) {
            out.push({
                shot_id: shot.id,
                shot_code: shot.shot_code,
                scene_number: String(shot.scene_number),
                // Ordered by the chain, so working top to bottom is correct by
                // construction rather than by the director remembering the graph.
                stages: rows,
                next: rows.find(r => r.state === 'redo') || null,
            });
        }
    }

    return {
        chain: steps.map(s => s.id),
        shots_affected: out.length,
        redo_now: out.reduce((n, s) => n + s.stages.filter(r => r.state === 'redo').length, 0),
        waiting: out.reduce((n, s) => n + s.stages.filter(r => r.state === 'waiting').length, 0),
        shots: out,
    };
}

module.exports = { impact, chain };
