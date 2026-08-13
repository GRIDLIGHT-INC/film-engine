/**
 * The gateway credential must only ever be sent to the gateway.
 *
 * When a provider answers a generation call with a URL instead of bytes, the
 * server fetches that URL to persist the media. Gridlight's own serving
 * endpoints need `Authorization: Bearer GRIDLIGHT_API_KEY`; a third-party CDN
 * must never receive it. That decision was made with:
 *
 *     if (GRIDLIGHT_API_KEY && fetchUrl.startsWith(GRIDLIGHT_URL))
 *
 * A string prefix is not an origin. Every one of these passes that check while
 * resolving to a host the operator does not control:
 *
 *     https://gw.gridlight.ai@evil.example/steal    -> host evil.example (userinfo)
 *     https://gw.gridlight.ai.evil.example/steal    -> host gw.gridlight.ai.evil.example
 *     https://gw.gridlight.ai-evil.example/steal    -> host gw.gridlight.ai-evil.example
 *
 * The URL is attacker-influenced whenever a provider is malicious, compromised,
 * or reachable over plaintext, so this is credential exfiltration rather than a
 * theoretical parsing nit.
 *
 * Two tests, deliberately different in kind: a payload table proving the check
 * itself rejects each bypass shape, and a set-based scan proving no prefix-gated
 * credential decision survives anywhere in lib/ or routes/. The scan is what
 * stops the next copy of this pattern — the bug reached a second call site by
 * being copied, and a payload table alone would not have noticed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { isGatewayUrl } = require('../lib/provider-media');
const { GRIDLIGHT_URL } = require('../lib/gridlight-client');

// Hosts that must NEVER receive the gateway credential, expressed against
// whatever GRIDLIGHT_URL is configured so the table holds for any deployment.
function bypassCandidates(gateway) {
    const withoutScheme = gateway.replace(/^https?:\/\//, '');
    const scheme = gateway.startsWith('https') ? 'https' : 'http';
    return [
        { url: `${scheme}://${withoutScheme}@evil.example/steal`, why: 'userinfo — real host is evil.example' },
        { url: `${scheme}://${withoutScheme}.evil.example/steal`, why: 'suffix — attacker registers a subdomain-looking host' },
        { url: `${scheme}://${withoutScheme}-evil.example/steal`, why: 'hyphen — prefix matches, host does not' },
        { url: `https://cdn.example.com/x.png`, why: 'unrelated third-party CDN' },
        { url: `${scheme}://${withoutScheme}.attacker.co/a?b=1`, why: 'suffix with query' },
    ];
}

test('the gateway credential is withheld from every look-alike host', () => {
    const leaked = [];
    for (const { url, why } of bypassCandidates(GRIDLIGHT_URL)) {
        let parsedHost = '(unparseable)';
        try { parsedHost = new URL(url).host; } catch (_) { continue; } // fetch would reject it anyway
        if (isGatewayUrl(url)) leaked.push(`${url} -> host ${parsedHost} (${why})`);
    }
    assert.deepStrictEqual(leaked, [], `gateway credential would be sent to:\n  ${leaked.join('\n  ')}`);
});

test('the gateway credential is still sent to the gateway itself', () => {
    // The fix must not be so strict that legitimate media downloads lose auth.
    assert.ok(isGatewayUrl(`${GRIDLIGHT_URL}/images/shot_1A.png`), 'gateway URL was rejected');
    assert.ok(isGatewayUrl(`${GRIDLIGHT_URL}/videos/1A.mp4`), 'gateway URL was rejected');
    assert.ok(isGatewayUrl(GRIDLIGHT_URL), 'the gateway root was rejected');
});

test('malformed and non-http URLs never receive the credential', () => {
    for (const bad of ['', null, undefined, 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://gw/x']) {
        assert.strictEqual(isGatewayUrl(bad), false, `credential offered to ${String(bad)}`);
    }
});

test('no credential decision anywhere is gated on a URL string prefix', () => {
    // Set-based over the whole server surface: the pattern spread by copy, so
    // pinning the two known sites would just wait for a third.
    const roots = [path.join(__dirname, '..', 'lib'), path.join(__dirname, '..', 'routes')];
    const offenders = [];

    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js')) continue;

            const src = fs.readFileSync(full, 'utf8');
            src.split('\n').forEach((line, i) => {
                // Prose may name the anti-pattern in order to warn about it —
                // isGatewayUrl's own doc comment does. Only executable lines count.
                const trimmed = line.trim();
                if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;

                // A credential guarded by a prefix test on a URL.
                if (/startsWith\(\s*GRIDLIGHT_URL\s*\)/.test(line)) {
                    offenders.push(`${path.relative(path.join(__dirname, '..'), full)}:${i + 1}: ${trimmed}`);
                }
            });
        }
    };
    roots.forEach(walk);

    assert.deepStrictEqual(offenders, [], `prefix-gated credential decisions remain:\n  ${offenders.join('\n  ')}`);
});
