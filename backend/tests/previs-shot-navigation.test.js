/** Execute actual UI loaders against deferred responses to prove selection race safety. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ui = fs.readFileSync(path.join(__dirname,'../../src/index.html'),'utf8');
function source(name) { const start = ui.indexOf('    async function '+name+'('); assert.ok(start >= 0); return ui.slice(start,ui.indexOf('\n    }\n',start)+7); }
function harness(api) {
    const env = { WORLD:{}, WALK:{}, api, worldEngineOn:()=>true, worldConsoleRender:()=>{},worldHydrateMove:()=>{} };
    vm.createContext(env); vm.runInContext(source('worldRailSelect')+'\n'+source('worldLoadForShot'),env); return env;
}
test('slow prior shot cannot overwrite the current shot location/world or blocking',async()=>{
    let release;
    const old=new Promise(r=>{release=r;});
    const env=harness(async url=>{
        if(url==='/shots/A/previs') return old;
        if(url==='/shots/A/world') return {world_version_id:'vA',world_id:'wA'};
        if(url==='/shots/B/previs') return {shot_id:'B'};
        if(url==='/shots/B/world') return {world_version_id:'vB',world_id:'wB'};
        if(url.includes('/versions')) return {versions:[{id:url.includes('wB')?'vB':'vA'}]};
        if(url.startsWith('/worlds/')) return {world:{id:url.split('/')[2]}};
        return {world_version_id:url.includes('vB')?'vB':'vA'};
    });
    const a=env.worldRailSelect('A');await env.worldRailSelect('B');release({shot_id:'A'});await a;
    assert.equal(env.WORLD.shotId,'B');assert.equal(env.WORLD.world.id,'wB');assert.equal(env.WORLD.version.id,'vB');assert.equal(env.WORLD.geometryFor,'vB');assert.equal(env.WORLD.blocking.shot_id,'B');
});
test('an unpinned shot clears previous set geometry and a late mesh response cannot restore it',async()=>{
    let release;const mesh=new Promise(r=>{release=r;});
    const env=harness(async url=>{
        if(url==='/shots/A/world')return {world_version_id:'vA',world_id:'wA'};
        if(url==='/shots/B/world')return {world_version_id:null};
        if(url.includes('/geometry'))return mesh;
        if(url.includes('/versions'))return {versions:[{id:'vA'}]};
        if(url.startsWith('/worlds/'))return {world:{id:'wA'}};
        return null;
    });
    const a=env.worldRailSelect('A');await Promise.resolve();await Promise.resolve();await env.worldRailSelect('B');release({triangles:[1]});await a;
    assert.equal(env.WORLD.shotId,'B');assert.equal(env.WORLD.world,null);assert.equal(env.WORLD.geometry,null);assert.equal(env.WORLD.geometryFor,null);
});
test('failure clears the current shot set and switching back reloads its own stable pin',async()=>{
    let fail=false;
    const env=harness(async url=>{
        if(url==='/shots/B/world')throw new Error('cancelled');
        if(url==='/shots/A/world') { if(fail)throw new Error('failed');return {world_id:'wA',world_version_id:'v1',newer_version:2,newer_version_id:'v2'}; }
        if(url.includes('/versions'))return {versions:[{id:'v1'},{id:'v2'}]};
        if(url.startsWith('/worlds/'))return {world:{id:'wA'}};
        if(url.includes('/geometry'))return {triangles:[1]};
        return null;
    });
    await env.worldRailSelect('A');assert.equal(env.WORLD.version.id,'v1');
    await env.worldRailSelect('B');assert.equal(env.WORLD.world,null);assert.equal(env.WORLD.geometry,null);
    await env.worldRailSelect('A');assert.equal(env.WORLD.version.id,'v1');assert.equal(env.WORLD.version.newer_version_id,'v2');
    fail=true;await env.worldRailSelect('A');assert.equal(env.WORLD.world,null);assert.equal(env.WORLD.geometry,null);
});
test('locking after an awaited apply keeps the original shot and cannot refresh another selection',async()=>{
    let release;const pending=new Promise(r=>{release=r;});const calls=[];
    const env=harness(async(url)=>{calls.push(url);if(url==='/shots/A/previs/apply')return pending;return {shot_id:'A'};});
    env.setStatus=()=>{};vm.runInContext(source('worldRefreshBlocking')+'\n'+source('worldLockShot'),env);
    env.WORLD={shotId:'A',selectionRevision:1,blocking:{decisions:[{state:'trying'}]}};
    const work=env.worldLockShot(true);env.WORLD={shotId:'B',selectionRevision:2,blocking:{shot_id:'B'}};
    release({});await work;
    assert.deepEqual(calls,['/shots/A/previs/apply','/shots/A/previs/lock']);assert.equal(env.WORLD.blocking.shot_id,'B');
});
test('a late explicit blocking refresh cannot replace the selected shot',async()=>{
    let release;const pending=new Promise(r=>{release=r;});
    const env=harness(async()=>pending);vm.runInContext(source('worldRefreshBlocking'),env);
    env.WORLD={shotId:'A',selectionRevision:1};const work=env.worldRefreshBlocking();
    env.WORLD={shotId:'B',selectionRevision:2,blocking:{shot_id:'B'}};release({shot_id:'A'});await work;
    assert.equal(env.WORLD.blocking.shot_id,'B');
});
test('a completed set rebuild pins its original shot rather than a later selection',async()=>{
    let release;const pending=new Promise(r=>{release=r;});const calls=[];
    const env=harness(async(url)=>{calls.push(url);return url.includes('/edit')?pending:{};});
    Object.assign(env,{SETEDIT:{build:{id:'buildA'}},state:{currentProject:{id:'p'}},stageRenderBar:()=>{},setStatus:()=>{},setEditObjects:()=>[],worldPaintFrame:()=>{}});
    vm.runInContext(source('setEditRebuild'),env);env.WORLD={shotId:'A',selectionRevision:1};
    const work=env.setEditRebuild();env.WORLD={shotId:'B',selectionRevision:2};release({version:{id:'v2',version:2}});await work;
    assert.deepEqual(calls,['/set-builds/buildA/edit','/shots/A/world']);assert.equal(env.WORLD.shotId,'B');
});
