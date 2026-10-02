/** Video sound is production sound; the score is authored separately. */
const NO_MUSIC = 'Audio: natural dialogue, diegetic sound effects and ambience only. NO MUSIC. No score, soundtrack, musical bed, singing or instruments. The music score is created separately.';
const MUSIC_NEGATIVE = 'music, score, soundtrack, musical bed, singing, instruments';
function policyOf(project) {
    let config = project && project.provider_config;
    if (typeof config === 'string') { try { config = JSON.parse(config); } catch (_) { config = {}; } }
    const policy = (project && project.video_audio_policy) || (config && config.video_audio_policy) || 'no_music';
    if (!['no_music', 'silent'].includes(policy)) throw new Error('video_audio_policy must be no_music or silent');
    return policy;
}
function applyVideoAudioPolicy(payload, project) {
    const p = { ...payload };
    const configured = project && (project.video_audio_policy || (typeof project.provider_config === 'object' && project.provider_config.video_audio_policy));
    p.video_audio_policy = configured ? policyOf(project) : policyOf({ ...project, video_audio_policy: p.video_audio_policy || policyOf(project) });
    const sound = p.video_audio_policy !== 'silent' && (p.audio !== undefined ? p.audio : p.generate_audio !== false);
    p.audio = p.generate_audio = !!sound;
    if (sound) {
        for (const key of ['prompt', 'motion_prompt', 'promptText']) if (p[key]) p[key] = soundPrompt(p[key]);
        p.negative_prompt = [p.negative_prompt && p.negative_prompt.replace(MUSIC_NEGATIVE, '').replace(/,\s*$/, ''), MUSIC_NEGATIVE].filter(Boolean).join(', ');
        p.video_negative_prompt = [p.video_negative_prompt && p.video_negative_prompt.replace(MUSIC_NEGATIVE, '').replace(/,\s*$/, ''), MUSIC_NEGATIVE].filter(Boolean).join(', ');
    }
    return p;
}
function soundPrompt(prompt, limit) {
    const text = String(prompt || '').replace(NO_MUSIC, '').trim();
    return (NO_MUSIC + (text ? '\n' + text : '')).slice(0, limit || Infinity);
}
module.exports = { NO_MUSIC, MUSIC_NEGATIVE, policyOf, applyVideoAudioPolicy, soundPrompt };
