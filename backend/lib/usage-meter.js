/**
 * Metering: every provider call records what it consumed, automatically.
 *
 * Thirty-one call sites in routes/ and lib/ invoke `.generate()` or
 * `.generateStream()`. Instrumenting thirty-one call sites is how twenty-nine
 * of them end up instrumented — the gap lives in whichever file nobody thought
 * about, and it is invisible, because an untracked generation looks exactly
 * like one that never happened. So the meter is installed at the ONE place all
 * thirty-one already pass through: `resolve()` / `resolveGenerator()` in the
 * provider registry. Adding a route later inherits it; there is nothing to
 * remember. Same reasoning as `lib/shot-references.js` gathering plates once
 * for four paths rather than each path gathering its own.
 *
 * Attribution rides in on the project config. Every call site already writes
 * `resolve('video', parseProjectConfig(scene.project_id))` — the project id is
 * right there, and was thrown away one line before it was needed. It is now
 * stamped onto the config object by `lib/provider-config.js`, so the meter
 * reads it with no call-site edit at all.
 *
 * Two rules the tests pin, because both failure modes cost real money:
 *
 *   A FAILED generation is not billed. A provider that refused produced
 *   nothing and charged nothing; recording it would make the image-fallback
 *   chain — which deliberately walks past providers that decline — look like
 *   three purchases for one image.
 *
 *   A THROWING meter never fails a generation. By the time this code runs the
 *   request has been made and the money is gone. Turning a paid, successful
 *   generation into an error the caller reports as a failure is the worst
 *   available trade, and it is the exact trap `stampAsset()` documents for
 *   fingerprinting.
 */

const pricing = require('./provider-pricing');

/** Which cost_type a capability's money lands under in the ledger. */
const COST_TYPE = {
    llm: 'model_inference',
    image: 'image_generation',
    video: 'video_generation',
    voice: 'voice_tts',
    music: 'music_generation',
    sfx: 'sfx_generation',
    ambient: 'ambient_generation',
    lipsync: 'lipsync_generation',
    post: 'post_production',
    model3d: 'model3d_generation',
    stock: 'license',
};

let _rateOverrides = null;

/** Per-install rate corrections, read once and cached. */
function rateOverrides() {
    if (_rateOverrides) return _rateOverrides;
    _rateOverrides = {};
    try {
        const { db } = require('../db/database');
        for (const row of db.prepare('SELECT * FROM film_provider_rates').all()) {
            const patch = {};
            if (row.native_per_unit != null) patch.native_per_unit = row.native_per_unit;
            if (row.usd_per_native != null) patch.usd_per_native = row.usd_per_native;
            const key = row.model
                ? `${row.provider}:${row.capability}:${row.model}`
                : `${row.provider}:${row.capability}`;
            _rateOverrides[key] = patch;
        }
    } catch (_) { /* pre-migration or no database: the researched book stands */ }
    return _rateOverrides;
}

function invalidateRateCache() { _rateOverrides = null; }

/**
 * Wrap an adapter so every successful generation is metered.
 *
 * The wrapper is a prototype-delegating proxy rather than a copy: an adapter
 * carries `health`, `connection`, `promptLimit`, `_internal` and whatever the
 * next one adds, and a hand-copied wrapper silently drops the field nobody
 * remembered. Callers keep reading `.id`, `.capabilities`, `.supports()` and
 * everything else exactly as before.
 */
function meterAdapter(adapter, ctx) {
    if (!adapter || typeof adapter.generate !== 'function') return adapter;
    if (adapter.__metered) return adapter;

    const wrapped = Object.create(adapter);
    wrapped.__metered = true;
    wrapped.__meterContext = ctx || {};

    wrapped.generate = async function (capability, payload, opts) {
        const started = Date.now();
        const result = await adapter.generate(capability, payload, opts);
        record(adapter, capability, payload, result, ctx, opts, Date.now() - started);
        return result;
    };

    if (typeof adapter.generateStream === 'function') {
        wrapped.generateStream = async function (capability, payload, res, callbacks) {
            const started = Date.now();
            const result = await adapter.generateStream(capability, payload, res, callbacks);
            // A stream reports its payload under `finalData`; normalise so the
            // adapter's own meter() sees the same shape either way.
            const asResult = result && result.ok
                ? { ok: true, data: result.finalData, provider_model: result.provider_model, usage: result.usage, meta: result.meta }
                : result;
            record(adapter, capability, payload, asResult, ctx, {}, Date.now() - started);
            return result;
        };
    }

    return wrapped;
}

/** Meter one completed call. Never throws. */
function record(adapter, capability, payload, result, ctx, opts, latencyMs) {
    try {
        if (!result || result.ok !== true) return;          // refusals cost nothing

        const usage = typeof adapter.meter === 'function'
            ? adapter.meter(capability, payload, result)
            : null;
        if (!usage || !(Number(usage.quantity) > 0)) return;

        const attribution = { ...(ctx || {}), ...meterHints(opts), ...meterHints(payload) };

        recordUsage({
            provider: adapter.id,
            capability,
            model: usage.model || result.provider_model || '',
            unit: usage.unit,
            quantity: usage.quantity,
            parts: usage.parts || null,
            estimated: !!usage.estimated,
            estimate_basis: usage.estimate_basis || '',
            latencyMs,
            ...attribution,
        });
    } catch (err) {
        // The generation succeeded and was paid for. Metering is bookkeeping;
        // it does not get to fail the thing it is keeping books on.
        console.error('[usage-meter] failed to record usage:', err.message);
    }
}

/** Attribution a caller may attach explicitly, overriding the resolved config. */
function meterHints(source) {
    if (!source || typeof source !== 'object') return {};
    const out = {};
    const m = source.__meter || source.meter_context || null;
    const from = m && typeof m === 'object' ? m : source;
    if (from.projectId || from.project_id) out.projectId = from.projectId || from.project_id;
    if (from.shotId || from.shot_id) out.shotId = from.shotId || from.shot_id;
    if (from.sceneId || from.scene_id) out.sceneId = from.sceneId || from.scene_id;
    return out;
}

/**
 * Write one usage event and its matching cost entry.
 *
 * Both, in one transaction. The usage event is the consumption record and the
 * cost entry is the money — and the money table is what the budget bar, the
 * flow gate and the forecast already read. Writing only the usage event would
 * leave every existing consumer of the budget reporting zero while a second,
 * parallel truth accumulated beside it.
 */
function recordUsage(entry) {
    const { db, generateId } = require('../db/database');

    const priced = pricing.priceUsage({
        provider: entry.provider,
        capability: entry.capability,
        model: entry.model,
        unit: entry.unit,
        quantity: entry.quantity,
        parts: entry.parts,
    }, rateOverrides());

    const usageId = generateId();
    const now = new Date().toISOString();
    const projectId = entry.projectId || null;

    // A self-hosted call consumed compute and cost no money. It is recorded as
    // a usage event — so "how many keyframes did the local gateway make" stays
    // answerable — but writes no cost entry, because a stream of $0.00 rows is
    // noise in a ledger a person reads.
    const billable = priced.amount_usd > 0;
    let costEntryId = null;

    const write = db.transaction(() => {
        if (billable && projectId) {
            costEntryId = generateId();
            db.prepare(`
                INSERT INTO film_cost_entries (id, project_id, cost_type, description, amount,
                    currency, gpu_seconds, model_used, scene_id, shot_id, created_at)
                VALUES (?, ?, ?, ?, ?, 'USD', 0, ?, ?, ?, ?)
            `).run(
                costEntryId, projectId,
                COST_TYPE[entry.capability] || 'other',
                describe(entry, priced),
                priced.amount_usd,
                entry.model || '',
                entry.sceneId || null,
                entry.shotId || null,
                now
            );
        }

        db.prepare(`
            INSERT INTO film_usage_events (id, project_id, shot_id, scene_id, cost_entry_id,
                provider, capability, model, unit, quantity, native_unit, native_quantity,
                parts, unit_rate, amount_usd, currency, estimated, estimate_basis,
                source_ref, ok, latency_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, 1, ?, ?)
        `).run(
            usageId, projectId, entry.shotId || null, entry.sceneId || null, costEntryId,
            entry.provider || '', entry.capability || '', entry.model || '',
            entry.unit || 'call', Number(entry.quantity) || 0,
            priced.native_unit || '', priced.native_quantity || 0,
            JSON.stringify(entry.parts || {}),
            priced.unit_rate || 0, priced.amount_usd || 0,
            entry.estimated ? 1 : 0, entry.estimate_basis || '',
            entry.sourceRef || null,
            Number(entry.latencyMs) || 0, now
        );
    });

    write();
    return { id: usageId, cost_entry_id: costEntryId, ...priced };
}

function describe(entry, priced) {
    const qty = trimNumber(entry.quantity);
    const native = priced.native_unit && priced.native_unit !== entry.unit
        ? ` (${trimNumber(priced.native_quantity)} ${priced.native_unit}${priced.native_quantity === 1 ? '' : 's'})`
        : '';
    const model = entry.model ? ` · ${entry.model}` : '';
    return `${entry.capability} via ${entry.provider}${model} — ${qty} ${entry.unit}${qty === 1 ? '' : 's'}${native}`.slice(0, 2000);
}

function trimNumber(n) {
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/**
 * What a project has spent, and what it cost per minute of finished footage.
 *
 * Footage length is the shots' own `duration_ms`, not the number of generated
 * clips — a project storyboarded but not yet shot has real spend and real
 * intended running time, and "cost per minute" is exactly the figure that says
 * whether the remaining work is affordable. Measuring only rendered clips
 * would report Infinity for every project before its first video, which is the
 * moment the number is most useful.
 */
function projectSpend(projectId, opts = {}) {
    const { db } = require('../db/database');

    const totals = db.prepare(`
        SELECT COALESCE(SUM(amount_usd), 0) AS total,
               COUNT(*) AS events,
               COALESCE(SUM(CASE WHEN estimated = 1 THEN amount_usd ELSE 0 END), 0) AS estimated_total,
               COALESCE(SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END), 0) AS estimated_events
        FROM film_usage_events WHERE project_id = ?
    `).get(projectId);

    const byCapability = {};
    for (const row of db.prepare(`
        SELECT capability, COALESCE(SUM(amount_usd), 0) AS usd, COUNT(*) AS calls,
               COALESCE(SUM(native_quantity), 0) AS native_qty,
               MAX(native_unit) AS native_unit
        FROM film_usage_events WHERE project_id = ? GROUP BY capability ORDER BY usd DESC
    `).all(projectId)) {
        byCapability[row.capability] = {
            usd: round2(row.usd), calls: row.calls,
            native_quantity: round2(row.native_qty), native_unit: row.native_unit || '',
        };
    }

    const byProvider = db.prepare(`
        SELECT provider, COALESCE(SUM(amount_usd), 0) AS usd, COUNT(*) AS calls,
               COALESCE(SUM(native_quantity), 0) AS native_quantity, MAX(native_unit) AS native_unit
        FROM film_usage_events WHERE project_id = ? GROUP BY provider ORDER BY usd DESC
    `).all(projectId).map(r => ({ ...r, usd: round2(r.usd), native_quantity: round2(r.native_quantity) }));

    const byModel = db.prepare(`
        SELECT provider, model, capability, COALESCE(SUM(amount_usd), 0) AS usd, COUNT(*) AS calls,
               COALESCE(SUM(quantity), 0) AS quantity, MAX(unit) AS unit
        FROM film_usage_events WHERE project_id = ? AND model <> ''
        GROUP BY provider, model, capability ORDER BY usd DESC
    `).all(projectId).map(r => ({ ...r, usd: round2(r.usd), quantity: round2(r.quantity) }));

    const daily = db.prepare(`
        SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(amount_usd), 0) AS usd, COUNT(*) AS calls
        FROM film_usage_events WHERE project_id = ? GROUP BY day ORDER BY day
    `).all(projectId).map(r => ({ ...r, usd: round2(r.usd) }));

    const footage = db.prepare(`
        SELECT COALESCE(SUM(s.duration_ms), 0) AS ms, COUNT(*) AS shots
        FROM film_shots s JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?
    `).get(projectId);

    const rendered = db.prepare(`
        SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM film_assets
        WHERE project_id = ? AND asset_type IN ('video_raw','video_synced','video_final')
    `).get(projectId);

    const project = db.prepare('SELECT budget_total, budget_currency, title FROM film_projects WHERE id = ?').get(projectId) || {};
    const limit = Number(project.budget_total) || 0;

    const footageSeconds = (footage.ms || 0) / 1000;
    const total = round2(totals.total);

    // Per-shot spend, so the expensive shot is nameable rather than averaged away.
    const perShot = opts.includeShots === false ? [] : db.prepare(`
        SELECT u.shot_id, sh.shot_code, sc.scene_number,
               COALESCE(SUM(u.amount_usd), 0) AS usd, COUNT(*) AS calls, sh.duration_ms
        FROM film_usage_events u
        LEFT JOIN film_shots sh ON sh.id = u.shot_id
        LEFT JOIN film_scenes sc ON sc.id = sh.scene_id
        WHERE u.project_id = ? AND u.shot_id IS NOT NULL
        GROUP BY u.shot_id ORDER BY usd DESC
    `).all(projectId).map(r => ({ ...r, usd: round2(r.usd) }));

    return {
        project_id: projectId,
        project_title: project.title || '',
        currency: project.budget_currency || 'USD',
        total_usd: total,
        call_count: totals.events,
        estimated_usd: round2(totals.estimated_total),
        estimated_calls: totals.estimated_events,
        measured_usd: round2(totals.total - totals.estimated_total),
        budget_limit: limit,
        remaining: limit > 0 ? round2(limit - total) : null,
        budget_used_pct: limit > 0 ? Math.round((total / limit) * 1000) / 10 : null,
        footage_seconds: Math.round(footageSeconds * 100) / 100,
        rendered_seconds: Math.round(((rendered.ms || 0) / 1000) * 100) / 100,
        shot_count: footage.shots,
        usd_per_minute: footageSeconds > 0 ? total / (footageSeconds / 60) : 0,
        usd_per_shot: footage.shots > 0 ? round2(total / footage.shots) : 0,
        by_capability: byCapability,
        by_provider: byProvider,
        by_model: byModel,
        by_day: daily,
        by_shot: perShot,
    };
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = {
    meterAdapter, recordUsage, projectSpend, rateOverrides, invalidateRateCache, COST_TYPE,
};
