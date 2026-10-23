import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-runtime-api-'));process.chdir(root);
Object.assign(process.env,{AGENT_PLAYER_DATA_DIR:root,DATABASE_PATH:path.join(root,'main.db'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),AGENT_PLAYER_BACKGROUND:'off',EXTENSIONS_DISABLED:'true',MEMORY_EMBEDDINGS:'hash',ALLOWED_ORIGINS:'http://127.0.0.1:42522'});delete process.env.AGENT_PLAYER_DB;delete process.env.AGENT_PLAYER_LAUNCH_TOKEN;
const realFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Network disabled in fixture');};
const {buildServer}=await import('../src/api/app.ts');const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const {generateToken}=await import('../src/auth/jwt.ts');const {enrollInstallOwner,reviewedInstall}=await import('./fixtures/reviewed-paper-install.mjs');
const registry=await import('../src/services/trading-paper-installation.ts');
const runtime=await import('../src/services/trading-paper-runtime-consent.ts'),journal=await import('../src/services/trading-paper-dispatch-attempts.ts'),activation=await import('../src/services/trading-paper-bot-activation.ts'),ledger=await import('../src/services/trading-paper-ledger.ts'),execution=await import('../src/services/trading-paper-execution.ts');
let selected=db;const base='/api/trading-paper/runtime';
const app=await buildServer({logger:false,paperLedger:()=>selected});app.addHook('preHandler',async request=>{const kind=request.headers['x-fixture-actor'];if(kind&&request.actor)request.actor=kind==='channel'?{...request.actor,channel:'fixture'}:kind==='agent'?{...request.actor,kind:'agent',agentId:'fixture'}:{...request.actor,kind:'system'};});await app.ready();
async function owner({enroll=true,role='owner',bot=true}={}){
 const id='runtime-api-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'fixture',?,'active',1)").run(id,id+'@example.invalid',id,role);
 const at=Date.now(),f=enroll?await enrollInstallOwner(id,at-90000):{};let botId=randomUUID();
 if(bot&&enroll&&role==='owner'){
  await reviewedInstall(db,f,{now:at-60000,capabilities:['paper.account.read','paper.bot.manage']});
  const accountId='account-'+randomUUID(),policyId='policy-'+randomUUID();
  const policy={id:policyId,ownerId:id,accountId,revision:1,appRevision:1,currency:'USD',enabled:true,mode:'paper',expiresAt:at+86400000,symbols:['AAA'],maxOrder:1000,maxExposure:100000,maxDailyLoss:1000,maxOrders:100,cooldownMs:0,maxQuoteAgeMs:5000};ledger.provisionPaperAccount(db,{policy,cash:100000,exposure:0});execution.configurePaperExecution(db,{ownerId:id,accountId,revision:1,feeBps:100,slippageBps:0,unitScale:1,currency:'USD'});
  const body={accountId,policyId,policyRevision:1,appRevision:1,expiresAt:at+3600000,maxSuccessfulTicks:3,cooldownMs:1000},stage=await activation.stagePaperBotActivation(db,f.context,f.actor,body,at-30000);assert.equal(stage.ok,true);
  const challenge=await activation.issuePaperBotActivationProof(db,f.context,f.actor,stage.id,at-30000),proof=await activation.completePaperBotActivationProof(db,f.context,f.actor,stage.id,challenge.token,f.otp(at-30000),at-30000);assert.ok(proof);assert.equal((await activation.applyPaperBotActivation(db,f.context,f.actor,stage.id,proof.receipt,at-30000)).ok,true);botId=stage.botId;
 }
 return {...f,id,botId,token:generateToken(id,enroll?2:1)};
}
const call=(f,method,url,payload,extra={})=>app.inject({method,url,headers:{host:'127.0.0.1:42521',origin:'http://127.0.0.1:42522',...(f?{authorization:'Bearer '+f.token}:{}),...extra},...(payload===undefined?{}:{payload})});
const input=f=>({botId:f.botId,strategy:{kind:'fixed-paper-order',version:1,symbol:'AAA',side:'buy',amount:1000},limits:{expiresAt:Date.now()+1800000,maxAttempts:3,cadenceMs:1000}});
async function proof(f){const stage=await call(f,'POST',base+'/reviews',input(f));assert.equal(stage.statusCode,200,stage.body);const url=base+'/reviews/'+stage.json().id;const challenge=await call(f,'POST',url+'/challenge',{});assert.equal(challenge.statusCode,200,challenge.body);const complete=await call(f,'POST',url+'/complete',{challenge:challenge.json().challenge,code:f.otp(Date.now())});assert.equal(complete.statusCode,200,complete.body);return {url,stage:stage.json(),receipt:complete.json().receipt};}
async function grant(f){const p=await proof(f),applied=await call(f,'POST',p.url+'/apply',{receipt:p.receipt});assert.equal(applied.statusCode,200,applied.body);return {...p,result:applied.json()};}
const consumed=receipt=>db.prepare('SELECT consumed_at FROM verification_receipts WHERE token_hash=?').get(createHash('sha256').update(receipt).digest('hex')).consumed_at;
test.after(async()=>{await app.close();closeDatabase();globalThis.fetch=realFetch;await fs.rm(root,{recursive:true,force:true});});
test('null and missing explicit storage refuse without DDL or dispatch endpoints',async()=>{
 const f=await owner({bot:false});selected=null;assert.equal((await call(f,'POST',base+'/reviews',input(f))).statusCode,503);selected=db;const before=db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();assert.equal((await call(f,'POST',base+'/reviews',input(f))).statusCode,503);assert.deepEqual(db.prepare('SELECT name FROM sqlite_master ORDER BY name').all(),before);
 for(const suffix of ['/dispatch','/execute','/start','/tick','/quotes'])assert.equal(app.hasRoute({method:'POST',url:base+suffix}),false);
 runtime.initializePaperRuntimeConsent(db);journal.initializePaperDispatchAttempts(db);
});
test('real JWT and TOTP create only reviewed consent after explicit apply; owner can read and revoke without trading',async()=>{
 const f=await owner(),p=await proof(f);assert.equal(db.prepare('SELECT count(*) n FROM paper_runtime_consents WHERE owner_id=?').get(f.id).n,0);assert.equal(db.prepare('SELECT count(*) n FROM paper_dispatch_definitions WHERE owner_id=?').get(f.id).n,0);assert.equal(consumed(p.receipt),null);
 const review=await call(f,'GET',p.url);assert.equal(review.statusCode,200,review.body);assert.equal(review.headers['cache-control'],'no-store');assert.equal(review.json().runtimePrincipal,'bundled.paper.deterministic.v1');assert.equal(review.json().amountUnit,'account_minor_units');assert.equal(review.json().providerAccess,false);assert.equal(review.json().runtimeConnected,false);assert.doesNotMatch(review.body,/session_hash|receipt_hash|definition_json|sealed_secret|fenceToken/);
 const applied=await call(f,'POST',p.url+'/apply',{receipt:p.receipt});assert.equal(applied.statusCode,200,applied.body);const g=applied.json();assert.equal(g.status,'granted');assert.equal(g.runtimeConnected,false);assert.equal(g.attemptCount,0);assert.equal((await call(f,'POST',p.url+'/apply',{receipt:p.receipt})).json().replayed,true);
 const url=base+'/consents/'+g.consentId,read=await call(f,'GET',url);assert.equal(read.statusCode,200,read.body);assert.equal(read.headers['cache-control'],'no-store');assert.equal(read.json().definitionId,g.definitionId);assert.equal(db.prepare('SELECT count(*) n FROM paper_bot_ticks').get().n,0);
 const revoked=await call(f,'POST',url+'/revoke',{});assert.equal(revoked.statusCode,200,revoked.body);assert.equal(revoked.json().status,'revoked');assert.equal((await call(f,'POST',url+'/revoke',{})).json().replayed,true);assert.equal((await call(f,'GET',url)).json().status,'revoked');assert.equal(db.prepare('SELECT count(*) n FROM paper_runtime_consents WHERE owner_id=?').get(f.id).n,1);
});
test('human owner factor target and CSRF gates refuse borrowed actors and privileges',async()=>{
 for(const f of [null,await owner({enroll:false,role:'user'}),await owner({enroll:false,role:'admin'}),await owner({enroll:false})])assert.ok([401,403].includes((await call(f,'POST',base+'/reviews',input(f??{botId:randomUUID()}))).statusCode));
 const missing=await owner({bot:false});assert.equal((await call(missing,'POST',base+'/reviews',input(missing))).statusCode,409);
 const f=await owner();for(const kind of ['agent','channel','system'])assert.equal((await call(f,'POST',base+'/reviews',input(f),{'x-fixture-actor':kind})).statusCode,403);assert.equal((await call(f,'POST',base+'/reviews',input(f),{origin:'https://untrusted.invalid'})).statusCode,403);
});
test('strict nested requests and body limits reject owner strategy provider or count injection',async()=>{
 const patches=f=>[{ownerId:f.id},{botId:f.botId+'\n'},{strategy:{...input(f).strategy,symbol:'AAA\n'}},{strategy:{...input(f).strategy,kind:'model'}},{strategy:{...input(f).strategy,provider:'claude'}},{strategy:{...input(f).strategy,amount:0}},{limits:{...input(f).limits,maxAttempts:1001}},{limits:{...input(f).limits,cadenceMs:999}}];
 for(const patch of patches({id:'x',botId:randomUUID()})){const f=await owner(),response=await call(f,'POST',base+'/reviews',{...input(f),...patch});assert.equal(response.statusCode,400,response.body);}
 const f=await owner();assert.equal((await call(f,'POST',base+'/reviews',{...input(f),padding:'x'.repeat(5000)})).statusCode,413);assert.equal((await call(f,'POST',base+'/reviews?owner=other',input(f))).statusCode,400);assert.equal((await call(f,'GET',base+'/reviews/'+randomUUID()+'?x=1')).statusCode,400);
});
test('foreign same-file ledger and other owner cannot read review consume proof or revoke consent',async()=>{
 const f=await owner(),p=await proof(f),other=await owner();assert.equal((await call(other,'GET',p.url)).statusCode,404);const foreign=new Database(process.env.DATABASE_PATH);try{selected=foreign;assert.equal((await call(f,'POST',p.url+'/apply',{receipt:p.receipt})).statusCode,503);assert.equal(consumed(p.receipt),null);}finally{selected=db;foreign.close();}
 const applied=await call(f,'POST',p.url+'/apply',{receipt:p.receipt});assert.equal(applied.statusCode,200,applied.body);const url=base+'/consents/'+applied.json().consentId;assert.equal((await call(other,'GET',url)).statusCode,404);assert.ok([404,409].includes((await call(other,'POST',url+'/revoke',{})).statusCode));assert.equal((await call(f,'GET',url)).json().status,'granted');
});
test('factor loss or target disable blocks new apply while emergency revoke survives missing journal and damaged proof',async()=>{
 const f=await owner(),p=await proof(f);db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(f.id);assert.equal((await call(f,'POST',p.url+'/apply',{receipt:p.receipt})).statusCode,403);assert.equal(consumed(p.receipt),null);
 const h=await owner(),pending=await proof(h);assert.equal(registry.provisionTrustedPaperInstallation(db,h.id,{action:'disable',expectedRevision:1,idempotencyKey:'fixture-disable-h',manifestDigest:registry.BUNDLED_PAPER_INSTALLATION.manifestDigest,capabilities:[]}).ok,true);assert.equal((await call(h,'POST',pending.url+'/apply',{receipt:pending.receipt})).statusCode,409);assert.equal(consumed(pending.receipt),null);
 const g=await owner(),saved=await grant(g);assert.equal(registry.provisionTrustedPaperInstallation(db,g.id,{action:'disable',expectedRevision:1,idempotencyKey:'fixture-disable-g',manifestDigest:registry.BUNDLED_PAPER_INSTALLATION.manifestDigest,capabilities:[]}).ok,true);db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(g.id);db.prepare('DELETE FROM paper_dispatch_definitions WHERE id=?').run(saved.result.definitionId);db.prepare("UPDATE verification_receipts SET operation_hash='bad' WHERE token_hash=?").run(createHash('sha256').update(saved.receipt).digest('hex'));
 const url=base+'/consents/'+saved.result.consentId;assert.equal((await call(g,'GET',url)).statusCode,404);const revoked=await call(g,'POST',url+'/revoke',{});assert.equal(revoked.statusCode,200,revoked.body);assert.equal(revoked.json().status,'revoked');assert.equal((await call(g,'POST',url+'/revoke',{})).json().replayed,true);assert.equal(db.prepare('SELECT count(*) n FROM paper_dispatch_definitions WHERE id=?').get(saved.result.definitionId).n,0);
});
test('exhausted grant attempts do not block separate historical reads or emergency revoke',async()=>{
 const f=await owner(),saved=await grant(f),url=base+'/consents/'+saved.result.consentId;
 // Four invalid stage calls plus a fifth exhaust this route's separate proof bucket.
 for(let i=0;i<4;i++)assert.equal((await call(f,'POST',base+'/reviews',{...input(f),ownerId:f.id})).statusCode,400);
 assert.equal((await call(f,'POST',base+'/reviews',input(f))).statusCode,429);assert.equal((await call(f,'GET',url)).statusCode,200);const revoke=await call(f,'POST',url+'/revoke',{});assert.equal(revoke.statusCode,200,revoke.body);
});

test('actual desktop session/controller preserves explicit runtime consent apply with real JWT and TOTP',async()=>{
 const {SessionClient}=await import('../../core-ui/src/session.ts');const {TradingRuntimeController}=await import('../../core-ui/src/trading-runtime-controller.ts');
 const f=await owner(),user={id:f.id,email:f.id+'@example.invalid',username:f.id,role:'owner'},calls=[];
 const client=new SessionClient({live:async request=>{
  if(request.path==='/api/auth/login')return {status:200,body:{token:f.token,deviceToken:'d'.repeat(43),user}};
  if(request.path==='/api/auth/me')return {status:200,body:{user}};
  calls.push(request.method+' '+request.path);const r=await app.inject({method:request.method,url:request.path,headers:{host:'127.0.0.1:42521',origin:'http://127.0.0.1:42522',...request.headers},...(request.body===undefined?{}:{payload:request.body})});return {status:r.statusCode,body:r.json()};
 }});client.selectMode('live');await client.login(user.email,'Fixture login only');const controller=new TradingRuntimeController(client);
 try{
  const draft=input(f);await controller.stage(draft);assert.equal(controller.getSnapshot().phase,'review');assert.deepEqual(controller.getSnapshot().review.strategy,draft.strategy);
  await controller.startVerification();assert.equal(controller.getSnapshot().phase,'code');await controller.verify(f.otp(Date.now()));assert.equal(controller.getSnapshot().phase,'verified');
  assert.equal(db.prepare('SELECT count(*) n FROM paper_runtime_consents WHERE owner_id=?').get(f.id).n,0);assert.doesNotMatch(JSON.stringify(controller.getSnapshot()),/"receipt"\s*:|"challenge"\s*:|"code"\s*:/);
  await controller.apply();assert.equal(controller.getSnapshot().phase,'applied');assert.equal(controller.getSnapshot().consent.status,'granted');assert.equal(controller.getSnapshot().consent.botId,f.botId);assert.equal(controller.getSnapshot().consent.runtimeConnected,false);
  assert.equal(db.prepare('SELECT count(*) n FROM paper_runtime_consents WHERE owner_id=?').get(f.id).n,1);assert.equal(db.prepare('SELECT count(*) n FROM paper_bot_ticks WHERE bot_id=?').get(f.botId).n,0);
  assert.deepEqual(calls.map(s=>s.replace(/\/reviews\/[a-f0-9-]{36}/,'/reviews/:id')),['POST '+base+'/reviews','POST '+base+'/reviews/:id/challenge','POST '+base+'/reviews/:id/complete','POST '+base+'/reviews/:id/apply']);
 }finally{controller.close();client.cancel();}
});

test('actual committed-but-lost apply recovers exact consent after disposal; emergency revoke bypasses damaged journal and factor loss',async()=>{
 const {SessionClient}=await import('../../core-ui/src/session.ts');const {TradingRuntimeController}=await import('../../core-ui/src/trading-runtime-controller.ts');
 const f=await owner(),user={id:f.id,email:f.id+'@example.invalid',username:f.id,role:'owner'};let dropApply=true;
 const client=new SessionClient({live:async request=>{
  if(request.path==='/api/auth/login')return {status:200,body:{token:f.token,deviceToken:'d'.repeat(43),user}};
  if(request.path==='/api/auth/me')return {status:200,body:{user}};
  const r=await app.inject({method:request.method,url:request.path,headers:{host:'127.0.0.1:42521',origin:'http://127.0.0.1:42522',...request.headers},...(request.body===undefined?{}:{payload:request.body})});
  if(dropApply&&request.path.endsWith('/apply')){dropApply=false;assert.equal(r.statusCode,200,r.body);throw Error('Owned transport lost committed response');}return {status:r.statusCode,body:r.json()};
 }});client.selectMode('live');await client.login(user.email,'Fixture login only');let controller=new TradingRuntimeController(client);
 try{
  await controller.stage(input(f));const consentId=controller.getSnapshot().review.consentId;await controller.startVerification();await controller.verify(f.otp(Date.now()));await controller.apply();assert.equal(controller.getSnapshot().phase,'unknown');assert.equal(db.prepare('SELECT status FROM paper_runtime_consents WHERE id=?').get(consentId).status,'granted');
  controller.close();controller=new TradingRuntimeController(client);await controller.loadConsent(consentId);assert.equal(controller.getSnapshot().phase,'unknown');assert.equal(controller.getSnapshot().recoveryRead,true);assert.equal(controller.acknowledgeUnknown(),true);
  const definitionId=db.prepare('SELECT definition_id FROM paper_runtime_consents WHERE id=?').get(consentId).definition_id;db.prepare('DELETE FROM paper_dispatch_definitions WHERE id=?').run(definitionId);db.prepare('UPDATE verification_factors SET enabled=0 WHERE user_id=?').run(f.id);
  await controller.revoke(consentId);assert.equal(controller.getSnapshot().consent.status,'revoked');assert.equal(db.prepare('SELECT status FROM paper_runtime_consents WHERE id=?').get(consentId).status,'revoked');assert.equal(db.prepare('SELECT count(*) n FROM paper_dispatch_definitions WHERE id=?').get(definitionId).n,0);assert.equal(db.prepare('SELECT count(*) n FROM paper_bot_ticks WHERE bot_id=?').get(f.botId).n,0);
 }finally{controller.close();client.cancel();}
});
