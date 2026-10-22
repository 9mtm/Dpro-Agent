'use strict';
/** Serve reviewed SDK bytes; never turn its asset paths into a general file server. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {VERSION,SHA256}=require('./prepare-genvr.cjs');
const CSP="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; media-src 'self' blob:; connect-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.ogg':'audio/ogg','.wav':'audio/wav','.mp3':'audio/mpeg','.glb':'model/gltf-binary'};
function readAsset(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>128*1024*1024)throw Error();const data=Buffer.alloc(stat.size+1);let used=0;while(used<data.length){const n=fs.readSync(fd,data,used,data.length-used,null);if(!n)break;used+=n;}if(used>stat.size)throw Error();return data.subarray(0,used);}finally{fs.closeSync(fd);}
}
function createGenVRAssets(root,studioToken=()=>null){
 let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(root,'vendor/genvr/manifest.json')));if(manifest.version!==VERSION||manifest.archiveSha256!==SHA256)manifest=null;}catch{manifest=null;}
 return function serve(req,res,pathname){
  const shell=pathname==='/genvr/studio.html'||pathname==='/genvr/avatar.html',host=pathname==='/genvr/host.js'||pathname==='/genvr/avatar-host.js';
  const name=pathname.startsWith('/genvr/dist/')?pathname.slice('/genvr/'.length):'dist/studio-assets'+pathname;
  if(!shell&&!host&&!manifest?.files?.[name])return false;
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return true;}
  try{
   if(!manifest)throw Error();let data;
   if(shell){const token=studioToken();data=Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GenVR Studio</title>'+(token&&/^[a-f0-9]{64}$/.test(token)?'<meta name="genvr-studio-token" content="'+token+'">':'')+'<link rel="stylesheet" href="/genvr/dist/studio.css"><body>'+(pathname==='/genvr/avatar.html'?'<div id="avatar" style="position:fixed;inset:0"></div><script type="module" src="/genvr/avatar-host.js"></script>':'<div id="studio"></div><script type="module" src="/genvr/host.js"></script>')+'</body></html>');res.setHeader('Content-Security-Policy',CSP);res.setHeader('X-Frame-Options','SAMEORIGIN');}
   else if(host)data=fs.readFileSync(path.join(__dirname,pathname==='/genvr/avatar-host.js'?'genvr-avatar-host.js':'genvr-host.js'));
   else{if(name.split('/').some(part=>!part||part==='..'||part==='.')||name.includes('\\'))throw Error();const base=path.resolve(root,'vendor/genvr/package');const file=path.resolve(base,name);if(!file.startsWith(base+path.sep)||fs.realpathSync(file)!==file)throw Error();data=readAsset(file);if(crypto.createHash('sha256').update(data).digest('hex')!==manifest.files[name])throw Error();}
   res.writeHead(200,{'Content-Type':shell?'text/html; charset=utf-8':host?'text/javascript; charset=utf-8':types[path.extname(name)]??'application/octet-stream','Content-Length':data.length});res.end(req.method==='HEAD'?undefined:data);
  }catch{res.writeHead(503,{'Content-Type':'text/plain'});res.end('GenVR is unavailable in this build.');}return true;
 };
}
module.exports={createGenVRAssets};
