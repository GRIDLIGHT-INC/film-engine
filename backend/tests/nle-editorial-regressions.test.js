'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('../lib/nle-media');
const { generatePremiereXML } = require('../lib/nle-export');
const { preflightExport } = require('../lib/export-package');
const project = { id: 'p', name: 'Regression', target_fps: 24 };
test('Premiere retains full source duration and both handles for a trimmed clip', () => {
    const shot = {id:'s',shot_code:'S1',duration_ms:4000};
    const asset = {id:'v',shot_id:'s',asset_type:'video_raw',file_name:'source.mov',duration_ms:4000,metadata:{has_audio:false,edit:{source_in_ms:1000,duration_ms:2000}}};
    const xml = generatePremiereXML(project,[shot],[asset],{target_fps:24});
    const clip = xml.match(/<clipitem id="clipitem-1">([\s\S]*?)<\/clipitem>/)[1];
    assert.match(clip, /<duration>96<\/duration>/);
    assert.match(clip, /<start>0<\/start>\s*<end>48<\/end>\s*<in>24<\/in>\s*<out>72<\/out>/);
    assert.match(clip.match(/<file[^>]*>([\s\S]*?)<\/file>/)[1], /<duration>96<\/duration>/);
    assert.deepEqual(media.sourceRange(shot,asset),{source_in_ms:1000,duration_ms:2000,source_ms:4000,head_handle_ms:1000,tail_handle_ms:1000});
});
function dialogueFixture(pause) {
    const shot={id:'s',shot_code:'S1',duration_ms:1900,scene_card_yaml:JSON.stringify({dialogue:[{character:'A',line:'Hello.',direction:'beat'},{character:'B',line:'Goodbye.'}]})};
    const assets=[0,1].map(i=>({id:'d'+i,shot_id:'s',asset_type:'audio_dialogue',file_name:'line_'+i+'.wav',duration_ms:600,metadata:{line_index:i,...(pause === undefined ? {} : {pause_after_ms:pause})}}));
    return {shot,assets};
}
test('card beat overflow blocks preflight and export through the same timing plan',()=>{
    const {shot,assets}=dialogueFixture();
    const plan=media.planAudioEvents([shot],assets,{});
    assert.equal(plan.events.length,2);
    assert.ok(plan.events[1].start_ms > shot.duration_ms);
    assert.equal(plan.events[1].duration_ms,600);
    assert.equal(plan.blocking[0].code,'DIALOGUE_OUTSIDE_PICTURE');
    const preflight=preflightExport(project,[shot],assets);
    assert.equal(preflight.ready,false);
    assert.ok(preflight.blocking.some(issue=>issue.code==='DIALOGUE_OUTSIDE_PICTURE' && issue.asset_id==='d1'));
    assert.throws(()=>media.audioEvents([shot],assets,{}),{code:'DIALOGUE_OUTSIDE_PICTURE'});
    assert.throws(()=>generatePremiereXML(project,[shot],assets),{code:'DIALOGUE_OUTSIDE_PICTURE'});
});
test('explicit zero pause overrides the card beat consistently',()=>{
    const {shot,assets}=dialogueFixture(0);
    const plan=media.planAudioEvents([shot],assets,{});
    assert.deepEqual(plan.events.map(e=>[e.start_ms,e.duration_ms]),[[0,600],[600,600]]);
    assert.deepEqual(plan.blocking,[]);
    assert.equal(preflightExport(project,[shot],assets).ready,true);
    assert.equal(media.audioEvents([shot],assets,{}).length,2);
    const xml=generatePremiereXML(project,[shot],assets);
    assert.match(xml, /line_0.wav/); assert.match(xml,/line_1.wav/);
});
