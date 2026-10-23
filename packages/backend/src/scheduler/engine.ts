import { safeConsole } from '../services/safe-error-log.js';
/**
 * Cron Engine
 * Manages scheduled jobs using node-cron
 */

import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {rowToJob,type CronJobRow} from './store.js';
import {resolvePaperScheduleExecutionInTransaction,type PaperScheduleExecutionFence} from './paper-execution-admission.js';
import {assertScheduledDispatchInTransaction} from './authorization.js';
import {dispatchRegisteredScheduledPaperRuntime} from '../services/trading-paper-runtime-dispatch.js';
import { assertScheduledDispatch } from './authorization.js';
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
import { claimRun, listEnabledJobs, recordRunTimes, saveExecution, tickSlot, type ExecutionRecord } from './store.js';

export type PaperCronStatus=Readonly<{jobId:string;registered:boolean;phase:'unavailable'|'waiting'|'refused'|'pending'|'unknown'|'completed'|'failed'|'stopped';callbackAt:number|null;attemptId:string|null;replayed:boolean|null;historyRecorded:boolean}>;
type PaperOwnerRegistrationConstraint=Readonly<{ownerId:string;consentId:string;jobRevision:number;authorizationRevision:number;definitionHash:string}>;
function ownerRegistrationConstraint(value:unknown):PaperOwnerRegistrationConstraint{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Paper registration unavailable');
 const fields=['ownerId','consentId','jobRevision','authorizationRevision','definitionHash'],keys=Reflect.ownKeys(value);
 if(keys.length!==fields.length||keys.some(k=>typeof k!=='string'||!fields.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value')))throw Error('Paper registration unavailable');
 const v=value as Record<string,unknown>;
 if(typeof v.ownerId!=='string'||!v.ownerId||v.ownerId.length>128||/[\x00-\x20\x7f]/.test(v.ownerId)||typeof v.consentId!=='string'||v.consentId.length!==36||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.consentId)||typeof v.definitionHash!=='string'||v.definitionHash.length!==64||!/^[a-f0-9]{64}$/.test(v.definitionHash)||!Number.isSafeInteger(v.jobRevision)||Number(v.jobRevision)<1||!Number.isSafeInteger(v.authorizationRevision)||Number(v.authorizationRevision)<1)throw Error('Paper registration unavailable');
 return Object.freeze({...v}) as PaperOwnerRegistrationConstraint;
}
type PaperRegistration={generation:number;epoch:number;timeZone:string;fence:PaperScheduleExecutionFence};

export class CronEngine extends EventEmitter implements ICronEngine {
  private jobs: Map<string, CronJob> = new Map();
  private tasks: Map<string, any> = new Map();
  private readonly timerTokens=new Map<string,object>();
  private isRunning = false;

  readonly #paperLedger: Database.Database|null;
  readonly #paperOnly:boolean;
  private epoch=0;
  private generation=0;
  private readonly paperRegistrations=new Map<string,PaperRegistration>();
  private readonly paperStatuses=new Map<string,PaperCronStatus>();

  /** An explicit instance dependency; the default singleton remains disconnected. */
  constructor(paperLedger:Database.Database|null=null,mode:'all'|'paper-only'='all'){super();if(mode!=='all'&&mode!=='paper-only')throw Error('Invalid cron mode');this.#paperLedger=paperLedger;this.#paperOnly=mode==='paper-only';}

  /** Registration is physical timer state; waiting is not an execution-readiness or heartbeat claim. */
  getPaperStatus(jobId:string):PaperCronStatus|undefined{
    const status=this.paperStatuses.get(jobId),registration=this.paperRegistrations.get(jobId);
    if(status?.registered&&registration&&!this.paperCurrent(jobId,registration))return Object.freeze({...status,phase:'unavailable'});
    return status;
  }

  private paperAvailable():boolean{
    try{return this.#paperLedger!==null&&this.#paperLedger.open&&dbDriver()==='sqlite'&&getDatabase().getDb()===this.#paperLedger&&backgroundEnabled();}catch{return false;}
  }

  private paperCurrent(jobId:string,registration:PaperRegistration):boolean{
    return this.isRunning&&this.epoch===registration.epoch&&this.paperRegistrations.get(jobId)===registration&&this.paperAvailable()&&Intl.DateTimeFormat().resolvedOptions().timeZone===registration.timeZone;
  }

  private registerPaper(job:CronJob,expected?:PaperOwnerRegistrationConstraint,replace=false):boolean{
    this.jobs.set(job.id,job);
    if(!this.tasks.has(job.id))this.paperStatuses.set(job.id,Object.freeze({jobId:job.id,registered:false,phase:'unavailable',callbackAt:null,attemptId:null,replayed:null,historyRecorded:false}));
    if(!this.isRunning||!job.enabled||!this.paperAvailable())return false;
    const db=this.#paperLedger!;
    try{
      const captured=db.transaction(()=>{
        const row=db.prepare('SELECT * FROM main.cron_jobs WHERE id=?').get(job.id) as CronJobRow|undefined;
        if(!row||row.action_type!=='paper-runtime-cycle')throw Error('unavailable');
        const persisted=rowToJob('sqlite',row),now=Date.now();
        const admission=assertScheduledDispatchInTransaction(db,persisted,'scheduled',now);
        const fence=resolvePaperScheduleExecutionInTransaction(db,{jobId:job.id,trigger:'scheduled'},now);
        if(expected&&Object.keys(expected).some(k=>fence[k as keyof PaperOwnerRegistrationConstraint]!==expected[k as keyof PaperOwnerRegistrationConstraint]))throw Error('Paper registration changed');
        return {persisted,fence,timeZone:admission.definition.timeZone};
      }).deferred();
      if(replace)this.unscheduleJob(job.id);
      const registration:PaperRegistration=Object.freeze({generation:++this.generation,epoch:this.epoch,timeZone:captured.timeZone,fence:captured.fence});
      this.paperRegistrations.set(job.id,registration);
      const task=cron.schedule(captured.persisted.cronExpression,()=>{
        if(!this.paperCurrent(job.id,registration))return;
        return this.executePaper(job.id,'scheduled',registration);
      },{timezone:registration.timeZone});
      this.tasks.set(job.id,task);
      this.jobs.set(job.id,captured.persisted);
      this.paperStatuses.set(job.id,Object.freeze({jobId:job.id,registered:true,phase:'waiting',callbackAt:null,attemptId:null,replayed:null,historyRecorded:false}));
      return true;
    }catch{
      if(!this.tasks.has(job.id))this.paperRegistrations.delete(job.id);
      return false;
    }
  }

  /** Expected control result is a comparison constraint, never authority to adopt a newer grant. */
  registerOwnedPaperJob(jobId:string,value:unknown):boolean{
    try{
      const expected=ownerRegistrationConstraint(value);
      if(!this.#paperOnly||typeof jobId!=='string'||jobId.length!==36||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(jobId)||!this.isRunning||!this.paperAvailable())return false;
      const row=this.#paperLedger!.prepare('SELECT * FROM main.cron_jobs WHERE id=?').get(jobId) as CronJobRow|undefined;
      if(!row||row.action_type!=='paper-runtime-cycle')return false;
      if(!this.registerPaper(rowToJob('sqlite',row),expected,true))return false;
      const current=this.paperRegistrations.get(jobId);
      return !!current&&Object.keys(expected).every(k=>current.fence[k as keyof PaperOwnerRegistrationConstraint]===expected[k as keyof PaperOwnerRegistrationConstraint])&&this.paperCurrent(jobId,current);
    }catch{return false;}
  }

  getPaperRegistration(jobId:string){
    const fence=this.paperRegistrations.get(jobId)?.fence;
    return fence?Object.freeze({ownerId:fence.ownerId,consentId:fence.consentId,jobRevision:fence.jobRevision,authorizationRevision:fence.authorizationRevision,definitionHash:fence.definitionHash}):null;
  }

  private executePaper(jobId:string,trigger:'manual'|'scheduled',registration:PaperRegistration|undefined):JobExecutionResult{
    const startTime=Date.now();
    if(!registration||!this.paperCurrent(jobId,registration))return {jobId,success:false,error:'Paper cron unavailable',executedAt:new Date(),duration:0};
    const fence=Object.freeze({...registration.fence,trigger});
    const output=dispatchRegisteredScheduledPaperRuntime(this.#paperLedger!,{jobId,trigger},fence);
    const phase=output.ok?output.status:'refused',success=output.ok&&output.status==='completed';
    let historyRecorded=false;
    // This summary is the actual dispatch acknowledgement, never an enabled flag or a fill estimate.
    try{
      this.#paperLedger!.prepare('INSERT INTO main.job_executions(job_id,success,output,error,executed_at,duration) VALUES(?,?,?,?,?,?)').run(jobId,success?1:0,JSON.stringify(output),success?null:'Paper cron '+phase,new Date(startTime).toISOString(),Math.max(0,Date.now()-startTime));
      historyRecorded=true;
    }catch{/* A failed history write cannot undo or misrepresent an already committed paper attempt. */}
    if(this.paperCurrent(jobId,registration))this.paperStatuses.set(jobId,Object.freeze({jobId,registered:true,phase,callbackAt:startTime,attemptId:output.ok?output.attemptId:null,replayed:output.ok?output.replayed:null,historyRecorded}));
    const result={jobId,success,output,executedAt:new Date(startTime),duration:Math.max(0,Date.now()-startTime),...(success?{}:{error:'Paper cron '+phase})};
    this.emit('job:executed',result);
    return result;
  }

  /**
   * Start cron engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[CronEngine] ⚠️  Already running');
      return;
    }

    console.log('[CronEngine] 🚀 Starting cron engine...');

    const epoch=++this.epoch;
    // Load jobs from database
    await this.loadJobs();
    if(epoch!==this.epoch)return;
    this.isRunning=true;

    // Schedule all enabled jobs
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }

    this.isRunning = true;
    console.log(`[CronEngine] ✅ Started with ${this.jobs.size} jobs`);
  }

  /** True between start() and stop(). */
  isStarted(): boolean {
    return this.isRunning;
  }

  /**
   * Stop cron engine
   */
  async stop(): Promise<void> {
    console.log('[CronEngine] 🛑 Stopping cron engine...');

    // Invalidate retained callbacks before stopping any owned timers.
    ++this.epoch;
    this.isRunning=false;
    this.paperRegistrations.clear();
    this.timerTokens.clear();
    for(const [id,status] of this.paperStatuses)this.paperStatuses.set(id,Object.freeze({...status,registered:false,phase:'stopped'}));
    // Stop all scheduled tasks
    for (const task of this.tasks.values()) {
      task.stop();
      task.destroy?.();
    }

    this.tasks.clear();
    this.isRunning = false;

    console.log('[CronEngine] ✅ Stopped');
  }

  /**
   * Schedule a job
   */
  scheduleJob(job: CronJob): void {
    if(this.#paperOnly&&job.actionType!=='paper-runtime-cycle')return;
    if (!cron.validate(job.cronExpression)) {
      throw new Error(`Invalid cron expression: ${job.cronExpression}`);
    }

    // If already scheduled, unschedule first
    if (this.tasks.has(job.id)) {
      this.unscheduleJob(job.id);
    }

    // RUN-ISO F2: with AGENT_PLAYER_BACKGROUND=off the job is known but never runs.
    if(job.actionType==='paper-runtime-cycle'){this.registerPaper(job);return;}
    if (!backgroundEnabled()) {
      this.jobs.set(job.id, job);
      return;
    }

    // Identity also prevents a retained generic closure from adopting a later paper job at this ID.
    const token=Object.freeze({}),epoch=this.epoch;
    this.timerTokens.set(job.id,token);
    const current=()=>this.epoch===epoch&&this.timerTokens.get(job.id)===token&&this.jobs.get(job.id)?.actionType!=='paper-runtime-cycle';
    // Create scheduled task
    const task = cron.schedule(
      job.cronExpression,
      async () => {
        if(!current())return;
        // B2.2c: on PostgreSQL several processes fire the same tick; only the
        // one that claims its slot runs it (store.ts claimRun). SQLite: always.
        try {
          if (!(await claimRun(job.id, tickSlot(job.cronExpression)))) return;
        } catch (error: any) {
          safeConsole.error(`[CronEngine] ❌ Job "${job.name}" claim failed:`, error?.code ?? 'error');
          return;
        }

        if(!current())return;
        safeConsole.log(`[CronEngine] ⏰ Executing job: ${job.name}`);

        try {
          const result = await this.executeJob(job.id, 'scheduled');

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

        if(!current())return;
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
    this.paperRegistrations.delete(jobId);
    this.timerTokens.delete(jobId);
    const status=this.paperStatuses.get(jobId);
    if(status)this.paperStatuses.set(jobId,Object.freeze({...status,registered:false,phase:'stopped'}));
    const task = this.tasks.get(jobId);

    if (task) {
      task.stop();
      task.destroy?.();
      this.tasks.delete(jobId);
      safeConsole.log(`[CronEngine] ⏹️  Unscheduled job: ${jobId}`);
    }
  }

  /** Remember a persisted draft without starting a cron task. */
  rememberPausedJob(job: CronJob): void {
    if(this.#paperOnly&&job.actionType!=='paper-runtime-cycle')throw Error('Paper job required');
    if (job.enabled) throw new Error('Paused job required');
    this.unscheduleJob(job.id);
    this.jobs.set(job.id, job);
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
  async executeJob(jobId: string, trigger: 'manual' | 'scheduled' = 'manual'): Promise<JobExecutionResult> {
    const job = this.jobs.get(jobId);

    if (!job||this.#paperOnly&&job.actionType!=='paper-runtime-cycle') {
      throw new Error(`Job not found: ${jobId}`);
    }

    if(job.actionType==='paper-runtime-cycle')return this.executePaper(jobId,trigger,this.paperRegistrations.get(jobId));
    const startTime = Date.now();

    try {
      const admitted = job.actionType === 'send-message' || job.actionType === 'api-call' ? await assertScheduledDispatch(job, trigger) : undefined;
      let output: any;

      switch (admitted?.actionType ?? job.actionType) {
        case 'execute-skill':
          output = await this.executeSkill(job.actionData as ExecuteSkillAction);
          break;

        case 'send-message':
          output = await this.sendMessage(admitted!.actionData as unknown as SendMessageAction);
          break;

        case 'api-call':
          output = await this.executeApiCall(admitted!.actionData as unknown as ApiCallAction);
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
    if(this.#paperOnly){
      const db=this.#paperLedger;
      if(!db||!db.open||dbDriver()!=='sqlite'||getDatabase().getDb()!==db)return;
      // Filter in SQL before parsing JSON: unrelated generic data is never adopted by this instance.
      const rows=db.prepare("SELECT * FROM main.cron_jobs WHERE enabled=1 AND action_type='paper-runtime-cycle'").all() as CronJobRow[];
      for(const row of rows){try{const job=rowToJob('sqlite',row);this.jobs.set(job.id,job);}catch{/* Malformed paper rows never become timers. */}}
      return;
    }
    for (const job of await listEnabledJobs())this.jobs.set(job.id, job);
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

/** Restrictive per-owner-server lifecycle; generic jobs and the default singleton are never adopted. */
export class OwnedPaperCronEngine extends CronEngine{
  constructor(ledger:Database.Database|null){super(ledger,'paper-only');}
}

// Singleton instance
let engineInstance: CronEngine | null = null;

export function getCronEngine(): CronEngine {
  if (!engineInstance) {
    engineInstance = new CronEngine();
  }
  return engineInstance;
}
