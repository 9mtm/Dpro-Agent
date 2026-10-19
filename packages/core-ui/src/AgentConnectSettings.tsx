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
    setEnvironment({}); setExtraEnv(''); setSettings(''); setNotice('');
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
  return <section aria-label="Channels"><h2>Channels</h2>
    <p className="fine-print">Messaging, email, webhooks, APIs and relays from agent-connect-dpro. Saving settings does not enable an extension, start a provider, install dependencies or send messages.</p>
    {phase === 'loading' ? <p role="status">Loading integrations…</p> : phase === 'error' ? <p role="alert">Integrations could not be loaded. Reopen settings to try again.</p> : <>
      <div className="channel-status-list" aria-label="Channel activation and status">{channels.filter(c => c.configured).map(c => <div className="app-settings-row" key={c.id}>
        <span><strong>{c.label}</strong><span className="fine-print" role="status"> · {c.state === 'restart_required' ? 'Restart application required' : c.state}</span></span>
        <button type="button" disabled={busy || !configurable} onClick={() => void activate(c)} aria-label={`${c.enabled ? 'Disable' : 'Enable'} ${c.label}`}>{c.enabled ? 'Disable' : 'Enable'}</button>
      </div>)}</div>
      {notice && <p role="status">{notice}</p>}
      <ChannelCatalogSelect channels={channels} selected={selected} busy={busy} onSelect={select}/>
      {!configurable && <p role="status">Channel extensions currently require the SQLite workspace. Configuration is unavailable for this database type.</p>}
      {current && <form className="channel-configuration" aria-label={`${current.label} configuration`} onSubmit={e => { e.preventDefault(); void save(); }}>
        <h3>{current.label}</h3>
        {!current.configured && <div className="app-settings-row"><span className="fine-print">Not configured. Save credentials before enabling.</span><button type="button" disabled>Enable {current.label}</button></div>}
        <p className="fine-print">{current.runtime === 'node' ? 'Native Node.js transport.' : 'Optional Python 3.11–3.13 runtime required.'} {current.prerequisites}</p>
        <p className="fine-print">{current.enabled ? 'Channel is enabled.' : 'Channel is disabled. Save configuration before enabling.'} Real-account delivery has not been verified here.</p>
        <p className="fine-print">Provider setup guide: Agent Connect repository → docs/CHANNELS.md.</p>
        {current.requiredEnv.map(key => <label className="field" key={key}><span>{key}</span><input type="password" autoComplete="off" aria-label={key} maxLength={16384} value={environment[key] ?? ''} placeholder={current.hasSecrets ? 'Saved credentials stay hidden; leave empty to keep' : 'Enter provider value'} onChange={e => setEnvironment(values => ({ ...values, [key]: e.target.value }))}/></label>)}
        <label className="field"><span>Trusted sender IDs (comma separated)</span><input aria-label="Trusted sender IDs" value={users} maxLength={20000} onChange={e => setUsers(e.target.value)}/></label>
        <label className="field"><span>Permitted conversation IDs (comma separated)</span><input aria-label="Permitted conversation IDs" value={conversations} maxLength={20000} onChange={e => setConversations(e.target.value)}/></label>
        {current.runtime === 'python' && <details><summary>Provider settings and additional variables</summary><p className="fine-print">Write-only JSON objects. Leave empty to preserve saved values. Runtime executables, local paths and interpreter variables cannot be configured here.</p><label className="field"><span>Additional provider variables (JSON)</span><textarea aria-label="Additional provider variables" value={extraEnv} maxLength={32768} onChange={e => setExtraEnv(e.target.value)} spellCheck={false}/></label><label className="field"><span>Provider settings (JSON)</span><textarea aria-label="Provider settings" value={settings} maxLength={32768} onChange={e => setSettings(e.target.value)} spellCheck={false}/></label></details>}
        <p className="fine-print">Automatic replies are off for new configurations. Sender and conversation restrictions remain enforced by the host.</p>
        <button type="submit" disabled={busy || !configurable}>{busy ? 'Saving…' : 'Save configuration'}</button>
        {notice && <p role="status">{notice}</p>}
      </form>}
    </>}
  </section>;
}
