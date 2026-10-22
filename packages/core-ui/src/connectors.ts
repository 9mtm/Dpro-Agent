import type { SessionClient } from './session';
import { CONNECTORS_PATH } from './connectors-contract.js';
import type { Connector, LaunchApproval } from './connectors-contract.js';

export type ConnectorDraft = { name: string; description: string; kind: 'program' | 'web'; command: string; args: string; url: string; allowRemote: boolean; secrets: string };
export const EMPTY_DRAFT: ConnectorDraft = { name: '', description: '', kind: 'web', command: '', args: '', url: '', allowRemote: false, secrets: '' };
export type ConnectorsState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error';
  servers: readonly Connector[];
  busy: string | null;
  notice?: string;
  /** A local program waiting for the owner to approve exactly what it starts. */
  approval?: { id: string; name: string; launch: LaunchApproval; hash: string };
}>;

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const MESSAGES: Record<string, string> = {
  exec_tools_disabled: 'Local program connectors are turned off on this server (setting AGENT_EXEC_TOOLS=true). Web connectors work without it.',
  name_taken: 'A connector with this name already exists.',
  disabled: 'Turn the connector on first.',
  not_found: 'This connector no longer exists.',
  conflict: 'This connection changed elsewhere. Reload it before saving.',
};

/** NAME=value lines → a map (values are secrets: sent once, never shown again). */
export function parseSecrets(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const i = line.indexOf('=');
    const k = i > 0 ? line.slice(0, i).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(k)) return `"${line.slice(0, 30)}" is not NAME=value.`;
    out[k] = line.slice(i + 1).trim();
  }
  return out;
}
/** A command line split into arguments, keeping "quoted parts" together. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]).slice(0, 50);
}

/** Connectors (MCP servers): add, turn on (a local program needs one approval of what it starts), discover tools, turn off, remove. Owner only. */
export class ConnectorsController {
  #state: ConnectorsState = Object.freeze({ phase: 'idle', servers: [], busy: null });
  #listeners = new Set<() => void>();
  constructor(private readonly client: SessionClient) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(p: Partial<ConnectorsState>) { this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); }
  private req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) { return this.client.request((body === undefined ? { method, path } : { method, path, body }) as never); }
  private fail(r: { status: number; body: unknown }, fallback: string) {
    const code = record(r.body) ? String(r.body.code ?? '') : '';
    return MESSAGES[code] ?? (code.startsWith('mcp_') ? 'The connector could not be reached. Check that it runs and the address or command is right.' : r.status === 400 && record(r.body) && r.body.error ? `Check the details: ${String(r.body.error)}` : fallback);
  }
  private put(s: Connector) { this.publish({ servers: this.#state.servers.some(x => x.id === s.id) ? this.#state.servers.map(x => (x.id === s.id ? s : x)) : [...this.#state.servers, s] }); }

  async load() {
    this.publish({ phase: 'loading', notice: undefined });
    try {
      const r = await this.req('GET', CONNECTORS_PATH);
      if (r.status === 200 && record(r.body) && Array.isArray(r.body.servers)) this.publish({ phase: 'ready', servers: r.body.servers as Connector[] });
      else this.publish({ phase: 'error', notice: 'Connectors could not be loaded.' });
    } catch { this.publish({ phase: 'error', notice: 'Connectors could not be loaded (no connection).' }); }
  }

  /** Read session state without starting a connection or overriding a concurrent local action. */
  async refreshStatus(){
    const before=this.#state;if(before.phase!=='ready'||before.busy)return;
    try{const r=await this.req('GET',CONNECTORS_PATH);if(this.#state===before&&r.status===200&&record(r.body)&&Array.isArray(r.body.servers))this.publish({servers:r.body.servers as Connector[]});}catch{ /* Preserve the current view on a background read failure. */ }
  }

  /** Adds a connector (it starts off). Returns an error message or null. */
  async add(d: ConnectorDraft): Promise<string | null> {
    const name = d.name.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(name)) return 'Name: 1-24 lowercase letters, digits or "-".';
    const secrets = parseSecrets(d.secrets); if (typeof secrets === 'string') return secrets;
    const body: Record<string, unknown> = { name, ...(d.description.trim() ? { description: d.description.trim().slice(0, 500) } : {}) };
    if (d.kind === 'program') {
      const parts = splitArgs(d.command.trim());
      if (!parts.length) return 'Enter the command that starts the connector, e.g. npx -y @scope/server.';
      Object.assign(body, { transport: 'stdio', command: parts[0], args: [...parts.slice(1), ...splitArgs(d.args)], ...(Object.keys(secrets).length ? { env: secrets } : {}) });
    } else {
      if (!d.url.trim()) return 'Enter the connector address.';
      Object.assign(body, { transport: 'http', url: d.url.trim(), allowRemote: d.allowRemote, ...(Object.keys(secrets).length ? { headers: secrets } : {}) });
    }
    return this.create(body);
  }

  /** Exact structured input; adding never enables a connection. */
  async create(body:Record<string,unknown>):Promise<string|null>{
    this.publish({busy:'add',notice:undefined});
    try{const r=await this.req('POST',CONNECTORS_PATH,body);if((r.status===200||r.status===201)&&record(r.body)&&record(r.body.server)){this.put(r.body.server as unknown as Connector);this.publish({notice:'Connection added disabled. Review it before turning it on.'});return null;}return this.fail(r,'The connection was not added.');}catch{return 'The connection was not added (no connection).';}finally{this.publish({busy:null});}
  }

  async update(id:string,body:Record<string,unknown>):Promise<string|null>{
    this.publish({busy:id,notice:undefined});
    try{const r=await this.req('PUT',`${CONNECTORS_PATH}/${id}`,body);if(r.status===200&&record(r.body)&&record(r.body.server)){this.put(r.body.server as unknown as Connector);this.publish({notice:r.body.disabledByChange?'Connection saved and turned off. Discover its tools and review agent access again.':'Connection saved. No tools were granted.'});return null;}return this.fail(r,'The connection was not saved.');}catch{return 'The connection was not saved (no connection).';}finally{this.publish({busy:null});}
  }

  /** Turns a connector on, then discovers its tools. A local program first asks for approval of exactly what it starts. */
  async enable(id: string, launchHash?: string) {
    this.publish({ busy: id, notice: undefined, approval: undefined });
    try {
      const r = await this.req('POST', `${CONNECTORS_PATH}/${id}/enable`, launchHash ? { launchHash } : undefined);
      if (r.status === 409 && record(r.body) && r.body.code === 'launch_approval_required' && record(r.body.launch) && typeof r.body.launchHash === 'string') {
        this.publish({ approval: { id, name: this.#state.servers.find(s => s.id === id)?.name ?? '', launch: r.body.launch as unknown as LaunchApproval, hash: r.body.launchHash } });
        return;
      }
      if (r.status !== 200 || !record(r.body) || !record(r.body.server)) { this.publish({ notice: this.fail(r, 'The connector could not be turned on.') }); return; }
      this.put(r.body.server as unknown as Connector);
      await this.refresh(id);
    } catch { this.publish({ notice: 'The connector could not be turned on (no connection).' }); } finally { this.publish({ busy: null }); }
  }
  approve() { const a = this.#state.approval; return a ? this.enable(a.id, a.hash) : Promise.resolve(); }
  cancelApproval() { this.publish({ approval: undefined }); }

  async refresh(id: string) {
    this.publish({ busy: id });
    try {
      const r = await this.req('POST', `${CONNECTORS_PATH}/${id}/refresh`);
      if (r.status === 200 && record(r.body) && record(r.body.server)) { this.put(r.body.server as unknown as Connector); this.publish({ notice: `Found ${typeof r.body.discovered === 'number' ? r.body.discovered : (r.body.server as unknown as Connector).tools.length} tools. Give them to agents on each agent's tools.` }); }
      else {this.publish({ notice: this.fail(r, 'The tools could not be read.') });await this.syncOne(id);}
    } catch { this.publish({ notice: 'The tools could not be read (no connection).' }); } finally { this.publish({ busy: null }); }
  }
  /** Close and reopen the connection; never changes grants or bypasses launch approval. */
  async reconnect(id:string){
    this.publish({busy:id,notice:undefined});
    try{const r=await this.req('POST',`${CONNECTORS_PATH}/${id}/reconnect`);if(r.status===200&&record(r.body)&&record(r.body.server)){this.put(r.body.server as unknown as Connector);this.publish({notice:'Reconnected and updated discovered tools. Existing agent policies still apply.'});}else{this.publish({notice:this.fail(r,'The connection could not be reconnected.')});await this.syncOne(id);}}catch{this.publish({notice:'The connection could not be reconnected (no connection).'});}finally{this.publish({busy:null});}
  }
  private async syncOne(id:string){try{const r=await this.req('GET',`${CONNECTORS_PATH}/${id}`);if(r.status===200&&record(r.body)&&record(r.body.server))this.put(r.body.server as unknown as Connector);}catch{ /* Keep the failed-action notice. */ }}
  async disable(id: string) {
    this.publish({ busy: id, notice: undefined });
    try {
      const r = await this.req('POST', `${CONNECTORS_PATH}/${id}/disable`);
      if (r.status === 200 && record(r.body) && record(r.body.server)) this.put(r.body.server as unknown as Connector); else this.publish({ notice: this.fail(r, 'The connector could not be turned off.') });
    } catch { this.publish({ notice: 'The connector could not be turned off (no connection).' }); } finally { this.publish({ busy: null }); }
  }
  async remove(id: string) {
    this.publish({ busy: id, notice: undefined });
    try {
      const r = await this.req('DELETE', `${CONNECTORS_PATH}/${id}`);
      if (r.status === 200) this.publish({ servers: this.#state.servers.filter(s => s.id !== id) }); else this.publish({ notice: this.fail(r, 'The connector was not removed.') });
    } catch { this.publish({ notice: 'The connector was not removed (no connection).' }); } finally { this.publish({ busy: null }); }
  }
  /** Whether a tool asks the owner before it runs (null = the connector's own hint). */
  async setApproval(id: string, tool: string, requiresApproval: boolean | null) {
    this.publish({ busy: id });
    try {
      const r = await this.req('PUT', `${CONNECTORS_PATH}/${id}/tools/${encodeURIComponent(tool)}`, { requiresApproval });
      if (r.status === 200 && record(r.body) && record(r.body.server)) this.put(r.body.server as unknown as Connector); else if(r.status===200&&record(r.body)&&record(r.body.tool)){const updated=r.body.tool;const server=this.#state.servers.find(s=>s.id===id);if(server)this.put({...server,tools:server.tools.map(t=>t.name===tool?{...t,...updated}:t)});}else this.publish({ notice: this.fail(r, 'The setting was not saved.') });
    } catch { this.publish({ notice: 'The setting was not saved (no connection).' }); } finally { this.publish({ busy: null }); }
  }
}
