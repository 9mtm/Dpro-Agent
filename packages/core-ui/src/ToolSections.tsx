// Skills, MCP connections and Terminal as sections of their own (board M33
// L3–L5): each owns the sidebar, and each lists what the computer scan found
// for it ("Found on this computer"): skills, MCP servers, SSH hosts. Added
// skills and servers start off; SSH shows host names only, never keys.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SessionClient } from './session';
import { DiscoveryController, STATE_LABEL } from './discovery-controller';
import type { DiscoveryKind } from './discovery-contract.js';
import { SkillLibrary } from './SkillLibrary';
import { McpLibrary } from './McpLibrary';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { IconButton } from './desktop-ui';

type Place = { key: string; icon: UiIconName; label: string; badge?: number };

/** A section's sidebar (rendered into the shell's sidebar when it has a slot). */
function SectionSidebar({ title, places, current, onPick }: { title: string; places: Place[]; current: string; onPick: (key: string) => void }) {
  return <nav className="dk-sidebar" aria-label={`${title} places`}>
    <p className="section-label dk-label"><span>{title}</span></p>
    {places.map(p => <button key={p.key} type="button" className="nav-item dk-place" aria-current={current === p.key ? 'page' : undefined} onClick={() => onPick(p.key)}>
      <UiIcon name={p.icon} size={15}/><span className="dk-place-name">{p.label}</span>{p.badge ? <span className="dk-badge-pill">{p.badge}</span> : null}
    </button>)}
  </nav>;
}
function Section({ slot, active, sidebar, children, label }: { slot?: HTMLElement | null; active: boolean; sidebar: ReactNode; children: ReactNode; label: string }) {
  return <section className="dk-mem" aria-label={label} data-inline-sidebar={slot ? undefined : 'true'}>
    {slot ? (active ? createPortal(sidebar, slot) : null) : sidebar}
    <div className="dk-content">{children}</div>
  </section>;
}
function useDiscovery(client: SessionClient, active: boolean) {
  const [c, setC] = useState<DiscoveryController>();
  useEffect(() => { const x = new DiscoveryController(client); setC(x); return () => x.dispose(); }, [client]);
  useEffect(() => { if (active && c && c.getSnapshot().phase === 'idle') void c.load(); }, [active, c]);
  return c;
}
const fresh = (c: DiscoveryController | undefined, kind: DiscoveryKind) => (c?.getSnapshot().view?.items ?? []).filter(i => i.kind === kind && (i.state === 'new' || i.state === 'changed')).length;

/** Found on this computer for one kind: a quiet list, the selected one beside it with Add (off) and Don't show again. */
export function FoundOnComputer({ c, kind }: { c: DiscoveryController; kind: DiscoveryKind }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (s.phase === 'error') return <div className="dk-empty"><p>{s.notice ?? 'The scan could not be read.'}</p><button type="button" onClick={() => void c.load()}>Try again</button></div>;
  if (s.phase !== 'ready' || !s.view) return <p className="dk-empty" role="status">Reading what the scan found…</p>;
  const items = s.view.items.filter(i => i.kind === kind && i.state !== 'ignored');
  const root = (id: string | null) => s.view?.roots.find(r => r.id === id)?.name ?? 'This computer';
  const word = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'MCP servers' : 'SSH hosts';
  const p = s.preview && s.preview.kind === kind ? s.preview : null;
  return <div className="dk-split">
    <div className="dk-list" role="listbox" aria-label={`${word} found on this computer`}>
      <div className="dk-list-bar"><span className="fine-print">From the same scan as Memory (Settings › Memory › Folders and drives).</span><span className="dk-toolbar-gap"/><IconButton icon="refresh" label="Scan now" disabled={s.scanning} onClick={() => void c.scan()}/></div>
      {s.result && <p className="dk-inline-ok" role="status">{s.result}</p>}
      {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
      {!items.length && <div className="dk-empty"><p>No {word} found yet. Allow more folders in Settings › Memory › Folders and drives, then scan.</p></div>}
      {items.map(i => <div key={i.id} className="dk-row" role="option" aria-selected={p?.id === i.id || s.previewLoading === i.id} onClick={() => void c.open(i.id)}>
        <span className="dk-row-icon"><UiIcon name={kind === 'skill' ? 'file' : kind === 'mcp' ? 'tool' : 'terminal'} size={14}/></span>
        <span className="dk-row-text"><span className="dk-row-main">{i.name}</span><span className="dk-row-sub">{root(i.rootId)} · {i.from}{i.state !== 'imported' ? ` · ${STATE_LABEL[i.state].toLowerCase()}` : ' · added'}</span></span>
      </div>)}
    </div>
    <aside className="dk-split-detail" aria-label="Selected">{!p ? <p className="dk-empty">{s.previewLoading ? 'Opening…' : `Select one to see it.`}</p> : <div className="dk-insp">
      <div className="dk-insp-head"><UiIcon name={kind === 'skill' ? 'file' : kind === 'mcp' ? 'tool' : 'terminal'} size={20}/><div><h3>{p.name}</h3><p className="fine-print">{kind === 'skill' ? 'Skill' : kind === 'mcp' ? 'MCP server' : 'SSH host'} from {p.from}</p></div></div>
      {kind === 'ssh' ? <p className="fine-print">Host, user and port only. Keys are never read.</p> : <pre className="dk-preview" dir="auto">{p.text.slice(0, 4000)}{p.truncated ? '\n…' : ''}</pre>}
      {kind === 'mcp' && p.secrets.length > 0 && <div className="dk-ask"><p>It has a key. Save it in Credentials, or leave it on this computer?</p>
        <div className="dk-segmented" role="group" aria-label="The key">{(['credentials', 'leave'] as const).map(v => <button key={v} type="button" aria-pressed={s.secret === v} onClick={() => c.setSecret(v)}>{v === 'credentials' ? 'Credentials' : 'Leave it'}</button>)}</div></div>}
      {p.blocked && <p className="dk-inline-notice">{p.blocked}</p>}
      <div className="actions">
        <button type="button" onClick={() => void c.ignore(p.id, true)}>Don't show again</button>
        {p.state === 'imported' ? <button type="button" onClick={() => void c.remove(p.id)}>Take out</button>
          : <button type="button" className="primary" disabled={s.busy || !!p.blocked} onClick={() => void c.importOpen()}>{kind === 'ssh' ? 'Add host' : 'Add (off)'}</button>}
      </div>
      <p className="fine-print">{kind === 'skill' ? 'Added skills start off; turn them on per agent.' : kind === 'mcp' ? 'New MCP tools stay off until you turn them on.' : 'Added hosts are used only when you start a session to them.'}</p>
    </div>}</aside>
  </div>;
}

function Toolbar({ title, sub }: { title: string; sub?: string }) {
  return <header className="dk-toolbar"><div className="dk-title"><h2>{title}</h2>{sub && <span className="dk-sub">{sub}</span>}</div></header>;
}

export function SkillsSection({ client, active, slot }: { client: SessionClient; active: boolean; slot?: HTMLElement | null }) {
  const [place, setPlace] = useState('library');
  const c = useDiscovery(client, active);
  useSyncExternalStore(c?.subscribe ?? (() => () => {}), c?.getSnapshot ?? (() => null), c?.getSnapshot ?? (() => null));
  const places: Place[] = [{ key: 'library', icon: 'file', label: 'All skills' }, { key: 'found', icon: 'search', label: 'Found on this computer', badge: fresh(c, 'skill') }];
  return <Section slot={slot} active={active} label="Skills" sidebar={<SectionSidebar title="Skills" places={places} current={place} onPick={setPlace}/>}>
    <Toolbar title={place === 'found' ? 'Found on this computer' : 'Skills'} sub={place === 'found' ? 'skills from the computer scan' : 'abilities your agents can use'}/>
    <div className="dk-body">{place === 'found' ? (c ? <FoundOnComputer c={c} kind="skill"/> : null) : <div className="dk-files"><SkillLibrary client={client}/></div>}</div>
  </Section>;
}
export function McpSection({ client, active, slot }: { client: SessionClient; active: boolean; slot?: HTMLElement | null }) {
  const [place, setPlace] = useState('library');
  const c = useDiscovery(client, active);
  useSyncExternalStore(c?.subscribe ?? (() => () => {}), c?.getSnapshot ?? (() => null), c?.getSnapshot ?? (() => null));
  const places: Place[] = [{ key: 'library', icon: 'tool', label: 'Connected and library' }, { key: 'found', icon: 'search', label: 'Found on this computer', badge: fresh(c, 'mcp') }];
  return <Section slot={slot} active={active} label="MCP connections" sidebar={<SectionSidebar title="MCP connections" places={places} current={place} onPick={setPlace}/>}>
    <Toolbar title={place === 'found' ? 'Found on this computer' : 'MCP connections'} sub={place === 'found' ? 'MCP servers from the computer scan' : 'tools your agents can reach'}/>
    <div className="dk-body">{place === 'found' ? (c ? <FoundOnComputer c={c} kind="mcp"/> : null) : <div className="dk-files"><McpLibrary client={client}/></div>}</div>
  </Section>;
}
export function TerminalSection({ client, active, slot, onOpenTerminal }: { client: SessionClient; active: boolean; slot?: HTMLElement | null; onOpenTerminal: () => void }) {
  const [place, setPlace] = useState('sessions');
  const c = useDiscovery(client, active);
  useSyncExternalStore(c?.subscribe ?? (() => () => {}), c?.getSnapshot ?? (() => null), c?.getSnapshot ?? (() => null));
  const places: Place[] = [{ key: 'sessions', icon: 'terminal', label: 'Sessions' }, { key: 'found', icon: 'search', label: 'Found on this computer', badge: fresh(c, 'ssh') }];
  return <Section slot={slot} active={active} label="Terminal" sidebar={<SectionSidebar title="Terminal" places={places} current={place} onPick={setPlace}/>}>
    <Toolbar title={place === 'found' ? 'Found on this computer' : 'Terminal'} sub={place === 'found' ? 'SSH hosts from ~/.ssh/config (names only)' : 'a terminal beside your chat'}/>
    <div className="dk-body">{place === 'found' ? (c ? <FoundOnComputer c={c} kind="ssh"/> : null)
      : <div className="dk-empty"><UiIcon name="terminal" size={22}/><p>The terminal opens beside the chat, in the project folder of the chat.</p><button type="button" className="primary" onClick={onOpenTerminal}>Open the terminal</button></div>}</div>
  </Section>;
}
