const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const {execFileSync}=require('child_process');
process.env.FILM_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'film-audio-handoff-'));
for(const key of Object.keys(process.env)) if (/_API_KEY$|_API_SECRET$|^RUNWAYML_/.test(key)) delete process.env[key];
const {db,generateId}=require('../db/database'); require('../db/schema').ensureSchema();
const audio=require('../lib/video-audio-policy'); const media=require('../lib/nle-media'); const nle=require('../lib/nle-export');
const ff=require('../lib/ffmpeg').resolveFfmpeg();
const folder=process.env.FILM_DATA_DIR;
const video=path.join(folder,'production.mp4'); const silent=path.join(folder,'silent.mp4');
if(ff.available){
 execFileSync(ff.bin,['-nostdin','-y',...require('./helpers').lavfiSource('color=c=black:s=160x90:r=24:d=4','sine=frequency=440:duration=4'),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video],{stdio:'ignore'});
 execFileSync(ff.bin,['-nostdin','-y','-i',video,'-c:v','copy','-an',silent],{stdio:'ignore'});
}
test('no-music rule survives every provider prompt and sound remains on',()=>{
 const p=audio.applyVideoAudioPolicy({prompt:'Rain on roof',motion_prompt:'Walk slowly',width:1280,height:720,duration_s:4},{});
 assert.equal(p.audio,true); assert.equal(p.generate_audio,true);
 const seed=require('../lib/providers/seedance').buildVideoRequest(p).body;
 assert.equal(seed.generate_audio,true); assert.match(seed.prompt,/NO MUSIC/);
 const run=require('../lib/providers/runway').buildVideoRequest({...p,model:'veo3.1'}).body;
 assert.equal(run.audio,true); assert.match(run.promptText,/NO MUSIC/);
 const silent=audio.applyVideoAudioPolicy(p,{provider_config:{video_audio_policy:'silent'}});
 assert.equal(silent.audio,false); assert.equal(silent.generate_audio,false);
 assert.match(audio.soundPrompt('x'.repeat(4000),1000),/^Audio:.*NO MUSIC/);
 assert.equal(audio.soundPrompt('x'.repeat(4000),1000).length,1000);
});
test('wrapper carries sound metadata on bytes, URLs and resumable handles',async()=>{
 const providers=require('../lib/providers');
 providers.register({id:'audio-fixture',capabilities:['video'],supports:c=>c==='video',isConfigured:()=>true,generate:async()=>({ok:true,data:Buffer.from('fixture')})});
 const result=await providers.resolve('video',{video:'audio-fixture'}).generate('video',{prompt:'A door closes'});
 assert.equal(result.audio,true); assert.equal(result.data.audio,true);
 providers.register({id:'audio-url-fixture',capabilities:['video'],supports:c=>c==='video',isConfigured:()=>true,asyncGeneration:true,generate:async(cap,p,opts)=>{opts.onHandle('audio-fixture-handle',{}); return {ok:true,url:'https://fixture.invalid/video.mp4'};}});
 const url=await providers.resolve('video',{video:'audio-url-fixture'}).generate('video',{prompt:'A door closes'});
 assert.equal(url.data.audio,true);
 assert.equal(JSON.parse(db.prepare('SELECT meta FROM film_generation_jobs WHERE request_id = ?').get('audio-fixture-handle').meta).audio,true);
});
test('real video keeps requested audio and explicit silence strips it',{skip:!ff.available},async()=>{
 const {persistProviderMedia}=require('../lib/provider-media');
 const kept=await persistProviderMedia('fixture','video','kept.mp4',fs.readFileSync(video),{keepAudio:true});
 assert.equal(require('../lib/ffmpeg').inspectMedia(kept).hasAudio,true);
 const stripped=await persistProviderMedia('fixture','video','silent.mp4',fs.readFileSync(video),{keepAudio:false});
 assert.equal(require('../lib/ffmpeg').inspectMedia(stripped).hasAudio,false);
 await assert.rejects(persistProviderMedia('fixture','video','broken.mp4',Buffer.from('invalid'),{keepAudio:false}),e=>e.code==='VIDEO_AUDIO_STRIP_FAILED');
});
test('NLE preserves gaps, all stems, clip sound, source trims and fades',{skip:!ff.available},()=>{
 const shots=[{id:'a',shot_code:'A',duration_ms:2000,scene_id:'scene'},{id:'gap',shot_code:'GAP',duration_ms:1000},{id:'b',shot_code:'B',duration_ms:1000}];
 const assets=[{id:'v',shot_id:'a',asset_type:'video_raw',file_path:video,file_name:'production.mp4',duration_ms:4000,metadata:JSON.stringify({edit:{source_in_ms:1000}})},
 {id:'b',shot_id:'b',asset_type:'video_raw',file_path:silent,file_name:'silent.mp4',duration_ms:4000},
 ...['line_1.wav','line_2.wav'].map((name,i)=>({id:name,shot_id:'a',asset_type:'audio_dialogue',file_path:video,file_name:name,duration_ms:500,metadata:JSON.stringify({gain_db:-4,fade_in_ms:100,fade_out_ms:100})})),
 ...['sfx_1.wav','sfx_2.wav'].map(name=>({id:name,shot_id:'a',asset_type:'audio_sfx',file_path:video,file_name:name,duration_ms:1000}))];
 const xml=nle.generatePremiereXML({title:'Fixture'},shots,assets,{target_fps:24,timecode_start:'01:00:00:00'});
 assert.match(xml,/<name>B<\/name>[\s\S]*?<start>72<\/start>/);
 assert.match(xml,/<name>A<\/name>[\s\S]*?<in>24<\/in><out>72<\/out>/);
 for(const name of ['production.mp4','line_1.wav','line_2.wav','sfx_1.wav','sfx_2.wav']) assert.match(xml,new RegExp('<name>'+name.replace('.','\\.')+'</name>'));
 assert.match(xml,/<keyframe>/); assert.match(xml,/<frame>86400<\/frame>/);
 const fcpx=nle.generateFCPXML({title:'Fixture'},shots,assets,{target_fps:23.976,timecode_start:'01:00:00:00'});
 assert.match(fcpx,/tcFormat="NDF"/); assert.match(fcpx,/<gap name="GAP"/);
 for(const name of ['line_1.wav','line_2.wav','sfx_1.wav','sfx_2.wav']) assert.ok(fcpx.includes(name));
 assert.equal(nle.elapsedFrames(10000,29.97),300); assert.equal(nle.elapsedFrames(30000,29.97),899);
 assert.equal(nle.timecodeToFrames('01:00:00;00',29.97),107892);
 assert.match(nle.generateEDL({title:'Fixture'},shots,{target_fps:23.976,timecode_start:'01:00:00:00',assets}),/NON-DROP FRAME/);
});
test('audition approval is bound to the current file; package has production audio after relocation',{skip:!ff.available},async()=>{
 const shot={id:'s',shot_code:'S',duration_ms:2000};
 const asset={id:'v',shot_id:'s',asset_type:'video_raw',file_path:video,file_name:'production.mp4',duration_ms:4000};
 const pkg=require('../lib/export-package');
 assert.ok(pkg.preflightExport({},[shot],[asset]).blocking.some(b=>b.code==='VIDEO_AUDIO_AUDITION_REQUIRED'));
 asset.metadata=JSON.stringify({audio_review:{status:'approved',no_music:true,reviewed_at:new Date().toISOString(),fingerprint:media.fingerprint(asset)}});
 const dest=path.join(folder,'package'); const result=await pkg.packageExport({title:'Fixture'},[shot],[asset],{dest,format:'premiere'});
 const moved=path.join(folder,'relocated');fs.renameSync(dest,moved);
 const xml=fs.readFileSync(path.join(moved,path.basename(result.xml_path)),'utf8');
 assert.match(xml,/<audio>[\s\S]*production.mp4/); assert.ok(fs.existsSync(path.join(moved,'media',result.copied[0])));
 fs.appendFileSync(video,Buffer.from('changed'));
 assert.ok(media.audition(asset));
});
test('source ranges reject invalid trims',()=>{
 assert.throws(()=>media.sourceRange({shot_code:'X',duration_ms:3000},{duration_ms:4000,metadata:{edit:{source_in_ms:2000}}}),/Invalid source range/);
 const pre=require('../lib/export-package').preflightExport({},[{id:'s',duration_ms:4000}],[{id:'v',shot_id:'s',asset_type:'video_raw',duration_ms:4000,metadata:{edit:{duration_ms:2000}}},{id:'line',shot_id:'s',asset_type:'audio_dialogue',duration_ms:2500}]);
 assert.ok(pre.blocking.some(b=>b.code==='DIALOGUE_OUTSIDE_PICTURE'));
});

test('project policy and clip audition API are explicit; approval clears QA/export gate',{skip:!ff.available},()=>{
 const pid=generateId(),sid=generateId(),shot=generateId(),aid=generateId();
 db.prepare("INSERT INTO film_projects (id,title) VALUES (?, 'Policy fixture')").run(pid);
 db.prepare("INSERT INTO film_scenes (id,project_id,scene_number) VALUES (?,?,1)").run(sid,pid);
 db.prepare("INSERT INTO film_shots (id,scene_id,shot_code,duration_ms) VALUES (?,?, 'A',2000)").run(shot,sid);
 db.prepare("INSERT INTO film_assets (id,project_id,shot_id,asset_type,file_path,file_name,duration_ms) VALUES (?,?,?,'video_raw',?,'production.mp4',4000)").run(aid,pid,shot,video);
 const handler=require('../routes/video-gen').handleVideoGen;
 const call=(method,parts,body={})=>{let result;handler({method,body},{writeHead:code=>{result={code};},end:text=>{result.body=JSON.parse(text);}},parts,{});return result;};
 const policy=call('PUT',['film','projects',pid,'video','audio-policy'],{video_audio_policy:'silent'});
 assert.equal(policy.code,200);assert.equal(policy.body.music_allowed,false);assert.equal(policy.body.dialogue_sfx_allowed,false);
 assert.equal(call('PUT',['film','projects',pid,'video','audio-policy'],{video_audio_policy:'allow_music'}).code,400);
 assert.equal(call('GET',['film','shots',shot,'video','audio-review']).body.blocking.code,'VIDEO_AUDIO_AUDITION_REQUIRED');
 assert.equal(call('PUT',['film','shots',shot,'video','audio-review'],{asset_id:aid,status:'approved',no_music:false}).code,400);
 const approved=call('PUT',['film','shots',shot,'video','audio-review'],{asset_id:aid,status:'approved',no_music:true,expected_fingerprint:media.fingerprint({file_path:video}),reviewer:'fixture reviewer'});
 assert.equal(approved.code,200);assert.equal(approved.body.blocking,null);
 const qa=require('../lib/qa-checker').runShotQA(shot,db);
 assert.equal(qa.checks.find(c=>c.id==='video_audio_no_music_review').passed,true);
 assert.equal(call('PUT',['film','shots',shot,'video','edit'],{asset_id:aid,source_in_ms:3000,duration_ms:2000}).code,400);
 const edit=call('PUT',['film','shots',shot,'video','edit'],{asset_id:aid,source_in_ms:1000,duration_ms:2000});
 assert.equal(edit.code,200);assert.equal(edit.body.head_handle_ms,1000);assert.equal(edit.body.tail_handle_ms,1000);
 assert.equal(call('GET',['film','shots',shot,'video','audio-review']).body.blocking,null);
});

test('approved-score stems are sidecars, and dialogue order uses line indices',()=>{
 const renderer=require('../lib/music-renderer'); const original=renderer.listBounces;
 renderer.listBounces=()=>[{master:{asset_id:'mix'},stems:[{asset_id:'stem'}]}];
 try {
  const stems=media.scoreStems({prepare:()=>({get:id=>({id,file_name:'strings.wav',file_path:'/fixture/strings.wav',asset_type:'audio_mix'})})},{session_id:'session',asset_id:'mix'});
  assert.equal(stems.length,1);assert.equal(media.metadata(stems[0]).handoff_only,true);
  assert.equal(media.selectedAudio(stems,'audio_mix').length,0);
 } finally {renderer.listBounces=original;}
 const ordered=media.selectedAudio([{file_name:'ZED_0.wav',asset_type:'audio_dialogue'},{file_name:'ANN_1.wav',asset_type:'audio_dialogue'}],'audio_dialogue');
 assert.deepEqual(ordered.map(a=>a.file_name),['ZED_0.wav','ANN_1.wav']);
});

test('stream callbacks and results retain an explicit silent policy',async()=>{
 const providers=require('../lib/providers');
 providers.register({id:'audio-stream-fixture',capabilities:['video'],supports:c=>c==='video',isConfigured:()=>true,generate:async()=>({ok:true}),generateStream:async(cap,p,res,cb)=>{const data=Buffer.from('fixture');cb.onComplete(data);return {ok:true,data};}});
 let audioSignal;
 const result=await providers.resolve('video',{video:'audio-stream-fixture',video_audio_policy:'silent'}).generateStream('video',{prompt:'Door closes'},null,{onComplete:data=>{audioSignal=data.audio;}});
 assert.equal(audioSignal,false);assert.equal(result.audio,false);assert.equal(result.data.audio,false);
});


test('direct video route replaces the adapter-consumed motion prompt and preserves no-music sound',async()=>{
 const providers=require('../lib/providers');
 const pid=generateId(),sid=generateId(),shot=generateId();
 db.prepare("INSERT INTO film_projects (id,title,provider_config) VALUES (?, 'Override fixture', ?)").run(pid,JSON.stringify({video:'route-prompt-fixture'}));
 db.prepare("INSERT INTO film_scenes (id,project_id,scene_number) VALUES (?,?,1)").run(sid,pid);
 db.prepare("INSERT INTO film_shots (id,scene_id,shot_code,duration_ms,scene_card_yaml) VALUES (?,?, 'OVERRIDE',4000,?)").run(shot,sid,JSON.stringify({description:'Original composed scene',action:'Original motion'}));
 let consumed;
 providers.register({id:'route-prompt-fixture',capabilities:['video'],supports:c=>c==='video',isConfigured:()=>true,generate:async(cap,p)=>{
  consumed={seedance:require('../lib/providers/seedance').buildVideoRequest(p).body,runway:require('../lib/providers/runway').buildVideoRequest({...p,model:'veo3.1'}).body};
  return {ok:false,status:422,error:'Fixture stops before media generation'};
 }});
 let response;
 await require('../routes/video-gen').handleVideoGen({method:'POST',body:{prompt_override:'Replacement: a red kite rises over the sea.'}}, {writeHead:code=>{response={code};},end:text=>{response.body=JSON.parse(text);}},['film','shots',shot,'video','generate'],{});
 assert.equal(response.code,422);
 assert.ok(consumed,'registered adapter was reached by the direct route');
 for(const prompt of [consumed.seedance.prompt,consumed.runway.promptText]) {
  assert.match(prompt,/Replacement: a red kite rises over the sea\./);
  assert.doesNotMatch(prompt,/Original composed scene|Original motion/);
  assert.match(prompt,/NO MUSIC/);
 }
 assert.equal(consumed.seedance.generate_audio,true);
 assert.equal(consumed.runway.audio,true);
});


test('approval rejects same-size byte replacement even with preserved mtime',()=>{
 const pid=generateId(),sid=generateId(),shot=generateId(),aid=generateId();
 const file=path.join(folder,'race-'+aid+'.mp4');fs.writeFileSync(file,Buffer.from('oldbytes'));
 db.prepare("INSERT INTO film_projects (id,title) VALUES (?, 'Race fixture')").run(pid);
 db.prepare("INSERT INTO film_scenes (id,project_id,scene_number) VALUES (?,?,1)").run(sid,pid);
 db.prepare("INSERT INTO film_shots (id,scene_id,shot_code,duration_ms) VALUES (?,?, 'RACE',2000)").run(shot,sid);
 db.prepare("INSERT INTO film_assets (id,project_id,shot_id,asset_type,file_path,file_name,duration_ms) VALUES (?,?,?,'video_raw',?,'race.mp4',4000)").run(aid,pid,shot,file);
 const handler=require('../routes/video-gen').handleVideoGen;
 const call=(method,body={})=>{let result;handler({method,body},{writeHead:code=>{result={code};},end:text=>{result.body=JSON.parse(text);}},['film','shots',shot,'video','audio-review'],{});return result;};
 const read=call('GET',{asset_id:aid});assert.equal(read.code,200);assert.match(read.body.fingerprint,/^sha256:[a-f0-9]{64}$/);
 assert.equal(call('PUT',{asset_id:aid,status:'approved',no_music:true}).code,400);
 const stat=fs.statSync(file);fs.writeFileSync(file,Buffer.from('newbytes'));fs.utimesSync(file,stat.atime,stat.mtime);
 const stale=call('PUT',{asset_id:aid,status:'approved',no_music:true,expected_fingerprint:read.body.fingerprint});
 assert.equal(stale.code,409);assert.equal(stale.body.code,'AUDIO_REVIEW_STALE');
 assert.equal(media.metadata(db.prepare('SELECT metadata FROM film_assets WHERE id=?').get(aid)).audio_review,undefined);
 const current=call('GET',{asset_id:aid});assert.notEqual(current.body.fingerprint,read.body.fingerprint);
 assert.equal(call('PUT',{asset_id:aid,status:'approved',no_music:true,expected_fingerprint:current.body.fingerprint}).code,200);
});

test('selected source trim matches Playback, timeline route, conform and Premiere',{skip:!ff.available},async()=>{
 const pid=generateId(),sid=generateId(),shot=generateId(),aid=generateId();
 const asset={id:aid,shot_id:shot,asset_type:'video_raw',file_path:video,file_name:'production.mp4',duration_ms:4000,metadata:JSON.stringify({edit:{source_in_ms:1000,duration_ms:2000}})};
 db.prepare("INSERT INTO film_projects (id,title) VALUES (?, 'Trim fixture')").run(pid);
 db.prepare("INSERT INTO film_scenes (id,project_id,scene_number) VALUES (?,?,1)").run(sid,pid);
 db.prepare("INSERT INTO film_shots (id,scene_id,shot_code,duration_ms) VALUES (?,?, 'TRIM',4000)").run(shot,sid);
 db.prepare("INSERT INTO film_assets (id,project_id,shot_id,asset_type,file_path,file_name,duration_ms,metadata) VALUES (?,?,?,'video_raw',?,'production.mp4',4000,?)").run(aid,pid,shot,video,asset.metadata);
 db.prepare('UPDATE film_shots SET selected_video_asset_id=? WHERE id=?').run(aid,shot);
 const row=db.prepare('SELECT * FROM film_shots WHERE id=?').get(shot);
 const timeline=require('../lib/timeline').buildTimeline([row],{[shot]:[asset]},{fps:24});
 const entry=timeline.entries[0];assert.equal(entry.duration_ms,2000);assert.equal(entry.source_in_ms,1000);assert.equal(entry.source_out_ms,3000);
 assert.equal(entry.video.source_in_ms,1000);assert.equal(entry.video.source_out_ms,3000);
 const plan=require('../lib/conform').planConform(pid);assert.equal(plan.ok,true);assert.equal(plan.total_duration_ms,2000);
 assert.equal(plan.clips[0].source_in_ms,1000);assert.equal(plan.clips[0].source_out_ms,3000);
 const xml=nle.generatePremiereXML({title:'Trim'},[row],[asset],{target_fps:24});assert.match(xml,/<in>24<\/in>\s*<out>72<\/out>/);
 const route=fs.readFileSync(path.join(__dirname,'../routes/timeline.js'),'utf8');assert.match(route,/a\.metadata/);
 const cmd=require('../lib/conform').buildFfmpegArgs(plan,path.join(folder,'preview.mp4'));
 assert.deepEqual(cmd.args.slice(0,6),['-ss','1','-t','2','-i',video]);
 const master=await require('../lib/conform').runConform(pid);assert.equal(master.ok,true,master.error);
 const probe=require('../lib/ffmpeg').inspectMedia(master.output || master.file_path);assert.equal(probe.ok,true);assert.equal(probe.hasAudio,true);assert.ok(Math.abs(probe.durationSeconds-2)<0.1);
});
