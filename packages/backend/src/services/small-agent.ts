/**
 * Small-agent runs (MCP-01, D-HYBRID).
 *
 * A large agent (Claude Code / Codex through the Agent Player MCP server, with
 * the owner's CLI token) hands a light task to the small local agent: a
 * dedicated agent `small-local-agent` (provider ollama, local Qwen model).
 * Every task becomes an ordinary durable task run (CORE-08) with:
 *
 *  - tools  = requested ∩ SMALL_AGENT_SAFE_TOOLS ∩ the small agent's own
 *             grants, minus anything exec-class or approval-gated. Nothing
 *             requested -> memory_search + storage_search. `read` only when
 *             asked for explicitly. Delegation never expands permissions.
 *  - drawers = the requested memory drawers that an owner turn may open
 *             (memory/drawers.ts selectDrawers + subagentDrawers). Nothing
 *             requested -> no memory at all.
 *  - budget = lower defaults than other runs (15 steps / 5 min); a larger
 *             request is clamped down, never up.
 *  - capacity: at most SMALL_AGENT_MAX_CONCURRENT (default 2) active runs;
 *             further spawns are refused (429), never queued silently.
 *
 *  - read:   only inside the small agent's own workspace
 *             (.data/workspaces/small-local-agent/), or inside one directory
 *             the owner names at spawn (`read_dir`), never the backend tree
 *             or the data directory (MCP-01b, S1.6 sandbox + deny list).
 *  - settings: the executor always uses the built-in SYSTEM_PROMPT, the
 *             env/default model and fixed sampling settings, never the
 *             editable agents_config row (MCP-01b). An edited row only makes
 *             the card ask for review.
 *
 * What a run was allowed is stored in small_agent_runs when it is created
 * and read again by the executor on every attempt (smallAgentRunScope).
 * The result card says whether a large agent must review the output;
 * secret-looking values are redacted from it.
 */

import { dataPath, dataRoot } from '../config/data-root.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { all, dialect, one, run as runSql, sql } from '../repositories/sql-steps.js';
import { insertOrIgnore } from '../db/pg/dialect.js';
import { getOrchestrator } from '../multi-agent/index.js';
import { DEFAULT_OLLAMA_MODEL } from '../llm/ollama.js';
import { createAgentToolsRegistry } from '../tools/index.js';
import { approvalCategory } from '../tools/approvals.js';
import { isToolExecClass } from '../tools/exec-policy.js';
import { TOOL_NAME_PATTERN, intersectGrants, setAgentGrants, staticGrants, type AgentToolGrants } from '../tools/grants.js';
import {
  DrawerInputError,
  drawerId,
  normalizeDrawer,
  parseDrawerId,
  sameDrawer,
  selectDrawers,
  subagentDrawers,
  type DrawerRef,
} from '../memory/drawers.js';
import { redactSecrets } from './secret-redact.js';
import { isoUtc } from '../api/timestamps.js';
import { canonicalPath, denyReason, isInside, isInsideIgnoringCase, realPath } from '../tools/core/file-sandbox.js';
import { cliConfigDir } from './instance-identity.js';
import { createRun, getRun, getSteps, elapsedMs, type TaskRunRow, type TaskRunStatus } from './task-runs.js';

export const SMALL_AGENT_ID = 'small-local-agent';

/** The only tools a small-agent run can ever get (read-only, no external effect). */
export const SMALL_AGENT_SAFE_TOOLS: readonly string[] = ['memory_search', 'storage_search', 'read', 'memory_graph'];
/** Tools a run gets when the caller does not name any. */
export const SMALL_AGENT_DEFAULT_TOOLS: readonly string[] = ['memory_search', 'storage_search'];

export const SMALL_AGENT_KINDS = ['lookup', 'summary', 'classification', 'draft', 'other'] as const;
export type SmallAgentKind = typeof SMALL_AGENT_KINDS[number];
/** Kinds whose output is purely informational (no review needed when nothing went wrong). */
const INFORMATIONAL_KINDS: ReadonlySet<string> = new Set(['lookup', 'summary', 'classification']);

const MAX_TASK_CHARS = 8_000;
const MAX_REQUESTED_TOOLS = 20;
const MAX_REQUESTED_DRAWERS = 14;
const MAX_CARD_OUTPUT_CHARS = 20_000;

export const SYSTEM_PROMPT = [
  'You are the small local helper agent of Agent Player.',
  'A larger agent gave you one light task: a lookup, a summary, a classification or a draft.',
  'Do only that task. Use only the tools you were given; you cannot send messages, change files or run commands.',
  'If you cannot do the task with what you have, say so plainly.',
  'Answer with the result only. Start with a one-line summary, then the details.',
].join(' ');

/** Fixed sampling settings of the small agent (not taken from agents_config). */
export const SMALL_AGENT_TEMPERATURE = 0.2;
export const SMALL_AGENT_MAX_TOKENS = 2048;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/** Defaults (env overrides, read at call time). */
export function smallAgentDefaults() {
  return {
    maxSteps: envInt('SMALL_AGENT_MAX_STEPS', 15, 1, 100),
    maxDurationMs: envInt('SMALL_AGENT_MAX_DURATION_MS', 5 * 60_000, 5_000, 60 * 60_000),
    maxConcurrent: envInt('SMALL_AGENT_MAX_CONCURRENT', 2, 1, 50),
    model: (process.env.SMALL_AGENT_MODEL || '').trim() || DEFAULT_OLLAMA_MODEL,
  };
}

export class SmallAgentInputError extends Error { readonly status = 400; }
export class SmallAgentCapacityError extends Error {
  readonly status = 429;
  constructor(readonly capacity: SmallAgentCapacity) {
    super(`The small agent is busy: ${capacity.active} of ${capacity.limit} runs are active. Try again when one finishes.`);
  }
}

// ---------------------------------------------------------------------------
// The dedicated agent
// ---------------------------------------------------------------------------

/**
 * Create the small agent once (agents_config + grant profile + orchestrator
 * registration). Its stored grants are exactly the safe set; the owner can
 * narrow them later through the grants API, and runs respect that.
 */
export async function ensureSmallAgent(): Promise<void> {
  const exists = await sql().read(one('SELECT 1 AS ok FROM agents_config WHERE id = ?', SMALL_AGENT_ID));
  if (!exists) {
    await sql().read((function* () {
      const d = yield* dialect();
      return yield* runSql(insertOrIgnore(d, `
      INSERT INTO agents_config (id, name, description, system_prompt, model, provider, temperature, max_tokens, cron_enabled)
      VALUES (?, ?, ?, ?, ?, 'ollama', ?, ?, 0)
    `),
      SMALL_AGENT_ID,
      'Small local agent',
      'Local Qwen helper for light tasks delegated by a large agent (lookups, summaries, classification, drafts).',
      SYSTEM_PROMPT,
      smallAgentDefaults().model,
      SMALL_AGENT_TEMPERATURE,
      SMALL_AGENT_MAX_TOKENS,
    );
    })());
    const available = (await createAgentToolsRegistry({ workspaceDir: process.cwd() })).listRegistered();
    await setAgentGrants(SMALL_AGENT_ID, { grants: [...SMALL_AGENT_SAFE_TOOLS] }, 'system:small-agent', available);
  }
  const orchestrator = getOrchestrator();
  if (!orchestrator.getAgent(SMALL_AGENT_ID)) {
    orchestrator.registerAgent({
      id: SMALL_AGENT_ID,
      name: 'Small local agent',
      role: 'worker',
      capabilities: ['lookup', 'summary', 'classification', 'draft'],
      // Concurrency is limited by SMALL_AGENT_MAX_CONCURRENT, not here.
      maxConcurrentTasks: 1_000,
    } as any);
  }
}

// ---------------------------------------------------------------------------
// Tools and drawers
// ---------------------------------------------------------------------------

export interface Dropped { item: string; reason: string }

type ToolInfo = { name: string; execClass?: boolean; requiresApproval?: boolean };

/**
 * Tools a small-agent run may use: requested ∩ safe set ∩ the agent's grants,
 * minus exec-class and approval-gated tools. Pure (inputs passed in).
 */
export function resolveSmallAgentTools(
  requested: unknown,
  registered: ReadonlyArray<ToolInfo>,
  agentGrants: AgentToolGrants,
): { requested: string[]; granted: string[]; dropped: Dropped[] } {
  let list: string[];
  if (requested === undefined || requested === null) {
    list = [...SMALL_AGENT_DEFAULT_TOOLS];
  } else {
    if (!Array.isArray(requested) || requested.length > MAX_REQUESTED_TOOLS) {
      throw new SmallAgentInputError(`tools must be an array of tool names (max ${MAX_REQUESTED_TOOLS})`);
    }
    list = [];
    for (const t of requested) {
      if (typeof t !== 'string' || !TOOL_NAME_PATTERN.test(t)) throw new SmallAgentInputError('invalid tool name');
      if (!list.includes(t)) list.push(t);
    }
  }
  const granted: string[] = [];
  const dropped: Dropped[] = [];
  for (const name of list) {
    const tool = registered.find((t) => t.name === name);
    if (!SMALL_AGENT_SAFE_TOOLS.includes(name)) dropped.push({ item: name, reason: 'not in the small-agent safe set (memory_search, storage_search, read, memory_graph)' });
    else if (!tool) dropped.push({ item: name, reason: 'not available on this server' });
    else if (isToolExecClass(tool)) dropped.push({ item: name, reason: 'exec-class tools are never delegated' });
    else if (approvalCategory(tool) !== null) dropped.push({ item: name, reason: 'tools that need owner approval are never delegated' });
    else if (!agentGrants.tools.has(name)) dropped.push({ item: name, reason: 'not granted to the small agent' });
    else granted.push(name);
  }
  return { requested: list, granted, dropped };
}

/**
 * Drawers a small-agent run may read: the requested ones that an owner turn
 * may open (owner, experience, ONE project, ONE task, up to 10 people).
 * Nothing requested -> none. Invalid entries are a 400; extra projects/tasks
 * are dropped with a warning.
 */
export function resolveSmallAgentDrawers(requested: unknown): { drawers: DrawerRef[]; dropped: Dropped[] } {
  if (requested === undefined || requested === null) return { drawers: [], dropped: [] };
  if (!Array.isArray(requested) || requested.length > MAX_REQUESTED_DRAWERS) {
    throw new SmallAgentInputError(`drawers must be an array (max ${MAX_REQUESTED_DRAWERS})`);
  }
  const parsed: DrawerRef[] = [];
  for (const r of requested) {
    try {
      const d = typeof r === 'string' ? parseDrawerId(r) : normalizeDrawer(r);
      if (!parsed.some((x) => sameDrawer(x, d))) parsed.push(d);
    } catch (err) {
      if (err instanceof DrawerInputError) throw new SmallAgentInputError(`invalid drawer: ${err.message}`);
      throw err;
    }
  }
  const project = parsed.find((d) => d.kind === 'project')?.key ?? null;
  const task = parsed.find((d) => d.kind === 'task')?.key ?? null;
  const people = parsed.filter((d) => d.kind === 'people').map((d) => d.key!);
  const allowed = selectDrawers({ audience: 'owner', project, task, people, experience: parsed.some((d) => d.kind === 'experience') });
  const drawers = subagentDrawers(allowed, parsed);
  const dropped = parsed
    .filter((d) => !drawers.some((x) => sameDrawer(x, d)))
    .map((d) => ({ item: drawerId(d), reason: 'an owner turn opens at most one project, one task and ten people drawers' }));
  return { drawers, dropped };
}

// ---------------------------------------------------------------------------
// Read directory (MCP-01b)
// ---------------------------------------------------------------------------

/** One implementation with the file-tool sandbox: on-disk case (realpath.native). */
const realOrResolved = canonicalPath;

/** Credential / config folders under the home directory that a read_dir may never overlap. */
const HOME_CREDENTIAL_DIRS = ['.config', '.aws', '.kube', '.docker', '.gnupg', '.ssh', 'Library', '.codex', '.npmrc', '.netrc', '.git-credentials', '.azure', '.gcloud'];

/**
 * Places a small-agent read directory may never overlap, even inside an
 * allowed root: the backend tree, data dirs, the CLI config dir (token and
 * instance secret), credential folders in the home directory (incl. every
 * `~/.claude*`), and /etc.
 */
export function smallAgentProtectedTrees(): string[] {
  const home = os.homedir();
  const list = [process.cwd(), dataRoot(), dataPath('secrets.env'), path.join(process.cwd(), '.data'), cliConfigDir(), '/etc', '/private/etc'];
  if (process.env.DATABASE_PATH) list.push(path.dirname(process.env.DATABASE_PATH));
  for (const d of HOME_CREDENTIAL_DIRS) list.push(path.join(home, d));
  try {
    for (const name of fs.readdirSync(home)) if (name.toLowerCase().startsWith('.claude')) list.push(path.join(home, name));
  } catch { /* unreadable home: the fixed list still applies */ }
  list.push(path.join(home, '.claude'), path.join(home, '.claude.json'));
  return [...new Set(list.flatMap((p) => [path.resolve(p), realOrResolved(p)]))];
}

/** Owner-configured allow-list (SMALL_AGENT_READ_ROOTS, path-delimiter separated). Empty -> read_dir is refused (deny by default). */
function configuredReadRoots(): string[] {
  return (process.env.SMALL_AGENT_READ_ROOTS ?? '').split(path.delimiter).map((x) => x.trim()).filter(Boolean)
    .filter((x) => path.isAbsolute(x)).map(realOrResolved);
}

/**
 * Validate a directory the owner lets a small-agent run read. Returns its
 * real path. Refused: relative paths, missing/non-directories, the
 * filesystem root, the home directory itself, anything that contains or is
 * inside a protected tree (smallAgentProtectedTrees), deny-listed places
 * (.git, .ssh, ...), and anything outside SMALL_AGENT_READ_ROOTS. Deny by
 * default: with no SMALL_AGENT_READ_ROOTS every read_dir is refused.
 */
export function validateSmallAgentReadDir(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new SmallAgentInputError('read_dir must be an absolute directory path');
  // eslint-disable-next-line no-control-regex
  if (input.length > 1024 || /[\u0000-\u001f\u007f]/.test(input)) throw new SmallAgentInputError('read_dir is not a valid path');
  if (!path.isAbsolute(input)) throw new SmallAgentInputError('read_dir must be an absolute directory path');
  let real: string;
  try {
    real = realPath(input);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SmallAgentInputError('read_dir must be an existing directory');
  }
  if (real === path.parse(real).root) throw new SmallAgentInputError('read_dir cannot be the filesystem root');
  if (isInsideIgnoringCase(real, realOrResolved(os.homedir())) && isInsideIgnoringCase(realOrResolved(os.homedir()), real)) throw new SmallAgentInputError('read_dir cannot be the whole home directory; name a project folder');
  const allowed = configuredReadRoots();
  if (!allowed.length) {
    throw new SmallAgentInputError('read_dir is off: the owner has not set SMALL_AGENT_READ_ROOTS (allowed folders) in the backend environment');
  }
  if (!allowed.some((r) => isInside(r, real))) {
    throw new SmallAgentInputError('read_dir is outside the directories allowed by SMALL_AGENT_READ_ROOTS');
  }
  for (const t of smallAgentProtectedTrees()) {
    if (isInsideIgnoringCase(t, real) || isInsideIgnoringCase(real, t)) throw new SmallAgentInputError('read_dir cannot be or contain the Agent Player backend, data, config or credential folders');
  }
  if (denyReason('', real)) throw new SmallAgentInputError('read_dir points to a protected location');
  return real;
}

/** Fields of the small agent's agents_config row that differ from the built-in defaults. */
export async function smallAgentConfigDrift(): Promise<string[]> {
  const row = await sql().read(one<{ system_prompt: string | null; model: string; provider: string; temperature: number; max_tokens: number }>(
    'SELECT system_prompt, model, provider, temperature, max_tokens FROM agents_config WHERE id = ?', SMALL_AGENT_ID));
  if (!row) return [];
  const drift: string[] = [];
  if ((row.system_prompt ?? '') !== SYSTEM_PROMPT) drift.push('system_prompt');
  if (row.model !== smallAgentDefaults().model) drift.push('model');
  if (row.provider !== 'ollama') drift.push('provider');
  if (Number(row.temperature) !== SMALL_AGENT_TEMPERATURE) drift.push('temperature');
  if (Number(row.max_tokens) !== SMALL_AGENT_MAX_TOKENS) drift.push('max_tokens');
  return drift;
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface SmallAgentCapacity {
  active: number; running: number; queued: number; waiting: number; limit: number; available: number;
}

export async function smallAgentCapacity(): Promise<SmallAgentCapacity> {
  const rows = await sql().read(all<{ status: string; n: number }>(`
    SELECT status, COUNT(*) AS n FROM task_runs
    WHERE agent_id = ? AND status IN ('queued', 'running', 'waiting_approval') GROUP BY status
  `, SMALL_AGENT_ID));
  const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const limit = smallAgentDefaults().maxConcurrent;
  const active = by('queued') + by('running') + by('waiting_approval');
  return { active, running: by('running'), queued: by('queued'), waiting: by('waiting_approval'), limit, available: Math.max(0, limit - active) };
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

interface SmallAgentRunRow {
  run_id: string; task_id: string; requested_by: string; kind: SmallAgentKind;
  requested_tools: string; granted_tools: string; drawers: string; model: string; warnings: string; created_at: string;
  read_root: string | null;
}

function parseList<T = string>(json: string | null | undefined): T[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface SpawnInput {
  ownerId: string;
  task: unknown;
  tools?: unknown;
  drawers?: unknown;
  maxSteps?: unknown;
  kind?: unknown;
  /** Owner-chosen directory `read` may use instead of the agent's workspace. */
  readDir?: unknown;
}

export interface SpawnResult {
  run: TaskRunRow;
  kind: SmallAgentKind;
  grantedTools: string[];
  drawers: DrawerRef[];
  model: string;
  warnings: string[];
  capacity: SmallAgentCapacity;
  readRoot: string | null;
}

// One spawn at a time in this process, so the capacity check and the insert
// cannot interleave.
let spawnChain: Promise<unknown> = Promise.resolve();

export function spawnSmallAgentRun(input: SpawnInput): Promise<SpawnResult> {
  const next = spawnChain.then(() => doSpawn(input));
  spawnChain = next.catch(() => undefined);
  return next;
}

async function doSpawn(input: SpawnInput): Promise<SpawnResult> {
  if (typeof input.task !== 'string' || !input.task.trim()) throw new SmallAgentInputError('task is required');
  if (input.task.length > MAX_TASK_CHARS) throw new SmallAgentInputError(`task is too long (max ${MAX_TASK_CHARS} characters)`);
  const kind = (input.kind === undefined || input.kind === null ? 'other' : input.kind) as SmallAgentKind;
  if (!(SMALL_AGENT_KINDS as readonly unknown[]).includes(kind)) {
    throw new SmallAgentInputError(`kind must be one of ${SMALL_AGENT_KINDS.join(', ')}`);
  }
  const d = smallAgentDefaults();
  const warnings: string[] = [];
  let maxSteps = d.maxSteps;
  if (input.maxSteps !== undefined && input.maxSteps !== null) {
    const n = Number(input.maxSteps);
    if (!Number.isInteger(n) || n < 1) throw new SmallAgentInputError('max_steps must be a positive integer');
    if (n > d.maxSteps) warnings.push(`max_steps ${n} lowered to the small-agent limit ${d.maxSteps}`);
    maxSteps = Math.min(n, d.maxSteps);
  }

  await ensureSmallAgent();
  const registry = await createAgentToolsRegistry({ workspaceDir: process.cwd(), agentId: SMALL_AGENT_ID });
  const tools = resolveSmallAgentTools(input.tools, registry.listRegistered(), registry.getContext().grants!);
  const drawers = resolveSmallAgentDrawers(input.drawers);
  for (const x of tools.dropped) warnings.push(`tool "${x.item}" not given: ${x.reason}`);
  for (const x of drawers.dropped) warnings.push(`drawer "${x.item}" not opened: ${x.reason}`);
  let readRoot: string | null = null;
  if (input.readDir !== undefined && input.readDir !== null) {
    const real = validateSmallAgentReadDir(input.readDir);
    if (tools.granted.includes('read')) readRoot = real;
    else warnings.push('read_dir ignored: the "read" tool was not given to this run');
  }

  const capacity = await smallAgentCapacity();
  if (capacity.active >= capacity.limit) throw new SmallAgentCapacityError(capacity);

  // MCP-01b: always the env/default model, never the editable agents_config row.
  const model = d.model;

  // The task text lives only in the encrypted run input, not in the
  // orchestrator's task title/description.
  const orchestrator = getOrchestrator();
  const task = orchestrator.createTask({
    title: `Small agent run (${kind})`,
    description: 'Light task delegated to the small local agent (text kept encrypted in the task run).',
    priority: 'normal',
    origin: 'owner',
    maxRetries: 0,
  });
  if (!orchestrator.assignTask(task.id, SMALL_AGENT_ID)) throw new Error('could not assign the task to the small agent');
  orchestrator.startTask(task.id);

  const run = await createRun({
    taskId: task.id,
    agentId: SMALL_AGENT_ID,
    userId: input.ownerId,
    prompt: input.task,
    maxSteps,
    maxDurationMs: d.maxDurationMs,
  });
  await sql().read(runSql(`
    INSERT INTO small_agent_runs (run_id, task_id, requested_by, kind, requested_tools, granted_tools, drawers, model, warnings, read_root)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, run.id, task.id, input.ownerId, kind, JSON.stringify(tools.requested), JSON.stringify(tools.granted),
    JSON.stringify(drawers.drawers), model, JSON.stringify(warnings), readRoot));

  return { run, kind, grantedTools: tools.granted, drawers: drawers.drawers, model, warnings, capacity: await smallAgentCapacity(), readRoot };
}

// ---------------------------------------------------------------------------
// Executor hook
// ---------------------------------------------------------------------------

export interface SmallAgentRunScope {
  /** Effective grants for this attempt (never wider than what was stored). */
  grants: AgentToolGrants;
  memoryDrawers: DrawerRef[];
  userId: string | null;
  /** Owner-chosen read directory (re-validated), or undefined -> the agent's own workspace. */
  fileReadRoot?: string;
  /** Built-in settings the executor uses (never the agents_config row). */
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Scope of a small-agent run for one attempt: the stored tools ∩ the safe
 * set ∩ the agent's grants now (`current`), minus exec/approval tools; the
 * stored drawers re-validated. A missing row -> nothing (fail closed).
 */
export async function smallAgentRunScope(
  run: Pick<TaskRunRow, 'id' | 'user_id'>,
  current: AgentToolGrants,
  registered: ReadonlyArray<ToolInfo>,
): Promise<SmallAgentRunScope> {
  const row = await sql().read(one<Pick<SmallAgentRunRow, 'granted_tools' | 'drawers' | 'model' | 'read_root'>>(
    'SELECT granted_tools, drawers, model, read_root FROM small_agent_runs WHERE run_id = ?', run.id));
  const settings = {
    model: row?.model || smallAgentDefaults().model,
    systemPrompt: SYSTEM_PROMPT,
    temperature: SMALL_AGENT_TEMPERATURE,
    maxTokens: SMALL_AGENT_MAX_TOKENS,
  };
  if (!row) return { grants: { agentId: SMALL_AGENT_ID, tools: new Map() }, memoryDrawers: [], userId: null, ...settings };
  // The stored read directory must still be valid; otherwise `read` is
  // dropped for this attempt (fail closed).
  let fileReadRoot: string | undefined;
  let readOk = true;
  if (row.read_root) {
    try { fileReadRoot = validateSmallAgentReadDir(row.read_root); } catch { readOk = false; }
  }
  const allowed = parseList(row.granted_tools).filter((name) => {
    if (name === 'read' && !readOk) return false;
    if (typeof name !== 'string' || !SMALL_AGENT_SAFE_TOOLS.includes(name)) return false;
    const tool = registered.find((t) => t.name === name);
    return !!tool && !isToolExecClass(tool) && approvalCategory(tool) === null;
  });
  const grants = intersectGrants(staticGrants(allowed, SMALL_AGENT_ID), current);
  const memoryDrawers = selectDrawers({ audience: 'subagent', passed: parseList<DrawerRef>(row.drawers) });
  return { grants, memoryDrawers, userId: run.user_id, fileReadRoot, ...settings };
}

/** MCP-01b: the small agent always runs with the built-in prompt (the stored row is ignored). */
export function smallAgentSystemPrompt(_stored?: string | null): string {
  return SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

export interface ResultCard {
  run_id: string;
  status: TaskRunStatus;
  kind: SmallAgentKind;
  summary: string;
  outputs: Array<{ type: 'text'; text: string }>;
  steps_used: number;
  max_steps: number;
  duration_ms: number;
  max_duration_ms: number;
  model: string;
  agent: string;
  tools_granted: string[];
  tools_used: string[];
  /** Directory `read` was confined to (null -> the small agent's own workspace). */
  read_dir: string | null;
  drawers: string[];
  needs_review: boolean;
  review_reason: string | null;
  warnings: string[];
  created_at: string;
  finished_at: string | null;
}

const FINAL: ReadonlySet<TaskRunStatus> = new Set(['completed', 'failed', 'cancelled']);

function fullOutput(run: TaskRunRow): string {
  try {
    const task = getOrchestrator().getTask(run.task_id);
    const out = (task?.output as any)?.output;
    if (typeof out === 'string') return out;
  } catch { /* orchestrator unavailable */ }
  return run.output_preview ?? '';
}

function summaryOf(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const clean = first.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1');
  return clean.length > 280 ? `${clean.slice(0, 277)}...` : clean;
}

/** Result card of a small-agent run, or null when it is not one. */
export async function smallAgentCard(runId: string): Promise<ResultCard | null> {
  const meta = await sql().read(one<SmallAgentRunRow>('SELECT * FROM small_agent_runs WHERE run_id = ?', runId));
  const run = meta ? await getRun(runId) : undefined;
  if (!meta || !run) return null;
  const steps = await getSteps(run.id);
  const warnings = [...parseList(meta.warnings)];
  const runtime: string[] = [];

  let output = run.status === 'completed' ? fullOutput(run) : '';
  if (output.length > MAX_CARD_OUTPUT_CHARS) {
    output = output.slice(0, MAX_CARD_OUTPUT_CHARS);
    runtime.push(`output cut to ${MAX_CARD_OUTPUT_CHARS} characters`);
  }
  // MCP-01b: secret-looking values never leave through the card.
  const redacted = redactSecrets(output);
  output = redacted.text;
  if (redacted.count) runtime.push(`${redacted.count} secret-looking value(s) redacted from the output`);
  const drift = await smallAgentConfigDrift();
  if (drift.length) runtime.push(`the small-local-agent settings were edited (${drift.join(', ')}); the built-in settings were used`);
  const failedTools = steps.filter((s) => s.kind === 'tool' && (s.status === 'failed' || s.status === 'unknown'));
  if (failedTools.length) runtime.push(`${failedTools.length} tool step(s) failed`);
  const toolsUsed = [...new Set(steps.filter((s) => s.kind === 'tool' && s.tool_name).map((s) => s.tool_name!))];
  const outsideGrant = toolsUsed.filter((t) => !parseList(meta.granted_tools).includes(t));
  if (outsideGrant.length) runtime.push(`the model asked for tools it was not given (refused): ${outsideGrant.join(', ')}`);
  if (toolsUsed.includes('read')) runtime.push(meta.read_root ? 'the agent read files from the directory given at spawn; check that nothing private is quoted' : 'the agent read files from its own workspace; check that nothing private is quoted');
  if (run.status === 'failed') runtime.push(`run failed: ${run.status_reason ?? 'unknown reason'}`);
  if (run.status === 'cancelled') runtime.push('run was cancelled');
  if (run.status === 'waiting_approval') runtime.push(`run is waiting for the owner (${run.status_reason ?? 'decision'})`);
  if (run.status === 'completed' && !output.trim()) runtime.push('the agent returned no output');

  // Unfinished runs are not reviewable yet; every finished run that is not
  // a clean informational result needs a large agent's review.
  const finished = FINAL.has(run.status) || run.status === 'waiting_approval';
  const reviewReason = !finished ? 'the run has not finished'
    : run.status !== 'completed' ? 'the run did not complete'
    : !INFORMATIONAL_KINDS.has(meta.kind) ? `"${meta.kind}" output is not purely informational`
    : runtime.length ? 'warnings during the run'
    : null;

  const summary = run.status === 'completed'
    ? summaryOf(output) || '(no output)'
    : run.status === 'failed' ? `Failed: ${redactSecrets(run.status_reason ?? 'unknown reason').text}`
    : run.status === 'cancelled' ? 'Cancelled.'
    : run.status === 'waiting_approval' ? `Waiting for the owner (${run.status_reason ?? 'decision'}).`
    : run.status === 'running' ? 'Running.' : 'Queued.';

  return {
    run_id: run.id,
    status: run.status,
    kind: meta.kind,
    summary,
    outputs: output ? [{ type: 'text', text: output }] : [],
    steps_used: run.steps_used,
    max_steps: run.max_steps,
    duration_ms: elapsedMs(run),
    max_duration_ms: run.max_duration_ms,
    model: meta.model,
    agent: SMALL_AGENT_ID,
    tools_granted: parseList(meta.granted_tools),
    tools_used: toolsUsed,
    read_dir: meta.read_root ?? null,
    drawers: parseList<DrawerRef>(meta.drawers).map((d) => drawerId(d)),
    needs_review: reviewReason !== null,
    review_reason: reviewReason,
    warnings: [...warnings, ...runtime],
    created_at: isoUtc(run.created_at) as string, // BE-UI-01: ISO UTC with Z
    finished_at: isoUtc(run.finished_at),
  };
}

export interface SmallAgentRunSummary {
  run_id: string; status: TaskRunStatus; kind: SmallAgentKind; summary: string | null;
  steps_used: number; max_steps: number; created_at: string; finished_at: string | null;
}

export async function listSmallAgentRuns(filter: { status?: string; limit?: number }): Promise<SmallAgentRunSummary[]> {
  const limit = Math.min(Math.max(Number(filter.limit) || 20, 1), 100);
  const args: Array<string | number> = [];
  let where = '';
  if (filter.status) { where = 'WHERE r.status = ?'; args.push(filter.status); }
  // Ties on created_at (second precision) by the run id (B2.2b-3: no rowid).
  const rows = await sql().read(all<TaskRunRow & { small_kind: SmallAgentKind }>(`
    SELECT r.*, s.kind AS small_kind FROM small_agent_runs s JOIN task_runs r ON r.id = s.run_id
    ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ?
  `, ...args, limit));
  return rows.map((r) => ({
    run_id: r.id,
    status: r.status,
    kind: r.small_kind,
    summary: r.output_preview ? summaryOf(redactSecrets(r.output_preview).text) : (r.status === 'failed' && r.status_reason ? redactSecrets(r.status_reason).text : null),
    steps_used: r.steps_used,
    max_steps: r.max_steps,
    created_at: isoUtc(r.created_at) as string,
    finished_at: isoUtc(r.finished_at),
  }));
}
