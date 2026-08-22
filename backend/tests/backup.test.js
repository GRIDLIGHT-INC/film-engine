// Set up temp data dir before any module imports (database.js reads DATA_DIR at require time)
const os = require('os');
const crypto = require('crypto');
const _testDir = require('path').join(os.tmpdir(), 'film-backup-test-' + crypto.randomUUID().slice(0, 8));
require('fs').mkdirSync(_testDir, { recursive: true });
process.env.FILM_DATA_DIR = _testDir;

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { exportProjectData, importProjectData, BACKUP_TABLES } = require('../lib/backup');
const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');

// Run migrations on the temp DB
ensureSchema();

// Ensure a test project exists
let projectId;

before(() => {
    projectId = generateId();
    db.prepare(`
        INSERT INTO film_projects (id, title, status)
        VALUES (?, 'Backup Test Project', 'concept')
    `).run(projectId);

    // Add a scene
    const sceneId = generateId();
    db.prepare(`
        INSERT INTO film_scenes (id, project_id, scene_number, location, int_ext, time_of_day, status)
        VALUES (?, ?, 1, 'Test', 'INT', 'DAY', 'written')
    `).run(sceneId, projectId);

    // Add a shot
    const shotId = generateId();
    db.prepare(`
        INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, created_at)
        VALUES (?, ?, '001A', '{}', 5000, datetime('now'))
    `).run(shotId, sceneId);

    // Add a character
    db.prepare(`
        INSERT INTO film_characters (id, project_id, name)
        VALUES (?, ?, 'Test Character')
    `).run(generateId(), projectId);

    // Add a milestone
    db.prepare(`
        INSERT INTO film_milestones (id, project_id, title, status)
        VALUES (?, ?, 'Alpha', 'pending')
    `).run(generateId(), projectId);
});

describe('BACKUP_TABLES', () => {
    it('includes core tables', () => {
        assert.ok(BACKUP_TABLES.includes('film_projects'));
        assert.ok(BACKUP_TABLES.includes('film_scenes'));
        assert.ok(BACKUP_TABLES.includes('film_shots'));
        assert.ok(BACKUP_TABLES.includes('film_characters'));
    });

    it('includes new Phase 15-18 tables', () => {
        // film_acts is deliberately absent: acts are Fountain `#` sections and
        // the table was dropped in migration 076. The screenplay itself is
        // exported (film_scripts), so act structure travels with the bundle —
        // asserted below rather than assumed.
        assert.ok(!BACKUP_TABLES.includes('film_acts'),
            'the backup names a table that no longer exists — every export would throw');
        assert.ok(BACKUP_TABLES.includes('film_scripts'),
            'the screenplay is not exported, so act structure would not travel');
        assert.ok(BACKUP_TABLES.includes('film_subtitles'));
        assert.ok(BACKUP_TABLES.includes('film_audio_deliverables'));
        assert.ok(BACKUP_TABLES.includes('film_continuity_refs'));
        assert.ok(BACKUP_TABLES.includes('film_credits'));
        assert.ok(BACKUP_TABLES.includes('film_title_cards'));
        assert.ok(BACKUP_TABLES.includes('film_marketing_assets'));
        assert.ok(BACKUP_TABLES.includes('film_cost_entries'));
    });
});

describe('exportProjectData', () => {
    it('returns null for non-existent project', () => {
        const result = exportProjectData('00000000-0000-0000-0000-000000000000');
        assert.equal(result, null);
    });

    it('exports project data with correct structure', () => {
        const result = exportProjectData(projectId);
        assert.ok(result);
        assert.ok(result.data);
        assert.ok(result.rowCounts);
        assert.ok(result.tablesIncluded);
    });

    it('includes the project itself', () => {
        const result = exportProjectData(projectId);
        assert.equal(result.data.film_projects.length, 1);
        assert.equal(result.data.film_projects[0].id, projectId);
        assert.equal(result.data.film_projects[0].title, 'Backup Test Project');
    });

    it('includes scenes for the project', () => {
        const result = exportProjectData(projectId);
        assert.ok(result.data.film_scenes.length >= 1);
        assert.equal(result.data.film_scenes[0].project_id, projectId);
    });

    it('includes shots via scene join', () => {
        const result = exportProjectData(projectId);
        assert.ok(result.data.film_shots.length >= 1);
    });

    it('includes characters', () => {
        const result = exportProjectData(projectId);
        assert.ok(result.data.film_characters.length >= 1);
    });

    it('includes milestones', () => {
        const result = exportProjectData(projectId);
        assert.ok(result.data.film_milestones.length >= 1);
    });

    it('rowCounts matches data lengths', () => {
        const result = exportProjectData(projectId);
        assert.equal(result.rowCounts.film_projects, 1);
        assert.equal(result.rowCounts.film_scenes, result.data.film_scenes.length);
        assert.equal(result.rowCounts.film_shots, result.data.film_shots.length);
    });

    it('tablesIncluded lists all exported tables', () => {
        const result = exportProjectData(projectId);
        assert.ok(result.tablesIncluded.includes('film_projects'));
        assert.ok(result.tablesIncluded.includes('film_scenes'));
    });
});

describe('importProjectData', () => {
    it('returns error for null input', () => {
        const result = importProjectData(null);
        assert.equal(result.success, false);
    });

    it('returns error for empty data', () => {
        const result = importProjectData({});
        assert.equal(result.success, false);
    });

    it('returns error for data without projects', () => {
        const result = importProjectData({ film_projects: [] });
        assert.equal(result.success, false);
    });

    it('imports data successfully', () => {
        // Export first
        const exported = exportProjectData(projectId);

        // Change the project ID to simulate import of a "new" project
        const newProjectId = generateId();
        exported.data.film_projects[0].id = newProjectId;
        exported.data.film_projects[0].title = 'Imported Project';

        // Update project_id references
        for (const scene of exported.data.film_scenes) {
            scene.project_id = newProjectId;
            scene.id = generateId();
        }

        const result = importProjectData(exported.data);
        assert.equal(result.success, true);
        assert.ok(result.imported.film_projects >= 1);

        // Verify the imported project exists
        const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(newProjectId);
        assert.ok(project);
        assert.equal(project.title, 'Imported Project');

        // Clean up
        db.prepare('DELETE FROM film_projects WHERE id = ?').run(newProjectId);
    });
});

describe('round-trip', () => {
    it('export then import preserves project data', () => {
        const exported = exportProjectData(projectId);
        const result = importProjectData(exported.data);
        assert.equal(result.success, true);

        // Verify project still exists and is unchanged
        const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
        assert.equal(project.title, 'Backup Test Project');
    });
});
