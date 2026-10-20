/**
 * memory_doctor / memory_doctor_fix tools (CORE-MEM-DOCTOR).
 *
 * memory_doctor   read-only health check of the memory the run can reach
 *                 (duplicates, expired items, missing/stale embeddings,
 *                 orphan versions, broken drawers, invalid topic keys);
 *                 ids and counts only, never memory text.
 * memory_doctor_fix  applies the safe fixes of a reviewed check. Every call
 *                 needs one-time owner approval (approvals.ts, 'delete'); the
 *                 approval is the explicit confirm, and the call carries the
 *                 reportHash of the check it fixes (a changed memory -> refused).
 *
 * Same owner gate for both (repositories/memory.ts doctorScope): only in the
 * owner's own turns, never when answering an outside sender, and only the
 * drawers open for the run.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryUser } from './scope.js';
import { repositories } from '../../repositories/index.js';
import { toolActor } from '../../repositories/actor.js';
import { ScopeError } from '../../repositories/scope.js';
import { DOCTOR_KINDS, DoctorError, type DoctorReport } from '../../memory/doctor.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Memory doctor refused: ${msg}` }], error: msg });

function summary(r: DoctorReport): string {
  const found = DOCTOR_KINDS.filter((k) => r.counts[k] > 0).map((k) => `${k}: ${r.counts[k]}`);
  return found.length
    ? `Memory check of ${r.total} memories found ${found.join(', ')}. reportHash ${r.reportHash}`
    : `Memory check of ${r.total} memories: no problems found.`;
}

export const memoryDoctorTool: Tool = {
  name: 'memory_doctor',
  description: `Check the health of the memory (read only): duplicate memories, expired items,
missing or outdated embeddings, orphan history, broken drawers, invalid topic keys.
Owner's own conversations only. Returns counts, memory ids and a reportHash; to repair,
call memory_doctor_fix with that reportHash (the owner approves the fix).`,
  input_schema: { type: 'object', properties: {} },
  async execute(_params, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!toolMemoryUser(context)) return fail('no user for this memory');
    if (context?.toolPolicy) return fail('not available when answering someone else');
    try {
      const report = await repositories.memory.doctorCheck(toolActor(context));
      return { content: [{ type: 'text', text: summary(report) }], data: { success: true, ...report } } as ToolResult;
    } catch (err) {
      if (err instanceof ScopeError) return fail(err.message);
      throw err;
    }
  },
};

export const memoryDoctorFixTool: Tool = {
  name: 'memory_doctor_fix',
  description: `Repair what memory_doctor reported, after the owner approves this call.
Give the reportHash of the check (run memory_doctor first) and optionally which kinds to
fix (${DOCTOR_KINDS.join(', ')}). Safe fixes only: extra duplicate copies and expired
items are deleted with their history kept, embeddings are refreshed, broken drawers and
topic keys are repaired. If the memory changed since the check, nothing is changed.`,
  input_schema: {
    type: 'object',
    properties: {
      report_hash: { type: 'string', description: 'reportHash from memory_doctor' },
      kinds: { type: 'array', items: { type: 'string', enum: [...DOCTOR_KINDS] }, description: 'Kinds to fix (default: all)' },
    },
    required: ['report_hash'],
  },
  async execute(params: { report_hash?: unknown; kinds?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!toolMemoryUser(context)) return fail('no user for this memory');
    if (context?.toolPolicy) return fail('not available when answering someone else');
    try {
      // The owner's approval of this call is the explicit confirm.
      const result = await repositories.memory.doctorFix(toolActor(context), { confirm: true, expectedReportHash: params.report_hash, kinds: params.kinds });
      const fixed = DOCTOR_KINDS.filter((k) => result.fixed[k] > 0).map((k) => `${k}: ${result.fixed[k]}`);
      return {
        content: [{ type: 'text', text: `Memory repaired (${fixed.join(', ') || 'nothing to fix'}). ${summary(result.report)}` }],
        data: { success: true, fixed: result.fixed, skipped: result.skipped, reportHash: result.report.reportHash },
      } as ToolResult;
    } catch (err) {
      if (err instanceof DoctorError || err instanceof ScopeError) return fail(err.message);
      throw err;
    }
  },
};
