import {PreferenceGroup,PreferenceRow} from './Preferences';
import {useEffect,useState} from 'react';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import {ClaudeCodeIcon,CodexIcon} from './brand-icons';
/** Read-only availability, from the same catalogue as the chat reply selector. */
export function ReplyAppsSettings({client,onOpenChat}:{client:SessionClient;onOpenChat?:()=>void}){
 const [apps,setApps]=useState<string[]|null>(null),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{let stopped=false;setError(false);void client.request({method:'GET',path:'/api/models'} as never).then(r=>{if(stopped)return;const b=r.body as {models?:{id:string;provider:string}[]};if(r.status!==200||!Array.isArray(b.models)){setError(true);return;}setApps(b.models.filter(x=>x.provider==='subscription').map(x=>x.id));}).catch(()=>{if(!stopped)setError(true);});return()=>{stopped=true;};},[client,refresh]);
 return <PreferenceGroup title="Coding app replies" note="Availability comes from this installation. App sign-in is managed in the coding app."><PreferenceRow title="Claude Code" description="Local CLI reply source" icon="terminal"><ClaudeCodeIcon size={18}/><span className="preference-status">{error?'Could not check':apps===null?'Checking…':apps.includes('subscription:claude')?'Available':'Not offered here'}</span></PreferenceRow><PreferenceRow title="Codex" description="Local CLI reply source" icon="terminal"><CodexIcon size={18}/><span className="preference-status">{error?'Could not check':apps===null?'Checking…':apps.includes('subscription:codex')?'Available':'Not offered here'}</span></PreferenceRow><PreferenceRow title="Reply source" description="Choose the app used for a conversation." icon="message"><button title="Refresh coding app availability" aria-label="Refresh coding app availability" onClick={()=>setRefresh(n=>n+1)}><UiIcon name="refresh" size={15}/></button>{onOpenChat&&<button onClick={onOpenChat}>Open Chat</button>}</PreferenceRow></PreferenceGroup>;
}
