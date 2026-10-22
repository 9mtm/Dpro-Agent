const BASE='/api/scheduler/jobs';
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x)&&!x.includes('..');
const text=(x,max)=>typeof x==='string'?x.slice(0,max).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,''):'';
const date=x=>typeof x==='string'&&x.length<=40&&Number.isFinite(Date.parse(x))?x:null;
export function schedulerRoute(path){
 if(path===BASE)return {kind:'list'};
 if(typeof path!=='string')return null;
 const m=/^\/api\/scheduler\/jobs\/([^/?#]+)(?:\/(history|enable|disable|execute))?$/.exec(path);if(!m)return null;
 let id;try{id=decodeURIComponent(m[1]);}catch{return null;}
 return validId(id)&&encodeURIComponent(id)===m[1]?{kind:m[2]??'detail',id}:null;
}
export function allowedScheduler(method,path,body){const r=schedulerRoute(path);if(!r)return false;return ['list','detail','history'].includes(r.kind)?method==='GET'&&body===undefined:method==='POST'&&body!==null&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===0;}
const job=x=>{if(!x||!validId(x.id)||typeof x.enabled!=='boolean'||typeof x.name!=='string'||typeof x.cronExpression!=='string')throw Error('protocol');return {id:x.id,name:text(x.name,180),description:text(x.description,1000),cronExpression:text(x.cronExpression,180),actionType:text(x.actionType,60),enabled:x.enabled,responsibility:text(x.responsibility,250)||'Workspace service',lastRun:date(x.lastRun),nextRun:date(x.nextRun)};};
export function schedulerResponse(path,status,body){
 const r=schedulerRoute(path);if(!r)throw Error('protocol');
 if(status!==200)return {code:'schedule_unavailable'};
 if(r.kind==='list'){if(!body||body.success!==true||!Array.isArray(body.jobs)||body.jobs.length>2000)throw Error('protocol');return {success:true,jobs:body.jobs.map(job)};}
 if(r.kind==='detail'){const selected=job(body?.job);if(selected.id!==r.id)throw Error('protocol');return {success:true,job:selected};}
 if(r.kind==='history'){if(!body||body.success!==true||!Array.isArray(body.history)||body.history.length>100)throw Error('protocol');return {success:true,history:body.history.map(x=>{if(!x||typeof x.success!=='boolean')throw Error('protocol');return {success:x.success,executedAt:date(x.executedAt),duration:typeof x.duration==='number'&&Number.isFinite(x.duration)&&x.duration>=0?Math.min(x.duration,86400000):null};})};}
 if(typeof body?.success!=='boolean')throw Error('protocol');return {success:body.success};
}
