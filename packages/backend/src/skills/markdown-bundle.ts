/** Pure preparation shared by reviewed artifacts and central Markdown storage. */
import {createHash} from 'node:crypto';
import yaml from 'js-yaml';
import {redactImportText} from '../memory/import/redact.js';
import {isValidSkillName} from './skill-ids.js';
export class SkillLibraryError extends Error { constructor(readonly code:string,readonly status=400){super(code);} }
export const normalizeSkillMarkdown=(text:string)=>text.replace(/\r\n?/g,'\n').trim()+'\n';
export function skillMarkdownMetadata(content:string){
 const match=/^---\n([\s\S]*?)\n---\n/.exec(normalizeSkillMarkdown(content));if(!match)throw new SkillLibraryError('invalid_skill');
 let raw:any;try{raw=yaml.load(match[1],{schema:yaml.JSON_SCHEMA});}catch{throw new SkillLibraryError('invalid_skill');}
 if(!raw||!isValidSkillName(raw.name)||typeof raw.description!=='string'||!raw.description.trim()||raw.description.length>2000)throw new SkillLibraryError('invalid_skill');
 const version=raw.metadata?.['agent-player']?.version??raw.version??'1.0.0';
 return {name:raw.name.toLowerCase(),description:raw.description.trim(),version:typeof version==='string'?version.slice(0,80):'1.0.0'};
}
/** No filesystem, database, assignment or execution side effects. */
export function prepareSkillMarkdown(content:string,name:string){
 if(typeof content!=='string'||content.length>200000||Buffer.byteLength(content)>200000||Buffer.from(content).toString('utf8')!==content||content.includes('\0'))throw new SkillLibraryError('invalid_text');
 const clean=redactImportText(content),text=normalizeSkillMarkdown(clean.text),meta=skillMarkdownMetadata(text);
 if(typeof name!=='string'||meta.name!==name.toLowerCase())throw new SkillLibraryError('invalid_skill');
 if(Buffer.byteLength(text)>200000)throw new SkillLibraryError('file_too_large');
 const files=Object.freeze([Object.freeze({path:'SKILL.md',content:text})]);
 return Object.freeze({...meta,files,hash:createHash('sha256').update(JSON.stringify(files)).digest('hex'),redactions:clean.total,omitted:0});
}
