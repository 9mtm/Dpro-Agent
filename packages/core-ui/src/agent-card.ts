// AGENT-CARD-01: one agent's card. Profile (role, department, description),
// versioned persona (preset or traits, dialect, lock, history, roll back),
// permissions (tools, memory drawers it reads/writes, off/ask/allow) and the
// memories it can read. Owner only; every save carries the version it read.
import type { SessionClient } from './session';
import type { PublicAgent } from './agents';
import type { MemoryItem, PersonaCurrent, Persona, Traits, TraitName } from './agent-card-contract.js';
import { permissionCategories, permissionModes, riskyCategories } from './hire-contract.js';

export type CardTab = 'profile' | 'persona' | 'permissions' | 'memory' | 'skills' | 'mcp';
export type Grants = { version: number; granted: readonly string[]; available: readonly { name: string; description: string; requiresApproval: boolean; allowedByServer: boolean; execClass: boolean }[] };
export type Permissions = { memoryRead: string[]; memoryWrite: string[]; sharedMemory: boolean; modes: Record<string, string>; version: number };
export type ProfileDraft = { role: string; department: string; description: string; model: string };
export type ModelOption = { id: string; provider: 'ollama' | 'claude' | 'lmstudio'; label: string; size: string };
export type CardState = Readonly<{
  agentId: string; tab: CardTab; phase: 'loading' | 'ready' | 'saving' | 'error';
  agent?: PublicAgent; profile: ProfileDraft; models?: readonly ModelOption[];
  persona?: PersonaCurrent; personaDraft?: { traits: Traits; preset: string | null; dialect: string }; versions?: readonly Persona[];
  grants?: Grants; grantDraft?: readonly string[]; permissions?: Permissions; permissionDraft?: Permissions;
  memories?: readonly MemoryItem[];
  notice?: string; saved?: string;
}>;

const record = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const profileOf = (a?: PublicAgent): ProfileDraft => ({ role: a?.role ?? '', department: a?.department ?? '', description: a?.description ?? '', model: a?.model ?? '' });
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x));

/** Tool groups on the card, in display order. */
export const TOOL_GROUPS = ['Memory', 'Board', 'Files', 'Internet and browser', 'Messages and reminders', 'System', 'Connectors', 'Other'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];
/** Which group a tool belongs to, by its name. */
export function toolGroup(name: string): ToolGroup {
  if (/^mcp:/.test(name)) return 'Connectors';
  if (/^memory_/.test(name)) return 'Memory';
  if (/^board_/.test(name)) return 'Board';
  if (/^(read|write|storage_)/.test(name)) return 'Files';
  if (/^(web_|browser_)/.test(name)) return 'Internet and browser';
  if (/^(create_reminder|telegram_|whatsapp_|email_|send_|notify)/.test(name)) return 'Messages and reminders';
  if (/^(exec|execute_code|desktop_|skill_install|credentials_|sandbox)/.test(name)) return 'System';
  return 'Other';
}

/** True when this memory's drawer is one the agent may read. */
export function readable(m: MemoryItem, perms?: Pick<Permissions, 'memoryRead'>): boolean {
  return !!perms && perms.memoryRead.includes(m.drawer.kind);
}

export class AgentCardController {
  #state: CardState;
  #listeners = new Set<() => void>();
  #disposed = false;
  constructor(readonly client: SessionClient, agentId: string, tab: CardTab = 'profile') {
    this.#state = Object.freeze({ agentId, tab, phase: 'loading', profile: profileOf() });
  }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(p: Partial<CardState>) { if (this.#disposed) return; this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); }
  dispose() { this.#disposed = true; this.#listeners.clear(); }
  private get id() { return this.#state.agentId; }
  private async get(path: string) { return this.client.request({ method: 'GET', path } as never); }
  private async send(method: 'POST' | 'PUT', path: string, body?: unknown) { return this.client.request((body === undefined ? { method, path } : { method, path, body }) as never); }

  async load() {
    this.publish({ phase: 'loading', notice: undefined });
    try {
      const [a, p] = await Promise.all([this.get(`/api/agents/${this.id}`), this.get(`/api/agents/${this.id}/personality/current`)]);
      if (a.status !== 200 || !record(a.body)) { this.publish({ phase: 'error', notice: a.status === 404 ? 'This agent no longer exists.' : 'The agent could not be loaded.' }); return; }
      const agent = a.body.agent as PublicAgent;
      const persona = p.status === 200 ? (p.body as PersonaCurrent) : undefined;
      this.publish({ phase: 'ready', agent, profile: profileOf(agent), persona, personaDraft: persona && { traits: { ...persona.traits }, preset: persona.preset, dialect: persona.dialect } });
      void this.loadModels();
      await this.openTab(this.#state.tab);
    } catch { this.publish({ phase: 'error', notice: 'The agent could not be loaded.' }); }
  }

  async openTab(tab: CardTab) {
    this.publish({ tab, saved: undefined, notice: undefined });
    if ((tab === 'permissions' || tab === 'memory' || tab === 'mcp') && !this.#state.permissions) await this.loadPermissions();
    if (tab === 'memory' && !this.#state.memories) await this.loadMemories();
    if (tab === 'persona' && !this.#state.versions) await this.loadVersions();
  }

  private async loadModels() {
    try {
      const r = await this.get('/api/models');
      // An agent's default model is Ollama or Claude; LM Studio models are picked per reply in the chat.
      if (r.status === 200 && record(r.body) && Array.isArray(r.body.models)) this.publish({ models: (r.body.models as ModelOption[]).filter(m => m.provider === 'ollama'||m.provider==='claude') });
    } catch { /* the model stays as it is */ }
  }

  // ---- profile ----
  editProfile(p: Partial<ProfileDraft>) { this.publish({ profile: { ...this.#state.profile, ...p }, saved: undefined }); }
  profileChanged() { const a = profileOf(this.#state.agent), d = this.#state.profile; return a.role !== d.role || a.department !== d.department.trim().toLowerCase() || a.description !== d.description || a.model !== d.model; }
  async saveProfile() {
    const a = this.#state.agent; if (!a || !this.profileChanged()) return;
    const d = this.#state.profile; const before = profileOf(a);
    const dept = d.department.trim().toLowerCase();
    const body: Record<string, unknown> = { expectedVersion: a.version };
    if (d.role !== before.role) body.role = d.role || null;
    if (dept !== before.department) body.department = dept || null;
    if (d.description !== before.description) body.description = d.description;
    if (d.model !== before.model && d.model) {
      const m = this.#state.models?.find(x => x.id === d.model);
      body.model = d.model; body.provider = m?.provider ?? (/^claude-/.test(d.model) ? 'claude' : 'ollama');
    }
    this.publish({ phase: 'saving' });
    try {
      const r = await this.send('PUT', `/api/agents/${this.id}`, body);
      if (r.status === 200 && record(r.body)) { const agent = r.body.agent as PublicAgent; this.publish({ phase: 'ready', agent, profile: profileOf(agent), saved: 'Profile saved.' }); return; }
      if (r.status === 409 && record(r.body) && r.body.code === 'version_conflict') {
        const agent = r.body.agent as PublicAgent;
        this.publish({ phase: 'ready', agent, notice: 'Someone changed this agent meanwhile. The latest values are shown; your draft is kept — save again to apply it.' });
        return;
      }
      this.publish({ phase: 'ready', notice: r.status === 400 ? 'The department must be lowercase letters, numbers, spaces, _ or - (up to 64).' : 'The profile was not saved.' });
    } catch { this.publish({ phase: 'ready', notice: 'The profile was not saved (no connection).' }); }
  }

  // ---- persona ----
  private async loadVersions() {
    try { const r = await this.get(`/api/agents/${this.id}/personality/versions`); if (r.status === 200 && record(r.body)) this.publish({ versions: r.body.versions as Persona[] }); } catch { /* history stays hidden */ }
  }
  applyPreset(id: string) {
    const p = this.#state.persona?.presets.find(x => x.id === id); const d = this.#state.personaDraft;
    if (p && d) this.publish({ personaDraft: { ...d, traits: { ...p.traits }, preset: p.id }, saved: undefined });
  }
  setTrait(name: TraitName, value: number) {
    const d = this.#state.personaDraft; if (!d) return;
    this.publish({ personaDraft: { ...d, traits: { ...d.traits, [name]: Math.max(0, Math.min(100, Math.round(value))) }, preset: null }, saved: undefined });
  }
  setDialect(dialect: string) { const d = this.#state.personaDraft; if (d) this.publish({ personaDraft: { ...d, dialect }, saved: undefined }); }
  personaChanged() {
    const c = this.#state.persona, d = this.#state.personaDraft;
    return !!c && !!d && (c.dialect !== d.dialect || c.preset !== d.preset || Object.keys(c.traits).some(k => c.traits[k as TraitName] !== d.traits[k as TraitName]));
  }
  async savePersona(note?: string) {
    const c = this.#state.persona, d = this.#state.personaDraft;
    if (!c || !d || !this.personaChanged() || c.locked) return;
    const body: Record<string, unknown> = d.preset && d.preset !== c.preset && Object.keys(d.traits).every(k => d.traits[k as TraitName] === c.presets.find(p => p.id === d.preset)?.traits[k as TraitName])
      ? { preset: d.preset } : { traits: d.traits };
    if (d.dialect !== c.dialect) body.dialect = d.dialect;
    if (note?.trim()) body.note = note.trim().slice(0, 500);
    await this.personaChange('POST', 'versions', body, 'Persona saved as a new version.');
  }
  lock(locked: boolean) { return this.personaChange('POST', locked ? 'lock' : 'unlock', undefined, locked ? 'Persona locked: no changes until you unlock it.' : 'Persona unlocked.'); }
  rollback(version: number) { return this.personaChange('POST', 'rollback', { version }, `Restored version ${version} as a new version.`); }
  private async personaChange(method: 'POST', action: string, body: unknown, ok: string) {
    this.publish({ phase: 'saving' });
    try {
      const r = await this.send(method, `/api/agents/${this.id}/personality/${action}`, body);
      if (r.status === 200 || r.status === 201) {
        const cur = await this.get(`/api/agents/${this.id}/personality/current`);
        const persona = cur.status === 200 ? (cur.body as PersonaCurrent) : this.#state.persona;
        this.publish({ phase: 'ready', persona, personaDraft: persona && { traits: { ...persona.traits }, preset: persona.preset, dialect: persona.dialect }, versions: undefined, saved: ok });
        await this.loadVersions();
        return;
      }
      const code = record(r.body) ? r.body.code : undefined;
      this.publish({ phase: 'ready', notice: code === 'personality_locked' ? 'The persona is locked. Unlock it first.' : code === 'no_change' ? 'Nothing changed.' : 'The persona was not changed.' });
    } catch { this.publish({ phase: 'ready', notice: 'The persona was not changed (no connection).' }); }
  }

  // ---- permissions ----
  private async loadPermissions() {
    try {
      const [p, g] = await Promise.all([this.get(`/api/agents/${this.id}/permissions`), this.get(`/api/agents/${this.id}/tool-grants`)]);
      const permissions = p.status === 200 && record(p.body) ? p.body as Permissions : undefined;
      const grants = g.status === 200 && record(g.body) ? { version: g.body.version as number, granted: (g.body.grants as { tool: string }[]).map(x => x.tool), available: (g.body.available ?? []) as Grants['available'] } : undefined;
      this.publish({ permissions, permissionDraft: permissions && structuredClone(permissions), grants, grantDraft: grants?.granted });
    } catch { this.publish({ notice: 'Permissions could not be loaded.' }); }
  }
  /** Turns a whole group on or off (tools the server keeps off are never turned on). */
  setTools(names: readonly string[], on: boolean) {
    const g = this.#state.grants; const d = this.#state.grantDraft ?? [];
    const allowed = new Set((g?.available ?? []).filter(t => t.allowedByServer).map(t => t.name));
    const next = on ? [...new Set([...d, ...names.filter(n => allowed.has(n))])] : d.filter(n => !names.includes(n));
    this.publish({ grantDraft: next, saved: undefined });
  }
  toggleTool(name: string) { const d = this.#state.grantDraft ?? []; this.publish({ grantDraft: d.includes(name) ? d.filter(x => x !== name) : [...d, name], saved: undefined }); }
  toggleDrawer(kind: string, access: 'read' | 'write') {
    const d = this.#state.permissionDraft; if (!d) return;
    let read = [...d.memoryRead], write = [...d.memoryWrite];
    if (access === 'read') { if (read.includes(kind)) { read = read.filter(k => k !== kind); write = write.filter(k => k !== kind); } else read.push(kind); }
    else if (write.includes(kind)) write = write.filter(k => k !== kind); else { write.push(kind); if (!read.includes(kind)) read.push(kind); }
    this.publish({ permissionDraft: { ...d, memoryRead: read, memoryWrite: write }, saved: undefined });
  }
  setMode(category: string, mode: string) { const d = this.#state.permissionDraft; if (d && (permissionModes as readonly string[]).includes(mode)) this.publish({ permissionDraft: { ...d, modes: { ...d.modes, [category]: mode } }, saved: undefined }); }
  setShared(shared: boolean) { const d = this.#state.permissionDraft; if (d) this.publish({ permissionDraft: { ...d, sharedMemory: shared }, saved: undefined }); }
  permissionsChanged() {
    const p = this.#state.permissions, d = this.#state.permissionDraft, g = this.#state.grants, gd = this.#state.grantDraft;
    const perms = !!p && !!d && (!same(p.memoryRead, d.memoryRead) || !same(p.memoryWrite, d.memoryWrite) || p.sharedMemory !== d.sharedMemory || permissionCategories.some(c => p.modes[c] !== d.modes[c]));
    return perms || (!!g && !!gd && !same(g.granted, gd));
  }
  /** Risky categories set to "allow" need an explicit confirmation. */
  riskyAllowed() { const d = this.#state.permissionDraft; return !!d && riskyCategories.some(c => d.modes[c] === 'allow'); }
  async savePermissions(confirmRisky = false) {
    const p = this.#state.permissions, d = this.#state.permissionDraft, g = this.#state.grants, gd = this.#state.grantDraft;
    if (!this.permissionsChanged()) return;
    this.publish({ phase: 'saving' });
    try {
      if (p && d && (!same(p.memoryRead, d.memoryRead) || !same(p.memoryWrite, d.memoryWrite) || p.sharedMemory !== d.sharedMemory || permissionCategories.some(c => p.modes[c] !== d.modes[c]))) {
        const r = await this.send('PUT', `/api/agents/${this.id}/permissions`, { memoryRead: d.memoryRead, memoryWrite: d.memoryWrite, sharedMemory: d.sharedMemory, modes: d.modes, expectedVersion: p.version, ...(confirmRisky ? { confirmRisky: true } : {}) });
        if (r.status !== 200) { this.publish({ phase: 'ready', notice: r.status === 409 ? 'Permissions changed elsewhere. Reload the card and try again.' : 'Permissions were not saved.' }); return; }
      }
      if (g && gd && !same(g.granted, gd)) {
        const r = await this.send('PUT', `/api/agents/${this.id}/tool-grants`, { grants: [...gd], expectedVersion: g.version, keepScopes: true });
        if (r.status !== 200) { this.publish({ phase: 'ready', notice: r.status === 409 ? 'Tools changed elsewhere. Reload the card and try again.' : 'Tools were not saved.' }); return; }
      }
      this.publish({ permissions: undefined, grants: undefined });
      await this.loadPermissions();
      this.publish({ phase: 'ready', saved: 'Permissions saved.', memories: undefined });
      if (this.#state.tab === 'memory') await this.loadMemories();
    } catch { this.publish({ phase: 'ready', notice: 'Permissions were not saved (no connection).' }); }
  }

  // ---- memory ----
  private async loadMemories() {
    try {
      const r = await this.get('/api/memory');
      if (r.status === 200 && record(r.body)) this.publish({ memories: r.body.memories as MemoryItem[] });
      else this.publish({ memories: [], notice: 'Memories could not be loaded.' });
    } catch { this.publish({ memories: [], notice: 'Memories could not be loaded.' }); }
  }
}
