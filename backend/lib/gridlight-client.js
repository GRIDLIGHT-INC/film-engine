/**
 * Gridlight API Client
 *
 * Shared HTTP client for calling external generation endpoints
 * (image, video, music, voice, lipsync, postprocess, 3d) at the
 * Gridlight platform. All Film Engine generation routes use this.
 */

const GRIDLIGHT_URL = process.env.GRIDLIGHT_URL || process.env.GATEWAY_URL || 'http://localhost:8080';
const GRIDLIGHT_API_KEY = process.env.GRIDLIGHT_API_KEY || process.env.IMAGEGEN_API_KEY || '';

if (!GRIDLIGHT_API_KEY) {
    console.warn('[security] GRIDLIGHT_API_KEY not set. External API calls will be sent without authentication.');
}

// ── Request Queue / Semaphore (FILM-034) ────────────────────────────
// Limits concurrent requests to external services to avoid overwhelming
// GPU workers. Each endpoint gets its own concurrency slot.

const MAX_CONCURRENT = parseInt(process.env.GRIDLIGHT_MAX_CONCURRENT || '2', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.GRIDLIGHT_MAX_QUEUE || '50', 10);
const RETRY_ON_429_DELAY = parseInt(process.env.GRIDLIGHT_429_RETRY_MS || '5000', 10);
const MAX_429_RETRIES = parseInt(process.env.GRIDLIGHT_429_MAX_RETRIES || '3', 10);

// Per-endpoint semaphore state
const _queues = {};          // endpoint → { active: number, waiting: Array<{resolve, reject}> }

function _getQueue(endpoint) {
    if (!_queues[endpoint]) {
        _queues[endpoint] = { active: 0, waiting: [] };
    }
    return _queues[endpoint];
}

/**
 * Acquire a concurrency slot for an endpoint.
 * If all slots are busy, the caller is queued and receives its position.
 * Rejects immediately if the queue is full.
 *
 * @param {string} endpoint
 * @returns {Promise<{ position: number }>} - position 0 = running immediately
 */
function _acquireSlot(endpoint) {
    const q = _getQueue(endpoint);
    if (q.active < MAX_CONCURRENT) {
        q.active++;
        return Promise.resolve({ position: 0 });
    }
    if (q.waiting.length >= MAX_QUEUE_SIZE) {
        return Promise.reject(new Error('queue_full'));
    }
    return new Promise((resolve, reject) => {
        const position = q.waiting.length + 1;
        q.waiting.push({ resolve: () => { q.active++; resolve({ position }); }, reject });
    });
}

/**
 * Release a concurrency slot for an endpoint.
 * If callers are queued, the next one is admitted.
 */
function _releaseSlot(endpoint) {
    const q = _getQueue(endpoint);
    q.active = Math.max(0, q.active - 1);
    if (q.waiting.length > 0) {
        const next = q.waiting.shift();
        next.resolve();
    }
}

/**
 * Get queue status for all endpoints.
 * @returns {object} Map of endpoint → { active, queued, max_concurrent }
 */
function getQueueStatus() {
    const status = {};
    for (const [ep, q] of Object.entries(_queues)) {
        status[ep] = { active: q.active, queued: q.waiting.length, max_concurrent: MAX_CONCURRENT };
    }
    return status;
}

/**
 * Sleep helper for 429 retry backoff.
 */
function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call a Gridlight endpoint (non-streaming).
 * Returns the response as a Buffer (for binary like images/video/audio)
 * or parsed JSON depending on content type.
 *
 * @param {string} endpoint - e.g. '/image', '/video', '/music'
 * @param {object} payload - Request body
 * @param {object} [options]
 * @param {number} [options.timeout=300000] - Timeout in ms (default 5 min)
 * @returns {Promise<{ ok: boolean, status: number, data: Buffer|object, contentType: string, error?: string }>}
 */
async function callGridlight(endpoint, payload, options) {
    const opts = options || {};
    const skipQueue = opts.skipQueue || false;

    // Acquire concurrency slot (unless caller opts out, e.g. health checks)
    if (!skipQueue) {
        try {
            await _acquireSlot(endpoint);
        } catch (err) {
            if (err.message === 'queue_full') {
                return {
                    ok: false,
                    status: 429,
                    data: null,
                    contentType: null,
                    error: `queue_full: Too many queued requests for ${endpoint}. Max queue size: ${MAX_QUEUE_SIZE}`,
                    queue: { active: _getQueue(endpoint).active, queued: _getQueue(endpoint).waiting.length },
                };
            }
            throw err;
        }
    }

    try {
        return await _callGridlightInner(endpoint, payload, opts);
    } finally {
        if (!skipQueue) _releaseSlot(endpoint);
    }
}

/**
 * Inner call with 429 retry logic.
 */
async function _callGridlightInner(endpoint, payload, opts, retryCount) {
    retryCount = retryCount || 0;
    const timeout = opts.timeout || 300000;
    const url = `${GRIDLIGHT_URL}${endpoint}`;

    const headers = { 'Content-Type': 'application/json' };
    if (GRIDLIGHT_API_KEY) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    // Ensure stream is false for non-streaming calls
    const body = { ...payload, stream: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timer);

        // Handle 429 Too Many Requests with automatic retry
        if (response.status === 429 && retryCount < MAX_429_RETRIES) {
            const retryAfter = response.headers.get('retry-after');
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_ON_429_DELAY * (retryCount + 1);
            await _sleep(delay);
            return _callGridlightInner(endpoint, payload, opts, retryCount + 1);
        }

        if (!response.ok) {
            const errText = await response.text();
            return {
                ok: false,
                status: response.status,
                data: null,
                contentType: null,
                error: `${endpoint} error ${response.status}: ${errText}`,
                retries: retryCount,
            };
        }

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
            const data = await response.json();
            return { ok: true, status: response.status, data, contentType, retries: retryCount };
        }

        // Binary response (image, video, audio)
        const data = Buffer.from(await response.arrayBuffer());
        return { ok: true, status: response.status, data, contentType, retries: retryCount };

    } catch (err) {
        clearTimeout(timer);

        if (err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED') {
            return {
                ok: false,
                status: 503,
                data: null,
                contentType: null,
                error: `service_unavailable: Cannot connect to ${url}. Ensure the service is running.`,
            };
        }

        if (err.name === 'AbortError') {
            return {
                ok: false,
                status: 504,
                data: null,
                contentType: null,
                error: `timeout: Request to ${endpoint} timed out after ${timeout}ms`,
            };
        }

        return {
            ok: false,
            status: 500,
            data: null,
            contentType: null,
            error: `${endpoint} request failed: ${err.message}`,
        };
    }
}

/**
 * Call a Gridlight endpoint with SSE streaming.
 * Relays SSE events to the client response, calling callbacks for each event type.
 *
 * @param {string} endpoint - e.g. '/video', '/music'
 * @param {object} payload - Request body (stream: true will be set automatically)
 * @param {http.ServerResponse} res - The client response to relay events to
 * @param {object} [callbacks]
 * @param {function} [callbacks.onProgress] - Called with progress data
 * @param {function} [callbacks.onComplete] - Called with final complete data
 * @param {function} [callbacks.onError] - Called with error data
 * @returns {Promise<{ ok: boolean, finalData: object|null, error?: string }>}
 */
async function relayGridlightSSE(endpoint, payload, res, callbacks) {
    const cb = callbacks || {};
    const url = `${GRIDLIGHT_URL}${endpoint}`;

    const headers = { 'Content-Type': 'application/json' };
    if (GRIDLIGHT_API_KEY) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    const body = { ...payload, stream: true };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            const errorMsg = `${endpoint} error ${response.status}: ${errText}`;
            if (cb.onError) cb.onError({ error: errorMsg });
            return { ok: false, finalData: null, error: errorMsg };
        }

        let finalData = null;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6).trim();
                if (!dataStr || dataStr === '[DONE]') continue;

                try {
                    const data = JSON.parse(dataStr);

                    // Relay to client
                    res.write(`data: ${JSON.stringify(data)}\n\n`);

                    // Call appropriate callback
                    if (data.type === 'complete' || data.type === 'completed') {
                        finalData = data;
                        if (cb.onComplete) cb.onComplete(data);
                    } else if (data.type === 'error') {
                        if (cb.onError) cb.onError(data);
                    } else if (data.type === 'progress') {
                        if (cb.onProgress) cb.onProgress(data);
                    }
                } catch (_) {
                    // Skip unparseable lines
                }
            }
        }

        return { ok: true, finalData };

    } catch (err) {
        const isConnRefused = err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED';
        const error = isConnRefused
            ? `service_unavailable: Cannot connect to ${url}. Ensure the service is running.`
            : `${endpoint} stream failed: ${err.message}`;

        if (cb.onError) cb.onError({ error });
        return { ok: false, finalData: null, error };
    }
}

/**
 * Check if a Gridlight endpoint is available.
 *
 * @param {string} endpoint - e.g. '/image', '/video'
 * @returns {Promise<{ available: boolean, latency_ms: number, error?: string }>}
 */
async function checkEndpointHealth(endpoint) {
    const url = `${GRIDLIGHT_URL}${endpoint}`;
    const start = Date.now();

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, {
            method: 'HEAD',
            signal: controller.signal,
        });

        clearTimeout(timer);
        return {
            available: response.status < 500,
            latency_ms: Date.now() - start,
        };
    } catch (err) {
        return {
            available: false,
            latency_ms: Date.now() - start,
            error: err.message,
        };
    }
}

/**
 * Build a service unavailable error response.
 */
function serviceUnavailableError(endpoint, serviceName) {
    return {
        error: 'service_unavailable',
        service: serviceName || endpoint.replace('/', ''),
        endpoint: `${GRIDLIGHT_URL}${endpoint}`,
        hint: `The ${serviceName || endpoint} service is not running. Start it at ${GRIDLIGHT_URL} or set GRIDLIGHT_URL env var.`,
    };
}

module.exports = {
    callGridlight,
    relayGridlightSSE,
    checkEndpointHealth,
    serviceUnavailableError,
    getQueueStatus,
    GRIDLIGHT_URL,
    GRIDLIGHT_API_KEY,
    MAX_CONCURRENT,
    MAX_QUEUE_SIZE,
};
