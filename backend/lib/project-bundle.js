/**
 * Project Bundle — Export & Import
 *
 * Exports a complete project (DB rows + asset files) as a .tar.gz archive.
 * Imports a .tar.gz archive to recreate a project on another instance.
 *
 * Bundle structure:
 *   manifest.json              — All DB rows with ID mappings
 *   storyboards/<file>         — Storyboard images
 *   audio/<file>               — Voice audio files
 *   video/<file>               — Video files
 *   music/<file>               — Music/SFX/ambient files
 *   refsheets/<file>           — Character reference sheets
 *   provenance/<file>          — AI provenance/disclosure sidecars
 */

const { db, generateId } = require('../db/database');
const { DATA_DIR } = require('./file-storage');
const fs = require('fs');
const path = require('path');
const { CACHE_DIRNAME: THUMB_CACHE_DIR } = require('./thumbnails');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Asset subdirectories to include in bundle
const ASSET_SUBDIRS = ['storyboards', 'audio', 'video', 'music', 'refsheets', 'provenance'];

// Tables to export, in dependency order (parents before children)
const EXPORT_TABLES = [
    { table: 'film_projects', key: 'id', filter: 'id = ?' },
    { table: 'film_scripts', key: 'id', filter: 'project_id = ?' },
    { table: 'film_scenes', key: 'id', filter: 'project_id = ?' },
    { table: 'film_shots', key: 'id', filter: 'scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?)' },
    { table: 'film_characters', key: 'id', filter: 'project_id = ?' },
    { table: 'film_locations', key: 'id', filter: 'project_id = ?' },
    { table: 'film_props', key: 'id', filter: 'project_id = ?' },
    { table: 'film_costumes', key: 'id', filter: 'character_id IN (SELECT id FROM film_characters WHERE project_id = ?)' },
    { table: 'film_voice_profiles', key: 'id', filter: 'character_id IN (SELECT id FROM film_characters WHERE project_id = ?)' },
    { table: 'film_shot_notes', key: 'id', filter: 'shot_id IN (SELECT id FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?))' },
    { table: 'film_shot_versions', key: 'id', filter: 'shot_id IN (SELECT id FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?))' },
    { table: 'film_milestones', key: 'id', filter: 'project_id = ?' },
    { table: 'film_assets', key: 'id', filter: 'project_id = ?' },
    { table: 'film_music_cues', key: 'id', filter: 'project_id = ?' },
    { table: 'film_color_presets', key: 'id', filter: 'project_id = ?' },
    { table: 'film_rights', key: 'id', filter: 'project_id = ?' },
    { table: 'film_provenance_manifests', key: 'id', filter: 'project_id = ?' },
    { table: 'film_color_pipelines', key: 'id', filter: 'project_id = ?' },
    { table: 'film_dubbing_jobs', key: 'id', filter: 'project_id = ?' },
    { table: 'film_broadcast_qc_reports', key: 'id', filter: 'project_id = ?' },
    { table: 'film_script_elements', key: 'id', filter: 'script_id IN (SELECT id FROM film_scripts WHERE project_id = ?)' },
    { table: 'render_ledger', key: 'id', filter: 'shot_id IN (SELECT id FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?))' },
    { table: 'film_screenplay_comments', key: 'id', filter: 'script_id IN (SELECT id FROM film_scripts WHERE project_id = ?)' },
];

// Foreign key columns that reference IDs needing remapping
const FK_REMAP = {
    film_scripts: { project_id: 'film_projects' },
    film_scenes: { project_id: 'film_projects' },
    film_shots: { scene_id: 'film_scenes' },
    film_characters: { project_id: 'film_projects' },
    film_locations: { project_id: 'film_projects' },
    film_props: { project_id: 'film_projects' },
    film_costumes: { character_id: 'film_characters' },
    film_voice_profiles: { character_id: 'film_characters' },
    film_shot_notes: { shot_id: 'film_shots' },
    film_shot_versions: { shot_id: 'film_shots' },
    film_milestones: { project_id: 'film_projects' },
    film_assets: { project_id: 'film_projects', shot_id: 'film_shots' },
    film_music_cues: { project_id: 'film_projects' },
    film_color_presets: { project_id: 'film_projects' },
    film_rights: { project_id: 'film_projects' },
    film_provenance_manifests: { project_id: 'film_projects', asset_id: 'film_assets' },
    film_color_pipelines: { project_id: 'film_projects', lut_asset_id: 'film_assets' },
    film_dubbing_jobs: { project_id: 'film_projects', output_asset_id: 'film_assets' },
    film_broadcast_qc_reports: { project_id: 'film_projects' },
    film_script_elements: { script_id: 'film_scripts' },
    render_ledger: { shot_id: 'film_shots' },
    film_screenplay_comments: { script_id: 'film_scripts' },
};

/**
 * Copy a project's asset directory, subdirectories and all.
 *
 * `readdirSync` + `copyFileSync` throws EISDIR the moment a subdirectory
 * appears, and one has been there since frames started being archived:
 * `storyboards/<project>/versions/` holds every superseded attempt. On a real
 * project that is 61 files, and exporting it threw rather than producing a
 * bundle — a backup that fails on exactly the projects worth backing up.
 *
 * `.thumbs` is skipped deliberately. It is a derived cache rebuilt on demand
 * from the pictures beside it, so bundling it would inflate every archive with
 * bytes the importing machine can regenerate for free.
 */
function copyAssetTree(srcDir, destDir, onFile) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (entry.name === THUMB_CACHE_DIR) continue;
        const from = path.join(srcDir, entry.name);
        const to = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(to, { recursive: true });
            copyAssetTree(from, to, onFile);
        } else if (entry.isFile()) {
            fs.copyFileSync(from, to);
            if (onFile) onFile();
        }
    }
}


/**
 * Export a project to a .tar.gz bundle.
 * @param {string} projectId
 * @returns {{ archivePath: string, manifest: object }} Path to the .tar.gz and the manifest
 */
function exportProject(projectId) {
    // Verify project exists
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('Project not found');

    // Create temp staging directory
    const tmpBase = path.join(DATA_DIR, '.tmp-export');
    if (!fs.existsSync(tmpBase)) fs.mkdirSync(tmpBase, { recursive: true });
    const stagingDir = path.join(tmpBase, `export-${projectId}-${Date.now()}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    // Export all table data
    const manifest = {
        version: 1,
        format: 'film-engine-bundle',
        exported_at: new Date().toISOString(),
        source_project_id: projectId,
        tables: {},
    };

    for (const { table, filter } of EXPORT_TABLES) {
        try {
            const rows = db.prepare(`SELECT * FROM ${table} WHERE ${filter}`).all(projectId);
            manifest.tables[table] = rows;
        } catch (e) {
            // Table might not exist yet (optional migration)
            manifest.tables[table] = [];
        }
    }

    // Write manifest
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Copy asset files
    for (const subdir of ASSET_SUBDIRS) {
        const srcDir = path.join(DATA_DIR, subdir, projectId);
        if (fs.existsSync(srcDir)) {
            const destDir = path.join(stagingDir, subdir);
            fs.mkdirSync(destDir, { recursive: true });
            copyAssetTree(srcDir, destDir);
        }
    }

    // Create tar.gz archive
    const safeTitle = (project.title || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
    const archiveName = `${safeTitle}-${projectId.slice(0, 8)}.tar.gz`;
    const archivePath = path.join(tmpBase, archiveName);
    const tarCreate = spawnSync('tar', ['czf', archivePath, '-C', stagingDir, '.'], { stdio: 'pipe' });
    if (tarCreate.status !== 0) {
        throw new Error('Failed to create archive: ' + (tarCreate.stderr?.toString() || 'unknown error'));
    }

    // Clean up staging directory
    fs.rmSync(stagingDir, { recursive: true, force: true });

    return { archivePath, manifest, archiveName };
}

/**
 * Import a project from a .tar.gz bundle.
 * @param {Buffer} archiveBuffer - The raw .tar.gz buffer
 * @returns {{ project: object, stats: object }} The new project and import stats
 */
function importProject(archiveBuffer) {
    // Create temp extraction directory
    const tmpBase = path.join(DATA_DIR, '.tmp-export');
    if (!fs.existsSync(tmpBase)) fs.mkdirSync(tmpBase, { recursive: true });
    const extractDir = path.join(tmpBase, `import-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });

    // Write buffer to temp file and extract
    const tmpArchive = path.join(tmpBase, `import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpArchive, archiveBuffer);
    const tarExtract = spawnSync('tar', ['xzf', tmpArchive, '-C', extractDir], { stdio: 'pipe' });
    if (tarExtract.status !== 0) {
        fs.unlinkSync(tmpArchive);
        throw new Error('Failed to extract archive: ' + (tarExtract.stderr?.toString() || 'unknown error'));
    }
    fs.unlinkSync(tmpArchive);

    // Read manifest
    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error('Invalid bundle: manifest.json not found');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    if (manifest.format !== 'film-engine-bundle' || manifest.version !== 1) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error('Unsupported bundle format or version');
    }

    // Build ID remap: old ID → new ID (new UUIDs for every row)
    const idMap = {};
    for (const { table } of EXPORT_TABLES) {
        const rows = manifest.tables[table] || [];
        for (const row of rows) {
            if (row.id && !idMap[row.id]) {
                idMap[row.id] = generateId();
            }
        }
    }

    const stats = { tables: {}, assets_copied: 0 };
    const newProjectId = manifest.tables.film_projects?.[0]?.id
        ? idMap[manifest.tables.film_projects[0].id]
        : null;

    if (!newProjectId) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error('Invalid bundle: no project data');
    }

    // Import in a transaction
    const importAll = db.transaction(() => {
        for (const { table } of EXPORT_TABLES) {
            const rows = manifest.tables[table] || [];
            if (rows.length === 0) { stats.tables[table] = 0; continue; }

            let inserted = 0;
            for (const row of rows) {
                const remapped = Object.fromEntries(
                    Object.entries(row).filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k))
                );

                // Remap the row's own ID
                if (remapped.id && idMap[remapped.id]) {
                    remapped.id = idMap[remapped.id];
                }

                // Remap foreign keys
                const fks = FK_REMAP[table] || {};
                for (const [col, _refTable] of Object.entries(fks)) {
                    if (remapped[col] && idMap[remapped[col]]) {
                        remapped[col] = idMap[remapped[col]];
                    }
                }

                // Build INSERT statement dynamically
                const cols = Object.keys(remapped);
                const placeholders = cols.map(() => '?').join(', ');
                const values = cols.map(c => remapped[c]);

                try {
                    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
                    inserted++;
                } catch (e) {
                    // Skip rows that fail (duplicate, constraint violation)
                    // This can happen if the table schema has changed
                }
            }
            stats.tables[table] = inserted;
        }
    });

    importAll();

    // Copy asset files to data directory with new project ID
    const oldProjectId = manifest.source_project_id;
    for (const subdir of ASSET_SUBDIRS) {
        const srcDir = path.join(extractDir, subdir);
        if (fs.existsSync(srcDir)) {
            const destDir = path.join(DATA_DIR, subdir, newProjectId);
            fs.mkdirSync(destDir, { recursive: true });
            copyAssetTree(srcDir, destDir, () => { stats.assets_copied++; });
        }
    }

    // Clean up extraction directory
    fs.rmSync(extractDir, { recursive: true, force: true });

    // Return the newly created project
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(newProjectId);

    return { project, stats, id_map: { old: oldProjectId, new: newProjectId } };
}

module.exports = {
    // Exposed so the tree copy can be exercised directly: the fault it fixes
    // only appears on a project that has archived frames.
    __copyAssetTree: copyAssetTree, exportProject, importProject, EXPORT_TABLES, ASSET_SUBDIRS };
