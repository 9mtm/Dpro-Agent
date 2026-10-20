import {findSession,readSession} from '../memory/import/local-agents.js';
/** Explicit owner-selected CLI sessions; never an agent tool or a channel provider. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {minimalChildEnv,safeChildCwd} from '../tools/exec-policy.js';
export const subscriptionModel=(value:unknown):value is string=>typeof value==='string'&&/^subscription:(claude|codex)(?::[a-f0-9]{32})?(?:\/[a-z0-9][a-z0-9.-]{0,40})?$/.test(value);
/** The coding app's own model after the slash (subscription:claude/opus, subscription:codex/gpt-6.1-sol), or undefined for its default (CORE-PICKER-02). */
export const subscriptionVariant=(model:string):string|undefined=>model.match(/\/([a-z0-9][a-z0-9.-]{0,40})$/)?.[1];
const CLAUDE_VARIANTS=[{id:'fable',label:'Fable'},{id:'opus',label:'Opus'},{id:'sonnet',label:'Sonnet'},{id:'haiku',label:'Haiku'}];
/** Models the owner can pick for a coding app: Claude Code's aliases; Codex's own list for this account (~/.codex/models_cache.json, visible ones only). */
export async function subscriptionVariants(kind:'claude'|'codex',home=os.homedir()):Promise<{id:string;label:string}[]>{
 if(kind==='claude')return CLAUDE_VARIANTS;
 try{
  const raw=JSON.parse(await fs.readFile(path.join(home,'.codex','models_cache.json'),'utf8'));const list=Array.isArray(raw?.models)?raw.models:Array.isArray(raw)?raw:[];
  return list.filter((m:any)=>m&&m.visibility==='list'&&typeof m.slug==='string'&&/^[a-z0-9][a-z0-9.-]{0,40}$/.test(m.slug)).slice(0,20)
   .map((m:any)=>({id:m.slug,label:typeof m.display_name==='string'&&m.display_name.trim()?m.display_name.trim().slice(0,40):m.slug}));
 }catch{return [];}
}
export const subscriptionEnabled=()=>process.env.DPRO_SUBSCRIPTION_CHAT==='1'&&process.env.AGENT_PLAYER_ISOLATED!=='1';
/** Where the CLIs are installed. An app opened from the Dock gets a short PATH, so the usual install folders are searched too (CORE-PICKER-01): Homebrew, npm under fnm/nvm/volta. */
export async function subscriptionSearchDirs(home=os.homedir(),pathEnv=process.env.PATH??''):Promise<string[]>{
 const versions=async(dir:string,tail:string[])=>{try{return (await fs.readdir(dir)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(v=>path.join(dir,v,...tail));}catch{return [];}};
 const dirs=[path.join(home,'.local','bin'),...pathEnv.split(path.delimiter).filter(Boolean),'/opt/homebrew/bin','/usr/local/bin',path.join(home,'.volta','bin'),path.join(home,'.npm-global','bin'),
  ...await versions(path.join(home,'.local','share','fnm','node-versions'),['installation','bin']),...await versions(path.join(home,'.nvm','versions','node'),['bin'])];
 return [...new Set(dirs.filter(d=>path.isAbsolute(d)))];
}
export async function subscriptionBinary(kind:'claude'|'codex'){
 for(const dir of await subscriptionSearchDirs()){const file=path.join(dir,kind);try{if((await fs.stat(file)).isFile()){await fs.access(file,fs.constants.X_OK);return file;}}catch{}}
 return null;
}
export function subscriptionArgs(kind:'claude'|'codex',nativeId?:string,variant?:string){
 const args=kind==='claude'?['-p','--output-format','json','--no-session-persistence','--safe-mode','--restricted','--permission-mode','acceptEdits','--permission-prompts','none','--tools','Read,Write,Edit,Glob,Grep','--strict-mcp-config','--mcp-config','{"mcpServers":{}}']:
 ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','--disable','plugins','--disable','skill_mcp_dependency_install','--json','-'];
 if(nativeId){if(kind==='claude')args.push('--resume',nativeId,'--fork-session');else args.splice(args.length-1,1,'fork',nativeId,'-');}
 if(variant&&/^[a-z0-9][a-z0-9.-]{0,40}$/.test(variant)){if(kind==='claude')args.push('--model',variant);else args.splice(1,0,'-m',variant);}
 return args;
}
export function subscriptionAnswer(kind:'claude'|'codex',stdout:string):string{
 if(kind==='claude'){const row=JSON.parse(stdout);if(row.api_error_code==='oauth_not_allowed_for_organization')throw Error('subscription_org_blocked');if(row.type!=='result'||row.is_error||typeof row.result!=='string')throw Error('cli_failed');return row.result;}
 const rows=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));const answers=rows.filter(r=>r.type==='item.completed'&&r.item?.type==='agent_message'&&typeof r.item.text==='string');
 if(!answers.length||rows.some(r=>r.type==='error'||r.type==='turn.failed'))throw Error('cli_failed');return answers.map(r=>r.item.text).join('\n\n');
}
export async function runSubscription(model:string,folder:string,prompt:string,signal:AbortSignal):Promise<string>{
 if(!subscriptionEnabled()||!subscriptionModel(model))throw Error('cli_disabled');
 const cwd=await fs.realpath(safeChildCwd(folder));if(!(await fs.stat(cwd)).isDirectory()||cwd===os.homedir()||cwd===path.parse(cwd).root)throw Error('project_required');
 const kind=model.startsWith('subscription:claude')?'claude':'codex',bin=await subscriptionBinary(kind);
 let nativeId:string|undefined;const opaque=model.split('/')[0].split(':')[2];
 if(opaque){const ref=await findSession(opaque);if(!ref||ref.source!==(kind==='claude'?'claude-code':'codex'))throw Error('session_missing');const session=await readSession(ref);if(!session.cwd||await fs.realpath(session.cwd)!==cwd)throw Error('session_folder_mismatch');nativeId=path.basename(ref.file).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/)?.[1];if(!nativeId)throw Error('session_missing');}if(!bin)throw Error('cli_missing');if(signal.aborted)throw Error('cancelled');
 return new Promise((resolve,reject)=>{
  const args=subscriptionArgs(kind,nativeId,subscriptionVariant(model));
  // The CLI's own folder goes first on PATH: an npm-installed CLI starts with `env node`, and that node sits next to it.
  const env=minimalChildEnv({NO_COLOR:'1',TERM:'dumb'});env.PATH=[path.dirname(bin),env.PATH].filter(Boolean).join(path.delimiter);
  const child=spawn(bin,args,{cwd,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
  let output='',bytes=0,failed=false,hardStop:ReturnType<typeof setTimeout>|undefined;const kill=(signal:NodeJS.Signals)=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch{}};const stop=()=>{if(failed)return;failed=true;kill('SIGTERM');hardStop=setTimeout(()=>kill('SIGKILL'),1500);hardStop.unref();};
  const timer=setTimeout(stop,240000);signal.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024)stop();else output+=chunk.toString();});child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);clearTimeout(hardStop);signal.removeEventListener('abort',stop);reject(Error('cli_unavailable'));});
  child.on('close',code=>{clearTimeout(timer);clearTimeout(hardStop);signal.removeEventListener('abort',stop);if(failed){reject(Error(signal.aborted?'cancelled':'cli_failed'));return;}if(code!==0){try{subscriptionAnswer(kind,output);}catch(error){if(error instanceof Error&&error.message==='subscription_org_blocked'){reject(error);return;}}reject(Error('cli_failed'));return;}try{const answer=subscriptionAnswer(kind,output).trim();if(!answer)throw Error();resolve(answer);}catch{reject(Error('cli_failed'));}});
  child.stdin.end(prompt);
 });
}
