const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
    diffPrompts, diffParams, comparePrompts, tokenize, LCS_TOKEN_CAP,
} = require('../lib/prompt-diff');

describe('prompt-diff', () => {
    describe('tokenize', () => {
        test('splits on commas and whitespace, dropping the delimiters', () => {
            assert.deepEqual(tokenize('cinematic, wide shot'), ['cinematic', 'wide', 'shot']);
        });

        test('handles empty and non-string input', () => {
            assert.deepEqual(tokenize(''), []);
            assert.deepEqual(tokenize('   '), []);
            assert.deepEqual(tokenize(null), []);
            assert.deepEqual(tokenize(undefined), []);
            assert.deepEqual(tokenize(42), []);
        });

        test('collapses runs of whitespace and commas', () => {
            assert.deepEqual(tokenize('a,,   b'), ['a', 'b']);
        });
    });

    describe('diffPrompts', () => {
        test('identical prompts report no change', () => {
            const d = diffPrompts('cinematic, wide shot', 'cinematic, wide shot');
            assert.equal(d.changed, false);
            assert.deepEqual(d.added, []);
            assert.deepEqual(d.removed, []);
            assert.equal(d.similarity, 1);
        });

        test('detects a single token substitution as one add and one remove', () => {
            const d = diffPrompts('cinematic, wide shot', 'cinematic, close shot');
            assert.equal(d.changed, true);
            assert.deepEqual(d.added, ['close']);
            assert.deepEqual(d.removed, ['wide']);
            assert.deepEqual(d.unchanged, ['cinematic', 'shot']);
        });

        test('detects pure additions', () => {
            const d = diffPrompts('cinematic', 'cinematic, moody');
            assert.deepEqual(d.added, ['moody']);
            assert.deepEqual(d.removed, []);
        });

        test('detects pure removals', () => {
            const d = diffPrompts('cinematic, moody', 'cinematic');
            assert.deepEqual(d.added, []);
            assert.deepEqual(d.removed, ['moody']);
        });

        test('both empty is unchanged, not a spurious diff', () => {
            const d = diffPrompts('', '');
            assert.equal(d.changed, false);
            assert.equal(d.similarity, 1);
        });

        test('empty to non-empty is all additions', () => {
            const d = diffPrompts('', 'cinematic');
            assert.deepEqual(d.added, ['cinematic']);
            assert.equal(d.changed, true);
        });

        test('ops replay to reconstruct both sides', () => {
            const before = 'a b c d';
            const after = 'a x c e';
            const d = diffPrompts(before, after);
            const rebuiltBefore = d.ops.filter(o => o.op !== 'add').map(o => o.token).join(' ');
            const rebuiltAfter = d.ops.filter(o => o.op !== 'remove').map(o => o.token).join(' ');
            assert.equal(rebuiltBefore, before);
            assert.equal(rebuiltAfter, after);
        });

        test('similarity is measured over the union, not just the overlap', () => {
            // 1 shared token, 1 removed, 1 added -> 1/3
            const d = diffPrompts('shared removed', 'shared added');
            assert.equal(d.similarity, 0.333);
        });

        test('oversized prompts degrade to a whole-block replace rather than hanging', () => {
            const huge = Array.from({ length: LCS_TOKEN_CAP + 10 }, (_, i) => `t${i}`).join(' ');
            const d = diffPrompts(huge, 'small');
            assert.equal(d.truncated, true);
            assert.equal(d.changed, true);
            assert.equal(d.similarity, 0);
        });
    });

    describe('diffParams', () => {
        test('reports only fields that actually differ', () => {
            const changes = diffParams(
                { seed: 1, sampler: 'euler', steps: 30 },
                { seed: 2, sampler: 'euler', steps: 30 },
            );
            assert.equal(changes.length, 1);
            assert.equal(changes[0].field, 'seed');
            assert.equal(changes[0].before, 1);
            assert.equal(changes[0].after, 2);
        });

        test('does not report numeric/string representation as a change', () => {
            assert.deepEqual(diffParams({ guidance: 7.5 }, { guidance: '7.5' }), []);
        });

        test('treats null and undefined as equivalent absence', () => {
            assert.deepEqual(diffParams({ seed: null }, {}), []);
        });

        test('identical rows produce no changes', () => {
            const row = { seed: 1, sampler: 'ddim', steps: 20, guidance: 7 };
            assert.deepEqual(diffParams(row, row), []);
        });
    });

    describe('comparePrompts', () => {
        test('summarizes prompt and parameter changes together', () => {
            const result = comparePrompts(
                { prompt: 'cinematic wide', seed: 1 },
                { prompt: 'cinematic close', seed: 2 },
            );
            assert.equal(result.prompt.changed, true);
            assert.equal(result.params.length, 1);
            assert.match(result.summary, /added/);
            assert.match(result.summary, /removed/);
            assert.match(result.summary, /parameter/);
        });

        test('identical renders say so plainly', () => {
            const row = { prompt: 'cinematic', seed: 1, sampler: 'euler' };
            const result = comparePrompts(row, row);
            assert.equal(result.summary, 'Identical prompt and parameters');
        });

        test('a seed-only change is attributable to the seed, not the prompt', () => {
            const result = comparePrompts(
                { prompt: 'same words', seed: 1 },
                { prompt: 'same words', seed: 999 },
            );
            assert.equal(result.prompt.changed, false);
            assert.equal(result.params.length, 1);
            assert.equal(result.params[0].field, 'seed');
        });

        test('singular and plural wording', () => {
            const one = comparePrompts({ prompt: 'a' }, { prompt: 'a b' });
            assert.match(one.summary, /1 token added/);
            const many = comparePrompts({ prompt: 'a' }, { prompt: 'a b c' });
            assert.match(many.summary, /2 tokens added/);
        });
    });
});
