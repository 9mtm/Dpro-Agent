import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-proof-execution-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('proof-owner','proof@example.test','proof','x','owner','active',1)").run();db.prepare("INSERT INTO agents_config(id,name,provider,model) VALUES('proof-agent','proof-agent','claude','fixture')").run();
const tools=await import('../src/tools/index.ts');const grants=await import('../src/tools/grants.ts');const approvals=await import('../src/tools/approvals.ts');
let executions=0;
const tool={name:'fixture_proof_action',description:'Harmless fixture',extensionId:'fixture-proof',requiresApproval:true,input_schema:{type:'object',properties:{value:{type:'string'}}},async execute(){executions++;return {content:[{type:'text',text:'fixture completed'}]};}};
tools.registerExtensionTool(tool);
const available=tools.createToolsRegistry({workspaceDir:dir}).listRegistered();
await grants.setAgentGrants('proof-agent',{grants:[tool.name]},'proof-owner',available);
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
const initial=Date.now()-60000,setupBinding={userId:'proof-owner',sessionHash:'a'.repeat(64),tokenVersion:1},setup=await beginEnrollment(setupBinding,initial);
const otp=time=>hotp(decodeSecret(setup.secret),BigInt(Math.floor(time/30000)));
await activateEnrollment(setupBinding,otp(initial),initial);
const {issueApprovalProofChallenge,completeApprovalProofChallenge}=await import('../src/auth/verification/approval-proof.ts');
const context={userId:'proof-owner',sessionHash:'b'.repeat(64),tokenVersion:2,factorVersion:1};
async function pending(){const result=await approvals.requestApproval(tool,{value:'fixture'},{userId:'proof-owner',agentId:'proof-agent',sessionId:'s1',workspaceDir:dir},'other');const id=result.details.approvalId;const detail=await approvals.getApprovalDetail(id);return {id,hash:detail.paramsHash};}
async function proof(request,time=Date.now()){const challenge=await issueApprovalProofChallenge(context,request.id,request.hash,time);return completeApprovalProofChallenge(challenge.token,context,request.id,request.hash,otp(time),time);}
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {approvalsRoutes}=await import('../src/api/routes/approvals.ts');const {generateToken}=await import('../src/auth/jwt.ts');
const app=Fastify();registerAuthGate(app);await app.register(approvalsRoutes);await app.ready();
test.after(async()=>{await app.close();tools.unregisterExtensionTool(tool.name);closeDatabase();});
test('enabled owner cannot omit proof through the executor; denial stays available',async()=>{
 const request=await pending(),before=executions;
 await assert.rejects(approvals.approveAndRun(request.id,'proof-owner',request.hash),error=>error instanceof approvals.ApprovalVerificationRequiredError&&error.status===403);
 assert.equal(executions,before);assert.equal((await approvals.getApproval(request.id)).status,'pending');
 const rejected=await approvals.denyApproval(request.id,'proof-owner');assert.equal(rejected.status,'denied');assert.equal(executions,before);
});
test('no-factor owner retains approval; live role/status changes block direct executor claims',async()=>{
 for(const [id,role,status] of [['plain-owner','owner','active'],['plain-admin','admin','active'],['inactive-owner','owner','suspended']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,?,1)").run(id,id+'@example.test',id,role,status);
 for(const actor of ['plain-admin','inactive-owner','missing-owner']){const request=await pending(),before=executions;await assert.rejects(approvals.approveAndRun(request.id,actor,request.hash));assert.equal(executions,before);assert.equal((await approvals.getApproval(request.id)).status,'pending');}
 const request=await pending(),before=executions,result=await approvals.approveAndRun(request.id,'plain-owner',request.hash);assert.equal(result.record.status,'executed');assert.equal(executions,before+1);
});
test('actual executor consumes receipt with claim and executes harmless tool once under concurrent requests',async()=>{
 const request=await pending(),receipt=await proof(request),before=executions;assert.ok(receipt);
 const results=await Promise.allSettled(Array.from({length:6},()=>approvals.approveAndRun(request.id,'proof-owner',request.hash,{receipt:receipt.receipt,context})));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(executions,before+1);assert.equal((await approvals.getApproval(request.id)).status,'executed');
});
test('forged receipt or mismatched actor cannot claim or execute pending call',async()=>{
 const request=await pending(),before=executions;
 await assert.rejects(approvals.approveAndRun(request.id,'proof-owner',request.hash,{receipt:'x'.repeat(43),context}));
 await assert.rejects(approvals.approveAndRun(request.id,'other-owner',request.hash,{receipt:'x'.repeat(43),context}),/verification refused/);
 assert.equal(executions,before);assert.equal((await approvals.getApproval(request.id)).status,'pending');
});
test('valid proof cannot bypass grants revoked before actual execution',async()=>{
 const request=await pending(),time=Date.now()+30000,receipt=await proof(request,time);assert.ok(receipt);const before=executions;
 await grants.setAgentGrants('proof-agent',{grants:[]},'proof-owner',available);
 const result=await approvals.approveAndRun(request.id,'proof-owner',request.hash,{receipt:receipt.receipt,context});
 assert.equal(executions,before);assert.ok(result.result.error);assert.equal(result.record.status,'failed');
});

test('owner HTTP proof is server-bound and cross-session receipt replay cannot execute',async()=>{
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('http-owner','http-owner@example.test','http-owner','x','owner','active',1)").run();
 db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES('http-admin','http-admin@example.test','http-admin','x','admin','active',1)").run();
 const time=Date.now()-60000,b={userId:'http-owner',sessionHash:'e'.repeat(64),tokenVersion:1},setup2=await beginEnrollment(b,time);
 const codeAt=now=>hotp(decodeSecret(setup2.secret),BigInt(Math.floor(now/30000)));
 await activateEnrollment(b,codeAt(time),time);await grants.setAgentGrants('proof-agent',{grants:[tool.name]},'proof-owner',available);
 const request=await pending(),headers={authorization:'Bearer '+generateToken('http-owner',2)},url='/api/approvals/'+request.id;
 const send=(path,payload,h=headers)=>app.inject({method:'POST',url:url+path,payload,headers:h});
 assert.equal((await send('/verification',{paramsHash:request.hash},{authorization:'Bearer '+generateToken('http-admin',1)})).statusCode,403);
 assert.equal((await send('/verification',{paramsHash:request.hash,userId:'http-owner'})).statusCode,400);
 const issued=await send('/verification',{paramsHash:request.hash});assert.equal(issued.statusCode,200,issued.body);assert.equal(issued.headers['cache-control'],'no-store');assert.equal(issued.json().token,undefined);
 const before=executions;
 const detailResponse=await app.inject({method:'GET',url,headers});assert.equal(detailResponse.statusCode,200);assert.equal(detailResponse.json().approval.verificationRequired,true);
 const omitted=await send('/approve',{paramsHash:request.hash});assert.equal(omitted.statusCode,403);assert.deepEqual(omitted.json(),{code:'verification_required'});assert.equal((await approvals.getApproval(request.id)).status,'pending');assert.equal(executions,before);
 const verified=await send('/verification/complete',{paramsHash:request.hash,challenge:issued.json().challenge,code:codeAt(Date.now())});assert.equal(verified.statusCode,200,verified.body);assert.ok(verified.json().receipt);assert.equal(executions,before);
 const proofBody={paramsHash:request.hash,verificationReceipt:verified.json().receipt};
 const otherSession={authorization:'Bearer '+generateToken('http-owner',2)};
 assert.equal((await send('/approve',proofBody,otherSession)).statusCode,403);assert.equal(executions,before);assert.equal((await approvals.getApproval(request.id)).status,'pending');
 const result=await send('/approve',proofBody);assert.equal(result.statusCode,200,result.body);assert.equal(executions,before+1);
 const replay=await send('/approve',proofBody);assert.equal(replay.statusCode,409);assert.equal(executions,before+1);
});
