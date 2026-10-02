const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-handoffs-'));
for (const key of Object.keys(process.env)) if (/_API_KEY$|_API_SECRET$/.test(key)) delete process.env[key];
const { db } = require('../db/database');
require('../db/schema').ensureSchema();
const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
const { gatherShotReferences, shotReferencesFor } = require('../lib/shot-references');
const { selectReferences } = require('../lib/reference-images');
const { selectedFrame } = require('../lib/selected-frame');
const { activeAnchorFor } = require('../lib/shot-anchor');
const { generationRevision } = require('../lib/generation-revision');
const { executeGenerator } = require('../lib/node-handlers/generate');
const id = () => crypto.randomUUID();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function fixture() {
    const project = id(), scene = id(), shot = id(), location = id();
    db.prepare('INSERT INTO film_projects (id,title,style_preset) VALUES (?,?,?)').run(project,'Workflow test','cinematic');
    db.prepare('INSERT INTO film_locations (id,project_id,name) VALUES (?,?,?)').run(location,project,'STREET');
    db.prepare('INSERT INTO film_scenes (id,project_id,scene_number,location) VALUES (?,?,1,?)').run(scene,project,'STREET');
    db.prepare('INSERT INTO film_shots (id,scene_id,shot_code,scene_card_yaml) VALUES (?,?,?,?)').run(shot,scene,'1A',JSON.stringify({description:'A red mailbox beside a tree',action:'A hand opens the mailbox',camera:{lens:'85mm',movement:'dolly-in'},shot_type:'close-up',location_view:'north'}));
    const asset = (version,type='keyframe',meta={}) => {
        const aid = id(), file = path.join(process.env.FILM_DATA_DIR,aid+'.png'); fs.writeFileSync(file,PNG);
        db.prepare('INSERT INTO film_assets (id,project_id,shot_id,location_id,asset_type,file_name,file_path,version,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run(aid,project,type==='keyframe'?shot:null,type==='reference_image'?location:null,type,path.basename(file),file,version,JSON.stringify(meta));
        return {id:aid,file_path:file};
    };
    return {project,scene,shot,location,asset};
}
test('selected approved frame and anchor stay pinned when a newer attempt exists', () => {
    const f=fixture(), first=f.asset(1), newer=f.asset(2);
    db.prepare('UPDATE film_shots SET current_frame_version=1 WHERE id=?').run(f.shot);
    assert.equal(selectedFrame(db,f.shot).id,first.id);
    const ctx=loadShotContext(f.shot); assert.equal(ctx.keyframeAsset.id,first.id); assert.ok(ctx.initImage.startsWith('data:image/png'));
    const other=id();db.prepare('INSERT INTO film_shots (id,scene_id,shot_code) VALUES (?,?,?)').run(other,f.scene,'1B');
    db.prepare('UPDATE film_projects SET anchor_shot_id=? WHERE id=?').run(f.shot,f.project);
    assert.equal(activeAnchorFor(db,other).asset.id,first.id);
    db.prepare('UPDATE film_shots SET current_frame_version=99 WHERE id=?').run(f.shot);
    assert.equal(selectedFrame(db,f.shot),null);
    assert.notEqual(first.id,newer.id);
});
test('moodboard image reaches gatherer and explicit location view wins', () => {
    const f=fixture(), north=f.asset(1,'reference_image',{view:'north',plate_role:'reference'});
    f.asset(2,'reference_image',{view:'south',plate_role:'reference'});
    const style=f.asset(1,'other');
    db.prepare('INSERT INTO film_mood_board (id,project_id,note,image_path) VALUES (?,?,?,?)').run(id(),f.project,'warm dusk',style.file_path);
    const diagnostics=[];
    const refs=gatherShotReferences(f.project,[],{id:f.location,name:'STREET'},[],null,{locationView:'north',limit:5,diagnostics});
    assert.ok(refs.some(r=>r.kind==='style'&&r.name==='warm dusk'));
    const loc=refs.find(r=>r.kind==='location');assert.equal(loc.view,'north');assert.equal(loc.uri,'data:image/png;base64,'+PNG.toString('base64'));assert.equal(diagnostics.length,0);
    const shared=shotReferencesFor(db,{projectId:f.project,location:{id:f.location,name:'STREET'},locationView:'north',support:{canAttach:true,canTag:true,maxReferenceImages:5}});
    assert.equal(shared.references.find(r=>r.kind==='location').view,'north');assert.ok(north.id);
});
test('reference budget and missing files produce actionable diagnostics', () => {
    const diagnostics=[];
    const refs=selectReferences([{name:'missing actor',kind:'character',file_path:'/does-not-exist.png'}, {name:'set',kind:'location',uri:'data:image/png;base64,AA=='},{name:'look',kind:'style',uri:'data:image/png;base64,AA=='}],{limit:1,diagnostics});
    assert.equal(refs.length,1);assert.deepEqual(diagnostics.map(d=>d.code),['REFERENCE_UNREADABLE','REFERENCE_BUDGET']);assert.ok(diagnostics.every(d=>d.action));
});
test('flow direction is added once while camera, style and scene are inherited; replacement is explicit', async () => {
    const ctx={project:{style_preset:'cinematic',provider_config:'{}'},sceneCard:{description:'A red mailbox beside a tree',camera:{lens:'85mm'},shot_type:'close-up'},characters:[],location:null};
    const sent=[];ctx.providerFor=()=>({id:'mock',promptLimit:4000,generate:async(_c,p)=>{sent.push(p);return {ok:true,data:{image_url:'fixture'}};}});
    const node={type:'gen.image',config:{}};
    await executeGenerator(node,{text:{value:'A blue butterfly lands'}},ctx);
    assert.equal(sent.length,1);assert.equal(sent[0].prompt.split('A blue butterfly lands').length-1,1);
    assert.match(sent[0].prompt,/red mailbox/);assert.match(sent[0].prompt,/85/);assert.match(sent[0].prompt,/cinematic|film grain|photoreal/i);
    await executeGenerator({...node,config:{prompt_mode:'replace'}},{text:{value:'Exact replacement'}},ctx);
    assert.equal(sent[1].prompt,'Exact replacement');
});
test('generation revision changes on design, reference bytes, selected version and Previs decisions', () => {
    const f=fixture();f.asset(1);const plate=f.asset(1,'reference_image',{view:'north'});
    const before=()=>generationRevision(db,f.shot).fingerprint;
    let last=before();db.prepare('UPDATE film_locations SET description=? WHERE id=?').run('A cobbled street',f.location);assert.notEqual(before(),last);
    last=before();fs.writeFileSync(plate.file_path,Buffer.concat([PNG,Buffer.from('changed')]));assert.notEqual(before(),last);
    last=before();f.asset(2);assert.notEqual(before(),last);
    last=before();db.prepare('UPDATE film_shots SET current_frame_version=1 WHERE id=?').run(f.shot);assert.notEqual(before(),last);
    last=before();db.prepare('INSERT INTO film_previs_blocking (id,shot_id,camera_json) VALUES (?,?,?)').run(id(),f.shot,JSON.stringify({focalMm:35}));assert.notEqual(before(),last);
});
test('unapplied Previs refuses durable generator calls without spending', async () => {
    let calls=0;const out=await executeGenerator({type:'gen.image',config:{}},{},{project:{},previsApplication:{applied:false},providerFor:()=>({id:'mock',generate:async()=>{calls++;}})});
    assert.equal(out.code,'STAGED_PREVIS');assert.equal(calls,0);
});
test('ambiguous location names refuse generation rather than selecting an arbitrary set',()=>{
    const f=fixture();db.prepare('INSERT INTO film_locations (id,project_id,name) VALUES (?,?,?)').run(id(),f.project,'street');
    const ctx=loadShotContext(f.shot);assert.equal(ctx.location,null);assert.ok(ctx.referenceDiagnostics.some(d=>d.code==='LOCATION_AMBIGUOUS'));
    assert.throws(()=>buildCapabilityPayload('image',ctx),e=>e.code==='LOCATION_AMBIGUOUS');
});
test('actual per-node adapter governs reference limit and tags before prompt assembly',async()=>{
    const f=fixture();f.asset(1,'reference_image',{view:'north'});const style=f.asset(1,'other');
    db.prepare('INSERT INTO film_mood_board (id,project_id,note,image_path) VALUES (?,?,?,?)').run(id(),f.project,'warm dusk',style.file_path);
    let payload;
    const ctx=loadShotContext(f.shot);ctx.providerFor=()=>({id:'mock',supportsReferenceImages:true,supportsReferenceTags:false,maxReferenceImages:1,promptLimit:4000,generate:async(_c,p)=>{payload=p;return{ok:true,data:{image_url:'fixture'}};}});
    const out=await executeGenerator({type:'gen.image',config:{provider:'mock'}},{},ctx);
    assert.equal(out.ok,true);assert.equal(payload.reference_images.length,1);assert.equal(payload.reference_images[0].kind,'location');assert.doesNotMatch(payload.prompt,/@street/);assert.ok(out.generation.reference_diagnostics.some(d=>d.code==='REFERENCE_BUDGET'));
});
test('world archive filters active choices, preserves versions, refuses pinned sets, and restores',()=>{
    const worlds=require('../lib/worlds'),f=fixture();
    const w=worlds.createWorld(db,{projectId:f.project,locationId:f.location,name:'Old set'});
    const v=worlds.newVersion(db,w.id,{});
    worlds.pinShot(db,f.shot,v.id);
    assert.throws(()=>worlds.updateWorld(db,w.id,{archived:true}),e=>e.code==='WORLD_IN_USE');
    worlds.unpinShot(db,f.shot);
    assert.ok(worlds.updateWorld(db,w.id,{archived:true}).archived_at);
    assert.equal(worlds.worldsFor(db,f.project).length,0);
    assert.equal(worlds.worldsFor(db,f.project,{archived:'only'})[0].id,w.id);
    assert.equal(worlds.getVersion(db,v.id).id,v.id);
    assert.throws(()=>worlds.pinShot(db,f.shot,v.id),e=>e.code==='WORLD_ARCHIVED');
    worlds.updateWorld(db,w.id,{archived:false});
    assert.equal(worlds.worldsFor(db,f.project)[0].id,w.id);assert.equal(worlds.pinShot(db,f.shot,v.id).world_version_id,v.id);
});
test('wired video direction and explicit replacement reach Seedance and Runway wire prompts',async()=>{
    const ctx={project:{style_preset:'cinematic',provider_config:'{}'},sceneCard:{description:'A red mailbox beside a tree',action:'A hand opens the mailbox',camera:{lens:'85mm',movement:'dolly-in'}},characters:[],location:null,initImage:'data:image/png;base64,'+PNG.toString('base64')};
    const sent=[];ctx.providerFor=()=>({id:'mock',generate:async(_c,p)=>{sent.push(p);return{ok:true,data:{video_url:'fixture'}};}});
    await executeGenerator({type:'gen.video',config:{}},{text:{value:'A blue butterfly lands'}},ctx);
    assert.match(sent[0].motion_prompt,/blue butterfly/);assert.match(sent[0].motion_prompt,/mailbox/);
    const seedance=require('../lib/providers/seedance'),runway=require('../lib/providers/runway');
    assert.match(seedance.buildVideoRequest(sent[0]).body.prompt,/blue butterfly/);
    assert.match(runway.buildVideoRequest(sent[0]).body.promptText,/blue butterfly/);
    await executeGenerator({type:'gen.video',config:{prompt_mode:'replace'}},{text:{value:'Exact replacement'}},ctx);
    assert.equal(sent[1].motion_prompt,'Exact replacement');
    for(const wire of [seedance.buildVideoRequest(sent[1]).body.prompt,runway.buildVideoRequest(sent[1]).body.promptText]){
        assert.match(wire,/Exact replacement/);assert.doesNotMatch(wire,/mailbox/);assert.equal(wire.split('Exact replacement').length-1,1);
    }
});
test('explicit kept character plate survives primary and fallback adapter rebuilds',()=>{
    const f=fixture(), character=id();
    db.prepare('INSERT INTO film_characters (id,project_id,name) VALUES (?,?,?)').run(character,f.project,'MAYA');
    const frame=f.asset(1),plate=f.asset(1,'character_sheet',{view:'front',plate_role:'reference'});
    db.prepare('UPDATE film_assets SET character_id=? WHERE id=?').run(character,plate.id);
    db.prepare('UPDATE film_shots SET scene_card_yaml=? WHERE id=?').run(JSON.stringify({characters:['MAYA'],camera:{shot_type:'wide'},description:'Maya stands in the street'}),f.shot);
    const target=id();
    db.prepare('INSERT INTO film_shots (id,scene_id,shot_code,scene_card_yaml) VALUES (?,?,?,?)').run(target,f.scene,'1B',JSON.stringify({characters:['MAYA'],camera:{shot_type:'wide'},description:'Maya walks in the street'}));
    db.prepare('UPDATE film_projects SET anchor_shot_id=? WHERE id=?').run(f.shot,f.project);
    const ctx=loadShotContext(target,{keepPlates:['MAYA'],referenceSupport:{canAttach:true,canTag:true,maxReferenceImages:5}});
    assert.ok(ctx.references.some(r=>r.kind==='character'));
    const build=require('../lib/capability-payloads').buildImagePayloadForAdapter;
    for(const adapter of [{id:'primary',supportsReferenceImages:true,supportsReferenceTags:true,maxReferenceImages:5,promptLimit:4000},{id:'fallback',supportsReferenceImages:true,supportsReferenceTags:false,maxReferenceImages:2,promptLimit:3000}]){
        const payload=build(ctx,adapter);
        assert.ok(payload.reference_images.some(r=>r.kind==='character'),adapter.id);
        assert.ok(payload.reference_images.some(r=>r.kind==='anchor'),adapter.id);
    }
    assert.ok(frame.id);
});
test('all storyboard routes and node adapter refresh retain request-selected plates',async()=>{
    const f=fixture(),character=id(),target=id();f.asset(1);
    db.prepare('INSERT INTO film_characters (id,project_id,name) VALUES (?,?,?)').run(character,f.project,'MAYA');
    const plate=f.asset(1,'character_sheet',{view:'front',plate_role:'reference'});db.prepare('UPDATE film_assets SET character_id=? WHERE id=?').run(character,plate.id);
    const card=JSON.stringify({characters:['MAYA'],camera:{shot_type:'wide'},description:'Maya on the street'});
    db.prepare('UPDATE film_shots SET scene_card_yaml=? WHERE id=?').run(card,f.shot);
    db.prepare('INSERT INTO film_shots (id,scene_id,shot_code,scene_card_yaml) VALUES (?,?,?,?)').run(target,f.scene,'1B',card);
    db.prepare('UPDATE film_projects SET anchor_shot_id=? WHERE id=?').run(f.shot,f.project);
    const adapters=[{id:'fixture-primary',supportsReferenceImages:true,supportsReferenceTags:true,maxReferenceImages:5,promptLimit:4000},{id:'fixture-fallback',supportsReferenceImages:true,supportsReferenceTags:false,maxReferenceImages:2,promptLimit:3000}];
    const fallback=require('../lib/image-fallback'),original={...fallback};const seen=[];
    fallback.imageProviderChain=()=>adapters;
    fallback.generateImageWithFallback=async factory=>{for(const adapter of adapters){const p=typeof factory==='function'?factory(adapter):factory;seen.push(p);}return {ok:false,error:'Fixture stops before provider: no generation'};};
    const modulePath=require.resolve('../routes/storyboard');delete require.cache[modulePath];const {handleStoryboard}=require(modulePath);
    const {Writable}=require('stream');
    const call=async url=>{const res=new Writable({write(_c,_e,next){next();}});res.writeHead=()=>res;res.setHeader=()=>{};await handleStoryboard({method:'POST',body:{keep_plates:['MAYA']}},res,url.split('/').filter(Boolean),{});};
    try{
        for(const route of [`/film/shots/${target}/storyboard/regenerate`,`/film/projects/${f.project}/storyboard/generate`,`/film/projects/${f.project}/storyboard/generate/stream`]){
            seen.length=0;await call(route);
            const anchored=seen.filter(p=>(p.reference_images||[]).some(r=>r.kind==='anchor'));
            assert.equal(anchored.length,2,route);
            for(const p of anchored)assert.ok(p.reference_images.some(r=>r.kind==='character'),route);
        }
        const ctx=loadShotContext(target,{keepPlates:['MAYA'],referenceSupport:{canAttach:true,canTag:true,maxReferenceImages:5}});
        let payload;ctx.providerFor=()=>({...adapters[0],generate:async(_cap,p)=>{payload=p;return {ok:true,data:{image_url:'fixture'}};}});
        const out=await executeGenerator({type:'gen.image',config:{}},{},ctx);assert.equal(out.ok,true);assert.ok(payload.reference_images.some(r=>r.kind==='character'));
    }finally{Object.assign(fallback,original);delete require.cache[modulePath];}
});
