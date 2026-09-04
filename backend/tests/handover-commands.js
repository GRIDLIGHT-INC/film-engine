#!/usr/bin/env node
/**
 * Every command in the handover's FREE path, executed.
 *
 * A manual-test document nobody runs is a list of typos, and it rots silently:
 * the commands keep looking plausible long after a route was renamed. This
 * extracts them and runs them, so the document fails rather than misleads.
 *
 * Bounded to section 3 by its own headings — NOT by a character window, and
 * deliberately not over the whole file. Section 4 spends money and section 8
 * contains `git revert`; a runner that swept the document would do both.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DOC = path.join(__dirname, '..', '..', 'docs', 'world-engine', 'handover.md');
const md = fs.readFileSync(DOC, 'utf8');

const START = '## 3. Manual testing — the free path';
const END = '## 4. Manual testing — the paid path';
const from = md.indexOf(START);
const to = md.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
    console.error('FAIL: the free-path section moved — the extractor is broken, not the doc');
    process.exit(1);
}
const section = md.slice(from, to);

const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]);
if (blocks.length < 8) {
    console.error(`FAIL: found only ${blocks.length} command blocks — the extractor is broken`);
    process.exit(1);
}

// Guard the guard: nothing destructive can have crept into the free section.
const FORBIDDEN = /\bgit\s+(revert|reset|push)\b|\brm\s+-rf\b|\/generate\b|DROP\s+TABLE/i;
const unsafe = blocks.filter(b => FORBIDDEN.test(b));
if (unsafe.length) {
    console.error('FAIL: the free-path section contains something that spends or destroys:\n' + unsafe.join('\n'));
    process.exit(1);
}

const script = ['set -euo pipefail', ...blocks].join('\n');
console.log(`Running ${blocks.length} command blocks from the handover's free path…\n`);
try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 180000 });
    console.log(out.trim());
    console.log(`\nPASS — all ${blocks.length} blocks executed`);
} catch (err) {
    console.error((err.stdout || '') + (err.stderr || ''));
    console.error(`\nFAIL — a command in the handover no longer works (exit ${err.status})`);
    process.exit(1);
}
