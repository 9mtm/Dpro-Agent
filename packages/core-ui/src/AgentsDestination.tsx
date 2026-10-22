import { PersonalityController } from './personality';
import { AgentCard } from './AgentCard';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentsController } from './agents';
import { HireController } from './hire';
import { HireAgent } from './HireAgent';
import { CompanyController } from './company';
import { CompanyWizard } from './CompanyWizard';
import { namingLanguages, validatedDisplayName } from './naming';
import type { NamingLanguage } from './naming';
import type { SessionClient } from './session';
import { ConnectorsSection } from './ConnectorsSection';
import { createPortal } from 'react-dom';
import { UiIcon } from './ui-icons';
import { Avatar } from './desktop-ui';
import { StaffDirectory } from './StaffDirectory';

export function AgentsDestination({ client, active = false, onOpenMemory, focusConnectors = false, sidebarSlot,focusAgent }: { client: SessionClient; active?: boolean; onOpenMemory?: (agentId?: string) => void; focusConnectors?: boolean; sidebarSlot?: HTMLElement | null;focusAgent?:{id:string;n:number}|null }) {
  const [department,setDepartment]=useState('all');
  const [connections,setConnections]=useState(focusConnectors);
  useEffect(()=>{if(focusConnectors)setConnections(true);},[focusConnectors]);
  const [open, setOpen] = useState<string | null>(null);
  // The effect owns subscription cleanup; construction also supports offline SSR without reads.
  const [controller, setController] = useState<AgentsController>();
  const [personality, setPersonality] = useState<PersonalityController>();
  const [hire, setHire] = useState<HireController>();
  const [hiring, setHiring] = useState(false);
  const [company, setCompany] = useState<CompanyController>();
  const [building, setBuilding] = useState(false);
  const session = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const owner = session.phase === 'authenticated' && session.user?.role === 'owner';
  useEffect(() => {
    const c = new AgentsController(client), p = new PersonalityController(client), h = new HireController(client), w = new CompanyController(client);
    const unsubscribe = c.subscribe(() => {
      const selected = c.getSnapshot().selected; p.select(selected?.id ?? '', selected?.version);
    });
    setController(c); setPersonality(p); setHire(h); setCompany(w);
    return () => { unsubscribe(); c.dispose(); p.dispose(); h.dispose(); w.dispose(); };
  }, [client]);
  useEffect(()=>{if(active&&focusAgent)setOpen(focusAgent.id);},[active,focusAgent?.n]);
  // Opening the page shows the team at once (one read the first time the page is shown).
  useEffect(() => { if (active && session.phase === 'authenticated' && controller && controller.getSnapshot().phase === 'idle' && !controller.getSnapshot().agents.length) void controller.list(); }, [active, session.phase, controller]);
  // The Agents section owns the sidebar: search, New agent and the team by department (board M28 H4).
  const sidebar = sidebarSlot && active && controller ? createPortal(<AgentsSidebar controller={controller} open={open} onOpen={id => setOpen(id)} onTeam={() => setOpen(null)}
    department={department} onDepartment={d=>{setDepartment(d);setConnections(false);setOpen(null);}} connections={connections} onConnections={()=>{setConnections(true);setOpen(null);}}
    onNew={owner && hire ? () => { setOpen(null); hire.restart(); setHiring(true); } : undefined}/>, sidebarSlot) : null;
  if (open && controller && !owner) return <>{sidebar}<MemberAgent controller={controller} agentId={open} onBack={() => setOpen(null)}/></>;
  if (open && controller && personality) return <section aria-label="Agents">
    <AgentCard sidebarSlot={active?sidebarSlot:null} client={client} agentId={open} agents={controller} personality={personality} onBack={() => { setOpen(null); void controller.list(); }} onOpenMemory={onOpenMemory}/>
  </section>;
  const newHire=()=>{if(hire){hire.restart();setHiring(true);}};
  const newCompany=()=>{if(company){company.restart();setBuilding(true);}};
  return <section aria-label="Agents" className="agents-destination">{sidebar}
    {owner && company && building && <CompanyWizard controller={company} onClose={() => { setBuilding(false); void controller?.list(); }}/>}
    {owner && hire && hiring && !building && <HireSheet onClose={()=>{setHiring(false);void controller?.list();}}><HireAgent controller={hire} onClose={() => { setHiring(false); void controller?.list(); }}/></HireSheet>}
    {connections ? <><div className="staff-toolbar"><button title="Back to staff" aria-label="Back to staff" onClick={()=>setConnections(false)}><UiIcon name="arrow-left" size={16}/></button><h2>Agent connections</h2></div><div className="staff-connections">{owner?<ConnectorsSection client={client} active={active} focus={focusConnectors}/>:<p>Only the owner can configure connections.</p>}</div></> : controller ? <StaffDirectory controller={controller} department={department} onDepartment={setDepartment} onOpen={setOpen} onMemory={onOpenMemory} onHire={owner?newHire:undefined} onCompany={owner?newCompany:undefined}/>:<p role="status">Loading your team…</p>}
  </section>;

}

/** Members can inspect the readable directory without requesting owner-only configuration. */
export function MemberAgent({ controller, agentId, onBack }: { controller: AgentsController; agentId: string; onBack: () => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const agent = s.agents.find(a => a.id === agentId);
  return <section aria-label="Agent overview">
    <button type="button" onClick={onBack}>Team</button>
    <h2><bdi>{agent?.name ?? 'Agent unavailable'}</bdi></h2>
    {agent?.description && <p dir="auto">{agent.description}</p>}
    <h3>Tools & permissions</h3>
    <p>Only the workspace owner can view or change tool permissions. Ask the owner to configure this agent.</p>
  </section>;
}

const ROLE: Record<string, string> = { main: 'Main agent', manager: 'Manager', specialist: 'Specialist', evaluator: 'Evaluator' };
/** The team as cards, grouped by department; a card opens the agent. */
export function TeamGrid({ controller, onOpen }: { controller: AgentsController; onOpen: (id: string) => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [query, setQuery] = useState('');
  if (s.phase === 'listing' && !s.agents.length) return <p className="empty-note" role="status">Loading the team…</p>;
  if (s.phase === 'denied') return <p className="empty-note">Only the owner can manage the team here.</p>;
  if (s.phase === 'idle' && !s.agents.length) return <p className="empty-note" role="status">Loading the team…</p>;
  if (!s.agents.length) return <div className="empty-note"><p>{s.phase === 'error' ? 'The team could not be loaded.' : 'No agents yet. Hire your first one above.'}</p>{s.phase === 'error' && <button type="button" onClick={() => void controller.list()}>Try again</button>}</div>;
  const q = query.trim().toLowerCase();
  const shown = s.agents.filter(a => !q || [a.name, a.role, a.department, a.description].some(x => (x ?? '').toLowerCase().includes(q)));
  const groups = new Map<string, typeof shown>();
  for (const a of [...shown].sort((x, y) => Number(!!y.isPrimary) - Number(!!x.isPrimary) || (x.name ?? '').localeCompare(y.name ?? ''))) {
    const k = a.isPrimary ? '' : a.department ?? 'other';
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const order = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a === 'other' ? 1 : b === 'other' ? -1 : a.localeCompare(b)));
  return <div className="team">
    <div className="team-tools">
      <span className="fine-print">{s.agents.length} {s.agents.length === 1 ? 'agent' : 'agents'}</span>
      {s.agents.length > 6 && <input type="search" className="team-filter" placeholder="Filter by name, role or department" aria-label="Filter the team" value={query} onChange={e => setQuery(e.target.value)}/>}
      <button type="button" className="ghost" onClick={() => void controller.list()} disabled={s.phase === 'listing'}>Reload</button>
    </div>
    {order.map(k => <section key={k || 'main'} className="team-group" aria-label={k ? `Department ${k}` : 'Main agent'}>
      {k && <h3 className="team-group-title">{k === 'other' ? 'No department' : k[0].toUpperCase() + k.slice(1)}</h3>}
      <ul className="team-grid">{groups.get(k)!.map(a => <li key={a.id}>
        <button type="button" className="team-card" onClick={() => onOpen(a.id)}>
          <span className="team-avatar" aria-hidden="true">{(a.name ?? '?').trim().slice(0, 1).toUpperCase() || '?'}</span>
          <span className="team-text">
            <span className="team-name"><bdi>{a.name ?? 'Name unavailable'}</bdi>{a.isPrimary && <span className="chip accent">Main</span>}</span>
            <span className="team-role">{[a.role ? ROLE[a.role] : null, a.department].filter(Boolean).join(' · ') || 'No role yet'}</span>
            {a.description && <span className="team-desc" dir="auto">{a.description}</span>}
          </span>
        </button></li>)}</ul>
    </section>)}
    {shown.length === 0 && <p className="empty-note">No agent matches.</p>}
  </div>;
}
/** Readable status for each controller phase (the controller keeps its own words). */
const phaseLabel: Record<string, string> = {
  idle: 'Team not loaded yet', listing: 'Loading the team…', reading: 'Opening the agent…', ready: 'Ready',
  generating: 'Suggesting a name…', saving: 'Saving…', saved: 'Saved', review: 'Changed elsewhere — review before saving',
  unknown: 'Outcome unknown — reconcile before editing', reconciling: 'Checking the latest version…', error: 'Something went wrong', denied: 'Access denied',
};
export function AgentsReview({ controller }: { controller: AgentsController }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [language, setLanguage] = useState<NamingLanguage>('en');
  const busy = ['listing', 'reading', 'saving', 'reconciling', 'generating'].includes(s.phase);
  const name = validatedDisplayName(s.draft);
  return <>
    <button disabled={busy} onClick={() => void controller.list()}>{s.agents.length ? 'Reload team' : 'Load team'}</button>
    {s.agents.length > 0 && <ul className="team-grid" aria-label="Team members">{s.agents.map(a =>
      <li key={a.id}><button type="button" className="team-card" aria-pressed={s.selected?.id === a.id} disabled={busy} onClick={() => void controller.select(a.id)}>
        <span className="team-avatar" aria-hidden="true">{(a.name ?? '?').trim().slice(0, 1).toUpperCase() || '?'}</span>
        <span className="team-text"><bdi className="team-name">{a.name ?? 'Name unavailable'}</bdi><bdi className="team-id">{a.id}</bdi></span>
      </button></li>)}
    </ul>}
    <label className={s.agents.length > 0 ? 'sr-only' : undefined}>Selected agent<select value={s.selected?.id ?? ''} disabled={busy} onChange={e => void controller.select(e.target.value)}>
      <option value="">Select an agent</option>{s.agents.map(a => <option value={a.id} key={a.id}>{a.name ?? 'Name unavailable'} · {a.id}</option>)}
    </select></label>
    <p role="status">{s.notice ?? phaseLabel[s.phase] ?? s.phase}</p>
    {s.selected && <>
      <dl><dt>Stable ID</dt><dd><bdi>{s.selected.id}</bdi></dd><dt>Latest acknowledged name</dt><dd><bdi>{s.selected.name ?? 'Name unavailable'}</bdi></dd><dt>Version</dt><dd>{s.selected.version}</dd></dl>
      <label>Draft name<input value={s.draft} disabled={!s.owner || s.selected.nameUnavailable || busy || s.unknown} onChange={e => controller.edit(e.target.value)}/></label>
      <label>Suggestion language<select value={language} disabled={busy} onChange={e => setLanguage(e.target.value as NamingLanguage)}>{namingLanguages.map(l => <option key={l}>{l}</option>)}</select></label>
      <button disabled={!s.owner || s.selected.nameUnavailable || busy || s.unknown} onClick={() => void controller.generate(language)}>Generate draft</button>
      {!name && <p>Enter a name of 1–60 Unicode characters after normalization; control characters are unavailable.</p>}
      {name && name !== s.draft && <p>Normalized name to save: <bdi>{name}</bdi></p>}
      {(s.unknown || s.refreshRequired) && <button disabled={busy} onClick={() => void controller.reconcile()}>Reconcile with GET</button>}
      {s.needsReview && !s.unknown && !s.refreshRequired && <button disabled={busy} onClick={() => controller.review()}>I reviewed the latest name, version and draft</button>}
      <button className="primary" disabled={!s.owner || s.selected.nameUnavailable || busy || s.unknown || s.refreshRequired || s.needsReview || !name || name === s.selected.name} onClick={() => void controller.save()}>Save name</button>
      <button disabled={busy || s.unknown} onClick={() => controller.cancel()}>Cancel draft</button>
    </>}
  </>;
}

/** The Agents section's sidebar: search agents, New agent, the team by department. */
function AgentsSidebar({controller,open,onOpen,onTeam,onNew,department,onDepartment,connections,onConnections}:{controller:AgentsController;open:string|null;onOpen:(id:string)=>void;onTeam:()=>void;onNew?:()=>void;department:string;onDepartment:(value:string)=>void;connections:boolean;onConnections:()=>void}){
 const s=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const departments=[...new Set(s.agents.map(a=>a.department).filter((d):d is string=>!!d))].sort();
 return <nav className="dk-sidebar staff-sidebar" aria-label="Agents"><div className="dk-side-top"><p className="section-label">Workspace</p></div>
 <button className="nav-item dk-place" aria-current={!open&&!connections&&department==='all'?'page':undefined} onClick={()=>{onDepartment('all');onTeam();}}><UiIcon name="users" size={16}/><span>All staff</span></button>
 {s.agents.filter(a=>a.isPrimary).map(a=><button key={a.id} className="nav-item dk-place" aria-current={open===a.id?'page':undefined} onClick={()=>onOpen(a.id)}><UiIcon name="sparkle" size={16}/><span>Main agent</span></button>)}
 <p className="section-label dk-label">Departments</p>
 {departments.map(d=><button key={d} className="nav-item dk-place" aria-current={!connections&&!open&&department===d?'page':undefined} onClick={()=>onDepartment(d)}><UiIcon name="folder" size={16}/><span className="dk-place-name">{d[0].toUpperCase()+d.slice(1)}</span></button>)}
 <button className="nav-item dk-place" aria-current={!connections&&!open&&department==='none'?'page':undefined} onClick={()=>onDepartment('none')}><UiIcon name="inbox" size={16}/><span>No department</span></button>
 <p className="section-label dk-label">Setup</p><button className="nav-item dk-place" aria-current={connections?'page':undefined} onClick={onConnections}><UiIcon name="link" size={16}/><span>Agent connections</span></button>
 </nav>;
}
function HireSheet({children,onClose}:{children:React.ReactNode;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
 return <dialog ref={ref} className="staff-hire-sheet" aria-label="Hire an agent" onCancel={e=>{e.preventDefault();}}>{children}</dialog>;
}
