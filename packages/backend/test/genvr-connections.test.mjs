import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-genvr-conn-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('conn-owner','o@example.invalid','conn-owner','fixture','owner','active')").run();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('conn-user','u@example.invalid','conn-user','fixture','user','active')").run();
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {generateToken}=await import('../src/auth/jwt.ts');
const {connectionsRoutes}=await import('../src/api/routes/connections.ts');const account=await import('../src/services/genvr-account.ts');
const TOKEN='fictional-token-'+'x'.repeat(40);let now=Date.parse('2026-10-19T10:00:00Z'),polls=0,linkedAfter=1,calls=[];
const server={drafts:0,version:0,status:'draft',publish:null};
const client=token=>{assert.equal(token,TOKEN);return {
 linkedIdentity:async()=>({id:'genvr-user-1',name:'Fictional Owner'}),disconnect:async()=>{calls.push('disconnect');},
 createDraft:async world=>{server.drafts++;assert.equal(world.export().assets.length,0);return {id:'exp-fictional'};},
 readWorld:async()=>({world:{version:server.version},terrain:[]}),
 uploadWorld:async(world,target)=>{if(target.baseVersion!==server.version){const e=new Error('stale');e.status=409;throw e;}const cmds=world.export().commands;assert.equal(cmds.length,1);assert.equal(cmds[0].params.itemId,"genvr.core.bench");server.version++;return {id:target.id,version:server.version};},
 experience:async()=>({isOwner:true,status:server.status,accessMode:'private'}),
 publishWorld:async(_id,o)=>{server.publish=o;server.status='published';return {isOwner:true,status:'published',accessMode:o.access.mode};}};};
account.setGenvrAccountDeps({now:()=>now,client:async t=>client(t),link:async()=>({start:async(name,scopes)=>{calls.push(['start',name,scopes]);return {deviceCode:'device-secret',userCode:'ABCD-EFGH',verificationUri:'https://genvr.net/link',expiresIn:600,interval:5};},poll:async r=>{assert.equal(r.deviceCode,'device-secret');polls++;return polls>linkedAfter?{status:'linked',account:{accessToken:TOKEN,tokenType:'Bearer',expiresAt:'2026-11-18T10:00:00Z',scopes:['worlds:read','worlds:write','worlds:publish','worlds:join'],grantId:'grant-1'}}:{status:'pending'};}})});
const app=Fastify();registerAuthGate(app);await app.register(connectionsRoutes);await app.ready();
const h=id=>({authorization:'Bearer '+generateToken(id,1)});const owner=h('conn-owner');
const get=async()=>(await app.inject({url:'/api/connections',headers:owner})).json().connections[0];
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await new Promise(r=>setTimeout(r,100));}return false;};
test.after(async()=>{await app.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});

test('only the owner sees or changes connections; bodies are exact',async()=>{
 assert.equal((await app.inject({url:'/api/connections'})).statusCode,401);
 assert.equal((await app.inject({url:'/api/connections',headers:h('conn-user')})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/connections/genvr/link',headers:owner,payload:{scopes:['items:submit']}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/connections/genvr/disconnect',headers:owner,payload:{}})).statusCode,400);
 assert.deepEqual(await get(),{id:'genvr',name:'Genvr',status:'not_connected',account:null,scopes:[],linkedAt:null,expiresAt:null,pending:null,error:null});
});

test('device consent: connecting shows the code, then connected; the token stays in the key store',{timeout:30000},async()=>{
 const started=(await app.inject({method:'POST',url:'/api/connections/genvr/link',headers:owner,payload:{}})).json().connection;
 assert.equal(started.status,'connecting');assert.equal(started.pending.userCode,'ABCD-EFGH');assert.equal(started.pending.verificationUri,'https://genvr.net/link');
 assert.deepEqual(calls[0],['start','Dpro Agent',['worlds:read','worlds:write','worlds:publish','worlds:join']]);
 assert.ok(await wait(async()=>(await get()).status==='connected'));
 const c=await get();assert.equal(c.account.name,'Fictional Owner');assert.equal(c.pending,null);assert.ok(polls>=2);
 const all=JSON.stringify((await app.inject({url:'/api/connections',headers:owner})).json());assert.ok(!all.includes(TOKEN)&&!all.includes('device-secret'));
 const row=db.prepare("select encrypted_value from credentials where name='genvr-account'").get();assert.ok(row&&!row.encrypted_value.includes(TOKEN));
 assert.equal(await account.genvrToken('conn-owner'),TOKEN);
});

test('test world: draft created once, upload on server version, separate publish confirmation',async()=>{
 const up=()=>app.inject({method:'POST',url:'/api/connections/genvr/test-world/upload',headers:owner,payload:{confirm:true}});
 assert.equal((await app.inject({method:'POST',url:'/api/connections/genvr/test-world/upload',headers:owner,payload:{}})).statusCode,400);
 const first=(await up()).json().publication;assert.equal(first.serverId,'exp-fictional');assert.equal(first.localId,'dpro.publication.test');assert.equal(first.version,1);assert.equal(first.status,'draft');
 assert.equal((await up()).json().publication.version,2);assert.equal(server.drafts,1);
 const content={violence:false,blood:false,horror:false,romance:false,userChat:false,paidItems:false};
 assert.equal((await app.inject({method:'POST',url:'/api/connections/genvr/test-world/publish',headers:owner,payload:{title:'T',type:'social',access:'public',content}})).statusCode,400);
 const pub=(await app.inject({method:'POST',url:'/api/connections/genvr/test-world/publish',headers:owner,payload:{confirm:true,title:'Dpro test world',type:'social',access:'public',content}})).json().publication;
 assert.equal(pub.status,'published');assert.equal(pub.link,'https://genvr.net/places/exp-fictional');assert.deepEqual(server.publish.access,{mode:'public'});
 assert.equal((await up()).statusCode,409);
 const list=(await app.inject({url:'/api/connections/genvr/publications',headers:owner})).json().publications;assert.equal(list.length,1);
});

test('expired grant asks to relink; disconnect revokes and forgets',async()=>{
 now=Date.parse('2026-12-01T00:00:00Z');assert.equal((await get()).status,'expired');
 assert.equal((await app.inject({method:'POST',url:'/api/connections/genvr/test-world/upload',headers:owner,payload:{confirm:true}})).json().code,'relink_required');
 now=Date.parse('2026-10-19T10:00:00Z');
 const off=(await app.inject({method:'POST',url:'/api/connections/genvr/disconnect',headers:owner,payload:{confirm:true}})).json().connection;
 assert.equal(off.status,'not_connected');assert.ok(calls.includes('disconnect'));assert.equal(await account.genvrToken('conn-owner'),null);
 assert.equal(db.prepare("select count(*) n from credentials where name='genvr-account'").get().n,0);
});
