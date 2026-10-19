import { SessionFailure } from './session-failure';
import { validSpecialties, department as validDepartment, displayName, validCreateBody, BATCHES_PATH, CATALOGUE_PATH, DISTRIBUTION_PATH, MAX_TOTAL, PLAN_PATH } from './hire-contract.js';
import type { CreateBody, Preset, Role } from './hire';
import type { SessionClient } from './session';
import { rolesFor } from './team-split';
import type { TeamRole } from './team-split';

export type CompanySize = 'solo' | 'small' | 'medium' | 'large';
export type PlanBody = { size: CompanySize; departments: string[]; language?: string };
export type CatalogueDepartment = Readonly<{ id: string; label: string; summary: string }>;
export type Specialty = Readonly<{name:string;count:number;description:string}>;
export type SpecialtyChoice = Readonly<{department:string;name:string;description:string}>;
export type Catalogue = Readonly<{ sizes: readonly Readonly<{ id: CompanySize; label: string }>[]; departments: readonly CatalogueDepartment[]; maxTotal?: number; specialties?: readonly SpecialtyChoice[] }>;
/** ONBOARD-TEAM-02: one department of a total headcount, as the owner edits it. */
export type Share = Readonly<{ specialties?: readonly Specialty[]; department: string; departmentLabel: string; count: number; presets: Readonly<Record<TeamRole, Preset>>; titles: Readonly<Record<TeamRole, string>> }>;
export type BatchProgress = Readonly<{ id: string; total: number; created: number; failed: number; pending: number; done: boolean; departments: readonly Readonly<{ department: string; total: number; created: number; failed: number }>[] }>;
type BatchBody = { id: string; departments: { department: string; count: number; presets: Record<TeamRole, Preset>; specialties?: Specialty[] }[] };
export type HireStatus = 'planned' | 'creating' | 'created' | 'failed' | 'unknown';
export type PlannedHire = Readonly<{
  key: string; department: string; departmentLabel: string; role: Role; title: string; description: string; preset: Preset;
  name: string; include: boolean; status: HireStatus; note?: string;
}>;
export type CompanyStep = 'size' | 'departments' | 'review' | 'hiring' | 'done';
export type CompanyState = Readonly<{
  step: CompanyStep; owner: boolean;
  phase: 'idle' | 'loading' | 'ready' | 'planning' | 'hiring' | 'done' | 'error' | 'stopped' | 'denied';
  catalogue?: Catalogue; size?: CompanySize; departments: readonly string[]; hires: readonly PlannedHire[]; notice?: string;
  /** Total headcount mode (instead of a size): the split the owner reviews, the running batch, unfinished batches found on Start. */
  total?: number; shares: readonly Share[]; batch?: BatchProgress; open: readonly BatchProgress[];
}>;

export const MAX_DEPARTMENTS = 12;
export const MAX_CUSTOM = 4;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const normalizeDepartment = (x: string) => x.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The create body for one reviewed hire (role + persona preset), or null when invalid. */
export function hireBody(h: PlannedHire): CreateBody | null {
  const name = h.name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const body: CreateBody = { ...(name ? { name } : {}), role: h.role, department: h.department, description: h.description, personality: { preset: h.preset } };
  return validCreateBody(body) ? body : null;
}

/** Total of a split as the owner edited it. */
export const sharesTotal = (shares: readonly Share[]) => shares.reduce((a, x) => a + x.count, 0);
/** Role split of a share (the server applies the same rule). */
export const shareSpecialties=(share:Share):readonly Specialty[]=>share.specialties??[{name:share.titles.specialist,count:share.count,description:`${share.titles.specialist} in ${share.departmentLabel}.`}];
export const shareRoles = (x: Share) => rolesFor(x.count);

/** A fresh batch id (letters, digits and -). */
function newBatchId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16); c.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class CompanyController {
  #state: CompanyState = Object.freeze({ step: 'size', owner: false, phase: 'denied', departments: [], hires: [], shares: [], open: [] });
  #batchBody?: BatchBody; #batchStored = false;
  #listeners = new Set<() => void>();
  #disposed = false; #ticket = 0; #abort?: AbortController; #identity = ''; #unsubscribe: () => void;
  constructor(readonly client: SessionClient) { this.#unsubscribe = client.subscribe(this.#sync); this.#sync(); }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  #publish(patch: Partial<CompanyState>) { this.#state = Object.freeze({ ...this.#state, ...patch }); this.#listeners.forEach(fn => fn()); }
  #sync = () => {
    const s = this.client.getSnapshot(); const identity = `${s.mode}:${s.epoch}:${s.phase}:${s.user?.id ?? ''}:${s.user?.role ?? ''}`;
    if (identity === this.#identity) return;
    this.#identity = identity; this.#invalidate();
    const owner = s.phase === 'authenticated' && s.user?.role === 'owner';
    this.#batchBody = undefined; this.#batchStored = false;
    this.#publish({ step: 'size', owner, phase: owner ? 'idle' : 'denied', catalogue: undefined, size: undefined, departments: [], hires: [], total: undefined, shares: [], batch: undefined, open: [], notice: s.phase === 'authenticated' && !owner ? 'Only the owner can build the company.' : undefined });
  };
  #invalidate() { this.#ticket++; this.#abort?.abort(); }
  #begin(phase: CompanyState['phase']) { this.#invalidate(); this.#abort = new AbortController(); this.#publish({ phase, notice: undefined }); return this.#ticket; }
  #busy() { return ['loading', 'planning', 'hiring'].includes(this.#state.phase); }
  #refused(status: number, body: unknown): boolean {
    if (status === 403 && record(body) && body.code === 'read_only_stage') { this.#publish({ phase: 'error', notice: 'This test server does not accept this yet. Nothing was saved.' }); return true; }
    if (status === 401 || status === 403) { this.#invalidate(); this.#publish({ phase: 'denied', notice: 'Access denied. Sign in again as the owner.' }); return true; }
    return false;
  }
  dispose() { this.#disposed = true; this.#invalidate(); this.#unsubscribe(); this.#publish({ owner: false, phase: 'denied', hires: [], shares: [], batch: undefined, open: [] }); }

  restart() {
    if (!this.#state.owner || this.#busy()) return;
    this.#invalidate();
    this.#batchBody = undefined; this.#batchStored = false;
    this.#publish({ step: 'size', phase: this.#state.catalogue ? 'ready' : 'idle', size: undefined, departments: [], hires: [], total: undefined, shares: [], batch: undefined, notice: undefined });
  }

  /** Explicit read of sizes and departments (never on mount). */
  async loadCatalogue() {
    if (!this.#state.owner || this.#busy() || this.#disposed) return;
    const ticket = this.#begin('loading');
    try {
      const r = await this.client.request({ method: 'GET', path: CATALOGUE_PATH }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      if (this.#refused(r.status, r.body)) return;
      const b = r.body as Catalogue | null;
      if (r.status !== 200 || !b || !b.sizes.length) throw Error();
      this.#publish({ catalogue: Object.freeze(b), phase: 'ready' });
    } catch { if (ticket === this.#ticket) this.#publish({ phase: 'error', notice: 'The list of departments could not be read. Try again.' }); return; }
    // Unfinished batch hires (e.g. the page was reloaded mid-run): offered for resuming. Not fatal when unreadable.
    try {
      const r = await this.client.request({ method: 'GET', path: BATCHES_PATH }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      const b = r.body as { batches?: BatchProgress[] } | null;
      if (r.status === 200 && b?.batches) this.#publish({ open: Object.freeze(b.batches.map(x => Object.freeze(x))) });
    } catch { /* the wizard works without it */ }
  }

  chooseSize(size: CompanySize) {
    if (!this.#state.owner || this.#busy() || !this.#state.catalogue?.sizes.some(s => s.id === size)) return;
    this.#publish({ size, total: undefined, step: 'departments', notice: undefined });
  }
  /** Total headcount instead of a size (ONBOARD-TEAM-02). */
  chooseTotal(total: number) {
    const s = this.#state; if (!s.owner || this.#busy() || !s.catalogue) return false;
    const max = s.catalogue.maxTotal ?? MAX_TOTAL;
    if (!Number.isSafeInteger(total) || total < 1 || total > max) { this.#publish({ notice: `Enter a whole number from 1 to ${max}.` }); return false; }
    this.#publish({ total, size: undefined, step: 'departments', notice: undefined });
    return true;
  }
  back() {
    const s = this.#state; if (this.#busy()) return;
    if (s.step === 'departments') this.#publish({ step: 'size', notice: undefined });
    else if (s.step === 'review') this.#publish({ step: 'departments', notice: undefined });
  }
  toggleDepartment(id: string) {
    const s = this.#state; if (!s.owner || this.#busy() || s.step !== 'departments') return;
    const dep = normalizeDepartment(id);
    if (s.departments.includes(dep)) return this.#publish({ departments: Object.freeze(s.departments.filter(d => d !== dep)) });
    if (s.departments.length >= MAX_DEPARTMENTS) return this.#publish({ notice: `At most ${MAX_DEPARTMENTS} departments.` });
    this.#publish({ departments: Object.freeze([...s.departments, dep]), notice: undefined });
  }
  addCustom(name: string) {
    const s = this.#state; if (!s.owner || this.#busy() || s.step !== 'departments') return false;
    const dep = normalizeDepartment(name);
    if (!dep || !validDepartment(dep)) { this.#publish({ notice: 'Department: up to 64 letters, numbers, spaces, - or _.' }); return false; }
    const known = new Set(s.catalogue?.departments.map(d => d.id) ?? []);
    if (s.departments.filter(d => !known.has(d)).length >= MAX_CUSTOM && !known.has(dep) && !s.departments.includes(dep)) { this.#publish({ notice: `At most ${MAX_CUSTOM} custom departments.` }); return false; }
    if (!s.departments.includes(dep)) this.toggleDepartment(dep);
    return true;
  }

  /** Ask the server for a proposed team (reads only; names are not reserved). */
  async propose() {
    const s = this.#state;
    if (s.total !== undefined) return this.distribute();
    if (!s.owner || this.#busy() || !s.size || !s.departments.length) return;
    const ticket = this.#begin('planning');
    try {
      const r = await this.client.request({ method: 'POST', path: PLAN_PATH, body: { size: s.size, departments: [...s.departments] } }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      if (this.#refused(r.status, r.body)) return;
      const b = r.body as { hires?: Omit<PlannedHire, 'key' | 'include' | 'status'>[]; code?: string } | null;
      if (r.status !== 200 || !b?.hires) return this.#publish({ phase: 'error', notice: b?.code === 'invalid_plan' ? 'The server refused these choices. Check the departments.' : 'No team could be proposed. Try again.' });
      const hires = b.hires.map((h, i) => Object.freeze({ ...h, key: `h${i}`, include: true, status: 'planned' as const }));
      this.#publish({ hires: Object.freeze(hires), step: 'review', phase: 'ready' });
    } catch (error) {
      if (ticket !== this.#ticket) return;
      this.#publish({ phase: 'error', notice: error instanceof SessionFailure && error.code === 'blocked' ? 'Nothing was sent. Check the choices.' : 'No team could be proposed. Try again.' });
    }
  }

  edit(key: string, patch: Partial<Pick<PlannedHire, 'name' | 'include' | 'preset' | 'role'>>) {
    const s = this.#state; if (!s.owner || this.#busy() || s.step !== 'review') return;
    this.#publish({ hires: Object.freeze(s.hires.map(h => h.key === key && h.status !== 'created' ? Object.freeze({ ...h, ...patch }) : h)), notice: undefined });
  }

  /**
   * Hire every included proposal, one create at a time. A refused hire is
   * marked and the rest continue; an unknown outcome stops the run and is
   * never retried automatically.
   */
  async hireAll() {
    const s = this.#state;
    if (!s.owner || this.#busy() || s.step !== 'review') return;
    const chosen = s.hires.filter(h => h.include && h.status !== 'created');
    if (!chosen.length) return this.#publish({ notice: 'Choose at least one agent to hire.' });
    const invalid = chosen.find(h => !hireBody(h) || (h.name.trim() && !displayName(h.name.normalize('NFKC').replace(/\s+/g, ' ').trim())));
    if (invalid) return this.#publish({ notice: `Check the name of ${invalid.title}: up to 60 characters, no hidden characters.` });
    const ticket = this.#begin('hiring');
    this.#publish({ step: 'hiring' });
    for (const planned of chosen) {
      if (ticket !== this.#ticket || this.#disposed) return;
      this.#mark(planned.key, { status: 'creating' });
      try {
        const r = await this.client.request({ method: 'POST', path: '/api/agents', body: hireBody(planned)! }, this.#abort!.signal);
        if (ticket !== this.#ticket) return;
        if (r.status === 401 || (r.status === 403 && !(record(r.body) && r.body.code === 'read_only_stage'))) { this.#mark(planned.key, { status: 'failed', note: 'Refused' }); this.#refused(r.status, r.body); return; }
        const b = r.body as { agent?: { name?: string }; code?: string } | null;
        if (r.status === 201 && b?.agent) this.#mark(planned.key, { status: 'created', name: b.agent.name ?? planned.name });
        else this.#mark(planned.key, { status: 'failed', note: b?.code === 'name_taken' ? 'Name already used' : b?.code === 'read_only_stage' ? 'Server is read-only' : 'Refused' });
      } catch {
        if (ticket !== this.#ticket) return;
        this.#mark(planned.key, { status: 'unknown', note: 'Result unknown' });
        return this.#publish({ phase: 'stopped', notice: 'One hire has an unknown result, so the rest were not sent. Open Your team to check, then try the remaining ones.' });
      }
    }
    const failed = this.#state.hires.filter(h => h.include && h.status === 'failed').length;
    this.#publish(failed
      ? { phase: 'stopped', step: 'review', notice: `${failed} hire${failed === 1 ? '' : 's'} could not be created. Fix them and hire again; the others are already on your team.` }
      : { phase: 'done', step: 'done', notice: undefined });
  }

  // ---- Total headcount (ONBOARD-TEAM-02) ----

  /** Ask the server to split the total over the chosen departments (reads nothing). */
  async distribute() {
    const s = this.#state;
    if (!s.owner || this.#busy() || s.total === undefined || !s.departments.length) return;
    if (s.total < s.departments.length) return this.#publish({ notice: `${s.total} ${s.total === 1 ? 'agent is' : 'agents are'} too few for ${s.departments.length} departments; each needs at least one.` });
    const ticket = this.#begin('planning');
    try {
      const r = await this.client.request({ method: 'POST', path: DISTRIBUTION_PATH, body: { departments: [...s.departments], total: s.total } }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      if (this.#refused(r.status, r.body)) return;
      const b = r.body as { departments?: (Share & { roles: unknown })[]; code?: string } | null;
      if (r.status !== 200 || !b?.departments) return this.#publish({ phase: 'error', notice: b?.code === 'invalid_plan' ? 'The server refused these choices. Check the total and the departments.' : 'The team could not be split. Try again.' });
      const shares = b.departments.map(d => Object.freeze({ department: d.department, departmentLabel: d.departmentLabel, count: d.count, presets: Object.freeze({ ...d.presets }), titles: Object.freeze({ ...d.titles }) }));
      this.#publish({ shares: Object.freeze(shares), step: 'review', phase: 'ready' });
    } catch (error) {
      if (ticket !== this.#ticket) return;
      this.#publish({ phase: 'error', notice: error instanceof SessionFailure && error.code === 'blocked' ? 'Nothing was sent. Check the choices.' : 'The team could not be split. Try again.' });
    }
  }

  /** Edit one department of the split: its headcount or the persona for one role. */
  editShare(department: string, patch: { count?: number; role?: TeamRole; preset?: Preset }) {
    const s = this.#state; if (!s.owner || this.#busy() || s.step !== 'review' || !s.shares.length) return;
    const max = s.catalogue?.maxTotal ?? MAX_TOTAL;
    if (patch.count !== undefined && (!Number.isSafeInteger(patch.count) || patch.count < 1 || patch.count > max)) return this.#publish({ notice: `Each department needs 1 to ${max} agents.` });
    this.#publish({ notice: undefined, shares: Object.freeze(s.shares.map(x => x.department !== department ? x : Object.freeze({
      ...x,
      ...(patch.count !== undefined ? { count: patch.count } : {}),
      ...(patch.role && patch.preset ? { presets: Object.freeze({ ...x.presets, [patch.role]: patch.preset }) } : {}),
    }))) });
  }

  editSpecialties(department:string, rows: readonly Specialty[]){
    const s=this.#state;if(!s.owner||this.#busy()||s.step!=='review'||rows.length>50)return;
    this.#publish({notice:undefined,shares:Object.freeze(s.shares.map(x=>x.department===department?Object.freeze({...x,specialties:Object.freeze(rows.map(row=>Object.freeze({...row})))}):x))});
  }

  /** Store the reviewed split as one batch, then create the agents in chunks with progress. */
  async hireBatch() {
    const s = this.#state;
    if (!s.owner || this.#busy() || s.step !== 'review' || !s.shares.length) return;
    const total = s.shares.reduce((a, x) => a + x.count, 0);
    const max = s.catalogue?.maxTotal ?? MAX_TOTAL;
    if (total > max) return this.#publish({ notice: `At most ${max} agents in total; you have ${total}.` });
    if(s.shares.some(x=>!validSpecialties(x.specialties,x.count)))return this.#publish({notice:'Check specialty names and descriptions. Specialty counts must equal each department total.'});
    this.#batchBody = { id: newBatchId(), departments: s.shares.map(x => ({ department: x.department, count: x.count, presets: { ...x.presets }, specialties:shareSpecialties(x).map(row=>({...row})) })) };
    this.#batchStored = false;
    await this.#store();
  }

  /** Go on after a break (lost connection, another window, a reload): never creates anyone twice. */
  async continueBatch() {
    const s = this.#state; if (!s.owner || this.#busy()) return;
    if (this.#batchBody && !this.#batchStored) return this.#store();
    if (s.batch) return this.#run(s.batch.id, false);
  }

  /** Resume an unfinished batch found on Start. */
  async resume(id: string) {
    const s = this.#state; const found = s.open.find(b => b.id === id);
    if (!s.owner || this.#busy() || !found) return;
    this.#batchBody = undefined; this.#batchStored = true;
    this.#publish({ batch: found, step: 'hiring', notice: undefined });
    await this.#run(id, found.pending === 0 && found.failed > 0);
  }

  /** Try the failed agents of the current batch again. */
  async retryFailed() {
    const s = this.#state; if (!s.owner || this.#busy() || !s.batch || !s.batch.failed) return;
    await this.#run(s.batch.id, true);
  }

  async #store() {
    const body = this.#batchBody!;
    const ticket = this.#begin('hiring');
    this.#publish({ step: 'hiring' });
    try {
      const r = await this.client.request({ method: 'POST', path: BATCHES_PATH, body }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      if (this.#refused(r.status, r.body)) return;
      const b = r.body as { batch?: BatchProgress; code?: string } | null;
      if ((r.status === 200 || r.status === 201) && b?.batch) {
        this.#batchStored = true;
        this.#publish({ batch: Object.freeze(b.batch) });
        return this.#loop(ticket, b.batch.id, false);
      }
      this.#publish({ phase: 'error', step: 'review', notice: b?.code === 'invalid_plan' ? 'The server refused this team. Check the counts.' : 'The hire could not start. Nothing was created.' });
    } catch {
      if (ticket !== this.#ticket) return;
      this.#publish({ phase: 'stopped', notice: 'The connection broke before the hire started. Press Continue: the same plan is sent again and nobody is hired twice.' });
    }
  }

  async #run(id: string, retry: boolean) {
    const ticket = this.#begin('hiring');
    this.#publish({ step: 'hiring' });
    await this.#loop(ticket, id, retry);
  }

  async #loop(ticket: number, id: string, retry: boolean) {
    for (let first = true; ; first = false) {
      if (ticket !== this.#ticket || this.#disposed) return;
      let r;
      try {
        r = await this.client.request({ method: 'POST', path: `${BATCHES_PATH}/${id}/run`, body: retry && first ? { max: 25, retryFailed: true } : { max: 25 } }, this.#abort!.signal);
      } catch {
        if (ticket !== this.#ticket) return;
        return this.#publish({ phase: 'stopped', notice: 'The connection broke. Press Continue to go on; nobody is hired twice.' });
      }
      if (ticket !== this.#ticket) return;
      if (this.#refused(r.status, r.body)) return;
      const b = r.body as { batch?: BatchProgress; code?: string } | null;
      if (r.status === 409 && b?.code === 'batch_running') return this.#publish({ phase: 'stopped', notice: 'This hire is running in another window. Press Continue when it has finished there.' });
      if (r.status !== 200 || !b?.batch) return this.#publish({ phase: 'error', notice: b?.code === 'batch_not_found' ? 'This hire was not found.' : 'The hire stopped. Press Continue to try again.' });
      this.#publish({ batch: Object.freeze(b.batch), open: Object.freeze(this.#state.open.filter(x => x.id !== id)) });
      if (b.batch.done) break;
    }
    const done = this.#state.batch!;
    this.#publish(done.failed
      ? { phase: 'stopped', notice: `${done.created} hired; ${done.failed} could not be created. Try them again.` }
      : { phase: 'done', step: 'done', notice: undefined });
  }

  #mark(key: string, patch: Partial<PlannedHire>) {
    this.#publish({ hires: Object.freeze(this.#state.hires.map(h => h.key === key ? Object.freeze({ ...h, ...patch }) : h)) });
  }
}
