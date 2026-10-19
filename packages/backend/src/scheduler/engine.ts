import { safeConsole } from '../services/safe-error-log.js';
/**
 * Cron Engine
 * Manages scheduled jobs using node-cron
 */

import { backgroundEnabled } from '../config/background.js';
import { isPaidProviderUrl } from '../llm/model-call.js';
import cron from 'node-cron';
import { EventEmitter } from 'events';
import type {
  CronJob,
  ICronEngine,
  JobExecutionResult,
  ExecuteSkillAction,
  SendMessageAction,
  ApiCallAction,
  RunWorkflowAction,
} from './types.js';
import { getJobQueue } from './queue.js';
import { claimRun, listEnabledJobs, recordRunTimes, saveExecution, tickSlot, type ExecutionRecord } from './store.js';

export class CronEngine extends EventEmitter implements ICronEngine {
  private jobs: Map<string, CronJob> = new Map();
  private tasks: Map<string, any> = new Map();
  private queue = getJobQueue();
  private isRunning = false;

  /**
   * Start cron engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[CronEngine] ⚠️  Already running');
      return;
    }

    console.log('[CronEngine] 🚀 Starting cron engine...');

    // Load jobs from database
    await this.loadJobs();

    // Schedule all enabled jobs
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }

    this.isRunning = true;
    console.log(`[CronEngine] ✅ Started with ${this.jobs.size} jobs`);
  }

  /**
   * Stop cron engine
   */
  async stop(): Promise<void> {
    console.log('[CronEngine] 🛑 Stopping cron engine...');

    // Stop all scheduled tasks
    for (const task of this.tasks.values()) {
      task.stop();
    }

    this.tasks.clear();
    this.isRunning = false;

    console.log('[CronEngine] ✅ Stopped');
  }

  /**
   * Schedule a job
   */
  scheduleJob(job: CronJob): void {
    if (!cron.validate(job.cronExpression)) {
      throw new Error(`Invalid cron expression: ${job.cronExpression}`);
    }

    // If already scheduled, unschedule first
    if (this.tasks.has(job.id)) {
      this.unscheduleJob(job.id);
    }

    // RUN-ISO F2: with AGENT_PLAYER_BACKGROUND=off the job is known but never runs.
    if (!backgroundEnabled()) {
      this.jobs.set(job.id, job);
      return;
    }

    // Create scheduled task
    const task = cron.schedule(
      job.cronExpression,
      async () => {
        // B2.2c: on PostgreSQL several processes fire the same tick; only the
        // one that claims its slot runs it (store.ts claimRun). SQLite: always.
        try {
          if (!(await claimRun(job.id, tickSlot(job.cronExpression)))) return;
        } catch (error: any) {
          safeConsole.error(`[CronEngine] ❌ Job "${job.name}" claim failed:`, error?.code ?? 'error');
          return;
        }

        safeConsole.log(`[CronEngine] ⏰ Executing job: ${job.name}`);

        try {
          const result = await this.executeJob(job.id);

          if (result.success) {
            safeConsole.log(`[CronEngine] ✅ Job "${job.name}" completed`);
          } else {
            safeConsole.error(`[CronEngine] ❌ Job "${job.name}" failed:`, result.error);
          }

          this.emit('job:executed', result);
        } catch (error: any) {
          safeConsole.error(`[CronEngine] ❌ Job "${job.name}" error:`, error);
          this.emit('job:error', { jobId: job.id, error: error.message });
        }

        // Update last run time
        job.lastRun = new Date();
        await this.updateJob(job);
      }
    );

    this.jobs.set(job.id, job);
    this.tasks.set(job.id, task);

    safeConsole.log(`[CronEngine] 📅 Scheduled job: ${job.name} (${job.cronExpression})`);
  }

  /**
   * Unschedule a job
   */
  unscheduleJob(jobId: string): void {
    const task = this.tasks.get(jobId);

    if (task) {
      task.stop();
      this.tasks.delete(jobId);
      safeConsole.log(`[CronEngine] ⏹️  Unscheduled job: ${jobId}`);
    }
  }

  /**
   * Get all scheduled jobs
   */
  getJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): CronJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Execute job immediately (manual trigger)
   */
  async executeJob(jobId: string): Promise<JobExecutionResult> {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const startTime = Date.now();

    try {
      let output: any;

      switch (job.actionType) {
        case 'execute-skill':
          output = await this.executeSkill(job.actionData as ExecuteSkillAction);
          break;

        case 'send-message':
          output = await this.sendMessage(job.actionData as SendMessageAction);
          break;

        case 'api-call':
          output = await this.executeApiCall(job.actionData as ApiCallAction);
          break;

        case 'run-workflow':
          output = await this.executeWorkflow(job.actionData as RunWorkflowAction);
          break;

        case 'evolve-agent':
          output = await this.executeEvolveAgent(job.actionData as any);
          break;

        case 'memory-job': {
          // CORE-05/07: in-process, owner-scoped, local only.
          const { runMemoryJob } = await import('../memory/jobs.js');
          output = await runMemoryJob(job.actionData as any);
          break;
        }

        case 'custom':
          output = await this.executeCustom(job.actionData as any);
          break;

        default:
          throw new Error(`Unknown action type: ${job.actionType}`);
      }

      const duration = Date.now() - startTime;

      // Save execution history
      await this.saveExecutionHistory({
        jobId: job.id,
        success: true,
        output: JSON.stringify(output),
        executedAt: new Date(),
        duration,
      });

      return {
        jobId: job.id,
        success: true,
        output,
        executedAt: new Date(),
        duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;

      // Save execution history
      await this.saveExecutionHistory({
        jobId: job.id,
        success: false,
        error: error.message,
        executedAt: new Date(),
        duration,
      });

      return {
        jobId: job.id,
        success: false,
        error: error.message,
        executedAt: new Date(),
        duration,
      };
    }
  }

  /**
   * Execute skill
   */
  private async executeSkill(action: ExecuteSkillAction): Promise<any> {
    const { getSkillsExecutor } = await import('../skills/executor.js');
    const executor = getSkillsExecutor();

    const result = await executor.execute(action.skillId, {
      message: action.context.message,
      settings: action.context.settings || {},
      userId: 'cron',
      channelId: 'cron',
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    return result.output;
  }

  /**
   * Send message
   */
  private async sendMessage(action: SendMessageAction): Promise<any> {
    const { getChannelRegistry } = await import('../channels/registry.js');
    const registry = getChannelRegistry();

    await registry.sendMessage(action.channelId, {
      channelId: action.channelId,
      to: action.to,
      content: action.content,
      options: action.options,
    });

    return { sent: true };
  }

  /**
   * Execute API call
   */
  private async executeApiCall(action: ApiCallAction): Promise<any> {
    // R2.2: a scheduled job runs without the owner present; it must not reach
    // a paid model provider around the cost budget gate (src/llm/model-call.ts).
    if (isPaidProviderUrl(String(action.url))) {
      throw new Error('scheduled api_call to a paid model provider is refused (background model calls go through the cost budget gate)');
    }
    const response = await fetch(action.url, {
      method: action.method,
      headers: action.headers || {},
      body: action.body ? JSON.stringify(action.body) : undefined,
    });

    return await response.json();
  }

  /**
   * Execute workflow
   */
  private async executeWorkflow(action: RunWorkflowAction): Promise<any> {
    // TODO: Integrate with workflow engine when implemented
    throw new Error('Workflow execution not yet implemented');
  }

  /**
   * Run one evolution cycle for an agent, in-process (S0-A.4). The auto-evolve
   * jobs used to POST to the backend's own /api/evolution route without any
   * credentials; with deny-by-default auth that call is refused, and a cron
   * job should not need an HTTP identity for server-internal work anyway.
   */
  private async executeEvolveAgent(action: { agentId?: unknown }): Promise<any> {
    const agentId = action?.agentId;
    if (typeof agentId !== 'string' || !agentId) {
      throw new Error('evolve-agent job is missing agentId');
    }
    // @ts-ignore -- plain JS module without type declarations
    const { evolveAgent } = await import('../services/agent-evolution-orchestrator.js');
    return await evolveAgent(agentId);
  }

  /**
   * Execute custom function
   */
  private async executeCustom(action: any): Promise<any> {
    // TODO: Implement custom function execution
    throw new Error('Custom function execution not yet implemented');
  }

  /**
   * Load jobs from database (B2.2c: on the process driver, store.ts)
   */
  private async loadJobs(): Promise<void> {
    for (const job of await listEnabledJobs()) {
      this.jobs.set(job.id, job);
    }
  }

  /**
   * Update job in database
   */
  private async updateJob(job: CronJob): Promise<void> {
    await recordRunTimes(job);
  }

  /**
   * Save execution history
   */
  private async saveExecutionHistory(history: ExecutionRecord): Promise<void> {
    await saveExecution(history);
  }
}

// Singleton instance
let engineInstance: CronEngine | null = null;

export function getCronEngine(): CronEngine {
  if (!engineInstance) {
    engineInstance = new CronEngine();
  }
  return engineInstance;
}
