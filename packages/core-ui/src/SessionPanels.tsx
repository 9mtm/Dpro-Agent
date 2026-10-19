import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { bindMemorySession, displayName } from './session';
import type { SessionClient } from './session';
import { createMemoryAdapter, MemoryController, validDrawer } from './memory';
import { AgentsController } from './agents';
import { MemoryReview } from './MemoryDestination';
import { MemoryBulkReview } from './MemoryBulkReview';
import { BulkReviewController } from './memory';
import { Markdown } from './markdown';

const roleName: Record<string, string> = { owner: 'Owner', admin: 'Admin', user: 'Member', guest: 'Guest' };
const roleHelp: Record<string, string> = {
  owner: 'Full control: hires agents, sets their permissions and approves memory changes.',
  admin: 'Manages agents and settings, but cannot change permissions or approve memory.',
  user: 'Works with the agents; cannot change the team.',
  guest: 'Read-only access.',
};
/** Profile, this session, and sign-out on all devices behind an explicit confirmation. */
export function AccountPanel({ client }: { client: SessionClient }) {
  const state = client.getSnapshot();
  const user = state.user!;
  const [confirm, setConfirm] = useState(false);
  return <section className="panel account-page" aria-label="Account"><h2>Account</h2>
    <div className="account-card">
      <span className="team-avatar account-avatar" aria-hidden="true">{displayName(user).trim().slice(0, 1).toUpperCase() || '?'}</span>
      <div className="account-who">
        <p className="account-name">Signed in as <bdi>{displayName(user)}</bdi></p>
        <p className="fine-print"><bdi>{user.email}</bdi></p>
      </div>
      <span className="badge">{roleName[user.role] ?? user.role}</span>
    </div>
    <p className="fine-print">{roleHelp[user.role] ?? ''}</p>

    <section className="account-section" aria-label="This session">
      <h3>This session</h3>
      <dl>
        <dt>Connection</dt><dd>{state.mode === 'live' ? 'This installation' : state.mode === 'mock' ? 'Offline practice (fictional data)' : 'Preview'}</dd>
        <dt>Device</dt><dd>This browser only; the sign-in is not stored on disk.</dd>
      </dl>
    </section>

    <section className="account-section account-danger" aria-label="Sign out everywhere">
      <h3>Sign out everywhere</h3>
      <p>Ends every session of this account, on all devices. You will need to sign in again here too.</p>
      <label className="check"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)}/>I understand: this revokes every session for this account.</label>
      <div className="hire-actions"><button className="danger" disabled={!confirm} onClick={() => void client.logoutAllDevices()}>Sign out on all devices</button></div>
    </section>
  </section>;
}
/** Readable status for each memory review phase. */
const memoryLabel: Record<string, string> = {
  idle: 'Choose an agent and drawer, then read', loading: 'Reading memory…', ready: 'Ready', deciding: 'Recording your decision…',
  rejected: 'Rejected', denied: 'Access denied', error: 'Something went wrong', stale: 'Changed elsewhere — read again',
  pending: 'Waiting for your review', expired: 'Session expired — sign in again', unavailable: 'Memory service unavailable', unknown: 'Outcome unknown — read again',
};
type DrawerKind = 'owner' | 'experience' | 'project' | 'task' | 'people';
const drawerTabs: readonly { kind: DrawerKind; label: string; help: string }[] = [
  { kind: 'owner', label: 'About you', help: 'What the agent knows about you: preferences, identity, how you like to work.' },
  { kind: 'experience', label: 'Lessons', help: 'What the agent learned from past work.' },
  { kind: 'project', label: 'Project', help: 'Memory for one project (lowercase name, e.g. website).' },
  { kind: 'task', label: 'Task', help: 'Memory for one task, by its ID.' },
  { kind: 'people', label: 'Person', help: 'What the agent knows about one person, by their ID.' },
];
/** Drawer ID for a tab and key, or '' when the key is missing or invalid. */
export function drawerId(kind: DrawerKind, key: string): string {
  if (kind === 'owner' || kind === 'experience') return kind;
  const id = `${kind}:${key.trim()}`;
  return key.trim() && validDrawer(id) ? id : '';
}
export function MemoryPanel({ client, active = false }: { client: SessionClient; active?: boolean }) {
  const state = client.getSnapshot();
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState<DrawerKind>('owner'); const [key, setKey] = useState('');
  const [query, setQuery] = useState('');
  const [bulk, setBulk] = useState(false);
  const [team, setTeam] = useState<AgentsController>();
  useEffect(() => { const c = new AgentsController(client); setTeam(c); return () => c.dispose(); }, [client]);
  const teamState = useSyncExternalStore(team ? team.subscribe : noop, team ? team.getSnapshot : nothing, team ? team.getSnapshot : nothing);
  const controller = useMemo(() => new MemoryController(createMemoryAdapter(client.request, c => { const current = client.getSnapshot(); return current.phase === 'authenticated' && current.user?.role === 'owner' && current.user.id === c.userId && String(current.epoch) === c.session; }), {
    userId: state.user!.id, agentId: '', drawerId: 'owner', access: state.user!.role === 'owner' ? 'owner' : 'denied', session: String(state.epoch),
  }), [client, state.epoch, state.user]);
  const memory = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => bindMemorySession(client, controller), [client, controller]);
  const busy = memory.phase === 'loading' || memory.phase === 'deciding';
  const owner = state.user!.role === 'owner';
  const tab = drawerTabs.find(t => t.kind === kind)!;
  const agents = teamState?.agents ?? [];
  const chosen = agents.find(a => a.id === agent);
  const shown = agents.filter(a => !query.trim() || (a.name ?? '').toLowerCase().includes(query.trim().toLowerCase()));
  /** Read one drawer of one agent (each click is an explicit read). */
  const read = (agentId: string, drawer: string) => { if (!owner || !agentId || !drawer) return; setBulk(false); controller.setContext({ ...memory.context, agentId, drawerId: drawer }); void controller.load(); };
  const keyed = kind === 'project' || kind === 'task' || kind === 'people';
  // Opening the page shows the team at once (one read the first time the page is shown).
  useEffect(() => { if (active && owner && team && teamState?.phase === 'idle' && !agents.length) void team.list(); }, [active, owner, team, teamState?.phase, agents.length]);

  return <section className="memory-page" aria-label="Memory review">
    <header className="memory-head">
      <h2>Memory</h2>
      <p>What each agent remembers about you and its work, and the changes it asks you to approve.{state.mode === 'mock' ? ' Offline practice: fictional memory only.' : ''}</p>
    </header>
    {!agents.length
      ? <div className="memory-start">{owner ? <button type="button" className="primary" disabled={teamState?.phase === 'listing'} onClick={() => void team?.list()}>{teamState?.phase === 'listing' ? 'Opening…' : 'Open memory'}</button>
        : <p className="fine-print">Only the owner can read agents' memory.</p>}</div>
      : <div className="memory-layout">
        <nav className="memory-team" aria-label="Agents">
          {agents.length > 8 && <input aria-label="Find an agent" placeholder="Find an agent" value={query} onChange={e => setQuery(e.target.value)}/>}
          <ul>{shown.map(a => <li key={a.id}>
            <button type="button" className="memory-agent" aria-current={agent === a.id ? 'true' : undefined} disabled={busy}
              onClick={() => { setAgent(a.id); setKind('owner'); setKey(''); read(a.id, 'owner'); }}>
              <span className="board-avatar" aria-hidden="true">{(a.name ?? '?').trim().slice(0, 1).toUpperCase() || '?'}</span>
              <bdi>{a.name ?? 'Name unavailable'}</bdi>
            </button>
          </li>)}</ul>
        </nav>
        <div className="memory-main">
          {!chosen ? <p className="memory-empty">Choose an agent to read what it remembers.</p> : <>
            <div className="memory-agent-head">
              <span className="board-avatar large" aria-hidden="true">{(chosen.name ?? '?').trim().slice(0, 1).toUpperCase() || '?'}</span>
              <div><h3><bdi>{chosen.name}</bdi></h3><p className="fine-print">{tab.help}</p></div>
            </div>
            <div className="memory-tabs" role="tablist" aria-label="Memory drawers">{drawerTabs.map(t =>
              <button key={t.kind} type="button" role="tab" aria-selected={kind === t.kind} disabled={busy}
                onClick={() => { setKind(t.kind); setKey(''); if (t.kind === 'owner' || t.kind === 'experience') read(agent, t.kind); else controller.invalidate(); }}>{t.label}</button>)}
            </div>
            {keyed && <form className="memory-key" onSubmit={e => { e.preventDefault(); read(agent, drawerId(kind, key)); }}>
              <label>{kind === 'project' ? 'Project name' : kind === 'task' ? 'Task ID' : 'Person ID'}<input value={key} maxLength={128} placeholder={kind === 'project' ? 'e.g. website' : kind === 'task' ? 'e.g. T-12' : 'e.g. mira@example.com'} onChange={e => setKey(e.target.value)}/></label>
              <button type="submit" disabled={busy || !drawerId(kind, key)}>Open</button>
            </form>}
            {(memory.phase !== 'ready' && memory.phase !== 'idle' || memory.unknownOutcome || memory.decisionNotice) && <p role="status" className="memory-status">
              {memory.unknownOutcome ? 'Decision outcome unknown. Read again to see the current state; nothing was sent twice.' : memory.decisionNotice ? `${memory.decisionNotice}. Open the change again before deciding.` : memory.phase === 'accepted' ? 'Approved and saved.' : memoryLabel[memory.phase] ?? memory.phase}</p>}
            {bulk && <MemoryBulkReview adapter={controller.adapter} context={memory.context} proposals={memory.proposals} onClose={changed => { setBulk(false); if (changed) void controller.load(); }}/>}
            {!bulk && memory.proposals.length > 0 && <section className="memory-pending" aria-label="Waiting for your review">
              <h4>{memory.proposals.length} {memory.proposals.length === 1 ? 'change waits' : 'changes wait'} for your review</h4>
              {BulkReviewController.eligible(memory.proposals).length > 1 && !!controller.adapter.decide && <button type="button" className="memory-bulk-open" disabled={memory.phase === 'deciding'} onClick={() => setBulk(true)}>Review {BulkReviewController.eligible(memory.proposals).length} imported memories together</button>}
              <ul>{memory.proposals.map(p => <li key={p.id}>
                <span>{sourceLabel[p.source] ?? p.source}</span><span className="fine-print">{p.createdAt.slice(0, 16).replace('T', ' ')}</span>
                <button type="button" aria-pressed={memory.detail?.id === p.id} disabled={memory.phase === 'deciding'} onClick={() => void controller.open(p.id)}>Review</button>
              </li>)}</ul>
            </section>}
            <MemoryReview key={memory.review ?? memory.phase} state={memory} locale="en" contract canDecide={!!controller.adapter.decide} onDecision={(action, reviewed) => void controller.decide(action, reviewed)}/>
            {memory.drawer && memory.context.agentId === agent && <article className="memory-body" aria-label="Stored memory">
              {memory.drawer.count === 0
                ? <p className="memory-empty">Nothing stored here yet. {chosen.name} adds to it as it works with you.</p>
                : <><p className="fine-print">{memory.drawer.count} {memory.drawer.count === 1 ? 'entry' : 'entries'}</p><div className="memory-text" dir="auto"><Markdown text={readableDrawer(memory.drawer.content)}/></div></>}
            </article>}
          </>}
        </div>
      </div>}
  </section>;
}
const noop = () => () => {};
const nothing = () => undefined;
/** The drawer text without the generated file header comments (display only). */
export function readableDrawer(content: string): string {
  return content.replace(/<!--[\s\S]*?-->[ \t]*\n?/g, '').replace(/^\s+/, '');
}
const sourceLabel: Record<string, string> = { file: 'Edited file', upload: 'Upload', learning: 'Learned', agent: 'Agent proposal', import: 'Import' };
