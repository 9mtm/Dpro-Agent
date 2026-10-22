import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'skill-review-stage-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'fixture.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts'),db=getDatabase();await db.initialize();
const {CentralSkills}=await import('../src/skills/central-store.ts');const store=new CentralSkills(root,path.join(root,'library'));await store.initialize();
const {stageSkillReview,readSkillReview}=await import('../src/plugins/skill-review-stage.ts');
for(const id of ['fixture-owner','fixture-other']){db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified,token_version) VALUES(?,?,?,'fixture','owner','active',1,1)").run(id,id+'@example.invalid',id);db.prepare('INSERT INTO verification_factors(user_id,version,enabled,sealed_secret,last_counter,activated_at) VALUES(?,1,1,?,-1,1)').run(id,'not-a-real-factor');}
const context={userId:'fixture-owner',sessionHash:'a'.repeat(64),tokenVersion:1,factorVersion:1},actor={kind:'user',role:'owner',userId:context.userId};
const raw='---\nname: staged-example\ndescription: Fictional staged review\n---\npassword = "fictional-staged-value"\n';
const input=()=>({provider:'anthropic-skills',commit:'a'.repeat(40),sourcePath:'skills/staged-example',targetName:'staged-example',expectedRevision:0,previousContentHash:null,expectedContentHash:createHash('sha256').update(raw).digest('hex'),content:raw});
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
test('durable stage stores only sanitized review and causes no skill or receipt creation',async()=>{
 const s=await stageSkillReview(context,actor,input(),1000),r=await readSkillReview(context,actor,s.id,1001);
 assert.deepEqual(r,s);assert.ok(Object.isFrozen(r.review.bundle.files[0]));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM central_skills').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verification_receipts').get().n,0);
 assert.equal(db.prepare('SELECT review_json FROM skill_install_reviews WHERE id=?').get(s.id).review_json.includes('fictional-staged-value'),false);
 assert.equal(await fs.stat(path.join(root,'library/objects')).then(()=>true,()=>false),false);
 await assert.rejects(readSkillReview(context,actor,s.id,301000),e=>e.code==='changed');
 await assert.rejects(readSkillReview({...context,sessionHash:'b'.repeat(64)},actor,s.id,1002),e=>e.code==='unavailable');
 await assert.rejects(readSkillReview({...context,userId:'fixture-other'},{...actor,userId:'fixture-other'},s.id,1002),e=>e.code==='unavailable');
});
test('current owner, factor, token and global policy changes invalidate staging',async()=>{
 const s=await stageSkillReview(context,actor,input(),2000);
 for(const [table,column,changed,original,where] of [['users','role','user','owner',"id='fixture-owner'"],['users','token_version',2,1,"id='fixture-owner'"],['verification_factors','enabled',0,1,"user_id='fixture-owner'"],['verification_factors','version',2,1,"user_id='fixture-owner'"]]){db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}`).run(changed);await assert.rejects(readSkillReview(context,actor,s.id,2001));await assert.rejects(stageSkillReview(context,actor,input(),2001));db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}`).run(original);}
 db.prepare('UPDATE approval_proof_policy SET version=version+1 WHERE id=1').run();await assert.rejects(readSkillReview(context,actor,s.id,2001),e=>e.code==='changed');
 await assert.rejects(stageSkillReview(context,{...actor,agentId:'agent'},input(),2002),e=>e.code==='forbidden');
});
test('target creation, revision changes and delete/recreate identity invalidate prior review',async()=>{
 const absent=await stageSkillReview(context,actor,input(),3000);const saved=await store.installMarkdown(raw,'staged-example','fixture');
 await assert.rejects(readSkillReview(context,actor,absent.id,3001),e=>e.code==='changed');await assert.rejects(stageSkillReview(context,actor,input(),3001),e=>e.code==='changed');
 const existing={...input(),expectedRevision:1,previousContentHash:saved.skill.content_hash},s=await stageSkillReview(context,actor,existing,3002);
 db.prepare('UPDATE central_skills SET revision=2 WHERE id=?').run(saved.skill.id);await assert.rejects(readSkillReview(context,actor,s.id,3003),e=>e.code==='changed');db.prepare('UPDATE central_skills SET revision=1,id=? WHERE id=?').run('recreated-fixture',saved.skill.id);await assert.rejects(readSkillReview(context,actor,s.id,3003),e=>e.code==='changed');
});
test('bounded active reviews reject concurrent excess; expired rows do not consume active capacity',async()=>{
 const other={...context,userId:'fixture-other'},otherActor={...actor,userId:'fixture-other'},value={...input(),expectedRevision:1,previousContentHash:(await store.list())[0].content_hash};
 const results=await Promise.allSettled(Array.from({length:10},()=>stageSkillReview(other,otherActor,value,4000)));assert.equal(results.filter(r=>r.status==='fulfilled').length,8);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='limit').length,2);
 assert.ok(await stageSkillReview(other,otherActor,value,304001));
});
test('persisted content tampering refuses rather than changing reviewed material',async()=>{
 const current=(await store.list())[0],value={...input(),expectedRevision:1,previousContentHash:current.content_hash};const s=await stageSkillReview(context,actor,value,305000);
 const row=db.prepare('SELECT review_json FROM skill_install_reviews WHERE id=?').get(s.id),review=JSON.parse(row.review_json);review.bundle.files[0].content+='Changed';db.prepare('UPDATE skill_install_reviews SET review_json=? WHERE id=?').run(JSON.stringify(review),s.id);
 await assert.rejects(readSkillReview(context,actor,s.id,305001),e=>e.code==='unavailable');
});
