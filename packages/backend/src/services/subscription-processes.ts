/** Private process journal; exact birth/executable identity is required before signalling a group. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
type Identity={pid:number;ppid:number;pgid:number;uid:number;birth:string;executable:string};
type Entry={version:1;backend:Identity;child:Identity};
const positive=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>1;
const DARWIN_PROBE=`import ctypes,struct,sys,json,os
p=int(sys.argv[1]);lib=ctypes.CDLL('/usr/lib/libproc.dylib');b=ctypes.create_string_buffer(136)
n=lib.proc_pidinfo(p,3,0,b,136)
if n!=136:sys.exit(1)
v=struct.unpack('=12I16s32s5IiQQ',b.raw)
if v[1]==5:sys.exit(1)
s=ctypes.create_string_buffer(4096)
if lib.proc_pidpath(p,s,4096)<=0:sys.exit(1)
print(json.dumps(dict(pid=v[3],ppid=v[4],pgid=v[15],uid=v[5],birth=str(v[20])+':'+str(v[21]),executable=s.value.decode())))
`;
/** Darwin requires the already present system Python/libproc; failure never falls back to coarse ps times. */
export function subscriptionProcessIdentity(pid:number,pythonPath?:string):Identity|null{
 if(!positive(pid))return null;
 try{
  if(process.platform==='darwin'){
   if(!pythonPath||!path.isAbsolute(pythonPath))return null;
   const value=JSON.parse(execFileSync(pythonPath,['-c',DARWIN_PROBE,String(pid)],{encoding:'utf8',timeout:2000,maxBuffer:8192,stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}}));
   return valid(value)?value:null;
  }
  if(process.platform==='linux'){
   const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
   if(fields[0]==='Z')return null;
   const value={pid,ppid:Number(fields[1]),pgid:Number(fields[2]),uid:fs.statSync(`/proc/${pid}`).uid,birth:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fields[19],executable:fs.readlinkSync(`/proc/${pid}/exe`)};
   return valid(value)?value:null;
  }
 }catch{}return null;
}
function valid(x:unknown):x is Identity{
 if(!x||typeof x!=='object')return false;const v=x as Identity;
 return positive(v.pid)&&Number.isSafeInteger(v.ppid)&&v.ppid>=0&&positive(v.pgid)&&Number.isSafeInteger(v.uid)&&v.uid>=0&&typeof v.birth==='string'&&v.birth.length>0&&v.birth.length<160&&typeof v.executable==='string'&&path.isAbsolute(v.executable)&&v.executable.length<4096;
}
const exists=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}};
const same=(a:Identity,b:Identity)=>a.pid===b.pid&&a.pgid===b.pgid&&a.uid===b.uid&&a.birth===b.birth&&a.executable===b.executable;
/** Journal location must be a dedicated server-private directory, never a workspace selected by an agent. */
export class SubscriptionProcesses{
 readonly #root:string;readonly #backend:Identity;readonly #pythonPath:string|undefined;
 constructor(directory:string,options:{pythonPath?:string}={}){
  this.#pythonPath=options.pythonPath;
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const info=fs.lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw Error('process_journal_unavailable');
  this.#root=fs.realpathSync(directory);const backend=subscriptionProcessIdentity(process.pid,this.#pythonPath);if(!backend||backend.uid!==process.getuid?.())throw Error('process_identity_unavailable');this.#backend=backend;
 }
 register(pid:number,expectedExecutable:string):string{
  const child=subscriptionProcessIdentity(pid,this.#pythonPath);
  if(!child||child.ppid!==process.pid||child.pgid!==pid||child.uid!==this.#backend.uid||child.executable!==fs.realpathSync(expectedExecutable))throw Error('process_identity_unavailable');
  if(this.#files().length>=64)throw Error('process_journal_full');
  const id=randomUUID(),file=path.join(this.#root,id+'.json');const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,JSON.stringify({version:1,backend:this.#backend,child} satisfies Entry));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}this.#sync();return id;
 }
 /** Call on child close. Does not signal processes. */
 forget(id:string){if(!/^[a-f0-9-]{36}$/.test(id))return;const file=path.join(this.#root,id+'.json');try{fs.unlinkSync(file);this.#sync();}catch{}}
 /** A closed leader does not prove its descendants are gone. Never discard that recovery evidence. */
 forgetIfAbsent(id:string):boolean{
  if(!/^[a-f0-9-]{36}$/.test(id))return false;const entry=this.#read(id+'.json');
  if(!entry||exists(entry.child.pid)||exists(-entry.child.pgid))return false;
  this.forget(id);return true;
 }
 #sync(){const fd=fs.openSync(this.#root,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 #files(){const names=fs.readdirSync(this.#root).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));if(names.length>128)throw Error('process_journal_full');return names;}
 #read(name:string):Entry|null{try{const file=path.join(this.#root,name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==this.#backend.uid||(s.mode&0o077)!==0||s.size>16384)return null;const e=JSON.parse(fs.readFileSync(fd,'utf8'));return e.version===1&&valid(e.backend)&&valid(e.child)&&e.child.pgid===e.child.pid&&e.child.uid===this.#backend.uid&&e.backend.uid===this.#backend.uid?e:null;}finally{fs.closeSync(fd);}}catch{return null;}}
 async #clean(own:boolean){let ended=0,skipped=0;
  for(const name of this.#files()){
   const e=this.#read(name);if(!e){skipped++;continue;}
   const backend=subscriptionProcessIdentity(e.backend.pid,this.#pythonPath);
   if(own?!same(e.backend,this.#backend):backend?same(backend,e.backend):exists(e.backend.pid)){skipped++;continue;}
   const child=subscriptionProcessIdentity(e.child.pid,this.#pythonPath);
   if(!child||!same(child,e.child)){
    // A dead leader alone does not prove that its group has no surviving descendants.
    if(!child&&!exists(e.child.pid)&&!exists(-e.child.pgid))this.forget(name.slice(0,-5));else skipped++;
    continue;
   }
   try{process.kill(-e.child.pgid,'SIGTERM');}catch{skipped++;continue;}
   await new Promise(resolve=>setTimeout(resolve,100));
   const current=subscriptionProcessIdentity(e.child.pid,this.#pythonPath);
   if(current&&same(current,e.child)){try{process.kill(-current.pgid,'SIGKILL');}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
   const after=subscriptionProcessIdentity(e.child.pid,this.#pythonPath);
   if(after&&same(after,e.child)||!after&&exists(e.child.pid)||exists(-e.child.pgid)){skipped++;continue;}
   ended++;this.forget(name.slice(0,-5));
  }return {ended,skipped};
 }
 /** Leaves groups belonging to another still-live backend alone. */
 sweepOrphans(){return this.#clean(false);}
 shutdown(){return this.#clean(true);}
}
