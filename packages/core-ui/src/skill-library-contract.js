import { validAgentId } from './agent-id.js';
export const SKILLS_PATH='/api/skill-library';
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const version=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
export function skillLibraryPath(path){if([SKILLS_PATH,SKILLS_PATH+'/scan',SKILLS_PATH+'/preview',SKILLS_PATH+'/import'].includes(path))return true;const item=/^\/api\/skill-library\/items\/([^/]+)$/.exec(path);if(item)return uuid(item[1]);const scan=/^\/api\/skill-library\/scans\/([^/]+)$/.exec(path);if(scan)return uuid(scan[1]);const agent=/^\/api\/skill-library\/agents\/([^/]+)$/.exec(path);return !!agent&&validAgentId(agent[1])&&agent[1]!=='small-local-agent';}
export function allowedSkillLibrary(method,path,body){
 if(!skillLibraryPath(path))return false;if(method==='GET')return body===undefined&&(path===SKILLS_PATH||path.startsWith(SKILLS_PATH+'/items/')||path.startsWith(SKILLS_PATH+'/scans/')||path.startsWith(SKILLS_PATH+'/agents/'));
 if(method==='PUT'&&path.startsWith(SKILLS_PATH+'/agents/'))return record(body)&&Object.keys(body).sort().join(',')==='revision,selected'&&version(body.revision)&&Array.isArray(body.selected)&&body.selected.length<=50&&body.selected.every(uuid)&&new Set(body.selected).size===body.selected.length;
 if(method!=='POST'||!record(body))return false;
 if(path===SKILLS_PATH+'/scan')return Object.keys(body).length===0;
 if(path===SKILLS_PATH+'/preview')return Object.keys(body).sort().join(',')==='scanId,sourceId'&&uuid(body.scanId)&&uuid(body.sourceId);
 if(path===SKILLS_PATH+'/import')return ['hash,scanId,sourceId','hash,replaceHash,scanId,sourceId'].includes(Object.keys(body).sort().join(','))&&uuid(body.scanId)&&uuid(body.sourceId)&&hex(body.hash)&&(body.replaceHash===undefined||hex(body.replaceHash));
 return false;
}
const line=(value,max)=>typeof value==='string'&&value.length<=max;
const skill=row=>{if(!record(row)||!uuid(row.id)||!line(row.name,100)||!line(row.description,2000)||!line(row.version,80)||!version(row.revision)||!hex(row.content_hash)||!line(row.origin,80))throw Error('protocol');return {id:row.id,name:row.name,description:row.description,version:row.version,revision:row.revision,content_hash:row.content_hash,origin:row.origin};};
export function skillLibraryResponse(path,status,body){
 if(status!==200)return record(body)&&['forbidden','invalid_input','invalid_agent','agent_not_found','scan_not_found','source_not_found','preview_changed','version_conflict','skill_not_found','skill_unavailable','file_too_large','invalid_skill','symlink_refused','scan_busy','bundle_too_large','storage_unavailable'].includes(body.code)?{code:body.code}:null;
 if(!record(body))throw Error('protocol');
 if(path===SKILLS_PATH){if(!Array.isArray(body.skills)||body.skills.length>10000)throw Error('protocol');return {skills:body.skills.map(skill)};}
 if(path.startsWith(SKILLS_PATH+'/items/')){if(!Array.isArray(body.files)||!body.files.length||body.files.length>200||!body.files.every(f=>record(f)&&line(f.path,400)&&!f.path.startsWith('/')&&!f.path.split('/').includes('..')&&f.path.toLowerCase().endsWith('.md')&&line(f.content,200001)))throw Error('protocol');return {skill:skill(body.skill),files:body.files.map(f=>({path:f.path,content:f.content}))};}
 if(path.startsWith(SKILLS_PATH+'/agents/')){if(!version(body.revision))throw Error('protocol');if(body.selected!==undefined){if(!Array.isArray(body.selected)||body.selected.length>50||!body.selected.every(uuid))throw Error('protocol');return {revision:body.revision,selected:body.selected};}return {revision:body.revision};}
 if(path===SKILLS_PATH+'/import'){if(typeof body.duplicate!=='boolean')throw Error('protocol');return {skill:skill(body.skill),duplicate:body.duplicate};}
 if(path===SKILLS_PATH+'/preview'){
  if(!line(body.name,100)||!line(body.description,2000)||!line(body.version,80)||!hex(body.hash)||!version(body.redactions)||!version(body.omitted)||!Array.isArray(body.files)||body.files.length>200||!body.files.every(f=>record(f)&&line(f.path,400)&&line(f.content,200001)))throw Error('protocol');
  if(body.existing!==null&&(!record(body.existing)||!uuid(body.existing.id)||!hex(body.existing.hash)||typeof body.existing.identical!=='boolean'))throw Error('protocol');
  return {name:body.name,description:body.description,version:body.version,hash:body.hash,redactions:body.redactions,omitted:body.omitted,files:body.files.map(f=>({path:f.path,content:f.content})),existing:body.existing?{id:body.existing.id,hash:body.existing.hash,identical:body.existing.identical}:null};
 }
 if(!uuid(body.id)||!['scanning','done','error'].includes(body.status)||!version(body.visited)||!version(body.skipped)||typeof body.limited!=='boolean'||!Array.isArray(body.sources)||body.sources.length>2000||!body.sources.every(s=>record(s)&&uuid(s.id)&&line(s.name,100)&&line(s.description,2000)&&line(s.origin,80)&&line(s.location,2000)))throw Error('protocol');
 return {id:body.id,status:body.status,visited:body.visited,skipped:body.skipped,limited:body.limited,sources:body.sources.map(s=>({id:s.id,name:s.name,description:s.description,origin:s.origin,location:s.location}))};
}
