import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-verification-api-'));
process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {default:bcrypt}=await import('bcryptjs');const password='Fixture-Setup-Password-729!';const hash=await bcrypt.hash(password,4);
for(const id of ['human','other','guest'])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,?,?,'active',1)").run(id,id+'@example.test',id,hash,id==='guest'?'guest':'user');
const {generateToken}=await import('../src/auth/jwt.ts');
const {registerAuthGate}=await import('../src/auth/auth-gate.ts');
const {verificationRoutes}=await import('../src/api/routes/verification.ts');
const {default:Fastify}=await import('fastify');
const app=Fastify();registerAuthGate(app);await app.register(verificationRoutes);await app.ready();
// One retained bearer per fixture session; a newly minted token is a different session.
const sessions=new Map();
const headers=id=>{if(!sessions.has(id))sessions.set(id,generateToken(id,1));return {authorization:'Bearer '+sessions.get(id)};};
const send=(path,payload,id='human')=>app.inject({method:'POST',url:'/api/auth/verification/'+path,payload,headers:headers(id)});
test.after(async()=>{await app.close();closeDatabase();});
test('lifecycle endpoints require active human bearer and exact input',async()=>{
 assert.equal((await app.inject({url:'/api/auth/verification'})).statusCode,401);
 assert.equal((await app.inject({url:'/api/auth/verification',headers:headers('guest')})).statusCode,403);
 assert.equal((await send('enroll',{password,userId:'other'})).statusCode,400);
 assert.equal((await send('enroll?target=other',{password})).statusCode,400);
 assert.equal((await send('enroll',{password:'wrong'})).statusCode,403);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_enrollment').get().n,0);
 const status=await app.inject({url:'/api/auth/verification',headers:headers('human')});
 assert.deepEqual(status.json(),{enabled:false});assert.equal(status.headers['cache-control'],'no-store');
});
let setup;
test('fresh password stages encrypted setup scoped to bearer session and refuses another account proof',async()=>{
 const started=await send('enroll',{password});assert.equal(started.statusCode,200);setup=started.json();assert.match(setup.secret,/^[A-Z2-7]{32}$/);
 assert.equal(started.headers['cache-control'],'no-store');
 const wrong=await send('confirm',{password,code:'000000'},'other');assert.equal(wrong.statusCode,403);
 const {decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');const realCode=hotp(decodeSecret(setup.secret),BigInt(Math.floor(Date.now()/30000)));
 const otherSession=await app.inject({method:'POST',url:'/api/auth/verification/confirm',headers:{authorization:'Bearer '+generateToken('human',1)},payload:{password,code:realCode}});assert.equal(otherSession.statusCode,403);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_factors').get().n,0);
});
test('confirm invalidates session and returns recovery codes once',async()=>{
 const {decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');const code=hotp(decodeSecret(setup.secret),BigInt(Math.floor(Date.now()/30000)));
 const confirmed=await send('confirm',{password,code});assert.equal(confirmed.statusCode,200,confirmed.body);
 assert.equal(confirmed.json().requiresSignIn,true);assert.equal(confirmed.json().recoveryCodes.length,8);assert.equal(confirmed.json().token,undefined);
 assert.equal((await app.inject({url:'/api/auth/verification',headers:headers('human')})).statusCode,401);
 assert.equal((await send('confirm',{password,code})).statusCode,401);
 const current=await app.inject({url:'/api/auth/verification',headers:{authorization:'Bearer '+generateToken('human',2)}});
 assert.deepEqual(current.json(),{enabled:true});assert.ok(!current.body.includes(setup.secret));
});
test('staged plugin rejects agent context even with a valid human bearer',async()=>{
 const isolated=Fastify();isolated.addHook('onRequest',async request=>{request.actor={kind:'agent',userId:'other',role:'owner'};});
 await isolated.register(verificationRoutes);await isolated.ready();
 assert.equal((await isolated.inject({url:'/api/auth/verification',headers:headers('other')})).statusCode,401);await isolated.close();
});
test('disable requires fresh password plus unused TOTP and revokes the current bearer',async()=>{
 const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');
 const {decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
 const time=Date.now()-60000,b={userId:'other',sessionHash:'e'.repeat(64),tokenVersion:1};
 const pending=await beginEnrollment(b,time);
 await activateEnrollment(b,hotp(decodeSecret(pending.secret),BigInt(Math.floor(time/30000))),time);
 const h={authorization:'Bearer '+generateToken('other',2)};
 const payload={password,code:hotp(decodeSecret(pending.secret),BigInt(Math.floor(Date.now()/30000)))};
 const wrong=await app.inject({method:'POST',url:'/api/auth/verification/disable',headers:h,payload:{...payload,password:'wrong'}});assert.equal(wrong.statusCode,403);
 const result=await app.inject({method:'POST',url:'/api/auth/verification/disable',headers:h,payload});assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{requiresSignIn:true});
 assert.equal((await app.inject({url:'/api/auth/verification',headers:h})).statusCode,401);
 assert.equal(db.prepare("SELECT enabled FROM verification_factors WHERE user_id='other'").get().enabled,0);
});
