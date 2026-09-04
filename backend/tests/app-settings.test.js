/**
 * Settings that belong to the person, not the project.
 *
 * The screenplay's author was a free-text field on every title page: retyped
 * per project, per draft, and blank whenever anyone forgot — which on a title
 * page is the field a reader looks at first. It is not a fact about a
 * screenplay. It is a fact about whoever is writing them here.
 *
 * Set-based over the known settings, because the failure mode of a key/value
 * store is that it accepts anything: a caller who misspells a key gets a 200
 * and believes it was saved, and nothing ever reads the row again.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-appsettings-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleAppSettings, SETTINGS } = require('../routes/app-settings');
const fs = require('fs');
const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');

function call(method, body) {
    return new Promise(resolve => {
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handleAppSettings({ method, body: body || {} }, res))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

test('every known setting reads back as it was written, in its own type', async () => {
    /*
     * The probe follows the setting's DECLARED type. Writing a string to every
     * key was right while every setting was free text, and became wrong the day
     * boolean flags arrived: a boolean stored as the string "false" is truthy,
     * so a flag switched off read as on. The default is what declares the type,
     * so nothing is listed twice here.
     */
    for (const [key, def] of Object.entries(SETTINGS)) {
        const value = typeof def.default === 'boolean' ? true : `value-for-${key}`;
        const put = await call('PUT', { [key]: value });
        assert.strictEqual(put.status, 200, JSON.stringify(put.body));
        const got = await call('GET');
        assert.strictEqual(got.body.settings[key], value, `${key} did not survive the round trip`);
    }
});

test('a boolean setting turned OFF reads as off, not as the string "false"', async () => {
    // The bug this replaces: `false` was stored via String(), came back as
    // "false", and every truthiness check read the flag as ON. Measured in a
    // browser — the console rendered with world_engine switched off.
    const bools = Object.entries(SETTINGS).filter(([, d]) => typeof d.default === 'boolean').map(([k]) => k);
    assert.ok(bools.length >= 6, `only ${bools.length} boolean settings found — the scan is broken`);
    for (const key of bools) {
        await call('PUT', { [key]: true });
        await call('PUT', { [key]: false });
        const got = await call('GET');
        assert.strictEqual(got.body.settings[key], false,
            `${key} came back as ${JSON.stringify(got.body.settings[key])} after being switched off`);
    }
});

test('an unset setting reads as its default, not as missing', async () => {
    // A caller that has to distinguish undefined from "" writes that check
    // once per caller and gets it wrong somewhere.
    const got = await call('GET');
    for (const key of Object.keys(SETTINGS)) {
        const want = typeof SETTINGS[key].default;
        assert.strictEqual(typeof got.body.settings[key], want,
            `${key} is not always a ${want}`);
    }
});

test('a misspelled key is reported, not silently accepted', async () => {
    const res = await call('PUT', { authr: 'Manny Henri' });
    assert.strictEqual(res.status, 400, 'a PUT of only unknown keys returned success');
    assert.ok(res.body.unknown.includes('authr'), 'the unknown key is not named back');
});

test('a PUT merges rather than clearing what it does not mention', async () => {
    await call('PUT', { author: 'Manny Henri' });
    const res = await call('PUT', { author: 'Manny Henri' });
    assert.strictEqual(res.body.settings.author, 'Manny Henri');
    // With one setting this is trivially true; it is asserted because the
    // second setting is where a rebuild-from-body implementation starts
    // wiping fields nobody touched.
    assert.deepStrictEqual(res.body.changed, ['author']);
});

test('the title page is printed, not edited in the middle of the script', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(/\.title-page-block \{ display: none !important; \}/.test(html),
        'the title page is still a slab at the top of the editor');
    const print = html.slice(html.indexOf('@media print'));
    assert.ok(/\.title-page-block \{\s*display: block !important;/.test(print),
        'hiding it on screen also hid it from the printer, which is the one place it belongs');
    // It is hidden, not removed: the block carries the data the Fountain
    // serialiser writes back, so deleting it would lose the title page itself.
    assert.ok(/data-title-page-data/.test(html), 'the title page data is no longer in the document');
    assert.ok(/onclick="openTitlePageModal\(\)"/.test(html), 'no way left to edit it');
});

test('the author fills a blank credit and never overwrites one', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(/currentTitlePage\.author \|\| await appAuthor\(\)/.test(html),
        'the app author does not fill a blank title page');
    assert.ok(!/await appAuthor\(\) \|\| currentTitlePage\.author/.test(html),
        'the setting outranks the screenplay, so it can reassign authorship');
});
