import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-verification-login-'));
process.env.DATABASE_PATH=join(dir,'test.db');
process.env.JWT_SECRET=randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');
const db=getDatabase();await db.initialize();
const {default:bcrypt}=await import('bcryptjs');
const password='Fixture-Private-Password-927!';
const hash=await bcrypt.hash(password,4);
for(const id of ['plain','factor','direct','recover','quota'])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,?,'user','active',1)").run(id,id+'@example.test',id,hash);
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');
const {decodeSecret,hotp}=await import('../src/auth/verification/totp.ts');
const code=secret=>hotp(decodeSecret(secret),BigInt(Math.floor(Date.now()/30000)));
const secrets={},recoveries={};
for(const id of ['factor','direct','recover','quota']){
 const binding={userId:id,sessionHash:'a'.repeat(64),tokenVersion:1},time=Date.now()-60000;
 const setup=await beginEnrollment(binding,time);
 const activated=await activateEnrollment(binding,hotp(decodeSecret(setup.secret),BigInt(Math.floor(time/30000))),time);
 secrets[id]=setup.secret;recoveries[id]=activated.recoveryCodes;
}
const {sqliteIdentityAuth}=await import('../src/repositories/identity-auth.ts');
const {default:Fastify}=await import('fastify');
const {authRoutes}=await import('../src/api/routes/auth.ts');
const app=Fastify();await app.register(authRoutes);await app.ready();
test.after(async()=>{await app.close();closeDatabase();});
const login=payload=>app.inject({method:'POST',url:'/api/auth/login',payload});
test('direct identity repository requires proof before issuing any factor-account JWT',async()=>{
 const challenge=await sqliteIdentityAuth.signIn('direct@example.test',password);
 assert.equal(challenge.status,'verification_required');assert.equal(challenge.token,undefined);assert.equal(challenge.user,undefined);
 const verification={challenge:challenge.challenge,nonce:challenge.nonce,code:code(secrets.direct)};
 const accepted=await sqliteIdentityAuth.signIn('direct@example.test',password,verification);
 assert.equal(accepted.status,'ok');assert.ok(accepted.token);
 assert.equal((await sqliteIdentityAuth.signIn('direct@example.test',password,verification)).status,'bad_password');
});
test('login route keeps existing non-factor behavior and refuses wrong password generically',async()=>{
 const plain=await login({email:'plain@example.test',password});
 assert.equal(plain.statusCode,200);assert.ok(plain.json().token);assert.ok(plain.json().deviceToken);
 const wrong=await login({email:'factor@example.test',password:'wrong'});
 assert.equal(wrong.statusCode,401);assert.equal(wrong.json().code,'invalid_credentials');
});
test('factor login returns token-free challenge, rejects malformed proofs, and completes once',async()=>{
 const first=await login({email:'factor@example.test',password});
 assert.equal(first.statusCode,200);
 const challenge=first.json();assert.equal(challenge.verificationRequired,true);
 for(const field of ['token','user','deviceToken'])assert.equal(challenge[field],undefined);
 const verification={challenge:challenge.challenge,nonce:challenge.nonce,code:code(secrets.factor)};
 const wrong=await login({email:'factor@example.test',password,verification:{...verification,code:'invalid'}});
 assert.equal(wrong.statusCode,401);
 const accepted=await login({email:'factor@example.test',password,verification});
 assert.equal(accepted.statusCode,200);assert.ok(accepted.json().token);assert.ok(accepted.json().deviceToken);
 const replay=await login({email:'factor@example.test',password,verification});assert.equal(replay.statusCode,401);
});

test('public recovery requires password plus purpose-bound recovery proof and issues no session',async()=>{
 const {generateToken,verifyRequestTokenAsync}=await import('../src/auth/jwt.ts');
 const oldRequest={headers:{authorization:'Bearer '+generateToken('recover',2)}};
 assert.equal((await verifyRequestTokenAsync(oldRequest)).userId,'recover');
 const wrongPassword=await login({email:'recover@example.test',password:'wrong',recovery:true});assert.equal(wrongPassword.statusCode,401);
 const first=await login({email:'recover@example.test',password,recovery:true});assert.equal(first.statusCode,200);
 const challenge=first.json();assert.equal(challenge.verificationMethod,'recovery');assert.equal(challenge.token,undefined);
 const verification={challenge:challenge.challenge,nonce:challenge.nonce,code:recoveries.recover[0]};
 assert.equal((await login({email:'recover@example.test',password,verification})).statusCode,401);
 assert.equal((await login({email:'recover@example.test',password,recovery:true,verification:{...verification,code:'0'.repeat(32)}})).statusCode,401);
 const recovered=await login({email:'recover@example.test',password,recovery:true,verification});
 assert.equal(recovered.statusCode,200,recovered.body);assert.deepEqual(recovered.json(),{requiresSignIn:true,recovered:true});
 for(const field of ['token','user','deviceToken'])assert.equal(recovered.json()[field],undefined);
 await assert.rejects(verifyRequestTokenAsync(oldRequest),/invalidated/);
 assert.equal((await login({email:'recover@example.test',password,recovery:true,verification})).statusCode,401);
 const signedIn=await login({email:'recover@example.test',password});assert.equal(signedIn.statusCode,200);assert.ok(signedIn.json().token);
});
test('pending challenge quota returns bounded retry response without a session or internal error',async()=>{
 for(let i=0;i<10;i++){
  const result=await login({email:'quota@example.test',password});assert.equal(result.statusCode,200);assert.equal(result.json().verificationRequired,true);assert.equal(result.json().token,undefined);
 }
 const limited=await login({email:'quota@example.test',password});assert.equal(limited.statusCode,429);assert.equal(limited.json().code,'verification_limited');assert.equal(limited.headers['retry-after'],'300');assert.equal(limited.json().token,undefined);
});
