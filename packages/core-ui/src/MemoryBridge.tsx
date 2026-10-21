// MEM-FINISH-01 (board M11): Memory › Coding apps — the memory bridge.
import { useSyncExternalStore } from 'react';
import { MemoryBridgeController, activityText } from './memory-bridge';
import { ago } from './memory-store';
import type { BridgeApp } from './memory-bridge-contract.js';

const MARK: Record<string, string> = { 'claude-code': 'CC', codex: 'CX', 'gemini-cli': 'GE', antigravity: 'AG' };
const date = (iso: string) => new Date(Date.parse(iso.length === 19 ? `${iso.replace(' ', 'T')}Z` : iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function appState(a: BridgeApp): { reg: string; tone: 'ok' | 'bad' | 'warn'; last: string } {
  const reg = a.registrationId ? (a.enabled ? `Registered · ${a.registeredAt ? date(a.registeredAt) : ''}` : 'Registered · off') : 'Not registered';
  const tone = a.registrationId ? (a.enabled ? 'ok' : 'bad') : 'warn';
  const last = !a.enabled && a.registrationId ? 'Off: every call is refused' : a.lastCallAt ? `Last call ${ago(a.lastCallAt) === 'now' ? 'just now' : `${ago(a.lastCallAt)} ago`}${a.lastTool ? ` · ${a.lastTool}` : ''}` : 'No calls yet';
  return { reg, tone, last };
}

/** A unified diff block: + lines green, - lines red, the rest quiet. */
function Diff({ text }: { text: string }) {
  return <pre className="mem-diff" aria-label="Change">{text.split('\n').map((l, i) => <span key={i} data-line={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>{l}{'\n'}</span>)}</pre>;
}

export function BridgeView({ c, onChangeFolder }: { c: MemoryBridgeController; onChangeFolder?: (projectId: string) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready' || !s.status) return <p className="empty-note" role="status">Loading coding apps…</p>;
  const st = s.status;
  const projectName = (id: string) => st.projects.find(p => p.projectId === id)?.name ?? 'a project';
  const p = s.preview;
  return <div className="mem-bridge">
    <div className="mem-bridge-main">
      <div className="mem-bridge-head">
        <h3>Coding apps share this memory</h3>
        <p className="fine-print">Each app reads approved facts and the latest handoff for the folder it works in, and can only propose new facts. Nothing is written to an app's config before you see the change.</p>
      </div>
      {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
      {s.result && <p className="memory-status" role="status">{s.result}</p>}
      {!st.serverReady && <p className="card-notice">The dpro-memory server cannot start from this install yet; registering still shows the exact change.</p>}
      <div className="mem-bridge-apps">{st.clients.map(a => {
        const x = appState(a);
        const selected = p?.kind === 'registration' && p.client === a.client;
        return <section key={a.client} className="mem-bridge-app" data-selected={selected || undefined} aria-label={a.name}>
          <div className="mem-bridge-app-head">
            <span className="mem-handoff-mark mem-bridge-mark">{MARK[a.client]}</span>
            <span className="mem-bridge-app-name"><span>{a.name}</span><span className="fine-print">{a.configPath}</span></span>
            <label className="check"><input type="checkbox" checked={a.enabled} disabled={s.busy} aria-label={`${a.name} may use Dpro memory`} onChange={e => void c.setEnabled(a.client, e.target.checked)}/>On</label>
          </div>
          <div className="mem-chips"><span className="mem-pill" data-health={x.tone === 'ok' ? undefined : x.tone === 'bad' ? 'problem' : 'attention'}>{x.reg}</span><span className="mem-pill mem-pill-quiet">{x.last}</span></div>
          <div className="actions">
            <button type="button" className={a.registrationId ? undefined : 'primary'} disabled={s.previewBusy} onClick={() => void c.previewRegistration(a.client)}>{a.registrationId ? 'Check registration' : 'Register…'}</button>
            {a.registrationId && (s.confirmUndo === a.client
              ? <span className="confirm-inline">Undo the registration?<button type="button" className="link-button danger" disabled={s.busy} onClick={() => void c.undo(a.client)}>Undo</button><button type="button" className="link-button" onClick={() => c.askUndo(null)}>Keep</button></span>
              : <button type="button" className="ghost" onClick={() => c.askUndo(a.client)}>Undo registration</button>)}
          </div>
        </section>;
      })}</div>
      <section className="mem-card mem-bridge-folders" aria-label="Folders and projects">
        <div className="mem-card-head"><h3>Folders and projects</h3><span className="fine-print">A folder belongs to one project; the app gets only that project's memory</span></div>
        <div className="mem-bridge-row mem-bridge-row-head"><span>Project</span><span>Folder on this computer</span><span>Managed files</span><span>Hide from Git</span><span>Bring back app notes</span><span/></div>
        {st.projects.length === 0 && <p className="fine-print">No project has a folder yet. Give a chat project a folder to share its memory with coding apps.</p>}
        {st.projects.map(f => {
          const files = f.filesEnabled ? `On${f.writtenAt ? ` · in sync ${ago(f.writtenAt) === 'now' ? 'just now' : `${ago(f.writtenAt)} ago`}` : ''}` : 'Off';
          return <div key={f.projectId} className="mem-bridge-row">
            <span className="mem-bridge-project">{f.name}</span>
            <span className="mem-bridge-folder"><span title={f.folder}>{f.folder}</span>{onChangeFolder && <button type="button" className="link-button" onClick={() => onChangeFolder(f.projectId)}>Change</button>}</span>
            <span data-tone={f.filesEnabled ? 'ok' : undefined} className={f.filesEnabled ? undefined : 'fine-print'}>{files}</span>
            <label className="check"><input type="checkbox" checked={f.gitExclude} disabled={s.busy} aria-label="Keep the managed files out of Git" onChange={e => void c.setFolder(f.projectId, { gitExclude: e.target.checked })}/>{f.gitExclude ? 'Hidden' : 'Visible'}</label>
            <span className="mem-bridge-back"><label className="check"><input type="checkbox" checked={f.backflowEnabled} disabled={s.busy} aria-label="Import this folder's app notes as reviews" onChange={e => void c.setFolder(f.projectId, { backflowEnabled: e.target.checked })}/>{f.backflowEnabled ? 'On' : 'Off'}</label>
              <button type="button" className="link-button" disabled={s.busy} onClick={() => void c.backflowNow(f.projectId)}>Now</button></span>
            {f.filesEnabled ? <button type="button" disabled={s.busy} onClick={() => void c.setFolder(f.projectId, { filesEnabled: false })}>Stop updating</button>
              : <button type="button" className="primary" disabled={s.previewBusy} onClick={() => void c.previewFiles(f.projectId)}>Preview &amp; turn on</button>}
          </div>;
        })}
        <span className="fine-print">Dpro writes only between its own markers in AGENTS.md / CLAUDE.md / GEMINI.md. Your own text in those files is never changed. App notes come back as reviews, never as saved facts.</span>
      </section>
    </div>
    <aside className="mem-bridge-side" aria-label="Registration preview">
      {s.previewBusy && !p && <p role="status" className="fine-print">Making the preview…</p>}
      {p?.kind === 'registration' && <>
        <div className="mem-bridge-step"><span className="mem-link-text fine-print">Step 1 of 2 · Preview</span><h3>Register Dpro memory in {p.preview.name}</h3><span className="fine-print">{p.preview.configPath} · a backup is kept first</span></div>
        {p.preview.action === 'unchanged' ? <p className="memory-status">Already registered: the config has exactly Dpro’s entry.</p>
          : p.preview.action === 'conflict' ? <p className="card-notice">Dpro cannot change this file safely: {p.preview.reason ?? 'conflict'}.</p> : <Diff text={p.preview.diff}/>}
        <div className="mem-bridge-notes">
          <span>Tools {p.preview.name} gets: project brief · pinned facts · latest handoff · search · propose a fact · write a handoff</span>
          <span data-tone="ok">No key, password or token goes into this file.</span>
          <span className="fine-print">{p.preview.name} asks Dpro for a short-lived pass each session; turning {p.preview.name} off stops it at once.</span>
          {p.preview.warnings.map((w, i) => <span key={i} data-tone="warn">{w}</span>)}
        </div>
        <div className="actions">
          <button type="button" className="primary" disabled={s.previewBusy || p.preview.action === 'conflict' || p.preview.action === 'unchanged'} onClick={() => void c.confirm()}>Confirm and register</button>
          <button type="button" onClick={() => c.cancelPreview()}>Cancel</button>
        </div>
        <p className="mem-bridge-warn">If the file changed after this preview, Dpro stops and shows a new preview.</p>
      </>}
      {p?.kind === 'files' && <>
        <div className="mem-bridge-step"><span className="mem-link-text fine-print">Step 1 of 2 · Preview</span><h3>Turn on managed files for {projectName(p.projectId)}</h3><span className="fine-print">{p.preview.folder}</span></div>
        {p.preview.files.map(f => <div key={f.relative} className="mem-bridge-file"><span className="mem-bridge-file-name">{f.relative} · {f.action}</span>{f.action === 'conflict' ? <span data-tone="warn">{f.reason}</span> : f.action !== 'unchanged' && <Diff text={f.diff}/>}</div>)}
        <div className="actions">
          <button type="button" className="primary" disabled={s.previewBusy || p.preview.conflicts > 0} onClick={() => void c.confirm()}>Confirm and turn on</button>
          <button type="button" onClick={() => c.cancelPreview()}>Cancel</button>
        </div>
        <p className="mem-bridge-warn">Only Dpro’s section changes. If a file changed after this preview, Dpro stops and shows a new preview.</p>
      </>}
      {!p && !s.previewBusy && <p className="fine-print">Pick “Register…” on an app or “Preview &amp; turn on” on a folder to see the exact change first.</p>}
      <h4 id="bridge-audit" className="mem-handoff-history-head">Recent bridge activity</h4>
      {s.audit.length === 0 ? <p className="fine-print">Nothing yet.</p> : <ul className="mem-bridge-audit">{s.audit.map(e => <li key={e.id}><span className="fine-print">{ago(e.createdAt)}</span><span>{activityText(e, projectName)}</span></li>)}</ul>}
    </aside>
  </div>;
}
