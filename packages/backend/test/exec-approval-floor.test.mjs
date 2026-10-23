import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'exec-approval-floor-'));process.env.DATABASE_PATH=join(dir,'test.db');process.env.AGENT_PLAYER_DATA_DIR=dir;process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.AGENT_EXEC_TOOLS='true';
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('exec-owner','exec@example.invalid','Owner','fixture','owner','active')").run();db.prepare("INSERT INTO agents_config(id,name,provider,model) VALUES('exec-agent','Fixture','claude','fixture')").run();
const {ToolsRegistry}=await import('../src/tools/registry.ts');const {staticGrants}=await import('../src/tools/grants.ts');const {approvalCategory}=await import('../src/tools/approvals.ts');
const {legacyPermissions}=await import('../src/tools/agent-permissions.ts');let executions=0;
const names=['exec','execute_code','desktop_control','claude_cli','gemini_cli','ask_coding_app','fixture_process'];
const permissions=legacyPermissions('exec-agent');for(const key of Object.keys(permissions.modes))permissions.modes[key]='allow';
const registry=new ToolsRegistry({userId:'exec-owner',agentId:'exec-agent',sessionId:'exec-session',workspaceDir:dir,grants:staticGrants(names),permissions});
for(const name of names)registry.register({name,execClass:name==='fixture_process',mcp:name==='fixture_process'?{}:undefined,description:'Harmless test fixture',input_schema:{type:'object',properties:{}},async execute(){executions++;return {content:[{type:'text',text:'fixture'}]};}});
test.after(()=>closeDatabase());
test('every exec-class call needs a single-use owner approval despite allow modes and forged tickets',async()=>{
 for(const name of names){const result=await registry.execute(name,{command:'echo fixture'},{approvalTicket:{toolName:name,approvalId:'forged'}});assert.equal(result.details?.status,'pending_approval',name);const row=db.prepare('SELECT status,params_encrypted FROM tool_approvals WHERE id=?').get(result.details.approvalId);assert.equal(row.status,'pending');assert.ok(!row.params_encrypted.includes('echo fixture'));}assert.equal(executions,0);
});
test('real approval claim executes an exec-class fixture once and rechecks current grants',async()=>{
 const tools=await import('../src/tools/index.ts'),grants=await import('../src/tools/grants.ts'),approvals=await import('../src/tools/approvals.ts');
 const fixture={name:'fixture_exec_approved',execClass:true,extensionId:'fixture',description:'Harmless approved fixture',input_schema:{type:'object',properties:{}},async execute(){executions++;return {content:[{type:'text',text:'approved fixture'}]};}};
 tools.registerExtensionTool(fixture);const available=tools.createToolsRegistry({}).listRegistered();await grants.setAgentGrants('exec-agent',{grants:[fixture.name]},'exec-owner',available);
 try{const make=()=>tools.createToolsRegistry({userId:'exec-owner',agentId:'exec-agent',sessionId:'s1',workspaceDir:dir});const r=await make().execute(fixture.name,{});assert.equal(r.details.status,'pending_approval');const detail=await approvals.getApprovalDetail(r.details.approvalId),before=executions;
 const results=await Promise.allSettled([approvals.approveAndRun(detail.id,'exec-owner',detail.paramsHash),approvals.approveAndRun(detail.id,'exec-owner',detail.paramsHash)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(executions,before+1);
 const next=await make().execute(fixture.name,{}),d=await approvals.getApprovalDetail(next.details.approvalId);await grants.setAgentGrants('exec-agent',{grants:[]},'exec-owner',available);await approvals.approveAndRun(d.id,'exec-owner',d.paramsHash);assert.equal(executions,before+1);
 }finally{tools.unregisterExtensionTool(fixture.name);}
});
test('exec flag cannot opt out of category and server off still refuses before approval',async()=>{
 assert.equal(approvalCategory({name:'fixture',execClass:true,requiresApproval:false}),'other');const countBefore=executions;const before=db.prepare('SELECT COUNT(*) AS n FROM tool_approvals').get().n;delete process.env.AGENT_EXEC_TOOLS;const result=await registry.execute('exec',{});assert.ok(result.error);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_approvals').get().n,before);assert.equal(executions,countBefore);
});
