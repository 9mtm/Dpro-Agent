/**
 * Scheduler/Cron System Types
 * Types for scheduled tasks and cron jobs
 */

/**
 * Cron job action types
 */
export type CronActionType =
  | 'execute-skill' // Execute a skill
  | 'send-message' // Send message to channel
  | 'api-call' // HTTP API call
  | 'run-workflow' // Execute workflow
  | 'evolve-agent' // Run one agent evolution cycle in-process (S0-A.4)
  | 'memory-job' // Owner-scoped memory job in-process: weekly summary, retention (CORE-05/07)
  | 'custom'; // Custom function

/**
 * Cron job configuration
 */
export interface CronJob {
  id: string;
  name: string;
  description?: string;

  // Cron expression (e.g., "0 9 * * *" for 9 AM daily)
  cronExpression: string;

  // Action to perform
  actionType: CronActionType;
  actionData: CronActionData;

  // Status
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Action-specific data
 */
export type CronActionData =
  | ExecuteSkillAction
  | SendMessageAction
  | ApiCallAction
  | RunWorkflowAction
  | CustomAction;

/**
 * Execute skill action
 */
export interface ExecuteSkillAction {
  skillId: string;
  context: {
    message: string;
    settings?: Record<string, any>;
  };
}

/**
 * Send message action
 */
export interface SendMessageAction {
  channelId: string;
  to: string;
  content: string;
  options?: any;
}

/**
 * API call action
 */
export interface ApiCallAction {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: any;
}

/**
 * Run workflow action
 */
export interface RunWorkflowAction {
  workflowId: string;
  context?: Record<string, any>;
}

/**
 * Custom action (function)
 */
export interface CustomAction {
  functionName: string;
  args?: any[];
}

/**
 * Job execution result
 */
export interface JobExecutionResult {
  jobId: string;
  success: boolean;
  output?: any;
  error?: string;
  executedAt: Date;
  duration: number; // in milliseconds
}

/**
 * Job execution history
 */
export interface JobExecutionHistory {
  id: string;
  jobId: string;
  success: boolean;
  output?: string;
  error?: string;
  executedAt: Date;
  duration: number;
}

/**
 * Cron Engine Interface
 */
export interface ICronEngine {
  /**
   * Start cron engine
   */
  start(): Promise<void>;

  /**
   * Stop cron engine
   */
  stop(): Promise<void>;

  /**
   * Schedule a job
   */
  scheduleJob(job: CronJob): void;

  /**
   * Unschedule a job
   */
  unscheduleJob(jobId: string): void;

  /**
   * Get all scheduled jobs
   */
  getJobs(): CronJob[];

  /**
   * Get job by ID
   */
  getJob(jobId: string): CronJob | undefined;

  /**
   * Execute job immediately (manual trigger)
   */
  executeJob(jobId: string, trigger?: 'manual' | 'scheduled'): Promise<JobExecutionResult>;
}

/**
 * Job Queue Interface
 */
export interface IJobQueue {
  /**
   * Add job to queue
   */
  enqueue(job: QueuedJob): void;

  /**
   * Process next job
   */
  processNext(): Promise<void>;

  /**
   * Get queue size
   */
  size(): number;

  /**
   * Clear queue
   */
  clear(): void;
}

/**
 * Queued job
 */
export interface QueuedJob {
  id: string;
  jobId: string;
  actionType: CronActionType;
  actionData: CronActionData;
  scheduledAt: Date;
  priority?: number; // Higher = more priority
}
