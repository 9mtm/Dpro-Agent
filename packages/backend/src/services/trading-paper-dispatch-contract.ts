import {createHash} from 'node:crypto';

/** Internal data contract only. A digest is not owner consent or permission to dispatch. */
export interface PaperDispatchDefinition {
  version: 1;
  mode: 'paper';
  ownerId: string;
  botId: string;
  accountId: string;
  policyId: string;
  policyRevision: number;
  appRevision: number;
  installationId: string;
  installationRevision: number;
  manifestDigest: string;
  policyHash: string;
  profileHash: string;
  quoteSource: 'stored-paper-quote';
  strategy: {kind: 'fixed-paper-order'; version: 1; symbol: string; side: 'buy' | 'sell'; amount: number};
  limits: {expiresAt: number; maxAttempts: number; cadenceMs: number};
}
const fields = ['version','mode','ownerId','botId','accountId','policyId','policyRevision','appRevision',
  'installationId','installationRevision','manifestDigest','policyHash','profileHash','quoteSource','strategy','limits'];
function exact(value: unknown, names: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && keys.every(key => typeof key === 'string' && names.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!, 'value'));
}
const uint = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$(?![\s\S])/.test(v);

/**
 * Capture untrusted data without coercion or getters. Only a deterministic, provider-free strategy is representable.
 * Buy amount is total reserved notional in account minor units; sell amount is whole asset units. Current policy,
 * balances, quote provenance and all authority still require validation at the future atomic dispatch boundary.
 */
export function capturePaperDispatchDefinition(input: unknown, now: number):
  Readonly<{definition: Readonly<PaperDispatchDefinition>; canonical: string; digest: string}> | null {
  try {
    if (!uint(now,1,Number.MAX_SAFE_INTEGER-2592000000) || !exact(input,fields)
      || input.version !== 1 || input.mode !== 'paper' || input.quoteSource !== 'stored-paper-quote'
      || !['ownerId','botId','accountId','policyId','installationId'].every(key => id(input[key]))
      || !['policyRevision','appRevision','installationRevision'].every(key => uint(input[key],1))
      || !['manifestDigest','policyHash','profileHash'].every(key => hash(input[key]))
      || !exact(input.strategy,['kind','version','symbol','side','amount'])
      || !exact(input.limits,['expiresAt','maxAttempts','cadenceMs'])) return null;
    const s = input.strategy, l = input.limits;
    if (s.kind !== 'fixed-paper-order' || s.version !== 1 || !id(s.symbol) || !['buy','sell'].includes(s.side as string)
      || !uint(s.amount,1,1_000_000_000_000) || !uint(l.expiresAt,now+1,now+2592000000)
      || !uint(l.maxAttempts,1,1000) || !uint(l.cadenceMs,1000,86400000)) return null;
    const strategy = Object.freeze({kind:'fixed-paper-order' as const,version:1 as const,symbol:s.symbol,
      side:s.side as 'buy'|'sell',amount:s.amount});
    const limits = Object.freeze({expiresAt:l.expiresAt,maxAttempts:l.maxAttempts,cadenceMs:l.cadenceMs});
    const definition = Object.freeze({version:1 as const,mode:'paper' as const,ownerId:input.ownerId as string,
      botId:input.botId as string,accountId:input.accountId as string,policyId:input.policyId as string,
      policyRevision:input.policyRevision as number,appRevision:input.appRevision as number,
      installationId:input.installationId as string,installationRevision:input.installationRevision as number,
      manifestDigest:input.manifestDigest as string,policyHash:input.policyHash as string,profileHash:input.profileHash as string,
      quoteSource:'stored-paper-quote' as const,strategy,limits});
    const canonical = JSON.stringify({domain:'paper-dispatch-definition-v1',definition});
    return Object.freeze({definition,canonical,digest:createHash('sha256').update(canonical).digest('hex')});
  } catch { return null; }
}
