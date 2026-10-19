import { safeConsole } from './safe-error-log.js';
/**
 * Agent Evolution Scheduler
 *
 * Integrates agent evolution system with the scheduler
 * Creates and manages cron jobs for automatic evolution cycles
 *
 * B2.2c: cron_jobs is written only through scheduler/store.ts (one
 * transaction under the job-name lock, so two processes never create the
 * same agent's job twice); the other reads run on the process driver.
 */

import { all, one, sql } from '../repositories/sql-steps.js';
import { getCronEngine } from '../scheduler/engine.js';
import { deleteJobByName, getJobByName, upsertNamedJob } from '../scheduler/store.js';
import { v4 as uuidv4 } from 'uuid';

// SECURITY (S0-A.4): auto-evolve jobs run the evolution service in-process
// ('evolve-agent' action) instead of an unauthenticated HTTP call to the
// backend's own /api/evolution route.
export const EVOLVE_ACTION_TYPE = 'evolve-agent';
export function evolveActionData(agentId) {
  return { agentId };
}

/**
 * Initialize evolution scheduler for all agents with enabled evolution
 */
export async function initializeEvolutionScheduler() {
  console.log('[Evolution Scheduler] 🔄 Initializing agent evolution schedules...');

  // Get all agents with evolution enabled (an integer 0/1 column on both drivers)
  const configs = await sql().read(all(`
    SELECT agent_id, evolution_frequency FROM agent_evolution_config
    WHERE enabled = 1
  `));

  let scheduled = 0;
  for (const config of configs) {
    try {
      await scheduleAgentEvolution(config.agent_id, config.evolution_frequency);
      scheduled++;
    } catch (error) {
      console.error(`[Evolution Scheduler] Failed to schedule agent ${config.agent_id}:`, error.message);
    }
  }

  console.log(`[Evolution Scheduler] ✅ Scheduled evolution for ${scheduled}/${configs.length} agents\n`);
}

/**
 * Schedule evolution for a specific agent
 * @param {string} agentId - Agent ID
 * @param {string} frequency - Evolution frequency ('hourly', 'daily', 'weekly')
 */
export async function scheduleAgentEvolution(agentId, frequency = 'daily') {
  const cronEngine = getCronEngine();

  // Get agent name
  const agent = await sql().read(one('SELECT name FROM agents_config WHERE id = ?', agentId));

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  // Convert frequency to cron expression
  const cronExpression = frequencyToCron(frequency);

  // Create unique job name
  const jobName = `agent-evolution-${agentId}`;

  // Insert, or update the existing job (this also rewrites old rows that
  // still use the HTTP 'api-call' form, S0-A.4).
  const { job, created } = await upsertNamedJob(uuidv4(), {
    name: jobName,
    description: `Auto-evolve agent: ${agent.name}`,
    cronExpression,
    actionType: EVOLVE_ACTION_TYPE,
    actionData: evolveActionData(agentId),
  });

  if (!created) cronEngine.unscheduleJob(job.id);
  cronEngine.scheduleJob({
    id: job.id,
    name: job.name,
    description: job.description,
    cronExpression: job.cronExpression,
    actionType: job.actionType,
    actionData: job.actionData,
    enabled: job.enabled,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });

  console.log(created
    ? `[Evolution Scheduler] ✅ Scheduled evolution for agent "${agent.name}" (${frequency})`
    : `[Evolution Scheduler] 🔄 Updated schedule for agent "${agent.name}" (${frequency})`);
}

/**
 * Unschedule evolution for an agent
 * @param {string} agentId - Agent ID
 */
export async function unscheduleAgentEvolution(agentId) {
  const cronEngine = getCronEngine();

  const jobName = `agent-evolution-${agentId}`;

  const jobId = await deleteJobByName(jobName);

  if (jobId) {
    cronEngine.unscheduleJob(jobId);

    safeConsole.log(`[Evolution Scheduler] ⏹️  Unscheduled evolution for agent ${agentId}`);
  }
}

/**
 * Update evolution schedule for an agent
 * @param {string} agentId - Agent ID
 * @param {boolean} enabled - Whether evolution is enabled
 * @param {string} frequency - Evolution frequency
 */
export async function updateEvolutionSchedule(agentId, enabled, frequency) {
  if (enabled) {
    await scheduleAgentEvolution(agentId, frequency);
  } else {
    await unscheduleAgentEvolution(agentId);
  }
}

/**
 * Convert frequency string to cron expression
 * @param {string} frequency - 'hourly', 'daily', 'weekly', 'manual'
 * @returns {string} Cron expression
 */
function frequencyToCron(frequency) {
  switch (frequency) {
    case 'hourly':
      return '0 * * * *'; // Every hour at minute 0
    case 'daily':
      return '0 3 * * *'; // Every day at 3 AM (low traffic time)
    case 'weekly':
      return '0 3 * * 0'; // Every Sunday at 3 AM
    case 'manual':
      return '0 0 31 2 *'; // Never runs (Feb 31 doesn't exist) - manual only
    default:
      return '0 3 * * *'; // Default: daily at 3 AM
  }
}

/**
 * Get evolution schedule status for an agent
 * @param {string} agentId - Agent ID
 * @returns {Promise<Object|null>} Schedule info or null
 */
export async function getEvolutionSchedule(agentId) {
  const jobName = `agent-evolution-${agentId}`;

  const job = await getJobByName(jobName);

  if (!job) return null;

  return {
    jobId: job.id,
    agentId,
    frequency: cronToFrequency(job.cronExpression),
    cronExpression: job.cronExpression,
    enabled: job.enabled,
    lastRun: job.lastRun ?? null,
    nextRun: job.nextRun ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Convert cron expression back to frequency string
 * @param {string} cronExpression - Cron expression
 * @returns {string} Frequency
 */
function cronToFrequency(cronExpression) {
  const cronMap = {
    '0 * * * *': 'hourly',
    '0 3 * * *': 'daily',
    '0 3 * * 0': 'weekly',
    '0 0 31 2 *': 'manual',
  };

  return cronMap[cronExpression] || 'custom';
}
