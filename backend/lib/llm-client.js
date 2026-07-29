/**
 * Provider-aware LLM helper.
 *
 * Keeps text routes from knowing whether the project selected Gridlight
 * (/chat/intelligent) or OpenAI (Responses API).
 */

const { resolveGenerator } = require('./providers');

function parseProjectConfig(project) {
    try { return JSON.parse((project && project.provider_config) || '{}'); } catch (_) { return {}; }
}

function extractAnswer(result) {
    if (!result || !result.ok) return '';
    const data = result.data || {};
    if (typeof data.answer === 'string') return data.answer;
    if (typeof data.response === 'string') return data.response;
    if (typeof data.message === 'string') return data.message;
    if (typeof result.answer === 'string') return result.answer;
    return '';
}

async function callProjectLLM(project, payload, opts) {
    const adapter = resolveGenerator('llm', parseProjectConfig(project));
    const result = await adapter.generate('llm', payload, opts);
    return {
        ...result,
        answer: extractAnswer(result),
        provider: result.provider || adapter.id,
        provider_model: result.provider_model || '',
    };
}

async function streamProjectLLM(project, payload, res, handlers) {
    const adapter = resolveGenerator('llm', parseProjectConfig(project));
    if (!adapter || typeof adapter.generateStream !== 'function') {
        return { ok: false, error: `${adapter ? adapter.id : 'provider'} does not support LLM streaming` };
    }
    return adapter.generateStream('llm', payload, res, handlers);
}

module.exports = { callProjectLLM, streamProjectLLM, parseProjectConfig, extractAnswer };
