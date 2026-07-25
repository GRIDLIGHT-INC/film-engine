const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const testDir = path.join(os.tmpdir(), 'film-ops-compliance-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(testDir, { recursive: true });
process.env.FILM_DATA_DIR = testDir;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ensureSchema } = require('../db/schema');
const { db, generateId } = require('../db/database');
const { handleJobs } = require('../routes/jobs');
const { handleAssets } = require('../routes/assets');
const { handlePostProduction } = require('../routes/post-production');
const { handleSubtitles } = require('../routes/subtitles');
const { handleQA } = require('../routes/qa');
const { EXPORT_TABLES, ASSET_SUBDIRS } = require('../lib/project-bundle');

ensureSchema();

function invoke(handler, { method = 'GET', parts, query = {}, body = {} }) {
    const req = { method, body };
    const res = {
        statusCode: 0,
        headers: {},
        raw: '',
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers || {};
        },
        end(payload) {
            this.raw = payload || '';
        },
    };
    const out = handler(req, res, parts, query);
    if (out && typeof out.then === 'function') {
        return out.then(() => parseResponse(res));
    }
    return parseResponse(res);
}

function parseResponse(res) {
    let data = {};
    try { data = JSON.parse(res.raw || '{}'); } catch (_) { data = res.raw; }
    return { status: res.statusCode, data };
}

describe('ops/compliance gap closures', () => {
    let projectId;
    let sceneId;
    let shotId;

    before(() => {
        projectId = generateId();
        sceneId = generateId();
        shotId = generateId();
        db.prepare('INSERT INTO film_projects (id, title, status) VALUES (?, ?, ?)').run(projectId, 'Ops Compliance', 'post-production');
        db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location, time_of_day) VALUES (?, ?, ?, ?, ?)').run(sceneId, projectId, 1, 'LAB', 'NIGHT');
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, status) VALUES (?, ?, ?, ?, ?)').run(shotId, sceneId, '1A', 5000, 'complete');
    });

    after(() => {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    });

    it('returns an empty unified queue for a valid project with no jobs', () => {
        const res = invoke(handleJobs, { parts: ['film', 'projects', projectId, 'jobs'] });
        assert.equal(res.status, 200);
        assert.equal(res.data.total, 0);
        assert.deepEqual(res.data.jobs, []);
    });

    it('aggregates jobs across generation job tables', () => {
        db.prepare(`
            INSERT INTO film_video_jobs (id, project_id, shot_id, status, prompt, model)
            VALUES (?, ?, ?, 'generating', 'wide shot', 'animatediff')
        `).run(generateId(), projectId, shotId);
        db.prepare(`
            INSERT INTO film_music_jobs (id, project_id, scene_id, shot_id, gen_type, status, prompt, model)
            VALUES (?, ?, ?, ?, 'score', 'complete', 'tense pulse', 'musicgen')
        `).run(generateId(), projectId, sceneId, shotId);

        const res = invoke(handleJobs, { parts: ['film', 'projects', projectId, 'jobs'] });
        assert.equal(res.status, 200);
        assert.equal(res.data.total, 2);
        assert.equal(res.data.summary.active, 1);
        assert.equal(res.data.summary.complete, 1);
    });

    it('creates general rights records and exposes them in provenance', () => {
        const right = invoke(handleAssets, {
            method: 'POST',
            parts: ['film', 'projects', projectId, 'rights'],
            body: {
                subject: 'Synthetic lead voice',
                entity_type: 'voice',
                rights_type: 'voice_clone',
                status: 'cleared',
                territory: 'worldwide',
            },
        });
        assert.equal(right.status, 201);
        assert.equal(right.data.subject, 'Synthetic lead voice');

        const list = invoke(handleAssets, { parts: ['film', 'projects', projectId, 'rights'] });
        assert.equal(list.status, 200);
        assert.equal(list.data.total, 1);

        const provenance = invoke(handleAssets, { parts: ['film', 'projects', projectId, 'provenance'] });
        assert.equal(provenance.status, 200);
        assert.equal(provenance.data.c2pa_status, 'sidecar_only_not_signed');
        assert.equal(provenance.data.manifest.counts.rights_records, 1);
    });

    it('writes a project provenance sidecar record', () => {
        const res = invoke(handleAssets, { method: 'POST', parts: ['film', 'projects', projectId, 'provenance', 'export'] });
        assert.equal(res.status, 201);
        assert.ok(res.data.sidecar_path.includes('provenance'));

        const count = db.prepare('SELECT COUNT(*) AS count FROM film_provenance_manifests WHERE project_id = ?').get(projectId).count;
        assert.equal(count, 1);
    });

    it('upserts the ACES/CDL color pipeline', async () => {
        const res = await invoke(handlePostProduction, {
            method: 'PUT',
            parts: ['film', 'projects', projectId, 'post', 'color-pipeline'],
            body: {
                aces_version: 'ACES 1.3',
                working_space: 'ACEScct',
                target_color_space: 'Rec.709',
                cdl_slope: [1.05, 1, 0.98],
            },
        });
        assert.equal(res.status, 201);
        assert.equal(res.data.pipeline.working_space, 'ACEScct');

        const get = await invoke(handlePostProduction, { parts: ['film', 'projects', projectId, 'post', 'color-pipeline'] });
        assert.equal(get.status, 200);
        assert.equal(get.data.pipeline.target_color_space, 'Rec.709');
    });

    it('creates a dubbing package from subtitle cues', () => {
        const subtitle = invoke(handleSubtitles, {
            method: 'POST',
            parts: ['film', 'projects', projectId, 'subtitles'],
            body: { language: 'en', start_ms: 0, end_ms: 1200, text: 'Hello world', shot_id: shotId },
        });
        assert.equal(subtitle.status, 201);

        const dub = invoke(handleSubtitles, {
            method: 'POST',
            parts: ['film', 'projects', projectId, 'subtitles', 'dubbing'],
            body: { source_language: 'en', target_language: 'es', voice_strategy: 'preserve_character' },
        });
        assert.equal(dub.status, 201);
        assert.equal(dub.data.cue_count, 1);
        assert.equal(dub.data.package.cues[0].source_text, 'Hello world');
    });

    it('persists broadcast QC reports', () => {
        db.prepare(`
            INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
            VALUES (?, ?, ?, 'video_final', '/video/final.mp4', 'final.mp4')
        `).run(generateId(), projectId, shotId);

        const run = invoke(handleQA, { method: 'POST', parts: ['film', 'projects', projectId, 'qa', 'broadcast'], body: {} });
        assert.equal(run.status, 200);
        assert.ok(['pass', 'warning', 'fail'].includes(run.data.status));
        assert.ok(run.data.checks.some(check => check.key === 'provenance_disclosure'));

        const list = invoke(handleQA, { parts: ['film', 'projects', projectId, 'qa', 'broadcast'] });
        assert.equal(list.status, 200);
        assert.equal(list.data.total, 1);
    });

    it('includes ops/compliance records in project bundle exports', () => {
        const tables = EXPORT_TABLES.map(row => row.table);
        assert.ok(tables.includes('film_rights'));
        assert.ok(tables.includes('film_provenance_manifests'));
        assert.ok(tables.includes('film_color_pipelines'));
        assert.ok(tables.includes('film_dubbing_jobs'));
        assert.ok(tables.includes('film_broadcast_qc_reports'));
        assert.ok(ASSET_SUBDIRS.includes('provenance'));
    });
});
