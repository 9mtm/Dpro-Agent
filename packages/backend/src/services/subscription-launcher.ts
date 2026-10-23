/** Detached Node leader starts no provider until its durable process record is acknowledged. */
import {spawn,type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {SubscriptionProcesses} from './subscription-processes.js';
const SHIM=`
const {spawn}=require('node:child_process');
let child,started=false,stopping=false,done=false;
function stop(){if(stopping)return;stopping=true;try{process.kill(-process.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}},150);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.on('disconnect',()=>{if(!done)stop();});
process.on('message',m=>{if(started||!m||m.type!=='start')return;started=true;
 try{child=spawn(m.program,m.args,{shell:false,stdio:['pipe','pipe','pipe'],env:process.env});
 child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});child.stdin.end(m.prompt);
 child.on('error',()=>stop());
 child.on('close',(code,signal)=>{if(stopping)return;done=true;if(process.connected)process.send({type:'done',code:Number.isInteger(code)?code:1},stop);else stop();});
 }catch{stop();}});
if(process.connected)process.send({type:'ready'});else stop();
`;
export async function launchTrackedSubscription(manager:SubscriptionProcesses,program:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv}):Promise<{child:ChildProcess;start:(prompt:string)=>void;completion:Promise<number>}>{
 if(process.platform==='win32'||!path.isAbsolute(program)||!Array.isArray(args)||args.length>256||args.some(a=>typeof a!=='string'||a.length>65536)||!path.isAbsolute(options.cwd))throw Error('subscription_launch_invalid');
 const child=spawn(process.execPath,['-e',SHIM],{cwd:options.cwd,env:options.env,detached:true,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 let journal:string|undefined,done=false,exitCode=1;
 let finishCompletion:(value:number)=>void=()=>{};const completion=new Promise<number>(resolve=>{finishCompletion=resolve;});
 child.on('message',m=>{if(m&&typeof m==='object'&&'type' in m&&m.type==='done'){done=true;exitCode='code' in m&&Number.isInteger(m.code)?Number(m.code):1;}});
 child.once('close',()=>{if(done&&journal)manager.forgetIfAbsent(journal);finishCompletion(done?exitCode:1);});
 child.once('exit',()=>{if(!done)finishCompletion(1);});
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>finish(Error('subscription_launch_unavailable')),5000);const message=(m:unknown)=>{if(m&&typeof m==='object'&&'type' in m&&m.type==='ready')finish();};const failed=()=>finish(Error('subscription_launch_unavailable'));function finish(error?:Error){clearTimeout(timer);child.off('message',message);child.off('error',failed);child.off('exit',failed);error?reject(error):resolve();}child.on('message',message);child.once('error',failed);child.once('exit',failed);});
  if(!child.pid)throw Error('subscription_launch_unavailable');journal=manager.register(child.pid,process.execPath);
 }catch{if(child.connected)child.disconnect();throw Error('subscription_launch_unavailable');}
 let started=false;
 return {child,completion,start(prompt:string){
  if(started||typeof prompt!=='string'||Buffer.byteLength(prompt,'utf8')>200000||!child.connected){if(child.connected)child.disconnect();throw Error('subscription_launch_invalid');}
  started=true;
  try{child.send({type:'start',program,args,prompt},error=>{if(error&&child.connected)child.disconnect();});}catch{if(child.connected)child.disconnect();throw Error('subscription_launch_unavailable');}
 }};
}
