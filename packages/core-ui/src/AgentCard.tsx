import { AgentMcp } from './McpLibrary';
import { AgentSkills } from './SkillLibrary';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AgentCardController, readable, TOOL_GROUPS, toolGroup } from './agent-card';
import type { CardTab } from './agent-card';
import type { AgentsController } from './agents';
import type { PersonalityController } from './personality';
import { PersonalityReview } from './PersonalityReview';
import { permissionCategories, drawerKinds } from './hire-contract.js';
import type { TraitName } from './agent-card-contract.js';
import { drawerLabel } from './MemoryViews';
import { AgentMemoryController, handoffLine } from './agent-memory';
import { ago, oneLine } from './memory-store';
import { validatedDisplayName } from './naming';
import { UiIcon } from './ui-icons';

const TABS: { key: CardTab; label: string }[] = [
  // Board M6: Memory next to the persona; tools and MCP together; drawer and action permissions under Access.
  { key: 'profile', label: 'Profile' }, { key: 'persona', label: 'Persona' }, { key: 'memory', label: 'Memory' }, { key: 'skills', label: 'Skills' }, { key: 'mcp', label: 'Tools & MCP' }, { key: 'permissions', label: 'Access' },
];
const VIEWS: { label: string; tabs: CardTab[] }[] = [{ label: 'Profile', tabs: ['profile', 'persona'] }, { label: 'Memory', tabs: ['memory'] }, { label: 'Skills and tools', tabs: ['skills', 'mcp', 'permissions'] }];
const ROLE_LABEL: Record<string, string> = { '': 'No role', main: 'Main agent', manager: 'Manager', specialist: 'Specialist', evaluator: 'Evaluator' };
const TRAIT: Record<TraitName, [string, string, string]> = {
  doubt: ['Doubt', 'Trusts quickly', 'Checks everything'], caution: ['Caution', 'Bold', 'Careful'], creativity: ['Creativity', 'Conventional', 'Inventive'],
  thoroughness: ['Thoroughness', 'Quick', 'Thorough'], independence: ['Independence', 'Asks often', 'Decides alone'], verbosity: ['Length', 'Short', 'Detailed'],
  warmth: ['Warmth', 'Neutral', 'Warm'], curiosity: ['Curiosity', 'Focused', 'Explores'], persistence: ['Persistence', 'Gives up early', 'Keeps trying'],
};
export const CATEGORY: Record<string, string> = { browser: 'Use the browser', network: 'Reach the internet', message: 'Send messages', delete: 'Delete things', install: 'Install software', money: 'Spend money', settings: 'Change settings' };
const DIALECT: Record<string, string> = { 'ar-IQ': 'Arabic (Iraqi)', ar: 'Arabic', en: 'English', de: 'German', fr: 'French', es: 'Spanish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', 'pt-BR': 'Portuguese (Brazil)', ru: 'Russian', tr: 'Turkish', hi: 'Hindi' };

/**
 * One agent's card: who it is (profile), how it behaves (persona, versioned),
 * what it may do (tools, memory drawers, off/ask/allow) and what it can
 * remember (the memories in drawers it may read).
 */
export function AgentCard({ client, agentId, agents, personality, onBack, onOpenMemory }: {
  client: ConstructorParameters<typeof AgentCardController>[0]; agentId: string; agents: AgentsController; personality: PersonalityController;
  onBack: () => void; onOpenMemory?: (agentId?: string) => void;
}) {
  const [card, setCard] = useState<AgentCardController>();
  useEffect(() => { const c = new AgentCardController(client, agentId); setCard(c); void c.load(); void agents.select(agentId); return () => c.dispose(); }, [client, agentId, agents]);
  if (!card) return null;
  return <CardView card={card} agents={agents} personality={personality} onBack={onBack} onOpenMemory={onOpenMemory}/>;
}

export function CardView({ card, agents, personality, onBack, onOpenMemory }: { card: AgentCardController; agents?: AgentsController; personality?: PersonalityController; onBack: () => void; onOpenMemory?: (agentId?: string) => void }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const a = s.agent;
  const busy = s.phase === 'saving' || s.phase === 'loading';
  return <article className="agent-card" aria-label={a?.name ? `Agent ${a.name}` : 'Agent'}>
    <header className="agent-card-head">
      <button type="button" className="back-link" onClick={onBack}><span aria-hidden="true">‹</span> Team</button>
      <div className="agent-card-id">
        <span className="team-avatar large" aria-hidden="true">{(a?.name ?? '?').trim().slice(0, 1).toUpperCase()}</span>
        <div>
          <h3><bdi>{a?.name ?? (s.phase === 'loading' ? 'Loading…' : 'Agent')}</bdi>{a?.isPrimary && <span className="chip accent">Main</span>}</h3>
          <p className="agent-card-sub">{[ROLE_LABEL[a?.role ?? ''], a?.department].filter(Boolean).join(' · ')}{s.persona && <> · {s.persona.locked ? 'Persona locked' : `Persona v${s.persona.version}`}</>}</p>
        </div>
      </div>
      {/* Board M28 H4: three views (Profile · Memory · Skills and tools); each keeps its parts as a short second row. */}
      <div className="seg" role="tablist" aria-label="Agent card">{VIEWS.map(v =>
        <button key={v.label} type="button" role="tab" aria-selected={v.tabs.includes(s.tab)} onClick={() => void card.openTab(v.tabs[0])}>{v.label}</button>)}</div>
      {(VIEWS.find(v => v.tabs.includes(s.tab))?.tabs.length ?? 0) > 1 && <div className="seg small" role="tablist" aria-label="Parts">{VIEWS.find(v => v.tabs.includes(s.tab))!.tabs.map(k =>
        <button key={k} type="button" role="tab" aria-selected={s.tab === k} onClick={() => void card.openTab(k)}>{TABS.find(t => t.key === k)!.label}</button>)}</div>}
    </header>
    {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
    {s.saved && <p className="card-saved" role="status"><UiIcon name="check" size={12}/>{s.saved}</p>}
    {s.phase === 'error' ? null : <>
      {s.tab === 'profile' && <ProfileTab card={card} agents={agents} busy={busy}/>}
      {s.tab === 'persona' && <PersonaTab card={card} personality={personality} busy={busy}/>}
      {s.tab === 'permissions' && <PermissionsTab card={card} busy={busy} part="access"/>}
      {s.tab === 'mcp' && <><PermissionsTab card={card} busy={busy} part="tools"/><AgentMcp key={s.agentId} client={card.client} agentId={s.agentId}/></>}
      {s.tab === 'skills' && <AgentSkills key={s.agentId} client={card.client} agentId={s.agentId}/>}
      {s.tab === 'memory' && <MemoryTab card={card} onOpenMemory={onOpenMemory}/>}
    </>}
  </article>;
}

function ProfileTab({ card, agents, busy }: { card: AgentCardController; agents?: AgentsController; busy: boolean }) {
  const s = card.getSnapshot();
  useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const n = useSyncExternalStore(agents ? agents.subscribe : noop, agents ? agents.getSnapshot : none, agents ? agents.getSnapshot : none);
  const nameOk = n ? validatedDisplayName(n.draft) : null;
  const nameBusy = !!n && ['listing', 'reading', 'saving', 'reconciling', 'generating'].includes(n.phase);
  return <div className="card-section">
    {agents && n?.selected && <div className="field-row">
      <label className="field"><span>Name</span>
        <input value={n.draft} disabled={nameBusy || n.unknown} onChange={e => agents.edit(e.target.value)}/></label>
      <button type="button" disabled={nameBusy || !nameOk || nameOk === n.selected.name || n.needsReview || n.refreshRequired} onClick={() => void agents.save()}>Save name</button>
      <button type="button" className="ghost" disabled={nameBusy} onClick={() => void agents.generate('en')}>Suggest</button>
    </div>}
    <div className="field-grid">
      <label className="field"><span>Role</span>
        <select value={s.profile.role} disabled={busy} onChange={e => card.editProfile({ role: e.target.value })}>
          {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
      <label className="field"><span>Department</span>
        <input value={s.profile.department} placeholder="e.g. marketing" maxLength={64} disabled={busy} onChange={e => card.editProfile({ department: e.target.value })}/></label>
    </div>
    <ModelField card={card} busy={busy}/>
    <label className="field"><span>What this agent does</span>
      <textarea rows={3} value={s.profile.description} maxLength={1000} disabled={busy} dir="auto" onChange={e => card.editProfile({ description: e.target.value })}/></label>
    <p className="fine-print">A role change never changes the persona or the permissions; those are set in their own tabs.</p>
    <div className="card-actions">
      <button type="button" className="primary" disabled={busy || !card.profileChanged()} onClick={() => void card.saveProfile()}>Save profile</button>
      <span className="fine-print">Agent ID <bdi>{s.agentId}</bdi></span>
    </div>
  </div>;
}

function PersonaTab({ card, personality, busy }: { card: AgentCardController; personality?: PersonalityController; busy: boolean }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const [note, setNote] = useState('');
  const p = s.persona, d = s.personaDraft;
  if (!p || !d) return <p className="fine-print">The persona could not be loaded.</p>;
  const locked = p.locked;
  return <div className="card-section">
    <div className="persona-presets" role="group" aria-label="Start from a preset">
      {p.presets.map(x => <button key={x.id} type="button" className="chip-button" aria-pressed={d.preset === x.id} disabled={busy || locked} onClick={() => card.applyPreset(x.id)}>{x.label}</button>)}
      {d.preset === null && <span className="chip">Custom</span>}
    </div>
    <div className="traits">{p.traitNames.map(t => {
      const [label, low, high] = TRAIT[t];
      return <label key={t} className="trait">
        <span className="trait-name">{label}</span>
        <span className="trait-scale"><small>{low}</small>
          <input type="range" min={0} max={100} step={5} value={d.traits[t]} disabled={busy || locked} onChange={e => card.setTrait(t, Number(e.target.value))} aria-valuetext={`${d.traits[t]} of 100`}/>
          <small>{high}</small></span>
        <span className="trait-value" data-changed={d.traits[t] !== p.traits[t] || undefined}>{d.traits[t]}</span>
      </label>;
    })}</div>
    <div className="field-grid">
      <label className="field"><span>Language and dialect</span>
        <select value={d.dialect} disabled={busy || locked} onChange={e => card.setDialect(e.target.value)}>
          {p.dialects.map(x => <option key={x} value={x}>{DIALECT[x] ?? x}</option>)}
        </select></label>
      <label className="field"><span>Note for this version (optional)</span>
        <input value={note} maxLength={500} disabled={busy || locked} placeholder="Why the change" onChange={e => setNote(e.target.value)}/></label>
    </div>
    <p className="fine-print">The persona shapes how the agent answers and when it asks first. It never gives tools or permissions.</p>
    <div className="card-actions">
      <button type="button" className="primary" disabled={busy || locked || !card.personaChanged()} onClick={() => { void card.savePersona(note); setNote(''); }}>Save as new version</button>
      <button type="button" disabled={busy} onClick={() => void card.lock(!locked)}>{locked ? 'Unlock persona' : 'Lock persona'}</button>
    </div>
    {s.versions && s.versions.length > 0 && <section className="card-sub" aria-label="Persona history">
      <h4>History</h4>
      <ol className="version-list">{s.versions.map(v => <li key={v.version} data-current={v.version === p.version || undefined}>
        <span className="version-n">v{v.version}</span>
        <span className="version-what">{v.preset ? p.presets.find(x => x.id === v.preset)?.label ?? v.preset : 'Custom'} · {DIALECT[v.dialect] ?? v.dialect}{v.locked ? ' · locked' : ''}{v.note ? <> · <bdi>{v.note}</bdi></> : ''}</span>
        <span className="version-when">{v.source === 'seed' ? 'first version' : (v.createdAt ?? '').slice(0, 16).replace('T', ' ')}</span>
        {v.version === p.version ? <span className="chip">Current</span>
          : <button type="button" className="ghost-action" disabled={busy || locked} onClick={() => void card.rollback(v.version)}>Restore</button>}
      </li>)}</ol>
    </section>}
    {personality && <section className="card-sub" aria-label="Suggested persona changes"><PersonalityReview controller={personality}/></section>}
  </div>;
}

/** Access (drawers + actions) or Tools (by kind); one save for both. */
function PermissionsTab({ card, busy, part }: { card: AgentCardController; busy: boolean; part: 'access' | 'tools' }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const [confirm, setConfirm] = useState(false);
  const d = s.permissionDraft, g = s.grants, gd = s.grantDraft ?? [];
  if (!d || !g) return <p className="fine-print">Loading permissions…</p>;
  const save = () => { if (card.riskyAllowed() && !confirm) { setConfirm(true); return; } setConfirm(false); void card.savePermissions(card.riskyAllowed()); };
  return <div className="card-section">
    {part === 'access' && <><section className="card-sub" aria-label="Memory drawers">
      <h4>Memory</h4>
      <p className="fine-print">Which of your memory drawers this agent may read, and which it may add to.</p>
      <table className="perm-table"><thead><tr><th scope="col">Drawer</th><th scope="col">Read</th><th scope="col">Write</th></tr></thead>
        <tbody>{drawerKinds.map(k => <tr key={k}><th scope="row">{drawerLabel({ kind: k as never })}</th>
          <td><input type="checkbox" aria-label={`Read ${k}`} checked={d.memoryRead.includes(k)} disabled={busy} onChange={() => card.toggleDrawer(k, 'read')}/></td>
          <td><input type="checkbox" aria-label={`Write ${k}`} checked={d.memoryWrite.includes(k)} disabled={busy} onChange={() => card.toggleDrawer(k, 'write')}/></td></tr>)}</tbody></table>
      <label className="check"><input type="checkbox" checked={d.sharedMemory} disabled={busy} onChange={e => card.setShared(e.target.checked)}/>Share what it learns with the team</label>
    </section>
    <section className="card-sub" aria-label="Actions">
      <h4>Actions</h4>
      <div className="mode-list">{permissionCategories.map(c => <div key={c} className="mode-row"><span>{CATEGORY[c] ?? c}</span>
        <span className="seg small" role="radiogroup" aria-label={CATEGORY[c] ?? c}>{(['off', 'ask', 'allow'] as const).map(m =>
          <button key={m} type="button" role="radio" aria-checked={d.modes[c] === m} disabled={busy} onClick={() => card.setMode(c, m)}>{m === 'off' ? 'Off' : m === 'ask' ? 'Ask me' : 'Allow'}</button>)}</span></div>)}</div>
    </section></>}
    {part === 'tools' && <section className="card-sub" aria-label="Tools">
      <h4>Tools <small className="fine-print">{gd.length} of {g.available.length} on</small></h4>
      {TOOL_GROUPS.map(group => {
        const tools = g.available.filter(t => toolGroup(t.name) === group);
        if (!tools.length) return null;
        const on = tools.filter(t => gd.includes(t.name)).length;
        return <div key={group} className="tool-group">
          <div className="tool-group-head">
            <span className="tool-group-name">{group}</span>
            <span className="fine-print">{on} of {tools.length} on</span>
            <button type="button" className="ghost-action" disabled={busy} onClick={() => card.setTools(tools.map(t => t.name), on < tools.length)}>{on < tools.length ? 'Turn all on' : 'Turn all off'}</button>
          </div>
          <ul className="tool-grid">{tools.map(t => {
            const off = !t.allowedByServer;
            return <li key={t.name}><label className="tool-check" data-off={off || undefined}>
              <input type="checkbox" checked={gd.includes(t.name)} disabled={busy || (off && !gd.includes(t.name))} onChange={() => card.toggleTool(t.name)}/>
              <span><code>{t.name}</code>{t.requiresApproval && <span className="chip">asks first</span>}{off && <span className="chip">off on this server</span>}<small>{t.description}</small></span>
            </label></li>;
          })}</ul>
        </div>;
      })}
    </section>}
    {confirm && <p className="card-notice" role="alert">You allowed a risky action (spend money, install software or delete). Press Save again to confirm.</p>}
    <div className="card-actions sticky">
      <button type="button" className="primary" disabled={busy || !card.permissionsChanged()} onClick={save}>{confirm ? 'Confirm and save' : 'Save permissions'}</button>
    </div>
  </div>;
}

/**
 * The agent's memory (board M6): what it may remember (drawers read / write,
 * shared with the team; its role template and exceptions from Memory › Access),
 * the notes it wrote itself, its handoffs, and its skills and tools at a glance.
 */
function MemoryTab({ card, onOpenMemory }: { card: AgentCardController; onOpenMemory?: (agentId?: string) => void }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const [mem, setMem] = useState<AgentMemoryController>();
  useEffect(() => { const m = new AgentMemoryController(card.client as never, s.agentId); setMem(m); void m.load(); return () => m.dispose(); }, [card, s.agentId]);
  const m = useSyncExternalStore(mem?.subscribe ?? noopSubscribe, mem?.getSnapshot ?? noSnapshot, mem?.getSnapshot ?? noSnapshot);
  const d = s.permissionDraft, g = s.grants, gd = s.grantDraft ?? [];
  const busy = s.phase === 'saving' || s.phase === 'loading';
  const name = s.agent?.name ?? 'This agent';
  if (!d) return <p className="fine-print">Loading memory…</p>;
  const a = m?.access;
  return <div className="card-section agent-memory">
    <div className="agent-memory-grid">
      <section className="card-sub" aria-label="Drawer access">
        <h4>What {name} may remember</h4>
        <table className="perm-table"><thead><tr><th scope="col">Drawer</th><th scope="col">Read</th><th scope="col">Write</th></tr></thead>
          <tbody>{drawerKinds.map(k => <tr key={k}><th scope="row">{drawerLabel({ kind: k as never })}</th>
            <td><input type="checkbox" aria-label={`Read ${k}`} checked={d.memoryRead.includes(k)} disabled={busy} onChange={() => card.toggleDrawer(k, 'read')}/></td>
            <td><input type="checkbox" aria-label={`Write ${k}`} checked={d.memoryWrite.includes(k)} disabled={busy} onChange={() => card.toggleDrawer(k, 'write')}/></td></tr>)}</tbody></table>
        <label className="check"><input type="checkbox" checked={d.sharedMemory} disabled={busy} onChange={e => card.setShared(e.target.checked)}/>Share what it learns with the team</label>
        <div className="card-actions"><button type="button" className="primary" disabled={busy || !card.permissionsChanged()} onClick={() => void card.savePermissions(false)}>Save memory access</button></div>
        {a && <p className="fine-print">{a.template ? <>Role template: <b>{a.template.name}</b>. </> : 'No role template. '}{a.exceptions.length ? `${a.exceptions.length} ${a.exceptions.length === 1 ? 'exception' : 'exceptions'} in Memory › Access.` : ''} Effective now: reads {a.effective.memoryRead.map(k => drawerLabel({ kind: k as never })).join(', ') || 'nothing'}.</p>}
        <p className="fine-print">Off / ask / allow per action stays under Access.</p>
      </section>
      <div className="agent-memory-col">
        <section className="card-sub" aria-label="Its own notes">
          <h4>Its own notes <small className="fine-print">{m?.notes ? `${m.notes.total} ${m.notes.total === 1 ? 'note' : 'notes'}` : '…'}</small></h4>
          {m?.notes && m.notes.items.length === 0 && <p className="fine-print">{name} has not written a memory yet.</p>}
          <ul className="agent-notes">{(m?.notes?.items ?? []).map(n => <li key={n.id} dir="auto">{oneLine(n.preview)}</li>)}</ul>
          {onOpenMemory && <div className="card-actions"><button type="button" onClick={() => onOpenMemory(s.agentId)}>Edit notes</button><button type="button" onClick={() => onOpenMemory(s.agentId)}>History</button></div>}
        </section>
        <section className="card-sub" aria-label="Handoffs">
          <h4>Handoffs</h4>
          {m?.handoffs === null || !m ? <p className="fine-print">…</p> : m.handoffs.length === 0 ? <p className="fine-print">No handoff notes yet. The agent writes one when a larger piece of work ends.</p>
            : <ul className="agent-handoffs">{m.handoffs.map(h => <li key={h.id}><span className="fine-print">{h.kind === 'conversation' ? 'Chat' : 'Board task'} · {ago(h.createdAt)}</span><span>{handoffLine(h)}</span></li>)}</ul>}
        </section>
      </div>
      <div className="agent-memory-col">
        <section className="card-sub" aria-label="Skills">
          <h4>Skills <button type="button" className="link-button" onClick={() => void card.openTab('skills')}>Choose…</button></h4>
          {m?.skills === null || !m ? <p className="fine-print">…</p> : m.skills.length === 0 ? <p className="fine-print">No skills assigned.</p>
            : <div className="mem-chips">{m.skills.map(k => <span key={k} className="chip">{k}</span>)}</div>}
          <p className="fine-print">From the central skill library; updates arrive with the library.</p>
        </section>
        <section className="card-sub" aria-label="Tools and MCP">
          <h4>Tools &amp; MCP <button type="button" className="link-button" onClick={() => void card.openTab('mcp')}>Manage…</button></h4>
          {g ? TOOL_GROUPS.map(group => { const tools = g.available.filter(t => toolGroup(t.name) === group); if (!tools.length) return null;
            return <span key={group} className="mem-line"><span>{group}</span><span className="fine-print">{tools.filter(t => gd.includes(t.name)).length} of {tools.length} on</span></span>; }) : <p className="fine-print">…</p>}
          <p className="fine-print">New MCP tools stay off until you turn them on.</p>
        </section>
      </div>
    </div>
  </div>;
}
const noopSubscribe = () => () => {};
const noSnapshot = () => undefined;

/** The agent's default model: installed local models, and Claude only when a key exists. */
function ModelField({ card, busy }: { card: AgentCardController; busy: boolean }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const models = s.models ?? [];
  const current = s.profile.model;
  const known = models.some(m => m.id === current);
  const claudeWithoutKey = s.agent?.provider === 'claude' && !models.some(m => m.provider === 'claude');
  return <label className="field"><span>Model</span>
    <select value={current} disabled={busy || !models.length} onChange={e => card.editProfile({ model: e.target.value })}>
      {!known && <option value={current}>{current || 'Not set'}{claudeWithoutKey ? ' (no Claude key: answers use the local model)' : ''}</option>}
      {models.some(m => m.provider === 'ollama') && <optgroup label="On this computer">{models.filter(m => m.provider === 'ollama').map(m => <option key={m.id} value={m.id}>{m.label}{m.size ? ` · ${m.size}` : ''}</option>)}</optgroup>}
      {models.some(m => m.provider === 'claude') && <optgroup label="Claude (paid)">{models.filter(m => m.provider === 'claude').map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>}
    </select>
    {claudeWithoutKey && <small className="fine-print">This agent is set to Claude but no Claude key is saved, so it answers with the local model. Pick a local model here to make that explicit.</small>}
  </label>;
}

const noop = () => () => {};
const none = () => undefined;
