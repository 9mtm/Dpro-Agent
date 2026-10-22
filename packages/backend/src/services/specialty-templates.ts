import fs from 'node:fs/promises';
import {extendSpecialtyList,plannedSpecialty} from './specialty-catalogue.js';
import {constants} from 'node:fs';
import {readRegularFile} from './read-regular-file.js';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {q,sql,one,run,dialect,all} from '../repositories/sql-steps.js';
import {forUpdate} from '../db/pg/dialect.js';
import {dataPath} from '../config/data-root.js';
import {COMPANY_SPECIALTIES} from './company-specialties.js';
import {parsePermissionsInput,PERMISSION_CATEGORIES} from '../tools/agent-permissions.js';
import {setAgentGrantsStep} from '../tools/grants.js';
import {createAgentToolsRegistry} from '../tools/index.js';
import {isToolObjectAllowedByExecPolicy} from '../tools/exec-policy.js';
import {currentMcpTool,currentMcpToolStep} from '../mcp-client/grant-binding.js';
import {insertAgentConfigStep,newAgentId} from '../repositories/agents-config.js';
import {suggestAgentName,resolveNamingLanguage,validateAgentName} from './agent-names.js';
import {redactImportText} from '../memory/import/redact.js';
export class TemplateError extends Error{constructor(readonly code:string,readonly status=400){super(code);}}
export type TemplateConfig={primarySkill:string|null;skills:string[];tools:{name:string;fingerprint:string|null}[];memoryRead:string[];memoryWrite:string[];sharedMemory:boolean;modes:Record<string,string>;requirements?:{id:string;name:string;toolName:string|null;server:string|null}[]};
type Row={id:string;name:string;department:string;description:string;revision:number;content_hash:string;config_json:string};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
const text=(s:unknown,max:number):s is string=>typeof s==='string'&&s.length<=max&&!/[\u0000\u202a-\u202e\u2066-\u2069]/.test(s);
const keys=(v:Record<string,any>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const stable=(v:any):string=>JSON.stringify(v&&typeof v==='object'?(Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))]))):v);
const draftHash=(raw:any)=>hash(stable({name:raw.name,department:raw.department,description:raw.description,instructions:raw.instructions,config:raw.config,revision:raw.revision}));
const defaults=():TemplateConfig=>({primarySkill:null,skills:[],tools:[],memoryRead:['project','experience','task'],memoryWrite:['project','experience','task'],sharedMemory:false,modes:Object.fromEntries(PERMISSION_CATEGORIES.map(c=>[c,'ask']))});
export class SpecialtyTemplates{
 private root=dataPath('specialty-templates/objects');
 private async content(instructions:string){
  const clean=redactImportText(instructions.replace(/\r\n?/g,'\n').trim()+'\n').text,id=hash(clean);
  const base=await fs.realpath(dataPath());
  for(const dir of [path.join(base,'specialty-templates'),path.join(base,'specialty-templates','objects')]){
   await fs.mkdir(dir,{recursive:true,mode:0o700});
   const handle=await fs.open(dir,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_DIRECTORY??0));
   try{const stat=await handle.stat();if(!stat.isDirectory()||(process.platform!=='win32'&&((stat.mode&0o022)!==0||(process.getuid&&stat.uid!==process.getuid()))))throw new TemplateError('storage_unavailable',503);}finally{await handle.close();}
   if(await fs.realpath(dir)!==dir)throw new TemplateError('storage_unavailable',503);
  }
  this.root=path.join(base,'specialty-templates','objects');
  const file=path.join(this.root,id+'.md'),temporary=path.join(this.root,'pending-'+randomUUID());
  const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(clean);await handle.sync();}finally{await handle.close();}
  try{await fs.link(temporary,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}finally{await fs.unlink(temporary);}
  const directory=await fs.open(this.root,'r');try{await directory.sync();}finally{await directory.close();}
  if(hash((await readRegularFile(file,120000)).data.toString('utf8'))!==id)throw new TemplateError('storage_unavailable',503);return id;
 }
 async initialize(){
  for(const item of COMPANY_SPECIALTIES){const digest=hash(item.department+':'+item.name),id=`${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;if(await q.one('SELECT id FROM specialty_templates WHERE id=?',id))continue;
   const content=await this.content(`# ${item.name}\n\n${item.description}\n\nUse only assigned tools and memory drawers. Ask when approval is required.`);
   await q.run('INSERT INTO specialty_templates(id,name,department,description,revision,content_hash,config_json) VALUES(?,?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING',id,item.name,item.department,item.description,content,JSON.stringify(defaults()));
  }
 }
 async list(){const rows=await q.all<Pick<Row,'id'|'name'|'department'|'description'|'revision'>>('SELECT id,name,department,description,revision FROM specialty_templates ORDER BY department,name');const links=await q.all<{template_id:string;id:string;name:string}>('SELECT s.template_id,a.id,a.name FROM agent_specialties s JOIN agents_config a ON a.id=s.agent_id ORDER BY a.name');return extendSpecialtyList(rows.map(r=>({...r,agents:links.filter(l=>l.template_id===r.id).map(l=>({id:l.id,name:l.name}))})));}
 async read(id:string){const planned=plannedSpecialty(id);if(planned&&!await q.one('SELECT id FROM specialty_templates WHERE id=?',id))return planned;return this.get(id);}
 async get(id:string){if(!uuid(id))throw new TemplateError('invalid_input');const row=await q.one<Row>('SELECT * FROM specialty_templates WHERE id=?',id);if(!row)throw new TemplateError('not_found',404);const file=path.join(this.root,row.content_hash+'.md');if(!/^[a-f0-9]{64}$/.test(row.content_hash))throw new TemplateError('storage_unavailable',503);let instructions:string;try{instructions=(await readRegularFile(file,120000)).data.toString('utf8');}catch{throw new TemplateError('storage_unavailable',503);}if(hash(instructions)!==row.content_hash)throw new TemplateError('storage_unavailable',503);return {id:row.id,name:row.name,department:row.department,description:row.description,revision:row.revision,instructions,config:JSON.parse(row.config_json) as TemplateConfig};}
 async catalogue(){const skills=await q.all('SELECT id,name,revision FROM central_skills ORDER BY name');const tools=[];for(const tool of (await createAgentToolsRegistry({workspaceDir:process.cwd()})).listRegistered()){if(tool.selfOnly)continue;const binding=tool.mcp?await currentMcpTool(tool.name):undefined;tools.push({name:tool.name,description:tool.description.slice(0,500),server:tool.mcp?.serverName??null,fingerprint:binding?.fingerprint??null,available:isToolObjectAllowedByExecPolicy(tool)});}return {skills,tools};}
 private async config(raw:unknown,requireAvailable=true){
  if(!object(raw)||!keys(raw,['primarySkill','skills','tools','memoryRead','memoryWrite','sharedMemory','modes','requirements'])||!(raw.primarySkill===null||uuid(raw.primarySkill))||!Array.isArray(raw.skills)||raw.skills.length>49||!raw.skills.every(uuid)||new Set(raw.skills).size!==raw.skills.length||raw.skills.includes(raw.primarySkill)||!Array.isArray(raw.tools)||raw.tools.length>500)throw new TemplateError('invalid_input');
  if(raw.requirements!==undefined&&(!Array.isArray(raw.requirements)||raw.requirements.length>100||!raw.requirements.every((r:any)=>object(r)&&keys(r,['id','name','toolName','server'])&&uuid(r.id)&&text(r.name,120)&&!!r.name.trim()&&(r.toolName===null||text(r.toolName,200)&&/^[A-Za-z0-9_.:-]+$/.test(r.toolName))&&(r.server===null||text(r.server,200)))||new Set(raw.requirements.map((r:any)=>r.id)).size!==raw.requirements.length))throw new TemplateError('invalid_input');
  if(raw.requirements?.some((r:any)=>redactImportText(r.name).total||r.server&&redactImportText(r.server).total))throw new TemplateError('secret_refused');
  const permissions=parsePermissionsInput('template-draft',{...raw,confirmRisky:true});const selected=[...(raw.primarySkill?[raw.primarySkill]:[]),...raw.skills];for(const id of selected)if(!await q.one('SELECT id FROM central_skills WHERE id=?',id))throw new TemplateError('skill_unavailable',409);
  const catalogue=await this.catalogue(),seen=new Set<string>();for(const value of raw.tools){if(!object(value)||!keys(value,['name','fingerprint'])||typeof value.name!=='string'||seen.has(value.name))throw new TemplateError('invalid_input');seen.add(value.name);const current=catalogue.tools.find(t=>t.name===value.name);if(requireAvailable&&(!current||!current.available||current.fingerprint!==value.fingerprint))throw new TemplateError('tools_changed',409);}
  return {primarySkill:raw.primarySkill,skills:raw.skills,tools:raw.tools,memoryRead:permissions.memoryRead,memoryWrite:permissions.memoryWrite,sharedMemory:permissions.sharedMemory,modes:permissions.modes,...(raw.requirements!==undefined?{requirements:raw.requirements}:{})} as TemplateConfig;
 }
 private validateDraft(raw:unknown):asserts raw is Record<string,any>{
  if(!object(raw)||!keys(raw,['name','department','description','instructions','config','revision','confirmImpact'])||!text(raw.name,80)||!raw.name.trim()||/[\x00-\x1f\x7f]/.test(raw.name)||!text(raw.department,64)||!raw.department.trim()||/[\x00-\x1f\x7f]/.test(raw.department)||!text(raw.description,1800)||!text(raw.instructions,30000)||!raw.instructions.trim()||!Number.isSafeInteger(raw.revision)||raw.revision<0)throw new TemplateError('invalid_input');
  if(redactImportText(raw.name).total||redactImportText(raw.department).total||redactImportText(raw.description).total)throw new TemplateError('secret_refused');
 }
 async assigned(agentId:string){if(!text(agentId,100))throw new TemplateError('invalid_input');return {templates:await q.all('SELECT t.id,t.name,t.department,t.revision FROM specialty_templates t JOIN agent_specialties s ON s.template_id=t.id WHERE s.agent_id=? ORDER BY t.name',agentId)};}
 async impact(id:string,proposed?:unknown){
  const template=await this.get(id);
  const agents=await q.all<{id:string;name:string}>('SELECT a.id,a.name FROM agents_config a JOIN agent_specialties s ON s.agent_id=a.id WHERE s.template_id=? ORDER BY a.id',id);
  if(proposed!==undefined){this.validateDraft(proposed);await this.config(proposed.config);}
  if(proposed!==undefined&&(!object(proposed)||proposed.revision!==template.revision))throw new TemplateError('version_conflict',409);
  const changes=proposed===undefined?[]:['name','department','description','instructions','config'].filter(k=>stable((template as any)[k])!==stable((proposed as any)[k])).map(field=>({field,before:typeof (template as any)[field]==='string'?(template as any)[field]:stable((template as any)[field]),after:typeof (proposed as any)[field]==='string'?(proposed as any)[field]:stable((proposed as any)[field])}));
  return {revision:template.revision,agents,changes,confirmation:hash(JSON.stringify([id,template.revision,agents.map(a=>a.id),proposed===undefined?null:draftHash(proposed)]))};
 }
 async agents(id:string){
  const template=await this.get(id),catalogue=await this.catalogue();
  const agents=await q.all<{id:string;name:string;linked:number}>('SELECT a.id,a.name,CASE WHEN s.agent_id IS NULL THEN 0 ELSE 1 END AS linked FROM agents_config a LEFT JOIN agent_specialties s ON s.agent_id=a.id AND s.template_id=? WHERE a.id!=? ORDER BY a.name',id,'small-local-agent');
  const {loadAgentGrants}=await import('../tools/grants.js');const {loadAgentPermissions,modeFor}=await import('../tools/agent-permissions.js');
  const required=template.config.requirements??template.config.tools.map(t=>({id:t.name,name:t.name,toolName:t.name,server:catalogue.tools.find(c=>c.name===t.name)?.server??null}));
  return {agents:await Promise.all(agents.map(async a=>{const grants=await loadAgentGrants(a.id,catalogue.tools),permissions=await loadAgentPermissions(a.id);
   const access=required.map(r=>{const current=catalogue.tools.find(c=>c.name===r.toolName);const binding=template.config.tools.find(t=>t.name===r.toolName);const mode=r.toolName?modeFor(permissions,{name:r.toolName,...(current?.server?{mcp:{}}:{})}):null;
    const status=!current?'unavailable':!current.available||mode==='off'?'blocked':binding&&binding.fingerprint!==current.fingerprint?'review_required':!grants.tools.has(current.name)?'needs_grant':mode==='ask'?'ask':'allowed';
    return {id:r.id,name:r.name,toolName:r.toolName,server:r.server,status,scopes:current?grants.tools.get(current.name)?.destinations??[]:[]};});
   return {id:a.id,name:a.name,linked:!!a.linked,missingTools:access.filter(r=>!['ask','allowed'].includes(r.status)).map(r=>r.toolName??r.name),access};}))};
 }
 async link(ownerId:string,id:string,input:unknown){
  if(!uuid(id)||!object(input)||!keys(input,['agentId','revision','linked'])||!text(input.agentId,100)||input.agentId==='small-local-agent'||typeof input.linked!=='boolean'||!Number.isSafeInteger(input.revision))throw new TemplateError('invalid_input');
  await sql().tx(function*(){const d=yield* dialect();const row=yield* one<Row>('SELECT * FROM specialty_templates WHERE id=?'+forUpdate(d),id);if(!row||row.revision!==input.revision)throw new TemplateError('version_conflict',409);
   if(!(yield* one('SELECT id FROM agents_config WHERE id=?'+forUpdate(d),input.agentId)))throw new TemplateError('not_found',404);
   if(input.linked){const count=yield* one<{n:number}>('SELECT COUNT(*) n FROM agent_specialties WHERE agent_id=?',input.agentId);if((count?.n??0)>=10&&!(yield* one('SELECT agent_id FROM agent_specialties WHERE agent_id=? AND template_id=?',input.agentId,id)))throw new TemplateError('specialty_limit',409);
    yield* run('INSERT INTO agent_specialties(agent_id,template_id,linked_by) VALUES(?,?,?) ON CONFLICT(agent_id,template_id) DO NOTHING',input.agentId,id,ownerId);
   }else yield* run('DELETE FROM agent_specialties WHERE agent_id=? AND template_id=?',input.agentId,id);
  },{immediate:true});return this.agents(id);
 }
 async assign(ownerId:string,id:string,input:unknown){
  if(!uuid(id)||!object(input)||!keys(input,['revision','agentIds','expectedAgentIds'])||!Number.isSafeInteger(input.revision)||!Array.isArray(input.agentIds)||!Array.isArray(input.expectedAgentIds)||input.agentIds.length>1000||input.expectedAgentIds.length>1000||![...input.agentIds,...input.expectedAgentIds].every(v=>text(v,100)&&!!v&&v!=='small-local-agent')||new Set(input.agentIds).size!==input.agentIds.length||new Set(input.expectedAgentIds).size!==input.expectedAgentIds.length)throw new TemplateError('invalid_input');
  await sql().tx(function*(){const d=yield* dialect();const template=yield* one<Row>('SELECT * FROM specialty_templates WHERE id=?'+forUpdate(d),id);if(!template||template.revision!==input.revision)throw new TemplateError('version_conflict',409);
   const current=yield* all<{agent_id:string}>('SELECT agent_id FROM agent_specialties WHERE template_id=? ORDER BY agent_id',id);
   if(stable(current.map(a=>a.agent_id))!==stable([...input.expectedAgentIds].sort()))throw new TemplateError('links_changed',409);
   for(const agentId of [...input.agentIds].sort()){if(!(yield* one('SELECT id FROM agents_config WHERE id=?'+forUpdate(d),agentId)))throw new TemplateError('not_found',404);const count=yield* one<{n:number}>('SELECT COUNT(*) n FROM agent_specialties WHERE agent_id=?',agentId);if((count?.n??0)>=10&&!current.some(a=>a.agent_id===agentId))throw new TemplateError('specialty_limit',409);}
   for(const row of current)if(!input.agentIds.includes(row.agent_id))yield* run('DELETE FROM agent_specialties WHERE agent_id=? AND template_id=?',row.agent_id,id);
   for(const agentId of input.agentIds)yield* run('INSERT INTO agent_specialties(agent_id,template_id,linked_by) VALUES(?,?,?) ON CONFLICT(agent_id,template_id) DO NOTHING',agentId,id,ownerId);
  },{immediate:true});return this.agents(id);
 }
 async save(id:string,raw:unknown){
  if(plannedSpecialty(id))throw new TemplateError('content_not_ready',409);
  this.validateDraft(raw);
  const config=await this.config(raw.config),content=await this.content(raw.instructions);
  if(!uuid(id))throw new TemplateError('invalid_input');
  if(raw.revision===0){const inserted=await q.run('INSERT INTO specialty_templates(id,name,department,description,revision,content_hash,config_json) VALUES(?,?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING',id,raw.name.trim(),raw.department.trim(),raw.description,content,JSON.stringify(config));if(inserted.changes!==1)throw new TemplateError('version_conflict',409);}
  else {await sql().tx(function*(){const d=yield* dialect();const current=yield* one<Row>('SELECT * FROM specialty_templates WHERE id=?'+forUpdate(d),id);if(!current||current.revision!==raw.revision)throw new TemplateError('version_conflict',409);
   const linked=yield* all<{agent_id:string}>('SELECT agent_id FROM agent_specialties WHERE template_id=? ORDER BY agent_id',id);
   if(linked.length&&raw.confirmImpact!==hash(JSON.stringify([id,current.revision,linked.map(a=>a.agent_id),draftHash(raw)])))throw new TemplateError('impact_confirmation_required',409);
   yield* run('UPDATE specialty_templates SET name=?,department=?,description=?,content_hash=?,config_json=?,revision=revision+1 WHERE id=? AND revision=?',raw.name.trim(),raw.department.trim(),raw.description,content,JSON.stringify(config),id,raw.revision);
  },{immediate:true});}
  return this.get(id);
 }
 async hire(ownerId:string,input:unknown){
  if(!object(input)||!keys(input,['templateId','revision','requestId','name','confirmed','confirmRisky','linked'])||!uuid(input.templateId)||!uuid(input.requestId)||!Number.isSafeInteger(input.revision)||input.revision<1||input.confirmed!==true||typeof input.confirmRisky!=='boolean'||!(input.name===undefined||text(input.name,80))||!(input.linked===undefined||typeof input.linked==='boolean'))throw new TemplateError('invalid_input');
  const requestedName=input.name?.trim()?validateAgentName(input.name):null,print=hash(JSON.stringify([input.templateId,input.revision,requestedName,input.confirmRisky,...(input.linked===true?['linked']:[])]));
  const prior=await q.one<{fingerprint:string;agent_id:string}>('SELECT fingerprint,agent_id FROM template_hire_requests WHERE owner_id=? AND request_id=?',ownerId,input.requestId);if(prior){if(prior.fingerprint!==print)throw new TemplateError('request_conflict',409);return {id:prior.agent_id,duplicate:true};}
  const template=await this.get(input.templateId);if(template.revision!==input.revision)throw new TemplateError('version_conflict',409);const config=await this.config(template.config,input.linked!==true),permissions=parsePermissionsInput('new-template-agent',{...config,confirmRisky:input.linked===true||input.confirmRisky});
  const available=(await createAgentToolsRegistry({workspaceDir:process.cwd()})).listRegistered();const language=await resolveNamingLanguage(ownerId),name=requestedName??(await suggestAgentName(language)).name,id=newAgentId();
  return sql().tx(function*(){
   const d=yield* dialect();
   yield* one('SELECT id FROM users WHERE id=?'+forUpdate(d),ownerId);
   const existing=yield* one<{fingerprint:string;agent_id:string}>('SELECT fingerprint,agent_id FROM template_hire_requests WHERE owner_id=? AND request_id=?',ownerId,input.requestId);if(existing){if(existing.fingerprint!==print)throw new TemplateError('request_conflict',409);return {id:existing.agent_id,duplicate:true};}
   const current=yield* one<Row>('SELECT * FROM specialty_templates WHERE id=?'+forUpdate(d),input.templateId);if(!current||current.revision!==input.revision)throw new TemplateError('version_conflict',409);
   yield* insertAgentConfigStep({id,name,language,role:'specialist',department:template.department,explicit:null,userId:ownerId,body:{description:`${template.name}: ${template.description}`,system_prompt:input.linked===true?'':template.instructions}});
   yield* run('UPDATE agents_config SET specialty=? WHERE id=?',template.name,id);
   if(input.linked===true){yield* run('INSERT INTO agent_specialties(agent_id,template_id,linked_by) VALUES(?,?,?)',id,template.id,ownerId);}else{
   yield* run('UPDATE agent_permissions SET memory_read=?,memory_write=?,shared_memory=?,modes=?,updated_by=? WHERE agent_id=?',JSON.stringify(permissions.memoryRead),JSON.stringify(permissions.memoryWrite),permissions.sharedMemory?1:0,JSON.stringify(permissions.modes),ownerId,id);
   yield* setAgentGrantsStep(id,{grants:config.tools.map(t=>t.name)},ownerId,available);
   for(const tool of config.tools)if(tool.fingerprint){const binding=yield* currentMcpToolStep(tool.name);if(!binding||binding.fingerprint!==tool.fingerprint)throw new TemplateError('tools_changed',409);yield* run('UPDATE mcp_grant_bindings SET fingerprint=? WHERE agent_id=? AND tool_name=?',tool.fingerprint,id,tool.name);}
   const skillIds=[...(config.primarySkill?[config.primarySkill]:[]),...config.skills];for(const skillId of skillIds){if(! (yield* one('SELECT id FROM central_skills WHERE id=?',skillId)))throw new TemplateError('skill_unavailable',409);yield* run('INSERT INTO central_agent_skills(agent_id,skill_id) VALUES(?,?)',id,skillId);}
   yield* run('INSERT INTO central_skill_assignments(agent_id,revision) VALUES(?,1)',id);
   yield* run('INSERT INTO agent_template_snapshots(agent_id,template_id,template_revision,content_hash,config_json,primary_skill_id) VALUES(?,?,?,?,?,?)',id,template.id,template.revision,current.content_hash,JSON.stringify(config),config.primarySkill);
   }
   yield* run('INSERT INTO template_hire_requests(owner_id,request_id,fingerprint,agent_id) VALUES(?,?,?,?)',ownerId,input.requestId,print,id);return {id,duplicate:false};
  },{immediate:true});
 }
}

/** Linked specialties supply instructions and skill references, never tool grants. */
export async function linkedSpecialtyContext(agentId:string){
 const links=await q.all<{template_id:string}>('SELECT template_id FROM agent_specialties WHERE agent_id=? ORDER BY template_id',agentId);
 const skills=new Set<string>();let prompt='';const store=new SpecialtyTemplates();
 for(const link of links){const t=await store.get(link.template_id);for(const id of [t.config.primarySkill,...t.config.skills])if(id)skills.add(id);
  const section=`\n### ${t.name} (revision ${t.revision})\n${t.description}\n${t.instructions}\nRequired tools: ${(t.config.requirements?.map(x=>x.name)??t.config.tools.map(x=>x.name)).join(', ')||'None specified'}.\n`;
  if(prompt.length+section.length<=32000)prompt+=section;else prompt+='\nA linked specialty exceeded the context budget; do not claim it was loaded.\n';
 }
 return {skills:[...skills],prompt:prompt?'\n## Linked specialties\nThese owner-assigned roles guide your work. They do not grant tools, MCP connections, memory access or permission to execute. Use only tools actually offered; report missing requirements.\n'+prompt:''};
}
