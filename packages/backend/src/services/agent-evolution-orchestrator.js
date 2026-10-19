import { safeConsole } from './safe-error-log.js';
/**
 * Agent Evolution Orchestrator
 *
 * Turns learning insights into owner-approved proposals:
 * analyze → learn → propose → (owner approves) → measure.
 *
 * SECURITY (S0-Q.23, D-PERSONALITY): nothing here changes an agent directly.
 * System-prompt and PERSONALITY.md changes are filed as pending
 * evolution_proposals (services/evolution-proposals.ts); only the owner's
 * approval applies them. Evolution never enables or changes capabilities,
 * tool grants or permissions: capability ideas are returned as
 * `suggestedCapabilities` (informational, nothing is written).
 *
 * B2.2c: queries run on the process driver (repositories/sql-steps.ts);
 * the SQLite SQL and row shapes are unchanged (booleans compared as 1).
 */

import { all, one, run, sql } from '../repositories/sql-steps.js';
import { analyzeAgentPerformance } from './agent-performance-analyzer.js';
import { extractLearningInsights } from './agent-learning-engine.js';
import { proposeDriftFromOutcomes } from './personality-evolution.js';
import {
  createEvolutionProposal,
  rollbackEvolutionHistory,
  MAX_PROPOSED_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_REASON_CHARS,
} from './evolution-proposals.js';

/**
 * Run evolution cycle for an agent
 * @param {string} agentId - Agent ID to evolve
 * @returns {Promise<Object>} Evolution result
 */
export async function evolveAgent(agentId) {
  // Check if evolution is enabled for this agent
  const config = await sql().read(one('SELECT * FROM agent_evolution_config WHERE agent_id = ?', agentId));

  if (!config || !config.enabled) {
    return {
      agentId,
      skipped: true,
      reason: 'Evolution disabled for this agent',
    };
  }

  safeConsole.log(`[Evolution] Starting evolution cycle for agent: ${agentId}`);

  // CORE-01d: personality drift is proposal-only. Verified task-run outcomes
  // may file one pending proposal (system actor, source 'evolution'); the
  // owner approves or rejects it. Nothing here writes a personality version.
  const personalityProposal = await personalityDriftStep(agentId);
  const result = await runConfigEvolution(agentId, config);
  return { ...result, personalityProposal };
}

/** Never throws: a failed proposal must not break the evolution cycle. */
async function personalityDriftStep(agentId) {
  try {
    const outcome = await proposeDriftFromOutcomes(agentId);
    return outcome.status === 'proposed'
      ? { status: 'proposed', proposalId: outcome.proposal.id, delta: outcome.proposal.delta }
      : { status: 'skipped', reason: outcome.reason, ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}) };
  } catch (error) {
    safeConsole.error(`[Evolution] Personality proposal step failed for ${agentId}:`, error);
    return { status: 'error', error: String(error?.message ?? error).slice(0, 200) };
  }
}

async function runConfigEvolution(agentId, config) {
  try {
    // Step 1: Analyze performance
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (7 * 24 * 60 * 60 * 1000)); // Last 7 days

    const performanceData = await analyzeAgentPerformance(agentId, startDate, endDate);

    if (performanceData.sampleSize < config.min_sample_size) {
      return {
        agentId,
        skipped: true,
        reason: `Insufficient data (${performanceData.sampleSize} < ${config.min_sample_size} required)`,
      };
    }

    // Step 2: Extract learning insights
    const insights = await extractLearningInsights(agentId, performanceData);

    // Step 3: Filter insights by confidence threshold
    const actionableInsights = insights.filter(i => i.confidence >= config.min_confidence_threshold);

    if (actionableInsights.length === 0) {
      return {
        agentId,
        analyzed: true,
        insightsFound: insights.length,
        actionableInsights: 0,
        evolved: false,
        reason: 'No actionable insights met confidence threshold',
      };
    }

    // Step 4: capability ideas are informational only (never written).
    const suggestedCapabilities = actionableInsights
      .filter(i => i.type === 'new_capability')
      .map(capabilitySuggestion);

    // Step 5: file proposals (up to max_evolutions_per_cycle insights)
    const allowedEvolutions = parseAllowed(config.allowed_evolutions);
    const maxEvolutions = config.max_evolutions_per_cycle;

    const proposable = actionableInsights
      .filter(i => i.type !== 'new_capability' && canProposeInsight(i, allowedEvolutions))
      .slice(0, maxEvolutions);

    const baselinePerformance = captureBaselineMetric(performanceData);

    const proposals = [];
    for (const insight of proposable) {
      for (const draft of proposalDrafts(insight)) {
        try {
          const outcome = await createEvolutionProposal(agentId, draft);
          proposals.push(outcome.status === 'proposed'
            ? { status: 'proposed', proposalId: outcome.proposal.id, kind: draft.kind, title: draft.title }
            : { status: 'skipped', reason: outcome.reason, kind: draft.kind, title: draft.title, ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}) });
        } catch (error) {
          console.error(`[Evolution] Failed to file proposal:`, error);
          proposals.push({ status: 'error', kind: draft.kind, title: draft.title, error: String(error?.message ?? error).slice(0, 200) });
        }
      }
    }

    return {
      agentId,
      analyzed: true,
      insightsFound: insights.length,
      actionableInsights: actionableInsights.length,
      // Nothing is applied by a cycle; the owner decides each proposal.
      evolved: false,
      proposed: proposals.filter(p => p.status === 'proposed').length,
      proposals,
      suggestedCapabilities,
      baselinePerformance,
      sampleSize: performanceData.sampleSize,
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
    };
  } catch (error) {
    safeConsole.error(`[Evolution] Error evolving agent ${agentId}:`, error);
    return {
      agentId,
      error: error.message,
    };
  }
}

/** Prompt-type insights may be proposed when 'prompt_update' is allowed. */
function canProposeInsight(insight, allowedEvolutions) {
  const proposable = ['success_pattern', 'failure_pattern', 'optimization'];
  return proposable.includes(insight.type) && allowedEvolutions.includes('prompt_update');
}

function parseAllowed(json) {
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The two proposals for one insight: the system-prompt addition and the
 * PERSONALITY.md note (same wording as the old direct writes). Text is data:
 * it is stored and, on approval, appended; never executed.
 */
function proposalDrafts(insight) {
  const title = clip(insight.title || 'Evolution insight', MAX_TITLE_CHARS);
  const description = clip(insight.description || '', 3000);
  const reason = clip(`${insight.type}: ${insight.title || ''}`.trim(), MAX_REASON_CHARS);
  const confidence = typeof insight.confidence === 'number' ? insight.confidence : null;
  const pct = confidence === null ? '' : `\n\nConfidence: ${(confidence * 100).toFixed(0)}%\n`;
  const day = new Date().toISOString().slice(0, 10);

  let prompt;
  let personality;
  if (insight.type === 'success_pattern') {
    prompt = `\n\n## Learned Success Pattern\n${description}\n\nWhen applicable, prioritize approaches similar to this successful pattern.`;
    personality = `\n## Success Pattern (Learned ${day})\n\n**${title}**\n\n${description}${pct}`;
  } else if (insight.type === 'failure_pattern') {
    prompt = `\n\n## Known Failure Pattern (Avoid)\n${description}\n\nBe cautious and implement robust error handling when encountering similar situations.`;
    personality = `\n## Failure Pattern (Learned ${day})\n\n**${title}**\n\n${description}${pct}`;
  } else {
    prompt = `\n\n## Performance Optimization\n${description}`;
    personality = `\n## Optimization (Proposed ${day})\n\n**${title}**\n\n${description}${pct}`;
  }
  const common = { title, reason, insightType: insight.type, confidence };
  return [
    { ...common, kind: 'prompt_append', proposedText: clip(prompt, MAX_PROPOSED_TEXT_CHARS) },
    { ...common, kind: 'personality_text', proposedText: clip(personality, MAX_PROPOSED_TEXT_CHARS) },
  ];
}

/** Informational capability idea from a new_capability insight (never applied). */
function capabilitySuggestion(insight) {
  return {
    capability: suggestedCapabilityName(insight),
    title: clip(insight.title || '', MAX_TITLE_CHARS),
    description: clip(insight.description || '', 1000),
    confidence: typeof insight.confidence === 'number' ? insight.confidence : null,
    applied: false,
  };
}

/**
 * Capture baseline performance metric
 */
function captureBaselineMetric(performanceData) {
  // Use composite score: task success rate (50%) + tool efficiency (30%) + error rate inverted (20%)
  const metrics = performanceData.metrics;

  const taskSuccess = metrics.taskSuccessRate?.rate || 0;
  const toolEff = metrics.toolEfficiency?.overall || 0;
  const errorPenalty = 1 - (metrics.errorRate?.rate || 0);

  const composite = (taskSuccess * 0.5) + (toolEff * 0.3) + (errorPenalty * 0.2);

  return {
    composite,
    taskSuccessRate: taskSuccess,
    toolEfficiency: toolEff,
    errorRate: metrics.errorRate?.rate || 0,
  };
}

/** Capability name an insight talks about (for the informational note only). */
function suggestedCapabilityName(insight) {
  const title = String(insight.title || '').toLowerCase();

  if (title.includes('file')) return 'fileOperations';
  if (title.includes('search')) return 'webSearch';
  if (title.includes('memory')) return 'memory';
  if (title.includes('command')) return 'executeCommands';

  return null;
}

/**
 * Measure evolution impact (should be run after some time has passed)
 * @param {string} evolutionId - Evolution history ID
 * @returns {Promise<Object>}
 */
export async function measureEvolutionImpact(evolutionId) {
  const evolution = await sql().read(one('SELECT * FROM agent_evolution_history WHERE id = ?', evolutionId));

  if (!evolution) {
    throw new Error(`Evolution ${evolutionId} not found`);
  }

  // Analyze performance after evolution
  const endDate = new Date();
  const startDate = new Date(evolution.created_at);

  const performanceData = await analyzeAgentPerformance(evolution.agent_id, startDate, endDate);

  if (performanceData.sampleSize < 10) {
    return {
      evolutionId,
      measured: false,
      reason: 'Insufficient data after evolution (need at least 10 activities)',
    };
  }

  const currentPerformance = captureBaselineMetric(performanceData);

  // Compare with baseline
  const config = await sql().read(one('SELECT * FROM agent_evolution_config WHERE agent_id = ?', evolution.agent_id));

  const performanceDelta = currentPerformance.composite - (evolution.performance_before || 0);

  // Check if performance degraded
  if (config?.rollback_on_degradation && performanceDelta < -config.degradation_threshold) {
    // Rollback (prompt / PERSONALITY.md rows only, and only while the content
    // is still exactly what that evolution wrote; see rollbackEvolutionHistory).
    let rolledBack = false;
    let rollbackError;
    try {
      await rollbackEvolutionHistory(evolution.agent_id, evolutionId);
      rolledBack = true;
    } catch (error) {
      rollbackError = error?.code || 'rollback_failed';
    }

    return {
      evolutionId,
      measured: true,
      performanceDelta,
      degraded: true,
      rolledBack,
      ...(rollbackError ? { rollbackError } : {}),
      before: evolution.performance_before,
      after: currentPerformance.composite,
    };
  }

  // Update evolution history with performance data
  await sql().read(run(`
    UPDATE agent_evolution_history
    SET performance_before = ?, performance_after = ?
    WHERE id = ?
  `, evolution.performance_before || currentPerformance.composite, currentPerformance.composite, evolutionId));

  return {
    evolutionId,
    measured: true,
    performanceDelta,
    degraded: false,
    before: evolution.performance_before,
    after: currentPerformance.composite,
    improvement: performanceDelta > 0,
  };
}

/**
 * Get evolution history for an agent
 * @param {string} agentId
 * @param {Object} filters - {status, type, limit}
 * @returns {Promise<Array>}
 */
export async function getEvolutionHistory(agentId, filters = {}) {
  let query = 'SELECT * FROM agent_evolution_history WHERE agent_id = ?';
  const params = [agentId];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters.type) {
    query += ' AND evolution_type = ?';
    params.push(filters.type);
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  const history = await sql().read(all(query, ...params));

  return history.map(h => ({
    ...h,
    insight_ids: h.insight_ids ? JSON.parse(h.insight_ids) : [],
  }));
}

/**
 * Evolve all agents (batch evolution)
 * @returns {Promise<Array>}
 */
export async function evolveAllAgents() {
  // Get all agents with evolution enabled (an integer 0/1 column on both drivers)
  const configs = await sql().read(all(`
    SELECT agent_id FROM agent_evolution_config WHERE enabled = 1
  `));

  const results = [];
  for (const config of configs) {
    try {
      const result = await evolveAgent(config.agent_id);
      results.push(result);
    } catch (error) {
      console.error(`[Evolution] Failed to evolve agent ${config.agent_id}:`, error);
      results.push({
        agentId: config.agent_id,
        error: error.message,
      });
    }
  }

  return results;
}
