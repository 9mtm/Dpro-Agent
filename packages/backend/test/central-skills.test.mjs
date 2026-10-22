import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dpro-skills-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();for(const id of ['skill-owner','skill-member'])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id,id+'@example.invalid',id,id==='skill-owner'?'owner':'user');
const {default:Fastify}=await import('fastify'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{generateToken}=await import('../src/auth/jwt.ts'),{CentralSkills,agentSkillsPrompt}=await import('../src/skills/central-store.ts'),{skillLibraryRoutes}=await import('../src/api/routes/skill-library.ts');
const sources=path.join(root,'claude'),clone=path.join(root,'codex'),secret='sk-ant-api03-'+('F'.repeat(55)),content='---\nname: fictional-skill\ndescription: Synthetic skill\nversion: "1.0.0"\n---\n\nUse the fictional green notebook.\nAPI_KEY='+secret+'\n';
for(const folder of [sources,clone]){await fs.mkdir(path.join(folder,'example/references'),{recursive:true});await fs.writeFile(path.join(folder,'example/SKILL.md'),content);await fs.writeFile(path.join(folder,'example/references/guide.md'),'# Fictional guide\n');await fs.writeFile(path.join(folder,'example/run.sh'),'never execute');}await fs.symlink('/etc',path.join(sources,'ignored-link'));
const store=new CentralSkills(root,path.join(root,'skill-library'),[{directory:sources,origin:'claude'},{directory:clone,origin:'codex'}]),app=Fastify();registerAuthGate(app);await app.register(skillLibraryRoutes,{store});await app.ready();const owner={authorization:'Bearer '+generateToken('skill-owner',1)},member={authorization:'Bearer '+generateToken('skill-member',1)},call=(method,url,payload,headers=owner)=>app.inject({method,url,headers,...(payload===undefined?{}:{payload})});let scanId,sourceId,preview,installed;
test.after(async()=>{await app.close();closeDatabase();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
test('authorized read-only discovery and redacted multi-file preview',async()=>{
 assert.equal((await app.inject({url:'/api/skill-library'})).statusCode,401);assert.equal((await call('POST','/api/skill-library/scan',{},member)).statusCode,403);
 const started=await call('POST','/api/skill-library/scan',{});assert.equal(started.statusCode,200);scanId=started.json().id;let status;for(let i=0;i<100;i++){status=(await call('GET','/api/skill-library/scans/'+scanId)).json();if(status.status!=='scanning')break;await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(status.status,'done');assert.equal(status.sources.length,2);sourceId=status.sources[0].id;
 const response=await call('POST','/api/skill-library/preview',{scanId,sourceId});assert.equal(response.statusCode,200);assert.ok(!response.body.includes(secret));preview=response.json();assert.ok(preview.redactions>0);assert.equal(preview.files.length,2);assert.ok(preview.omitted>0);assert.equal(await fs.readFile(path.join(sources,'example/SKILL.md'),'utf8'),content);
 assert.equal((await call('POST','/api/skill-library/preview',{scanId,sourceId,folder:'/etc'})).statusCode,400);
});
test('durable deduplicated Markdown import without scripts or automatic assignments',async()=>{
 const payload={scanId,sourceId,hash:preview.hash},saved=await call('POST','/api/skill-library/import',payload);assert.equal(saved.statusCode,200);installed=saved.json().skill;assert.equal((await call('POST','/api/skill-library/import',payload)).json().duplicate,true);
 const other=store.getScan('skill-owner',scanId).sources.find(s=>s.id!==sourceId),p=(await call('POST','/api/skill-library/preview',{scanId,sourceId:other.id})).json();assert.equal(p.existing.identical,true);assert.equal((await call('POST','/api/skill-library/import',{scanId,sourceId:other.id,hash:p.hash})).json().duplicate,true);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM central_skills WHERE name=?').get('fictional-skill').n,1);const folder=path.join(root,'skill-library/objects',installed.content_hash);assert.ok(!(await fs.readFile(path.join(folder,'SKILL.md'),'utf8')).includes(secret));assert.equal((await fs.stat(path.join(folder,'SKILL.md'))).mode&0o777,0o600);assert.equal(await fs.stat(path.join(folder,'run.sh')).then(()=>true,()=>false),false);assert.deepEqual((await call('GET','/api/skill-library/agents/main-agent')).json(),{revision:0,selected:[]});
});
test('installed package read is owner-gated, Markdown-only and verified against stored content',async()=>{
 const url='/api/skill-library/items/'+installed.id;
 assert.equal((await app.inject({url})).statusCode,401);
 assert.equal((await call('GET',url,undefined,member)).statusCode,403);
 const r=await call('GET',url);assert.equal(r.statusCode,200);const body=r.json();
 assert.equal(body.skill.id,installed.id);assert.equal(body.files.length,2);
 assert.ok(body.files.every(f=>f.path.endsWith('.md')));assert.ok(!r.body.includes(secret));
 assert.ok(!r.body.includes(root));assert.match(body.files.find(f=>f.path==='SKILL.md').content,/green notebook/);
 assert.equal((await call('GET','/api/skill-library/items/11111111-1111-4111-8111-111111111111')).statusCode,404);
 assert.equal((await call('GET','/api/skill-library/items/not-an-id')).statusCode,400);
});
test('per-agent assignment, CAS, fresh-instance durability and immediate prompt revocation',async()=>{
 const url='/api/skill-library/agents/main-agent';assert.equal((await call('PUT',url,{selected:[installed.id],revision:0},member)).statusCode,403);assert.equal((await call('PUT',url,{selected:[installed.id],revision:0})).statusCode,200);assert.match(await agentSkillsPrompt('main-agent'),/green notebook/);assert.equal(await agentSkillsPrompt('unassigned-agent'),'');assert.equal((await call('PUT',url,{selected:[],revision:0})).statusCode,409);assert.equal((await call('PUT',url,{selected:[installed.id,installed.id],revision:1})).statusCode,400);
 const fresh=new CentralSkills(root,path.join(root,'skill-library'));await fresh.initialize();assert.deepEqual((await fresh.assignments('main-agent')).selected,[installed.id]);assert.match(await fresh.prompt('main-agent'),/green notebook/);assert.equal((await call('PUT',url,{selected:[],revision:1})).statusCode,200);assert.equal(await agentSkillsPrompt('main-agent'),'');
});
test('source races and conflicting updates preserve original files and stable assignment IDs',async()=>{
 const file=path.join(store.getScan('skill-owner',scanId).sources.find(s=>s.id===sourceId).directory,'SKILL.md');await fs.writeFile(file,content.replace('green notebook','blue notebook'));assert.equal((await call('POST','/api/skill-library/import',{scanId,sourceId,hash:preview.hash})).statusCode,409);const next=(await call('POST','/api/skill-library/preview',{scanId,sourceId})).json();assert.equal((await call('POST','/api/skill-library/import',{scanId,sourceId,hash:next.hash})).statusCode,409);await call('PUT','/api/skill-library/agents/main-agent',{selected:[installed.id],revision:2});const changed=await call('POST','/api/skill-library/import',{scanId,sourceId,hash:next.hash,replaceHash:installed.content_hash});assert.equal(changed.statusCode,200);assert.equal(changed.json().skill.id,installed.id);assert.equal(changed.json().skill.revision,2);assert.match(await agentSkillsPrompt('main-agent'),/blue notebook/);assert.ok(await fs.stat(path.join(root,'skill-library/objects',installed.content_hash,'SKILL.md')));await fs.appendFile(path.join(root,'skill-library/objects',changed.json().skill.content_hash,'SKILL.md'),'\nUnindexed edit');assert.equal(await agentSkillsPrompt('main-agent'),'');assert.equal((await call('GET','/api/skill-library/items/'+installed.id)).statusCode,503);
});

test('reviewed Markdown bundle matches actual durable object without assignment',async()=>{
 const {prepareSkillArtifactReview}=await import('../src/plugins/skill-artifact.ts');
 const {createHash}=await import('node:crypto');
 const raw='---\r\nname: reviewed-example\r\ndescription: Fictional reviewed library test\r\n---\r\nA notebook.\r\npassword = "fictional-central-review-value"\r\n';
 const reviewed=prepareSkillArtifactReview({provider:'anthropic-skills',commit:'a'.repeat(40),sourcePath:'skills/reviewed-example',targetName:'reviewed-example',expectedRevision:0,previousContentHash:null,expectedContentHash:createHash('sha256').update(raw).digest('hex'),content:raw});
 const saved=await store.installMarkdown(raw,'reviewed-example','fictional-review-test');
 assert.equal(saved.skill.content_hash,reviewed.bundle.hash);
 assert.equal(await fs.readFile(path.join(root,'skill-library/objects',reviewed.bundle.hash,'SKILL.md'),'utf8'),reviewed.bundle.files[0].content);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM central_agent_skills WHERE skill_id=?').get(saved.skill.id).n,0);
});
