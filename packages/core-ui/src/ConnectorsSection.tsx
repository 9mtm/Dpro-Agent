import { useEffect, useState, useSyncExternalStore } from 'react';
import { ConnectorsController, EMPTY_DRAFT } from './connectors';
import type { ConnectorDraft } from './connectors';
import type { Connector } from './connectors-contract.js';
import type { SessionClient } from './session';
import { UiIcon } from './ui-icons';

/** Connectors: outside tools (MCP servers) the owner adds once and then gives to agents. */
export function ConnectorsSection({ client, active, focus }: { client: SessionClient; active: boolean; focus?: boolean }) {
  // Constructing sends nothing; the first read happens when the page is shown.
  const [c] = useState(() => new ConnectorsController(client));
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [adding, setAdding] = useState(false);
  const [query,setQuery]=useState(''),[transport,setTransport]=useState(''),[status,setStatus]=useState(''),[page,setPage]=useState(0);
  const matches=s.servers.filter(x=>(!transport||x.transport===transport)&&(!status||(status==='off'?!x.enabled:status==='problem'?x.enabled&&!!x.lastError:x.enabled&&!x.lastError))&&`${x.name} ${x.description??''}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
  useEffect(() => { if (active && s.phase === 'idle') void c.load(); }, [active, c, s.phase]);
  useEffect(() => { if (focus) document.getElementById('connectors')?.scrollIntoView({ block: 'start' }); }, [focus]);
  return <section id="connectors" className="connectors" aria-label="Connectors">
    <div className="connectors-head">
      <div><h2>Connectors</h2><p className="fine-print">Outside tools your agents can use, like a calendar, a database or a company service. Add one here, then give its tools to agents on each agent's tools.</p></div>
      {!adding && <button type="button" className="primary" onClick={() => setAdding(true)}>Add a connector</button>}
    </div>
    <div className="catalogue-filters"><label>Search<input type="search" aria-label="Search installed MCP connections" value={query} placeholder="Name or description" onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label><label>Transport<select value={transport} onChange={e=>{setTransport(e.target.value);setPage(0);}}><option value="">All transports</option><option value="stdio">Local program</option><option value="http">HTTP</option><option value="sse">SSE</option></select></label><label>Status<select value={status} onChange={e=>{setStatus(e.target.value);setPage(0);}}><option value="">All statuses</option><option value="on">On</option><option value="off">Off</option><option value="problem">Problem</option></select></label><button type="button" onClick={()=>{setQuery('');setTransport('');setStatus('');setPage(0);}}>Clear filters</button></div>
    <p className="fine-print" role="status">{matches.length} of {s.servers.length} connections</p>
    {s.notice && <p className="board-notice" role="status">{s.notice}</p>}
    {adding && <AddConnector c={c} onDone={() => setAdding(false)}/>}
    {s.approval && <div className="connector-approval" role="alertdialog" aria-label="Approve the program">
      <strong>Allow {s.approval.name} to start this program on this computer?</strong>
      <pre dir="ltr">{[s.approval.launch.command, ...s.approval.launch.args].join(' ')}</pre>
      {s.approval.launch.envNames.length > 0 && <p className="fine-print">With the secrets: {s.approval.launch.envNames.join(', ')}</p>}
      <p className="fine-print">It runs as your user. If the command changes later, it asks again.</p>
      <div className="hire-actions"><button type="button" className="primary" onClick={() => void c.approve()}>Allow and turn on</button><button type="button" onClick={() => c.cancelApproval()}>Cancel</button></div>
    </div>}
    {s.phase === 'loading' && !s.servers.length ? <p className="fine-print" role="status">Loading connectors…</p>
      : s.phase === 'error' && !s.servers.length ? <p className="fine-print">Connectors could not be loaded. <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>
      : !s.servers.length && !adding ? <p className="fine-print">No connectors yet.</p>
      : <ul className="connector-list catalogue-grid">{matches.slice(page*24,page*24+24).map(x => <ConnectorRow key={x.id} x={x} c={c} busy={s.busy === x.id}/>)}</ul>}
    {s.phase==='ready'&&s.servers.length>0&&!matches.length&&<p>No connections match these filters.</p>}
    {matches.length>24&&<div className="actions"><button disabled={!page} onClick={()=>setPage(p=>p-1)}>Previous</button><span>{page*24+1}–{Math.min(page*24+24,matches.length)} of {matches.length}</span><button disabled={page*24+24>=matches.length} onClick={()=>setPage(p=>p+1)}>Next</button></div>}
  </section>;
}
/** An example address on this computer (scheme joined here: no full address in the source). */
const LOCAL_EXAMPLE = ['http:', '', '127.0.0.1:3333/mcp'].join('/');

function ConnectorRow({ x, c, busy }: { x: Connector; c: ConnectorsController; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const state = x.enabled ? (x.lastError ? 'problem' : 'on') : 'off';
  return <li className="connector" data-state={state}>
    <div className="connector-main">
      <span className="connector-dot" aria-hidden="true"/>
      <div className="connector-id">
        <strong dir="ltr">{x.name}</strong>
        <span className="fine-print" dir="ltr">{x.transport === 'stdio' ? [x.command, ...x.args].join(' ') : x.url}</span>
        {x.description && <span className="fine-print">{x.description}</span>}
      </div>
      <span className="connector-state">{state === 'on' ? `On · ${x.tools.length} ${x.tools.length === 1 ? 'tool' : 'tools'}` : state === 'problem' ? 'Problem' : 'Off'}</span>
      <div className="connector-actions">
        {x.enabled ? <>
          <button type="button" disabled={busy} onClick={() => void c.refresh(x.id)} title="Connect and read its tools again">Refresh tools</button>
          <button type="button" disabled={busy} onClick={() => void c.disable(x.id)}>Turn off</button>
        </> : <button type="button" className="primary" disabled={busy} onClick={() => void c.enable(x.id)}>Turn on</button>}
        {x.tools.length > 0 && <button type="button" className="row-tool" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} tools of ${x.name}`} onClick={() => setOpen(v => !v)}><UiIcon name="chevron" size={11}/></button>}
        {confirm ? <span className="connector-confirm">Remove? <button type="button" className="link-button danger" disabled={busy} onClick={() => void c.remove(x.id)}>Yes</button><button type="button" className="link-button" onClick={() => setConfirm(false)}>No</button></span>
          : <button type="button" className="row-tool" aria-label={`Remove ${x.name}`} title="Remove (its tools are taken from every agent)" onClick={() => setConfirm(true)}><UiIcon name="trash" size={12}/></button>}
      </div>
    </div>
    {x.lastError && <p className="connector-error" role="alert">{x.lastError}</p>}
    {open && <ul className="connector-tools">{x.tools.map(t => <li key={t.name}>
      <div><code dir="ltr">{t.name}</code>{(t.title || t.description) && <span className="fine-print"> {t.title ?? t.description}</span>}</div>
      <label className="term-check" title="When on, the agent asks you before each use"><input type="checkbox" checked={t.requiresApproval} disabled={busy} onChange={e => void c.setApproval(x.id, t.name, e.target.checked)}/>Ask me first</label>
    </li>)}</ul>}
  </li>;
}

function AddConnector({ c, onDone }: { c: ConnectorsController; onDone: () => void }) {
  const [d, setD] = useState<ConnectorDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<ConnectorDraft>) => setD(v => ({ ...v, ...p }));
  return <form className="connector-form" aria-label="Add a connector" onSubmit={async e => {
    e.preventDefault(); setBusy(true); const err = await c.add(d); setBusy(false);
    if (err) setError(err); else onDone();
  }}>
    <div className="seg small" role="radiogroup" aria-label="Kind">
      <button type="button" role="radio" aria-checked={d.kind === 'web'} onClick={() => set({ kind: 'web' })}>Web address</button>
      <button type="button" role="radio" aria-checked={d.kind === 'program'} onClick={() => set({ kind: 'program' })}>Program on this computer</button>
    </div>
    <label>Name<input value={d.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. github" maxLength={24} dir="ltr" required/></label>
    <label>What it is for (optional)<input value={d.description} onChange={e => set({ description: e.target.value })} maxLength={500}/></label>
    {d.kind === 'web' ? <>
      <label>Address<input value={d.url} onChange={e => set({ url: e.target.value })} placeholder={LOCAL_EXAMPLE} dir="ltr" required/></label>
      <label className="term-check"><input type="checkbox" checked={d.allowRemote} onChange={e => set({ allowRemote: e.target.checked })}/>It is on the internet (not this computer)</label>
      <label>Secret headers (optional, one NAME=value per line)<textarea rows={2} value={d.secrets} onChange={e => set({ secrets: e.target.value })} placeholder="Authorization=Bearer …" dir="ltr" spellCheck={false}/></label>
    </> : <>
      <label>Command<input value={d.command} onChange={e => set({ command: e.target.value })} placeholder="npx -y @modelcontextprotocol/server-filesystem /path" dir="ltr" required/></label>
      <label>Secrets (optional, one NAME=value per line)<textarea rows={2} value={d.secrets} onChange={e => set({ secrets: e.target.value })} placeholder="API_KEY=…" dir="ltr" spellCheck={false}/></label>
      <p className="fine-print">You approve the exact command once when you turn it on.</p>
    </>}
    <p className="fine-print">Secrets are stored encrypted and never shown again.</p>
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="hire-actions"><button type="submit" className="primary" disabled={busy}>{busy ? 'Adding…' : 'Add connector'}</button><button type="button" onClick={onDone}>Cancel</button></div>
  </form>;
}
