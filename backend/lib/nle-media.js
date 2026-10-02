/** Editorial media contracts shared by timeline exporters and preflight. */
const fs = require('fs');
const audioProbeCache = new Map();
function metadata(asset) { try { return typeof asset.metadata === 'object' ? asset.metadata || {} : JSON.parse(asset.metadata || '{}'); } catch (_) { return {}; } }
function hasClipAudio(asset) {
    const m = metadata(asset);
    if (!asset.file_path || !fs.existsSync(asset.file_path)) return typeof m.has_audio === 'boolean' ? m.has_audio : false;
    const key=asset.file_path + ':' + fingerprint(asset);
    if (audioProbeCache.has(key)) return audioProbeCache.get(key);
    try { const probe = require('./ffmpeg').inspectMedia(asset.file_path); const present=!!(probe.ok && probe.hasAudio); if (probe.ok) audioProbeCache.set(key,present); return present; } catch (_) { return false; }
}
function sourceRange(shot, asset) {
    const edit = metadata(asset).edit || {};
    const source_in_ms = Number(shot.source_in_ms ?? edit.source_in_ms ?? 0);
    let duration_ms = Number(shot.edit_duration_ms ?? edit.duration_ms ?? shot.duration_ms ?? asset.duration_ms ?? 0);
    const source_ms = Number(asset.duration_ms) || source_in_ms + duration_ms;
    // Legacy card estimates may exceed imported footage; explicit edits must remain strict.
    if (shot.source_in_ms == null && edit.source_in_ms == null && shot.edit_duration_ms == null && edit.duration_ms == null && source_ms > 0) duration_ms = Math.min(duration_ms || source_ms, source_ms);
    if (!Number.isFinite(source_in_ms) || source_in_ms < 0 || !(duration_ms > 0) || source_in_ms + duration_ms > source_ms + 1) throw new Error(`Invalid source range for ${shot.shot_code || asset.file_name}`);
    return { source_in_ms, duration_ms, source_ms, head_handle_ms: source_in_ms, tail_handle_ms: source_ms - source_in_ms - duration_ms };
}
function selectedAudio(assets, type) {
    const seen = new Map();
    for (const a of assets.filter(a => a.asset_type === type && metadata(a).selected !== false && !metadata(a).handoff_only)) {
        const key = a.file_name || a.id || a.file_path;
        const old = seen.get(key);
        if (!old || Number(a.version || 0) > Number(old.version || 0) || (Number(a.version || 0) === Number(old.version || 0) && String(a.created_at || '') >= String(old.created_at || ''))) seen.set(key, a);
    }
    const index=a=>Number(metadata(a).line_index ?? ((String(a.file_name || '').match(/_(\d+)\.[^.]+$/) || [])[1]) ?? 0);
    return [...seen.values()].sort((a,b) => type === 'audio_dialogue' ? index(a)-index(b) : String(a.file_name || '').localeCompare(String(b.file_name || ''), undefined, { numeric: true }));
}
function planAudioEvents(shots, assets, beds = {}, fps) {
    const events = [], blocking = [];
    let shotStart = 0;
    for (const shot of shots) {
        const shotAssets = assets.filter(a => a.shot_id === shot.id);
        const video = shotAssets.find(a => ['video_final', 'video_synced', 'video_raw'].includes(a.asset_type));
        let duration;
        try { duration = video ? sourceRange(shot, video).duration_ms : Number(shot.duration_ms) || 0; }
        catch (e) { blocking.push({code:'SOURCE_RANGE_INVALID',shot_code:shot.shot_code,detail:e.message}); continue; }
        if (video && hasClipAudio(video)) events.push({ asset: video, type: 'clip', start_ms: shotStart, duration_ms: duration, source_in_ms: sourceRange(shot, video).source_in_ms, gain_db: 0 });
        for (const type of ['audio_dialogue', 'audio_sfx', 'audio_music', 'audio_ambient']) {
            let cursor = 0;
            for (const a of selectedAudio([...shotAssets, ...(beds[shot.id] || [])], type)) {
                const m = metadata(a); const bed = !a.shot_id;
                const offset = Number(m.start_ms ?? (type === 'audio_dialogue' ? cursor : 0));
                const sourceIn=Number(m.source_in_ms) || 0;
                const length = Number(m.duration_ms) || (Number(a.duration_ms) ? Number(a.duration_ms)-sourceIn : duration);
                if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(sourceIn) || sourceIn < 0 || !Number.isFinite(length) || !(length > 0) || (Number(a.duration_ms)>0 && sourceIn+length > Number(a.duration_ms)+1)) {
                    blocking.push({code:'AUDIO_TIMING_INVALID',asset_id:a.id,shot_code:shot.shot_code,detail:'Invalid audio source range for '+(a.file_name || a.id)}); continue;
                }
                if (type === 'audio_dialogue' && !bed && offset+length > duration+1) blocking.push({code:'DIALOGUE_OUTSIDE_PICTURE',asset_id:a.id,shot_code:shot.shot_code,detail:'The selected dialogue extends beyond this shot. Extend the picture or set explicit audio timing before export; no line is silently dropped.'});
                const dur = bed || type === 'audio_dialogue' ? length : Math.min(length, Math.max(0, duration - offset));
                if (dur > 0) events.push({ asset:a, type, start_ms:shotStart + offset, duration_ms:dur, source_in_ms:Number(m.source_in_ms) || 0, gain_db:Number.isFinite(Number(m.gain_db)) ? Number(m.gain_db) : 0, fade_in_ms:Number(m.fade_in_ms) || 0, fade_out_ms:Number(m.fade_out_ms) || 0 });
                if (type === 'audio_dialogue') {
                    const match=String(a.file_name || '').match(/_(\d+)\.[^.]+$/); const index=Number(m.line_index ?? (match && match[1]) ?? 0);
                    let card={}; try { card=JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}
                    const dialogue=require('./dialogue-delivery'); const lines=card.dialogue || [];
                    const pause=Number(m.pause_after_ms ?? (lines[index] ? dialogue.pauseAfter(lines[index],lines[index+1]) : dialogue.PAUSE.turn));
                    cursor=offset+length+pause;
                }
            }
        }
        shotStart += fps ? Math.round(duration*require('./nle-export').actualRate(fps)/1000)/require('./nle-export').actualRate(fps)*1000 : duration;
    }
    return { events, blocking };
}
function audioEvents(shots, assets, beds, fps) {
    const plan = planAudioEvents(shots, assets, beds, fps);
    if (plan.blocking.length) {
        const error = new Error(plan.blocking.map(issue => issue.detail).join('; '));
        error.code = plan.blocking[0].code; error.issues = plan.blocking; throw error;
    }
    return plan.events;
}
function fingerprint(asset) {
    try { return 'sha256:' + require('crypto').createHash('sha256').update(fs.readFileSync(asset.file_path)).digest('hex'); } catch (_) { return null; }
}
function audition(asset) {
    if (!hasClipAudio(asset)) return null;
    const review = metadata(asset).audio_review || {};
    return review.status === 'approved' && review.no_music === true && review.reviewed_at && review.fingerprint === fingerprint(asset) ? null
        : { asset_id:asset.id, file_name:asset.file_name, code:'VIDEO_AUDIO_AUDITION_REQUIRED', message:'Audition the mixed clip audio and approve that no music is present; dialogue and effects are allowed.' };
}
function scoreStems(db, score) {
    const bounce=require('./music-renderer').listBounces(db,score.session_id).find(b=>b.master && b.master.asset_id===score.asset_id);
    return (bounce && bounce.stems || []).map(stem=>db.prepare('SELECT * FROM film_assets WHERE id = ?').get(stem.asset_id)).filter(Boolean)
        .map(asset=>({...asset,metadata:JSON.stringify({...metadata(asset),handoff_only:true,kind:'score_stem_handoff'})}));
}
function editorialShots(shots, assets) {
    return shots.map(shot => {
        const asset = assets.find(a => a.shot_id === shot.id && ['video_final','video_synced','video_raw'].includes(a.asset_type));
        return asset ? { ...shot, duration_ms: sourceRange(shot,asset).duration_ms } : shot;
    });
}
function stack(items) {
    const tracks=[];
    for (const item of items) { let track=tracks.find(t => t[t.length-1].start_ms + t[t.length-1].duration_ms <= item.start_ms); if (!track) tracks.push(track=[]); track.push(item); }
    return tracks;
}
module.exports = { metadata, hasClipAudio, sourceRange, selectedAudio, planAudioEvents, audioEvents, audition, fingerprint, scoreStems, editorialShots, stack };
