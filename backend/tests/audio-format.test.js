/**
 * A file called .wav has to be a WAV
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "The audio file we download should be wav 48KHz PCM."
 *
 * `lib/dialogue-builder.js` and `lib/music-prompt.js` have always built their
 * payloads with `output_format: 'wav'`. ElevenLabs has no `wav_*` format — its
 * accepted set is `mp3_*` and `pcm_8000 … pcm_48000`, verified against its own
 * accepted-value list — so 'wav' matched neither vocabulary and fell through to
 * the `mp3_44100_128` default. Every score, bed and line of dialogue came back
 * as the lowest tier the provider offers, while the code asking for it said
 * WAV.
 *
 * And PCM alone is not the fix, because ElevenLabs PCM is RAW, header-less
 * samples. Written to `.wav` unwrapped it is a file no player opens — the same
 * lie as an uploaded JPEG stored under a `.png` name.
 *
 * THE CHANNEL COUNT IS THE PART THAT BITES. A mono stream headed as stereo
 * plays at double speed and the wrong pitch. It is inferred from the byte
 * count where a request states its own length — and text-to-speech has no
 * length to state, because a line is however long it turns out to be. So voice
 * fell to the default and the default was stereo: measured before the fix, a
 * mono 48k response came back `channels: 2` with a byte rate of 192000 where
 * mono 48k is 96000. Every line of dialogue in the film.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { adapter, buildVoiceRequest, normalizeOutputFormat } = require('../lib/providers/elevenlabs');

/** Serve `bytes` of raw samples, the way a `pcm_*` response arrives. */
async function withStubProvider(bytes, run) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(bytes));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const prevUrl = process.env.ELEVENLABS_BASE_URL;
    const prevKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    process.env.ELEVENLABS_API_KEY = 'test-key';
    try {
        return await run();
    } finally {
        if (prevUrl === undefined) delete process.env.ELEVENLABS_BASE_URL;
        else process.env.ELEVENLABS_BASE_URL = prevUrl;
        if (prevKey === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = prevKey;
        await new Promise(r => server.close(r));
    }
}

test("the 'wav' the callers already send resolves to 48kHz PCM", () => {
    // Both builders send exactly this string; neither vocabulary contained it.
    assert.strictEqual(normalizeOutputFormat({ output_format: 'wav' }), 'pcm_48000');
    assert.strictEqual(normalizeOutputFormat({ output_format: 'wav', sample_rate: 48000 }), 'pcm_48000');
    // A rate is never served BELOW what was asked for — that is the whole point
    // of asking, and 44.1k is the CD rate where video runs at 48k.
    assert.strictEqual(normalizeOutputFormat({ output_format: 'wav', sample_rate: 44100 }), 'pcm_44100');
    assert.strictEqual(normalizeOutputFormat({ output_format: 'wav', sample_rate: 30000 }), 'pcm_44100');
    // An explicit mp3 is still honoured: this translates a request, it does not
    // overrule one.
    assert.strictEqual(normalizeOutputFormat({ output_format: 'mp3_44100_128' }), 'mp3_44100_128');
});

test('dialogue is headed MONO — the one request that cannot state its own length', async () => {
    /*
     * Behavioural, and it has to be: `buildVoiceRequest` returning the right
     * shape says nothing about which number reaches the header. The bug was
     * entirely in what the wrapper defaulted to when the request carried
     * nothing for it to measure.
     */
    assert.strictEqual(buildVoiceRequest({ text: 'x', voice_id: 'v', output_format: 'wav' }).outputFormat,
        'pcm_48000');

    const out = await withStubProvider(96000, () =>          // 1s of mono 48k
        adapter.generate('voice', { text: 'A line.', voice_id: 'v1', output_format: 'wav' }));

    assert.strictEqual(out.ok, true, out.error || '');
    assert.strictEqual(out.data.slice(0, 4).toString('ascii'), 'RIFF', 'dialogue is stored headerless');
    assert.strictEqual(out.data.slice(8, 12).toString('ascii'), 'WAVE');
    assert.strictEqual(out.data.readUInt16LE(22), 1,
        'dialogue headed as stereo — it will play at double speed and the wrong pitch');
    assert.strictEqual(out.data.readUInt32LE(24), 48000, 'dialogue is not 48kHz');
    assert.strictEqual(out.data.readUInt16LE(34), 16, 'not 16-bit PCM');
    assert.strictEqual(out.data.readUInt32LE(28), 96000, 'byte rate disagrees with mono 48k');
    assert.strictEqual(out.data.readUInt32LE(4), out.data.length - 8, 'the RIFF size is wrong');
});

test('a request that states its length has its channels measured, not assumed', async () => {
    // 3s is the documented music minimum, so duration_s: 3 asks for exactly that.
    const mono = await withStubProvider(3 * 48000 * 2, () =>
        adapter.generate('music', { prompt: 'a cue', duration_s: 3, output_format: 'wav' }));
    assert.strictEqual(mono.data.readUInt16LE(22), 1, 'a mono score was headed as stereo');

    const stereo = await withStubProvider(3 * 48000 * 2 * 2, () =>
        adapter.generate('music', { prompt: 'a cue', duration_s: 3, output_format: 'wav' }));
    assert.strictEqual(stereo.data.readUInt16LE(22), 2, 'a stereo score was headed as mono');

    // And where the byte count fits neither, it refuses to guess and SAYS SO,
    // rather than handing over a file that plays at the wrong pitch.
    const odd = await withStubProvider(96000, () =>
        adapter.generate('music', { prompt: 'a cue', duration_s: 3, output_format: 'wav' }));
    assert.notStrictEqual(odd.data.slice(0, 4).toString('ascii'), 'RIFF');
    assert.strictEqual(odd.meta.pcm_wrapped_as_wav, false,
        'the refusal is silent — the caller cannot tell it received raw samples');
});

test('effects and room tone ask for a format at all', async () => {
    /*
     * These two go to /sound-generation, which takes output_format and which
     * both builders called with none — so they stayed 128kbps 44.1k after the
     * music path was fixed. A fix covering one endpoint of three looks done.
     */
    for (const capability of ['sfx', 'ambient']) {
        const seconds = 3;
        const out = await withStubProvider(seconds * 48000 * 2, () =>
            adapter.generate(capability, { prompt: 'a sound', duration_s: seconds, output_format: 'wav' }));
        assert.strictEqual(out.ok, true, `${capability}: ${out.error || ''}`);
        assert.strictEqual(out.data.slice(0, 4).toString('ascii'), 'RIFF',
            `${capability} is not stored as a WAV`);
        assert.strictEqual(out.data.readUInt32LE(24), 48000, `${capability} is not 48kHz`);
        assert.strictEqual(out.meta.format, 'wav', `${capability} reports the wrong container`);
    }
});
