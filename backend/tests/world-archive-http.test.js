const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'world-archive-http-'));process.env.FILM_DATA_DIR=dir;
for(const key of Object.keys(process.env))if(/_API_KEY$|_API_SECRET$/.test(key))delete process.env[key];
const {db}=require('../db/database');require('../db/schema').ensureSchema();const worlds=require('../lib/worlds');
const project=crypto.randomUUID();db.prepare('INSERT INTO film_projects(id,title)VALUES(?,?)').run(project,'Disposable archive HTTP');
const world=worlds.createWorld(db,{projectId:project,name:'Recoverable set'}),version=worlds.newVersion(db,world.id,{});
const port=28000+Math.floor(Math.random()*1000),base='http://localhost:'+port;let server;
async function request(url,method='GET',body){const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});return {status:response.status,body:await response.json(),headers:response.headers};}
test.before(async()=>{server=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),FILM_DATA_DIR:dir},stdio:'ignore'});for(let i=0;i<100;i++){try{if((await request('/api/health')).status===200)return;}catch(_){}await new Promise(r=>setTimeout(r,50));}throw Error('Fixture server failed to start');});
test.after(()=>{if(server)server.kill('SIGTERM');db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('actual HTTP PATCH archives and restores while retaining versions and selector filtering',async()=>{
 const archived=await request('/film/worlds/'+world.id,'PATCH',{archived:true});assert.equal(archived.status,200);assert.ok(archived.body.world.archived_at);
 assert.equal((await request('/film/projects/'+project+'/worlds')).body.worlds.length,0);
 assert.equal((await request('/film/projects/'+project+'/worlds?archived=only')).body.worlds[0].id,world.id);
 assert.equal(worlds.getVersion(db,version.id).id,version.id);
 const restored=await request('/film/worlds/'+world.id,'PATCH',{archived:false});assert.equal(restored.status,200);assert.equal(restored.body.world.archived_at,null);
 assert.equal((await request('/film/projects/'+project+'/worlds')).body.worlds[0].id,world.id);
});
test('PATCH shares malformed JSON and domain validation errors without archiving',async()=>{
 assert.equal((await request('/film/worlds/'+world.id,'PATCH','{bad json')).status,400);
 assert.equal((await request('/film/worlds/'+world.id,'PATCH',{archived:'yes'})).status,400);
 assert.equal((await request('/film/worlds/'+crypto.randomUUID(),'PATCH',{archived:true})).status,404);
 assert.equal(worlds.getWorld(db,world.id).archived_at,null);
});
test('PATCH shares the ordinary body limit and refuses oversized JSON without applying',async()=>{
 const payload=JSON.stringify({archived:true,pad:'x'.repeat(10*1024*1024)});
 const out=await request('/film/worlds/'+world.id,'PATCH',payload);assert.equal(out.status,413);assert.match(out.body.error,/too large/);assert.equal(worlds.getWorld(db,world.id).archived_at,null);
});
test('unsupported methods refuse and preflight advertises supported PATCH',async()=>{
 assert.equal((await request('/film/worlds/'+world.id,'PUT',{})).status,405);
 const response=await fetch(base+'/film/worlds/'+world.id,{method:'OPTIONS'});assert.equal(response.status,204);assert.match(response.headers.get('access-control-allow-methods'),/PATCH/);
});
