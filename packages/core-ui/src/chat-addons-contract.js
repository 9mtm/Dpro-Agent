export const CHAT_ADDONS_PATH='/api/chat/addons';
export const chatAddonsRoute=path=>path===CHAT_ADDONS_PATH;
export const allowedChatAddons=(method,path,body)=>chatAddonsRoute(path)&&method==='GET'&&body===undefined;
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function chatAddonsResponse(status,body){
 if(status!==200)return {code:status===403?'local_owner_required':'addons_unavailable'};
 if(!record(body)||!Array.isArray(body.items)||body.items.length>500||!Array.isArray(body.sources)||body.sources.length>2)throw Error('protocol');
 const items=body.items.map(x=>{if(!record(x)||typeof x.name!=='string'||!x.name.length||x.name.length>180||!['claude-code','codex'].includes(x.source)||!['plugin','hook'].includes(x.kind)||!(x.enabled===null||typeof x.enabled==='boolean')||!(x.installed===null||typeof x.installed==='boolean')||!Number.isSafeInteger(x.count)||x.count<0||x.count>1000)throw Error('protocol');return {name:x.name,...(typeof x.label==='string'&&x.label.length<=100?{label:x.label}:{}),source:x.source,kind:x.kind,enabled:x.enabled,installed:x.installed,count:x.count};});
 return {items,sources:body.sources.map(x=>{if(!record(x)||!['claude-code','codex'].includes(x.source)||!['read','missing','unavailable','limited'].includes(x.status))throw Error('protocol');return {source:x.source,status:x.status};})};
}
