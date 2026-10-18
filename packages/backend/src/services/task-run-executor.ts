import { agentSkillsPrompt } from '../skills/central-store.js';
/**
 * Durable task-run executor + startup recovery (CORE-08, R2).
 *
 * executeTaskRun() claims a run's lease and walks the agentic tool loop as
 * durable steps (services/task-runs.ts): every model call and every tool
 * call is recorded before and after it runs, so after a crash or restart
 * the same loop is replayed from stored results and only the first
 * incomplete step actually runs. Permissions are re-checked on every
 * attempt (the tools registry is built from the agent's current grants).
 *
 * R1: a run with a task contract is verified when the loop ends
 * (task-contracts.ts); a failed verdict starts another round in the same run
 * (bounded by the contract) where every completed step is replayed, so side
 * effects never repeat. Verdicts are stored per round. R2: every fresh
 * model call goes through the cost budget gate (cost-budget.ts).
 *
 * startTaskRunRecovery() runs once at boot and then on an interval: queued
 * runs (new, approval decided, owner resolved) and running runs whose lease
 * expired are claimed again (one worker per run via the atomic claim).
 */

import { one, sql } from '../repositories/sql-steps.js';
import { outsidePgTransaction } from '../db/pg/pool.js';
import { getOrchestrator } from '../multi-agent/index.js';
import { ClaudeClient } from '../llm/claude-client.js';
import { createAgentToolsRegistry } from '../tools/index.js';
import { approvalCategory } from '../tools/approvals.js';
import type { ToolResult } from '../tools/types.js';
import { UNKNOWN_PRINCIPAL } from '../tools/grants.js';
import { logActivity } from './activity-logger.js';
import { resolveProviderApiKey } from '../credentials/authority.js';
import { ollamaToolChat } from '../llm/ollama-tool-chat.js';
import { SMALL_AGENT_ID, smallAgentCard, smallAgentRunScope, smallAgentSystemPrompt } from './small-agent.js';
import { intersectGrants, staticGrants } from '../tools/grants.js';
import { toolMemoryDrawers } from '../tools/memory/scope.js';
import { CostBudgetError } from './cost-budget.js';
import { gatedModelCall } from '../llm/model-call.js';
import { contractRunDrawers, retryFeedback, verifyResult, type TaskContract } from './task-contracts.js';
import {
  BudgetExceededError,
  LeaseLostError,
  RunCancelledError,
  RunPausedError,
  WORKER_ID,
  claimRun,
  claimableRunIds,
  durableStep,
  finishAttempt,
  getRun,
  heartbeat,
  isIdempotentTool,
  getVerification,
  markRunNeedsReview,
  recordStepUsage,
  runContract,
  setRunVerification,
  storeVerification,
  successfulToolCalls,
  requeueDecidedApprovalRuns,
  runDefaults,
  runPrompt,
  setRecoveryKick,
  settleCancelledDeadRuns,
  reviewRun,
  type Lease,
  type ReviewDecision,
} from './task-runs.js';

export interface AgentRow {
  id: string;
  name: string;
  model: string;
  provider: string;
  system_prompt: string | null;
  temperature: number;
  max_tokens: number;
  cron_schedule: string;
  cron_enabled: number;
}

/** Model calls per attempt walk (unchanged from the previous cron loop). */
const MAX_ITERATIONS = 15;

/**
 * Agents a task was delegated from (S1.2), from server-recorded fields only:
 * the spawner of the task and of every parent task, plus the parent tasks'
 * assignees. A task in the chain without a spawner that was not created by
 * the owner through the API (origin 'owner') counts as delegated from an
 * unknown principal: the run gets at most the minimal default set.
 */
export function delegatingAgents(taskId: string): string[] {
  const orchestrator = getOrchestrator();
  const out = new Set<string>();
  let task: any = orchestrator.getTask(taskId);
  if (!task) return [UNKNOWN_PRINCIPAL];
  for (let depth = 0; task; depth++) {
    if (depth >= 16) { out.add(UNKNOWN_PRINCIPAL); break; }
    if (typeof task.spawnedBy === 'string' && task.spawnedBy) out.add(task.spawnedBy);
    else if (task.origin !== 'owner') out.add(UNKNOWN_PRINCIPAL);
    if (depth > 0 && typeof task.assignedTo === 'string' && task.assignedTo) out.add(task.assignedTo);
    if (!task.parentId) break;
    const parent = orchestrator.getTask(task.parentId);
    if (!parent) { out.add(UNKNOWN_PRINCIPAL); break; }
    task = parent;
  }
  return [...out];
}

export interface AttemptResult {
  status: 'completed' | 'failed' | 'cancelled' | 'waiting_approval' | 'not_claimed' | 'lease_lost';
  output?: string;
  reason?: string;
  /** R1: verdict of a run with a contract. */
  verification?: 'verified' | 'failed_verification' | 'needs_review';
}

interface StoredModelResponse {
  content: string;
  toolCalls?: Array<{ id: string; tool: string; arguments: Record<string, any> }>;
  rawBlocks?: any[];
  /** Ollama (small agent): the assistant message to append. */
  assistant?: any;
  /** Provider-reported token usage (R2). */
  usage?: { inputTokens: number; outputTokens: number };
}

type LoopMessage = { role: string; content: string | any[]; [k: string]: any };

/** How one provider's model is called and how its turns are appended. */
interface ModelDriver {
  /** Provider + model + output limit, for the cost budget gate (R2). */
  provider: string;
  model: string;
  maxTokens: number;
  /** What is sent besides the messages (system prompt, tools), for the input estimate. */
  overhead: unknown;
  call(messages: LoopMessage[]): Promise<StoredModelResponse>;
  assistantMessage(r: StoredModelResponse): LoopMessage;
  toolResultMessages(results: Array<{ id: string; tool: string; result: ToolResult; text: string }>): LoopMessage[];
}

function loadAgent(agentId: string): Promise<AgentRow | undefined> {
  return sql().read(one<AgentRow>(`
    SELECT id, name, model, provider, system_prompt, temperature, max_tokens, cron_schedule, cron_enabled
    FROM agents_config WHERE id = ?
  `, agentId));
}

async function hasToolSteps(runId: string): Promise<boolean> {
  return !!(await sql().read(one(`SELECT 1 AS ok FROM task_run_steps WHERE run_id = ? AND kind = 'tool' LIMIT 1`, runId)));
}

function approvalOutcome(a: { status: string; result_preview: string | null; error: string | null }): ToolResult {
  switch (a.status) {
    case 'executed':
      return { content: [{ type: 'text', text: `The owner approved this action and it ran once. Result: ${a.result_preview ?? '(no output)'}` }] };
    case 'failed':
      return { content: [{ type: 'text', text: `The owner approved this action but it failed: ${a.error ?? 'unknown error'}. Do not retry it on your own.` }], error: a.error ?? 'approved call failed' };
    case 'denied':
      return { content: [{ type: 'text', text: 'The owner denied this action; it was not run. Do not try it again.' }], error: 'denied by owner' };
    default:
      return { content: [{ type: 'text', text: 'The approval request expired; the action was not run.' }], error: 'approval expired' };
  }
}

function recreateIfRecurring(taskId: string, agentId: string): void {
  const orchestrator = getOrchestrator();
  const completedTask = orchestrator.getTask(taskId);
  const taskMeta = (completedTask?.input as any)?._meta as { repeat_schedule?: string } | undefined;
  if (!taskMeta?.repeat_schedule || !completedTask) return;
  try {
    // SECURITY (S1.2): never take the assignee from task input; keep the
    // original delegation origin on the copy.
    const assignToId = completedTask.assignedTo ?? agentId;
    // Preserve _meta but strip _upstream from input for the fresh run
    const { _upstream, ...cleanInput } = (completedTask.input as Record<string, unknown> | undefined) ?? {};
    const newTask = orchestrator.createTask({
      title: completedTask.title,
      description: completedTask.description,
      priority: completedTask.priority as any,
      inputData: Object.keys(cleanInput).length > 0 ? cleanInput : undefined,
      parentId: completedTask.parentId,
      spawnedBy: (completedTask as any).spawnedBy,
      origin: (completedTask as any).origin,
    });
    orchestrator.assignTask(newTask.id, assignToId);
    console.log(`[TaskRun] 🔄 Recurring task "${completedTask.title}" re-queued (schedule: ${taskMeta.repeat_schedule})`);
  } catch (err: any) {
    console.warn(`[TaskRun] ⚠️  Failed to re-queue recurring task: ${err.message}`);
  }
}

function claudeDriver(claude: ClaudeClient, agent: AgentRow, systemPrompt: string, tools: any[]): ModelDriver {
  return {
    provider: 'claude',
    model: agent.model,
    maxTokens: agent.max_tokens || 1024,
    overhead: { systemPrompt, tools },
    async call(messages) {
      const r = await claude.sendMessage(messages as any, {
        systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        temperature: agent.temperature,
        maxTokens: agent.max_tokens,
      });
      return { content: r.content, toolCalls: r.toolCalls, rawBlocks: r.rawBlocks, ...(r.usage ? { usage: r.usage } : {}) };
    },
    assistantMessage: (r) => ({ role: 'assistant', content: r.rawBlocks || r.content }),
    toolResultMessages: (results) => [{
      role: 'user',
      content: results.map(({ id, result, text }) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: result?.content ?? [{ type: 'text', text }],
        ...(result?.error ? { is_error: true } : {}),
      })),
    }],
  };
}

/** MCP-01: local Ollama model of the small agent (non-streaming, tools in function format). */
function ollamaDriver(agent: AgentRow, systemPrompt: string, tools: any[]): ModelDriver {
  return {
    provider: 'ollama',
    model: agent.model,
    maxTokens: agent.max_tokens || 1024,
    overhead: { systemPrompt, tools },
    async call(messages) {
      const r = await ollamaToolChat({
        model: agent.model,
        systemPrompt,
        messages: messages as any,
        tools,
        temperature: agent.temperature,
        maxTokens: agent.max_tokens,
      });
      return { content: r.content, toolCalls: r.toolCalls, assistant: r.assistant, ...(r.usage ? { usage: r.usage } : {}) };
    },
    assistantMessage: (r) => r.assistant ?? { role: 'assistant', content: r.content ?? '' },
    toolResultMessages: (results) => results.map(({ tool, result, text }) => ({
      role: 'tool',
      tool_name: tool,
      content: result?.error ? `Error: ${text}` : text,
    })),
  };
}

/**
 * R2: one model call of an autonomous run through the cost budget gate.
 * Paid providers: the worst case is reserved first (daily cap + the run's
 * cost limit); refused -> BudgetExceededError('cost'). The provider's usage
 * (or the estimate) is recorded on the step and the run. Replayed steps
 * never get here, so they cost nothing.
 */
async function gatedStepCall(driver: ModelDriver, messages: LoopMessage[], runId: string, stepIndex: number): Promise<StoredModelResponse> {
  const run = await getRun(runId);
  let gated;
  try {
    // R2.2: the shared gate of src/llm/model-call.ts (reserve -> call -> record / release).
    gated = await gatedModelCall({
      provider: driver.provider,
      model: driver.model,
      payload: { messages, overhead: driver.overhead },
      maxOutputTokens: driver.maxTokens,
      purpose: 'task_run',
      runId,
      stepIndex,
      runLimitCents: run?.max_cost_cents ?? null,
    }, () => driver.call(messages));
  } catch (err) {
    if (err instanceof CostBudgetError) throw new BudgetExceededError('cost', err.message);
    throw err;
  }
  const { response, used, ticket } = gated;
  try {
    await recordStepUsage(runId, stepIndex, { provider: ticket.provider, model: driver.model, inputTokens: used.inputTokens, outputTokens: used.outputTokens, costCents: used.costCents, source: used.source });
  } catch { /* usage bookkeeping must not fail the step */ }
  return response;
}

/**
 * Claim and execute (or resume) one run. Returns without doing anything
 * when another worker holds a live lease.
 */
export async function executeTaskRun(runId: string, owner: string = WORKER_ID): Promise<AttemptResult> {
  const lease = await claimRun(runId, owner);
  if (!lease) return { status: 'not_claimed' };

  let lost = false;
  // Fire-and-forget renewal: always on the pool, never inside a transaction
  // that happens to be open when the timer was created (B2.2b-3).
  const hb = setInterval(() => {
    outsidePgTransaction(() => heartbeat(lease)).then((ok) => { if (!ok) lost = true; }, () => { lost = true; });
  }, runDefaults().heartbeatMs);
  hb.unref?.();

  const run = (await getRun(runId))!;
  const taskId = run.task_id;
  const orchestrator = getOrchestrator();

  const fail = async (reason: string, agentId: string, noRetry = false): Promise<AttemptResult> => {
    if (!(await finishAttempt(lease, 'failed', reason))) return { status: 'lease_lost' };
    // A cost refusal would only be refused again: never auto-retry it.
    orchestrator.failTask(taskId, reason, { noRetry: noRetry || (await hasToolSteps(runId)) });
    await logActivity({ agentId, taskId, actionType: 'task_failed', summary: reason.slice(0, 200) });
    return { status: 'failed', reason, output: reason };
  };

  try {
    const agent = await loadAgent(run.agent_id);
    if (!agent) return await fail(`Agent "${run.agent_id}" no longer exists.`, run.agent_id);
    if (!orchestrator.getTask(taskId)) return await fail(`Task ${taskId} no longer exists.`, agent.id);

    const isSmall = agent.id === SMALL_AGENT_ID;
    // SECURITY (S1.2): the agent's current grants, intersected with every
    // agent this task was delegated from; re-checked on every attempt.
    const registry = await createAgentToolsRegistry({
      userId: agent.id,
      sessionId: `cron-${taskId}`,
      workspaceDir: process.cwd(),
      agentId: agent.id,
      taskId,
      delegatedFrom: delegatingAgents(taskId),
    });
    let driver: ModelDriver;
    let systemPrompt: string;
    let smallTemp: number | undefined;
    let claudeClient: ClaudeClient | undefined;
    if (isSmall) {
      // MCP-01: the small local agent. Tools = what the run was given at
      // spawn ∩ the agent's grants now (never wider); only the stored
      // drawers; memory of the owner who spawned it.
      const scope = await smallAgentRunScope(run, registry.getContext().grants!, registry.listRegistered());
      // MCP-01b: `read` only in the owner-chosen directory (or the agent's own
      // workspace); prompt, model and sampling are the built-in ones, never
      // the editable agents_config row.
      registry.updateContext({ grants: scope.grants, memoryDrawers: scope.memoryDrawers, userId: scope.userId ?? undefined, fileReadRoot: scope.fileReadRoot });
      systemPrompt = smallAgentSystemPrompt();
      smallTemp = scope.temperature;
      driver = ollamaDriver({ ...agent, model: scope.model, temperature: scope.temperature, max_tokens: scope.maxTokens }, systemPrompt, registry.getToolsForAPI());
    } else {
      // SECURITY (S1.1): key from the credential authority (agent's own key,
      // then the historical cron fallback row); never another agent's key.
      const apiKey = await resolveProviderApiKey('claude', { agentId: agent.id, noGlobal: true, legacySettingsRow: 'claude_api_key' });
      if (!apiKey || agent.provider !== 'claude') {
        const msg = `Agent "${agent.name}" has no Claude API key configured or provider is not claude.`;
        console.warn(`[TaskRun] ⚠️  ${msg}`);
        return await fail(msg, agent.id);
      }
      systemPrompt = (agent.system_prompt ?? `You are ${agent.name}, an AI agent.`) + await agentSkillsPrompt(agent.id);
      claudeClient = new ClaudeClient(apiKey, agent.model);
      driver = claudeDriver(claudeClient, agent, systemPrompt, registry.getToolsForAPI());
    }
    const prompt = await runPrompt(run);
    // R1: the contract pinned on the run narrows tools and drawers for this
    // attempt (never wider than the agent's grants now).
    const contract: TaskContract | null = await runContract(run);
    if (contract?.allowedTools) {
      registry.updateContext({ grants: intersectGrants(registry.getContext().grants!, staticGrants(contract.allowedTools)) });
    }
    if (contract?.allowedDrawers) {
      // SECURITY: intersect with the run's effective drawers (the stored
      // ones, or the audience default when none are set); never widen.
      registry.updateContext({ memoryDrawers: contractRunDrawers(contract, toolMemoryDrawers(registry.getContext())) });
    }
    if (contract?.allowedTools || contract?.allowedDrawers) {
      // Rebuild the driver so the model is only offered the narrowed tools.
      const tools = registry.getToolsForAPI();
      driver = isSmall
        ? ollamaDriver({ ...agent, model: driver.model, temperature: smallTemp!, max_tokens: driver.maxTokens }, systemPrompt, tools)
        : claudeDriver(claudeClient!, agent, systemPrompt, tools);
    }

    const loopMessages: LoopMessage[] = [{ role: 'user', content: prompt }];
    let stepIndex = 0;
    let finalContent = '';
    let finalResponse: StoredModelResponse | null = null;
    let round = 0;
    let verdict: { status: 'verified' | 'failed_verification' | 'needs_review'; reasons: string[] } | null = null;

    for (;;) {
      finalResponse = null;
      finalContent = '';
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (lost) throw new LeaseLostError();
        const { result: response } = await durableStep<StoredModelResponse>(lease, stepIndex++, {
          kind: 'model',
          name: 'model',
          input: { messages: loopMessages },
          idempotent: true, // no external side effect: safe to call again
          run: (_key, index) => gatedStepCall(driver, loopMessages, runId, index),
        });

        if (!response.toolCalls || response.toolCalls.length === 0) {
          finalContent = response.content ?? '';
          finalResponse = response;
          break;
        }
        loopMessages.push(driver.assistantMessage(response));

        const toolResults: Array<{ id: string; tool: string; result: ToolResult; text: string }> = [];
        for (const toolCall of response.toolCalls) {
          if (lost) throw new LeaseLostError();
          const tool = registry.get(toolCall.tool);
          const needsApproval = tool ? approvalCategory(tool) !== null : false;
          const { result, replayed } = await durableStep<ToolResult>(lease, stepIndex++, {
            kind: 'tool',
            name: toolCall.tool,
            input: toolCall.arguments ?? {},
            idempotent: isIdempotentTool(tool, needsApproval),
            run: async (key, index) => {
              registry.updateContext({ taskRun: { runId, stepIndex: index, idempotencyKey: key } });
              try {
                return await registry.execute(toolCall.tool, toolCall.arguments ?? {});
              } finally {
                registry.updateContext({ taskRun: undefined });
              }
            },
            pendingApprovalOf: (r) => (r?.details?.status === 'pending_approval' && typeof r.details.approvalId === 'string' ? r.details.approvalId : null),
            approvalOutcome,
          });
          const resultText = result?.content?.[0]?.text ?? JSON.stringify(result);
          toolResults.push({ id: toolCall.id, tool: toolCall.tool, result, text: resultText });
          if (!replayed) {
            await logActivity({
              agentId: agent.id, taskId, sessionId: `cron-${taskId}`,
              actionType: 'tool_called', toolName: toolCall.tool, summary: String(resultText).slice(0, 200),
            });
          }
        }
        loopMessages.push(...driver.toolResultMessages(toolResults));
      }

      if (!contract) break;
      // R1: deterministic verification of this round. A stored verdict (an
      // earlier attempt got this far) is replayed, never judged again.
      const stored = await getVerification(runId, round);
      const v = stored ?? await storeVerification(lease, round, verifyResult(contract, finalContent, {
        agentId: agent.id,
        toolCalls: await successfulToolCalls(runId),
      }), 'deterministic-checks/v1');
      verdict = { status: v.status, reasons: v.reasons };
      if (v.status !== 'failed_verification' || round >= contract.maxVerificationRetries) break;
      // Another round inside the same run: the model sees why and answers
      // again; every completed step before this point is replayed, not re-run.
      loopMessages.push(finalResponse ? driver.assistantMessage(finalResponse) : { role: 'assistant', content: finalContent || '(no answer)' });
      loopMessages.push({ role: 'user', content: retryFeedback(v.reasons, round, contract.maxVerificationRetries) });
      round++;
    }

    if (verdict) await setRunVerification(lease, verdict.status, verdict.reasons);
    // The run is recorded completed first (fenced): a crash after this point
    // never runs the task again.
    if (!(await finishAttempt(lease, 'completed', null, finalContent.slice(0, 500)))) return { status: 'lease_lost' };
    if (verdict?.status === 'failed_verification') {
      const reason = `verification failed: ${verdict.reasons.join('; ')}`.slice(0, 500);
      orchestrator.failTask(taskId, reason, { noRetry: true });
      await logActivity({ agentId: agent.id, taskId, actionType: 'task_failed', summary: reason.slice(0, 200) });
      try { await registry.execute('desktop_control', { action: 'hide_indicator' }); } catch { /* ignore */ }
      return { status: 'completed', output: finalContent, reason, verification: 'failed_verification' };
    }
    if (verdict?.status === 'needs_review') {
      // Held for the owner / a large agent: POST /api/task-runs/:id/review.
      orchestrator.holdTaskForReview(taskId, { output: finalContent });
      await logActivity({ agentId: agent.id, taskId, actionType: 'task_completed', summary: `Waiting for review: ${finalContent.slice(0, 180)}` });
      try { await registry.execute('desktop_control', { action: 'hide_indicator' }); } catch { /* ignore */ }
      return { status: 'completed', output: finalContent, verification: 'needs_review' };
    }
    orchestrator.completeTask(taskId, { output: finalContent });
    if (isSmall) {
      // MCP-01: important small-agent outputs are reviewed by a large agent.
      try {
        const card = await smallAgentCard(runId);
        if (card?.needs_review) await markRunNeedsReview(runId, card.review_reason ?? 'the small-agent card asks for a review');
      } catch { /* card unavailable: leave as is */ }
    }
    await logActivity({ agentId: agent.id, taskId, actionType: 'task_completed', summary: finalContent.slice(0, 200) });
    recreateIfRecurring(taskId, agent.id);
    try { await registry.execute('desktop_control', { action: 'hide_indicator' }); } catch { /* ignore */ }
    return { status: 'completed', output: finalContent, ...(verdict ? { verification: verdict.status } : {}) };
  } catch (err: any) {
    if (err instanceof LeaseLostError) {
      console.warn(`[TaskRun] ⚠️  Run ${runId}: lease lost; another worker owns it now`);
      return { status: 'lease_lost' };
    }
    if (err instanceof RunPausedError) {
      if (!(await finishAttempt(lease, 'waiting_approval', err.reason))) return { status: 'lease_lost' };
      await logActivity({ agentId: run.agent_id, taskId, actionType: 'task_started', summary: `Run waiting for the owner (${err.reason})` });
      return { status: 'waiting_approval', reason: err.reason };
    }
    if (err instanceof RunCancelledError) {
      if (!(await finishAttempt(lease, 'cancelled', 'cancelled'))) return { status: 'lease_lost' };
      orchestrator.failTask(taskId, 'cancelled', { cancelled: true });
      return { status: 'cancelled', reason: 'cancelled' };
    }
    if (err instanceof BudgetExceededError) {
      const res = await fail(err.message, run.agent_id, err.which === 'cost');
      return res.status === 'failed' ? { ...res, reason: err.message } : res;
    }
    const msg = `Run error: ${String(err?.message ?? err).slice(0, 300)}`;
    return await fail(msg, run.agent_id);
  } finally {
    clearInterval(hb);
  }
}

// ---------------------------------------------------------------------------
// R1: review of a needs_review result
// ---------------------------------------------------------------------------

/**
 * Apply a review decision. The run records it once; a task held in
 * 'review' is completed (accept: pipeline output + recurrence as usual) or
 * failed without retry (reject). A task that already completed (small-agent
 * runs keep their card output) only gets the decision recorded.
 */
export async function applyRunReview(runId: string, decision: ReviewDecision, by: string, reviewer: 'owner' | 'large_agent', note: string | null) {
  const run = await reviewRun(runId, decision, by, reviewer, note);
  const orchestrator = getOrchestrator();
  const task = orchestrator.getTask(run.task_id);
  if (task && task.status === 'review') {
    if (decision === 'accept') {
      orchestrator.completeTask(run.task_id, (task.output as Record<string, unknown> | undefined) ?? { output: run.output_preview ?? '' });
      recreateIfRecurring(run.task_id, run.agent_id);
    } else {
      orchestrator.failTask(run.task_id, `result rejected by review${note ? `: ${note}` : ''}`.slice(0, 500), { noRetry: true });
    }
  }
  await logActivity({ agentId: run.agent_id, taskId: run.task_id, actionType: decision === 'accept' ? 'task_completed' : 'task_failed', summary: `Review ${decision === 'accept' ? 'accepted' : 'rejected'} the result` });
  return run;
}

// ---------------------------------------------------------------------------
// Recovery loop
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();
let recoveryTimer: NodeJS.Timeout | null = null;
let scanning: Promise<number> | null = null;
let rescan = false;

/**
 * One recovery pass: settle cancelled dead runs, queue runs whose approval
 * was decided, then claim every claimable run. Returns how many attempts
 * this pass executed.
 */
export async function recoverTaskRuns(owner: string = WORKER_ID): Promise<number> {
  if (scanning) { rescan = true; return scanning; }
  scanning = (async () => {
    let n = 0;
    try {
      do {
        rescan = false;
        await settleCancelledDeadRuns();
        await requeueDecidedApprovalRuns();
        for (const id of await claimableRunIds()) {
          if (inFlight.has(id)) continue;
          inFlight.add(id);
          try {
            const res = await executeTaskRun(id, owner);
            if (res.status !== 'not_claimed') n++;
          } catch (err: any) {
            console.warn(`[TaskRun] ⚠️  Recovery of run ${id} failed: ${err?.message}`);
          } finally {
            inFlight.delete(id);
          }
        }
      } while (rescan);
    } finally {
      scanning = null;
    }
    return n;
  })();
  return scanning;
}

/** Start at boot: one pass now, then every lease period. */
export function startTaskRunRecovery(): void {
  if (recoveryTimer) return;
  const every = Math.max(1_000, runDefaults().leaseMs);
  const pass = () => { recoverTaskRuns().catch((err) => console.warn('[TaskRun] recovery pass failed:', err?.message)); };
  // Fire-and-forget: the kick may come from inside a caller's transaction
  // (an approval or owner decision); the pass always runs on the pool.
  setRecoveryKick(() => setImmediate(() => outsidePgTransaction(pass)));
  recoveryTimer = setInterval(pass, every);
  recoveryTimer.unref?.();
  pass();
  console.log(`[TaskRun] ✅ Durable task-run recovery started (every ${every} ms)`);
}

export function stopTaskRunRecovery(): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  setRecoveryKick(null);
}

export { type Lease };
