import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-connect-settings-'));process.env.AGENT_PLAYER_DATA_DIR=path.join(root,'data');process.env.DATABASE_PATH=path.join(root,'data','agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const [id,role] of [['channel-owner','owner'],['channel-user','user']])db.prepare('INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,\'fixture\',?,\'active\')').run(id,id+'@example.invalid',id,role);
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {generateToken}=await import('../src/auth/jwt.ts');const {agentConnectRoutes}=await import('../src/api/routes/agent-connect.ts');const {CHANNEL_CATALOG}=await import('agent-connect-dpro');
const app=Fastify();registerAuthGate(app);await app.register(agentConnectRoutes);await app.ready();const auth={authorization:'Bearer '+generateToken('channel-owner',1)};const realFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Provider requests forbidden in settings tests')};
test.after(async()=>{await app.close();globalThis.fetch=realFetch;closeDatabase();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
test('all33 canonical integrations are listed and configurable without activation or secret responses',async()=>{
 const listing=await app.inject({url:'/api/agent-connect/catalog',headers:auth});assert.equal(listing.statusCode,200);assert.equal(listing.json().configurable,true);assert.deepEqual(listing.json().channels.map(c=>c.id),CHANNEL_CATALOG.map(c=>c.id));assert.equal(listing.json().channels.length,33);
 for(const c of CHANNEL_CATALOG){
  const environment=Object.fromEntries(c.requiredEnv.map(k=>[k,k.endsWith('_JSON')?'{}':'secret-fixture-'+c.id]));
  const url='/api/agent-connect/'+c.id+'/config';const payload={allowedUsers:['trusted-person'],allowedChannels:['allowed-room'],environment};
  const result=await app.inject({method:'PUT',url,headers:auth,payload});assert.equal(result.statusCode,200,c.id+':'+result.body);assert.equal(result.json().saved,true);assert.equal(result.json().channel.configured,true);assert.ok(!result.body.includes('secret-fixture-'));
  const again=await app.inject({method:'PUT',url,headers:auth,payload:{allowedUsers:['trusted-person','another'],allowedChannels:['allowed-room']}});assert.equal(again.statusCode,200,c.id);
 }
 const end=await app.inject({url:'/api/agent-connect/catalog',headers:auth});assert.equal(end.json().channels.filter(c=>c.configured).length,33);assert.ok(!end.body.includes('secret-fixture-'));
 const rows=db.prepare("SELECT * FROM extension_configs WHERE extension_id IN ('agent-connect','telegram','discord')").all();assert.equal(rows.length,3);assert.ok(rows.every(r=>r.enabled===0));
 const py=JSON.parse(rows.find(r=>r.extension_id==='agent-connect').config_json).channels;assert.equal(Object.keys(py).length,31);assert.ok(Object.values(py).every(c=>c.auto_reply===false&&c.owner_user_id==='channel-owner'));assert.equal(py.ntfy.environment.NTFY_TOPIC,'secret-fixture-ntfy');
});
test('settings reject unauthorized access, unknown adapters, unsafe worker fields and injected config grants',async()=>{
 assert.equal((await app.inject({url:'/api/agent-connect/catalog'})).statusCode,401);
 const member={authorization:'Bearer '+generateToken('channel-user',1)};assert.equal((await app.inject({url:'/api/agent-connect/catalog',headers:member})).statusCode,403);
 const payload={allowedUsers:[],allowedChannels:[]};assert.equal((await app.inject({method:'PUT',url:'/api/agent-connect/ntfy/config',headers:member,payload})).statusCode,403);
 for(const extra of [{environment:{PYTHONPATH:'unsafe'}},{python_executable:'/bin/sh'},{auto_reply:true},{settings:{extra:{command:'unsafe'}}},{owner_user_id:'other'}]){
 const before=db.prepare("SELECT config_json FROM extension_configs WHERE extension_id='agent-connect'").get().config_json;
 assert.equal((await app.inject({method:'PUT',url:'/api/agent-connect/ntfy/config',headers:auth,payload:{...payload,...extra}})).statusCode,400);
 assert.equal(db.prepare("SELECT config_json FROM extension_configs WHERE extension_id='agent-connect'").get().config_json,before);
 }
 assert.equal((await app.inject({method:'PUT',url:'/api/agent-connect/unknown/config',headers:auth,payload})).statusCode,404);
});

test('activation is independent, durable and owner-only without activating siblings', async()=>{
 const toggle=(id,enabled,headers=auth)=>app.inject({method:'PUT',url:'/api/agent-connect/'+id+'/activation',headers,payload:{enabled}});
 assert.equal((await toggle('ntfy',true)).statusCode,200);
 let channels=(await app.inject({url:'/api/agent-connect/catalog',headers:auth})).json().channels;
 assert.deepEqual(channels.filter(c=>c.enabled).map(c=>c.id),['ntfy']);
 assert.equal(channels.find(c=>c.id==='ntfy').state,'restart_required');
 assert.equal((await toggle('slack',true)).statusCode,200);await toggle('telegram',true);
 channels=(await app.inject({url:'/api/agent-connect/catalog',headers:auth})).json().channels;
 assert.deepEqual(new Set(channels.filter(c=>c.enabled).map(c=>c.id)),new Set(['ntfy','slack','telegram']));
 await toggle('ntfy',false);
 channels=(await app.inject({url:'/api/agent-connect/catalog',headers:auth})).json().channels;
 assert.equal(channels.find(c=>c.id==='ntfy').state,'disabled');assert.equal(channels.find(c=>c.id==='slack').enabled,true);
 const saved=JSON.parse(db.prepare("SELECT config_json FROM extension_configs WHERE extension_id='agent-connect'").get().config_json);
 assert.equal(saved.channels.ntfy.enabled,false);assert.equal(saved.channels.slack.enabled,true);assert.equal(saved.channels.ntfy.environment.NTFY_TOPIC,'secret-fixture-ntfy');
 assert.equal((await toggle('slack',false,{authorization:'Bearer '+generateToken('channel-user',1)})).statusCode,403);
 for(const payload of [{enabled:'true'},{enabled:true,auto_reply:true}])assert.equal((await app.inject({method:'PUT',url:'/api/agent-connect/slack/activation',headers:auth,payload})).statusCode,400);
});

test('catalog membership rejects property-like adapter IDs before either write route', async () => {
 const before=db.prepare("SELECT extension_id,config_json,enabled FROM extension_configs ORDER BY extension_id").all();
 for(const id of ['__proto__','constructor','prototype','toString']){
  for(const suffix of ['config','activation']){
   const payload=suffix==='config'?{allowedUsers:[],allowedChannels:[]}:{enabled:false};
   assert.equal((await app.inject({method:'PUT',url:`/api/agent-connect/${id}/${suffix}`,headers:auth,payload})).statusCode,404);
  }
 }
 assert.deepEqual(db.prepare("SELECT extension_id,config_json,enabled FROM extension_configs ORDER BY extension_id").all(),before);
});
