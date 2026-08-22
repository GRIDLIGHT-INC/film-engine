/**
 * FILM-161: Auto-backup system
 * JSON-only project backups (lighter than tar.gz bundles).
 */
const { db } = require('../db/database');

const BACKUP_TABLES = [
    'film_projects',
    'film_scripts',
    'film_scenes',
    'film_shots',
    'film_characters',
    'film_costumes',
    'film_voice_profiles',
    'film_locations',
    'film_props',
    'film_shot_notes',
    'film_shot_versions',
    'film_milestones',
    'film_assets',
    'film_music_cues',
    'film_color_presets',
    'render_ledger',
    'film_subtitles',
    'film_audio_deliverables',
    'film_continuity_refs',
    'film_credits',
    'film_title_cards',
    'film_marketing_assets',
    'film_cost_entries',
];

/**
 * Export all project data as a JSON object.
 * Each table is keyed by name with rows filtered to project_id.
 */
function exportProjectData(projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;

    const data = { film_projects: [project] };
    const rowCounts = { film_projects: 1 };

    for (const table of BACKUP_TABLES) {
        if (table === 'film_projects') continue;

        // Check if table exists
        const tableInfo = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table);
        if (!tableInfo) continue;

        // Check which foreign key column to use
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        const colNames = columns.map(c => c.name);

        let rows = [];
        if (colNames.includes('project_id')) {
            rows = db.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId);
        } else if (colNames.includes('scene_id')) {
            // Join through scenes → project
            rows = db.prepare(`
                SELECT t.* FROM ${table} t
                JOIN film_scenes sc ON t.scene_id = sc.id
                WHERE sc.project_id = ?
            `).all(projectId);
        } else if (colNames.includes('shot_id')) {
            // Join through shots → scenes → project
            rows = db.prepare(`
                SELECT t.* FROM ${table} t
                JOIN film_shots s ON t.shot_id = s.id
                JOIN film_scenes sc ON s.scene_id = sc.id
                WHERE sc.project_id = ?
            `).all(projectId);
        }

        data[table] = rows;
        rowCounts[table] = rows.length;
    }

    return { data, rowCounts, tablesIncluded: Object.keys(data) };
}

/**
 * Import project data from a backup JSON object.
 * Inserts rows using INSERT OR REPLACE to handle conflicts.
 */
function importProjectData(backupData) {
    if (!backupData || !backupData.film_projects || !backupData.film_projects.length) {
        return { success: false, error: 'No project data in backup' };
    }

    const imported = {};

    const doImport = db.transaction(() => {
        for (const table of BACKUP_TABLES) {
            const rows = backupData[table];
            if (!rows || !rows.length) continue;

            // Get column info for the table
            const tableInfo = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
            ).get(table);
            if (!tableInfo) continue;

            const columns = db.prepare(`PRAGMA table_info(${table})`).all();
            const colNames = columns.map(c => c.name);

            let count = 0;
            for (const row of rows) {
                const keys = Object.keys(row).filter(k => colNames.includes(k));
                const placeholders = keys.map(() => '?').join(', ');
                const values = keys.map(k => row[k]);

                db.prepare(
                    `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
                ).run(...values);
                count++;
            }
            imported[table] = count;
        }
    });

    doImport();
    return { success: true, imported };
}

module.exports = {
    exportProjectData,
    importProjectData,
    BACKUP_TABLES,
};
