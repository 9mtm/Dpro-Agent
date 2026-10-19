import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dpro-sdk-skills-')));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const sdk=path.join(root,'sdk-skills');process.env.DPRO_GENVR_SKILLS=sdk;
const write=async(name,body,extra={})=>{await fs.mkdir(path.join(sdk,name,'references'),{recursive:true});await fs.writeFile(path.join(sdk,name,'SKILL.md'),`---\nname: ${name}\ndescription: >-\n  Fictional ${name} guide\n---\n\n${body}\n`);for(const [f,c] of Object.entries(extra))await fs.writeFile(path.join(sdk,name,'references',f),c);};
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {CentralSkills}=await import('../src/skills/central-store.ts');
const store=new CentralSkills(path.join(root,'home'),path.join(root,'skill-library'));
test.after(async()=>{closeDatabase();await fs.rm(root,{recursive:true,force:true});});
const row=name=>db.prepare('SELECT name,origin,revision,content_hash FROM central_skills WHERE name=?').get(name);

test('SDK skills are added, then updated when a newer SDK changes them',async()=>{
 await write('genvr-film-maker','Film steps v1.',{'tools.md':'# Tools v1\n'});
 await store.initialize();await store.seedBundled();
 const first=row('genvr-film-maker');assert.equal(first.origin,'genvr-sdk');assert.equal(first.revision,1);
 await store.seedBundled();assert.equal(row('genvr-film-maker').revision,1);
 await write('genvr-film-maker','Film steps v2.',{'tools.md':'# Tools v2\n'});
 await store.seedBundled();const second=row('genvr-film-maker');assert.equal(second.revision,2);assert.notEqual(second.content_hash,first.content_hash);
});

test('an SDK skill replaces an untouched bundled copy but never an owner-imported one',async()=>{
 // Dpro's own older copy was seeded as 'bundled' by the first test (no SDK copy of that name yet).
 assert.equal(row('genvr-world-builder').origin,'bundled');const before=row('genvr-world-builder').revision;
 db.prepare("INSERT INTO central_skills(id,name,description,version,revision,content_hash,origin) VALUES('owner-copy','genvr-avatar-presentation','mine','1.0.0',3,?,'claude')").run('b'.repeat(64));
 await write('genvr-world-builder','World steps.');await write('genvr-avatar-presentation','Avatar steps.');
 await store.seedBundled();
 assert.equal(row('genvr-world-builder').origin,'genvr-sdk');assert.equal(row('genvr-world-builder').revision,before+1);
 assert.deepEqual(row('genvr-avatar-presentation'),{name:'genvr-avatar-presentation',origin:'claude',revision:3,content_hash:'b'.repeat(64)});
});
