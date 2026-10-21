// "Found on this computer" (DISCOVER-01, board M17): projects on the left, the
// chosen project's items in the middle, the opened item on the right.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { DiscoveryController, KIND_LABEL, KIND_SHORT, STATE_LABEL } from './discovery-controller';
import { DISCOVERY_KINDS, DISCOVERY_STATES } from './discovery-contract.js';
import type { DiscoveryItem } from './discovery-contract.js';
import type { SessionClient } from './session';

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const ACTION: Record<DiscoveryItem['state'], string> = { new: 'Import', changed: 'Update', decision: 'Review', imported: 'Remove', ignored: 'Undo', gone: 'Keep' };
const RULES = [
  'Dpro only reads. It never changes, moves or deletes a file here.',
  'Never read: private SSH keys, .env files, browser, keychain and wallet data.',
  'A token or password goes only to encrypted Credentials, after your OK.',
  'Skills and MCP servers start off; an agent gets them only by grant.',
  'Remove from Dpro keeps the file here and the memory history.',
];

export function Discovery({ client, active }: { client: SessionClient; active: boolean }) {
  const [c, setC] = useState<DiscoveryController>();
  useEffect(() => { const x = new DiscoveryController(client); setC(x); return () => x.dispose(); }, [client]);
  return c ? <DiscoveryView c={c} active={active}/> : <p className="fine-print" role="status">Reading this computer…</p>;
}

export function DiscoveryView({ c, active }: { c: DiscoveryController; active: boolean }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { if (active && s.phase === 'idle') void c.load(); }, [active, c, s.phase]);
  if (s.phase === 'idle' || (s.phase === 'loading' && !s.view)) return <p className="fine-print" role="status">Reading this computer… (memory files, project notes, skills, MCP servers, SSH hosts)</p>;
  if (s.phase === 'error' || !s.view) return <p className="fine-print">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  const v = s.view;
  const root = v.roots.find(r => r.id === s.rootId) ?? null;
  const shown = c.shown(); const counts = c.counts();
  const act = (it: DiscoveryItem) => {
    if (it.state === 'new' || it.state === 'changed') return void c.importIds([it.id]);
    if (it.state === 'ignored') return void c.ignore(it.id, false);
    if (it.state === 'gone') return void c.keep(it.id);
    return void c.open(it.id); // Review, and Remove (confirmed in the opened item)
  };
  const p = s.preview;
  return <div className="disc">
    <nav className="disc-roots" aria-label="Projects found">
      <span className="fine-print">By project folder</span>
      {v.roots.map(r => <button key={r.id} type="button" className="disc-root" aria-current={r.id === s.rootId ? 'true' : undefined} onClick={() => c.setRoot(r.id)}>
        <span className="disc-root-name"><b dir="auto">{r.name}</b><span className="fine-print" dir="auto">{r.watch ? r.project : 'not watched'}</span></span>
        <span className="disc-root-count">{r.fresh > 0 && <span className="disc-pill" data-tone="new">{r.fresh} new</span>}<span>{r.count}</span></span>
      </button>)}
    </nav>
    <section className="disc-main" aria-label="Found on this computer">
      <div className="disc-head">
        <div><h3>Found on this computer</h3><p className="fine-print">What coding agents left here: memory files, project notes, skills, MCP servers, SSH hosts. Dpro only reads; your files never change.</p></div>
        <span className="fine-print">Last scan {ago(v.scannedAt)}{v.ms ? ` · ${(v.ms / 1000).toFixed(1)} s` : ''}</span>
        <button type="button" disabled={s.scanning} onClick={() => void c.scan()}>{s.scanning ? 'Scanning…' : 'Scan now'}</button>
        <label className="term-check check"><input type="checkbox" checked={v.settings.watch} disabled={s.busy} onChange={e => void c.setWatch(e.target.checked, v.settings.intervalMinutes)}/>Watch</label>
        <label className="disc-every check">every<select aria-label="How often to scan" value={v.settings.intervalMinutes} disabled={s.busy} onChange={e => void c.setWatch(v.settings.watch, Number(e.target.value) as 15 | 30 | 60)}>{[15, 30, 60].map(n => <option key={n} value={n}>{n} min</option>)}</select></label>
      </div>
      <div className="seg small" role="radiogroup" aria-label="Kind">
        {(['all', ...DISCOVERY_KINDS] as const).map(k => <button key={k} type="button" role="radio" aria-checked={s.kind === k} onClick={() => c.setKind(k)}>{k === 'all' ? 'All' : KIND_LABEL[k]} <span className="muted">{counts.kind[k] ?? 0}</span></button>)}
      </div>
      <div className="seg small" role="radiogroup" aria-label="State">
        <button type="button" role="radio" aria-checked={s.state === 'all'} onClick={() => c.setState('all')}>Any state</button>
        {DISCOVERY_STATES.map(k => <button key={k} type="button" role="radio" aria-checked={s.state === k} onClick={() => c.setState(k)}>{STATE_LABEL[k]} <span className="muted">{counts.state[k] ?? 0}</span></button>)}
      </div>
      {s.result && <p className="card-notice" role="status">{s.result}</p>}
      {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
      {root && <div className="disc-list">
        <div className="disc-list-head">
          <b dir="auto">{root.name}</b>
          {root.path && <span className="fine-print disc-path" dir="ltr" title={root.path}>{root.path}</span>}
          {root.project && <span className="disc-pill" data-tone="ok">{root.project}</span>}
          {root.id !== 'computer' && <button type="button" className="link-button disc-push" disabled={s.busy} onClick={() => void c.setRootWatch(root.id, !root.watch)}>{root.watch ? 'Stop watching this project' : 'Watch this project again'}</button>}
        </div>
        {!shown.length ? <p className="fine-print disc-empty">Nothing here with this kind and state.</p> : <ul>
          {shown.map(it => <li key={it.id} className="disc-row" data-open={p?.id === it.id ? 'true' : undefined}>
            <input type="checkbox" aria-label={`Select ${it.name}`} checked={s.selected.includes(it.id)} disabled={s.busy || !(it.state === 'new' || it.state === 'changed')} onChange={() => c.toggle(it.id)}/>
            <span className="disc-kind">{KIND_SHORT[it.kind]}</span>
            <button type="button" className="disc-item" onClick={() => void c.open(it.id)}><b dir="auto">{it.name}</b><span className="fine-print" dir="auto">{it.from}</span></button>
            <span className="disc-to" dir="auto">{it.to}</span>
            <span className="disc-pill" data-tone={it.state}>{STATE_LABEL[it.state]}</span>
            <button type="button" className={it.state === 'new' || it.state === 'changed' || it.state === 'decision' ? 'primary' : undefined} disabled={s.busy} onClick={() => act(it)}>{it.kind === 'note' && it.state === 'imported' ? 'Open' : ACTION[it.state]}</button>
          </li>)}
        </ul>}
        <div className="disc-bulk">
          <span className="fine-print">{s.selected.length} selected</span>
          <button type="button" className="primary" disabled={!s.selected.length || s.busy} onClick={() => void c.importIds(s.selected)}>{s.busy ? 'Working…' : 'Import selected'}</button>
          <button type="button" disabled={!shown.some(i => i.state === 'new' || i.state === 'changed') || s.busy} onClick={() => { c.clear(); shown.filter(i => i.state === 'new' || i.state === 'changed').slice(0, 100).forEach(i => c.toggle(i.id)); }}>Select new and changed</button>
          {s.selected.length > 0 && <button type="button" className="link-button" onClick={() => c.clear()}>Clear</button>}
          <span className="fine-print disc-push">Memory files go in as they are (no model). Project notes are read by the local model, like Project files.</span>
        </div>
      </div>}
    </section>
    <aside className="disc-preview" aria-label="Item preview">
      {s.previewLoading && <p className="fine-print" role="status">Opening…</p>}
      {!p && !s.previewLoading && <p className="fine-print">Open an item to see it before it goes into Dpro.</p>}
      {p && <>
        <div className="disc-preview-head">
          <span className="fine-print" data-tone={p.state}>{STATE_LABEL[p.state]}</span>
          <h4 dir="auto">{KIND_SHORT[p.kind]} {p.name}</h4>
          <span className="fine-print" dir="auto">From {p.from} · read only</span>
          <span className="fine-print" dir="auto">Goes to {p.to}</span>
        </div>
        <pre className="disc-text" dir="auto">{p.text}{p.truncated ? '\n…' : ''}</pre>
        {p.blocked && <p className="card-notice" role="alert">{p.blocked === 'skill_name_taken' ? 'Dpro already has another skill with this name. It is not replaced from here; compare them in Skills.' : `This server cannot be added here: ${p.blocked.replace(/_/g, ' ')}.`}</p>}
        {p.kind === 'mcp' && p.secrets.length > 0 && !p.blocked && <fieldset className="disc-secret">
          <legend>{p.secrets.length === 1 ? 'A secret was found' : `${p.secrets.length} secrets were found`} ({p.secrets.join(', ')})</legend>
          <label className="check"><input type="radio" name="disc-secret" checked={s.secret === 'credentials'} onChange={() => c.setSecret('credentials')}/>Save it in Credentials (encrypted)</label>
          <label className="check"><input type="radio" name="disc-secret" checked={s.secret === 'leave'} onChange={() => c.setSecret('leave')}/>Leave it on this computer only</label>
          <span className="fine-print">A secret never becomes memory and never shows again after this.</span>
        </fieldset>}
        {p.kind === 'mcp' && <p className="fine-print">The server is added switched off. No agent can use it until you grant it on the agent's card (Agents › MCP).</p>}
        {p.kind === 'skill' && <p className="fine-print">The skill joins the library assigned to no agent. Give it to an agent on the agent's card.</p>}
        <div className="actions">
          {(p.state === 'new' || p.state === 'changed' || p.state === 'decision' || (p.kind === 'note' && p.state === 'imported')) && !p.blocked &&
            <button type="button" className="primary" disabled={s.busy} onClick={() => void c.importOpen()}>{p.kind === 'mcp' ? 'Add server (off)' : p.kind === 'skill' ? 'Add skill (off)' : p.state === 'changed' ? 'Update' : p.state === 'imported' ? 'Read again' : 'Import'}</button>}
          {p.state === 'imported' && p.kind !== 'note' && <button type="button" disabled={s.busy} onClick={() => void c.remove(p.id)}>Remove from Dpro</button>}
          {p.state !== 'ignored' && p.state !== 'imported' && <button type="button" disabled={s.busy} onClick={() => void c.ignore(p.id, true)}>Ignore</button>}
          <button type="button" className="link-button" onClick={() => c.close()}>Close</button>
        </div>
      </>}
      <section className="disc-rules" aria-label="Rules of this page"><b>Rules of this page</b>{RULES.map(r => <span key={r}>· {r}</span>)}</section>
    </aside>
  </div>;
}
