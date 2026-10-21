// "Found on this computer" (DISCOVER-01, board M17): projects on the left, the
// chosen project's items in the middle, the opened item on the right.
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { DiscoveryController, FILE_KIND_LABEL, KIND_LABEL, KIND_SHORT, STATE_LABEL } from './discovery-controller';
import { DISCOVERY_KINDS, DISCOVERY_STATES, FILE_KINDS } from './discovery-contract.js';
import type { DiscoveryItem, DiscoveryPlace } from './discovery-contract.js';
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

/** DISCOVER-02 (board M18): the folders and drives Dpro may read; tick several, then allow them at once. */
function FolderTree({ c }: { c: DiscoveryController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [adding, setAdding] = useState(false); const [folder, setFolder] = useState('');
  const pending = c.pendingPlaces(); const changes = pending.allow.length + pending.deny.length + pending.exclude.length;
  const row = (pl: DiscoveryPlace, depth: number): ReactElement => {
    const on = c.ticked(pl), open = s.places.open.includes(pl.id), kids = s.places.children[pl.id];
    const note = pl.state === 'exclude' ? 'left out' : pl.state === 'allow' ? 'allowed' : pl.inherited === 'allow' ? 'inside an allowed folder' : pl.kind === 'drive' ? 'drive' : 'not allowed';
    return <li key={pl.id}>
      <div className="disc-place" style={{ paddingInlineStart: 4 + depth * 16 }}>
        {pl.hasChildren ? <button type="button" className="disc-caret" aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${pl.name}`} onClick={() => void c.openPlace(pl.id)}>{open ? '▾' : '▸'}</button> : <span className="disc-caret" aria-hidden="true"/>}
        <label className="check"><input type="checkbox" checked={on} onChange={e => c.tick(pl, e.target.checked)} aria-label={`Dpro may read ${pl.name}`}/><span className="disc-place-name"><b dir="auto">{pl.name}</b><span className="fine-print" dir="auto">{s.places.counts[pl.id] ?? note}{pl.id in s.places.ticks ? ' · changed' : ''}</span></span></label>
        {!(pl.id in s.places.counts) && <button type="button" className="link-button disc-count" onClick={() => void c.count(pl.id)}>Count</button>}
      </div>
      {open && kids && <ul>{kids.map(k => row(k, depth + 1))}</ul>}
    </li>;
  };
  return <section className="disc-folders" aria-label="Folders Dpro may read">
    <h4>Folders Dpro may read</h4>
    <p className="fine-print">Tick folders, then allow them at once. Everything inside is read, also new subfolders. Untick to stop.</p>
    {!s.places.top ? <p className="fine-print" role="status">Listing folders…</p> : <ul className="disc-tree">{s.places.top.map(pl => row(pl, 0))}</ul>}
    {changes > 0 && <div className="disc-allow"><span className="fine-print">{changes} change{changes === 1 ? '' : 's'}</span><button type="button" className="primary" disabled={s.busy} onClick={() => void c.applyPlaces()}>{pending.allow.length && !pending.deny.length && !pending.exclude.length ? `Allow ${pending.allow.length} folder${pending.allow.length === 1 ? '' : 's'}` : 'Save folders'}</button></div>}
    {adding ? <div className="disc-add"><input aria-label="Folder or drive path" placeholder="/Volumes/Work or ~/Projects" value={folder} onChange={e => setFolder(e.target.value)}/><button type="button" disabled={!folder.trim() || s.busy} onClick={() => { void c.addPlace(folder); setFolder(''); setAdding(false); }}>Allow</button><button type="button" className="link-button" onClick={() => setAdding(false)}>Cancel</button></div>
      : <button type="button" onClick={() => setAdding(true)}>+ Add a drive or folder</button>}
    {s.view && <div className="disc-kinds"><b>What to read</b>
      {FILE_KINDS.map(k => <label key={k} className="check"><input type="checkbox" checked={s.view!.settings.kinds[k]} disabled={s.busy} onChange={e => void c.setFileKind(k, e.target.checked)}/>{FILE_KIND_LABEL[k]}</label>)}
      <span className="fine-print">Word, PDF, Excel and images: later.</span>
    </div>}
    <p className="disc-never">Never read, even in an allowed folder: SSH keys · .env files · passwords and keychains · browser and wallet data · system folders.</p>
  </section>;
}

export function DiscoveryView({ c, active }: { c: DiscoveryController; active: boolean }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { if (active && s.phase === 'idle') void c.load(); }, [active, c, s.phase]);
  useEffect(() => { if (active && !s.places.top) void c.loadPlaces(); }, [active, c, s.places.top]);
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
  const m = s.merge;
  const otherRoots = v.roots.filter(r => r.id !== 'computer' && r.watch);
  return <div className="disc">
    <div className="disc-side">
    <FolderTree c={c}/>
    <nav className="disc-roots" aria-label="Projects found">
      <span className="fine-print">By project folder</span>
      {v.roots.map(r => <button key={r.id} type="button" className="disc-root" aria-current={r.id === s.rootId ? 'true' : undefined} onClick={() => c.setRoot(r.id)}>
        <span className="disc-root-name"><b dir="auto">{r.name}</b><span className="fine-print" dir="auto">{r.watch ? r.project : 'not watched'}</span></span>
        <span className="disc-root-count">{r.group && <span className="disc-pill">merged</span>}{r.fresh > 0 && <span className="disc-pill" data-tone="new">{r.fresh} new</span>}<span>{r.count}</span></span>
      </button>)}
    </nav>
    </div>
    <section className="disc-main" aria-label="Found on this computer">
      <div className="disc-head">
        <div><h3>Found on this computer</h3><p className="fine-print">What coding agents left here: memory files, project notes, commands, skills, MCP servers, SSH hosts. Dpro only reads; your files never change.{v.leftOut > 0 ? ` ${v.leftOut} files were left out: copies, archives and other people's code.` : ''}{v.allowedFolders === 0 ? ' Tick folders on the left to find more projects.' : ''}</p></div>
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
          <span className="disc-push"/>
          {root.group ? <button type="button" className="link-button" disabled={s.busy} onClick={() => void c.separate(root.id)}>Separate again</button>
            : root.id !== 'computer' && root.watch && <button type="button" className="link-button" disabled={s.busy} onClick={() => c.startMerge([root.id], root.name)}>Merge with…</button>}
          {root.id !== 'computer' && !root.group && <button type="button" className="link-button" disabled={s.busy} onClick={() => void c.setRootWatch(root.id, !root.watch)}>{root.watch ? 'Stop watching this project' : 'Watch this project again'}</button>}
        </div>
        {root.group && <p className="fine-print disc-members">One project made of: {root.group.members.map(x => x.path).join('  +  ')}. The folders stay where they are.</p>}
        {(root.hidden ?? []).length > 0 && <p className="fine-print disc-members">Not shown from this project: {root.hidden!.map(k => <button key={k} type="button" className="link-button" onClick={() => void c.hideKind(root.id, k, false)}>{KIND_LABEL[k]} (show again)</button>)}</p>}
        {!shown.length ? <p className="fine-print disc-empty">Nothing here with this kind and state.</p> : <ul>
          {shown.map(it => <li key={it.id} className="disc-row" data-open={p?.id === it.id ? 'true' : undefined}>
            <input type="checkbox" aria-label={`Select ${it.name}`} checked={s.selected.includes(it.id)} disabled={s.busy || !(it.state === 'new' || it.state === 'changed')} onChange={() => c.toggle(it.id)}/>
            <span className="disc-kind">{KIND_SHORT[it.kind]}</span>
            <button type="button" className="disc-item" onClick={() => void c.open(it.id)}><b dir="auto">{it.name}</b><span className="fine-print" dir="auto">{it.from}</span></button>
            <span className="disc-to" dir="auto">{it.to}</span>
            <span className="disc-pill" data-tone={it.state}>{STATE_LABEL[it.state]}</span>
            <span className="disc-acts">
              <button type="button" className={it.state === 'new' || it.state === 'changed' || it.state === 'decision' ? 'primary' : undefined} disabled={s.busy} onClick={() => act(it)}>{it.kind === 'note' && it.state === 'imported' ? 'Open' : ACTION[it.state]}</button>
              {(it.state === 'new' || it.state === 'changed' || it.state === 'decision') && <button type="button" className="disc-quiet" disabled={s.busy} onClick={() => void c.ignore(it.id, true)}>Don't show again</button>}
            </span>
          </li>)}
        </ul>}
        <div className="disc-bulk">
          <span className="fine-print">{s.selected.length} selected</span>
          <button type="button" className="primary" disabled={!s.selected.length || s.busy} onClick={() => void c.importIds(s.selected)}>{s.busy ? 'Working…' : 'Import selected'}</button>
          <button type="button" disabled={!shown.some(i => i.state === 'new' || i.state === 'changed') || s.busy} onClick={() => { c.clear(); shown.filter(i => i.state === 'new' || i.state === 'changed').slice(0, 100).forEach(i => c.toggle(i.id)); }}>Select new and changed</button>
          {s.selected.length > 0 && <button type="button" disabled={s.busy} onClick={() => void c.ignoreMany(s.selected)}>Don't show these again</button>}
          {s.kind !== 'all' && <button type="button" disabled={s.busy} onClick={() => void c.hideKind(root.id, s.kind as DiscoveryItem['kind'], true)}>Don't show {KIND_LABEL[s.kind as DiscoveryItem['kind']].toLowerCase()} from this project</button>}
          {s.selected.length > 0 && <button type="button" className="link-button" onClick={() => c.clear()}>Clear</button>}
          <span className="fine-print disc-push">Memory files go in as they are (no model). Project notes are read by the local model, like Project files.</span>
        </div>
      </div>}
    </section>
    <aside className="disc-preview" aria-label={m ? 'Merge folders' : 'Item preview'}>
      {m && <section className="disc-merge" aria-label="Merge folders">
        <span className="fine-print">Show as one project</span>
        <h4>Merge {m.ids.length} folder{m.ids.length === 1 ? '' : 's'}</h4>
        <span className="fine-print">Only how Dpro shows them changes. The folders stay where they are.</span>
        <ul>{m.ids.map(id => { const r = v.roots.find(x => x.id === id); return <li key={id}><b dir="auto">{r?.name ?? id}</b><span className="fine-print" dir="ltr">{r?.path}</span>{m.ids.length > 1 && <button type="button" className="link-button" onClick={() => c.setMerge({ ids: m.ids.filter(x => x !== id) })}>Remove</button>}</li>; })}</ul>
        <label className="disc-field">Add a project<select value="" onChange={e => e.target.value && c.setMerge({ ids: [...m.ids, e.target.value] })}><option value="">Choose…</option>{otherRoots.filter(r => !m.ids.includes(r.id)).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label className="disc-field">Project name<input value={m.name} maxLength={80} onChange={e => c.setMerge({ name: e.target.value })}/></label>
        <div className="actions"><button type="button" className="primary" disabled={m.ids.length < 2 || !m.name.trim() || s.busy} onClick={() => void c.merge()}>Merge into one project</button><button type="button" onClick={() => c.cancelMerge()}>Cancel</button></div>
      </section>}
      {!m && s.previewLoading && <p className="fine-print" role="status">Opening…</p>}
      {!m && !p && !s.previewLoading && <p className="fine-print">Open an item to see it before it goes into Dpro.</p>}
      {!m && p && <>
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
      {v.suggestions.length > 0 && <section className="disc-suggest" aria-label="Suggested merges"><b>Suggested merges</b>
        {v.suggestions.map(x => <div key={x.key}><span dir="auto">{x.a.name} + {x.b.name}</span><button type="button" onClick={() => c.startMerge([x.a.id, x.b.id], x.b.name)}>Merge…</button><button type="button" className="link-button" onClick={() => void c.dismissSuggestion(x)}>Not the same</button></div>)}
      </section>}
      <section className="disc-rules" aria-label="Rules of this page"><b>Rules of this page</b>{RULES.map(r => <span key={r}>· {r}</span>)}</section>
    </aside>
  </div>;
}
