import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import bcrypt from 'bcryptjs';
import {createHash} from 'node:crypto';
import {verifyRequestTokenAsync,AuthTokenError} from '../../auth/jwt.js';
import {sql,one} from '../../repositories/sql-steps.js';
import {loginThrottle} from '../../repositories/index.js';
import {beginEnrollment,activateEnrollment,revokeFactorWithChallenge,factorRevocationOperation} from '../../auth/verification/enrollment.js';
import {issueChallenge} from '../../auth/verification/challenges.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
import {isSystemAccount} from '../../auth/default-accounts.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const invalid={error:'Verification refused',code:'verification_refused'};
type Account={id:string;email:string;password_hash:string;token_version:number;email_verified:number};
async function account(request:FastifyRequest){
 if(request.actor&&request.actor.kind!=='user')throw new AuthTokenError('Unauthorized: Human account required');
 const verified=await verifyRequestTokenAsync(request);
 if(!['owner','admin','user'].includes(verified.user.role)||isSystemAccount(verified.userId))throw new AuthTokenError('Unauthorized: Human account required');
 if(request.actor&&request.actor.userId!==verified.userId)throw new AuthTokenError('Unauthorized: Account mismatch');
 const row=await sql().read(one<Account>('SELECT id,email,password_hash,token_version,email_verified FROM users WHERE id=?',verified.userId));
 if(!row||!Number(row.email_verified))throw new AuthTokenError('Unauthorized: Account unavailable');
 const bearer=request.headers.authorization!.slice(7);
 return {row,binding:{userId:row.id,tokenVersion:Number(row.token_version),sessionHash:hash(bearer)}};
}
async function freshPassword(request:FastifyRequest,reply:FastifyReply,row:Account,password:string){
 const source=request.ip||'unknown';
 const throttle=await loginThrottle.check(row.email,source);
 if(throttle.throttled){reply.header('Retry-After',String(throttle.retryAfterSeconds)).code(429).send({error:'Too many attempts',code:'rate_limited'});return false;}
 if(!(await bcrypt.compare(password,row.password_hash))){
  await loginThrottle.failed(row.email,source,request.headers['user-agent']);
  reply.code(403).send(invalid);return false;
 }
 return true;
}
const schema=(extra:Record<string,unknown>={},required:string[]=[])=>({body:{type:'object',additionalProperties:false,required:['password',...required],properties:{password:{type:'string',minLength:1,maxLength:1024},...extra}}});
/** Account verification lifecycle; bearer and fresh-password proof are checked independently. */
export async function verificationRoutes(app:FastifyInstance){
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.get('/api/auth/verification',async(request,reply)=>{
  try{
   if(Object.keys(request.query as object).length)return reply.code(400).send(invalid);
   const {row}=await account(request);
   const factor=await sql().read(one<{enabled:number}>('SELECT enabled FROM verification_factors WHERE user_id=?',row.id));
   return {enabled:Number(factor?.enabled??0)===1};
  }catch(error){return reply.code(error instanceof AuthTokenError?401:503).send(invalid);}
 });
 for(const action of ['enroll','confirm','disable'] as const){
  const extra=action==='enroll'?{}:{code:{type:'string',pattern:'^[0-9]{6}$'}};
  app.post('/api/auth/verification/'+action,{config:{rateLimit:changePasswordRateLimit},preValidation:async(request,reply)=>{
   const allowed=action==='enroll'?['password']:['password','code'];
   if(Object.keys(request.query as object).length||!request.body||typeof request.body!=='object'||Array.isArray(request.body)||Object.keys(request.body as object).some(key=>!allowed.includes(key)))return reply.code(400).send(invalid);
  },schema:schema(extra,action==='enroll'?[]:['code'])},async(request,reply)=>{
   try{
    const {row,binding}=await account(request),body=request.body as {password:string;code?:string};
    if(!(await freshPassword(request,reply,row,body.password)))return;
    if(action==='enroll')return await beginEnrollment(binding);
    if(action==='confirm'){
     const activated=await activateEnrollment(binding,body.code);
     return activated??reply.code(403).send(invalid);
    }
    const factor=await sql().read(one<{enabled:number;version:number}>('SELECT enabled,version FROM verification_factors WHERE user_id=?',row.id));
    if(!factor||Number(factor.enabled)!==1)return reply.code(403).send(invalid);
    const context={...binding,purpose:'disable' as const,factorVersion:Number(factor.version),operationHash:factorRevocationOperation(row.id,Number(factor.version),'totp')};
    const issued=await issueChallenge(context);
    if(!(await revokeFactorWithChallenge(issued.token,context,body.code,'totp')))return reply.code(403).send(invalid);
    return {requiresSignIn:true};
   }catch(error){return reply.code(error instanceof AuthTokenError?401:409).send(invalid);}
  });
 }
}
