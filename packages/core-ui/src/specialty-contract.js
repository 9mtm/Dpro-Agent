import {validAgentId} from './agent-id.js';
export const TEMPLATES_PATH='/api/specialty-templates';
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const line=(v,n)=>typeof v==='string'&&v.length<=n;
const version=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER;
const only=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const identities=v=>Array.isArray(v)&&v.length<=10000&&v.every(a=>object(a)&&validAgentId(a.id)&&line(a.name,80));
const required=v=>only(v,['id','name','toolName','server'])&&uuid(v.id)&&line(v.name,120)&&!!v.name.trim()&&(v.toolName===null||line(v.toolName,200)&&/^[A-Za-z0-9_.:-]+$/.test(v.toolName))&&(v.server===null||line(v.server,200));
export const templateCategories=['browser','network','message','delete','install','money','settings'];
export const templateDrawers=['owner','project','experience','task','people'];
export function validTemplateConfig(v){return only(v,['primarySkill','skills','tools','memoryRead','memoryWrite','sharedMemory','modes','requirements'])&&(v.primarySkill===null||uuid(v.primarySkill))&&Array.isArray(v.skills)&&v.skills.length<=49&&v.skills.every(uuid)&&new Set(v.skills).size===v.skills.length&&!v.skills.includes(v.primarySkill)&&Array.isArray(v.tools)&&v.tools.length<=500&&v.tools.every(t=>only(t,['name','fingerprint'])&&line(t.name,200)&&/^[a-zA-Z0-9_.:-]+$/.test(t.name)&&(t.fingerprint===null||digest(t.fingerprint)))&&new Set(v.tools.map(t=>t.name)).size===v.tools.length&&['memoryRead','memoryWrite'].every(k=>Array.isArray(v[k])&&v[k].length<=5&&v[k].every(d=>templateDrawers.includes(d))&&new Set(v[k]).size===v[k].length)&&v.memoryWrite.every(d=>v.memoryRead.includes(d))&&typeof v.sharedMemory==='boolean'&&only(v.modes,templateCategories)&&Object.keys(v.modes).length===templateCategories.length&&templateCategories.every(c=>['off','ask','allow'].includes(v.modes[c]))&&(v.requirements===undefined||Array.isArray(v.requirements)&&v.requirements.length<=100&&v.requirements.every(required)&&new Set(v.requirements.map(r=>r.id)).size===v.requirements.length);}
const draft=v=>only(v,['name','department','description','instructions','config','revision','confirmImpact'])&&line(v.name,80)&&!!v.name.trim()&&line(v.department,64)&&!!v.department.trim()&&line(v.description,1800)&&line(v.instructions,30000)&&!!v.instructions.trim()&&version(v.revision)&&validTemplateConfig(v.config)&&(v.confirmImpact===undefined||digest(v.confirmImpact));
const parts=path=>path.startsWith(TEMPLATES_PATH+'/')?path.slice(TEMPLATES_PATH.length+1).split('/'):[];
export function templatePath(path){const p=parts(path);return [TEMPLATES_PATH,TEMPLATES_PATH+'/catalogue',TEMPLATES_PATH+'/hire'].includes(path)||p.length===1&&uuid(p[0])||p.length===2&&(uuid(p[0])&&['agents','impact','preview','assign'].includes(p[1])||p[0]==='assigned'&&validAgentId(p[1]));}
export function allowedTemplates(method,path,body){
 if(!templatePath(path))return false;const p=parts(path);
 if(method==='GET')return body===undefined&&path!==TEMPLATES_PATH+'/hire'&&!['preview','assign'].includes(p[1]);
 if(method==='PUT')return p.length===1&&uuid(p[0])&&draft(body);
 if(method==='POST'&&p.length===2&&p[1]==='preview')return draft(body);
 if(method==='POST'&&p.length===2&&p[1]==='assign')return only(body,['revision','agentIds','expectedAgentIds'])&&version(body.revision)&&body.revision>0&&['agentIds','expectedAgentIds'].every(k=>Array.isArray(body[k])&&body[k].length<=1000&&body[k].every(id=>validAgentId(id)&&id!=='small-local-agent')&&new Set(body[k]).size===body[k].length);
 if(method==='POST'&&p.length===2&&p[1]==='agents')return only(body,['agentId','revision','linked'])&&validAgentId(body.agentId)&&body.agentId!=='small-local-agent'&&version(body.revision)&&body.revision>0&&typeof body.linked==='boolean';
 return method==='POST'&&path===TEMPLATES_PATH+'/hire'&&only(body,['templateId','revision','requestId','name','confirmed','confirmRisky','linked'])&&uuid(body.templateId)&&uuid(body.requestId)&&version(body.revision)&&body.revision>0&&(body.name===undefined||line(body.name,80))&&body.confirmed===true&&typeof body.confirmRisky==='boolean'&&(body.linked===undefined||typeof body.linked==='boolean');
}
const summary=t=>{if(!object(t)||!uuid(t.id)||!line(t.name,80)||!line(t.department,64)||!version(t.revision)||(t.revision<1&&t.planned!==true)||t.planned!==undefined&&typeof t.planned!=='boolean'||t.planned===true&&t.revision!==0)throw Error('protocol');return {id:t.id,name:t.name,department:t.department,revision:t.revision,...(typeof t.planned==='boolean'?{planned:t.planned}:{}),...(Array.isArray(t.groups)&&t.groups.length<=72&&t.groups.every(g=>line(g,100))?{groups:[...t.groups]}:{}),...(['role','track'].includes(t.kind)?{kind:t.kind}:{}),...(line(t.description,1800)?{description:t.description}:{}),...(identities(t.agents)?{agents:t.agents.map(a=>({id:a.id,name:a.name}))}:{})};};
const projectAccess=v=>{if(!Array.isArray(v)||v.length>500||!v.every(a=>object(a)&&line(a.id,200)&&line(a.name,200)&&(a.toolName===null||line(a.toolName,200))&&(a.server===null||line(a.server,200))&&['unavailable','blocked','review_required','needs_grant','ask','allowed'].includes(a.status)&&Array.isArray(a.scopes)&&a.scopes.length<=100&&a.scopes.every(s=>line(s,200))))throw Error('protocol');return v.map(a=>({id:a.id,name:a.name,toolName:a.toolName,server:a.server,status:a.status,scopes:a.scopes}));};
export function templatesResponse(path,status,body){
 if(status!==200)return object(body)&&['forbidden','invalid_input','invalid_permissions','risky_not_confirmed','not_found','version_conflict','request_conflict','name_taken','skill_unavailable','tools_changed','storage_unavailable','template_unavailable','secret_refused','impact_confirmation_required','specialty_limit','links_changed','content_not_ready'].includes(body.code)?{code:body.code}:null;
 if(!object(body))throw Error('protocol');const p=parts(path);
 if(p[0]==='assigned'){if(!Array.isArray(body.templates)||body.templates.length>10)throw Error('protocol');return {templates:body.templates.map(summary)};}
 if(p.length===2){
  if(!identities(body.agents))throw Error('protocol');
  if(['impact','preview'].includes(p[1])){if(!version(body.revision)||!digest(body.confirmation)||!Array.isArray(body.changes)||body.changes.length>5||!body.changes.every(c=>object(c)&&['name','department','description','instructions','config'].includes(c.field)&&line(c.before,100000)&&line(c.after,100000)))throw Error('protocol');return {revision:body.revision,confirmation:body.confirmation,agents:body.agents.map(a=>({id:a.id,name:a.name})),changes:body.changes.map(c=>({field:c.field,before:c.before,after:c.after}))};}
  if(!body.agents.every(a=>typeof a.linked==='boolean'&&Array.isArray(a.missingTools)&&a.missingTools.length<=500&&a.missingTools.every(t=>line(t,200))))throw Error('protocol');
  return {agents:body.agents.map(a=>({id:a.id,name:a.name,linked:a.linked,missingTools:a.missingTools,...(a.access!==undefined?{access:projectAccess(a.access)}:{})}))};
 }
 if(path===TEMPLATES_PATH){if(!Array.isArray(body.templates)||body.templates.length>10000)throw Error('protocol');return {templates:body.templates.map(summary)};}
 if(path===TEMPLATES_PATH+'/hire'){if(!validAgentId(body.id)||typeof body.duplicate!=='boolean')throw Error('protocol');return {id:body.id,duplicate:body.duplicate};}
 if(path===TEMPLATES_PATH+'/catalogue'){if(!Array.isArray(body.skills)||body.skills.length>10000||!body.skills.every(s=>object(s)&&uuid(s.id)&&line(s.name,100)&&version(s.revision))||!Array.isArray(body.tools)||body.tools.length>500||!body.tools.every(t=>object(t)&&line(t.name,200)&&line(t.description,500)&&(t.server===null||line(t.server,200))&&(t.fingerprint===null||digest(t.fingerprint))&&typeof t.available==='boolean'))throw Error('protocol');return {skills:body.skills.map(s=>({id:s.id,name:s.name,revision:s.revision})),tools:body.tools.map(t=>({name:t.name,description:t.description,server:t.server,fingerprint:t.fingerprint,available:t.available}))};}
 if(body.planned===true)return summary(body);
 const {id,...rest}=body;if(!draft(rest))throw Error('protocol');return {...summary(body),description:body.description,instructions:body.instructions,config:body.config};
}
