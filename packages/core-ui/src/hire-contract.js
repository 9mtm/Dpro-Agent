import {TEAM_RESOURCES_PATH,allowedTeamResources,teamResourcesResponse} from './team-resources-contract.js';
// UI-AGENT-CREATE-01 wire contract: create an agent (role + persona) and set
// its tool permissions. Shared by the browser boundary and the local bridge.
import { validAgentId } from './agent-id.js';
import { traitNames } from './personality-contract.js';

export const roles = ['main', 'manager', 'specialist', 'evaluator'];
export const presets = ['balanced-assistant', 'careful-auditor', 'bold-creative', 'precise-developer', 'strict-evaluator'];
export const dialects = ['ar-IQ', 'ar', 'en', 'de', 'fr', 'es', 'zh', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'hi'];
export const companySizes = ['solo', 'small', 'medium', 'large'];
export const nameLanguages = ['en', 'ar', 'de', 'fr', 'es', 'zh', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'hi'];
export const CATALOGUE_PATH = '/api/onboarding/team-catalogue';
export const PLAN_PATH = '/api/onboarding/team-plan';
// ONBOARD-TEAM-02: total headcount split + batch hire.
export const DISTRIBUTION_PATH = '/api/onboarding/team-distribution';
export const BATCHES_PATH = '/api/onboarding/team-batches';
export const MAX_TOTAL = 1000;
export const MAX_RUN = 50;
export const teamRoles = ['manager', 'specialist', 'evaluator'];
// CORE-PERMS-01: per-agent memory scope and off / ask / allow per tool category.
export const drawerKinds = ['owner', 'project', 'experience', 'task', 'people'];
export const permissionCategories = ['browser', 'network', 'message', 'delete', 'install', 'money', 'settings'];
export const permissionModes = ['off', 'ask', 'allow'];
export const riskyCategories = ['money', 'install', 'delete'];
export const MAX_GRANTS = 500;
export const MAX_AVAILABLE = 2000;

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const hidden = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/u;
export const displayName = x => typeof x === 'string' && x.length > 0 && [...x].length <= 60
  && x.normalize('NFKC').replace(/\s+/g, ' ').trim() === x && !hidden.test(x);
export const department = x => typeof x === 'string' && x.length > 0 && x.length <= 64 && x.trim() === x
  && x === x.toLowerCase() && /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(x);
export const description = x => typeof x === 'string' && x.length <= 500 && !/[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/u.test(x);
export const toolName = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const version = x => Number.isSafeInteger(x) && x > 0;
const trait = x => Number.isSafeInteger(x) && x >= 0 && x <= 100;

export function validPersonality(p) {
  if (!record(p) || !onlyKeys(p, ['preset', 'traits', 'dialect']) || !presets.includes(p.preset)) return false;
  if (p.dialect !== undefined && !dialects.includes(p.dialect)) return false;
  if (p.traits === undefined) return true;
  return record(p.traits) && Object.keys(p.traits).length <= traitNames.length
    && Object.entries(p.traits).every(([k, v]) => traitNames.includes(k) && trait(v));
}

/** POST /api/agents body: a role is required; persona is preset-based. */
export function validCreateBody(b) {
  if (!record(b) || !onlyKeys(b, ['name', 'role', 'department', 'description', 'personality'])) return false;
  if (!roles.includes(b.role)) return false;
  if (b.name !== undefined && !displayName(b.name)) return false;
  if (b.department !== undefined && !department(b.department)) return false;
  if (b.description !== undefined && !description(b.description)) return false;
  return b.personality === undefined || validPersonality(b.personality);
}

export function permissionsAgentId(path) {
  const m = /^\/api\/agents\/([^/?#]+)\/permissions$/.exec(path);
  return m && validAgentId(m[1]) ? m[1] : null;
}

const kindList = x => Array.isArray(x) && x.length <= drawerKinds.length && x.every(k => drawerKinds.includes(k)) && new Set(x).size === x.length;
const modeMap = x => record(x) && Object.keys(x).length === permissionCategories.length && permissionCategories.every(c => permissionModes.includes(x[c]));

/** PUT /api/agents/:id/permissions body: full replacement; risky "allow" only with confirmRisky. */
export function validPermissionsBody(b) {
  if (!record(b) || !onlyKeys(b, ['memoryRead', 'memoryWrite', 'sharedMemory', 'modes', 'expectedVersion', 'confirmRisky'])) return false;
  if (!kindList(b.memoryRead) || !kindList(b.memoryWrite) || !b.memoryWrite.every(k => b.memoryRead.includes(k))) return false;
  if (typeof b.sharedMemory !== 'boolean' || !modeMap(b.modes)) return false;
  if (!Number.isSafeInteger(b.expectedVersion) || b.expectedVersion < 0) return false;
  if (b.confirmRisky !== undefined && typeof b.confirmRisky !== 'boolean') return false;
  return !riskyCategories.some(c => b.modes[c] === 'allow') || b.confirmRisky === true;
}

export function grantsAgentId(path) {
  const m = /^\/api\/agents\/([^/?#]+)\/tool-grants$/.exec(path);
  return m && validAgentId(m[1]) ? m[1] : null;
}

/**
 * PUT /api/agents/:id/tool-grants body: plain tool names only (no scopes from this UI).
 * keepScopes: true asks the server to keep the limits a still-granted tool already has.
 */
export function validGrantsBody(b) {
  if (!record(b) || !onlyKeys(b, ['grants', 'expectedVersion', 'keepScopes']) || !('grants' in b) || !version(b.expectedVersion) || (b.keepScopes !== undefined && b.keepScopes !== true)) return false;
  return Array.isArray(b.grants) && b.grants.length <= MAX_GRANTS && b.grants.every(toolName) && new Set(b.grants).size === b.grants.length;
}

/** POST /api/onboarding/team-plan body: size, 1-72 departments, optional name language. */
export function validPlanBody(b) {
  if (!record(b) || !onlyKeys(b, ['size', 'departments', 'language']) || !companySizes.includes(b.size)) return false;
  if (b.language !== undefined && !nameLanguages.includes(b.language)) return false;
  return Array.isArray(b.departments) && b.departments.length >= 1 && b.departments.length <= 72
    && b.departments.every(department) && new Set(b.departments).size === b.departments.length;
}

const headcount = x => Number.isSafeInteger(x) && x >= 1 && x <= MAX_TOTAL;
const batchIdOk = x => typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x);
export const validBatchId = batchIdOk;
const departmentList = d => Array.isArray(d) && d.length >= 1 && d.length <= 72 && d.every(department) && new Set(d).size === d.length;

/** A batch path: /api/onboarding/team-batches/:id or …/:id/run. */
export function batchPath(path) {
  const m = /^\/api\/onboarding\/team-batches\/([^/?#]+)(\/run)?$/.exec(path);
  return m && batchIdOk(m[1]) ? { id: m[1], run: m[2] === '/run' } : null;
}

/** POST team-distribution: departments with a total, or with the owner's count per department. */
export function validDistributionBody(b) {
  if (!record(b) || !onlyKeys(b, ['departments', 'total', 'counts']) || !departmentList(b.departments)) return false;
  if (b.total === undefined && b.counts === undefined) return false;
  if (b.total !== undefined && !headcount(b.total)) return false;
  if (b.counts === undefined) return true;
  if (!record(b.counts)) return false;
  const keys = Object.keys(b.counts);
  return keys.length === b.departments.length && keys.every(k => b.departments.includes(k) && headcount(b.counts[k]))
    && keys.reduce((a, k) => a + b.counts[k], 0) <= MAX_TOTAL;
}

export function validSpecialties(rows,count){
 if(rows===undefined)return true;
 return Array.isArray(rows)&&rows.length>=1&&rows.length<=50&&rows.every(s=>record(s)&&onlyKeys(s,['name','count','description'])&&typeof s.name==='string'&&s.name.normalize('NFKC').trim().length>0&&s.name.length<=80&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s.name)&&typeof s.description==='string'&&s.description.length<=1800&&!/[\u0000\u202a-\u202e\u2066-\u2069]/.test(s.description)&&Number.isSafeInteger(s.count)&&s.count>=0&&s.count<=count)&&new Set(rows.map(s=>s.name.normalize('NFKC').trim().toLowerCase())).size===rows.length&&rows.reduce((sum,s)=>sum+s.count,0)===count;
}
/** POST team-batches: a reviewed plan, one entry per department, persona per role optional. */
export function validBatchBody(b) {
  if (!record(b) || !onlyKeys(b, ['id', 'language', 'departments']) || !batchIdOk(b.id) || (b.language !== undefined && !nameLanguages.includes(b.language))) return false;
  const d = b.departments;
  if (!Array.isArray(d) || d.length < 1 || d.length > 72) return false;
  const ok = d.every(x => record(x) && onlyKeys(x, ['department', 'count', 'presets', 'specialties']) && department(x.department) && headcount(x.count)
    && validSpecialties(x.specialties,x.count)
    && (x.presets === undefined || (record(x.presets) && Object.entries(x.presets).every(([r, p]) => teamRoles.includes(r) && presets.includes(p)))));
  return ok && new Set(d.map(x => x.department)).size === d.length && d.reduce((a, x) => a + x.count, 0) <= MAX_TOTAL;
}

export function validRunBody(b) {
  if (!record(b) || !onlyKeys(b, ['max', 'retryFailed'])) return false;
  if (b.max !== undefined && !(Number.isSafeInteger(b.max) && b.max >= 1 && b.max <= MAX_RUN)) return false;
  return b.retryFailed === undefined || typeof b.retryFailed === 'boolean';
}

export function allowedHire(method, path, body) {
  if(path===TEAM_RESOURCES_PATH)return allowedTeamResources(method,body);
  if (path === CATALOGUE_PATH) return method === 'GET' && body === undefined;
  if (path === PLAN_PATH) return method === 'POST' && validPlanBody(body);
  if (path === DISTRIBUTION_PATH) return method === 'POST' && validDistributionBody(body);
  if (path === BATCHES_PATH) return (method === 'GET' && body === undefined) || (method === 'POST' && validBatchBody(body));
  const batch = batchPath(path);
  if (batch) return batch.run ? method === 'POST' && validRunBody(body) : method === 'GET' && body === undefined;
  if (permissionsAgentId(path)) return (method === 'GET' && body === undefined) || (method === 'PUT' && validPermissionsBody(body));
  if (path === '/api/agents') return method === 'POST' && validCreateBody(body);
  if (!grantsAgentId(path)) return false;
  if (method === 'GET') return body === undefined;
  return method === 'PUT' && validGrantsBody(body);
}

/** True when this response belongs to the hire contract (create result or a grants path). */
export function hireRoute(path, status) {
  return path === TEAM_RESOURCES_PATH || path === CATALOGUE_PATH || path === PLAN_PATH || path === DISTRIBUTION_PATH || path === BATCHES_PATH || batchPath(path) !== null
    || grantsAgentId(path) !== null || permissionsAgentId(path) !== null || (path === '/api/agents' && (status === 201 || status === 400 || status === 403));
}

const fail = () => { throw Error('Invalid hire response'); };
const clip = (x, max) => (typeof x === 'string' ? (x.length > max ? x.slice(0, max) : x) : '');

function createResult(status, body) {
  if (status === 201) {
    const a = record(body) ? body.agent : undefined;
    if (!record(a) || !validAgentId(a.id) || !version(a.version)) fail();
    return displayName(a.name) ? { agent: { id: a.id, name: a.name, version: a.version } } : { agent: { id: a.id, version: a.version, nameUnavailable: true } };
  }
  const code = record(body) ? body.code : undefined;
  if (status === 403 && code === 'read_only_stage') return { code };
  return status === 400 && ['invalid_role', 'invalid_personality'].includes(code) ? { code } : null;
}

function grantsView(agentId, body) {
  if (!record(body) || body.agentId !== agentId || !version(body.version) || !Array.isArray(body.grants) || body.grants.length > MAX_GRANTS) fail();
  const grants = body.grants.map(g => {
    if (!record(g) || !toolName(g.tool)) fail();
    return { tool: g.tool, scoped: g.scopes !== null && g.scopes !== undefined };
  });
  const view = { agentId, version: body.version, grants };
  if (body.available === undefined) return view;
  if (!Array.isArray(body.available) || body.available.length > MAX_AVAILABLE) fail();
  view.available = body.available.filter(t => record(t) && toolName(t.name)).map(t => ({
    name: t.name,
    description: clip(t.description, 300),
    requiresApproval: t.requiresApproval === true,
    allowedByServer: t.allowedByServer !== false,
    execClass: t.execClass === true,
  }));
  return view;
}

function grantsResult(agentId, status, body) {
  if (status === 200) return grantsView(agentId, body);
  const code = record(body) ? body.code : undefined;
  if (status === 409 && code === 'version_conflict') {
    if (!version(body.currentVersion)) fail();
    return { code, currentVersion: body.currentVersion };
  }
  if (status === 403 && code === 'read_only_stage') return { code };
  return status === 400 && code === 'invalid_version' ? { code } : null;
}

/** Project a backend response to the reviewed fields only (never error text). */
function catalogueResult(status, body) {
  if (status !== 200) return null;
  if (!record(body) || !Array.isArray(body.sizes) || !Array.isArray(body.departments) || body.departments.length > 100) fail();
  return {
    ...(headcount(body.maxTotal) ? { maxTotal: body.maxTotal } : {}),
    ...(Array.isArray(body.specialties)?{specialties:body.specialties.filter(s=>record(s)&&department(s.department)&&typeof s.name==='string'&&s.name.length<=80&&typeof s.description==='string'&&s.description.length<=1800).slice(0,250).map(s=>({department:s.department,name:s.name,description:s.description}))}:{}),
    sizes: body.sizes.filter(x => record(x) && companySizes.includes(x.id)).map(x => ({ id: x.id, label: clip(x.label, 60) })),
    departments: body.departments.filter(x => record(x) && department(x.id)).map(x => ({ id: x.id, label: clip(x.label, 60), summary: clip(x.summary, 200) })),
  };
}

function planResult(status, body) {
  if (status === 200) {
    if (!record(body) || !companySizes.includes(body.size) || !Array.isArray(body.hires) || body.hires.length > 60) fail();
    return {
      size: body.size,
      hires: body.hires.map(h => {
        if (!record(h) || !department(h.department) || !roles.includes(h.role) || !presets.includes(h.preset) || !displayName(h.name) || !description(h.description)) fail();
        return { department: h.department, departmentLabel: clip(h.departmentLabel, 64), role: h.role, title: clip(h.title, 80), description: h.description, preset: h.preset, name: h.name };
      }),
    };
  }
  const code = record(body) ? body.code : undefined;
  if (status === 403 && code === 'read_only_stage') return { code };
  return status === 400 && code === 'invalid_plan' ? { code } : null;
}

const count0 = x => Number.isSafeInteger(x) && x >= 0 && x <= MAX_TOTAL;
const known = (status, body, codes) => {
  const code = record(body) ? body.code : undefined;
  if (status === 403 && code === 'read_only_stage') return { code };
  return codes.includes(code) ? { code } : null;
};

function distributionResult(status, body) {
  if (status !== 200) return status === 400 ? known(status, body, ['invalid_plan']) : known(status, body, []);
  if (!record(body) || !headcount(body.total) || !Array.isArray(body.departments) || body.departments.length < 1 || body.departments.length > 72) fail();
  const departments = body.departments.map(d => {
    if (!record(d) || !department(d.department) || !headcount(d.count) || !record(d.roles) || !record(d.presets) || !record(d.titles)) fail();
    const roles = {}; const ps = {}; const titles = {};
    for (const r of teamRoles) {
      if (!count0(d.roles[r]) || !presets.includes(d.presets[r])) fail();
      roles[r] = d.roles[r]; ps[r] = d.presets[r]; titles[r] = clip(d.titles[r], 80);
    }
    if (roles.manager + roles.specialist + roles.evaluator !== d.count) fail();
    return { department: d.department, departmentLabel: clip(d.departmentLabel, 64), count: d.count, roles, presets: ps, titles };
  });
  if (departments.reduce((a, d) => a + d.count, 0) !== body.total) fail();
  return { total: body.total, departments };
}

function progress(p) {
  if (!record(p) || !batchIdOk(p.id) || !headcount(p.total) || ![p.created, p.failed, p.pending].every(count0) || typeof p.done !== 'boolean') fail();
  if (p.created + p.failed + p.pending !== p.total || !Array.isArray(p.departments) || p.departments.length > 72) fail();
  return {
    id: p.id, total: p.total, created: p.created, failed: p.failed, pending: p.pending, done: p.done,
    departments: p.departments.map(d => {
      if (!record(d) || !department(d.department) || ![d.total, d.created, d.failed].every(count0)) fail();
      return { department: d.department, total: d.total, created: d.created, failed: d.failed };
    }),
  };
}

function batchesResult(status, body) {
  if (status === 200 && record(body) && Array.isArray(body.batches)) {
    if (body.batches.length > 10) fail();
    return { batches: body.batches.map(progress) };
  }
  if ((status === 200 || status === 201) && record(body) && typeof body.created === 'boolean') return { created: body.created, batch: progress(body.batch) };
  if (status === 200 || status === 201) fail();
  return known(status, body, status === 409 ? ['batch_conflict'] : status === 400 ? ['invalid_plan'] : []);
}

const runCodes = ['create_failed', 'name_unavailable'];
function batchResult(batch, status, body) {
  if (status === 200 && !batch.run) {
    if (!record(body)) fail();
    return { batch: progress(body.batch) };
  }
  if (status === 200) {
    if (!record(body) || !Array.isArray(body.results) || body.results.length > MAX_RUN) fail();
    return {
      batch: progress(body.batch),
      results: body.results.map(r => {
        if (!record(r) || !Number.isSafeInteger(r.seq) || r.seq < 1 || !['created', 'failed'].includes(r.status)) fail();
        if (r.status === 'created') return displayName(r.name) ? { seq: r.seq, status: r.status, name: r.name } : { seq: r.seq, status: r.status };
        return { seq: r.seq, status: r.status, ...(runCodes.includes(r.code) ? { code: r.code } : {}) };
      }),
    };
  }
  return known(status, body, status === 404 ? ['batch_not_found'] : status === 409 ? ['batch_running'] : status === 400 ? ['invalid_plan'] : []);
}

function permissionsView(agentId, b) {
  if (!record(b) || b.agentId !== agentId || !kindList(b.memoryRead) || !kindList(b.memoryWrite) || typeof b.sharedMemory !== 'boolean' || !modeMap(b.modes)
    || !Number.isSafeInteger(b.version) || b.version < 0) fail();
  return { agentId, memoryRead: [...b.memoryRead], memoryWrite: b.memoryWrite.filter(k => b.memoryRead.includes(k)), sharedMemory: b.sharedMemory,
    modes: Object.fromEntries(permissionCategories.map(c => [c, b.modes[c]])), version: b.version };
}

function permissionsResult(agentId, status, body) {
  if (status === 200) return permissionsView(agentId, body);
  const code = record(body) ? body.code : undefined;
  if (status === 409 && code === 'version_conflict') {
    if (!Number.isSafeInteger(body.currentVersion)) fail();
    return { code, currentVersion: body.currentVersion };
  }
  if (status === 403 && code === 'read_only_stage') return { code };
  return status === 400 && ['invalid_permissions', 'risky_not_confirmed', 'invalid_version'].includes(code) ? { code } : null;
}

export function hireResponse(path, status, body) {
  if(path===TEAM_RESOURCES_PATH)return teamResourcesResponse(status,body);
  if (path === CATALOGUE_PATH) return catalogueResult(status, body);
  if (path === PLAN_PATH) return planResult(status, body);
  if (path === DISTRIBUTION_PATH) return distributionResult(status, body);
  if (path === BATCHES_PATH) return batchesResult(status, body);
  const batch = batchPath(path);
  if (batch) return batchResult(batch, status, body);
  const permAgent = permissionsAgentId(path);
  if (permAgent) return permissionsResult(permAgent, status, body);
  if (path === '/api/agents') return createResult(status, body);
  const agentId = grantsAgentId(path);
  if (!agentId) fail();
  return grantsResult(agentId, status, body);
}
