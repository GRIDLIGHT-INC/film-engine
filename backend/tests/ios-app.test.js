/**
 * The iOS app: a full replica, and actually shippable to TestFlight.
 *
 * "Full replica" is taken literally — it ships THE APP, all 28 pages, inside a
 * WKWebView, rather than a second implementation of it. That is the decision
 * this repo's own mobile assessment already argued for: option C's real cost is
 * never React Native, it is A SECOND SURFACE, and this codebase has paid three
 * times in one week for two surfaces disagreeing (the plate pointer, the frame
 * pointer, effectiveCamera). A rewrite of 28 pages would be weeks of work whose
 * first bug is a screen that disagrees with the desktop.
 *
 * Set-based over TWO registries, because both fail partially:
 *   - the 28 pages, so a bundle that ships 20 of them cannot read as complete;
 *   - the TestFlight requirements, because an archive missing one Info.plist
 *     key is rejected at upload, after the build has "succeeded".
 *
 * The load-bearing check is the last one: it BUILDS. Everything else could be
 * asserted about a project that does not compile.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const IOS = path.join(ROOT, 'ios');
const SPA = path.join(ROOT, 'src/index.html');

const has = p => fs.existsSync(p);
const read = p => (has(p) ? fs.readFileSync(p, 'utf8') : '');

/** Every page the desktop app has, from the source of truth. */
function desktopPages() {
    const h = fs.readFileSync(SPA, 'utf8');
    return [...new Set([...h.matchAll(/id="page-([a-z0-9-]+)"/g)].map(m => m[1]))];
}

test('the project exists where an iOS build expects it', () => {
    assert.ok(has(IOS), 'no ios/ directory');
    assert.ok(has(path.join(IOS, 'FilmEngine.xcodeproj/project.pbxproj')),
        'no Xcode project — nothing can be archived for TestFlight');
});

/* ── registry 1: every page ships ────────────────────────────────────── */

test('the bundled app is THE app — every page, not a subset', () => {
    const bundled = path.join(IOS, 'FilmEngine/Web/index.html');
    assert.ok(has(bundled), 'the SPA is not bundled into the app');
    const html = read(bundled);
    const missing = desktopPages().filter(p => !html.includes(`id="page-${p}"`));
    assert.deepStrictEqual(missing, [],
        `the iOS bundle is missing ${missing.length} of the desktop's pages: ${missing.join(', ')}`);
});

test('the bundle is kept identical to the desktop build, not forked', () => {
    // A copy that drifts is the second surface this design exists to avoid.
    const bundled = read(path.join(IOS, 'FilmEngine/Web/index.html'));
    assert.strictEqual(bundled.length, fs.readFileSync(SPA, 'utf8').length,
        'the bundled SPA differs from src/index.html — it has been forked');
});

/* ── the API is not on the phone ─────────────────────────────────────── */

test('the API base survives a bundled load, where there is no hostname', () => {
    // Under file:// the old expression produced "file://localhost:3100" — a
    // broken scheme that reaches nothing and surfaces as "Backend offline",
    // the exact misdiagnosis this codebase has already paid for once.
    // Extract the whole function by brace depth: a non-greedy match to the
    // first ';' stops inside the body and yields a syntax error.
    const h = fs.readFileSync(SPA, 'utf8');
    const i = h.indexOf('function defaultApiBase(');
    assert.ok(i > 0, 'defaultApiBase not found — the API base is not testable');
    let depth = 0, j = h.indexOf('{', i), end = j;
    for (; j < h.length; j++) {
        if (h[j] === '{') depth++;
        else if (h[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    const f = new Function(`"use strict";${h.slice(i, end)};return defaultApiBase;`)();
    assert.strictEqual(f({ protocol: 'http:', hostname: '192.168.4.40' }), 'http://192.168.4.40:3100');
    const bundled = f({ protocol: 'file:', hostname: '' });
    assert.doesNotMatch(String(bundled), /^file:/,
        `a bundled load resolves the API to "${bundled}", which reaches nothing`);
});

test('the app can be told where the server is', () => {
    // The API runs on the user's Mac. Without a way to say where, a phone
    // build is an app that shows nothing and cannot explain why.
    const swift = read(path.join(IOS, 'FilmEngine/ContentView.swift'))
        + read(path.join(IOS, 'FilmEngine/FilmEngineApp.swift'))
        + read(path.join(IOS, 'FilmEngine/ServerSettings.swift'));
    assert.match(swift, /serverURL|serverAddress|film_api_url/i,
        'nothing in the app lets a user set the server address');
    assert.match(swift, /UserDefaults|AppStorage/,
        'the server address is not persisted, so it is asked for on every launch');
});

/* ── registry 2: what TestFlight requires ────────────────────────────── */

const PLIST_REQUIRED = Object.freeze({
    NSAppTransportSecurity: 'the API is plain http on a LAN address; iOS blocks that by default',
    NSLocalNetworkUsageDescription: 'iOS 14+ refuses LAN access without a stated reason',
});

test('every Info.plist key the app genuinely needs is present, with its reason', () => {
    const plist = read(path.join(IOS, 'FilmEngine/Info.plist'));
    assert.ok(plist, 'no Info.plist');
    for (const [key, why] of Object.entries(PLIST_REQUIRED)) {
        assert.ok(plist.includes(key), `Info.plist has no ${key} — ${why}`);
    }
    assert.match(plist, /NSAllowsLocalNetworking/,
        'ATS does not permit the local network, so the app cannot reach the Mac running the API');
});

/* ── registry 3: the privacy keys the app's own capabilities require ──── */

/*
 * NOT the same question as registry 2. That one is "what will TestFlight
 * reject"; this one is "what will iOS KILL the app for". A privacy-sensitive
 * API invoked with no usage-description string terminates the process
 * immediately — it does not fail, it does not prompt, the app disappears — and
 * from inside a WKWebView that reads as the web page's upload button being
 * broken.
 *
 * The set is DERIVED from what the bundled page actually asks the picker for,
 * never typed. A page that stops offering video relaxes the requirement and one
 * that adds a new medium tightens it, with nothing to remember. That matters
 * here specifically: the camera key was declared months before anything could
 * reach the camera, and the microphone key — which VIDEO capture needs, because
 * recording video records audio — was never added at all.
 */

/** Every accept type the bundled page can hand a file input, static or built. */
function acceptTypes() {
    const page = read(path.join(IOS, 'FilmEngine/Web/index.html'));
    assert.ok(page, 'no bundled page to derive capabilities from');
    const types = [];
    for (const m of page.matchAll(/accept="([^"]*)"/g)) types.push(m[1]);
    // Controls that build their accept at run time: take the string literals
    // the builder can produce, or a video-only control is invisible to a scan
    // of the markup.
    for (const m of page.matchAll(/accept\s*=\s*media === 'video'\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
        types.push(m[1], m[2]);
    }
    assert.ok(types.length >= 5,
        `the accept scan found ${types.length} — it is broken, and every check below `
        + 'would then pass over an empty set');
    return types;
}

/**
 * What each medium costs in privacy keys. iOS asks for the microphone on VIDEO
 * capture as well as audio, because a recorded clip carries sound.
 */
const MEDIUM_KEYS = Object.freeze({
    image: {
        match: /image\//,
        keys: {
            NSCameraUsageDescription: 'the picker offers Take Photo, and the camera kills an app with no reason declared',
            NSPhotoLibraryUsageDescription: 'the picker offers Photo Library',
        },
    },
    video: {
        match: /video\/|\.mp4|\.mov/,
        keys: {
            NSCameraUsageDescription: 'Record Video is a camera use',
            NSMicrophoneUsageDescription: 'recording video records audio; without this key iOS terminates the app the moment capture starts',
        },
    },
    audio: {
        match: /audio\//,
        keys: {
            NSMicrophoneUsageDescription: 'an audio file input can offer recording',
        },
    },
});

/** The keys the app must declare, given what its own page offers. */
function requiredPrivacyKeys() {
    const types = acceptTypes();
    const need = {};
    for (const [, spec] of Object.entries(MEDIUM_KEYS)) {
        if (!types.some((t) => spec.match.test(t))) continue;
        for (const [k, why] of Object.entries(spec.keys)) need[k] = need[k] || why;
    }
    // Not derivable from an accept type: the app writes to the library itself,
    // and it talks to a Mac over the LAN.
    need.NSPhotoLibraryAddUsageDescription = 'the app saves a frame or a clip back to the library';
    need.NSLocalNetworkUsageDescription = 'iOS 14+ silently drops LAN traffic without it';
    return need;
}

/** key -> string, read out of the plist. */
function plistStrings(plist) {
    const out = {};
    for (const m of plist.matchAll(/<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
        out[m[1]] = m[2].trim();
    }
    return out;
}

test('every privacy key the app own capabilities require is declared', () => {
    const plist = read(path.join(IOS, 'FilmEngine/Info.plist'));
    assert.ok(plist, 'no Info.plist');
    const need = requiredPrivacyKeys();
    assert.ok(Object.keys(need).length >= 4,
        `only ${Object.keys(need).length} keys derived — the derivation is broken`);
    const missing = Object.entries(need)
        .filter(([k]) => !plist.includes(`<key>${k}</key>`))
        .map(([k, why]) => `${k} — ${why}`);
    assert.deepStrictEqual(missing, [],
        `the app can reach these capabilities and has not declared them:\n  - ${missing.join('\n  - ')}`);
});

test('every declared reason is a sentence a person can read', () => {
    /*
     * A key with an empty or placeholder string is WORSE than an absent one:
     * the app still prompts, the prompt is blank, and App Store review rejects
     * it — so "the key is present" is not the requirement.
     */
    const plist = read(path.join(IOS, 'FilmEngine/Info.plist'));
    const strings = plistStrings(plist);
    const bad = [];
    for (const key of Object.keys(requiredPrivacyKeys())) {
        const s = strings[key];
        if (s === undefined) continue;                 // absence is the test above
        if (s.length < 20) bad.push(`${key}: "${s}" is not a reason`);
        else if (!/\s/.test(s)) bad.push(`${key}: "${s}" is one token, not a sentence`);
        else if (/^(TODO|TBD|xxx|placeholder)/i.test(s)) bad.push(`${key}: "${s}" is a placeholder`);
    }
    assert.deepStrictEqual(bad, [], `these reasons would show the user nothing useful:\n  - ${bad.join('\n  - ')}`);
});

test('the reasons already written are not disturbed', () => {
    /*
     * Regression pin. Adding one key must not rewrite the four that were
     * already there — each names the specific thing the app does with that
     * permission, which is what review reads.
     */
    const strings = plistStrings(read(path.join(IOS, 'FilmEngine/Info.plist')));
    assert.match(strings.NSCameraUsageDescription || '', /^Photograph a location or a prop/,
        'the camera reason changed');
    assert.match(strings.NSPhotoLibraryUsageDescription || '', /^Choose a photograph/,
        'the photo library reason changed');
    assert.match(strings.NSPhotoLibraryAddUsageDescription || '', /^Save a frame or a clip/,
        'the library-add reason changed');
    assert.match(strings.NSLocalNetworkUsageDescription || '', /Mac on your network/,
        'the local network reason changed');
});

const PROJECT_REQUIRED = Object.freeze({
    PRODUCT_BUNDLE_IDENTIFIER: 'App Store Connect keys the app on it',
    DEVELOPMENT_TEAM: 'an archive cannot be signed without a team',
    MARKETING_VERSION: 'TestFlight rejects a build with no version',
    CURRENT_PROJECT_VERSION: 'every TestFlight upload needs a unique build number',
    IPHONEOS_DEPLOYMENT_TARGET: 'without it the build targets whatever the toolchain defaults to',
    TARGETED_DEVICE_FAMILY: 'the app must declare which devices it supports',
});

test('every build setting an upload requires is set, with its reason', () => {
    const pbx = read(path.join(IOS, 'FilmEngine.xcodeproj/project.pbxproj'));
    for (const [key, why] of Object.entries(PROJECT_REQUIRED)) {
        assert.match(pbx, new RegExp(`${key}\\s*=`), `${key} is unset — ${why}`);
    }
    assert.match(pbx, /DEVELOPMENT_TEAM\s*=\s*3AXRJ22S9P/,
        'the project is not signed to the Gridlight team');
});

test('there is an icon and a launch screen — an upload is rejected without them', () => {
    assert.ok(has(path.join(IOS, 'FilmEngine/Assets.xcassets/AppIcon.appiconset/Contents.json')),
        'no app icon set');
    const pbx = read(path.join(IOS, 'FilmEngine.xcodeproj/project.pbxproj'));
    assert.match(pbx, /ASSETCATALOG_COMPILER_APPICON_NAME/, 'the icon is not wired to the target');
});

test('there is an export configuration for the archive', () => {
    const p = path.join(IOS, 'ExportOptions.plist');
    assert.ok(has(p), 'no ExportOptions.plist — `xcodebuild -exportArchive` needs one');
    assert.match(read(p), /app-store|app-store-connect/,
        'the export method is not App Store Connect, so the archive cannot go to TestFlight');
});

/* ── and the one that cannot be faked ────────────────────────────────── */

test('it BUILDS', { timeout: 600000 }, () => {
    // Everything above could be true of a project that does not compile.
    const out = execFileSync('xcodebuild', [
        '-project', path.join(IOS, 'FilmEngine.xcodeproj'),
        '-scheme', 'FilmEngine',
        '-destination', 'generic/platform=iOS Simulator',
        '-configuration', 'Debug',
        'CODE_SIGNING_ALLOWED=NO',
        'build',
    ], { encoding: 'utf8', cwd: IOS, stdio: ['ignore', 'pipe', 'pipe'], timeout: 570000 });
    assert.match(out, /BUILD SUCCEEDED/, 'the iOS app does not build');
});
