import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {prepareSkillMarkdown} from '../skills/markdown-bundle.js';
import {isValidSkillSourcePath} from '../skills/skill-ids.js';
export class SkillArtifactError extends Error{constructor(){super('Invalid skill artifact');}}
export type SkillArtifactOperation=Readonly<{kind:'skill_install';version:1;source:Readonly<{provider:'anthropic-skills';commit:string;path:string}>;target:Readonly<{name:string;expectedRevision:number;previousContentHash:string|null}>;contentHash:string;byteLength:number;effect:'store-markdown-only';enabled:false}>;
function invalid():never{throw new SkillArtifactError();}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const isValidSkillArtifactTarget=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value);
/** Internal snapshot only: no network, filesystem, approval receipt, registration or activation. */
export function captureSkillArtifact(input:unknown):Readonly<{operation:SkillArtifactOperation;planHash:string;content:string}>{
 const keys=['provider','commit','sourcePath','targetName','expectedRevision','previousContentHash','expectedContentHash','content'];
 if(!input||typeof input!=='object'||types.isProxy(input)||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).length!==keys.length||!keys.every(key=>Object.hasOwn(input,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(input,key)!,'value')))invalid();
 const value=input as Record<string,unknown>;
 if(value.provider!=='anthropic-skills'||typeof value.commit!=='string'||!/^[a-f0-9]{40}$/.test(value.commit)||/^0+$/.test(value.commit)||!isValidSkillSourcePath(value.sourcePath))invalid();
 if(!isValidSkillArtifactTarget(value.targetName))invalid();
 if(typeof value.expectedRevision!=='number'||!Number.isInteger(value.expectedRevision)||value.expectedRevision<0||value.expectedRevision>2147483646||!hash(value.expectedContentHash))invalid();
 if(value.expectedRevision===0?value.previousContentHash!==null:!hash(value.previousContentHash))invalid();
 if(typeof value.content!=='string'||!value.content||value.content.length>200000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value.content))invalid();
 const bytes=Buffer.from(value.content,'utf8');if(bytes.length>200000||bytes.toString('utf8')!==value.content)invalid();
 const contentHash=createHash('sha256').update(bytes).digest('hex');if(contentHash!==value.expectedContentHash)invalid();
 const operation:SkillArtifactOperation=Object.freeze({kind:'skill_install',version:1,source:Object.freeze({provider:'anthropic-skills',commit:value.commit,path:value.sourcePath}),target:Object.freeze({name:value.targetName,expectedRevision:value.expectedRevision,previousContentHash:value.previousContentHash as string|null}),contentHash,byteLength:bytes.length,effect:'store-markdown-only',enabled:false});
 return Object.freeze({operation,planHash:createHash('sha256').update(JSON.stringify(operation)).digest('hex'),content:value.content});
}

/** Review identity binds both original bytes and the exact sanitized library object. No apply authority. */
export function prepareSkillArtifactReview(input:unknown){
 const captured=captureSkillArtifact(input);
 const bundle=prepareSkillMarkdown(captured.content,captured.operation.target.name);
 const operation=Object.freeze({...captured.operation,bundle:Object.freeze({hash:bundle.hash,name:bundle.name,description:bundle.description,version:bundle.version,redactions:bundle.redactions,byteLength:Buffer.byteLength(bundle.files[0].content)})});
 return Object.freeze({operation,planHash:createHash('sha256').update(JSON.stringify(operation)).digest('hex'),bundle});
}
