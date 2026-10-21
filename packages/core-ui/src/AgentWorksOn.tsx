// Board M36 Q1: the Memory step of a new agent says which projects (or a
// whole group) it works on and what it may save there, and shows what it
// will read before anything changes. It becomes access exceptions for this
// agent, previewed first and applied with the preview's hash.
import { useEffect, useState } from 'react';
import type { SessionClient } from './session';
import { Tile } from './desktop-ui';
import type { ScopeTree } from './memory-pages-contract.js';
import type { ProjectGroup } from './memory-desktop-contract.js';

type Save = 'nothing' | 'lessons' | 'facts';
export function AgentWorksOn({ client, agentId, agentName }: { client: SessionClient; agentId: string; agentName: string }) {
  const [tree, setTree] = useState<ScopeTree | null>(null);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [save, setSave] = useState<Save>('lessons');
  const [state, setState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'error'; text?: string }>({ phase: 'idle' });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [t, g] = await Promise.all([client.request({ method: 'GET', path: '/api/memory/scopes/tree' } as never), client.request({ method: 'GET', path: '/api/memory/groups' } as never)]);
        if (!live) return;
        if (t.status === 200) setTree(t.body as ScopeTree);
        if (g.status === 200) setGroups((g.body as { groups: ProjectGroup[] }).groups);
      } catch { /* the step works without the list */ }
    })();
    return () => { live = false; };
  }, [client]);
  const projects = (tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto);
  const name = (slug: string) => projects.find(p => p.slug === slug)?.name ?? slug;
  const toggle = (slugs: string[], on: boolean) => setChosen(c => on ? [...new Set([...c, ...slugs])] : c.filter(x => !slugs.includes(x)));
  async function apply() {
    const changes = chosen.slice(0, 100).map(slug => ({ op: 'set_rule', scope: `project:${slug}`, agentId, drawerKind: 'project', read: 'allow', write: save === 'facts' ? 'allow' : 'deny', reason: 'works on this project' }));
    if (save !== 'nothing') changes.push({ op: 'set_rule', scope: 'company', agentId, drawerKind: 'experience', read: 'allow', write: 'allow', reason: 'its own lessons' });
    if (!changes.length) return;
    setState({ phase: 'busy' });
    try {
      const p = await client.request({ method: 'POST', path: '/api/memory/access/preview', body: { changes } } as never);
      if (p.status !== 200) { setState({ phase: 'error', text: 'The preview was refused. Set it later in Settings › Memory › Access.' }); return; }
      const hash = (p.body as { previewHash: string }).previewHash;
      const a = await client.request({ method: 'POST', path: '/api/memory/access/apply', body: { changes, expectedPreviewHash: hash, confirm: true } } as never);
      setState(a.status === 200 ? { phase: 'done', text: `${agentName} now works on ${chosen.length} ${chosen.length === 1 ? 'project' : 'projects'}.` } : { phase: 'error', text: 'Not applied. Set it later in Settings › Memory › Access.' });
    } catch { setState({ phase: 'error', text: 'No connection. Set it later in Settings › Memory › Access.' }); }
  }
  if (!tree) return null;
  return <fieldset className="hire-scope hire-works" disabled={state.phase === 'busy' || state.phase === 'done'}><legend>Works on</legend>
    {groups.length > 0 && <div className="hire-works-row">{groups.map(g => <label key={g.id} className="check"><input type="checkbox" checked={g.projects.length > 0 && g.projects.every(p => chosen.includes(p))} onChange={e => toggle(g.projects, e.target.checked)}/><Tile name={g.name}/>{g.name} <span className="fine-print">({g.projects.length} projects)</span></label>)}</div>}
    <div className="hire-works-row">{projects.map(p => <label key={p.slug} className="check"><input type="checkbox" checked={chosen.includes(p.slug)} onChange={e => toggle([p.slug], e.target.checked)}/><Tile name={p.name}/>{p.name}</label>)}</div>
    <label className="hire-works-save">It may save<select value={save} onChange={e => setSave(e.target.value as Save)}><option value="nothing">Nothing</option><option value="lessons">Its own lessons; facts go to Needs you</option><option value="facts">Lessons and project facts</option></select></label>
    {chosen.length > 0 && <p className="fine-print">It will read: {chosen.map(name).join(', ')}, the company rules and the lessons of its department. Never: About you (unless you allow), other departments, keys.</p>}
    {state.phase !== 'done' && <button type="button" disabled={!chosen.length} onClick={() => void apply()}>Apply</button>}
    {state.text && <p className={state.phase === 'error' ? 'card-notice' : 'fine-print'} role="status">{state.text}</p>}
    <p className="fine-print">Change it later in Agents › {agentName} › Memory or Settings › Memory › Access.</p>
  </fieldset>;
}
