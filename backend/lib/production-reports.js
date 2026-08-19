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

module.exports = { buildSides, buildDOOD, castOf };
