/**
 * Gap 7d: prompt history diff.
 *
 * render_ledger versions every render parameter, but the prompt itself — the
 * thing a director actually iterates on — could only be read as two opaque
 * blocks of text. This produces a token-level diff so "what did I change
 * between take 3 and take 7" is answerable.
 *
 * Prompts are comma/space-delimited token soup rather than prose, so this
 * tokenizes on whitespace and commas and diffs tokens, not characters. A
 * character diff of "cinematic, wide shot" vs "cinematic, close shot" produces
 * noise; a token diff says "wide → close", which is the actual edit.
 *
 * Pure functions, no I/O.
 */

/**
 * Split a prompt into comparable tokens, keeping the delimiter that followed
 * each so the diff can be rendered back as readable text.
 */
function tokenize(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) return [];
    return prompt
        .split(/([,\n]|\s+)/)
        .filter(t => t && t.trim())
        .map(t => t.trim())
        .filter(t => t !== ',');
}

/**
 * Longest common subsequence over token arrays.
 *
 * Bounded deliberately: prompts are short (tens of tokens), but a pathological
 * input would make an O(n*m) table expensive, so anything past the cap falls
 * back to a coarse whole-block replace rather than hanging the request.
 */
const LCS_TOKEN_CAP = 600;

function lcsMatrix(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = Array.from({ length: rows }, () => new Uint32Array(cols));
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            table[i][j] = a[i - 1] === b[j - 1]
                ? table[i - 1][j - 1] + 1
                : Math.max(table[i - 1][j], table[i][j - 1]);
        }
    }
    return table;
}

/**
 * Diff two prompts.
 * @returns {Object} { ops, added, removed, unchanged, changed, similarity }
 *   ops is an ordered list of { op: 'equal'|'add'|'remove', token }
 */
function diffPrompts(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);

    if (a.length === 0 && b.length === 0) {
        return { ops: [], added: [], removed: [], unchanged: [], changed: false, similarity: 1 };
    }

    // Oversized input: report it as a wholesale replacement rather than
    // pretending to a token-level answer we declined to compute.
    if (a.length > LCS_TOKEN_CAP || b.length > LCS_TOKEN_CAP) {
        return {
            ops: [
                ...a.map(token => ({ op: 'remove', token })),
                ...b.map(token => ({ op: 'add', token })),
            ],
            added: b,
            removed: a,
            unchanged: [],
            changed: true,
            similarity: 0,
            truncated: true,
        };
    }

    const table = lcsMatrix(a, b);

    // Walk the table backwards, then reverse — standard LCS backtrack.
    const ops = [];
    let i = a.length;
    let j = b.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            ops.push({ op: 'equal', token: a[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
            ops.push({ op: 'add', token: b[j - 1] });
            j--;
        } else {
            ops.push({ op: 'remove', token: a[i - 1] });
            i--;
        }
    }
    ops.reverse();

    const added = ops.filter(o => o.op === 'add').map(o => o.token);
    const removed = ops.filter(o => o.op === 'remove').map(o => o.token);
    const unchanged = ops.filter(o => o.op === 'equal').map(o => o.token);

    // Similarity over the union, so adding 10 tokens to a 10-token prompt reads
    // as 0.5 rather than 1.0.
    const union = unchanged.length + added.length + removed.length;
    const similarity = union === 0 ? 1 : unchanged.length / union;

    return {
        ops,
        added,
        removed,
        unchanged,
        changed: added.length > 0 || removed.length > 0,
        similarity: Math.round(similarity * 1000) / 1000,
    };
}

/**
 * Diff the non-prompt render parameters between two ledger rows, so the UI can
 * answer "was it the prompt or the seed that changed?" — the most common
 * question when two takes differ and you don't know why.
 */
const COMPARED_PARAMS = [
    'model_id', 'model_hash', 'seed', 'sampler', 'steps',
    'guidance', 'lora_ids', 'controlnets', 'negative_prompt',
];

function diffParams(before = {}, after = {}) {
    const changes = [];
    for (const key of COMPARED_PARAMS) {
        const a = before[key];
        const b = after[key];
        // Normalize through String so 7.5 and "7.5" don't read as a change.
        if (String(a ?? '') !== String(b ?? '')) {
            changes.push({ field: key, before: a ?? null, after: b ?? null });
        }
    }
    return changes;
}

/**
 * Build a full comparison between two render_ledger rows.
 */
function comparePrompts(beforeRow = {}, afterRow = {}) {
    const prompt = diffPrompts(beforeRow.prompt, afterRow.prompt);
    const params = diffParams(beforeRow, afterRow);
    return {
        prompt,
        params,
        // The headline: what actually differs between these two takes.
        summary: buildSummary(prompt, params),
    };
}

function buildSummary(prompt, params) {
    const parts = [];
    if (prompt.added.length) parts.push(`${prompt.added.length} token${prompt.added.length === 1 ? '' : 's'} added`);
    if (prompt.removed.length) parts.push(`${prompt.removed.length} token${prompt.removed.length === 1 ? '' : 's'} removed`);
    if (params.length) parts.push(`${params.length} parameter${params.length === 1 ? '' : 's'} changed`);
    if (!parts.length) return 'Identical prompt and parameters';
    return parts.join(', ');
}

module.exports = {    diffPrompts,
    diffParams,
    comparePrompts,
    tokenize,
    LCS_TOKEN_CAP,};
