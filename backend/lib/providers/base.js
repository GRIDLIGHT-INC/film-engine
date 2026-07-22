/**
 * Provider adapter layer — shared definitions.
 *
 * Film Engine talks to external generation/licensing services through pluggable
 * "provider adapters". Three kinds (see docs/plans/multi-provider-pipeline.md):
 *
 *   generator  — prompt/payload -> NEW asset   (Gridlight, OpenAI, ElevenLabs, ...)
 *   source     — query -> EXISTING licensed asset (Artlist catalog, Epidemic)
 *   mcp        — MCP tool call -> NEW asset       (Artlist AI Toolkit; a generator
 *                                                  whose transport is MCP)
 *
 * Adapter interface (duck-typed; not all methods required):
 *
 *   id           string                unique provider id, e.g. 'gridlight', 'openai'
 *   kind         'generator'|'source'|'mcp'
 *   capabilities string[]              subset of CAPABILITIES
 *   label        string                human-facing name
 *   requiresKey  boolean               whether an API key/credential is needed
 *
 *   supports(capability) -> boolean
 *   // generator/mcp:
 *   generate(capability, payload, opts) -> { ok, status?, data?, error? }
 *   generateStream(capability, payload, res, callbacks) -> { ok, finalData?, error? }
 *   // source:
 *   search(capability, query) -> [{ providerAssetId, title, preview, license }]
 *   license(providerAssetId, opts) -> { downloadUrl|buffer, license:{...} }
 *   // optional lifecycle:
 *   health() -> Promise<{ ok, latencyMs? }>
 *
 * Adapters normalize provider-specific shapes into these signatures so the rest
 * of the app (routes, jobs, film_assets, SSE) stays provider-agnostic.
 */

// Capabilities the pipeline resolves a provider for.
const CAPABILITIES = ['image', 'video', 'music', 'voice', 'sfx', 'ambient', 'lipsync', 'post', 'model3d', 'stock'];

// Default provider per capability when a project/env sets nothing. Gridlight is
// the safe default so behavior is unchanged until a project opts into another.
const DEFAULT_PROVIDER = 'gridlight';

function isCapability(c) {
    return CAPABILITIES.includes(c);
}

module.exports = { CAPABILITIES, DEFAULT_PROVIDER, isCapability };
