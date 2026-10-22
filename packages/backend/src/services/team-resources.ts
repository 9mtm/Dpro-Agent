import {parseDepartments,DEPARTMENTS,CompanyPlanInputError} from './company-plan.js';
import {SPECIALTY_GROUPS,SPECIALTY_DEPARTMENT_GROUPS,PLANNED_SPECIALTIES} from './specialty-catalogue.js';
import {BOARD_TEMPLATES,templateForDepartment} from './board-templates.js';
import {centralSkills} from '../skills/central-store.js';
import {listServers} from '../mcp-client/service.js';
import {connectionState} from '../mcp-client/connection.js';
import {all,sql} from '../repositories/sql-steps.js';
const needs:Record<string,string[]>={development:['Source control','Code review','Tests and builds'],marketing:['Campaign research','Content review','Publishing workflow'],sales:['CRM records','Sales pipeline','Follow-up tracking'],support:['Ticketing','Knowledge base','Customer communication'],finance:['Spreadsheets','Accounting records','Document review'],security:['Asset inventory','Security evidence','Access review'],hr:['Recruitment records','Onboarding','Employee documents'],education:['Course design','Learning materials','Progress tracking'],legal:['Authoritative legal sources','Document review','Case tracking'],data:['Data access','Analysis','Data quality'],infrastructure:['Server inventory','Monitoring','Change review'],research:['Source research','Evidence notes','Fact checking']};
const keywords:Record<string,string[]>={development:['code','github','git','test'],marketing:['content','campaign','brand','search'],sales:['crm','sales','pipeline'],support:['ticket','customer','knowledge'],finance:['spreadsheet','account','calculator','invoice'],security:['security','audit','access'],hr:['recruit','onboard','employee'],education:['teach','course','learn','document'],legal:['legal','compliance','document','research'],data:['data','analysis','spreadsheet'],research:['search','research','summar','note'],design:['design','image','layout'],production:['video','voice','genvr'],wellness:['fitness','wellness','health']};
export async function teamResources(raw:Record<string,unknown>){
 if(Object.keys(raw).some(k=>!['departments','roles'].includes(k)))throw new CompanyPlanInputError('Unexpected field');
 const departments=parseDepartments(raw.departments);
 const roles=raw.roles===undefined?[]:raw.roles;
 if(!Array.isArray(roles)||roles.length>300||!roles.every(r=>r&&typeof r==='object'&&Object.keys(r).sort().join(',')==='department,name'&&departments.includes(r.department)&&typeof r.name==='string'&&r.name.trim()&&r.name.length<=80))throw new CompanyPlanInputError('Invalid role selection');
 const [skills,servers,templates]=await Promise.all([centralSkills().list(),listServers(),sql().read(all<{name:string;department:string;config_json:string}>('SELECT name,department,config_json FROM specialty_templates'))]);
 return {departments:departments.map(department=>{
  const label=DEPARTMENTS.find(d=>d.id===department)?.label??department;
  const groupName=SPECIALTY_DEPARTMENT_GROUPS[department]??SPECIALTY_GROUPS.find(g=>g.name.toLowerCase()===department)?.name;
  const chosen:string[]=roles.filter(r=>r.department===department).map(r=>String(r.name).toLowerCase());
  const required=new Set<string>();const configuredNeeds:string[]=[];
  for(const t of templates.filter(t=>t.department===department&&chosen.includes(t.name.toLowerCase()))){try{const c=JSON.parse(t.config_json);for(const id of [c.primarySkill,...(Array.isArray(c.skills)?c.skills:[])])if(typeof id==='string')required.add(id);for(const r of Array.isArray(c.requirements)?c.requirements:[])if(typeof r.name==='string')configuredNeeds.push(r.name.slice(0,160));}catch{/* Invalid configuration never becomes a recommendation. */}}
  const keys=[...(keywords[department]??['document','search','note']),...chosen.flatMap(n=>n.split(/[^a-z0-9]+/).filter(w=>w.length>4&&!['specialist','manager','reviewer'].includes(w)))];
  const match=(text:string)=>keys.find(k=>new RegExp('(^|[^a-z0-9])'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(text));
  const tpl=BOARD_TEMPLATES.find(t=>t.id===templateForDepartment(label))??BOARD_TEMPLATES[0];
  return {department,label,board:{name:tpl.name,columns:[...tpl.columns]},needs:[...new Set([...(needs[department]??['Task planning','Document review','Source research']),...configuredNeeds])].slice(0,15),
   skills:skills.filter(s=>required.has(s.id)||match(s.name+' '+s.description)).slice(0,8).map(s=>({id:s.id,name:s.name,reason:required.has(s.id)?'Selected specialty configuration':'Keyword match; review instructions before assigning'})),
   connections:servers.filter(s=>match(s.name+' '+(s.description??''))).slice(0,8).map(s=>({id:s.id,name:s.name,state:!s.enabled?'disabled':!s.active?'blocked':s.lastError?'needs-attention':connectionState(s.id),reason:'Keyword match; review tools and per-agent access'})),
   pendingRoles:PLANNED_SPECIALTIES.filter(p=>p.groups.includes(groupName??'')&&!templates.some(t=>t.name.toLowerCase()===p.name.toLowerCase())).slice(0,8).map(p=>p.name)};
 })};
}
