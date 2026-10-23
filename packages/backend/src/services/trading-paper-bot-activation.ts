import {PAPER_BOT_ACTIVATION_SCHEMA_SQL} from './trading-paper-schema-definition.js';
/** Internal reviewed owner activation. SQLite same-handle only; no HTTP, runtime, timer or strategy wiring. */
import type Database from 'better-sqlite3';
import {createHash, randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import type {Actor} from '../repositories/actor.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {sql} from '../repositories/sql-steps.js';
import {issueOperationChallenge, completeOperationChallenge, consumeOperationReceiptStep, paperBotActivationOperationHash,
  type OperationContext, type PaperBotActivationOperation} from '../auth/verification/operation-proof.js';
import {readPaperRisk} from './trading-paper-risk.js';
import {readPaperAvailability} from './trading-paper-availability.js';
import {readPaperBotAvailability} from './trading-paper-bot-availability.js';
import {inspectPaperBundleSchema} from './trading-paper-bundle-schema.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation} from './trading-paper-installation.js';
import {readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
import {inspectPaperBotHistory} from './trading-paper-bots.js';

function fail(): never { throw Error('Paper activation unavailable'); }
const deny = () => ({ok: false as const, reason: 'unavailable' as const});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const uint = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const bounded = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 8192;
const fields = ['accountId','policyId','policyRevision','appRevision','expiresAt','maxSuccessfulTicks','cooldownMs'];
function plain(value: unknown, allowed: string[]): value is Record<string,unknown> {
  return !!value && typeof value === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === allowed.length && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
function handle(db: Database.Database) {
  // Identity, not filename equivalence. This check precedes every SQL runner/receipt call or local SQL statement.
  if (dbDriver() !== 'sqlite' || getDatabase().getDb() !== db || db.inTransaction) fail();
}
/** Server-owned opt-in for management HTTP. Trusted internal callers default to no installation gate. */
function managed(db:Database.Database,owner:string,required:boolean){
  if(typeof required!=='boolean')fail();
  if(required&&(readPaperAvailability(db,owner).state!=='ready'||readPaperBotAvailability(db,owner).state!=='ready'))fail();
}
function capture(context: OperationContext, actor: Actor, now: number): OperationContext {
  if (!context || !actor || actor.kind !== 'user' || actor.role !== 'owner' || actor.agentId !== undefined
    || actor.channel !== undefined || actor.userId !== context.userId || !id(context.userId) || isSystemAccount(context.userId)
    || typeof context.sessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(context.sessionHash)
    || !uint(context.tokenVersion,1) || !uint(context.factorVersion,1) || !uint(now,1) || now > Number.MAX_SAFE_INTEGER-300000) fail();
  return Object.freeze({userId:context.userId,sessionHash:context.sessionHash,tokenVersion:context.tokenVersion,factorVersion:context.factorVersion});
}
function active(db: Database.Database, context: OperationContext) {
  const user = db.prepare('SELECT role,status,email_verified,token_version FROM users WHERE id=?').get(context.userId) as Record<string,unknown>|undefined;
  const factor = db.prepare('SELECT enabled,version FROM verification_factors WHERE user_id=?').get(context.userId) as Record<string,unknown>|undefined;
  const policy = db.prepare('SELECT version FROM approval_proof_policy WHERE id=1').get() as {version:number}|undefined;
  if (!user || user.role !== 'owner' || user.status !== 'active' || user.email_verified !== 1 || user.token_version !== context.tokenVersion
    || !factor || factor.enabled !== 1 || factor.version !== context.factorVersion || !policy || !uint(policy.version,1)) fail();
  return policy!.version;
}
function inputDefinition(input: unknown) {
  if (!plain(input,fields) || !id(input.accountId) || !id(input.policyId)
    || !['policyRevision','appRevision','expiresAt','maxSuccessfulTicks'].every(key => uint(input[key],1))
    || Number(input.maxSuccessfulTicks)>1000 || !uint(input.cooldownMs)) fail();
  return {...input!} as {accountId:string;policyId:string;policyRevision:number;appRevision:number;expiresAt:number;maxSuccessfulTicks:number;cooldownMs:number};
}
function target(db: Database.Database, owner: string, input: ReturnType<typeof inputDefinition>, botId: string, now: number) {
  const risk = readPaperRisk(db,owner,input.accountId,input.policyId,()=>now);
  if (!risk.ok || !risk.allowed || risk.policyRevision!==input.policyRevision || risk.appRevision!==input.appRevision || input.expiresAt<=now) fail();
  const row = db.prepare('SELECT policy_json FROM paper_policies WHERE account_id=? AND policy_id=?').get(input.accountId,input.policyId) as {policy_json:string}|undefined;
  if (!row || !bounded(row.policy_json)) fail();
  const p = JSON.parse(row!.policy_json);
  if (input.expiresAt>p.expiresAt) fail();
  const profile = db.prepare('SELECT account_id,owner_id,revision,fee_bps,slippage_bps,unit_scale,currency FROM paper_execution_profiles WHERE account_id=?').get(input.accountId) as {fee_bps:number;slippage_bps:number;unit_scale:number};
  const definition = {version:1,botId,ownerId:owner,...input,currency:risk.ok?risk.currency:'',policyHash:sha(JSON.stringify(p)),profileHash:sha(JSON.stringify(profile)),execution:{feeBps:profile.fee_bps,slippageBps:profile.slippage_bps,unitScale:profile.unit_scale},
    limits:{symbols:[...p.symbols],maxOrder:p.maxOrder,maxExposure:p.maxExposure,maxDailyLoss:p.maxDailyLoss,maxOrders:p.maxOrders,cooldownMs:p.cooldownMs,maxQuoteAgeMs:p.maxQuoteAgeMs}};
  const json=JSON.stringify(definition);if(!bounded(json))fail();return {definition,json};
}
type Review = {id:string;bot_id:string;owner_id:string;session_hash:string;token_version:number;factor_version:number;policy_version:number;definition_json:string;definition_hash:string;review_hash:string;created_at:number;expires_at:number;status:string};
function reviewHash(row: Review) { return sha(JSON.stringify(['paper-bot-activation-review-v1',row.id,row.bot_id,row.definition_hash,row.policy_version,row.created_at,row.expires_at])); }
function readRow(db: Database.Database, owner: OperationContext, reviewId: string, version: number, now: number, historical=false) {
  if(!uuid(reviewId))fail();
  const row=db.prepare('SELECT * FROM paper_bot_activation_reviews WHERE id=? AND owner_id=?').get(reviewId,owner.userId) as Review|undefined;
  if(!row||row.session_hash!==owner.sessionHash||row.token_version!==owner.tokenVersion||row.factor_version!==owner.factorVersion
    ||row.policy_version!==version||!uuid(row.bot_id)||!uint(row.created_at,1)||row.created_at>now||!uint(row.expires_at,1)
    ||row.expires_at-row.created_at!==300000||!['staged','applied'].includes(row.status)||!bounded(row.definition_json)
    ||sha(row.definition_json)!==row.definition_hash||reviewHash(row)!==row.review_hash||(!historical&&(row.expires_at<=now||row.status!=='staged')))fail();
  const definition=JSON.parse(row!.definition_json),input=inputDefinition(Object.fromEntries(fields.map(key=>[key,definition[key]])));
  if(definition.botId!==row!.bot_id||definition.ownerId!==owner.userId||definition.version!==1||JSON.stringify(definition)!==row!.definition_json)fail();
  if(!historical&&target(db,owner.userId,input,row!.bot_id,now).json!==row!.definition_json)fail();
  return {row:row!,definition,input};
}
function eventHash(event: Record<string,unknown>) {
  return sha(JSON.stringify(['paper-bot-activation-event-v1',...['id','review_id','bot_id','owner_id','session_hash','token_version','factor_version','policy_version','definition_hash','review_hash','receipt_hash','created_at'].map(key=>event[key])]));
}
function publicReview(current: ReturnType<typeof readRow>) {
  const {row,definition:d}=current;
  return Object.freeze({ok:true as const,id:row.id,botId:row.bot_id,expiresAt:row.expires_at,accountId:d.accountId,policyId:d.policyId,
    policyRevision:d.policyRevision,appRevision:d.appRevision,currency:d.currency,botExpiresAt:d.expiresAt,
    maxSuccessfulTicks:d.maxSuccessfulTicks,cooldownMs:d.cooldownMs,symbols:Object.freeze([...d.limits.symbols]),
    limits:Object.freeze({...d.limits,symbols:Object.freeze([...d.limits.symbols])}),execution:Object.freeze({...d.execution})});
}
function operation(row: Review): PaperBotActivationOperation {return {kind:'paper_bot_activation',reviewId:row.id,reviewHash:row.review_hash,reviewExpiresAt:row.expires_at,policyVersion:row.policy_version};}
/** Explicit same-main-handle initialization only; no migrations and no lazy initialization. */
export function initializePaperBotActivation(db: Database.Database) {
  handle(db);db.transaction(()=>db.exec(PAPER_BOT_ACTIVATION_SCHEMA_SQL)).immediate();
}
export async function stagePaperBotActivation(db: Database.Database,context: OperationContext,actor: Actor,input: unknown,now=Date.now(),requireInstalledManagement=false) {
  try {handle(db);const owner=capture(context,actor,now),request=inputDefinition(input);
    return await sql().tx(function*(){
      managed(db,owner.userId,requireInstalledManagement);
      const version=active(db,owner),id=randomUUID(),botId=randomUUID(),{json}=target(db,owner.userId,request,botId,now);
      const count=db.prepare("SELECT count(*) n FROM paper_bot_activation_reviews WHERE owner_id=? AND status='staged' AND expires_at>?").get(owner.userId,now) as {n:number};if(count.n>=8)fail();
      const row:Review={id,bot_id:botId,owner_id:owner.userId,session_hash:owner.sessionHash,token_version:owner.tokenVersion,factor_version:owner.factorVersion,policy_version:version,definition_json:json,definition_hash:sha(json),review_hash:'',created_at:now,expires_at:now+300000,status:'staged'};row.review_hash=reviewHash(row);
      db.prepare('INSERT INTO paper_bot_activation_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.bot_id,row.owner_id,row.session_hash,row.token_version,row.factor_version,row.policy_version,row.definition_json,row.definition_hash,row.review_hash,row.created_at,row.expires_at,row.status);
      return publicReview(readRow(db,owner,id,version,now));
    },{immediate:true});
  }catch{return deny();}
}
export async function readPaperBotActivation(db: Database.Database,context: OperationContext,actor: Actor,id: string,now=Date.now(),requireInstalledManagement=false) {
  try{handle(db);const owner=capture(context,actor,now);return await sql().tx(function*(){managed(db,owner.userId,requireInstalledManagement);return publicReview(readRow(db,owner,id,active(db,owner),now));},{immediate:true});}catch{return deny();}
}
async function proofOperation(db:Database.Database,context:OperationContext,actor:Actor,id:string,now:number,required:boolean) {
  handle(db);const owner=capture(context,actor,now);
  return sql().tx(function*(){managed(db,owner.userId,required);return {owner,operation:operation(readRow(db,owner,id,active(db,owner),now).row)};},{immediate:true});
}
/** Proof uses the shared verification pipeline in separate transactions and never grants activation authority. */
export async function issuePaperBotActivationProof(db:Database.Database,context:OperationContext,actor:Actor,id:string,now=Date.now(),requireInstalledManagement=false) {
  try{const current=await proofOperation(db,context,actor,id,now,requireInstalledManagement);
    const result=await issueOperationChallenge(current.owner,current.operation,now);
    await proofOperation(db,current.owner,actor,id,now,requireInstalledManagement);return result;
  }catch{return null;}
}
export async function completePaperBotActivationProof(db:Database.Database,context:OperationContext,actor:Actor,id:string,token:unknown,code:unknown,now=Date.now(),requireInstalledManagement=false) {
  try{const current=await proofOperation(db,context,actor,id,now,requireInstalledManagement);
    const result=await completeOperationChallenge(token,current.owner,current.operation,code,now);
    await proofOperation(db,current.owner,actor,id,now,requireInstalledManagement);return result;
  }catch{return null;}
}
export async function applyPaperBotActivation(db:Database.Database,context:OperationContext,actor:Actor,id:string,receipt:unknown,now=Date.now(),requireInstalledManagement=false) {
  try{handle(db);const owner=capture(context,actor,now);if(typeof receipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(receipt))fail();const receiptHash=sha(receipt as string);
    return await sql().tx(function*(){
      managed(db,owner.userId,requireInstalledManagement);
      const version=active(db,owner),current=readRow(db,owner,id,version,now,true),{row,input}=current;
      const event=db.prepare('SELECT * FROM paper_bot_activation_events WHERE review_id=?').get(id) as Record<string,unknown>|undefined;
      if(event){
        if(row.status!=='applied'||event.review_id!==row.id||event.bot_id!==row.bot_id||event.owner_id!==owner.userId
          ||event.session_hash!==owner.sessionHash||event.token_version!==owner.tokenVersion||event.factor_version!==owner.factorVersion
          ||event.policy_version!==version||event.definition_hash!==row.definition_hash||event.review_hash!==row.review_hash
          ||event.event_hash!==eventHash(event)||event.receipt_hash!==receiptHash||!uuid(event.id)||!uint(event.created_at,1)||event.created_at<row.created_at||event.created_at>=row.expires_at||event.created_at>=input.expiresAt||event.created_at>now)fail();
        const bot=db.prepare('SELECT * FROM paper_bots WHERE bot_id=?').get(row.bot_id) as Record<string,unknown>|undefined;
        if(!bot||bot.owner_id!==owner.userId||bot.account_id!==input.accountId||bot.policy_id!==input.policyId
          ||bot.policy_revision!==input.policyRevision||bot.app_revision!==input.appRevision||bot.expires_at!==input.expiresAt
          ||bot.max_successful_ticks!==input.maxSuccessfulTicks||bot.cooldown_ms!==input.cooldownMs||bot.created_at!==event.created_at
          ||!['active','stopped','revoked'].includes(bot.status as string)||!uint(bot.successful_ticks)||Number(bot.successful_ticks)>input.maxSuccessfulTicks
          ||(bot.successful_ticks===0?bot.last_success_at!==null:!uint(bot.last_success_at)||Number(bot.last_success_at)<Number(bot.created_at)||Number(bot.last_success_at)>now))fail();
        const proof=db.prepare('SELECT * FROM verification_receipts WHERE token_hash=?').get(receiptHash) as Record<string,unknown>|undefined;
        if(!proof||proof.user_id!==owner.userId||proof.session_hash!==owner.sessionHash||proof.token_version!==owner.tokenVersion||proof.factor_version!==owner.factorVersion
          ||proof.operation_hash!==paperBotActivationOperationHash(operation(row))||proof.consumed_at!==event.created_at||!uint(proof.expires_at,1)||proof.expires_at<=Number(event.created_at))fail();
        return {ok:true as const,botId:row.bot_id,reviewId:row.id,replayed:true};
      }
      readRow(db,owner,id,version,now);
      if(!(yield* consumeOperationReceiptStep(receipt,owner,operation(row),now)))fail();
      db.prepare('INSERT INTO paper_bots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.bot_id,owner.userId,input.accountId,input.policyId,input.policyRevision,input.appRevision,input.expiresAt,input.maxSuccessfulTicks,input.cooldownMs,'active',0,null,now);
      const eventRecord={id:randomUUID(),review_id:row.id,bot_id:row.bot_id,owner_id:owner.userId,session_hash:owner.sessionHash,token_version:owner.tokenVersion,factor_version:owner.factorVersion,policy_version:version,definition_hash:row.definition_hash,review_hash:row.review_hash,receipt_hash:receiptHash,created_at:now};
      db.prepare('INSERT INTO paper_bot_activation_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(eventRecord.id,row.id,row.bot_id,owner.userId,owner.sessionHash,owner.tokenVersion,owner.factorVersion,version,row.definition_hash,row.review_hash,receiptHash,now,eventHash(eventRecord));
      if(db.prepare("UPDATE paper_bot_activation_reviews SET status='applied' WHERE id=? AND status='staged'").run(row.id).changes!==1)fail();
      managed(db,owner.userId,requireInstalledManagement);
      return {ok:true as const,botId:row.bot_id,reviewId:row.id,replayed:false};
    },{immediate:true});
  }catch{return deny();}
}

/**
 * Read-only provenance and CURRENT target resolver for a future separate runtime decision.
 * Historical activation consent survives normal session/token/factor rotation. This returns
 * no runtime grant, dispatch permission or execution authority; caller identity remains separate.
 * A caller-owned transaction is supported so a future atomic review can retain one snapshot.
 */
export function readReviewedPaperBotTarget(db:Database.Database,ownerId:string,botId:string,now=Date.now(),allowExhausted=false){
 try{
  const strictId=(value:unknown):value is string=>id(value)&&!/[\x00-\x20\x7f]/.test(value);
  const strictUuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&uuid(value);
  if(typeof allowExhausted!=='boolean'||dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!strictId(ownerId)||isSystemAccount(ownerId)||!strictUuid(botId)||!uint(now,1)||now>Number.MAX_SAFE_INTEGER-300000)fail();
  return db.transaction(()=>{
   if(!inspectPaperBundleSchema(db).ok)fail();
   const authNames=['users','verification_factors','verification_challenges','verification_receipts','approval_proof_policy'];
   const temp=db.prepare("SELECT name,tbl_name FROM sqlite_temp_master WHERE type IN ('table','index','view','trigger')").all() as {name:string;tbl_name:string}[];
   if(temp.some(row=>authNames.includes(row.name.toLowerCase())||authNames.includes(row.tbl_name.toLowerCase())))fail();
   for(const name of authNames)if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=? COLLATE NOCASE").get(name))fail();
   const user=db.prepare('SELECT role,status,email_verified,token_version FROM main.users WHERE id=?').get(ownerId) as Record<string,unknown>|undefined;
   const factor=db.prepare('SELECT enabled,version FROM main.verification_factors WHERE user_id=?').get(ownerId) as Record<string,unknown>|undefined;
   if(user?.role!=='owner'||user.status!=='active'||user.email_verified!==1||!uint(user.token_version,1)||factor?.enabled!==1||!uint(factor.version,1))fail();
   const installation=readPaperInstallation(db,ownerId,()=>now),access=readReviewedPaperInstallationAccess(db,ownerId,()=>now);
   if(!installation.ok||installation.state!=='provisioned'||access.state!=='ready'||!access.readAccounts||!access.readBots||!access.manageBots)fail();
   const event=db.prepare('SELECT * FROM main.paper_bot_activation_events WHERE bot_id=?').get(botId) as Record<string,unknown>|undefined;
   if(!event||!strictUuid(event.id)||!strictUuid(event.review_id)||event.bot_id!==botId||event.owner_id!==ownerId||typeof event.session_hash!=='string'||event.session_hash.length!==64||!/^[a-f0-9]{64}$/.test(event.session_hash)
    ||!uint(event.token_version,1)||!uint(event.factor_version,1)||!uint(event.policy_version,1)||typeof event.receipt_hash!=='string'||event.receipt_hash.length!==64||!/^[a-f0-9]{64}$/.test(event.receipt_hash)||event.event_hash!==eventHash(event))fail();
   // Check original proof context without comparing it to today's session/factor versions.
   const original=capture({userId:ownerId,sessionHash:event.session_hash,tokenVersion:event.token_version as number,factorVersion:event.factor_version as number},{kind:'user',role:'owner',userId:ownerId},now);
   const current=readRow(db,original,event.review_id as string,event.policy_version as number,now,true),r=current.row,input=current.input;
   if(r.status!=='applied'||r.bot_id!==botId||event.session_hash!==r.session_hash||event.token_version!==r.token_version||event.factor_version!==r.factor_version||event.policy_version!==r.policy_version||event.definition_hash!==r.definition_hash||event.review_hash!==r.review_hash
    ||!uint(event.created_at,1)||event.created_at<r.created_at||event.created_at>=r.expires_at||event.created_at>=input.expiresAt||event.created_at>now)fail();
   const receipt=db.prepare('SELECT * FROM main.verification_receipts WHERE token_hash=?').get(event.receipt_hash) as Record<string,unknown>|undefined;
   if(!receipt||receipt.user_id!==ownerId||receipt.session_hash!==r.session_hash||receipt.token_version!==r.token_version||receipt.factor_version!==r.factor_version||receipt.operation_hash!==paperBotActivationOperationHash(operation(r))||receipt.consumed_at!==event.created_at||!uint(receipt.expires_at,1)||receipt.expires_at<=Number(event.created_at))fail();
   const bot=db.prepare('SELECT * FROM main.paper_bots WHERE bot_id=?').get(botId) as Record<string,unknown>|undefined;
   if(!bot||bot.owner_id!==ownerId||bot.account_id!==input.accountId||bot.policy_id!==input.policyId||bot.policy_revision!==input.policyRevision||bot.app_revision!==input.appRevision||bot.expires_at!==input.expiresAt||bot.max_successful_ticks!==input.maxSuccessfulTicks||bot.cooldown_ms!==input.cooldownMs||bot.created_at!==event.created_at
    ||bot.status!=='active'||input.expiresAt<=now||!uint(bot.successful_ticks)||(allowExhausted?Number(bot.successful_ticks)>input.maxSuccessfulTicks:Number(bot.successful_ticks)>=input.maxSuccessfulTicks)||(bot.successful_ticks===0?bot.last_success_at!==null:!uint(bot.last_success_at)||Number(bot.last_success_at)<Number(bot.created_at)||Number(bot.last_success_at)>=input.expiresAt||Number(bot.last_success_at)>now))fail();
   const history=inspectPaperBotHistory(db,ownerId,botId,now);
   if(!history.ok||history.successfulTicks!==bot.successful_ticks||history.lastSuccessAt!==bot.last_success_at||history.status!=='active')fail();
   // Recompute all current account/policy/profile/risk checks; no stale owner-supplied snapshot.
   const refreshed=target(db,ownerId,input,botId,now);if(refreshed.json!==r.definition_json)fail();
   const d=refreshed.definition;
   const definition=Object.freeze({...d,execution:Object.freeze({...d.execution}),limits:Object.freeze({...d.limits,symbols:Object.freeze([...d.limits.symbols])})});
   return Object.freeze({ok:true as const,botId,reviewId:r.id,activationCreatedAt:event.created_at as number,activationDefinitionHash:r.definition_hash,activationReviewHash:r.review_hash,definition,
    installationId:installation.installationId,installationRevision:installation.revision,manifestDigest:BUNDLED_PAPER_INSTALLATION.manifestDigest,successfulTicks:bot.successful_ticks as number,lastSuccessAt:bot.last_success_at as number|null,assessedAt:now,executeOrders:false as const,runtimeConnected:false as const});
  }).deferred();
 }catch{return deny();}
}
