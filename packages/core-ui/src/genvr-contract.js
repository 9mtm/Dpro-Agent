export const GENVR_BYTES=64*1024*1024;
export const GENVR_AGENTS='/api/genvr/agents';
export const validGenVRTeam=value=>Array.isArray(value)&&value.length<=200&&new Set(value.map(a=>a?.id)).size===value.length&&value.every(a=>record(a)&&Object.keys(a).sort().join(',')==='avatar,id'&&genvrId(a.id)&&Number.isInteger(a.avatar)&&a.avatar>=0&&a.avatar<8);
export const GENVR_PATH='/api/genvr/projects';
export const genvrId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validStudioProject(value){return record(value)&&value.format==='genvr-studio'&&value.version===1&&genvrId(value.id)&&typeof value.title==='string'&&value.title.length>0&&value.title.length<=200&&record(value.world)&&record(value.play);}
const marketId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)&&!value.includes('..');
export function genvrMarket(path){if(path==='/api/genvr/market')return true;const match=/^\/api\/genvr\/market(?:\?after=([A-Za-z0-9._-]+)|\/items\/([A-Za-z0-9._-]+))$/.exec(path);return !!match&&marketId(match[1]??match[2]);}
export function genvrRoute(path){return path==='/api/genvr/mcp/bootstrap'||genvrMarket(path)||path===GENVR_AGENTS||path===GENVR_PATH||path.startsWith(GENVR_PATH+'/')&&genvrId(path.slice(GENVR_PATH.length+1));}
export function allowedGenVR(method,path,body){if(!genvrRoute(path))return false;if(path==='/api/genvr/mcp/bootstrap')return method==='POST'&&record(body)&&Object.keys(body).length===0;if(method==='GET')return body===undefined;if(method!=='PUT'||genvrMarket(path)||(path===GENVR_PATH||path===GENVR_AGENTS)||!record(body)||!['project,revision','agents,project,revision'].includes(Object.keys(body).sort().join(','))||(body.agents!==undefined&&!validGenVRTeam(body.agents)))return false;return Number.isSafeInteger(body.revision)&&body.revision>=0&&body.revision<Number.MAX_SAFE_INTEGER&&validStudioProject(body.project)&&body.project.id===path.slice(GENVR_PATH.length+1)&&JSON.stringify(body.project).length<=GENVR_BYTES;}
export function genvrResponse(path,status,body){
 if(!genvrRoute(path))throw Error('protocol');
 if(status!==200)return record(body)&&['not_found','conflict','invalid_input','unsupported_store','unavailable','market_unavailable','forbidden'].includes(body.code)?{code:body.code}:null;
 if(!record(body))throw Error('protocol');
 if(path==='/api/genvr/mcp/bootstrap'){if(!['ready','blocked','disabled','unavailable','conflict'].includes(body.status)||!(body.id===null||typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id)))throw Error('protocol');return {status:body.status,id:body.id};}
 if(genvrMarket(path)){if(path.startsWith('/api/genvr/market/items/')){if(!record(body.asset)||body.asset.id!==path.slice('/api/genvr/market/items/'.length)||!record(body.asset.manifest)||!Array.isArray(body.asset.files))throw Error('protocol');return {asset:body.asset};}if(!Array.isArray(body.items)||body.items.length>200||!(body.next===null||marketId(body.next)))throw Error('protocol');return {items:body.items.map(item=>({manifest:item.manifest,picture:null,caption:item.caption,tags:item.tags})),next:body.next};}
 if(path===GENVR_AGENTS){if(!Array.isArray(body.agents)||body.agents.length>10000||!body.agents.every(a=>record(a)&&genvrId(a.id)&&typeof a.name==='string'&&a.name.length<=200&&(a.avatar===null||Number.isInteger(a.avatar)&&a.avatar>=0&&a.avatar<8)))throw Error('protocol');return {agents:body.agents.map(a=>({id:a.id,name:a.name,avatar:a.avatar}))};}
 if(path===GENVR_PATH){if(!Array.isArray(body.projects)||body.projects.length>1000||!body.projects.every(p=>record(p)&&genvrId(p.id)&&typeof p.title==='string'&&p.title.length<=200))throw Error('protocol');return {projects:body.projects.map(p=>({id:p.id,title:p.title,agentCount:Number.isSafeInteger(p.agentCount)&&p.agentCount>=0?p.agentCount:0}))};}
 if(!Number.isSafeInteger(body.revision)||body.revision<1)throw Error('protocol');
 if(body.saved===true)return {saved:true,revision:body.revision};
 if(!validStudioProject(body.project)||body.project.id!==path.slice(GENVR_PATH.length+1)||JSON.stringify(body.project).length>GENVR_BYTES)throw Error('protocol');
 if(body.agents!==undefined&&!validGenVRTeam(body.agents))throw Error('protocol');
 return {project:body.project,revision:body.revision,agents:body.agents??[]};
}
