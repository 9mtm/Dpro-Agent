// Channel configuration is separate from MCP connectors and never starts providers.
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[a-z][a-z0-9_]{0,47}$/.test(x);
const list=x=>Array.isArray(x)&&x.length<=100&&x.every(v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\r\n\0]/.test(v));
export const AGENT_CONNECT_PATH='/api/agent-connect';
export function channelRoute(path){return path===AGENT_CONNECT_PATH+'/catalog'||/^\/api\/agent-connect\/[a-z][a-z0-9_]{0,47}\/(config|activation)$/.test(path);}
export function allowedChannel(method,path,body){
 if(path===AGENT_CONNECT_PATH+'/catalog')return method==='GET'&&body===undefined;
 if(path.endsWith('/activation'))return channelRoute(path)&&method==='PUT'&&record(body)&&Object.keys(body).length===1&&typeof body.enabled==='boolean';
 if(!channelRoute(path)||method!=='PUT'||!record(body)||Object.keys(body).some(k=>!['allowedUsers','allowedChannels','environment','settings'].includes(k))||!list(body.allowedUsers)||!list(body.allowedChannels))return false;
 if(body.environment!==undefined&&(!record(body.environment)||Object.keys(body.environment).length>64||!Object.entries(body.environment).every(([k,v])=>/^[A-Z][A-Z0-9_]{0,127}$/.test(k)&&typeof v==='string'&&v.length<=16384&&!v.includes('\0'))))return false;
 return body.settings===undefined||(record(body.settings)&&JSON.stringify(body.settings).length<=32768);
}
function state(x){if(!record(x)||!id(x.id)||!list(x.allowedUsers)||!list(x.allowedChannels))throw Error('protocol');return {id:x.id,enabled:x.enabled===true,state:['disabled','connected','connecting','reconnecting','error','disconnected','restart_required'].includes(x.state)?x.state:'disconnected',configured:x.configured===true,hasSecrets:x.hasSecrets===true,allowedUsers:x.allowedUsers,allowedChannels:x.allowedChannels};}
export function channelResponse(path,status,body){
 if(!channelRoute(path))throw Error('protocol');
 if(status!==200)return record(body)&&['invalid_input','not_found','unsupported_store','forbidden','unavailable'].includes(body.code)?{code:body.code}:null;
 if(!record(body))throw Error('protocol');
 if(path===AGENT_CONNECT_PATH+'/catalog'){
  if(!Array.isArray(body.channels)||body.channels.length>64)throw Error('protocol');const seen=new Set();
  return {configurable:body.configurable===true,channels:body.channels.map(c=>{
   const s=state(c);if(seen.has(s.id)||typeof c.label!=='string'||c.label.length>100||!['node','python'].includes(c.runtime)||!Array.isArray(c.requiredEnv)||c.requiredEnv.length>64||!c.requiredEnv.every(v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(v))||typeof c.prerequisites!=='string'||c.prerequisites.length>2000)throw Error('protocol');seen.add(s.id);return {...s,label:c.label,runtime:c.runtime,requiredEnv:c.requiredEnv,prerequisites:c.prerequisites};
  })};
 }
 if(body.saved!==true||body.channel?.id!==path.split('/')[3])throw Error('protocol');return {saved:true,channel:state(body.channel)};
}
