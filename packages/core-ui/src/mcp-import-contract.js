const root='/api/mcp-import/';
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const text=(x,n)=>typeof x==='string'&&x.length<=n;
export function mcpImportPath(path){return ['scan','preview','import'].some(a=>path===root+a);}
export function allowedMcpImport(method,path,body){if(method!=='POST'||!mcpImportPath(path)||!record(body))return false;const action=path.slice(root.length),keys=Object.keys(body).sort().join(',');return action==='scan'?keys==='':keys===(action==='preview'?'scanId,sourceId':'hash,scanId,sourceId')&&uuid(body.scanId)&&uuid(body.sourceId)&&(action==='preview'||typeof body.hash==='string'&&/^[a-f0-9]{64}$/.test(body.hash));}
export function mcpImportResponse(path,status,body){
 if(status!==200)return record(body)&&['forbidden','invalid_input','scan_not_found','source_not_found','preview_changed','name_conflict','unsupported_configuration','inline_secret_requires_manual_setup','url_credentials_require_manual_setup','import_unavailable','source_unavailable'].includes(body.code)?{code:body.code}:null;
 if(!record(body))throw Error('protocol');
 if(path===root+'scan'){
  if(!uuid(body.id)||!Number.isSafeInteger(body.skipped)||!Array.isArray(body.sources)||body.sources.length>500||!body.sources.every(s=>record(s)&&uuid(s.id)&&text(s.name,100)&&text(s.origin,80)&&typeof s.supported==='boolean'&&(s.issue===null||text(s.issue,80))))throw Error('protocol');
  return {id:body.id,skipped:body.skipped,sources:body.sources.map(s=>({id:s.id,name:s.name,origin:s.origin,supported:s.supported,issue:s.issue}))};
 }
 if(path===root+'import'){if(!uuid(body.id)||typeof body.duplicate!=='boolean')throw Error('protocol');return {id:body.id,duplicate:body.duplicate};}
 if(!text(body.name,24)||!['stdio','http','sse'].includes(body.transport)||!(body.command===null||text(body.command,1024))||!(body.url===null||text(body.url,2048))||!Array.isArray(body.args)||body.args.length>64||!body.args.every(a=>text(a,4096))||typeof body.allowRemote!=='boolean'||!text(body.hash,64)||!/^[a-f0-9]{64}$/.test(body.hash)||!(body.existingId===null||uuid(body.existingId)))throw Error('protocol');
 for(const key of ['envNames','headerNames'])if(!Array.isArray(body[key])||body[key].length>32||!body[key].every(s=>text(s,64)))throw Error('protocol');
 return {startupTimeoutMs:Number.isInteger(body.startupTimeoutMs)&&body.startupTimeoutMs>=1000&&body.startupTimeoutMs<=120000?body.startupTimeoutMs:null,name:body.name,transport:body.transport,command:body.command,args:body.args,url:body.url,allowRemote:body.allowRemote,hash:body.hash,existingId:body.existingId,envNames:body.envNames,headerNames:body.headerNames};
}
