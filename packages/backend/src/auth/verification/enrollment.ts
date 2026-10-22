import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {sql,one,run,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import {newTotpSecret,matchTotp} from './totp.js';
import {decideChallengeStep,type VerificationBinding} from './challenges.js';
export type EnrollmentBinding={userId:string;sessionHash:string;tokenVersion:number};
function validate(b:EnrollmentBinding,now:number){
 if(!b||typeof b.userId!=='string'||!b.userId||b.userId.length>200||!/^[a-f0-9]{64}$/.test(b.sessionHash)||!Number.isSafeInteger(b.tokenVersion)||b.tokenVersion<1||!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-600000)throw Error('Invalid enrollment binding');
}
function key(){
 const value=process.env.ENCRYPTION_KEY;
 if(!value||!/^[a-fA-F0-9]{64}$/.test(value))throw Error('Persistent encryption configuration required');
 return Buffer.from(value,'hex');
}
function aad(b:EnrollmentBinding,purpose='verification-enrollment-v1'){return Buffer.from(JSON.stringify([purpose,b.userId,b.sessionHash,b.tokenVersion]));}
function seal(secret:string,b:EnrollmentBinding,purpose?:string){
 const master=key();try{
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(aad(b,purpose));
  const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');
 }finally{master.fill(0);}
}
function unseal(value:string,b:EnrollmentBinding,purpose?:string){
 const master=key();try{
  if(!/^[A-Za-z0-9_-]{80}$/.test(value))throw Error('Invalid enrollment envelope');
  const bytes=Buffer.from(value,'base64url'),cipher=createDecipheriv('aes-256-gcm',master,bytes.subarray(0,12));
  cipher.setAAD(aad(b,purpose));cipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');
 }finally{master.fill(0);}
}
/** Internal setup primitive; callers must first authenticate and reverify the human. */
export async function beginEnrollment(b:EnrollmentBinding,now=Date.now()){
 validate(b,now);const secret=newTotpSecret(),sealed=seal(secret,b),expiresAt=now+600000;
 await sql().tx(function*(){
  yield* lockName('verification-enrollment:'+b.userId);
  yield* requireEligibleAccount(b);
  const active=yield* one('SELECT user_id FROM verification_factors WHERE user_id=? AND enabled=1',b.userId);
  if(active)throw Error('Verification factor already active');
  yield* run(`INSERT INTO verification_enrollment(user_id,session_hash,token_version,sealed_secret,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET session_hash=excluded.session_hash,token_version=excluded.token_version,sealed_secret=excluded.sealed_secret,expires_at=excluded.expires_at,attempts=0,consumed_at=NULL`,b.userId,b.sessionHash,b.tokenVersion,sealed,expiresAt);
 });
 return {secret,expiresAt};
}
/** Rechecks the authoritative account under a row lock, not only a captured JWT version. */
function* requireEligibleAccount(b:EnrollmentBinding):Step<void>{
 const d=yield* dialect();
 const user=yield* one<{status:string;email_verified:number;token_version:number}>(`SELECT status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,b.userId);
 if(!user||user.status!=='active'||!Number(user.email_verified)||Number(user.token_version)!==b.tokenVersion)throw Error('Account verification context changed');
}
function* enrollmentProof(b:EnrollmentBinding,code:unknown,now:number,onProof?:(secret:string,counter:number)=>Step<void>):Step<boolean>{
 yield* lockName('verification-enrollment:'+b.userId);
 yield* requireEligibleAccount(b);
 const d=yield* dialect();
 const row=yield* one<{session_hash:string;token_version:number;sealed_secret:string;expires_at:number;attempts:number;consumed_at:number|null}>(`SELECT * FROM verification_enrollment WHERE user_id=?${forUpdate(d)}`,b.userId);
 if(!row||row.session_hash!==b.sessionHash||Number(row.token_version)!==b.tokenVersion||row.consumed_at!==null||Number(row.expires_at)<=now||Number(row.attempts)>=5)return false;
 let secret='',counter:number|null=null;
 try{secret=unseal(row.sealed_secret,b);counter=matchTotp(secret,code,now,-1);}catch{counter=null;}
 if(counter===null){yield* run('UPDATE verification_enrollment SET attempts=attempts+1 WHERE user_id=? AND consumed_at IS NULL AND attempts<5',b.userId);return false;}
 if(onProof)yield* onProof(secret,counter);
 return (yield* run('UPDATE verification_enrollment SET consumed_at=?,sealed_secret=? WHERE user_id=? AND consumed_at IS NULL AND attempts<5',now,'',b.userId)).changes===1;
}
/** Proves pending setup once. Does not enable a factor or issue a login token. */
export async function consumeEnrollmentProof(b:EnrollmentBinding,code:unknown,now=Date.now()):Promise<boolean>{
 validate(b,now);return sql().tx(()=>enrollmentProof(b,code,now));
}
/** Transactional activation. Callers must first authenticate and verify a fresh account password. */
export async function activateEnrollment(b:EnrollmentBinding,code:unknown,now=Date.now()):Promise<{recoveryCodes:string[];factorVersion:number;requiresSignIn:true}|null>{
 validate(b,now);
 const recoveryCodes=Array.from({length:8},()=>randomBytes(16).toString('hex'));
 let factorVersion=0;
 const accepted=await sql().tx(()=>enrollmentProof(b,code,now,function*(secret,counter){
  const previous=yield* one<{version:number;enabled:number}>('SELECT version,enabled FROM verification_factors WHERE user_id=?',b.userId);
  if(previous&&Number(previous.enabled)===1)throw Error('Verification factor already active');
  factorVersion=Number(previous?.version??0)+1;
  if(!Number.isSafeInteger(factorVersion)||factorVersion<1)throw Error('Invalid factor version');
  const factorBinding={userId:b.userId,sessionHash:'0'.repeat(64),tokenVersion:factorVersion};
  const sealed=seal(secret,factorBinding,'verification-active-factor-v1');
  yield* run(`INSERT INTO verification_factors(user_id,version,enabled,sealed_secret,last_counter,activated_at) VALUES(?,?,1,?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,enabled=1,sealed_secret=excluded.sealed_secret,last_counter=excluded.last_counter,activated_at=excluded.activated_at`,b.userId,factorVersion,sealed,counter,now);
  yield* run('DELETE FROM verification_recovery_codes WHERE user_id=?',b.userId);
  for(const recoveryCode of recoveryCodes){
   const hash=createHash('sha256').update(JSON.stringify(['verification-recovery-v1',b.userId,factorVersion,recoveryCode])).digest('hex');
   yield* run('INSERT INTO verification_recovery_codes(user_id,factor_version,code_hash) VALUES(?,?,?)',b.userId,factorVersion,hash);
  }
  if(!Number.isSafeInteger(b.tokenVersion+1))throw Error('Invalid session version');
  const sessions=yield* run('UPDATE users SET token_version=token_version+1 WHERE id=? AND token_version=?',b.userId,b.tokenVersion);
  if(sessions.changes!==1)throw Error('Activation session conflict');
  yield* run('UPDATE verification_challenges SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL',now,b.userId);
 }));
 return accepted?{recoveryCodes,factorVersion,requiresSignIn:true}:null;
}

type FactorRow={version:number;enabled:number;sealed_secret:string;last_counter:number;failed_attempts:number;locked_until:number};
/** Internal proof gate. Recovery has a separate purpose so it cannot approve ordinary actions. */
export function* factorChallengeStep(token:unknown,b:VerificationBinding,code:unknown,mode:'totp'|'recovery',now:number):Step<boolean>{
 validate(b,now);
 if(!['totp','recovery'].includes(mode)||b.purpose==='enroll'||(mode==='recovery'&&b.purpose!=='recovery'))return false;
 yield* lockName('verification-enrollment:'+b.userId);
 yield* requireEligibleAccount(b);
 return yield* decideChallengeStep(token,b,function*(){
   const d=yield* dialect();
   const factor=yield* one<FactorRow>(`SELECT * FROM verification_factors WHERE user_id=?${forUpdate(d)}`,b.userId);
   if(!factor||Number(factor.enabled)!==1||Number(factor.version)!==b.factorVersion||Number(factor.locked_until)>now)return false;
   let accepted=false;
   if(mode==='totp'){
    let counter:number|null=null;
    try{counter=matchTotp(unseal(factor.sealed_secret,{userId:b.userId,sessionHash:'0'.repeat(64),tokenVersion:b.factorVersion},'verification-active-factor-v1'),code,now,Number(factor.last_counter));}catch{counter=null;}
    if(counter!==null){
     accepted=(yield* run('UPDATE verification_factors SET last_counter=? WHERE user_id=? AND version=? AND enabled=1 AND last_counter<?',counter,b.userId,b.factorVersion,counter)).changes===1;
    }
   }else if(typeof code==='string'&&/^[a-f0-9]{32}$/.test(code)){
    const hash=createHash('sha256').update(JSON.stringify(['verification-recovery-v1',b.userId,b.factorVersion,code])).digest('hex');
    accepted=(yield* run('UPDATE verification_recovery_codes SET consumed_at=? WHERE user_id=? AND factor_version=? AND code_hash=? AND consumed_at IS NULL',now,b.userId,b.factorVersion,hash)).changes===1;
   }
   if(accepted){yield* run('UPDATE verification_factors SET failed_attempts=0,locked_until=0 WHERE user_id=?',b.userId);return true;}
   const failures=Number(factor.locked_until)>0&&Number(factor.locked_until)<=now?1:Math.min(Number(factor.failed_attempts)+1,5);
   yield* run('UPDATE verification_factors SET failed_attempts=?,locked_until=? WHERE user_id=?',failures,failures>=5?now+300000:0,b.userId);
   return false;
  },now);
}

export async function verifyFactorChallenge(token:unknown,b:VerificationBinding,code:unknown,mode:'totp'|'recovery'='totp',now=Date.now()):Promise<boolean>{
 return sql().tx(()=>factorChallengeStep(token,b,code,mode,now));
}
/** Exact operation fingerprint to derive on the server before issuing a revoke challenge. */
export function factorRevocationOperation(userId:string,version:number,mode:'totp'|'recovery'):string{
 return createHash('sha256').update(JSON.stringify(['verification-revoke-v1',userId,version,mode])).digest('hex');
}
/** Internal only: recovery challenge issuance also requires a fresh verified password. */
export function* revokeFactorStep(token:unknown,b:VerificationBinding,code:unknown,mode:'totp'|'recovery',now:number):Step<boolean>{
 validate(b,now);
 if(!['totp','recovery'].includes(mode)||b.purpose!==(mode==='recovery'?'recovery':'disable')||b.operationHash!==factorRevocationOperation(b.userId,b.factorVersion,mode))return false;
 if(!(yield* factorChallengeStep(token,b,code,mode,now)))return false;
  if(!Number.isSafeInteger(b.factorVersion+1)||!Number.isSafeInteger(b.tokenVersion+1))throw Error('Invalid verification version');
  const changed=yield* run('UPDATE verification_factors SET enabled=0,version=version+1,sealed_secret=?,last_counter=-1,failed_attempts=0,locked_until=0 WHERE user_id=? AND version=? AND enabled=1','',b.userId,b.factorVersion);
  if(changed.changes!==1)throw Error('Factor revocation conflict');
  const session=yield* run('UPDATE users SET token_version=token_version+1 WHERE id=? AND token_version=?',b.userId,b.tokenVersion);
  if(session.changes!==1)throw Error('Session revocation conflict');
  yield* run('DELETE FROM verification_recovery_codes WHERE user_id=?',b.userId);
  yield* run('DELETE FROM verification_enrollment WHERE user_id=?',b.userId);
  yield* run('UPDATE verification_challenges SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL',now,b.userId);
  return true;
}
export async function revokeFactorWithChallenge(token:unknown,b:VerificationBinding,code:unknown,mode:'totp'|'recovery'='totp',now=Date.now()):Promise<boolean>{
 return sql().tx(()=>revokeFactorStep(token,b,code,mode,now));
}
