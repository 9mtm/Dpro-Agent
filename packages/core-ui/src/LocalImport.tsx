import { useEffect, useState, useSyncExternalStore } from 'react';
import { ViewTabs } from './ViewTabs';
import { LocalImportController } from './local-import';
import { AutomaticProjectImport } from './AutomaticProjectImport';
import { ProjectFilesImport } from './ProjectFilesImport';
import { LOCAL_SOURCES } from './local-import-contract.js';
import type { LocalSession, LocalSource } from './local-import-contract.js';
import type { SessionClient } from './session';

const SOURCE: Record<LocalSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', 'gemini-cli': 'Gemini CLI' };
const shortPath = (p: string) => { const home = p.match(/^\/Users\/[^/]+/)?.[0]; return home ? `~${p.slice(home.length)}` : p; };

/** Bring in what you told other agents: pick conversations, the local model proposes memories, you approve each one. */
export function LocalImport({ client, active, onReview }: { client: SessionClient; active: boolean; onReview: () => void }) {
  const [controller, setController] = useState<LocalImportController>();
  useEffect(() => {
    const current = new LocalImportController(client);
    setController(current);
    return () => current.dispose();
  }, [client]);
  return controller ? <LocalImportView controller={controller} client={client} active={active} onReview={onReview}/> : <section aria-label="Import from other agents"><h3>Import from other agents</h3><p>Manual imports wait for your approval. Automatic import saves directly when enabled.</p><p role="status">Looking for conversations…</p></section>;
}

export function LocalImportView({ controller: c, active, onReview, client }: { controller: LocalImportController; active: boolean; onReview: () => void; client?: SessionClient }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [importKind,setImportKind]=useState<'conversations'|'files'>('files');
  const [source, setSource] = useState<'all' | LocalSource>('all');
  const [query, setQuery] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  useEffect(() => { if (active && s.phase === 'idle') void c.load(); }, [active, c, s.phase]);
  const q = query.trim().toLowerCase();
  const shown = s.sessions.filter(x => (source === 'all' || x.source === source) && (!onlyNew || !x.imported) && (!q || x.title.toLowerCase().includes(q) || (x.cwd ?? '').toLowerCase().includes(q)));
  const groups = new Map<string, LocalSession[]>();
  for (const x of shown.slice(0, 200)) { const k = x.cwd ? shortPath(x.cwd) : 'No folder'; groups.set(k, [...(groups.get(k) ?? []), x]); }
  const running = s.busy || s.job?.status === 'running';
  return <section className="local-import" aria-label="Import from other agents">
    <div className="local-import-head">
      <div><h3>Import from other agents</h3>
        <p className="fine-print">Choose conversations or project documents from this computer using the tabs below. Secrets are removed first, a private copy is kept in <code>{s.archive || '~/.dpro/imports'}</code>, and the local model suggests lasting memories. Manual imports wait for your approval. Automatic import saves directly when enabled. The original files are never changed.</p></div>
    </div>
    <ViewTabs id="import-source" label="Import source type" value={importKind} onChange={setImportKind} tabs={[{value:'conversations',label:'Conversations'},{value:'files',label:'Project files'}]}/>
    <div id="import-source-panel" role="tabpanel" aria-labelledby={`import-source-${importKind}`}>
    <p className="fine-print">{importKind === 'conversations' ? 'Saved conversations from Claude Code, Codex and other agents.' : 'Project notes: CLAUDE.md, AGENTS.md and handoff files.'}</p>
    {client && importKind==='files' && <><AutomaticProjectImport client={client}/><ProjectFilesImport client={client} controller={c} busy={!!running}/></>}
    {s.progress && <p role="status">Processed {s.progress.done} of {s.progress.total} selected sources · {s.progress.proposed} {s.job?.automatic?'memories processed automatically.':'memories proposed for review.'}</p>}
    {s.job && <div className="local-import-job" role="status" data-status={s.job.status}>
      {running ? <>Reading {s.job.done} of {s.job.total}… <span className="local-import-bar" aria-hidden="true"><i style={{ inlineSize: `${s.job.total ? Math.round((s.job.done / s.job.total) * 100) : 0}%` }}/></span></>
        : <>{s.job.notice ?? (s.job.status === 'done' ? 'Done.' : 'The import stopped.')}{s.job.errors > 0 && ` ${s.job.errors} could not be read.`}
          {(s.job.status === 'error' || s.job.status === 'paused') && s.job.done < s.job.total && <button type="button" onClick={() => void c.resume()}>Resume import</button>}
          {s.job.proposed > 0 && <> <button type="button" className="link-button" onClick={onReview}>Review them now</button></>}</>}
      {s.job.status === 'running' && <button type="button" onClick={() => void c.pause()}>Pause import</button>}
    </div>}
    {importKind==='conversations' && (s.preview || s.previewLoading || s.previewError) && <aside className="local-import-preview" aria-label="Conversation preview">
      <header><h4>Conversation preview</h4><button type="button" onClick={() => c.closePreview()}>Close preview</button></header>
      <p className="fine-print">Read-only preview. Secrets are masked; the original file is unchanged.</p>
      {s.previewLoading && <p role="status">Opening conversation…</p>}
      {s.previewError && <p role="alert">{s.previewError}</p>}
      {s.preview && <><p>{SOURCE[s.preview.source]} · {s.sessions.find(x => x.id === s.preview?.id)?.title}</p>
        <div className="local-import-messages">{s.preview.messages.map((m,i) => <article key={i} data-role={m.role}><strong>{m.role === 'user' ? 'You' : SOURCE[s.preview!.source]}</strong><p dir="auto">{m.text}</p></article>)}</div>
        {s.preview.truncated && <p className="fine-print">Showing a shortened preview. Import still reads the selected conversation.</p>}
      </>}
    </aside>}
    {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
    {(importKind==='conversations' || !client) && (s.phase === 'loading' && !s.sessions.length ? <p className="fine-print" role="status">Looking for conversations…</p>
      : s.phase === 'error' ? <p className="fine-print">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>
      : <>
        <div className="local-import-tools">
          <div className="seg small" role="radiogroup" aria-label="Source">
            {(['all', ...LOCAL_SOURCES] as const).map(k => <button key={k} type="button" role="radio" aria-checked={source === k} onClick={() => setSource(k)}>
              {k === 'all' ? 'All' : SOURCE[k]} <span className="muted">{k === 'all' ? s.sessions.length : s.sessions.filter(x => x.source === k).length}</span></button>)}
          </div>
          <input type="search" placeholder="Find by words or folder" aria-label="Find conversations" value={query} onChange={e => setQuery(e.target.value)}/>
          <label className="term-check"><input type="checkbox" checked={onlyNew} onChange={e => setOnlyNew(e.target.checked)}/>Not imported yet</label>
          <button type="button" disabled={!shown.length || running} onClick={() => c.selectAll(shown.map(x => x.id))}>Select all matching ({shown.length})</button>
          <p className="fine-print">{s.selected.length} selected. The import continues when you leave this page. If you close Dpro, it resumes when Dpro starts again unless you pause it.</p>
          <button type="button" className="primary" disabled={!s.selected.length || running} onClick={() => void c.start()}>{running ? 'Importing…' : `Import ${s.selected.length || ''} ${s.selected.length === 1 ? 'conversation' : 'conversations'}`.replace('  ', ' ')}</button>
          {s.selected.length > 0 && !running && <button type="button" className="link-button" onClick={() => c.clear()}>Clear</button>}
        </div>
        {!shown.length ? <p className="fine-print">{s.sessions.length ? 'No conversation matches.' : 'No conversations from other agents were found on this computer.'}</p>
          : [...groups].map(([folder, list]) => <div key={folder} className="local-import-group">
            <p className="local-import-folder" dir="ltr" title={folder}>{folder}</p>
            <ul>{list.map(x => <li key={x.id}>
              <div className="local-import-row">
                <input type="checkbox" aria-label={`Select ${x.title || 'conversation'}`} checked={s.selected.includes(x.id)} disabled={running} onChange={() => c.toggle(x.id)}/>
                <button type="button" className="local-import-open" onClick={() => void c.preview(x.id)} aria-label={`Preview ${x.title || 'conversation'}`}>
                  <span className="local-import-title" dir="auto">{x.title || '(no text)'}</span>
                  <span className="local-import-meta">{SOURCE[x.source]} · {new Date(x.updatedAt).toLocaleDateString()} · {x.turns} messages{x.imported ? ` · imported, ${x.imported.proposed} suggested` : ''} · Preview →</span>
                </button>
              </div>
            </li>)}</ul>
          </div>)}
        {shown.length > 200 && <p className="fine-print">Showing the newest 200; search to find older ones.</p>}
      </>)}
    </div>
  </section>;
}
