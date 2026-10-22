export const TEAM_RESOURCES_PATH='/api/onboarding/team-resources';
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const line=(x,max)=>typeof x==='string'&&x.length<=max;
const dep=x=>line(x,64)&&x.length>0&&x===x.toLowerCase()&&/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(x);
export function allowedTeamResources(method,body){return method==='POST'&&record(body)&&Object.keys(body).every(k=>['departments','roles'].includes(k))&&Array.isArray(body.departments)&&body.departments.length>0&&body.departments.length<=72&&body.departments.every(dep)&&new Set(body.departments).size===body.departments.length&&(body.roles===undefined||Array.isArray(body.roles)&&body.roles.length<=300&&body.roles.every(r=>record(r)&&Object.keys(r).sort().join(',')==='department,name'&&body.departments.includes(r.department)&&line(r.name,80)&&r.name.trim()));}
const fail=()=>{throw Error('Invalid team resource response');};
export function teamResourcesResponse(status,body){
 if(status!==200)return record(body)&&['invalid_plan','resources_unavailable'].includes(body.code)?{code:body.code}:null;
 if(!record(body)||!Array.isArray(body.departments)||body.departments.length>72)fail();
 return {departments:body.departments.map(d=>{
  if(!record(d)||!dep(d.department)||!line(d.label,80)||!record(d.board)||!line(d.board.name,80)||!Array.isArray(d.board.columns)||d.board.columns.length>20||!d.board.columns.every(x=>line(x,60)))fail();
  for(const [key,max,count] of [['needs',160,15],['pendingRoles',80,8]])if(!Array.isArray(d[key])||d[key].length>count||!d[key].every(x=>line(x,max)))fail();
  for(const key of ['skills','connections'])if(!Array.isArray(d[key])||d[key].length>8||!d[key].every(x=>record(x)&&line(x.id,100)&&line(x.name,100)&&line(x.reason,200)))fail();
  if(!d.connections.every(x=>['disabled','blocked','needs-attention','connected','connecting','disconnected','unknown'].includes(x.state)))fail();
  return {department:d.department,label:d.label,board:{name:d.board.name,columns:d.board.columns},needs:d.needs,pendingRoles:d.pendingRoles,skills:d.skills.map(x=>({id:x.id,name:x.name,reason:x.reason})),connections:d.connections.map(x=>({id:x.id,name:x.name,reason:x.reason,state:x.state}))};
 })};
}
