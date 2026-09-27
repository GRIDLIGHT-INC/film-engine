/**
 * THE PRE-FLIGHT. What is wrong with the shots BEFORE anything is generated.
 *
 * This is the mechanical half of reading a production. Every finding here is
 * checkable by a machine and citable to a shot code, and none of it is a
 * judgement about the film -- that is `analysis_brief` / `analysis_write`,
 * which is interpretive and deliberately refuses to give a verdict. Two
 * different jobs; keeping them apart is what stops either becoming noise.
 *
 * It exists because of a real morning's work. A hand audit of a sixteen-shot
 * commercial, done with `shot_prompt` one shot at a time, found four defects
 * that every existing report had been reporting "clean" on:
 *
 *   - 3A named SWARMER on its card, had an approved plate on disk, and sent
 *     NEITHER the picture nor a line of description, because the action line
 *     said "SWARMERS" and `\bSWARMER\b` does not match a plural. The one shot
 *     in the film whose whole purpose is a five-rung scale ladder was going to
 *     be generated with four rungs and an invented fifth.
 *   - 2B named COLOSSUS and resolved nothing at all.
 *   - 2A silently attached the hero car to a frame that never asked for it,
 *     purely because the word appeared in the prose.
 *   - Every direction note phrased its intent as a negative -- "NO FLARE" --
 *     which names the thing it is trying to exclude to a model that cannot
 *     reliably not-draw.
 *
 * None of those are exotic. They are what a first AD catches by reading a call
 * sheet, and nothing in the engine was reading one.
 *
 * THE FINDING THAT MATTERS MOST is `unresolved_subject`: a subject the card
 * names that reaches the provider as neither a reference image nor a
 * description. Every other finding here degrades a frame. That one INVENTS
 * one, confidently, in a way that looks like a rendering choice rather than a
 * missing record -- which is why it is the only error, and why it is checked
 * first.
 *
 * Reported per shot with a severity, because an error must be able to stop a
 * run and a warning must not: a warning that blocks is a check people switch
 * off, and a check people switch off is worse than no check at all.
 */

const { db: database } = require('../db/database');

const ERROR = 'error';
const WARNING = 'warning';
const INFO = 'info';

/** Ordered worst-first, so a caller can stop reading when it stops mattering. */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

function parseCard(shot) {
    try { return JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { return {}; }
}

function namesOf(value) {
    return (Array.isArray(value) ? value : [])
        .map(x => (typeof x === 'string' ? x : (x && x.name)))
        .filter(Boolean)
        .map(s => String(s).trim())
        .filter(Boolean);
}

/**
 * Every shot in a project, in the order the film plays.
 *
 * Ordered by scene then `sort_order` then code, because the continuity checks
 * below walk this list as a sequence and a mis-ordered walk invents
 * discontinuities that are not there.
 */
function shotsInOrder(db, projectId) {
    return db.prepare(
        `SELECT s.*, sc.scene_number, sc.location, sc.time_of_day, sc.id AS scene_row_id
           FROM film_shots s
           JOIN film_scenes sc ON sc.id = s.scene_id
          WHERE sc.project_id = ? AND sc.status != 'removed'
          ORDER BY sc.scene_number, s.sort_order, s.shot_code`).all(projectId);
}

/** The subjects a project actually has, with whether each carries a plate. */
function subjectIndex(db, projectId) {
    const { platedSubjects } = require('./shot-references');
    let plated = { characters: [], props: [], locations: [] };
    try { plated = platedSubjects(projectId) || plated; } catch (_) { /* pre-migration */ }

    const index = new Map();
    const add = (row, kind, hasPlate, described, size) => {
        index.set(String(row.name).toUpperCase(), {
            name: row.name, kind, has_plate: !!hasPlate, described: !!described, has_size: !!size,
        });
    };
    const plateOf = (list, id) => (list.find(x => x.id === id) || {}).has_plate;

    for (const r of db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId)) {
        add(r, 'character', plateOf(plated.characters, r.id),
            String(r.appearance_prompt || r.description || '').trim().length, Number(r.height_m) > 0);
    }
    for (const r of db.prepare('SELECT * FROM film_props WHERE project_id = ?').all(projectId)) {
        add(r, 'prop', plateOf(plated.props, r.id),
            String(r.visual_prompt || r.description || '').trim().length, Number(r.height_m) > 0);
    }
    return index;
}

/**
 * What this card's text would pull in on its own.
 *
 * The same matcher generation uses, so the audit and the request cannot
 * disagree about who is in a frame -- the divergence that produced three of
 * the four defects this module was written for.
 */
function subjectsFromText(index, text) {
    const { subjectNameMatches } = require('./shot-references');
    const out = [];
    for (const [key, subject] of index) {
        if (subjectNameMatches(subject.name, text)) out.push(key);
    }
    return out;
}

/** Everything wrong with one shot's card. */
function auditShot(shot, index) {
    const card = parseCard(shot);
    const findings = [];
    const at = { shot_id: shot.id, shot_code: shot.shot_code, scene_number: shot.scene_number };

    const declared = new Set([...namesOf(card.characters), ...namesOf(card.props)]
        .map(n => n.toUpperCase()));
    const text = String(card.description || card.action || '');
    const fromText = new Set(subjectsFromText(index, text));

    for (const key of declared) {
        const subject = index.get(key);
        if (!subject) {
            findings.push({
                ...at, severity: ERROR, type: 'unresolved_subject', subject: key,
                why: `The card names "${key}" and the project has no character or prop by that name. `
                    + 'It reaches the provider as neither a picture nor a description, so the model '
                    + 'invents it — and an invented subject looks like a choice, not a missing record.',
                fix: 'Create it with character_create / prop_create, or correct the name on the card with shot_update.',
            });
            continue;
        }
        if (!subject.has_plate && !subject.described) {
            findings.push({
                ...at, severity: ERROR, type: 'unresolved_subject', subject: subject.name,
                why: `"${subject.name}" exists but has no plate and no description, so nothing about it `
                    + 'reaches the request. The frame will contain something invented.',
                fix: `Give it a description (${subject.kind}_update) or generate a plate for it.`,
            });
            continue;
        }
        if (!subject.described && !subject.has_plate) continue;
        if (!subject.described) {
            findings.push({
                ...at, severity: WARNING, type: 'undescribed_subject', subject: subject.name,
                why: `"${subject.name}" has a plate but no description. It survives while the plate does; `
                    + 'a shot that cannot attach one has nothing to fall back on.',
                fix: `${subject.kind}_update with a visual description.`,
            });
        }
        if (!subject.has_size) {
            findings.push({
                ...at, severity: INFO, type: 'missing_scale', subject: subject.name,
                why: `No declared size for "${subject.name}". An image model has no sense of scale and a `
                    + 'plate makes it worse — a plate is a close-up filling its own frame.',
                fix: `${subject.kind}_update with height_m.`,
            });
        }
    }

    /*
     * Named by the prose and nobody wrote it down.
     *
     * Works today and breaks on the next rewrite, because the subject is in
     * the frame only for as long as that sentence keeps that word. Rephrase
     * the action and the creature silently leaves the picture.
     */
    for (const key of fromText) {
        if (declared.has(key)) continue;
        const subject = index.get(key);
        findings.push({
            ...at, severity: WARNING, type: 'implicit_subject', subject: subject.name,
            why: `"${subject.name}" is in this frame only because the action line happens to name it. `
                + 'It is not on the card, so rewriting the prose would remove it with no warning.',
            fix: 'shot_update to put it on the card explicitly — or reword the action if it does not belong here.',
        });
    }

    /*
     * On the card, and nothing in the shot asks for it.
     *
     * The mirror of the above and the easier one to miss, because the frame
     * looks right: an extra subject does not read as an error, it reads as
     * set dressing somebody chose.
     */
    for (const key of declared) {
        if (!index.has(key)) continue;
        if (fromText.has(key)) continue;
        const inDialogue = (Array.isArray(card.dialogue) ? card.dialogue : [])
            .some(d => String((d && d.character) || '').toUpperCase() === key);
        if (inDialogue) continue;
        findings.push({
            ...at, severity: INFO, type: 'declared_not_described', subject: index.get(key).name,
            why: `"${index.get(key).name}" is on the card but the shot description never mentions it. `
                + 'Its plate is attached and the prompt says nothing about what it is doing.',
            fix: 'Say what it is doing in the description, or drop it from the card.',
        });
    }

    /*
     * A negative in a positive prompt names the thing it excludes.
     *
     * Already detected per shot inside `shot_prompt`; aggregated here because
     * a lint nobody runs across the whole board is a lint nobody runs.
     */
    /*
     * ONE finding per shot, not one per phrase, and INFO rather than warning.
     *
     * The first run of this audit produced thirty-two findings of which
     * twenty-four were this rule, several of them false -- "out of frame" and
     * "frightened" are not exclusions. A report that is three-quarters one
     * noisy rule teaches the reader to skim past the rule that matters, and
     * the rule that matters here is `unresolved_subject`. So the phrases are
     * collapsed into a single line the writer can act on in one pass, and the
     * severity says what it is: worth fixing, never worth blocking.
     */
    try {
        const { offFrameFindings } = require('./prompt-lint');
        const lintable = [text, String(card.direction || '')].filter(Boolean).join('\n');
        const hits = (offFrameFindings(lintable) || []);
        const sentences = [...new Set(hits.map(f => String(f.sentence || '').trim()).filter(Boolean))];
        if (sentences.length) {
            findings.push({
                ...at, severity: INFO, type: 'negative_phrasing', subject: null,
                count: sentences.length, sentences: sentences.slice(0, 6),
                why: `${sentences.length} sentence(s) on this card state intent as a negative. A negative in a `
                    + 'positive prompt names the thing it excludes, to a model that cannot reliably not-draw. '
                    + 'Some matches are loose — read them before rewriting.',
                fix: 'Rephrase as what SHOULD be in frame; put genuine exclusions in the negative prompt.',
            });
        }
    } catch (_) { /* lint unavailable; the rest of the audit still reports */ }

    return findings;
}

/**
 * A subject that leaves a continuous sequence and comes back without going
 * anywhere.
 *
 * The check that would have caught the hero car: established beside him at the
 * end of Act 1, walked PAST at the top of Act 2, and arrived at again four
 * shots later at the end of Act 3. Either it followed him down the avenue or
 * there are two of them, and the setup the whole film rests on — the phone
 * BECOMES this car — depends on it being that one.
 *
 * Only within a CONTINUOUS run, because that is where absence means something.
 * Across a cut to another day, a car being somewhere else is just a car being
 * somewhere else.
 */
function continuityFindings(shots, index) {
    const findings = [];
    const runs = [];
    let current = [];
    for (const shot of shots) {
        const continuous = /CONTINUOUS/i.test(String(shot.time_of_day || ''));
        if (!current.length || continuous) current.push(shot);
        else { runs.push(current); current = [shot]; }
    }
    if (current.length) runs.push(current);

    for (const run of runs) {
        if (run.length < 3) continue;
        const presence = new Map();
        run.forEach((shot, i) => {
            const card = parseCard(shot);
            const text = String(card.description || card.action || '');
            const here = new Set([
                ...namesOf(card.characters), ...namesOf(card.props),
            ].map(n => n.toUpperCase()).filter(k => index.has(k)));
            for (const key of subjectsFromText(index, text)) here.add(key);
            for (const key of here) {
                if (!presence.has(key)) presence.set(key, []);
                presence.get(key).push(i);
            }
        });

        for (const [key, positions] of presence) {
            if (positions.length < 2) continue;
            for (let i = 1; i < positions.length; i++) {
                const gap = positions[i] - positions[i - 1];
                if (gap < 2) continue;
                const before = run[positions[i - 1]];
                const after = run[positions[i]];
                findings.push({
                    shot_id: after.id, shot_code: after.shot_code, scene_number: after.scene_number,
                    severity: WARNING, type: 'subject_teleport', subject: index.get(key).name,
                    why: `"${index.get(key).name}" is in ${before.shot_code}, absent for `
                        + `${gap - 1} shot(s), and back in ${after.shot_code} — inside one continuous `
                        + 'sequence, with nothing in between that moves it. Either it travelled, or these '
                        + 'are two of them, and a setup that pays off on one object needs it to be one object.',
                    fix: `Read ${before.shot_code} through ${after.shot_code} and decide whether it is the same one. `
                        + 'If it is, say where it is in the shots between.',
                });
                break;
            }
        }
    }
    return findings;
}

/**
 * Audit a project's shots, or one shot.
 *
 * FREE and side-effect free. Nothing is generated, written or spent.
 */
function auditShots(projectId, shotId) {
    const db = database;
    const index = subjectIndex(db, projectId);
    const all = shotsInOrder(db, projectId);
    const scoped = shotId ? all.filter(s => s.id === shotId) : all;

    const findings = [];
    for (const shot of scoped) findings.push(...auditShot(shot, index));
    // Continuity needs the whole sequence even when one shot was asked for:
    // a teleport is a fact about a run, not about a frame.
    if (!shotId) findings.push(...continuityFindings(all, index));
    else {
        findings.push(...continuityFindings(all, index).filter(f => f.shot_id === shotId));
    }

    findings.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        || String(a.shot_code).localeCompare(String(b.shot_code)));

    const counts = { error: 0, warning: 0, info: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

    return {
        project_id: projectId,
        ...(shotId ? { shot_id: shotId } : {}),
        shots_checked: scoped.length,
        counts,
        blocking: counts.error > 0,
        findings,
        note: counts.error
            ? 'An ERROR means a subject the card names reaches the provider as neither a picture nor a '
              + 'description. Fix those before generating — the frame will contain something invented.'
            : 'No errors. Warnings are worth reading before a run but block nothing.',
    };
}

module.exports = { auditShots, auditShot, continuityFindings, subjectIndex, ERROR, WARNING, INFO };
