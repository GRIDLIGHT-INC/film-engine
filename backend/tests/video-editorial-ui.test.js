const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'../../src/index.html'),'utf8');
function source(name){const start=html.indexOf('async function '+name+'(');assert.ok(start>=0);return html.slice(start,html.indexOf('\n}\n',start)+3);}
function harness(){const calls=[],messages=[],elements={pgNoMusicAudition:{checked:false},pgClipSourceIn:{value:'1'},pgClipUsedDuration:{value:'2'}};const env={document:{getElementById:id=>elements[id]},api:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {head_handle_ms:1000,tail_handle_ms:1000};},state:{currentProject:{id:'p'}},setStatus:m=>messages.push(m),pgLoad:async()=>{},pgSecs:ms=>ms/1000+'s'};vm.createContext(env);vm.runInContext(['pgReviewClipAudio','pgSaveClipEdit','pgSetClipAudioPolicy'].map(source).join('\n'),env);return {env,calls,messages,elements};}
test('audio approval requires an explicit human audition checkbox and targets the exact asset',async()=>{const h=harness();await h.env.pgReviewClipAudio('s','v','auditioned-hash');assert.equal(h.calls.length,0);h.elements.pgNoMusicAudition.checked=true;await h.env.pgReviewClipAudio('s','v','auditioned-hash');assert.equal(h.calls[0].url,'/shots/s/video/audio-review');assert.equal(h.calls[0].body.asset_id,'v');assert.equal(h.calls[0].body.expected_fingerprint,'auditioned-hash');assert.equal(h.calls[0].body.no_music,true);assert.equal(h.calls[0].body.status,'approved');});
test('UI source range uses seconds converted to milliseconds and retains explicit version selection',async()=>{const h=harness();await h.env.pgSaveClipEdit('s','v');assert.deepEqual(h.calls[0],{url:'/shots/s/video/edit',body:{asset_id:'v',source_in_ms:1000,duration_ms:2000}});assert.match(h.messages[0],/head handle 1s.*tail handle 1s/);});
test('audio policy supports no music and silent without triggering generation',async()=>{const h=harness();for(const value of ['no_music','silent'])await h.env.pgSetClipAudioPolicy(value);assert.deepEqual(h.calls.map(x=>x.body.video_audio_policy),['no_music','silent']);assert.ok(h.calls.every(x=>x.url==='/projects/p/video/audio-policy'));});
test('desktop and packaged mobile UI compile and stay identical',()=>{assert.equal(html,fs.readFileSync(path.join(__dirname,'../../ios/FilmEngine/Web/index.html'),'utf8'));for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);});
test('Production monitor seeks the source in and ends at source out once',()=>{
    const start=html.indexOf('function pgPrepareVideo('),code=html.slice(start,html.indexOf('\n}\n',start)+3);
    const player={readyState:0,currentTime:0,pause(){this.paused=true;}};const env={document:{getElementById:()=>player}};vm.createContext(env);vm.runInContext(code,env);
    let advances=0;env.pgPrepareVideo({entry:{video:{source_in_ms:1000}},dur:2000},()=>advances++);
    player.onloadedmetadata();assert.equal(player.currentTime,1);player.currentTime=2.9;player.ontimeupdate();assert.equal(advances,0);
    player.currentTime=3;player.ontimeupdate();player.onended();assert.equal(advances,1);assert.equal(player.paused,true);
});
test('Post Playback loads and scrubs relative to the saved source in and times the edited cut',()=>{
    const names=['loadShotIntoStage','pbSeekAbsolute','pbTick'];const code=names.map(name=>{const start=html.indexOf('    function '+name+'(');assert.ok(start>=0);return html.slice(start,html.indexOf('\n    }\n',start)+7);}).join('\n');
    const entry={index:0,kind:'video',video:{path:'source',source_in_ms:1000},start_ms:0,end_ms:2000,duration_ms:2000};
    const player={currentTime:0,duration:4,readyState:1,paused:false,classList:{add(){},remove(){}},pause(){this.paused=true;},play:async()=>{},load(){this.onloadedmetadata();}};
    const elements={pbVideo:player,pbStill:{classList:{add(){}}},pbGap:{classList:{add(){}}},pbAudio:{pause(){}},pbDialogue:{checked:false},pbPlayBtn:{}};
    const env={pb:{index:0,playing:false,timeline:{entries:[entry]}},document:{getElementById:id=>elements[id]},pbEntry:()=>entry,mediaUrl:p=>p,pbPlayLine(){},renderPlaylist(){},pbMotionLabel(){},pbBedLabel(){},updatePlayhead(){},pbSyncAudio(){},pbSyncBeds(){},requestAnimationFrame:()=>1,pbLastFrame:0};
    vm.createContext(env);vm.runInContext(code,env);env.loadShotIntoStage(0);assert.equal(player.currentTime,1);
    env.pbSeekAbsolute(500);assert.equal(player.currentTime,1.5);assert.equal(env.pb.localMs,500);
    env.pb.playing=true;player.paused=false;player.currentTime=2;env.pbTick(1);assert.equal(env.pb.localMs,1000);
    player.currentTime=3;env.pbTick(2);assert.equal(env.pb.playing,false);assert.equal(player.paused,true);
});
