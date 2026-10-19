import type { WireRequest, WireResponse } from './session';
import { cardPath, traitNames } from './agent-card-contract.js';
import type { Traits } from './agent-card-contract.js';

const PRESETS: { id: string; label: string; traits: Traits }[] = [
  { id: 'balanced-assistant', label: 'Balanced assistant', traits: { doubt: 50, caution: 55, creativity: 50, thoroughness: 60, independence: 50, verbosity: 45, warmth: 65, curiosity: 50, persistence: 60 } },
  { id: 'careful-auditor', label: 'Careful auditor', traits: { doubt: 85, caution: 85, creativity: 25, thoroughness: 90, independence: 30, verbosity: 55, warmth: 40, curiosity: 45, persistence: 70 } },
  { id: 'bold-creative', label: 'Bold creative', traits: { doubt: 35, caution: 35, creativity: 90, thoroughness: 45, independence: 70, verbosity: 60, warmth: 70, curiosity: 85, persistence: 55 } },
];
type Version = { version: number; traits: Traits; preset: string | null; dialect: string; locked: boolean; note: string | null; source: string; createdAt: string };
type Mem = { id: string; type: string; content: string; importance: number; drawer: { kind: string; key?: string }; memoryLayer: string; createdAt: string; tags: string[]; history: { version: number; change: string; type: string; content: string; createdAt: string; reason: string }[] };

/** Fictional personas and memory items for offline practice and tests. Never a live fallback. */
export function createCardMock() {
  const personas = new Map<string, Version[]>();
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const now = () => '2026-10-15T12:00:00.000Z';
  const mem = new Map<string, Mem>();
  const seed = (type: string, content: string, importance: number, drawer: Mem['drawer']) => {
    const m: Mem = { id: uuid(), type, content, importance, drawer, memoryLayer: importance >= 8 ? 'factual' : 'experiential', createdAt: now(), tags: [], history: [] };
    m.history.push({ version: 1, change: 'create', type, content, createdAt: now(), reason: 'api' });
    mem.set(m.id, m);
  };
  seed('preference', 'Fictional: the owner likes short daily updates.', 8, { kind: 'owner' });
  seed('insight', 'Fictional: drafts with one clear number get approved faster.', 6, { kind: 'experience' });
  seed('context', 'Fictional: launch week starts on Monday.', 7, { kind: 'project', key: 'launch' });
  const versions = (agent: string) => {
    if (!personas.has(agent)) personas.set(agent, [{ version: 1, traits: { ...PRESETS[0].traits }, preset: 'balanced-assistant', dialect: 'en', locked: false, note: null, source: 'seed', createdAt: now() }]);
    return personas.get(agent)!;
  };
  const view = (m: Mem) => { const { history: _h, ...rest } = m; return { ...rest, embedding: [0, 1], userId: 'secret-owner' }; };
  return function transport(request: WireRequest): WireResponse {
    const p = cardPath(request.path);
    const body = request.body as Record<string, any> | undefined;
    if (!p) return { status: 404, body: null };
    if (p.kind.startsWith('persona-')) {
      const list = versions(p.agent!);
      const current = list[list.length - 1];
      const push = (v: Partial<Version>) => { const next = { ...current, ...v, version: current.version + 1, createdAt: now(), source: 'owner' }; list.push(next); return { status: 200, body: next }; };
      switch (p.kind) {
        case 'persona-current': return { status: 200, body: { ...current, traitNames: [...traitNames], dialects: ['en', 'ar', 'ar-IQ', 'de'], presets: PRESETS } };
        case 'persona-versions':
          if (request.method === 'GET') return { status: 200, body: { versions: [...list].reverse() } };
          if (current.locked) return { status: 409, body: { code: 'personality_locked' } };
          return push({ ...(body!.preset ? { preset: body!.preset, traits: { ...PRESETS.find(x => x.id === body!.preset)!.traits } } : {}), ...(body!.traits ? { traits: body!.traits, preset: null } : {}), ...(body!.dialect ? { dialect: body!.dialect } : {}), note: body!.note ?? null });
        case 'persona-lock': return push({ locked: true });
        case 'persona-unlock': return push({ locked: false });
        case 'persona-rollback': { const old = list.find(v => v.version === body!.version); return old ? push({ traits: old.traits, preset: old.preset, dialect: old.dialect }) : { status: 404, body: null }; }
      }
    }
    if (p.kind === 'models') return { status: 200, body: { models: [
      { id: 'qwen-fiction:7b', name: '🏠 qwen-fiction:7b', provider: 'local', size: '4.1GB', available: true },
      { id: 'llama-fiction:3b', name: '🏠 llama-fiction:3b', provider: 'local', size: '2.0GB', available: true },
      { id: 'lmstudio:fiction/mistral-7b', name: 'fiction/mistral-7b', provider: 'lmstudio', size: '', available: true },
    ], activeProvider: 'local' } };
    if (p.kind === 'memory-page') return { status: 200, body: { memories: [...mem.values()].map(view), total: mem.size, nextCursor: null } };
    if (p.kind === 'memories') {
      if (request.method === 'GET') return { status: 200, body: { success: true, memories: [...mem.values()].map(view) } };
      const m: Mem = { id: uuid(), type: body!.type, content: body!.content, importance: body!.importance ?? 5, drawer: body!.drawer ?? { kind: 'owner' }, memoryLayer: 'working', createdAt: now(), tags: [], history: [] };
      m.history.push({ version: 1, change: 'create', type: m.type, content: m.content, createdAt: now(), reason: 'api' });
      mem.set(m.id, m);
      return { status: 200, body: { success: true, memory: view(m) } };
    }
    if (p.kind === 'drawers') {
      const counts = new Map<string, { kind: string; key?: string; count: number }>();
      for (const m of mem.values()) { const k = `${m.drawer.kind}:${m.drawer.key ?? ''}`; const c = counts.get(k) ?? { ...m.drawer, count: 0 }; c.count++; counts.set(k, c); }
      return { status: 200, body: { success: true, drawers: [...counts.values()] } };
    }
    if (p.kind === 'search') {
      const q = String(body!.query).toLowerCase();
      return { status: 200, body: { success: true, results: [...mem.values()].filter(m => m.content.toLowerCase().includes(q)).map(m => ({ memory: view(m), score: 1 })) } };
    }
    const m = mem.get(p.id!);
    if (!m) return { status: 404, body: { error: 'Memory not found' } };
    if (p.kind === 'memory-versions') return { status: 200, body: { success: true, versions: [...m.history].reverse() } };
    if (p.kind === 'memory-forget' || request.method === 'DELETE') { mem.delete(m.id); return { status: 200, body: { success: true } }; }
    for (const k of ['content', 'importance', 'type'] as const) if (body![k] !== undefined) (m as any)[k] = body![k];
    m.history.push({ version: m.history.length + 1, change: 'update', type: m.type, content: m.content, createdAt: now(), reason: 'api' });
    return { status: 200, body: { success: true, memory: view(m) } };
  };
}
