// Real authenticator proofs and internal protected policy/vote producers; no seeded ballot rows.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID,createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ap-human-votes-'));process.chdir(dir);process.env.DATABASE_PATH=join(dir,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
const {saveReviewerDraft}=await import('../src/auth/verification/reviewer-policy.ts');const {reviewerDraftProofTarget,issueReviewerDraftChallenge,completeReviewerDraftChallenge}=await import('../src/auth/verification/reviewer-policy-proof.ts');const {activateReviewerPolicy}=await import('../src/auth/verification/reviewer-policy-state.ts');
const {reviewerVoteTarget,issueReviewerVoteChallenge,completeReviewerVoteChallenge,castReviewerVote}=await import('../src/auth/verification/reviewer-votes.ts');const {issueApprovalProofChallenge,completeApprovalProofChallenge}=await import('../src/auth/verification/approval-proof.ts');
const tools=await import('../src/tools/index.ts'),grants=await import('../src/tools/grants.ts'),approvals=await import('../src/tools/approvals.ts');
let executions=0,serial=0;const tool={name:'fixture_verified_vote',description:'Harmless verified-vote fixture',extensionId:'fixture-votes',requiresApproval:true,input_schema:{type:'object',properties:{text:{type:'string'}}},async execute(){executions++;return {content:[{type:'text',text:'Verified human quorum completed once'}]};}};tools.registerExtensionTool(tool);db.prepare("INSERT INTO agents_config(id,name,provider,model) VALUES('vote-agent','Vote fixture','claude','fixture')").run();const available=tools.createToolsRegistry({workspaceDir:dir}).listRegistered();
test.after(()=>{tools.unregisterExtensionTool(tool.name);closeDatabase();});test.beforeEach(()=>db.prepare("UPDATE human_reviewer_policies SET status='revoked'").run());
const sha=v=>createHash('sha256').update(v).digest('hex');const otp=(person,time=Date.now())=>hotp(decodeSecret(person.secret),BigInt(Math.floor(time/30000)));
const refOf=operation=>{const {kind,policyVersion,...ref}=operation;return ref;};
async function fixture(initiator='owner'){
 const prefix='v'+(++serial),people={};
 for(const [name,role] of [['owner','owner'],['a','user'],['b','admin'],['c','user'],['outsider','admin']]){const id=prefix+'-'+name;db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x',?,'active',1)").run(id,id+'@example.test',id,role);const initial=Date.now()-60000,b={userId:id,sessionHash:sha(id+'setup'),tokenVersion:1},setup=await beginEnrollment(b,initial);await activateEnrollment(b,hotp(decodeSecret(setup.secret),BigInt(Math.floor(initial/30000))),initial);people[name]={id,secret:setup.secret,actor:{kind:'user',role,userId:id},context:{userId:id,sessionHash:sha(id+'session'),tokenVersion:2,factorVersion:1}};}
 const owner=people.owner,time=Date.now(),policyId=randomUUID(),policyInput={name:'Verified review rule',scope:{agentIds:['vote-agent'],toolNames:[tool.name]},reviewerIds:[people.a.id,people.b.id,people.c.id],requiredVotes:2,allowInitiatorVote:false,expiresAt:time+3600000};
 await saveReviewerDraft({actor:owner.actor,tokenVersion:2},policyId,0,policyInput,time);const target=await reviewerDraftProofTarget(owner.context,owner.actor,policyId,1,time),issued=await issueReviewerDraftChallenge(owner.context,owner.actor,policyId,1,target.paramsHash,time),proof=await completeReviewerDraftChallenge(issued.token,owner.context,owner.actor,policyId,1,target.paramsHash,otp(owner,time),time);assert.ok(proof);const policy=await activateReviewerPolicy(proof.receipt,owner.context,owner.actor,policyId,1,target.paramsHash,time);
 await grants.setAgentGrants('vote-agent',{grants:[tool.name]},owner.id,available);const request=await approvals.requestApproval(tool,{text:'Local verified-vote fixture'},{userId:people[initiator].id,agentId:'vote-agent',sessionId:'vote-session',workspaceDir:dir},'other'),id=request.details.approvalId,detail=await approvals.getApprovalDetail(id);
 return {people,policy,policyInput,request:{id,hash:detail.paramsHash}};
}
async function voteProof(f,name,decision='approve',codeTime=Date.now()){
 const person=f.people[name],operation=await reviewerVoteTarget(person.context,person.actor,f.policy.id,f.policy.version,f.request.id,f.request.hash,decision),ref=refOf(operation),issued=await issueReviewerVoteChallenge(person.context,person.actor,ref),proof=await completeReviewerVoteChallenge(issued.token,person.context,person.actor,ref,otp(person,codeTime));assert.ok(proof);return {person,ref,receipt:proof.receipt};
}
const cast=proof=>castReviewerVote(proof.receipt,proof.person.context,proof.person.actor,proof.ref);
async function ownerProof(f){const p=f.people.owner,issued=await issueApprovalProofChallenge(p.context,f.request.id,f.request.hash),proof=await completeApprovalProofChallenge(issued.token,p.context,f.request.id,f.request.hash,otp(p,Date.now()+30000));assert.ok(proof);return {receipt:proof.receipt,context:p.context};}
test('real policy proof and two distinct authenticator-proved votes unlock actual tool once, never on voting alone',async()=>{
 const f=await fixture(),before=executions,a=await voteProof(f,'a'),b=await voteProof(f,'b');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);await cast(a);assert.equal(executions,before);const owner=await ownerProof(f);
 await assert.rejects(approvals.approveAndRun(f.request.id,f.people.owner.id,f.request.hash,owner),/reviewer_quorum_required/);await cast(b);assert.equal(executions,before);assert.equal((await approvals.getApproval(f.request.id)).status,'pending');
 const result=await approvals.approveAndRun(f.request.id,f.people.owner.id,f.request.hash,owner);assert.equal(result.record.status,'executed');assert.equal(executions,before+1);await assert.rejects(approvals.approveAndRun(f.request.id,f.people.owner.id,f.request.hash,owner));assert.equal(executions,before+1);
});
test('same-proof retries are idempotent under concurrency; each human still counts once and conflicting vote is refused',async()=>{
 const f=await fixture(),a=await voteProof(f,'a'),results=await Promise.all(Array.from({length:8},()=>cast(a)));assert.equal(results.filter(r=>!r.idempotent).length,1);assert.equal(results.filter(r=>r.idempotent).length,7);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_vote_events WHERE approval_id=?').get(f.request.id).n,1);
 const deny=await voteProof(f,'a','deny',Date.now()+30000);await assert.rejects(cast(deny),/conflict/);assert.equal(db.prepare('SELECT decision FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).decision,'approve');
});
test('outsider admin, initiator and explicit agent/service actors cannot obtain human vote proof',async()=>{
 const f=await fixture('a');for(const name of ['a','outsider']){const p=f.people[name];await assert.rejects(reviewerVoteTarget(p.context,p.actor,f.policy.id,1,f.request.id,f.request.hash,'approve'),/forbidden/);}
 const p=f.people.b;for(const kind of ['agent','service','system'])await assert.rejects(reviewerVoteTarget(p.context,{...p.actor,kind},f.policy.id,1,f.request.id,f.request.hash,'approve'),/forbidden/);
});
test('wrong session, expired/forged proof and decision change cannot create a vote',async()=>{
 const f=await fixture(),a=await voteProof(f,'a'),p=a.person;await assert.rejects(castReviewerVote(a.receipt,{...p.context,sessionHash:sha('different')},p.actor,a.ref),/proof_refused/);await assert.rejects(castReviewerVote(a.receipt,p.context,p.actor,a.ref,Date.now()+120001),/proof_refused/);await assert.rejects(castReviewerVote('x'.repeat(43),p.context,p.actor,a.ref),/proof_refused/);await assert.rejects(castReviewerVote(a.receipt,p.context,p.actor,{...a.ref,decision:'deny'}),/proof_refused/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);await cast(a);
});
test('changed request metadata and live account/factor revocation refuse pending proofs before recording',async()=>{
 const f=await fixture(),a=await voteProof(f,'a');db.prepare('UPDATE tool_approvals SET origin=? WHERE id=?').run('{"changed":true}',f.request.id);await assert.rejects(cast(a),/changed/);db.prepare('UPDATE tool_approvals SET origin=NULL WHERE id=?').run(f.request.id);
 db.prepare('UPDATE verification_factors SET version=version+1 WHERE user_id=?').run(a.person.id);await assert.rejects(cast(a),/forbidden/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);
});
test('vote/history storage failure rolls back receipt and vote; explicit retry records once',async()=>{
 const f=await fixture(),a=await voteProof(f,'a');db.exec("CREATE TEMP TRIGGER fail_vote_event BEFORE INSERT ON human_reviewer_vote_events BEGIN SELECT RAISE(ABORT,'fixture vote history failure'); END");await assert.rejects(cast(a),/fixture vote history failure/);db.exec('DROP TRIGGER fail_vote_event');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);assert.equal((await cast(a)).idempotent,false);assert.equal((await cast(a)).idempotent,true);
});
test('proved veto defeats enough positive votes; recording decisions never runs the tool',async()=>{
 const f=await fixture(),before=executions;for(const [name,decision] of [['c','deny'],['a','approve'],['b','approve']])await cast(await voteProof(f,name,decision));assert.equal(executions,before);const proof=await ownerProof(f);await assert.rejects(approvals.approveAndRun(f.request.id,f.people.owner.id,f.request.hash,proof),/reviewer_denied/);assert.equal((await approvals.denyApproval(f.request.id,f.people.owner.id)).status,'denied');assert.equal(executions,before);
});
test('fresh same-decision proof renews account generation in one human slot with append-only history',async()=>{
 const f=await fixture(),a=await voteProof(f,'a');await cast(a);db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(a.person.id);a.person.context={...a.person.context,tokenVersion:3,sessionHash:sha(a.person.id+'new-session')};const renewed=await voteProof(f,'a','approve',Date.now()+30000);const result=await cast(renewed);assert.equal(result.revision,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_vote_events WHERE approval_id=?').get(f.request.id).n,2);assert.equal((await cast(renewed)).idempotent,true);await assert.rejects(cast(a),/proof_refused/);
});
test('account revocation after real votes removes quorum at the actual execution sink',async()=>{
 const f=await fixture(),before=executions;await cast(await voteProof(f,'a'));await cast(await voteProof(f,'b'));const proof=await ownerProof(f);db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(f.people.b.id);await assert.rejects(approvals.approveAndRun(f.request.id,f.people.owner.id,f.request.hash,proof),/reviewer_quorum_required/);assert.equal(executions,before);
});
test('missing/extra reviewed fields cannot silently target current policy or request',async()=>{
 const f=await fixture(),a=await voteProof(f,'a');for(const ref of [{...a.ref,verified:true},{...a.ref,requestHash:undefined},{...a.ref,policyHash:undefined}]){await assert.rejects(issueReviewerVoteChallenge(a.person.context,a.person.actor,ref),/invalid/);await assert.rejects(castReviewerVote(a.receipt,a.person.context,a.person.actor,ref),/invalid/);}assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);
});

test('human-vote challenge/receipt cannot authorize tool execution proof with the same account and parameters',async()=>{
 const f=await fixture(),p=f.people.a,operation=await reviewerVoteTarget(p.context,p.actor,f.policy.id,1,f.request.id,f.request.hash,'approve'),ref=refOf(operation),issued=await issueReviewerVoteChallenge(p.context,p.actor,ref);
 const {completeOperationChallenge,consumeOperationReceiptStep}=await import('../src/auth/verification/operation-proof.ts'),{sql}=await import('../src/repositories/sql-steps.ts');
 const toolOperation={kind:'tool_approval',approvalId:f.request.id,paramsHash:f.request.hash,policyVersion:operation.policyVersion};assert.equal(await completeOperationChallenge(issued.token,p.context,toolOperation,otp(p)),null);
 const proof=await completeReviewerVoteChallenge(issued.token,p.context,p.actor,ref,otp(p));assert.ok(proof);assert.equal(await sql().tx(()=>consumeOperationReceiptStep(proof.receipt,p.context,toolOperation)),false);assert.equal((await castReviewerVote(proof.receipt,p.context,p.actor,ref)).recorded,true);
});
test('a separately proved policy change invalidates previously issued pending vote proof',async()=>{
 const f=await fixture(),a=await voteProof(f,'a'),owner=f.people.owner,time=Date.now(),id=randomUUID(),input={...f.policyInput,name:'Other rule',scope:{agentIds:['vote-agent'],toolNames:['other_fixture_tool']}};
 await saveReviewerDraft({actor:owner.actor,tokenVersion:2},id,0,input,time);const target=await reviewerDraftProofTarget(owner.context,owner.actor,id,1,time),issued=await issueReviewerDraftChallenge(owner.context,owner.actor,id,1,target.paramsHash,time),proof=await completeReviewerDraftChallenge(issued.token,owner.context,owner.actor,id,1,target.paramsHash,otp(owner,time+30000),time);assert.ok(proof);await activateReviewerPolicy(proof.receipt,owner.context,owner.actor,id,1,target.paramsHash,time);
 await assert.rejects(cast(a),/proof_refused/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);
});

test('channel-bound user-shaped actors cannot review or spend a real human vote receipt',async()=>{
 const f=await fixture(),a=await voteProof(f,'a'),actor={...a.person.actor,channel:'outside'};
 await assert.rejects(reviewerVoteTarget(a.person.context,actor,f.policy.id,1,f.request.id,f.request.hash,'approve'),/forbidden/);
 await assert.rejects(castReviewerVote(a.receipt,a.person.context,actor,a.ref),/forbidden/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM human_reviewer_votes WHERE approval_id=?').get(f.request.id).n,0);
 assert.equal((await cast(a)).idempotent,false);
});

test('active human rules force unclassified and category-allowed tools into approval before any execution',async()=>{
 const before=executions,priorRequired=tool.requiresApproval;
 try{
  tool.requiresApproval=false;
  for(const mapped of [false,true]){
   db.prepare("UPDATE human_reviewer_policies SET status='revoked'").run();
   if(mapped)tool.mcp=true;else delete tool.mcp;
   const f=await fixture(),registry=tools.createToolsRegistry({userId:f.people.owner.id,agentId:'vote-agent',sessionId:'admission-fixture',workspaceDir:dir,grants:grants.staticGrants([tool.name],'vote-agent'),permissions:{modes:{network:'allow'}}});
   const count=executions,pending=await registry.execute(tool.name,{text:'Actual registry admission'});assert.equal(executions,count);assert.ok(pending.details?.approvalId);
   const detail=await approvals.getApprovalDetail(pending.details.approvalId);f.request={id:detail.id,hash:detail.paramsHash};
   await cast(await voteProof(f,'a'));await cast(await voteProof(f,'b'));assert.equal(executions,count);
   await approvals.approveAndRun(f.request.id,f.people.owner.id,f.request.hash,await ownerProof(f));assert.equal(executions,count+1);
  }
  assert.equal(executions,before+2);
 }finally{tool.requiresApproval=priorRequired;delete tool.mcp;}
});

test('unavailable or expired active human rules never silently allow a direct tool call',async()=>{
 const f=await fixture(),count=executions,registry=tools.createToolsRegistry({userId:f.people.owner.id,agentId:'vote-agent',workspaceDir:dir,grants:grants.staticGrants([tool.name],'vote-agent')});
 db.prepare('UPDATE human_reviewer_policies SET policy_json=? WHERE id=?').run('{bad',f.policy.id);
 const refused=await registry.execute(tool.name,{text:'Must not execute'});assert.equal(refused.error,'Human review rules unavailable');assert.equal(executions,count);
 const {requiresReviewerApproval}=await import('../src/auth/verification/reviewer-quorum.ts');
 db.prepare('UPDATE human_reviewer_policies SET policy_json=? WHERE id=?').run(JSON.stringify(f.policyInput),f.policy.id);
 assert.equal(await requiresReviewerApproval('vote-agent',tool.name,f.policyInput.expiresAt+1),true);
 assert.equal(await requiresReviewerApproval('other-agent',tool.name),false);
});
