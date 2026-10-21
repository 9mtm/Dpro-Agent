// MEM-UI-01 P6 (board M6): what one agent may remember and what it left.
// Its effective memory access (role template, exceptions), the notes it
// wrote itself, its handoffs, and a summary of its skills.
import { Store } from './memory-store';
import type { Requester } from './memory-store';
import { queryString } from './memory-pages-contract.js';
import type { EffectiveAccess, ExplorerPage, Handoff } from './memory-pages-contract.js';
import { SKILLS_PATH } from './skill-library-contract.js';

export type AgentMemoryState = Readonly<{
  phase: 'idle' | 'loading' | 'ready';
  access: EffectiveAccess | null; notes: ExplorerPage | null; handoffs: readonly Handoff[] | null; skills: readonly string[] | null;
}>;

export class AgentMemoryController extends Store<AgentMemoryState> {
  constructor(client: Requester, readonly agentId: string) {
    super({ phase: 'idle', access: null, notes: null, handoffs: null, skills: null }, client);
  }
  async load() {
    this.publish({ phase: 'loading' });
    const id = encodeURIComponent(this.agentId);
    const [access, notes, handoffs, skills] = await Promise.all([
      this.read<EffectiveAccess>(`/api/memory/access/effective/${id}`),
      this.read<ExplorerPage>('/api/memory/scopes/memories' + queryString({ scope: `agent:${this.agentId}`, limit: 6 })),
      this.read<{ handoffs: Handoff[] }>('/api/handoffs' + queryString({ agentId: this.agentId, limit: 10 })),
      this.read<{ selected: string[] }>(`${SKILLS_PATH}/agents/${id}`),
    ]);
    if (this.disposed) return;
    this.publish({ phase: 'ready', access, notes, handoffs: handoffs?.handoffs ?? null, skills: skills?.selected ?? null });
  }
}

/** "Done: 3 drafts. Left: Ahmed's OK." */
export function handoffLine(h: Handoff): string {
  return [h.done.length && `Done: ${h.done.join('; ')}.`, h.left.length && `Left: ${h.left.join('; ')}.`, h.next.length && `Next: ${h.next.join('; ')}.`].filter(Boolean).join(' ');
}
