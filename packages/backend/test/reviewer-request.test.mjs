import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-reviewer-request-'));
process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {generateToken,AuthTokenError}=await import('../src/auth/jwt.ts');
const {reviewerRequestIdentity,ReviewerIdentityError}=await import('../src/auth/verification/reviewer-request.ts');
const {default:Fastify}=await import('fastify');
const {registerAuthGate}=await import('../src/auth/auth-gate.ts');
for(const [id,role] of [['owner','owner'],['human','user'],['admin','admin'],['guest','guest'],['no-factor','user'],['unverified','user']]){
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',?)").run(id,id+'@example.test',id,role,id==='unverified'?0:1);
 if(id!=='no-factor')db.prepare('INSERT INTO verification_factors(user_id,sealed_secret,version,enabled,last_counter,activated_at) VALUES(?,?,1,1,-1,?)').run(id,'unused-test-cipher',Date.now());
}
const app=Fastify();registerAuthGate(app);
// The diagnostic is fixture-only; production never serializes this private identity context.
app.get('/api/reviewer-identity-fixture',{config:{access:'user'}},async(request,reply)=>{
 try{const result=await reviewerRequestIdentity(request);return {id:result.context.userId,role:result.actor.role,session:result.context.sessionHash,factor:result.context.factorVersion};}
 catch(e){return reply.code(e instanceof AuthTokenError?401:e instanceof ReviewerIdentityError?403:503).send({refused:true});}
});await app.ready();
test.after(async()=>{await app.close();closeDatabase();});
const request=(token,extra={})=>({headers:{authorization:'Bearer '+token},...extra});
test('real central-gate requests admit current factor-enabled human roles only',async()=>{
 for(const id of ['owner','human','admin']){const token=generateToken(id),response=await app.inject({url:'/api/reviewer-identity-fixture',headers:request(token).headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().id,id);assert.equal(response.json().session,createHash('sha256').update(token).digest('hex'));assert.equal(response.json().factor,1);}
 for(const id of ['guest','no-factor','unverified'])assert.equal((await app.inject({url:'/api/reviewer-identity-fixture',headers:request(generateToken(id)).headers})).statusCode,403);
 assert.equal((await app.inject({url:'/api/reviewer-identity-fixture'})).statusCode,401);
});
test('independent bearer validation refuses forged cached gate identity and stale sessions',async()=>{
 const token=generateToken('human');const forged={actor:{kind:'user',userId:'human',role:'user'},authUser:{id:'human',role:'user',status:'active'}};
 await assert.rejects(reviewerRequestIdentity(request('forged',forged)),AuthTokenError);
 await assert.rejects(reviewerRequestIdentity({...forged,headers:{}}),AuthTokenError);
 db.prepare("UPDATE users SET token_version=2 WHERE id='human'").run();await assert.rejects(reviewerRequestIdentity(request(token,forged)),AuthTokenError);
 const current=await reviewerRequestIdentity(request(generateToken('human',2)));assert.equal(current.context.tokenVersion,2);
});
test('nonhuman, mismatched, elevated and channel-tagged actor contexts cannot become reviewers',async()=>{
 const token=generateToken('human',2);
 for(const actor of [{kind:'agent',userId:'human',role:'user'},{kind:'service',userId:'human',role:'user'},{kind:'system',role:'owner'},{kind:'user',userId:'owner',role:'owner'},{kind:'user',userId:'human',role:'owner'},{kind:'user',userId:'human',role:'user',agentId:'agent'},{kind:'user',userId:'human',role:'user',channel:'outside'}])await assert.rejects(reviewerRequestIdentity(request(token,{actor})),ReviewerIdentityError);
});
test('owner controls require a live owner; body identity/proof fields never influence context',async()=>{
 await assert.rejects(reviewerRequestIdentity(request(generateToken('admin')),true),ReviewerIdentityError);
 const result=await reviewerRequestIdentity(request(generateToken('owner'),{body:{userId:'admin',tokenVersion:99,factorVersion:99,sessionHash:'x',verified:true}}),true);
 assert.equal(result.actor.userId,'owner');assert.equal(result.context.factorVersion,1);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.context)&&Object.isFrozen(result.actor));
});
test('fresh same-account sessions remain distinct and live factor/status/email changes refuse context',async()=>{
 const a=generateToken('admin'),b=generateToken('admin');assert.notEqual((await reviewerRequestIdentity(request(a))).context.sessionHash,(await reviewerRequestIdentity(request(b))).context.sessionHash);
 db.prepare("UPDATE verification_factors SET version=2 WHERE user_id='admin'").run();assert.equal((await reviewerRequestIdentity(request(a))).context.factorVersion,2);
 db.prepare("UPDATE verification_factors SET enabled=0 WHERE user_id='admin'").run();await assert.rejects(reviewerRequestIdentity(request(a)),ReviewerIdentityError);
 db.prepare("UPDATE users SET status='inactive' WHERE id='owner'").run();await assert.rejects(reviewerRequestIdentity(request(generateToken('owner'))),AuthTokenError);
});
