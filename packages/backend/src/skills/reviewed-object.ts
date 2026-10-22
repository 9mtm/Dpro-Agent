/** Immutable Markdown preparation only; never creates a library index, assignment or permission. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readRegularFile} from '../services/read-regular-file.js';
import {prepareSkillMarkdown,SkillLibraryError} from './markdown-bundle.js';
export type PreparedMarkdown=ReturnType<typeof prepareSkillMarkdown>;
const unavailable=()=>new SkillLibraryError('storage_unavailable',503);
async function directory(folder:string){
 await fs.mkdir(folder,{mode:0o700});
}
async function checkedDirectory(folder:string){
 if(await fs.realpath(folder)!==path.resolve(folder))throw unavailable();
 const handle=await fs.open(folder,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_DIRECTORY??0));
 try{const stat=await handle.stat();if(!stat.isDirectory()||(process.platform!=='win32'&&((stat.mode&0o022)!==0||(process.getuid&&stat.uid!==process.getuid()))))throw unavailable();}finally{await handle.close();}
}
async function ensureDirectory(folder:string){try{await directory(folder);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await checkedDirectory(folder);}
async function syncDirectory(folder:string){const handle=await fs.open(folder,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_DIRECTORY??0));try{await handle.sync();}finally{await handle.close();}}
function capture(bundle:PreparedMarkdown){
 if(!bundle||!Array.isArray(bundle.files)||bundle.files.length!==1||bundle.files[0]?.path!=='SKILL.md')throw unavailable();
 const prepared=prepareSkillMarkdown(bundle.files[0].content,bundle.name);
 if(prepared.hash!==bundle.hash||prepared.description!==bundle.description||prepared.version!==bundle.version||prepared.files[0].content!==bundle.files[0].content)throw unavailable();
 return prepared;
}
export async function verifyReviewedObject(root:string,bundle:PreparedMarkdown){
 const prepared=capture(bundle),objects=path.join(root,'objects'),folder=path.join(objects,prepared.hash);
 await checkedDirectory(root);await checkedDirectory(objects);await checkedDirectory(folder);
 const content=(await readRegularFile(path.join(folder,'SKILL.md'),200000)).data;
 if(!content.equals(Buffer.from(prepared.files[0].content)))throw unavailable();
 const names=await fs.readdir(folder);if(names.length!==1||names[0]!=='SKILL.md')throw unavailable();
 return prepared.hash;
}
/** A crash before indexing leaves at most an unreferenced content object, reusable on retry. */
export async function prepareReviewedObject(root:string,bundle:PreparedMarkdown){
 const prepared=capture(bundle);if(typeof root!=='string'||!path.isAbsolute(root))throw unavailable();
 // Parent creation is the caller's workspace setup; no traversal through an unreviewed parent.
 await ensureDirectory(root);const objects=path.join(root,'objects');await ensureDirectory(objects);
 const folder=path.join(objects,prepared.hash);await ensureDirectory(folder);
 const temporary=path.join(objects,'pending-'+randomUUID()+'.md');
 const handle=await fs.open(temporary,'wx',0o600);
 try{
  try{await handle.writeFile(prepared.files[0].content);await handle.sync();}finally{await handle.close();}
  try{await fs.link(temporary,path.join(folder,'SKILL.md'));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  await verifyReviewedObject(root,prepared);await syncDirectory(folder);await syncDirectory(objects);await syncDirectory(root);
  return Object.freeze({hash:prepared.hash});
 }finally{await fs.unlink(temporary);}
}
