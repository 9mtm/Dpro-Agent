/** Exact create-once paper-account review transport; no reset, order or runtime capability. */
const base='/api/trading-paper/account-setup';
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const exact=(v,keys)=>record(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uint=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const generated=(v,prefix)=>typeof v==='string'&&v.startsWith(prefix)&&uuid(v.slice(prefix.length));
const token=v=>typeof v==='string'&&v.length===43&&/^[A-Za-z0-9_-]{43}$/.test(v);
const symbol=v=>typeof v==='string'&&v.length<=128&&!/[\x00-\x20\x7f]/.test(v)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const bytes=(v,max)=>{try{return new TextEncoder().encode(JSON.stringify(v)).length<=max;}catch{return false;}};
const policyKeys=['expiresAt','symbols','maxOrder','maxExposure','maxDailyLoss','maxOrders','cooldownMs','maxQuoteAgeMs'];
const fail=()=>{throw Error('paper_account_setup_protocol');};
function validInput(v){
 if(!exact(v,['currency','initialCashMinor','policy','execution'])||typeof v.currency!=='string'||v.currency.length!==3||!/^[A-Z]{3}$/.test(v.currency)||!uint(v.initialCashMinor,1,1e12)
  ||!exact(v.policy,policyKeys)||!exact(v.execution,['feeBps','slippageBps']))return false;
 const p=v.policy,e=v.execution,a=p.symbols;
 if(!uint(p.expiresAt,1)||!['maxOrder','maxExposure','maxDailyLoss'].every(k=>uint(p[k],1,v.initialCashMinor))||p.maxOrder>p.maxExposure||!uint(p.maxOrders,1,10000)||!uint(p.cooldownMs,0,86400000)||!uint(p.maxQuoteAgeMs,1,300000)||!uint(e.feeBps,0,10000)||!uint(e.slippageBps,0,10000))return false;
 if(!Array.isArray(a)||Object.getPrototypeOf(a)!==Array.prototype||a.length<1||a.length>100||Reflect.ownKeys(a).length!==a.length+1)return false;
 for(let i=0;i<a.length;i++){const d=Object.getOwnPropertyDescriptor(a,i);if(!d||!Object.hasOwn(d,'value')||!symbol(d.value))return false;}
 return new Set(a).size===a.length&&bytes(v,16384);
}
export function tradingAccountSetupRoute(path){
 if(typeof path!=='string'||/[\x00-\x20\x7f]/.test(path))return null;
 if(path===base+'/reviews')return {kind:'stage'};
 const match=path.match(/^\/api\/trading-paper\/account-setup\/reviews\/([^/]+)(?:\/(challenge|complete|apply))?$/);
 return match&&uuid(match[1])?{kind:match[2]??'review',reviewId:match[1]}:null;
}
export function allowedTradingAccountSetup(method,path,body){
 const route=tradingAccountSetupRoute(path);if(!route)return false;
 if(route.kind==='review')return method==='GET'&&body===undefined;
 if(method!=='POST')return false;
 if(route.kind==='stage')return validInput(body);
 if(route.kind==='challenge')return exact(body,[]);
 if(route.kind==='complete')return exact(body,['challenge','code'])&&token(body.challenge)&&typeof body.code==='string'&&body.code.length===6&&/^\d{6}$/.test(body.code);
 return route.kind==='apply'&&exact(body,['receipt'])&&token(body.receipt);
}
function policy(p){return {expiresAt:p.expiresAt,symbols:[...p.symbols],maxOrder:p.maxOrder,maxExposure:p.maxExposure,maxDailyLoss:p.maxDailyLoss,maxOrders:p.maxOrders,cooldownMs:p.cooldownMs,maxQuoteAgeMs:p.maxQuoteAgeMs};}
export function tradingAccountSetupResponse(path,status,body){
 const route=tradingAccountSetupRoute(path);if(!route||!uint(status,100,599))return fail();
 if(status!==200){const known=['unauthenticated','forbidden','owner_verification_required','rate_limited','verification_refused','invalid_paper_account_setup_request','paper_account_setup_unavailable','origin_not_allowed','inactive_user'];return {code:record(body)&&known.includes(body.code)?body.code:'paper_account_setup_unavailable'};}
 if(['stage','review'].includes(route.kind)){
  if(!record(body)||body.ok!==true||!uuid(body.id)||route.reviewId!==undefined&&body.id!==route.reviewId||!uint(body.expiresAt,1)||body.appId!=='trading'||body.version!=='1.0.0'||body.mode!=='paper'
   ||!generated(body.accountId,'account-')||!generated(body.policyId,'policy-')||body.installationRevision!==1||body.appRevision!==1||body.policyRevision!==1||body.profileRevision!==1||body.runtimeConnected!==false||body.createsAccount!==true||body.startsBot!==false||body.connectsBroker!==false||!record(body.execution)||body.execution.unitScale!==1)return fail();
  const input={currency:body.currency,initialCashMinor:body.initialCashMinor,policy:body.policy,execution:{feeBps:body.execution.feeBps,slippageBps:body.execution.slippageBps}};if(!validInput(input))return fail();
  const result={ok:true,id:body.id,expiresAt:body.expiresAt,appId:'trading',version:'1.0.0',mode:'paper',accountId:body.accountId,policyId:body.policyId,installationRevision:1,currency:body.currency,initialCashMinor:body.initialCashMinor,policy:policy(body.policy),execution:{feeBps:body.execution.feeBps,slippageBps:body.execution.slippageBps,unitScale:1},appRevision:1,policyRevision:1,profileRevision:1,runtimeConnected:false,createsAccount:true,startsBot:false,connectsBroker:false};
  return bytes(result,16384)?result:fail();
 }
 if(['challenge','complete'].includes(route.kind)){const key=route.kind==='challenge'?'challenge':'receipt';if(!record(body)||!token(body[key])||!uint(body.expiresAt,1))return fail();return {[key]:body[key],expiresAt:body.expiresAt};}
 if(!record(body))return fail();const r=body.result;
 if(body.ok!==true||body.reviewId!==route.reviewId||!uuid(body.setupId)||typeof body.replayed!=='boolean'||!record(r)||!generated(r.accountId,'account-')||!generated(r.policyId,'policy-')||r.appRevision!==1||r.policyRevision!==1||r.profileRevision!==1||r.mode!=='paper'||r.runtimeConnected!==false)return fail();
 return {ok:true,reviewId:route.reviewId,setupId:body.setupId,result:{accountId:r.accountId,policyId:r.policyId,appRevision:1,policyRevision:1,profileRevision:1,mode:'paper',runtimeConnected:false},replayed:body.replayed};
}
