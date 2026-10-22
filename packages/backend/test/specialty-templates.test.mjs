import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dpro-templates-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();for(const [id,role] of [['template-owner','owner'],['template-member','user']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fictional',?,'active')").run(id,id+'@example.invalid',id,role);
const {centralSkills}=await import('../src/skills/central-store.ts');await centralSkills().initialize();const skill=(await centralSkills().installMarkdown('---\nname: fictional-template-guide\ndescription: Fictional testing guide\n---\nUse the fictional notebook.\n','fictional-template-guide','test')).skill;
const {default:Fastify}=await import('fastify'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{generateToken}=await import('../src/auth/jwt.ts'),{specialtyTemplateRoutes}=await import('../src/api/routes/specialty-templates.ts');const app=Fastify();registerAuthGate(app);await app.register(specialtyTemplateRoutes);await app.ready();
const owner={authorization:'Bearer '+generateToken('template-owner',1)},member={authorization:'Bearer '+generateToken('template-member',1)},base='/api/specialty-templates',call=(method,url,payload,headers=owner)=>app.inject({method,url,headers,...(payload===undefined?{}:{payload})});let template,created;
const baseline=db.prepare('SELECT * FROM agents_config ORDER BY id').all();
test.after(async()=>{await app.close();closeDatabase();await fs.rm(root,{recursive:true,force:true});});
test('owner-only seeded library preserves existing agents',async()=>{assert.equal((await app.inject({url:base})).statusCode,401);assert.equal((await call('GET',base,undefined,member)).statusCode,403);const list=(await call('GET',base)).json().templates;assert.equal(list.filter(t=>!t.planned).length,122);assert.ok(list.some(t=>t.planned));template=(await call('GET',base+'/'+list[0].id)).json();assert.deepEqual(db.prepare('SELECT * FROM agents_config ORDER BY id').all(),baseline);});
test('reviewed template save uses CAS and does not grant authority',async()=>{const {id,...body}=template;body.config.primarySkill=skill.id;body.config.tools=[];body.config.memoryRead=['task'];body.config.memoryWrite=[];body.instructions+='\nAPI_KEY=sk-ant-api03-'+ 'F'.repeat(55);const saved=await call('PUT',base+'/'+id,body);assert.equal(saved.statusCode,200,saved.body);template=saved.json();assert.equal(template.revision,2);assert.ok(!template.instructions.includes('F'.repeat(55)));assert.equal((await call('PUT',base+'/'+id,body)).statusCode,409);assert.deepEqual(db.prepare('SELECT * FROM agents_config ORDER BY id').all(),baseline);});
test('atomic template hire retains reviewed permissions and idempotent receipt',async()=>{const request={templateId:template.id,revision:template.revision,requestId:randomUUID(),name:'Fictional template specialist',confirmed:true,confirmRisky:false};const result=await call('POST',base+'/hire',request);assert.equal(result.statusCode,200,result.body);created=result.json().id;assert.equal((await call('POST',base+'/hire',request)).json().id,created);assert.equal((await call('POST',base+'/hire',{...request,name:'Different fictional name'})).statusCode,409);const perms=db.prepare('SELECT * FROM agent_permissions WHERE agent_id=?').get(created);assert.deepEqual(JSON.parse(perms.memory_read),['task']);assert.deepEqual(JSON.parse(perms.memory_write),[]);assert.ok(Object.values(JSON.parse(perms.modes)).every(v=>v==='ask'));assert.equal(db.prepare('SELECT skill_id FROM central_agent_skills WHERE agent_id=?').get(created).skill_id,skill.id);assert.equal(db.prepare('SELECT primary_skill_id FROM agent_template_snapshots WHERE agent_id=?').get(created).primary_skill_id,skill.id);assert.deepEqual(db.prepare('SELECT * FROM agents_config WHERE id!=? ORDER BY id').all(created),baseline);});
test('future revisions never modify created agents; risky allow needs fresh confirmation',async()=>{const before=db.prepare('SELECT * FROM agents_config WHERE id=?').get(created),{id,...body}=template;body.config.modes.money='allow';const result=await call('PUT',base+'/'+id,body);assert.equal(result.statusCode,200,result.body);template=result.json();assert.deepEqual(db.prepare('SELECT * FROM agents_config WHERE id=?').get(created),before);const count=db.prepare('SELECT count(*) n FROM agents_config').get().n;assert.equal((await call('POST',base+'/hire',{templateId:id,revision:template.revision,requestId:randomUUID(),confirmed:true,confirmRisky:false})).statusCode,400);assert.equal(db.prepare('SELECT count(*) n FROM agents_config').get().n,count);assert.equal((await call('POST',base+'/hire',{templateId:id,revision:1,requestId:randomUUID(),confirmed:true,confirmRisky:true})).statusCode,409);});
test('concurrent retries create one agent; changed capability fingerprints fail closed',async()=>{const {id,...body}=template;body.config.modes.money='ask';body.config.tools=[{name:'memory_search',fingerprint:null}];let result=await call('PUT',base+'/'+id,body);assert.equal(result.statusCode,200,result.body);template=result.json();const request={templateId:id,revision:template.revision,requestId:randomUUID(),name:'Fictional concurrent specialist',confirmed:true,confirmRisky:false},before=db.prepare('SELECT count(*) n FROM agents_config').get().n;const replies=await Promise.all([call('POST',base+'/hire',request),call('POST',base+'/hire',request)]);assert.ok(replies.every(r=>r.statusCode===200),replies.map(r=>r.body).join('\n'));assert.equal(replies[0].json().id,replies[1].json().id);assert.equal(db.prepare('SELECT count(*) n FROM agents_config').get().n,before+1);assert.deepEqual(db.prepare('SELECT tool_name FROM agent_tool_grants WHERE agent_id=?').all(replies[0].json().id),[{tool_name:'memory_search'}]);const {id:tid,...changed}=template;changed.config.tools=[{name:'memory_search',fingerprint:'a'.repeat(64)}];result=await call('PUT',base+'/'+tid,changed);assert.equal(result.statusCode,409);assert.equal(db.prepare('SELECT revision FROM specialty_templates WHERE id=?').get(tid).revision,template.revision);});
test('custom templates start without grants; invalid names do not create agents',async()=>{const id=randomUUID(),{id:ignored,...body}=template;body.revision=0;body.name='Fictional custom teacher';body.config.tools=[];const saved=await call('PUT',base+'/'+id,body);assert.equal(saved.statusCode,200,saved.body);assert.equal((await call('PUT',base+'/'+id,body)).statusCode,409);const n=db.prepare('SELECT count(*) n FROM agents_config').get().n;assert.equal((await call('POST',base+'/hire',{templateId:id,revision:1,requestId:randomUUID(),name:'x'.repeat(61),confirmed:true,confirmRisky:false})).statusCode,400);assert.equal(db.prepare('SELECT count(*) n FROM agents_config').get().n,n);db.prepare("UPDATE users SET role='admin' WHERE id='template-member'").run();assert.equal((await call('GET',base,undefined,member)).statusCode,403);});

test('linked specialty assignments are owner-only, atomic and preserve agent authority',async()=>{
 const view=await call('GET',base+'/'+template.id+'/agents');assert.equal(view.statusCode,200,view.body);
 const before=db.prepare('SELECT * FROM agents_config WHERE id=?').get(created),permissions=db.prepare('SELECT * FROM agent_permissions WHERE agent_id=?').get(created),grants=db.prepare('SELECT * FROM agent_tool_grants WHERE agent_id=? ORDER BY tool_name').all(created);
 const input={revision:template.revision,agentIds:[created],expectedAgentIds:[]};
 assert.equal((await call('POST',base+'/'+template.id+'/assign',input,member)).statusCode,403);
 const applied=await call('POST',base+'/'+template.id+'/assign',input);assert.equal(applied.statusCode,200,applied.body);assert.equal(applied.json().agents.find(a=>a.id===created).linked,true);
 assert.deepEqual(db.prepare('SELECT * FROM agents_config WHERE id=?').get(created),before);assert.deepEqual(db.prepare('SELECT * FROM agent_permissions WHERE agent_id=?').get(created),permissions);assert.deepEqual(db.prepare('SELECT * FROM agent_tool_grants WHERE agent_id=? ORDER BY tool_name').all(created),grants);
 assert.equal((await call('POST',base+'/'+template.id+'/assign',{...input,agentIds:[],expectedAgentIds:[]})).json().code,'links_changed');
 const failed=await call('POST',base+'/'+template.id+'/assign',{revision:template.revision,agentIds:['not-an-agent'],expectedAgentIds:[created]});assert.equal(failed.statusCode,404);assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_specialties WHERE template_id=?').get(template.id).n,1);
 assert.equal((await call('GET',base+'/assigned/'+created)).json().templates[0].id,template.id);
 const {agentSkillsPrompt}=await import('../src/skills/central-store.ts');const prompt=await agentSkillsPrompt(created);assert.match(prompt,/Linked specialties/);assert.match(prompt,/fictional notebook/);
});

test('missing requirements persist, exact draft preview gates propagation, and stale review fails closed',async()=>{
 const {id,...body}=template;body.instructions='A revised linked accounting role. Never move money.';body.config.requirements=[{id:randomUUID(),name:'Read the accounting ledger',toolName:null,server:'Accounting MCP'}];
 const noPreview=await call('PUT',base+'/'+id,body);assert.equal(noPreview.statusCode,409);assert.equal(noPreview.json().code,'impact_confirmation_required');
 const preview=await call('POST',base+'/'+id+'/preview',body);assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().agents[0].id,created);assert.ok(preview.json().changes.some(c=>c.field==='instructions'));
 assert.equal((await call('PUT',base+'/'+id,{...body,instructions:'Another unreviewed instruction',confirmImpact:preview.json().confirmation})).statusCode,409);
 const saved=await call('PUT',base+'/'+id,{...body,confirmImpact:preview.json().confirmation});assert.equal(saved.statusCode,200,saved.body);template=saved.json();assert.equal(template.config.requirements[0].name,'Read the accounting ledger');
 const agents=(await call('GET',base+'/'+id+'/agents')).json().agents;assert.equal(agents.find(a=>a.id===created).access[0].status,'unavailable');
 const {agentSkillsPrompt}=await import('../src/skills/central-store.ts');assert.match(await agentSkillsPrompt(created),/revised linked accounting role/);
 assert.equal((await call('PUT',base+'/'+id,{...body,confirmImpact:preview.json().confirmation})).statusCode,409);
 const {id:ignored,...next}=template;next.instructions+='\nAn exact new draft.';const nextPreview=(await call('POST',base+'/'+id+'/preview',next)).json();
 assert.equal((await call('POST',base+'/'+id+'/assign',{revision:template.revision,agentIds:[],expectedAgentIds:[created]})).statusCode,200);
 assert.equal((await call('PUT',base+'/'+id,{...next,confirmImpact:nextPreview.confirmation})).statusCode,200); // no linked agents remain
 assert.equal((await call('GET',base+'/assigned/'+created)).json().templates.length,0);
 template=(await call('GET',base+'/'+id)).json();
 assert.equal((await call('POST',base+'/'+id+'/preview',{revision:template.revision})).statusCode,400);
});

test('new linked hires use the same live specialty while keeping safe permissions and idempotency',async()=>{
 const {id,...body}=template;body.config.modes.money='allow';const saved=await call('PUT',base+'/'+id,body);assert.equal(saved.statusCode,200,saved.body);template=saved.json();
 const request={templateId:id,revision:template.revision,requestId:randomUUID(),name:'Fictional linked accountant',confirmed:true,confirmRisky:false,linked:true};const result=await call('POST',base+'/hire',request);assert.equal(result.statusCode,200,result.body);const agent=result.json().id;
 assert.equal((await call('POST',base+'/hire',request)).json().id,agent);assert.equal(db.prepare('SELECT template_id FROM agent_specialties WHERE agent_id=?').get(agent).template_id,id);
 const permissions=db.prepare('SELECT * FROM agent_permissions WHERE agent_id=?').get(agent);assert.equal(JSON.parse(permissions.modes).money,'ask');assert.equal(db.prepare('SELECT system_prompt FROM agents_config WHERE id=?').get(agent).system_prompt,'');assert.equal(db.prepare('SELECT count(*) n FROM agent_template_snapshots WHERE agent_id=?').get(agent).n,0);
 const {agentSkillsPrompt}=await import('../src/skills/central-store.ts');assert.match(await agentSkillsPrompt(agent),/revised linked accounting role/);
});

test('specialty tools retain owner-turn and outsider gates',async()=>{
 const {specialtyLibraryTool,specialtyApplyTool}=await import('../src/tools/specialties.ts');assert.equal(specialtyApplyTool.requiresApproval,true);
 assert.equal((await specialtyLibraryTool.execute({action:'list'},{workspaceDir:root,userId:'template-member'})).error,'forbidden');
 assert.equal((await specialtyLibraryTool.execute({action:'list'},{workspaceDir:root,userId:'template-owner',toolPolicy:{channel:'public'}})).error,'forbidden');
 const result=await specialtyLibraryTool.execute({action:'assigned',agentId:created},{workspaceDir:root,userId:'template-owner'});assert.ok(!result.error);
});


test('approved planning catalogue is readable but cannot grant, assign, hire or save placeholder content',async()=>{
 const {SPECIALTY_GROUPS,PLANNED_SPECIALTIES}=await import('../src/services/specialty-catalogue.ts');
 assert.equal(SPECIALTY_GROUPS.length,72);assert.equal(SPECIALTY_GROUPS.reduce((n,g)=>n+g.entries.length,0),553);
 assert.equal(new Set(PLANNED_SPECIALTIES.map(t=>t.id)).size,PLANNED_SPECIALTIES.length);
 const list=(await call('GET',base)).json().templates,planned=list.find(t=>t.planned&&t.name==='Life and personal development coach');assert.ok(planned);assert.equal(planned.revision,0);
 for(const name of ['Desktop application developer','Poet','Lyricist','Newcomer and refugee integration adviser','Youth coach','EU legislation researcher'])assert.ok(list.some(t=>t.name===name),name);
 assert.equal(list.filter(t=>t.name==='Career guidance adviser').length,1);
 const read=await call('GET',base+'/'+planned.id);assert.equal(read.statusCode,200,read.body);assert.equal(read.json().planned,true);assert.equal(read.json().instructions,undefined);
 assert.equal((await call('GET',base+'/'+planned.id,undefined,member)).statusCode,403);
 const before=db.prepare('SELECT count(*) n FROM agents_config').get().n,links=db.prepare('SELECT count(*) n FROM agent_specialties').get().n;
 assert.notEqual((await call('POST',base+'/hire',{templateId:planned.id,revision:1,requestId:randomUUID(),confirmed:true,confirmRisky:false,linked:true})).statusCode,200);
 assert.notEqual((await call('POST',base+'/'+planned.id+'/assign',{revision:1,agentIds:[created],expectedAgentIds:[]})).statusCode,200);
 const {id,...body}=template;const saved=await call('PUT',base+'/'+planned.id,{...body,revision:0});assert.equal(saved.statusCode,409);assert.equal(saved.json().code,'content_not_ready');
 assert.equal(db.prepare('SELECT count(*) n FROM agents_config').get().n,before);assert.equal(db.prepare('SELECT count(*) n FROM agent_specialties').get().n,links);
 assert.equal(db.prepare('SELECT id FROM specialty_templates WHERE id=?').get(planned.id),undefined);
});

test('template storage refuses symlink content and writable shared object directories',async()=>{
 const {SpecialtyTemplates}=await import('../src/services/specialty-templates.ts');const store=new SpecialtyTemplates();
 const row=db.prepare('SELECT content_hash FROM specialty_templates WHERE id=?').get(template.id);
 const dir=path.join(root,'specialty-templates','objects'),file=path.join(dir,row.content_hash+'.md');
 const secret=path.join(root,'untrusted-file');await fs.writeFile(secret,'untrusted fixture');
 await fs.rename(file,file+'.saved');await fs.symlink(secret,file);
 try{await assert.rejects(store.get(template.id),{code:'storage_unavailable'});}finally{await fs.unlink(file);await fs.rename(file+'.saved',file);}
 if(process.platform!=='win32'){
  await fs.chmod(dir,0o777);
  try{const {id,...body}=template;body.revision=0;const out=await call('PUT',base+'/'+randomUUID(),body);assert.equal(out.statusCode,503,out.body);}finally{await fs.chmod(dir,0o700);}
 }
});
