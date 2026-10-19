import {findSession,readSession} from '../memory/import/local-agents.js';
/** Explicit owner-selected CLI sessions; never an agent tool or a channel provider. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {minimalChildEnv,safeChildCwd} from '../tools/exec-policy.js';
export const subscriptionModel=(value:unknown):value is string=>typeof value==='string'&&/^subscription:(claude|codex)(?::[a-f0-9]{32})?$/.test(value);
export const subscriptionEnabled=()=>process.env.DPRO_SUBSCRIPTION_CHAT==='1'&&process.env.AGENT_PLAYER_ISOLATED!=='1';
export async function subscriptionBinary(kind:'claude'|'codex'){
 const candidates=[path.join(os.homedir(),'.local','bin',kind),...(process.env.PATH??'').split(path.delimiter).filter(Boolean).map(p=>path.join(p,kind))];
 for(const file of candidates)try{if((await fs.stat(file)).isFile()){await fs.access(file,fs.constants.X_OK);return file;}}catch{}
 return null;
}
export function subscriptionArgs(kind:'claude'|'codex',nativeId?:string){
 const args=kind==='claude'?['-p','--output-format','json','--no-session-persistence','--safe-mode','--restricted','--permission-mode','acceptEdits','--permission-prompts','none','--tools','Read,Write,Edit,Glob,Grep','--strict-mcp-config','--mcp-config','{"mcpServers":{}}']:
 ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','--disable','plugins','--disable','skill_mcp_dependency_install','--json','-'];
 if(nativeId){if(kind==='claude')args.push('--resume',nativeId,'--fork-session');else args.splice(args.length-1,1,'fork',nativeId,'-');}return args;
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
 let nativeId:string|undefined;const opaque=model.split(':')[2];
 if(opaque){const ref=await findSession(opaque);if(!ref||ref.source!==(kind==='claude'?'claude-code':'codex'))throw Error('session_missing');const session=await readSession(ref);if(!session.cwd||await fs.realpath(session.cwd)!==cwd)throw Error('session_folder_mismatch');nativeId=path.basename(ref.file).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/)?.[1];if(!nativeId)throw Error('session_missing');}if(!bin)throw Error('cli_missing');if(signal.aborted)throw Error('cancelled');
 return new Promise((resolve,reject)=>{
  const args=subscriptionArgs(kind,nativeId);
  const child=spawn(bin,args,{cwd,env:minimalChildEnv({NO_COLOR:'1',TERM:'dumb'}),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
  let output='',bytes=0,failed=false,hardStop:ReturnType<typeof setTimeout>|undefined;const kill=(signal:NodeJS.Signals)=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch{}};const stop=()=>{if(failed)return;failed=true;kill('SIGTERM');hardStop=setTimeout(()=>kill('SIGKILL'),1500);hardStop.unref();};
  const timer=setTimeout(stop,240000);signal.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024)stop();else output+=chunk.toString();});child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);clearTimeout(hardStop);signal.removeEventListener('abort',stop);reject(Error('cli_unavailable'));});
  child.on('close',code=>{clearTimeout(timer);clearTimeout(hardStop);signal.removeEventListener('abort',stop);if(failed){reject(Error(signal.aborted?'cancelled':'cli_failed'));return;}if(code!==0){try{subscriptionAnswer(kind,output);}catch(error){if(error instanceof Error&&error.message==='subscription_org_blocked'){reject(error);return;}}reject(Error('cli_failed'));return;}try{const answer=subscriptionAnswer(kind,output).trim();if(!answer)throw Error();resolve(answer);}catch{reject(Error('cli_failed'));}});
  child.stdin.end(prompt);
 });
}
