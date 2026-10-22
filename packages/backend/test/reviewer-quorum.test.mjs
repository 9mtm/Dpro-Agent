// Policy/ballot rows below are seeded fixture records, not proof of a human vote-issuance flow.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-quorum-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const [id,role] of [['q-owner','owner'],['q-a','user'],['q-b','admin'],['q-c','user'],['q-outsider','admin']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',1)").run(id,id+'@example.test',id,role);
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
const initial=Date.now()-60000;
for(const userId of ['q-a','q-b','q-c','q-outsider']){const b={userId,sessionHash:'a'.repeat(64),tokenVersion:1},setup=await beginEnrollment(b,initial);await activateEnrollment(b,hotp(decodeSecret(setup.secret),BigInt(Math.floor(initial/30000))),initial);}
db.prepare("INSERT INTO agents_config(id,name,provider,model) VALUES('q-agent','Quorum fixture','claude','fixture')").run();
const tools=await import('../src/tools/index.ts'),grants=await import('../src/tools/grants.ts'),approvals=await import('../src/tools/approvals.ts');
const {quorumRequestHash,quorumPolicyHash,ReviewerQuorumError}=await import('../src/auth/verification/reviewer-quorum.ts');const {parseReviewerDraft}=await import('../src/auth/verification/reviewer-policy.ts');
let executions=0;const tool={name:'fixture_quorum_action',description:'Local harmless fixture',extensionId:'fixture-quorum',requiresApproval:true,input_schema:{type:'object',properties:{text:{type:'string'}}},async execute(){executions++;return {content:[{type:'text',text:'Harmless quorum fixture completed'}]};}};tools.registerExtensionTool(tool);
const available=tools.createToolsRegistry({workspaceDir:dir}).listRegistered();await grants.setAgentGrants('q-agent',{grants:[tool.name]},'q-owner',available);
const {default:Fastify}=await import('fastify');const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {approvalsRoutes}=await import('../src/api/routes/approvals.ts');const {generateToken}=await import('../src/auth/jwt.ts');const app=Fastify();registerAuthGate(app);await app.register(approvalsRoutes);await app.ready();
test.after(async()=>{await app.close();tools.unregisterExtensionTool(tool.name);closeDatabase();});
test.beforeEach(()=>{db.prepare("UPDATE human_reviewer_policies SET status='revoked'").run();});
async function pending(userId='q-owner'){const result=await approvals.requestApproval(tool,{text:'fixture'},{userId,agentId:'q-agent',sessionId:'q-session',workspaceDir:dir},'other');const id=result.details.approvalId,detail=await approvals.getApprovalDetail(id);return {id,hash:detail.paramsHash};}
function seedPolicy(overrides={}){const id=randomUUID(),at=Date.now()-1000,policy=parseReviewerDraft({name:'Seeded quorum rule',scope:{agentIds:['q-agent'],toolNames:[tool.name]},reviewerIds:['q-a','q-b','q-c'],requiredVotes:2,allowInitiatorVote:false,expiresAt:Date.now()+3600000,...overrides},at);db.prepare("INSERT INTO human_reviewer_policies(id,version,status,policy_json,approved_by,approved_at) VALUES(?,1,'active',?,'q-owner',?)").run(id,JSON.stringify(policy),at);return {id,version:1,policy};}
function seedVote(policy,request,userId,decision='approve',overrides={}){const row=db.prepare('SELECT * FROM tool_approvals WHERE id=?').get(request.id),person=db.prepare('SELECT token_version FROM users WHERE id=?').get(userId),factor=db.prepare('SELECT version FROM verification_factors WHERE user_id=?').get(userId);const record={policy_id:policy.id,policy_version:policy.version,approval_id:request.id,user_id:userId,actor_kind:'user',decision,receipt_hash:'f'.repeat(64),proof_session_hash:'e'.repeat(64),request_hash:quorumRequestHash(row),policy_hash:quorumPolicyHash(policy.policy),token_version:person.token_version,factor_version:factor.version,created_at:Date.now()-100,expires_at:Math.min(Date.now()+300000,policy.policy.expiresAt),...overrides};db.prepare('INSERT INTO human_reviewer_votes('+Object.keys(record).join(',')+') VALUES('+Object.keys(record).map(()=>'?').join(',')+')').run(...Object.values(record));}
const required=code=>error=>error instanceof ReviewerQuorumError&&error.code===code;
test('seeded active rule blocks actual owner claim without distinct eligible votes and leaves pending',async()=>{
 const policy=seedPolicy(),request=await pending(),before=executions;
 await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));seedVote(policy,request,'q-a');
 assert.throws(()=>seedVote(policy,request,'q-a'),/UNIQUE constraint/);await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));
 assert.throws(()=>seedVote(policy,request,'q-b','approve',{actor_kind:'agent'}),/CHECK constraint/);seedVote(policy,request,'q-outsider');await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));assert.equal((await approvals.getApproval(request.id)).status,'pending');assert.equal(executions,before);
});
test('current independent fixture ballots permit actual harmless execution once under concurrent claims',async()=>{
 const policy=seedPolicy(),request=await pending(),before=executions;seedVote(policy,request,'q-a');seedVote(policy,request,'q-b');
 const outcomes=await Promise.allSettled(Array.from({length:8},()=>approvals.approveAndRun(request.id,'q-owner',request.hash)));assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(executions,before+1);assert.equal((await approvals.getApproval(request.id)).status,'executed');
});
test('initiating account is excluded and matching human veto blocks execution while owner can deny safely',async()=>{
 const policy=seedPolicy(),request=await pending('q-a'),before=executions;seedVote(policy,request,'q-a');seedVote(policy,request,'q-b');await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));
 seedVote(policy,request,'q-c','deny');await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_denied'));assert.equal((await approvals.denyApproval(request.id,'q-owner')).status,'denied');assert.equal(executions,before);
});
test('revoked reviewer, changed factor/session versions and expired ballots cannot satisfy quorum',async()=>{
 const policy=seedPolicy(),request=await pending();seedVote(policy,request,'q-a');seedVote(policy,request,'q-b');
 for(const update of ["UPDATE users SET token_version=token_version+1 WHERE id='q-b'","UPDATE verification_factors SET version=version+1 WHERE user_id='q-b'","UPDATE users SET status='suspended' WHERE id='q-b'"]){const person=db.prepare("SELECT * FROM users WHERE id='q-b'").get(),factor=db.prepare("SELECT * FROM verification_factors WHERE user_id='q-b'").get();db.exec(update);await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));db.prepare("UPDATE users SET status=?,token_version=? WHERE id='q-b'").run(person.status,person.token_version);db.prepare("UPDATE verification_factors SET version=? WHERE user_id='q-b'").run(factor.version);}
 db.prepare("UPDATE human_reviewer_votes SET created_at=?,expires_at=? WHERE policy_id=? AND user_id='q-b'").run(Date.now()-2000,Date.now()-1000,policy.id);await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));
});
test('changed target, policy generation or exact policy content cannot reuse fixture votes',async()=>{
 const policy=seedPolicy(),request=await pending();seedVote(policy,request,'q-a');seedVote(policy,request,'q-b');
 db.prepare('UPDATE tool_approvals SET origin=? WHERE id=?').run('{"changed":true}',request.id);await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));db.prepare('UPDATE tool_approvals SET origin=NULL WHERE id=?').run(request.id);
 db.prepare('UPDATE human_reviewer_policies SET version=2 WHERE id=?').run(policy.id);await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));db.prepare('UPDATE human_reviewer_policies SET version=1,policy_json=? WHERE id=?').run(JSON.stringify({...policy.policy,name:'Changed rule'}),policy.id);await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));
});
test('every overlapping rule must pass and expired required policy fails closed',async()=>{
 const first=seedPolicy(),second=seedPolicy(),request=await pending();seedVote(first,request,'q-a');seedVote(first,request,'q-b');await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_quorum_required'));
 const expired={...second.policy,expiresAt:Date.now()-500};db.prepare('UPDATE human_reviewer_policies SET approved_at=?,policy_json=? WHERE id=?').run(Date.now()-10000,JSON.stringify(expired),second.id);await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash),required('reviewer_policy_unavailable'));
});
test('HTTP missing quorum has a reviewed refusal, while unscoped request keeps existing behavior',async()=>{
 seedPolicy();const request=await pending(),before=executions,response=await app.inject({method:'POST',url:'/api/approvals/'+request.id+'/approve',headers:{authorization:'Bearer '+generateToken('q-owner',1)},payload:{paramsHash:request.hash}});assert.equal(response.statusCode,403);assert.deepEqual(response.json(),{code:'reviewer_quorum_required'});assert.equal(executions,before);
 db.prepare("UPDATE human_reviewer_policies SET policy_json=? WHERE status='active'").run(JSON.stringify({...parseReviewerDraft({name:'Other tool',scope:{agentIds:['q-agent'],toolNames:['other_tool']},reviewerIds:['q-a','q-b','q-c'],requiredVotes:2,allowInitiatorVote:false,expiresAt:Date.now()+3600000}),name:'Other tool'}));const result=await approvals.approveAndRun(request.id,'q-owner',request.hash);assert.equal(result.record.status,'executed');assert.equal(executions,before+1);
});

test('satisfied fixture quorum cannot bypass an agent grant revoked before execution',async()=>{
 const policy=seedPolicy(),request=await pending(),before=executions;seedVote(policy,request,'q-a');seedVote(policy,request,'q-b');await grants.setAgentGrants('q-agent',{grants:[]},'q-owner',available);
 const result=await approvals.approveAndRun(request.id,'q-owner',request.hash);assert.equal(result.record.status,'failed');assert.ok(result.result.error);assert.equal(executions,before);await grants.setAgentGrants('q-agent',{grants:[tool.name]},'q-owner',available);
});
test('owner action proof cannot bypass quorum and is not consumed by the quorum refusal',async()=>{
 const policy=seedPolicy(),request=await pending(),before=executions,time=Date.now(),b={userId:'q-owner',sessionHash:'d'.repeat(64),tokenVersion:1},setup=await beginEnrollment(b,time-60000);
 await activateEnrollment(b,hotp(decodeSecret(setup.secret),BigInt(Math.floor((time-60000)/30000))),time-60000);
 const context={userId:'q-owner',sessionHash:'e'.repeat(64),tokenVersion:2,factorVersion:1};const {issueApprovalProofChallenge,completeApprovalProofChallenge}=await import('../src/auth/verification/approval-proof.ts');
 const challenge=await issueApprovalProofChallenge(context,request.id,request.hash),receipt=await completeApprovalProofChallenge(challenge.token,context,request.id,request.hash,hotp(decodeSecret(setup.secret),BigInt(Math.floor(Date.now()/30000))));assert.ok(receipt);
 await assert.rejects(approvals.approveAndRun(request.id,'q-owner',request.hash,{receipt:receipt.receipt,context}),required('reviewer_quorum_required'));assert.equal(executions,before);assert.equal((await approvals.getApproval(request.id)).status,'pending');
 seedVote(policy,request,'q-a');seedVote(policy,request,'q-b');const result=await approvals.approveAndRun(request.id,'q-owner',request.hash,{receipt:receipt.receipt,context});assert.equal(result.record.status,'executed');assert.equal(executions,before+1);
});
