import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {prepareSkillMarkdown} from '../src/skills/markdown-bundle.ts';import {prepareReviewedObject,verifyReviewedObject} from '../src/skills/reviewed-object.ts';
const raw='---\nname: object-example\ndescription: Fictional object test\n---\nBody\n',bundle=prepareSkillMarkdown(raw,'object-example');
async function fixture(run){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reviewed-object-')));try{await run(root,path.join(root,'library'));}finally{await fs.rm(root,{recursive:true,force:true});}}
test('durable object bytes match review; concurrent/restart retries reuse one object and never overwrite',()=>fixture(async(_,root)=>{
 const results=await Promise.all(Array.from({length:8},()=>prepareReviewedObject(root,bundle)));assert.ok(results.every(r=>r.hash===bundle.hash));
 const file=path.join(root,'objects',bundle.hash,'SKILL.md'),stat=await fs.stat(file);await prepareReviewedObject(root,bundle);assert.equal((await fs.stat(file)).ino,stat.ino);assert.equal(await fs.readFile(file,'utf8'),raw);assert.equal(await verifyReviewedObject(root,bundle),bundle.hash);assert.deepEqual(await fs.readdir(path.join(root,'objects')),[bundle.hash]);assert.equal(stat.mode&0o777,0o600);
}));
test('corrupted existing object refuses and remains untouched',()=>fixture(async(_,root)=>{
 await prepareReviewedObject(root,bundle);const file=path.join(root,'objects',bundle.hash,'SKILL.md');await fs.writeFile(file,'Foreign contents');await assert.rejects(prepareReviewedObject(root,bundle));assert.equal(await fs.readFile(file,'utf8'),'Foreign contents');
}));
test('symlink root/object/file and writable shared directories refuse',()=>fixture(async(parent,root)=>{
 const other=path.join(parent,'outside');await fs.mkdir(other);await fs.symlink(other,root);await assert.rejects(prepareReviewedObject(root,bundle));assert.deepEqual(await fs.readdir(other),[]);await fs.unlink(root);
 await prepareReviewedObject(root,bundle);const file=path.join(root,'objects',bundle.hash,'SKILL.md');await fs.unlink(file);await fs.writeFile(path.join(other,'secret'),'Fictional private content');await fs.symlink(path.join(other,'secret'),file);await assert.rejects(prepareReviewedObject(root,bundle));assert.equal(await fs.readFile(path.join(other,'secret'),'utf8'),'Fictional private content');
 await fs.unlink(file);await fs.writeFile(file,raw,{mode:0o600});
 const objects=path.join(root,'objects');await fs.rename(objects,objects+'-saved');await fs.symlink(other,objects);await assert.rejects(prepareReviewedObject(root,bundle));assert.deepEqual(await fs.readdir(other),['secret']);await fs.unlink(objects);await fs.rename(objects+'-saved',objects);
 if(process.platform!=='win32'){await fs.chmod(root,0o777);await assert.rejects(prepareReviewedObject(root,bundle));await fs.chmod(root,0o700);}
}));
test('changed bundle metadata/hash, scripts and noncanonical bytes refuse before creating storage',()=>fixture(async(_,root)=>{
 for(const patch of [{hash:'a'.repeat(64)},{description:'Changed'},{files:[...bundle.files,{path:'run.sh',content:'never run'}]},{files:[{path:'SKILL.md',content:raw+' '}]}])await assert.rejects(prepareReviewedObject(root,{...bundle,...patch}));assert.equal(await fs.stat(root).then(()=>true,()=>false),false);
}));
