import {createHash,randomBytes} from 'node:crypto';
import {sql,one,run,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
export class VerificationChallengeLimitError extends Error {}
const PURPOSES=['enroll','login','reverify','recovery','disable','rotate_recovery'] as const;
export type VerificationPurpose=typeof PURPOSES[number];
/** Derived by server-side identity/policy code, never copied from a request body. */
export type VerificationBinding={userId:string;purpose:VerificationPurpose;sessionHash:string;operationHash:string;tokenVersion:number;factorVersion:number};
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
function validate(binding:VerificationBinding,now:number){
 if(!binding||typeof binding.userId!=='string'||!binding.userId||binding.userId.length>200||!PURPOSES.includes(binding.purpose)||!/^([a-f0-9]{64})$/.test(binding.sessionHash)||!/^([a-f0-9]{64})$/.test(binding.operationHash)||!Number.isSafeInteger(binding.tokenVersion)||binding.tokenVersion<1||!Number.isSafeInteger(binding.factorVersion)||binding.factorVersion<0||!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-300000)throw Error('Invalid verification binding');
}
/** Stores only a verifier for a random 256-bit challenge, not a password or bearer session. */
export async function issueChallenge(binding:VerificationBinding,now=Date.now()){
 validate(binding,now);const token=randomBytes(32).toString('base64url'),expiresAt=now+300000;
 await sql().tx(function*(){
  yield* lockName('verification-challenges:'+binding.userId);
  const pending=yield* one<{n:number}>('SELECT COUNT(*) AS n FROM verification_challenges WHERE user_id=? AND consumed_at IS NULL AND attempts<5 AND expires_at>?',binding.userId,now);
  if(Number(pending?.n??0)>=10)throw new VerificationChallengeLimitError('Verification challenge limit reached');
  yield* run('INSERT INTO verification_challenges(token_hash,user_id,purpose,session_hash,operation_hash,token_version,factor_version,expires_at) VALUES(?,?,?,?,?,?,?,?)',digest(token),binding.userId,binding.purpose,binding.sessionHash,binding.operationHash,binding.tokenVersion,binding.factorVersion,expiresAt);
 });
 return {token,expiresAt};
}
type Row={user_id:string;purpose:VerificationPurpose;session_hash:string;operation_hash:string;token_version:number;factor_version:number;expires_at:number;attempts:number;consumed_at:number|null};
/** Internal composition only: storage failures propagate to roll back every proof mutation. */
export function* decideChallengeStep(token:unknown,binding:VerificationBinding,verify:()=>Step<boolean>,now:number):Step<boolean>{
 validate(binding,now);
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return false;
 const d=yield* dialect();
 const row=yield* one<Row>(`SELECT * FROM verification_challenges WHERE token_hash=?${forUpdate(d)}`,digest(token));
 if(!row||row.consumed_at!==null||Number(row.attempts)>=5||Number(row.expires_at)<=now||row.user_id!==binding.userId||row.purpose!==binding.purpose||row.session_hash!==binding.sessionHash||row.operation_hash!==binding.operationHash||Number(row.token_version)!==binding.tokenVersion||Number(row.factor_version)!==binding.factorVersion)return false;
 const accepted=yield* verify();
 if(!accepted){yield* run('UPDATE verification_challenges SET attempts=attempts+1 WHERE token_hash=? AND consumed_at IS NULL AND attempts<5',digest(token));return false;}
 const consumed=yield* run('UPDATE verification_challenges SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND attempts<5 AND expires_at>?',now,digest(token),now);
 if(consumed.changes!==1)throw Error('Verification consumption conflict');
 return true;
}
/** Trusted synchronous proof only; never accepts a proof result from an HTTP request. */
export async function decideChallenge(token:unknown,binding:VerificationBinding,verify:()=>boolean,now=Date.now()):Promise<boolean>{
 return sql().tx(()=>decideChallengeStep(token,binding,function*(){try{return verify()===true;}catch{return false;}},now));
}
