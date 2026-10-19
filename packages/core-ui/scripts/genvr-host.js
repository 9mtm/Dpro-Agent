let mountStudio;
const channel=location.hash.slice(1),pending=new Map();let studio,sequence=0;
const send=value=>parent.postMessage({type:'dpro-genvr',channel,...value},location.origin);
function request(operation,value){const id=String(++sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Studio storage did not respond. Keep this project open and retry saving.'));},30000);pending.set(id,{resolve,reject,timer});send({id,operation,value});});}
window.addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='dpro-genvr'||event.data.channel!==channel)return;
 const data=event.data;
 if(data.response){const work=pending.get(data.id);if(!work)return;pending.delete(data.id);clearTimeout(work.timer);data.ok?work.resolve(data.value):work.reject(Error(data.conflict?'This project changed elsewhere. Export your edits before reopening it.':'Studio storage is unavailable. Keep this project open and retry saving.'));}
 if(data.operation==='start'&&!studio){
  try{
   if(typeof data.storageNamespace!=='string'||!data.storageNamespace)throw Error();
   await isolateBrowserCache(data.storageNamespace);
   const sdk=await import('/genvr/dist/studio.js');mountStudio=sdk.mountStudio;
   const host=await studioHost(typeof data.privateLibrary==='string'&&/^[a-f0-9]{64}$/.test(data.privateLibrary)?data.privateLibrary:null);
   studio=mountStudio(document.getElementById('studio'),{filmExample:false,forceWebGL:true,initialProjectId:data.projectId,...host,agents:id=>request('agents',id),catalog:{list:()=>request('catalog-list'),asset:id=>request('catalog-asset',id)},storage:{list:()=>request('list'),read:id=>request('read',id),write:project=>request('write',project)}});
   send({operation:'mounted'});if(sdk.STUDIO_HOST_VERSION!==1&&typeof data.projectId==='string')openExisting(data.projectId);
  }catch{send({operation:'unavailable'});}
 }
 if(data.operation==='close'){try{send({operation:'closed',ok:await studio?.dispose()===true});}catch{send({operation:'closed',ok:false});}}
});
send({operation:'ready'});

// Adapt the SDK's platform exit link to this local host without navigating away.
document.addEventListener('click',event=>{
 const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;
 if(!anchor)return;const target=new URL(anchor.href,location.origin);
 if(target.origin===location.origin&&/^\/places\/[a-zA-Z0-9_-]+$/.test(target.pathname)){
  event.preventDefault();event.stopPropagation();void (async()=>{try{send({operation:'closed',ok:await studio?.dispose()===true});}catch{send({operation:'closed',ok:false});}})();
 }
},true);

// Studio film/media caches stay in this frame's account namespace. Project
// snapshots use the authenticated host storage above, never this browser cache.
async function isolateBrowserCache(account){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(account));
 const prefix='dpro-genvr-'+Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,'0')).join('')+':';
 const factory=window.indexedDB;
 const scoped=new Proxy(factory,{get(target,key){
  if(key==='open')return(name,version)=>version===undefined?target.open(prefix+name):target.open(prefix+name,version);
  if(key==='deleteDatabase')return name=>target.deleteDatabase(prefix+name);
  if(key==='databases')return async()=> (await target.databases()).filter(row=>row.name?.startsWith(prefix)).map(row=>({...row,name:row.name.slice(prefix.length)}));
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 Object.defineProperty(window,'indexedDB',{value:scoped});
 const store=window.localStorage;
 Object.defineProperty(window,'localStorage',{value:new Proxy(store,{get(target,key){
  if(key==='getItem')return name=>target.getItem(prefix+name);
  if(key==='setItem')return(name,value)=>target.setItem(prefix+name,value);
  if(key==='removeItem')return name=>target.removeItem(prefix+name);
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }})});
}

// Compatibility for the frozen SDK until the reviewed host API version is consumed.
function openExisting(id){
 const choose=()=>{const select=document.querySelector('select[aria-label="Open project"]');if(!(select instanceof HTMLSelectElement)||!Array.from(select.options).some(option=>option.value===id))return false;select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));return true;};
 if(choose())return;const observer=new MutationObserver(()=>{if(choose()){observer.disconnect();clearTimeout(timer);}});observer.observe(document.getElementById('studio'),{childList:true,subtree:true});const timer=setTimeout(()=>{observer.disconnect();send({operation:'open-failed'});},10000);
}

// Live bridge (live MCP + local voice) and, for the owner, the private library.
// The token is injected into this frame's shell by the local application server.
async function studioHost(ticket){
 const token=document.querySelector('meta[name="genvr-studio-token"]')?.content;
 if(!token||!/^[a-f0-9]{64}$/.test(token))return {};
 const call=async(route,body,raw)=>{const r=await fetch('/studio-library/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Studio-Library':ticket,'Content-Type':'application/json'},body:JSON.stringify(body??{})});if(!r.ok){let m='Library request failed.';try{m=(await r.json()).error||m;}catch{}throw Error(m);}return raw?r.arrayBuffer():r.json();};
 const options={liveBridge:{url:location.origin,token}};
 if(!ticket)return options;
 const listeners=new Set(),changed=()=>{for(const l of listeners)try{l();}catch{}};
 options.userLibrary={scope:'dpro-owner',storage:{
  list:async()=>(await call('list')).assets,
  get:async id=>{const all=(await call('list')).assets;const metadata=all.find(a=>a.id===id);if(!metadata)return null;return {metadata,data:await call('get',{id},true)};},
  put:async asset=>{const meta=btoa(unescape(encodeURIComponent(JSON.stringify(asset.metadata)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');const r=await fetch('/studio-library/put',{method:'POST',headers:{Authorization:'Bearer '+token,'X-Studio-Library':ticket,'Content-Type':'application/octet-stream','X-Library-Metadata':meta},body:asset.data});if(!r.ok){let m='Saving the library item failed.';try{m=(await r.json()).error||m;}catch{}throw Error(m);}changed();},
  remove:async id=>{await call('remove',{id});changed();},
  assignment:async(projectId,target)=>(await call('assignment',{projectId,target})).assetId,
  assign:async(projectId,target,assetId)=>{await call('assign',{projectId,target,assetId});changed();},
  subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  close(){listeners.clear();},
 }};
 try{const {motions}=await call('motions');if(motions.length)options.motionLibrary={entries:motions.map(m=>({id:m.id,name:m.name,category:m.category,loop:m.loop,load:()=>call('motion',{id:m.id},true)}))};}catch{/* no private motion library on this computer */}
 return options;
}
