import {DocumentEditor} from './DocumentEditor';
import {UiIcon} from './ui-icons';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionClient } from './session';
import type { ChannelEntry } from './agent-connect-contract.js';
import { AGENT_CONNECT_PATH } from './agent-connect-contract.js';

export function ChannelCatalogSelect({ channels, selected, busy, onSelect }: { channels: readonly ChannelEntry[]; selected: string; busy: boolean; onSelect: (id: string) => void }) {
  return <label className="field"><span>Integration ({channels.length})</span><select aria-label="Agent Connect integration" value={selected} disabled={busy} onChange={e => onSelect(e.target.value)}><option value="">Choose an integration</option>{channels.map(c => <option key={c.id} value={c.id}>{c.label}{c.configured ? ' · configured' : ''}</option>)}</select></label>;
}

export function AgentConnectSettings({ client }: { client: SessionClient }) {
  const owner = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).user?.role === 'owner';
  const [channels, setChannels] = useState<ChannelEntry[]>([]), [selected, select] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [configurable, setConfigurable] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [users, setUsers] = useState(''), [conversations, setConversations] = useState('');
  const [environment, setEnvironment] = useState<Record<string, string>>({}), [extraEnv, setExtraEnv] = useState(''), [settings, setSettings] = useState('');
  const [query,setQuery]=useState(''),[view,setView]=useState<'credentials'|'access'|'advanced'>('credentials');
  const [editor,setEditor]=useState<'environment'|'settings'|null>(null);
  const current = channels.find(c => c.id === selected);
  useEffect(() => {
    if (!owner) return; let disposed = false;
    void client.request({ method: 'GET', path: `${AGENT_CONNECT_PATH}/catalog` } as never).then(r => {
      if (disposed) return; const body = r.body as { channels?: ChannelEntry[]; configurable?: boolean };
      if (r.status !== 200 || !Array.isArray(body?.channels)) { setPhase('error'); return; }
      setChannels(body.channels); setConfigurable(body.configurable === true); setPhase('ready');
    }).catch(() => { if (!disposed) setPhase('error'); });
    return () => { disposed = true; };
  }, [client, owner]);
  useEffect(() => {
    setUsers(current?.allowedUsers.join(', ') ?? ''); setConversations(current?.allowedChannels.join(', ') ?? '');
    setEnvironment({}); setExtraEnv(''); setSettings(''); setNotice('');setEditor(null);
  }, [selected]);
  async function save() {
    if (!current || busy) return;
    let body: Record<string, unknown>;
    try {
      const additional = extraEnv.trim() ? JSON.parse(extraEnv) : {};
      if (!additional || typeof additional !== 'object' || Array.isArray(additional)) throw Error();
      body = { allowedUsers: users.split(',').map(x => x.trim()).filter(Boolean), allowedChannels: conversations.split(',').map(x => x.trim()).filter(Boolean),
        environment: { ...additional, ...Object.fromEntries(Object.entries(environment).filter(([,v]) => v !== '')) },
        ...(settings.trim() ? { settings: JSON.parse(settings) } : {}) };
    } catch { setNotice('Check the JSON fields. Use an object of provider settings or variables.'); return; }
    setBusy(true); setNotice('');
    try {
      const r = await client.request({ method: 'PUT', path: `${AGENT_CONNECT_PATH}/${current.id}/config`, body } as never);
      const result = r.body as { saved?: boolean; channel?: Partial<ChannelEntry> };
      if (r.status !== 200 || !result?.saved || !result.channel) { setNotice('Not saved. Check required credentials, trusted IDs and provider-specific settings.'); return; }
      setChannels(items => items.map(c => c.id === current.id ? { ...c, ...result.channel } : c));
      setEnvironment({}); setExtraEnv(''); setSettings(''); setNotice('Configuration saved. No provider connection was started.');
    } catch { setNotice('Save could not be confirmed. Reload settings before trying again.'); }
    finally { setBusy(false); }
  }
  async function activate(channel: ChannelEntry) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const r = await client.request({ method: 'PUT', path: `${AGENT_CONNECT_PATH}/${channel.id}/activation`, body: { enabled: !channel.enabled } } as never);
      const result = r.body as { saved?: boolean; channel?: Partial<ChannelEntry> };
      if (r.status !== 200 || !result.saved || !result.channel) { setNotice('Activation could not be saved. Configure the channel first.'); return; }
      setChannels(items => items.map(c => c.id === channel.id ? { ...c, ...result.channel } : c));
      setNotice(result.channel.enabled ? 'Channel enabled. Connection status will update automatically; restart the application if requested.' : 'Channel disabled. Other channels stay unchanged.');
    } catch { setNotice('Activation could not be confirmed. Check the channel status before retrying.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!owner) return;
    let disposed = false;
    const timer = setInterval(() => {
      void client.request({ method: 'GET', path: `${AGENT_CONNECT_PATH}/catalog` } as never).then(r => {
        const body = r.body as { channels?: ChannelEntry[] };
        if (!disposed && r.status === 200 && Array.isArray(body?.channels)) setChannels(body.channels);
      }).catch(() => {});
    }, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, owner]);
  if (!owner) return null;
  return <section aria-label="Channels" className="channels-settings"><div className="channel-workspace"><div className="channel-service-list"><label className="channel-service-search"><UiIcon name="search" size={14}/><input type="search" aria-label="Find messaging service" placeholder="Find service" value={query} onChange={e=>setQuery(e.target.value)}/></label>{phase==='loading'?<p role="status">Reading services…</p>:phase==='error'?<p role="alert">Services could not be loaded. Reopen settings to retry.</p>:<div role="listbox" aria-label="Messaging services">{channels.filter(c=>c.label.toLowerCase().includes(query.toLowerCase())).map(c=><button type="button" role="option" aria-selected={selected===c.id} disabled={busy} key={c.id} onClick={()=>select(c.id)}><UiIcon name="message" size={17}/><span><strong>{c.label}</strong><small>{c.configured?(c.enabled?'Enabled':'Disabled'):'Not configured'}</small></span></button>)}</div>}</div><div className="channel-detail-pane"><div className="channel-select-fallback"><ChannelCatalogSelect channels={channels} selected={selected} busy={busy} onSelect={select}/></div>
 {notice&&<p role="status" className="preference-notice">{notice}</p>}{!configurable&&phase==='ready'&&<p role="status">Channel configuration requires a SQLite workspace.</p>}
 {current?<form className="channel-configuration" aria-label={`${current.label} configuration`} onSubmit={e=>{e.preventDefault();void save();}}><header className="channel-service-head"><span className="preference-icon"><UiIcon name="message" size={22}/></span><div><h3>{current.label}</h3><p>{current.state==='restart_required'?'Restart required':current.state} · {current.runtime==='node'?'Built-in transport':'Python runtime'}</p></div><button type="button" title={`${current.enabled?'Disable':'Enable'} ${current.label}`} aria-label={`${current.enabled?'Disable':'Enable'} ${current.label}`} disabled={busy||!configurable||(!current.configured&&!current.enabled)} onClick={()=>void activate(current)}><UiIcon name="power" size={17}/>{current.enabled?'Disable':'Enable'}</button></header>
 <div className="preference-views" role="group" aria-label="Service settings">{(['credentials','access','advanced'] as const).map(v=><button type="button" key={v} aria-pressed={view===v} onClick={()=>setView(v)}>{v==='credentials'?'Credentials':v==='access'?'Sender access':'Advanced'}</button>)}</div>
 {view==='credentials'&&<div className="preference-group channel-form-group">{current.requiredEnv.length?current.requiredEnv.map(key=><label className="channel-field" key={key}><span>{key}</span><input type="password" autoComplete="off" aria-label={key} maxLength={16384} value={environment[key]??''} placeholder={current.hasSecrets?'Leave empty to keep saved value':'Enter provider value'} onChange={e=>setEnvironment(values=>({...values,[key]:e.target.value}))}/></label>):<p>This service uses provider settings instead of credential fields.</p>}<p className="preference-note">Saved credentials stay hidden. Saving does not start a connection.</p></div>}
 {view==='access'&&<div className="preference-group channel-form-group"><label className="channel-field"><span>Trusted sender IDs</span><input aria-label="Trusted sender IDs" value={users} maxLength={20000} onChange={e=>setUsers(e.target.value)}/><small>Separate IDs with commas.</small></label><label className="channel-field"><span>Permitted conversation IDs</span><input aria-label="Permitted conversation IDs" value={conversations} maxLength={20000} onChange={e=>setConversations(e.target.value)}/><small>Only these conversations may use this connection.</small></label><p className="preference-note">Automatic replies are off for new configurations.</p></div>}
 {view==='advanced'&&<><div className="preference-group channel-form-group"><div className="channel-document-row"><div><strong>Additional provider variables</strong><small>{extraEnv.trim()?'Draft entered':'Saved values stay hidden'}</small></div><button type="button" disabled={busy} onClick={()=>setEditor('environment')}><UiIcon name="pencil" size={14}/>Edit</button></div>{current.runtime==='python'&&<div className="channel-document-row"><div><strong>Provider settings</strong><small>{settings.trim()?'Draft entered':'JSON object'}</small></div><button type="button" disabled={busy} onClick={()=>setEditor('settings')}><UiIcon name="pencil" size={14}/>Edit</button></div>}</div><details className="preference-help"><summary>Provider requirements</summary><p>{current.prerequisites}</p><p>Provider setup guide: Agent Connect repository / docs/CHANNELS.md.</p><p>Runtime executables, local paths and interpreter variables cannot be configured here. Real-account delivery has not been verified in this preview.</p></details></>}
 <footer className="channel-savebar"><span>{current.configured?'Configuration saved previously':'Configuration required before enabling'}</span><button type="submit" className="primary" disabled={busy||!configurable}><UiIcon name="check" size={14}/>{busy?'Saving…':'Save configuration'}</button></footer></form>:<div className="channel-no-selection"><UiIcon name="message" size={30}/><h3>Select a messaging service</h3><p>Choose a service to configure credentials and trusted senders.</p></div>}
 </div></div>{editor&&<DocumentEditor title={editor==='environment'?'Additional provider variables':'Provider settings'} files={[{id:editor,name:editor==='environment'?'variables.json':'settings.json',content:editor==='environment'?extraEnv:settings}]} maxLength={32768} onChange={(_,text)=>editor==='environment'?setExtraEnv(text):setSettings(text)} onClose={()=>setEditor(null)}/>}</section>;
}
