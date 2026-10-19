// Settings → Connections (owner only): applications linked through an account grant.
// No token, device code or other secret is ever accepted from or passed to the page.
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const text=(x,n)=>typeof x==='string'&&x.length<=n&&!/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(x);
const time=x=>x===null||(typeof x==='string'&&x.length<=40&&!Number.isNaN(Date.parse(x)));
export const CONNECTIONS_PATH='/api/connections';
const GENVR=CONNECTIONS_PATH+'/genvr';
const CONTENT=['violence','blood','horror','romance','userChat','paidItems'];
const ERRORS=['invalid_input','forbidden','relink_required','missing_scope','not_found','conflict','rejected','unavailable','other_account','published_unpublish_first','upload_first','embedded_assets','link_expired'];
export function connectionsRoute(path){return path===CONNECTIONS_PATH||[GENVR+'/link',GENVR+'/cancel',GENVR+'/disconnect',GENVR+'/publications',GENVR+'/test-world/upload',GENVR+'/test-world/publish'].includes(path);}
export function allowedConnections(method,path,body){
 if(!connectionsRoute(path))return false;
 if(path===CONNECTIONS_PATH||path===GENVR+'/publications')return method==='GET'&&body===undefined;
 if(method!=='POST'||!record(body))return false;
 const keys=Object.keys(body).sort().join(',');
 if(path===GENVR+'/link'||path===GENVR+'/cancel')return keys==='';
 if(path===GENVR+'/disconnect'||path===GENVR+'/test-world/upload')return keys==='confirm'&&body.confirm===true;
 return keys==='access,confirm,content,title,type'&&body.confirm===true&&text(body.title,120)&&body.title.trim().length>0&&['game','event','social'].includes(body.type)&&['public','friends','invite'].includes(body.access)
  &&record(body.content)&&Object.keys(body.content).sort().join(',')===[...CONTENT].sort().join(',')&&CONTENT.every(k=>typeof body.content[k]==='boolean');
}
function https(x){if(!text(x,500))return false;try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}
function connection(x){
 if(!record(x)||x.id!=='genvr'||!['not_connected','connecting','connected','expired','error'].includes(x.status)||!Array.isArray(x.scopes)||x.scopes.length>10||!x.scopes.every(s=>text(s,40))||!time(x.linkedAt)||!time(x.expiresAt))throw Error('protocol');
 const account=x.account===null?null:record(x.account)&&text(x.account.name,200)?{name:x.account.name}:(()=>{throw Error('protocol');})();
 const pending=x.pending===null?null:record(x.pending)&&text(x.pending.userCode,32)&&https(x.pending.verificationUri)&&time(x.pending.expiresAt)?{userCode:x.pending.userCode,verificationUri:x.pending.verificationUri,expiresAt:x.pending.expiresAt}:(()=>{throw Error('protocol');})();
 return {id:'genvr',name:'Genvr',status:x.status,account,scopes:[...x.scopes],linkedAt:x.linkedAt,expiresAt:x.expiresAt,pending,error:ERRORS.includes(x.error)?x.error:null};
}
function publication(x){
 if(!record(x)||!text(x.localId,100)||!text(x.serverId,100)||!text(x.title,200)||!['draft','published'].includes(x.status)||!Number.isSafeInteger(x.version)||x.version<0||!text(x.access,20)||!(x.link===null||https(x.link))||!time(x.updatedAt))throw Error('protocol');
 return {localId:x.localId,serverId:x.serverId,title:x.title,status:x.status,version:x.version,access:x.access,link:x.link,updatedAt:x.updatedAt};
}
export function connectionsResponse(path,status,body){
 if(!connectionsRoute(path))throw Error('protocol');
 if(status!==200)return record(body)&&ERRORS.includes(body.code)?{code:body.code}:null;
 if(!record(body))throw Error('protocol');
 if(path===CONNECTIONS_PATH){if(!Array.isArray(body.connections)||body.connections.length>20)throw Error('protocol');return {connections:body.connections.map(connection)};}
 if(path===GENVR+'/publications'){if(!Array.isArray(body.publications)||body.publications.length>100)throw Error('protocol');return {publications:body.publications.map(publication)};}
 if(path.startsWith(GENVR+'/test-world/'))return {publication:publication(body.publication)};
 return {connection:connection(body.connection)};
}
