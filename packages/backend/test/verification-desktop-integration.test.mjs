import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const dir=mkdtempSync(join(tmpdir(),'ap-verification-desktop-'));
process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {default:bcrypt}=await import('bcryptjs');const password='Fixture-Desktop-Password-729!';const passwordHash=await bcrypt.hash(password,4);
for(const id of ['desktop-login','desktop-recovery','desktop-cancel','desktop-enroll'])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,?,'user','active',1)").run(id,id+'@example.test',id,passwordHash);
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');
const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
const setup={};
for(const id of ['desktop-login','desktop-recovery','desktop-cancel']){
 const time=Date.now()-60000,b={userId:id,tokenVersion:1,sessionHash:'e'.repeat(64)};
 const pending=await beginEnrollment(b,time),active=await activateEnrollment(b,hotp(decodeSecret(pending.secret),BigInt(Math.floor(time/30000))),time);
 setup[id]={secret:pending.secret,recoveryCodes:active.recoveryCodes};
}
const {default:Fastify}=await import('fastify');
const {authRoutes}=await import('../src/api/routes/auth.ts');
const {registerAuthGate}=await import('../src/auth/auth-gate.ts');
const {verificationRoutes}=await import('../src/api/routes/verification.ts');
const app=Fastify();registerAuthGate(app);await app.register(authRoutes);await app.register(verificationRoutes);
const {createApplicationServer}=createRequire(import.meta.url)('../../core-ui/scripts/application-server.cjs');
const {SessionClient,createSameOriginTransport}=await import('../../core-ui/src/session.ts');
let bridge,origin;
await app.listen({host:'127.0.0.1',port:0});
try{
 bridge=createApplicationServer({channel:'candidate',upstreamPort:app.server.address().port});
 await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
 origin='http://127.0.0.1:'+bridge.address().port;
}catch(error){await app.close();closeDatabase();throw error;}
test.after(async()=>{await new Promise(resolve=>{bridge.close(resolve);bridge.closeAllConnections();});await app.close();closeDatabase();});
const code=id=>hotp(decodeSecret(setup[id].secret),BigInt(Math.floor(Date.now()/30000)));
function clientFixture(){
 const responses=[];
 const wire=createSameOriginTransport(origin,async(url,options)=>{
  assert.equal(new URL(url).origin,origin);
  const result=await fetch(url,{...options,headers:{...options.headers,Origin:origin}});
  responses.push({path:new URL(url).pathname,status:result.status,cookie:result.headers.get('set-cookie')});
  return result;
 });
 const client=new SessionClient({live:wire});client.selectMode('live');return {client,responses};
}
test('real desktop HTTP chain withholds cookie/private access until factor proof',async()=>{
 const {client,responses}=clientFixture();
 await client.login('desktop-login@example.test',password);
 assert.equal(client.getSnapshot().phase,'verifying');assert.equal(responses.length,1);assert.equal(responses[0].cookie,null);
 await assert.rejects(client.request({method:'GET',path:'/api/auth/me'}));assert.equal(responses.length,1);
 await client.completeVerification(password,code('desktop-login'));
 assert.equal(client.getSnapshot().phase,'authenticated');assert.equal(client.getSnapshot().user.id,'desktop-login');
 assert.deepEqual(responses.map(row=>row.path),['/api/auth/login','/api/auth/login','/api/auth/me']);
 assert.match(responses[1].cookie,/HttpOnly; SameSite=Strict/);
 const me=await client.request({method:'GET',path:'/api/auth/me'});assert.equal(me.status,200);
 assert.doesNotMatch(JSON.stringify(client.getSnapshot()),/Fixture-Desktop|token|nonce|challenge/);
 client.cancel();
});
test('real recovery chain clears remembered cookie, revokes actual sessions and does not call me',async()=>{
 const {generateToken,verifyRequestTokenAsync}=await import('../src/auth/jwt.ts');
 const old={headers:{authorization:'Bearer '+generateToken('desktop-recovery',2)}};
 assert.equal((await verifyRequestTokenAsync(old)).userId,'desktop-recovery');
 const {client,responses}=clientFixture();await client.login('desktop-recovery@example.test',password);await client.startRecovery(password);
 assert.equal(client.getSnapshot().verification.method,'recovery');assert.equal(responses[0].cookie,null);assert.equal(responses[1].cookie,null);
 await client.completeVerification(password,setup['desktop-recovery'].recoveryCodes[0]);
 assert.equal(client.getSnapshot().phase,'signed-out');assert.equal(client.getSnapshot().notice,'recovered');assert.equal(responses.length,3);assert.ok(responses.every(row=>row.path==='/api/auth/login'));
 assert.match(responses[2].cookie,/Max-Age=0/);
 await assert.rejects(verifyRequestTokenAsync(old),/invalidated/);
 assert.equal(db.prepare("SELECT enabled FROM verification_factors WHERE user_id='desktop-recovery'").get().enabled,0);
 await client.login('desktop-recovery@example.test',password);assert.equal(client.getSnapshot().phase,'authenticated');client.cancel();
});
test('cancel discards a real pending challenge and prevents any follow-up HTTP request',async()=>{
 const {client,responses}=clientFixture();await client.login('desktop-cancel@example.test',password);assert.equal(client.getSnapshot().phase,'verifying');
 client.cancel();await client.completeVerification(password,code('desktop-cancel'));assert.equal(responses.length,1);assert.equal(client.getSnapshot().phase,'signed-out');
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_challenges WHERE user_id='desktop-cancel' AND consumed_at IS NOT NULL").get().n,0);
});

test('real authenticated lifecycle through bridge preserves session on bad proof then revokes on activation',async()=>{
 const {client,responses}=clientFixture();await client.login('desktop-enroll@example.test',password);assert.equal(client.getSnapshot().phase,'authenticated');
 const path='/api/auth/verification';
 assert.deepEqual((await client.request({method:'GET',path})).body,{enabled:false});
 const denied=await client.request({method:'POST',path:path+'/enroll',body:{password:'wrong'}});
 assert.equal(denied.status,403);assert.equal(client.getSnapshot().phase,'authenticated');assert.deepEqual(denied.body,{code:'verification_refused'});
 const enrollment=await client.request({method:'POST',path:path+'/enroll',body:{password}});assert.equal(enrollment.status,200);assert.match(enrollment.body.secret,/^[A-Z2-7]{32}$/);
 const step=Math.floor(Date.now()/30000),key=decodeSecret(enrollment.body.secret);
 const validCodes=new Set([-1,0,1,2].map(offset=>hotp(key,BigInt(step+offset))));
 let wrongCode='000000';for(let i=0;validCodes.has(wrongCode);i++)wrongCode=String(i+1).padStart(6,'0');
 const refused=await client.request({method:'POST',path:path+'/confirm',body:{password,code:wrongCode}});
 assert.equal(refused.status,403);assert.equal(client.getSnapshot().phase,'authenticated');
 const otp=hotp(decodeSecret(enrollment.body.secret),BigInt(Math.floor(Date.now()/30000)));
 const activated=await client.request({method:'POST',path:path+'/confirm',body:{password,code:otp}});
 assert.equal(activated.status,200);assert.equal(activated.body.requiresSignIn,true);assert.equal(client.recoveryCodes().length,8);assert.equal(activated.body.recoveryCodes,undefined);
 assert.match(responses.at(-1).cookie,/Max-Age=0/);
 assert.equal(client.getSnapshot().phase,'recovery-codes');await assert.rejects(client.request({method:'GET',path}));
 client.finishRecoveryCodes();assert.equal(client.recoveryCodes().length,0);assert.equal(client.getSnapshot().phase,'signed-out');
});
