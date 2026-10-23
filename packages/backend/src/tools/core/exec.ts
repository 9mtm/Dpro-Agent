/** Bounded host metadata commands only. No shell, interpreters or package execution. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpathSync,statSync} from 'node:fs';
import type {Tool,ToolResult} from '../types.js';
import {execToolRefusal,isExecToolsEnabled,minimalChildEnv,safeChildCwd} from '../exec-policy.js';
const executeFile=promisify(execFile);
const MAX_TIMEOUT=30000;
const fail=():ToolResult=>({content:[{type:'text',text:'Command refused by execution policy.'}],error:'Command not allowed by security policy'});
/** Deliberately small floor: unsupported commands require a separately reviewed capability. */
const BINARIES:Readonly<Record<string,string>>=Object.freeze({echo:'/bin/echo',pwd:'/bin/pwd',whoami:'/usr/bin/whoami',date:'/bin/date'});
/** Reject control syntax even inside quotes; quotes only group literal arguments. */
export function prepareExec(input:unknown):{file:string;args:string[];timeout:number}|null{
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const desc=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(desc).some(k=>typeof k!=='string'||!['command','timeout'].includes(k)||!Object.hasOwn(desc[k],'value')))return null;
 const command=desc.command?.value,requested=desc.timeout?desc.timeout.value:MAX_TIMEOUT;
 if(typeof command!=='string'||command.length<1||command.length>8192||typeof requested!=='number'||!Number.isSafeInteger(requested)||requested<1)return null;
 if(/[&;|<>`$\\(){}!*?\[\]\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(command))return null;
 const words:string[]=[];let token='',quote='',started=false;
 for(const c of command){if(quote){if(c===quote)quote='';else token+=c;started=true;}else if(c==='"'||c==="'"){quote=c;started=true;}else if(c===' '||c==='\t'){if(started){words.push(token);token='';started=false;}}else{token+=c;started=true;}if(words.length>64||token.length>2048)return null;}
 if(quote)return null;if(started)words.push(token);
 const [name,...args]=words;
 if(!name||!Object.hasOwn(BINARIES,name)||args.length>64)return null;
 if(name==='pwd'&&args.length||name==='whoami'&&args.length||name==='date'&&!(args.length===0||args.length===1&&args[0]==='-u'))return null;
 // echo flags differ across platforms. Literal flag-like arguments are unsupported.
 if(name==='echo'&&args.some(a=>a.startsWith('-')))return null;
 return {file:BINARIES[name],args,timeout:Math.min(requested,MAX_TIMEOUT)};
}
export const execTool:Tool={
 name:'exec',description:'Run bounded local metadata commands: echo, pwd, whoami or date. Requires execution policy and approval; shell syntax and programmable commands are refused.',
 input_schema:{type:'object',properties:{command:{type:'string',description:'Literal metadata command with optional quoted arguments.'},timeout:{type:'number',description:'Positive integer milliseconds, capped at 30000.'}},required:['command']},
 async execute(params,context):Promise<ToolResult>{
  if(!isExecToolsEnabled())return execToolRefusal('exec');
  const plan=prepareExec(params);if(!plan||process.platform==='win32')return fail();
  let cwd:string;
  try{cwd=realpathSync(safeChildCwd(context?.workspaceDir));safeChildCwd(cwd);if(!statSync(cwd).isDirectory())return fail();}catch{return fail();}
  const started=Date.now();
  try{
   const {stdout,stderr}=await executeFile(plan.file,plan.args,{cwd,env:minimalChildEnv({PATH:'/usr/bin:/bin'}),shell:false,timeout:plan.timeout,maxBuffer:65536,encoding:'utf8',windowsHide:true});
   return {content:[{type:'text',text:(stdout||stderr||'(no output)').trim()}],details:{exitCode:0,duration:Date.now()-started}};
  }catch{
   // Child errors can contain command arguments, output and paths. Do not echo or log them.
   return {content:[{type:'text',text:'Metadata command failed or exceeded its execution limit.'}],error:'Command execution failed'};
  }
 },
};
