/**
 * Sides and DOOD — the two reports a production asks for by name.
 *
 * Both are reports over presence, and they are built now rather than earlier
 * because presence was broken in a way that made them worse than useless: it
 * was keyed on dialogue cues, so a character introduced in an action line was
 * present in no scene. On Wingfall that meant the DRAGON — the title creature,
 * in most of the film — appeared in no report at all. A DOOD that omits the
 * most expensive subject in a production is more dangerous than no DOOD,
 * because it looks complete.
 *
 * The AI reading matters. On a set, sides are what a performer reads and DOOD
 * is what schedules them. Here, sides are what a director checks before
 * spending on voice generation, and DOOD answers "which subjects need a
 * reference plate, and how many shots does each one commit us to" — which is
 * the number that predicts spend.
 *
 * No I/O beyond reads, no formatting decisions: these return data, and the
 * route decides whether it becomes JSON or a file.
 */

const { db } = require('../db/database');

function parseList(json) {
    try {
        const v = JSON.parse(json || '[]');
        return Array.isArray(v) ? v.map(x => String(x).toUpperCase()) : [];
    } catch (_) { return []; }
}

function parseCard(yaml) {
    try { return JSON.parse(yaml || '{}'); } catch (_) { return {}; }
}

/**
 * Everyone the production knows about, from both directions.
 *
 * The character table and scene presence can disagree — a character row can
 * exist before it is detected in a scene, and vice versa — and a report that
 * trusted one would quietly drop whoever is only in the other.
 */
function castOf(projectId) {
    const names = new Set();
    for (const c of db.prepare('SELECT name FROM film_characters WHERE project_id = ?').all(projectId)) {
        names.add(String(c.name).toUpperCase());
    }
    for (const s of db.prepare('SELECT characters_present FROM film_scenes WHERE project_id = ?').all(projectId)) {
        for (const n of parseList(s.characters_present)) names.add(n);
    }
    return [...names].sort();
}

/**
 * Scene numbers are reported as strings, always.
 *
 * film_scenes.scene_number has INTEGER affinity, so '2' comes back as 2 while
 * '2A' comes back as '2A' — the same column yielding two types depending on
 * the value. A report that passed that through would make every consumer
 * handle both, so it is normalised once, here.
 */
function sceneNo(scene) { return String(scene.scene_number); }

function scenesWithShots(projectId) {
    const scenes = db.prepare(
        `SELECT id, scene_number, location, time_of_day, characters_present
           FROM film_scenes WHERE project_id = ? ORDER BY CAST(scene_number AS INTEGER), scene_number`)
        .all(projectId);
    const shots = db.prepare(
        `SELECT id, scene_id, shot_code, scene_card_yaml FROM film_shots
          WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?)
          ORDER BY shot_code`).all(projectId);
    const byScene = new Map(scenes.map(s => [s.id, []]));
    for (const shot of shots) if (byScene.has(shot.scene_id)) byScene.get(shot.scene_id).push(shot);
    return { scenes, byScene };
}

/**
 * Sides: each character's own lines, in order, with the scene they sit in.
 *
 * A character with NO lines still gets an entry. Omitting them would make
 * "has no dialogue" indistinguishable from "is not in this film", and the
 * second is a much worse thing to conclude silently.
 */
function buildSides(projectId) {
    const { scenes, byScene } = scenesWithShots(projectId);
    const cast = castOf(projectId);
    const out = new Map(cast.map(name => [name, { character: name, line_count: 0, scenes: [], lines: [] }]));

    for (const scene of scenes) {
        for (const shot of byScene.get(scene.id) || []) {
            const card = parseCard(shot.scene_card_yaml);
            const dialogue = Array.isArray(card.dialogue) ? card.dialogue : [];
            for (const d of dialogue) {
                const who = String((d && (d.character || d.speaker)) || '').toUpperCase();
                const text = String((d && (d.line || d.text || d.dialogue)) || '');
                if (!who || !text) continue;
                if (!out.has(who)) out.set(who, { character: who, line_count: 0, scenes: [], lines: [] });
                const entry = out.get(who);
                entry.lines.push({ scene: sceneNo(scene), shot: shot.shot_code, line: text });
                entry.line_count++;
                if (!entry.scenes.includes(sceneNo(scene))) entry.scenes.push(sceneNo(scene));
            }
        }
    }

    return {
        project_id: projectId,
        characters: [...out.values()].sort((a, b) => b.line_count - a.line_count || a.character.localeCompare(b.character)),
        speaking: [...out.values()].filter(c => c.line_count > 0).length,
        // Named explicitly: a non-speaking subject still needs a plate and
        // still costs money, and it is the one the old presence data lost.
        non_speaking: [...out.values()].filter(c => c.line_count === 0).map(c => c.character),
    };
}

/**
 * DOOD — day out of days, read for AI production.
 *
 * Which scenes and how many shots each subject is committed to, and whether it
 * has a reference plate yet. The plate flag is the actionable half: a character
 * in 40 shots with no plate is 40 frames that will each invent their own
 * version of them.
 */
function buildDOOD(projectId) {
    const { scenes, byScene } = scenesWithShots(projectId);
    const cast = castOf(projectId);

    const plates = new Set(
        db.prepare(
            `SELECT c.name FROM film_assets a JOIN film_characters c ON c.id = a.character_id
              WHERE a.project_id = ? AND a.asset_type = 'character_sheet'`).all(projectId)
            .map(r => String(r.name).toUpperCase()));

    const rows = cast.map(name => ({
        character: name, scenes: [], shot_count: 0, has_plate: plates.has(name),
    }));
    const byName = new Map(rows.map(r => [r.character, r]));

    for (const scene of scenes) {
        const present = new Set(parseList(scene.characters_present));
        const shots = byScene.get(scene.id) || [];
        // A card may name characters the scene-level list missed, and vice
        // versa; union rather than pick, because either alone has been wrong.
        for (const shot of shots) {
            const card = parseCard(shot.scene_card_yaml);
            for (const n of (Array.isArray(card.characters) ? card.characters : [])) {
                present.add(String(n).toUpperCase());
            }
            for (const d of (Array.isArray(card.dialogue) ? card.dialogue : [])) {
                const who = String((d && (d.character || d.speaker)) || '').toUpperCase();
                if (who) present.add(who);
            }
        }
        for (const name of present) {
            if (!byName.has(name)) {
                const row = { character: name, scenes: [], shot_count: 0, has_plate: plates.has(name) };
                byName.set(name, row); rows.push(row);
            }
            const row = byName.get(name);
            if (!row.scenes.includes(sceneNo(scene))) row.scenes.push(sceneNo(scene));
            row.shot_count += shots.length;
        }
    }

    rows.sort((a, b) => b.shot_count - a.shot_count || a.character.localeCompare(b.character));
    return {
        project_id: projectId,
        characters: rows,
        // The line that turns a report into a decision.
        needs_plate: rows.filter(r => !r.has_plate && r.shot_count > 0)
            .map(r => ({ character: r.character, shot_count: r.shot_count })),
    };
}

/**
 * Breakdown summary — what each scene contains, scene by scene.
 *
 * The document a first AD reads to know what a day needs. Here it answers the
 * same question about a generation run: which subjects a scene commits us to,
 * and how many shots carry that commitment.
 */
function buildBreakdownSummary(projectId) {
    const { scenes, byScene } = scenesWithShots(projectId);

    const props = db.prepare('SELECT name FROM film_props WHERE project_id = ?').all(projectId)
        .map(p => String(p.name));

    const rows = scenes.map(scene => {
        const shots = byScene.get(scene.id) || [];
        const present = new Set(parseList(scene.characters_present));
        const shotProps = new Set();
        let dialogueLines = 0, durationMs = 0;

        for (const shot of shots) {
            const card = parseCard(shot.scene_card_yaml);
            for (const n of (Array.isArray(card.characters) ? card.characters : [])) {
                present.add(String(n).toUpperCase());
            }
            for (const d of (Array.isArray(card.dialogue) ? card.dialogue : [])) {
                const who = String((d && (d.character || d.speaker)) || '').toUpperCase();
                if (who) present.add(who);
                dialogueLines++;
            }
            for (const p of (Array.isArray(card.props) ? card.props : [])) shotProps.add(String(p));
            durationMs += Number(card.duration_seconds ? card.duration_seconds * 1000 : 0) || 0;
        }

        return {
            scene: sceneNo(scene),
            int_ext: scene.int_ext || '',
            location: scene.location || '',
            time_of_day: scene.time_of_day || '',
            shot_count: shots.length,
            characters: [...present].sort(),
            props: [...shotProps].sort(),
            dialogue_lines: dialogueLines,
            estimated_duration_ms: durationMs,
        };
    });

    return {
        project_id: projectId,
        scenes: rows,
        totals: {
            scenes: rows.length,
            shots: rows.reduce((n, r) => n + r.shot_count, 0),
            dialogue_lines: rows.reduce((n, r) => n + r.dialogue_lines, 0),
            characters: castOf(projectId).length,
            props: props.length,
        },
    };
}

/**
 * Elements list — every taggable element, grouped by type.
 *
 * Grouped rather than flat on purpose: the question it answers is "what props
 * do we need", and a single undifferentiated array is a database dump that
 * makes the reader do the grouping.
 *
 * `scene_count` is what makes it actionable here — an element in one scene and
 * an element in thirty are different problems, and for generation the second
 * is where a missing plate becomes expensive.
 */
function buildElementsList(projectId) {
    const { scenes, byScene } = scenesWithShots(projectId);

    const sceneCountFor = new Map();
    const bump = name => {
        const k = String(name).toUpperCase();
        sceneCountFor.set(k, (sceneCountFor.get(k) || 0) + 1);
    };

    for (const scene of scenes) {
        const present = new Set(parseList(scene.characters_present));
        for (const shot of byScene.get(scene.id) || []) {
            const card = parseCard(shot.scene_card_yaml);
            for (const n of (Array.isArray(card.characters) ? card.characters : [])) present.add(String(n).toUpperCase());
            for (const d of (Array.isArray(card.dialogue) ? card.dialogue : [])) {
                const who = String((d && (d.character || d.speaker)) || '').toUpperCase();
                if (who) present.add(who);
            }
        }
        for (const n of present) bump(n);
    }

    const characters = castOf(projectId).map(name => ({
        name,
        scene_count: sceneCountFor.get(name) || 0,
        described: !!(db.prepare('SELECT appearance_prompt FROM film_characters WHERE project_id = ? AND UPPER(name) = ?')
            .get(projectId, name) || {}).appearance_prompt,
    }));

    // Union the locations table with what the scene headings name. A place can
    // exist in one and not the other — a heading whose row was never created is
    // exactly the state a fresh screenplay upload leaves — and reporting only
    // the table would silently omit locations the film actually shoots in.
    const locRows = db.prepare('SELECT name, description FROM film_locations WHERE project_id = ?').all(projectId);
    const locByName = new Map(locRows.map(l => [String(l.name).toUpperCase(), l]));
    for (const scene of scenes) {
        const name = String(scene.location || '').trim();
        if (name && !locByName.has(name.toUpperCase())) {
            locByName.set(name.toUpperCase(), { name, description: '' });
        }
    }
    const locations = [...locByName.values()].map(l => ({
        name: l.name,
        scene_count: scenes.filter(s => String(s.location || '').toUpperCase() === String(l.name).toUpperCase()).length,
        described: !!String(l.description || '').trim(),
        // Named, because "no row" and "row with no description" need different
        // fixes: one is entities_create, the other is entities_describe.
        has_record: locRows.some(r => String(r.name).toUpperCase() === String(l.name).toUpperCase()),
    }));

    const props = db.prepare('SELECT name, visual_prompt, category FROM film_props WHERE project_id = ?').all(projectId)
        .map(p => ({ name: p.name, category: p.category || 'generic', described: !!String(p.visual_prompt || '').trim() }));

    return {
        project_id: projectId,
        elements: { characters, locations, props },
        // The line that turns a list into work: an element with no description
        // reaches generation as a bare name.
        undescribed: [
            ...characters.filter(c => !c.described).map(c => ({ type: 'character', name: c.name })),
            ...locations.filter(l => !l.described).map(l => ({ type: 'location', name: l.name })),
            ...props.filter(p => !p.described).map(p => ({ type: 'prop', name: p.name })),
        ],
    };
}

/**
 * Run report — the reinterpreted call sheet.
 *
 * StudioBinder distributes a call sheet by email and SMS and tracks who opened
 * it. Neither has an AI-production meaning: nobody needs a call time and there
 * is no crew to confirm. What a director does need is the thing a call sheet is
 * actually for — did the day happen, what did it produce, what went wrong, what
 * did it cost.
 *
 * There is no delivery channel to build. The backend has exactly one dependency
 * and no mail or SMS capability, and adding one to send a notification would
 * reverse a deliberate stance for a feature the agent host already covers: an
 * MCP client can read this after a run and tell the director in the place they
 * are already standing.
 *
 * Failures are listed individually rather than counted. "3 steps failed" sends
 * you to the database; naming them is the difference between a report and a
 * number.
 */
function buildRunReport(projectId, options) {
    const limit = Math.max(1, Math.min(50, Number((options && options.limit) || 10)));

    const runs = db.prepare(
        `SELECT id, run_type, status, current_step, steps_completed, steps_failed,
                total_steps, progress_pct, started_at, completed_at, error_message, shot_id, scene_id
           FROM film_pipeline_runs WHERE project_id = ?
          ORDER BY COALESCE(completed_at, started_at, created_at) DESC LIMIT ?`).all(projectId, limit);

    const list = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };

    const rows = runs.map(r => {
        const failed = list(r.steps_failed);
        return {
            run_id: r.id,
            type: r.run_type,
            status: r.status,
            progress_pct: r.progress_pct,
            steps_completed: list(r.steps_completed).length,
            total_steps: r.total_steps,
            // Named, not counted.
            failed_steps: failed,
            error: r.error_message || null,
            started_at: r.started_at,
            completed_at: r.completed_at,
        };
    });

    const spendRow = db.prepare(
        'SELECT COALESCE(SUM(amount), 0) AS spent, COUNT(*) AS entries FROM film_cost_entries WHERE project_id = ?')
        .get(projectId) || { spent: 0, entries: 0 };
    const budgetRow = db.prepare('SELECT budget_total FROM film_projects WHERE id = ?').get(projectId) || {};
    const limitTotal = Number(budgetRow.budget_total || 0);

    return {
        project_id: projectId,
        runs: rows,
        summary: {
            total: rows.length,
            complete: rows.filter(r => r.status === 'complete').length,
            failed: rows.filter(r => r.status === 'failed').length,
            // completed_with_errors is a real status the orchestrator writes and
            // reads as neither success nor failure; folding it into either would
            // hide the runs most worth looking at.
            partial: rows.filter(r => !['complete', 'failed'].includes(r.status)).length,
            steps_failed: rows.reduce((n, r) => n + r.failed_steps.length, 0),
        },
        spend: {
            recorded: Number(spendRow.spent || 0),
            entries: spendRow.entries || 0,
            budget_total: limitTotal || null,
            remaining: limitTotal > 0 ? limitTotal - Number(spendRow.spent || 0) : null,
        },
        // What to do next, rather than leaving the reader to work it out.
        attention: rows.filter(r => r.failed_steps.length || r.status === 'failed')
            .map(r => ({ run_id: r.run_id, status: r.status, failed_steps: r.failed_steps })),
    };
}

module.exports = { buildSides, buildDOOD, buildBreakdownSummary, buildElementsList, buildRunReport, castOf };
