/**
 * Node handler registry.
 *
 * Auto-loads every sibling module and registers the handlers it exports, using
 * the same filename-autoload pattern as lib/providers/index.js. Adding a node
 * type is one new file and never an edit to a central switch — the property
 * that keeps parallel work on the palette conflict-free.
 *
 * A handler is:
 *   { execute(node, inputs, ctx) -> { ok, outputs?, skipped?, error?, providerId?, routingNote? } }
 *
 * `inputs` is a map of port name -> { type, value }, or an array of those for a
 * collector port. `outputs` is the same shape, keyed by output port.
 */

const fs = require('fs');
const path = require('path');

const _registry = new Map();

function register(nodeTypeId, handler) {
    if (!nodeTypeId || !handler || typeof handler.execute !== 'function') {
        throw new Error(`node handler for '${nodeTypeId}' must expose execute()`);
    }
    _registry.set(nodeTypeId, handler);
    return handler;
}

const _SKIP = new Set(['index.js']);

function _autoload() {
    let files = [];
    try { files = fs.readdirSync(__dirname); } catch (_) { return; }

    for (const file of files) {
        if (!file.endsWith('.js') || _SKIP.has(file)) continue;
        try {
            const mod = require(path.join(__dirname, file));
            const handlers = mod && mod.handlers;
            if (!handlers) continue;
            for (const [id, handler] of Object.entries(handlers)) {
                if (!_registry.has(id)) register(id, handler);
            }
        } catch (err) {
            console.error(`[node-handlers] failed to load ${file}:`, err.message);
        }
    }
}

function handlerFor(nodeTypeId) {
    return _registry.get(nodeTypeId) || null;
}

function list() {
    return Array.from(_registry.keys()).sort();
}

_autoload();

module.exports = { register, handlerFor, list };
