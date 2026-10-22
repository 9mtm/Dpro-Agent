import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {hotp,encodeSecret,decodeSecret,newTotpSecret,matchTotp} from '../src/auth/verification/totp.ts';
const dir=mkdtempSync(join(tmpdir(),'ap-verification-'));
process.env.DATABASE_PATH=join(dir,'test.db');
process.env.JWT_SECRET=randomBytes(64).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');
const db=getDatabase();await db.initialize();
const {issueChallenge,decideChallenge}=await import('../src/auth/verification/challenges.ts');
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('fixture','fixture@example.test','fixture','x','user','active',1)").run();
test.after(()=>closeDatabase());
const key=Buffer.from('12345678901234567890');
const binding={userId:'fixture',purpose:'login',sessionHash:'a'.repeat(64),operationHash:'b'.repeat(64),tokenVersion:1,factorVersion:1};
const now=1800000000000;
test('RFC 4226 and RFC 6238 SHA1 interoperability vectors',()=>{
 ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'].forEach((code,i)=>assert.equal(hotp(key,BigInt(i)),code));
 for(const [sec,code] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(hotp(key,BigInt(Math.floor(sec/30)),8),code);
});
test('secret roundtrip, strict code shape, window and replay counter',()=>{
 for(let i=0;i<20;i++){const value=newTotpSecret();assert.match(value,/^[A-Z2-7]{32}$/);assert.equal(encodeSecret(decodeSecret(value)),value);}
 const secret=encodeSecret(key),counter=Math.floor(now/30000),code=hotp(key,BigInt(counter));
 assert.equal(matchTotp(secret,code,now,-1),counter);
 assert.equal(matchTotp(secret,code,now,counter),null);
 assert.equal(matchTotp(secret,code,now+60000,-1),null);
 for(const offset of [-1,1])assert.equal(matchTotp(secret,hotp(key,BigInt(counter+offset)),now,-1),counter+offset);
 for(const invalid of [Number(code),' '+code,code+' ',null,'12345','abcdef'])assert.equal(matchTotp(secret,invalid,now,-1),null);
 assert.throws(()=>decodeSecret(secret.toLowerCase()));assert.throws(()=>hotp(key,-1n));assert.throws(()=>hotp(key,1n<<64n));
});
test('challenge context, expiry and stored verifier boundaries',async()=>{
 const issued=await issueChallenge(binding,now);
 assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);
 const row=db.prepare('SELECT * FROM verification_challenges WHERE token_hash=?').get(createHash('sha256').update(issued.token).digest('hex'));
 assert.ok(row);assert.ok(!JSON.stringify(row).includes(issued.token));
 for(const change of [{userId:'other'},{purpose:'recovery'},{sessionHash:'c'.repeat(64)},{operationHash:'d'.repeat(64)},{tokenVersion:2},{factorVersion:2}])assert.equal(await decideChallenge(issued.token,{...binding,...change},()=>{throw Error('must not evaluate mismatched proof');},now),false);
 assert.equal(await decideChallenge(issued.token,binding,()=>true,issued.expiresAt),false);
 assert.equal(await decideChallenge(issued.token,binding,()=>true,now),true);
 assert.equal(await decideChallenge(issued.token,binding,()=>true,now),false);
});
test('five failures lock the challenge including proof exceptions',async()=>{
 const {token}=await issueChallenge(binding,now);
 for(let i=0;i<5;i++)assert.equal(await decideChallenge(token,binding,()=>{throw Error('bad proof');},now),false);
 let invoked=false;assert.equal(await decideChallenge(token,binding,()=>{invoked=true;return true;},now),false);assert.equal(invoked,false);
});
test('concurrent successful decisions consume once',async()=>{
 const {token}=await issueChallenge(binding,now);
 const results=await Promise.all(Array.from({length:8},()=>decideChallenge(token,binding,()=>true,now)));
 assert.equal(results.filter(Boolean).length,1);
});
test('bounded pending challenges and invalid bindings',async()=>{
 for(let i=0;i<10;i++)await issueChallenge({...binding,purpose:'enroll'},now+1000000);
 await assert.rejects(issueChallenge(binding,now+1000000),/limit/);
 await assert.rejects(issueChallenge({...binding,purpose:'unknown'},now),/Invalid/);
 assert.equal(db.prepare("SELECT token_version FROM users WHERE id='fixture'").get().token_version,1);
});
const {beginEnrollment,consumeEnrollmentProof,activateEnrollment,verifyFactorChallenge,revokeFactorWithChallenge,factorRevocationOperation}=await import('../src/auth/verification/enrollment.ts');
const eb={userId:'fixture',sessionHash:'e'.repeat(64),tokenVersion:1};
const stableTestKey=randomBytes(32).toString('hex');
const enrollmentCode=(secret,time=now)=>hotp(decodeSecret(secret),BigInt(Math.floor(time/30000)));
test('pending enrollment refuses ephemeral encryption and stores only ciphertext',async()=>{
 delete process.env.ENCRYPTION_KEY;
 await assert.rejects(beginEnrollment(eb,now),/Persistent encryption/);
 process.env.ENCRYPTION_KEY=stableTestKey;
 const result=await beginEnrollment(eb,now);
 const row=db.prepare('SELECT * FROM verification_enrollment WHERE user_id=?').get(eb.userId);
 assert.ok(!JSON.stringify(row).includes(result.secret));
 assert.equal(await consumeEnrollmentProof({...eb,sessionHash:'f'.repeat(64)},enrollmentCode(result.secret),now),false);
 await assert.rejects(consumeEnrollmentProof({...eb,tokenVersion:2},enrollmentCode(result.secret),now),/context changed/);
 assert.equal(await consumeEnrollmentProof(eb,enrollmentCode(result.secret),result.expiresAt),false);
 const accepted=await Promise.all(Array.from({length:6},()=>consumeEnrollmentProof(eb,enrollmentCode(result.secret),now)));
 assert.equal(accepted.filter(Boolean).length,1);
 assert.equal(db.prepare('SELECT sealed_secret FROM verification_enrollment WHERE user_id=?').get(eb.userId).sealed_secret,'');
});
test('enrollment authentication rejects ciphertext tamper and identity substitution',async()=>{
 const first=await beginEnrollment(eb,now);
 const original=db.prepare('SELECT sealed_secret FROM verification_enrollment WHERE user_id=?').get(eb.userId).sealed_secret;
 const altered=(original[0]==='A'?'B':'A')+original.slice(1);
 db.prepare('UPDATE verification_enrollment SET sealed_secret=? WHERE user_id=?').run(altered,eb.userId);
 assert.equal(await consumeEnrollmentProof(eb,enrollmentCode(first.secret),now),false);
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('fixture2','fixture2@example.test','fixture2','x','user','active',1)").run();
 db.prepare('INSERT INTO verification_enrollment(user_id,session_hash,token_version,sealed_secret,expires_at) VALUES(?,?,?,?,?)').run('fixture2',eb.sessionHash,1,original,now+600000);
 assert.equal(await consumeEnrollmentProof({...eb,userId:'fixture2'},enrollmentCode(first.secret),now),false);
});
test('enrollment wrong-key refusal, attempt lockout and replacement',async()=>{
 const first=await beginEnrollment(eb,now);
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
 assert.equal(await consumeEnrollmentProof(eb,enrollmentCode(first.secret),now),false);
 process.env.ENCRYPTION_KEY=stableTestKey;
 for(let i=0;i<4;i++)assert.equal(await consumeEnrollmentProof(eb,'invalid',now),false);
 assert.equal(await consumeEnrollmentProof(eb,enrollmentCode(first.secret),now),false);
 const replacement=await beginEnrollment(eb,now);
 assert.notEqual(replacement.secret,first.secret);
 assert.equal(await consumeEnrollmentProof(eb,enrollmentCode(replacement.secret),now),true);
 assert.equal(db.prepare("SELECT token_version FROM users WHERE id='fixture'").get().token_version,1);
});

test('activation rolls back pending consumption and factor on recovery storage failure',async()=>{
 const setup=await beginEnrollment(eb,now);
 db.exec("CREATE TEMP TRIGGER fail_recovery BEFORE INSERT ON verification_recovery_codes BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");
 await assert.rejects(activateEnrollment(eb,enrollmentCode(setup.secret),now),/fixture storage failure/);
 assert.equal(db.prepare('SELECT * FROM verification_factors WHERE user_id=?').get(eb.userId),undefined);
 const pending=db.prepare('SELECT consumed_at,sealed_secret FROM verification_enrollment WHERE user_id=?').get(eb.userId);
 assert.equal(pending.consumed_at,null);assert.ok(pending.sealed_secret);
 db.exec('DROP TRIGGER fail_recovery');
});
let activeSecret='',activeRecovery=[];
test('activation atomically persists replay counter and recovery verifiers exactly once',async()=>{
 const setup=await beginEnrollment(eb,now);
 const results=await Promise.allSettled(Array.from({length:6},()=>activateEnrollment(eb,enrollmentCode(setup.secret),now)));
 const successes=results.filter(result=>result.status==='fulfilled'&&result.value).map(result=>result.value);assert.equal(successes.length,1);
 activeSecret=setup.secret;activeRecovery=successes[0].recoveryCodes;
 const result=successes[0],row=db.prepare('SELECT * FROM verification_factors WHERE user_id=?').get(eb.userId);
 assert.equal(row.enabled,1);assert.equal(row.version,1);assert.equal(row.last_counter,Math.floor(now/30000));
 assert.ok(!JSON.stringify(row).includes(setup.secret));
 assert.equal(result.recoveryCodes.length,8);assert.equal(new Set(result.recoveryCodes).size,8);
 const recovery=db.prepare('SELECT * FROM verification_recovery_codes WHERE user_id=?').all(eb.userId);
 assert.equal(recovery.length,8);
 for(const code of result.recoveryCodes){assert.match(code,/^[a-f0-9]{32}$/);assert.ok(!JSON.stringify(recovery).includes(code));}
 assert.equal(db.prepare('SELECT sealed_secret FROM verification_enrollment WHERE user_id=?').get(eb.userId).sealed_secret,'');
 await assert.rejects(beginEnrollment({...eb,tokenVersion:2},now),/already active/);
});
test('authoritative account revocation and inactive status reject pending activation',async()=>{
 const other={...eb,userId:'fixture2'};
 const setup=await beginEnrollment(other,now);
 db.prepare("UPDATE users SET token_version=2 WHERE id='fixture2'").run();
 await assert.rejects(activateEnrollment(other,enrollmentCode(setup.secret),now),/context changed/);
 db.prepare("UPDATE users SET token_version=1,status='inactive' WHERE id='fixture2'").run();
 await assert.rejects(activateEnrollment(other,enrollmentCode(setup.secret),now),/context changed/);
 assert.equal(db.prepare("SELECT * FROM verification_factors WHERE user_id='fixture2'").get(),undefined);
});

const gateBinding={...binding,tokenVersion:2,factorVersion:1};
test('factor counter and challenge consume together, concurrent distinct challenges accept once',async()=>{
 const time=now+2000000;
 const challenges=await Promise.all(Array.from({length:6},()=>issueChallenge(gateBinding,time)));
 const results=await Promise.all(challenges.map(({token})=>verifyFactorChallenge(token,gateBinding,enrollmentCode(activeSecret,time),'totp',time)));
 assert.equal(results.filter(Boolean).length,1);
 assert.equal(db.prepare('SELECT last_counter FROM verification_factors WHERE user_id=?').get(eb.userId).last_counter,Math.floor(time/30000));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_challenges WHERE consumed_at=?').get(time).n,1);
});
test('storage failure rolls back accepted TOTP counter and recovery consumption',async()=>{
 const time=now+3000000;
 const issued=await issueChallenge(gateBinding,time);
 const before=db.prepare('SELECT last_counter FROM verification_factors WHERE user_id=?').get(eb.userId).last_counter;
 db.exec("CREATE TEMP TRIGGER fail_challenge BEFORE UPDATE OF consumed_at ON verification_challenges WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture challenge failure'); END");
 await assert.rejects(verifyFactorChallenge(issued.token,gateBinding,enrollmentCode(activeSecret,time),'totp',time),/fixture challenge failure/);
 assert.equal(db.prepare('SELECT last_counter FROM verification_factors WHERE user_id=?').get(eb.userId).last_counter,before);
 const recoveryBinding={...gateBinding,purpose:'recovery'};
 const recovery=await issueChallenge(recoveryBinding,time);
 await assert.rejects(verifyFactorChallenge(recovery.token,recoveryBinding,activeRecovery[0],'recovery',time),/fixture challenge failure/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_recovery_codes WHERE consumed_at IS NOT NULL').get().n,0);
 db.exec('DROP TRIGGER fail_challenge');
 assert.equal(await verifyFactorChallenge(issued.token,gateBinding,enrollmentCode(activeSecret,time),'totp',time),true);
 assert.equal(await verifyFactorChallenge(recovery.token,recoveryBinding,activeRecovery[0],'recovery',time),true);
});
test('recovery codes are purpose-bound and single-use across fresh challenges',async()=>{
 const time=now+4000000;
 const ordinary=await issueChallenge(gateBinding,time);
 assert.equal(await verifyFactorChallenge(ordinary.token,gateBinding,activeRecovery[1],'recovery',time),false);
 const b={...gateBinding,purpose:'recovery'};
 const codes=await Promise.all([issueChallenge(b,time),issueChallenge(b,time)]);
 const result=await Promise.all(codes.map(({token})=>verifyFactorChallenge(token,b,activeRecovery[1],'recovery',time)));
 assert.equal(result.filter(Boolean).length,1);
 const wrongVersion={...b,factorVersion:2};
 const invalid=await issueChallenge(wrongVersion,time);
 assert.equal(await verifyFactorChallenge(invalid.token,wrongVersion,activeRecovery[2],'recovery',time),false);
});
test('per-factor throttle survives fresh challenge tokens and expires without bypass',async()=>{
 const time=now+5000000;
 // Reset prior failed attempts only by a successful legitimate proof.
 let issued=await issueChallenge(gateBinding,time);
 assert.equal(await verifyFactorChallenge(issued.token,gateBinding,enrollmentCode(activeSecret,time),'totp',time),true);
 for(let i=0;i<5;i++){
  issued=await issueChallenge(gateBinding,time);
  assert.equal(await verifyFactorChallenge(issued.token,gateBinding,'invalid','totp',time),false);
 }
 const stored=db.prepare('SELECT failed_attempts,locked_until FROM verification_factors WHERE user_id=?').get(eb.userId);
 assert.equal(stored.failed_attempts,5);assert.equal(stored.locked_until,time+300000);
 issued=await issueChallenge(gateBinding,time+30000);
 assert.equal(await verifyFactorChallenge(issued.token,gateBinding,enrollmentCode(activeSecret,time+30000),'totp',time+30000),false);
 issued=await issueChallenge(gateBinding,time+300000);
 assert.equal(await verifyFactorChallenge(issued.token,gateBinding,enrollmentCode(activeSecret,time+300000),'totp',time+300000),true);
 assert.equal(db.prepare('SELECT failed_attempts FROM verification_factors WHERE user_id=?').get(eb.userId).failed_attempts,0);
});

const {generateToken,verifyRequestTokenAsync}=await import('../src/auth/jwt.ts');
test('recovery revocation rolls back proof, factor and sessions on storage failure',async()=>{
 const time=now+6000000;
 const b={...gateBinding,purpose:'recovery',operationHash:factorRevocationOperation(eb.userId,1,'recovery')};
 const issued=await issueChallenge(b,time);
 db.exec("CREATE TEMP TRIGGER fail_session_revoke BEFORE UPDATE OF token_version ON users BEGIN SELECT RAISE(ABORT,'fixture session failure'); END");
 await assert.rejects(revokeFactorWithChallenge(issued.token,b,activeRecovery[2],'recovery',time),/fixture session failure/);
 assert.equal(db.prepare('SELECT enabled,version FROM verification_factors WHERE user_id=?').get(eb.userId).enabled,1);
 assert.equal(db.prepare('SELECT token_version FROM users WHERE id=?').get(eb.userId).token_version,2);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_recovery_codes WHERE consumed_at=?').get(time).n,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_challenges WHERE consumed_at=?').get(time).n,0);
 db.exec('DROP TRIGGER fail_session_revoke');
});
test('recovery revokes old bearer tokens, factor, pending setup and outstanding challenges atomically',async()=>{
 const time=now+7000000;
 const b={...gateBinding,purpose:'recovery',operationHash:factorRevocationOperation(eb.userId,1,'recovery')};
 const request={headers:{authorization:'Bearer '+generateToken(eb.userId,2)}};
 assert.equal((await verifyRequestTokenAsync(request)).userId,eb.userId);
 const outstanding=await issueChallenge(gateBinding,time);
 const issued=await issueChallenge(b,time);
 assert.equal(await revokeFactorWithChallenge(issued.token,{...b,operationHash:'f'.repeat(64)},activeRecovery[2],'recovery',time),false);
 assert.equal(await revokeFactorWithChallenge(issued.token,b,activeRecovery[2],'recovery',time),true);
 const factor=db.prepare('SELECT * FROM verification_factors WHERE user_id=?').get(eb.userId);
 assert.equal(factor.enabled,0);assert.equal(factor.version,2);assert.equal(factor.sealed_secret,'');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_recovery_codes WHERE user_id=?').get(eb.userId).n,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_enrollment WHERE user_id=?').get(eb.userId).n,0);
 await assert.rejects(verifyRequestTokenAsync(request),/invalidated/);
 await assert.rejects(verifyFactorChallenge(outstanding.token,gateBinding,enrollmentCode(activeSecret,time),'totp',time),/context changed/);
});
test('re-enrollment advances factor version and TOTP disable rejects unrelated operation purposes',async()=>{
 const time=now+8000000,b={...eb,tokenVersion:3};
 const setup=await beginEnrollment(b,time);
 const activated=await activateEnrollment(b,enrollmentCode(setup.secret,time),time);
 assert.equal(activated.factorVersion,3);
 const revoke={...gateBinding,tokenVersion:4,factorVersion:3,purpose:'disable',operationHash:factorRevocationOperation(b.userId,3,'totp')};
 const issued=await issueChallenge(revoke,time+30000);
 assert.equal(await revokeFactorWithChallenge(issued.token,{...revoke,purpose:'login'},enrollmentCode(setup.secret,time+30000),'totp',time+30000),false);
 assert.equal(await revokeFactorWithChallenge(issued.token,revoke,enrollmentCode(setup.secret,time+30000),'totp',time+30000),true);
 assert.equal(db.prepare('SELECT token_version FROM users WHERE id=?').get(b.userId).token_version,5);
 assert.equal(db.prepare('SELECT version FROM verification_factors WHERE user_id=?').get(b.userId).version,4);
});
test('activation invalidates actual pre-factor sessions and challenges, with complete failure rollback',async()=>{
 const time=now+9000000,id='activation-session';
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x','user','active',1)").run(id,id+'@example.test',id);
 const b={userId:id,sessionHash:'c'.repeat(64),tokenVersion:1};
 const request={headers:{authorization:'Bearer '+generateToken(id,1)}};
 assert.equal((await verifyRequestTokenAsync(request)).userId,id);
 const pending=await issueChallenge({...binding,userId:id,factorVersion:0},time);
 const setup=await beginEnrollment(b,time);
 assert.equal(await activateEnrollment(b,'invalid',time),null);
 assert.equal((await verifyRequestTokenAsync(request)).userId,id);
 db.exec("CREATE TEMP TRIGGER fail_activation_session BEFORE UPDATE OF token_version ON users BEGIN SELECT RAISE(ABORT,'fixture activation failure'); END");
 await assert.rejects(activateEnrollment(b,enrollmentCode(setup.secret,time),time),/fixture activation failure/);
 assert.equal((await verifyRequestTokenAsync(request)).userId,id);
 assert.equal(db.prepare('SELECT * FROM verification_factors WHERE user_id=?').get(id),undefined);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_recovery_codes WHERE user_id=?').get(id).n,0);
 assert.equal(db.prepare('SELECT consumed_at FROM verification_enrollment WHERE user_id=?').get(id).consumed_at,null);
 db.exec('DROP TRIGGER fail_activation_session');
 const activated=await activateEnrollment(b,enrollmentCode(setup.secret,time),time);
 assert.equal(activated.requiresSignIn,true);
 await assert.rejects(verifyRequestTokenAsync(request),/invalidated/);
 assert.equal(await decideChallenge(pending.token,{...binding,userId:id,factorVersion:0},()=>true,time),false);
 await assert.rejects(activateEnrollment(b,enrollmentCode(setup.secret,time),time),/context changed/);
});
