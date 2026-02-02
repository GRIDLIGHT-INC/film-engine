const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { exportProject, importProject, EXPORT_TABLES, ASSET_SUBDIRS } = require('../lib/project-bundle');
const { db, generateId } = require('../db/database');
const { DATA_DIR } = require('../lib/file-storage');
const fs = require('fs');
const path = require('path');

describe('project-bundle', () => {
    let projectId;
    let scriptId;
    let sceneId;
    let shotId;
    let characterId;

    before(() => {
        // Create a test project with related data
        projectId = generateId();
        db.prepare(`
            INSERT INTO film_projects (id, title, logline, genre, status)
            VALUES (?, ?, ?, ?, ?)
        `).run(projectId, 'Bundle Test Project', 'A test project for bundle export', 'Test', 'script');

        scriptId = generateId();
        db.prepare(`
            INSERT INTO film_scripts (id, project_id, version, fountain_content)
            VALUES (?, ?, ?, ?)
        `).run(scriptId, projectId, 1, 'INT. OFFICE - DAY\n\nA test scene.\n\nJOHN\nHello world.');

        sceneId = generateId();
        db.prepare(`
            INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sceneId, projectId, 1, 'INT', 'OFFICE', 'DAY', 'A test scene');

        shotId = generateId();
        db.prepare(`
            INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, status)
            VALUES (?, ?, ?, ?, ?)
        `).run(shotId, sceneId, 'SC1A', 5000, 'pending');

        characterId = generateId();
        db.prepare(`
            INSERT INTO film_characters (id, project_id, name)
            VALUES (?, ?, ?)
        `).run(characterId, projectId, 'John');

        // Create a fake storyboard file
        const storyDir = path.join(DATA_DIR, 'storyboards', projectId);
        fs.mkdirSync(storyDir, { recursive: true });
        fs.writeFileSync(path.join(storyDir, 'SC1A.png'), 'fake-image-data');
    });

    after(() => {
        // Clean up test data
        db.prepare('DELETE FROM film_characters WHERE id = ?').run(characterId);
        db.prepare('DELETE FROM film_shots WHERE id = ?').run(shotId);
        db.prepare('DELETE FROM film_scenes WHERE id = ?').run(sceneId);
        db.prepare('DELETE FROM film_scripts WHERE id = ?').run(scriptId);
        db.prepare('DELETE FROM film_projects WHERE id = ?').run(projectId);

        // Clean up storyboard dir
        const storyDir = path.join(DATA_DIR, 'storyboards', projectId);
        if (fs.existsSync(storyDir)) fs.rmSync(storyDir, { recursive: true, force: true });

        // Clean up any temp export directories
        const tmpBase = path.join(DATA_DIR, '.tmp-export');
        if (fs.existsSync(tmpBase)) fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    describe('EXPORT_TABLES', () => {
        it('includes all core tables', () => {
            const tables = EXPORT_TABLES.map(t => t.table);
            assert.ok(tables.includes('film_projects'));
            assert.ok(tables.includes('film_scripts'));
            assert.ok(tables.includes('film_scenes'));
            assert.ok(tables.includes('film_shots'));
            assert.ok(tables.includes('film_characters'));
        });

        it('has film_projects first (dependency order)', () => {
            assert.equal(EXPORT_TABLES[0].table, 'film_projects');
        });
    });

    describe('ASSET_SUBDIRS', () => {
        it('includes expected directories', () => {
            assert.ok(ASSET_SUBDIRS.includes('storyboards'));
            assert.ok(ASSET_SUBDIRS.includes('audio'));
            assert.ok(ASSET_SUBDIRS.includes('video'));
            assert.ok(ASSET_SUBDIRS.includes('music'));
        });
    });

    describe('exportProject', () => {
        it('throws for non-existent project', () => {
            assert.throws(() => exportProject(generateId()), /Project not found/);
        });

        it('exports a valid .tar.gz archive', () => {
            const result = exportProject(projectId);

            assert.ok(result.archivePath);
            assert.ok(result.archiveName);
            assert.ok(result.archiveName.endsWith('.tar.gz'));
            assert.ok(fs.existsSync(result.archivePath));

            // Archive should be > 0 bytes
            const stat = fs.statSync(result.archivePath);
            assert.ok(stat.size > 0);

            // Clean up
            fs.unlinkSync(result.archivePath);
        });

        it('manifest contains project data', () => {
            const result = exportProject(projectId);
            const manifest = result.manifest;

            assert.equal(manifest.version, 1);
            assert.equal(manifest.format, 'film-engine-bundle');
            assert.equal(manifest.source_project_id, projectId);
            assert.ok(manifest.exported_at);

            // Check tables
            assert.ok(manifest.tables.film_projects.length >= 1);
            assert.equal(manifest.tables.film_projects[0].title, 'Bundle Test Project');
            assert.ok(manifest.tables.film_scripts.length >= 1);
            assert.ok(manifest.tables.film_scenes.length >= 1);
            assert.ok(manifest.tables.film_shots.length >= 1);
            assert.ok(manifest.tables.film_characters.length >= 1);

            // Clean up
            fs.unlinkSync(result.archivePath);
        });

        it('archive name uses project title', () => {
            const result = exportProject(projectId);
            assert.ok(result.archiveName.startsWith('Bundle_Test_Project-'));
            fs.unlinkSync(result.archivePath);
        });
    });

    describe('importProject (round-trip)', () => {
        let archiveBuffer;
        let importedProjectId;

        it('imports an exported bundle', () => {
            // Export first
            const exported = exportProject(projectId);
            archiveBuffer = fs.readFileSync(exported.archivePath);
            fs.unlinkSync(exported.archivePath);

            // Import
            const result = importProject(archiveBuffer);

            assert.ok(result.project);
            assert.ok(result.project.id);
            assert.notEqual(result.project.id, projectId, 'Should get a new project ID');
            assert.equal(result.project.title, 'Bundle Test Project');
            importedProjectId = result.project.id;

            // Check stats
            assert.ok(result.stats.tables.film_projects >= 1);
            assert.ok(result.stats.tables.film_scripts >= 1);
            assert.ok(result.stats.tables.film_scenes >= 1);
            assert.ok(result.stats.tables.film_shots >= 1);
            assert.ok(result.stats.tables.film_characters >= 1);
        });

        it('imported project has correct data', () => {
            if (!importedProjectId) return;

            const scripts = db.prepare('SELECT * FROM film_scripts WHERE project_id = ?').all(importedProjectId);
            assert.ok(scripts.length >= 1);
            assert.ok(scripts[0].fountain_content.includes('INT. OFFICE'));

            const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ?').all(importedProjectId);
            assert.ok(scenes.length >= 1);
            assert.equal(scenes[0].location, 'OFFICE');

            const shots = db.prepare(
                'SELECT * FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?)'
            ).all(importedProjectId);
            assert.ok(shots.length >= 1);

            const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(importedProjectId);
            assert.ok(characters.length >= 1);
            assert.equal(characters[0].name, 'John');
        });

        it('copies asset files with new project ID', () => {
            if (!importedProjectId) return;

            const storyDir = path.join(DATA_DIR, 'storyboards', importedProjectId);
            assert.ok(fs.existsSync(storyDir), 'Storyboard dir should exist');
            assert.ok(fs.existsSync(path.join(storyDir, 'SC1A.png')), 'Storyboard file should exist');

            const content = fs.readFileSync(path.join(storyDir, 'SC1A.png'), 'utf8');
            assert.equal(content, 'fake-image-data');
        });

        it('id_map contains old and new project IDs', () => {
            // Re-export and import to test id_map
            const exported = exportProject(projectId);
            const buf = fs.readFileSync(exported.archivePath);
            fs.unlinkSync(exported.archivePath);
            const result = importProject(buf);

            assert.equal(result.id_map.old, projectId);
            assert.ok(result.id_map.new);
            assert.notEqual(result.id_map.new, projectId);

            // Clean up this second import
            const pid = result.id_map.new;
            db.prepare('DELETE FROM film_characters WHERE project_id = ?').run(pid);
            db.prepare('DELETE FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?)').run(pid);
            db.prepare('DELETE FROM film_scenes WHERE project_id = ?').run(pid);
            db.prepare('DELETE FROM film_scripts WHERE project_id = ?').run(pid);
            db.prepare('DELETE FROM film_projects WHERE id = ?').run(pid);
            const d = path.join(DATA_DIR, 'storyboards', pid);
            if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
        });

        after(() => {
            // Clean up imported project
            if (!importedProjectId) return;
            db.prepare('DELETE FROM film_characters WHERE project_id = ?').run(importedProjectId);
            db.prepare('DELETE FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?)').run(importedProjectId);
            db.prepare('DELETE FROM film_scenes WHERE project_id = ?').run(importedProjectId);
            db.prepare('DELETE FROM film_scripts WHERE project_id = ?').run(importedProjectId);
            db.prepare('DELETE FROM film_projects WHERE id = ?').run(importedProjectId);
            const storyDir = path.join(DATA_DIR, 'storyboards', importedProjectId);
            if (fs.existsSync(storyDir)) fs.rmSync(storyDir, { recursive: true, force: true });
        });
    });

    describe('importProject (error handling)', () => {
        it('rejects invalid archive (not tar.gz)', () => {
            assert.throws(
                () => importProject(Buffer.from('not a tar.gz file')),
                /failed|error|Invalid/i
            );
        });

        it('rejects archive without manifest', () => {
            // Create a valid tar.gz without manifest.json
            const { execSync } = require('child_process');
            const tmpDir = path.join(DATA_DIR, '.tmp-export', 'test-no-manifest');
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
            const tmpArchive = path.join(DATA_DIR, '.tmp-export', 'test-no-manifest.tar.gz');
            execSync(`tar czf "${tmpArchive}" -C "${tmpDir}" .`);
            const buf = fs.readFileSync(tmpArchive);
            fs.rmSync(tmpDir, { recursive: true, force: true });
            fs.unlinkSync(tmpArchive);

            assert.throws(() => importProject(buf), /manifest\.json not found/);
        });
    });
});
