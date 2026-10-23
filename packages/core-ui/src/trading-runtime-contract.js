/** Exact deterministic paper runtime-consent transport. No dispatch, worker, engine or provider capability. */
const base='/api/trading-paper/runtime';
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const exact=(v,keys)=>record(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uint=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const token=v=>typeof v==='string'&&v.length===43&&/^[A-Za-z0-9_-]{43}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(v);
const bytes=(v,max)=>{try{return new TextEncoder().encode(JSON.stringify(v)).length<=max;}catch{return false;}};
const fail=()=>{throw Error('paper_runtime_protocol');};
const strategyKeys=['kind','version','symbol','side','amount'],limitKeys=['expiresAt','maxAttempts','cadenceMs'];
function validStrategy(s){return exact(s,strategyKeys)&&s.kind==='fixed-paper-order'&&s.version===1&&id(s.symbol)&&['buy','sell'].includes(s.side)&&uint(s.amount,1,1e12);}
function validLimits(l){return exact(l,limitKeys)&&uint(l.expiresAt,1)&&uint(l.maxAttempts,1,1000)&&uint(l.cadenceMs,1000,86400000);}
const strategy=s=>({kind:s.kind,version:s.version,symbol:s.symbol,side:s.side,amount:s.amount});
const limits=l=>({expiresAt:l.expiresAt,maxAttempts:l.maxAttempts,cadenceMs:l.cadenceMs});
export function tradingRuntimeRoute(path){
 if(typeof path!=='string'||/[\x00-\x20\x7f]/.test(path))return null;
 if(path===base+'/reviews')return {kind:'stage'};
 const review=path.match(/^\/api\/trading-paper\/runtime\/reviews\/([^/]+)(?:\/(challenge|complete|apply))?$/);
 if(review&&uuid(review[1]))return {kind:review[2]??'review',reviewId:review[1]};
 const consent=path.match(/^\/api\/trading-paper\/runtime\/consents\/([^/]+)(?:\/(revoke))?$/);
 return consent&&uuid(consent[1])?{kind:consent[2]??'consent',consentId:consent[1]}:null;
}
export function allowedTradingRuntime(method,path,body){
 const r=tradingRuntimeRoute(path);if(!r)return false;
 if(['review','consent'].includes(r.kind))return method==='GET'&&body===undefined;
 if(method!=='POST')return false;
 if(r.kind==='stage')return exact(body,['botId','strategy','limits'])&&uuid(body.botId)&&validStrategy(body.strategy)&&validLimits(body.limits)&&bytes(body,4096);
 if(['challenge','revoke'].includes(r.kind))return exact(body,[]);
 if(r.kind==='complete')return exact(body,['challenge','code'])&&token(body.challenge)&&typeof body.code==='string'&&body.code.length===6&&/^\d{6}$/.test(body.code);
 return r.kind==='apply'&&exact(body,['receipt'])&&token(body.receipt);
}
function common(b){
 if(!record(b)||b.ok!==true||b.runtimePrincipal!=='bundled.paper.deterministic.v1'||b.engineExecution!==false||b.providerAccess!==false||b.modelCosts!==false||b.runtimeConnected!==false||typeof b.currency!=='string'||!/^[A-Z]{3}$(?![\s\S])/.test(b.currency)||!record(b.strategy)||!record(b.limits))return fail();
 const s=strategy(b.strategy),l=limits(b.limits);if(!validStrategy(s)||!validLimits(l)||b.amountUnit!==(s.side==='buy'?'account_minor_units':'whole_asset_units'))return fail();
 return {runtimePrincipal:'bundled.paper.deterministic.v1',currency:b.currency,amountUnit:b.amountUnit,engineExecution:false,providerAccess:false,modelCosts:false,strategy:s,limits:l,runtimeConnected:false};
}
export function tradingRuntimeResponse(path,status,body){
 const r=tradingRuntimeRoute(path);if(!r||!uint(status,100,599))return fail();
 if(status!==200){const known=['unauthenticated','forbidden','owner_verification_required','rate_limited','verification_refused','invalid_paper_runtime_request','paper_runtime_unavailable','origin_not_allowed','inactive_user'];return {code:record(body)&&known.includes(body.code)?body.code:'paper_runtime_unavailable'};}
 if(['stage','review'].includes(r.kind)){
  const c=common(body);if(!uuid(body.id)||r.reviewId!==undefined&&body.id!==r.reviewId||!uuid(body.consentId)||!uuid(body.botId)||!id(body.accountId)||!uint(body.expiresAt,1)||body.startsWorker!==false||body.connectsBroker!==false)return fail();
  const result={ok:true,id:body.id,consentId:body.consentId,botId:body.botId,accountId:body.accountId,expiresAt:body.expiresAt,...c,startsWorker:false,connectsBroker:false};return bytes(result,4096)?result:fail();
 }
 if(['challenge','complete'].includes(r.kind)){const k=r.kind==='challenge'?'challenge':'receipt';if(!record(body)||!token(body[k])||!uint(body.expiresAt,1))return fail();return {[k]:body[k],expiresAt:body.expiresAt};}
 if(r.kind==='revoke'){
  if(!record(body)||body.ok!==true||body.consentId!==r.consentId||body.status!=='revoked'||!uint(body.revokedAt,1)||typeof body.replayed!=='boolean'||body.runtimeConnected!==false)return fail();
  return {ok:true,consentId:r.consentId,status:'revoked',revokedAt:body.revokedAt,replayed:body.replayed,runtimeConnected:false};
 }
 const c=common(body);if(!uuid(body.consentId)||r.consentId!==undefined&&body.consentId!==r.consentId||!uuid(body.reviewId)||r.reviewId!==undefined&&body.reviewId!==r.reviewId||!uuid(body.botId)||!uuid(body.definitionId)||!hash(body.definitionDigest)||!['granted','revoked'].includes(body.status)||!uint(body.createdAt,1)||body.createdAt>=c.limits.expiresAt||!uint(body.attemptCount,0,c.limits.maxAttempts)||body.status==='granted'&&body.revokedAt!==null||body.status==='revoked'&&!uint(body.revokedAt,body.createdAt)||r.kind==='apply'&&typeof body.replayed!=='boolean')return fail();
 const result={ok:true,consentId:body.consentId,reviewId:body.reviewId,botId:body.botId,definitionId:body.definitionId,definitionDigest:body.definitionDigest,status:body.status,createdAt:body.createdAt,revokedAt:body.revokedAt,...c,attemptCount:body.attemptCount,...(r.kind==='apply'?{replayed:body.replayed}:{})};return bytes(result,4096)?result:fail();
}
