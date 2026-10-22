import {q} from '../../repositories/sql-steps.js';
import { safeConsole } from '../../services/safe-error-log.js';
/**
 * Scheduler API Routes
 * Manage cron jobs and scheduled tasks
 */

import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import { getCronEngine } from '../../scheduler/engine.js';
import { getJobQueue } from '../../scheduler/queue.js';
import { deleteJob, insertJob, jobHistory, setJobEnabled, updateJobDefinition } from '../../scheduler/store.js';
import type { CronJob, CronActionType, CronActionData } from '../../scheduler/types.js';
import { handleError } from '../error-handler.js';

async function responsibility(job:CronJob):Promise<string>{
 const data=job.actionData as unknown as Record<string,unknown>;
 if(job.actionType==='memory-job'&&typeof data.userId==='string'){
  const row=await q.one<{name:string}>('SELECT username AS name FROM users WHERE id=?',data.userId);
  return row?`Memory for ${row.name}`:'Workspace service';
 }
 if(job.actionType==='evolve-agent'&&typeof data.agentId==='string'){
  const row=await q.one<{name:string}>('SELECT name FROM agents_config WHERE id=?',data.agentId);
  return row?`Agent: ${row.name}`:'Workspace service';
 }
 return 'Workspace service';
}

export async function schedulerRoutes(fastify: FastifyInstance) {
  const cronEngine = getCronEngine();
  const jobQueue = getJobQueue();

  // GET /api/scheduler/jobs - List all cron jobs
  fastify.get('/api/scheduler/jobs', async (request, reply) => {
    try {
      const jobs = cronEngine.getJobs();

      return {
        success: true,
        jobs: await Promise.all(jobs.map(async (job) => ({
          id: job.id,
          name: job.name,
          description: job.description,
          cronExpression: job.cronExpression,
          actionType: job.actionType,
          responsibility: await responsibility(job),
          enabled: job.enabled,
          lastRun: job.lastRun,
          nextRun: job.nextRun,
        }))),
        stats: {
          total: jobs.length,
          enabled: jobs.filter((j) => j.enabled).length,
          disabled: jobs.filter((j) => !j.enabled).length,
        },
      };
    } catch (error: any) {
      console.error('[Scheduler API] ❌ List jobs failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Scheduler] List jobs failed');
    }
  });

  // GET /api/scheduler/jobs/:id - Get job details
  fastify.get<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const job = cronEngine.getJob(id);

        if (!job) {
          return reply.status(404).send({
            success: false,
            error: 'Job not found',
          });
        }

        return {
          success: true,
          job: {...job,responsibility:await responsibility(job)},
        };
      } catch (error: any) {
        console.error('[Scheduler API] ❌ Get job failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Scheduler] Get job failed');
      }
    }
  );

  // POST /api/scheduler/jobs - Create new cron job
  fastify.post<{
    Body: {
      name: string;
      description?: string;
      cronExpression: string;
      actionType: CronActionType;
      actionData: CronActionData;
      enabled?: boolean;
    };
  }>('/api/scheduler/jobs', async (request, reply) => {
    try {
      const { name, description, cronExpression, actionType, actionData, enabled } = request.body;

      // Validate cron expression
      if (!cron.validate(cronExpression)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid cron expression',
        });
      }

      const job: CronJob = {
        id: uuidv4(),
        name,
        description,
        cronExpression,
        actionType,
        actionData,
        enabled: enabled !== false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Save to database (B2.2c: process driver)
      await insertJob(job);

      // Schedule if enabled
      if (job.enabled) {
        cronEngine.scheduleJob(job);
      }

      return {
        success: true,
        job,
      };
    } catch (error: any) {
      safeConsole.error('[Scheduler API] ❌ Create job failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Scheduler] Create job failed');
    }
  });

  // PUT /api/scheduler/jobs/:id - Update cron job
  fastify.put<{
    Params: { id: string };
    Body: Partial<{
      name: string;
      description: string;
      cronExpression: string;
      actionType: CronActionType;
      actionData: CronActionData;
      enabled: boolean;
    }>;
  }>('/api/scheduler/jobs/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const updates = request.body;

      const job = cronEngine.getJob(id);

      if (!job) {
        return reply.status(404).send({
          success: false,
          error: 'Job not found',
        });
      }

      // Validate cron expression if provided
      if (updates.cronExpression && !cron.validate(updates.cronExpression)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid cron expression',
        });
      }

      // Update job
      const updatedJob = { ...job, ...updates, updatedAt: new Date() };

      // Update in database
      await updateJobDefinition(updatedJob);

      // Reschedule
      cronEngine.unscheduleJob(id);
      if (updatedJob.enabled) {
        cronEngine.scheduleJob(updatedJob);
      }

      return {
        success: true,
        job: updatedJob,
      };
    } catch (error: any) {
      safeConsole.error('[Scheduler API] ❌ Update job failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Scheduler] Update job failed');
    }
  });

  // DELETE /api/scheduler/jobs/:id - Delete cron job
  fastify.delete<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id',
    async (request, reply) => {
      try {
        const { id } = request.params;

        const job = cronEngine.getJob(id);

        if (!job) {
          return reply.status(404).send({
            success: false,
            error: 'Job not found',
          });
        }

        // Unschedule
        cronEngine.unscheduleJob(id);

        // Delete from database
        await deleteJob(id);

        return {
          success: true,
          message: `Job "${job.name}" deleted`,
        };
      } catch (error: any) {
        console.error('[Scheduler API] ❌ Delete job failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Scheduler] Delete job failed');
      }
    }
  );

  // POST /api/scheduler/jobs/:id/execute - Execute job manually
  // POST /api/scheduler/jobs/:id/run - Alias for execute
  const executeJobHandler = async (request: any, reply: any) => {
    try {
      const { id } = request.params;

      const result = await cronEngine.executeJob(id);

      return {
        success: result.success,
        output: result.output,
        error: result.error,
        duration: result.duration,
      };
    } catch (error: any) {
      safeConsole.error('[Scheduler API] ❌ Execute job failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Scheduler] Execute job failed');
    }
  };

  fastify.post<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id/execute',
    executeJobHandler
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id/run',
    executeJobHandler
  );

  // POST /api/scheduler/jobs/:id/enable - Enable job
  fastify.post<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id/enable',
    async (request, reply) => {
      try {
        const { id } = request.params;

        const job = cronEngine.getJob(id);

        if (!job) {
          return reply.status(404).send({
            success: false,
            error: 'Job not found',
          });
        }

        job.enabled = true;
        job.updatedAt = new Date();

        // Update database
        await setJobEnabled(id, true, job.updatedAt);

        // Schedule
        cronEngine.scheduleJob(job);

        return {
          success: true,
          message: `Job "${job.name}" enabled`,
        };
      } catch (error: any) {
        console.error('[Scheduler API] ❌ Enable job failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Scheduler] Enable job failed');
      }
    }
  );

  // POST /api/scheduler/jobs/:id/disable - Disable job
  fastify.post<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id/disable',
    async (request, reply) => {
      try {
        const { id } = request.params;

        const job = cronEngine.getJob(id);

        if (!job) {
          return reply.status(404).send({
            success: false,
            error: 'Job not found',
          });
        }

        job.enabled = false;
        job.updatedAt = new Date();

        // Update database
        await setJobEnabled(id, false, job.updatedAt);

        // Unschedule
        cronEngine.unscheduleJob(id);

        return {
          success: true,
          message: `Job "${job.name}" disabled`,
        };
      } catch (error: any) {
        console.error('[Scheduler API] ❌ Disable job failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Scheduler] Disable job failed');
      }
    }
  );

  // GET /api/scheduler/jobs/:id/history - Get job execution history
  fastify.get<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id/history',
    async (request, reply) => {
      try {
        const { id } = request.params;

        const history = await jobHistory(id, 100);

        return {
          success: true,
          history,
        };
      } catch (error: any) {
        console.error('[Scheduler API] ❌ Get history failed:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Scheduler] Get history failed');
      }
    }
  );

  // GET /api/scheduler/queue - Get job queue status
  fastify.get('/api/scheduler/queue', async (request, reply) => {
    try {
      const queue = jobQueue.getAll();

      return {
        success: true,
        queue: queue.map((job) => ({
          id: job.id,
          jobId: job.jobId,
          actionType: job.actionType,
          scheduledAt: job.scheduledAt,
          priority: job.priority,
        })),
        size: jobQueue.size(),
      };
    } catch (error: any) {
      console.error('[Scheduler API] ❌ Get queue failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Scheduler] Get queue failed');
    }
  });

  // POST /api/scheduler/queue/clear - Clear job queue
  fastify.post('/api/scheduler/queue/clear', async (request, reply) => {
    try {
      jobQueue.clear();

      return {
        success: true,
        message: 'Queue cleared',
      };
    } catch (error: any) {
      console.error('[Scheduler API] ❌ Clear queue failed:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Scheduler] Clear queue failed');
    }
  });

  console.log('[Scheduler API] ✅ Routes registered');
}
