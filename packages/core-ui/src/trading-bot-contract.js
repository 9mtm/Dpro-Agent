/** Exact protected paper-bot management transport. No tick, order, strategy or engine capability. */
const base='/api/trading-paper/bots';
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const exact=(value,keys)=>record(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&!/[\r\n]/.test(value)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const uuid=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const uint=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const currency=value=>typeof value==='string'&&value.length===3&&/^[A-Z]{3}$/.test(value);
const token=value=>typeof value==='string'&&value.length===43&&/^[A-Za-z0-9_-]{43}$/.test(value);
const bytes=(value,max)=>{try{return new TextEncoder().encode(JSON.stringify(value)).length<=max;}catch{return false;}};
const fail=()=>{throw Error('paper_bot_protocol');};
export function tradingBotRoute(path){
 if(typeof path!=='string'||/[\x00-\x1f\x7f]/.test(path))return null;
 if(path===base)return {kind:'list'};
 if(path===base+'/reviews')return {kind:'stage'};
 if(typeof path!=='string')return null;
 const review=path.match(/^\/api\/trading-paper\/bots\/reviews\/([^/]+)(?:\/(challenge|complete|apply))?$/);
 if(review&&uuid(review[1]))return {kind:review[2]??'review',reviewId:review[1]};
 const action=path.match(/^\/api\/trading-paper\/bots\/([^/]+)\/(stop|revoke)$/);
 if(!action)return null;
 let botId;try{botId=decodeURIComponent(action[1]);}catch{return null;}
 return id(botId)&&encodeURIComponent(botId)===action[1]?{kind:action[2],botId}:null;
}
export function allowedTradingBot(method,path,body){
 const route=tradingBotRoute(path);if(!route)return false;
 if(['list','review'].includes(route.kind))return method==='GET'&&body===undefined;
 if(method!=='POST')return false;
 if(route.kind==='stage')return exact(body,['accountId','policyId','policyRevision','appRevision','expiresAt','maxSuccessfulTicks','cooldownMs'])&&id(body.accountId)&&id(body.policyId)&&uint(body.policyRevision,1)&&uint(body.appRevision,1)&&uint(body.expiresAt,1)&&uint(body.maxSuccessfulTicks,1,1000)&&uint(body.cooldownMs)&&bytes(body,2048);
 if(['stop','revoke','challenge'].includes(route.kind))return exact(body,[])&&bytes(body,route.kind==='challenge'?2048:1024);
 if(route.kind==='complete')return exact(body,['challenge','code'])&&token(body.challenge)&&typeof body.code==='string'&&body.code.length===6&&/^\d{6}$/.test(body.code)&&bytes(body,2048);
 return route.kind==='apply'&&exact(body,['receipt'])&&token(body.receipt)&&bytes(body,2048);
}
function descriptor(value){
 if(!record(value)||!id(value.botId)||!id(value.accountId)||!id(value.policyId)||!currency(value.currency)||value.running!==false
   ||!['policyRevision','appRevision','expiresAt','createdAt'].every(key=>uint(value[key],1))||!uint(value.maxSuccessfulTicks,1,1000)||!uint(value.cooldownMs)
   ||!uint(value.successfulTicks,0,value.maxSuccessfulTicks)||value.expiresAt<=value.createdAt||!['active','expired','stopped','revoked'].includes(value.status)
   ||(value.successfulTicks===0?value.lastSuccessAt!==null:!uint(value.lastSuccessAt)||value.lastSuccessAt<value.createdAt||value.lastSuccessAt>=value.expiresAt))return fail();
 return {botId:value.botId,accountId:value.accountId,policyId:value.policyId,policyRevision:value.policyRevision,appRevision:value.appRevision,currency:value.currency,expiresAt:value.expiresAt,maxSuccessfulTicks:value.maxSuccessfulTicks,cooldownMs:value.cooldownMs,status:value.status,successfulTicks:value.successfulTicks,lastSuccessAt:value.lastSuccessAt,createdAt:value.createdAt,running:false};
}
function review(value,route){
 if(!record(value)||value.ok!==true||!uuid(value.id)||!uuid(value.botId)||(route.reviewId!==undefined&&value.id!==route.reviewId)
   ||!id(value.accountId)||!id(value.policyId)||!currency(value.currency)||!['policyRevision','appRevision','expiresAt','botExpiresAt'].every(key=>uint(value[key],1))
   ||!uint(value.maxSuccessfulTicks,1,1000)||!uint(value.cooldownMs)||!Array.isArray(value.symbols)||value.symbols.length<1||value.symbols.length>500||!value.symbols.every(id)
   ||new Set(value.symbols).size!==value.symbols.length||!record(value.limits)||!record(value.execution))return fail();
 const limits=value.limits,execution=value.execution;
 if(!['maxOrder','maxExposure','maxDailyLoss','maxOrders','maxQuoteAgeMs'].every(key=>uint(limits[key],1))||!uint(limits.cooldownMs)
   ||!Array.isArray(limits.symbols)||limits.symbols.length!==value.symbols.length||limits.symbols.some((symbol,index)=>symbol!==value.symbols[index])
   ||!uint(execution.feeBps,0,10000)||!uint(execution.slippageBps,0,10000)||execution.unitScale!==1)return fail();
 const result={ok:true,id:value.id,botId:value.botId,expiresAt:value.expiresAt,accountId:value.accountId,policyId:value.policyId,policyRevision:value.policyRevision,appRevision:value.appRevision,currency:value.currency,botExpiresAt:value.botExpiresAt,maxSuccessfulTicks:value.maxSuccessfulTicks,cooldownMs:value.cooldownMs,symbols:[...value.symbols],limits:{symbols:[...value.symbols],maxOrder:limits.maxOrder,maxExposure:limits.maxExposure,maxDailyLoss:limits.maxDailyLoss,maxOrders:limits.maxOrders,cooldownMs:limits.cooldownMs,maxQuoteAgeMs:limits.maxQuoteAgeMs},execution:{feeBps:execution.feeBps,slippageBps:execution.slippageBps,unitScale:1}};
 return bytes(result,32768)?result:fail();
}
/** Both bridge and renderer share bounded public projections; private metadata is never relayed. */
export function tradingBotResponse(path,status,body){
 const route=tradingBotRoute(path);if(!route||!uint(status,100,599))return fail();
 if(status!==200){const codes=['unauthenticated','forbidden','owner_verification_required','rate_limited','verification_refused','invalid_paper_bot_request','paper_bot_management_unavailable','origin_not_allowed','inactive_user'];return {code:record(body)&&codes.includes(body.code)?body.code:'paper_bot_management_unavailable'};}
 if(route.kind==='list'){
  if(!record(body)||body.mode!=='paper'||body.running!==false||!Array.isArray(body.bots)||body.bots.length>100||typeof body.hasMore!=='boolean'||body.hasMore&&body.bots.length!==100)return fail();
  const bots=body.bots.map(descriptor);if(new Set(bots.map(bot=>bot.botId)).size!==bots.length)return fail();const result={mode:'paper',running:false,bots,hasMore:body.hasMore};return bytes(result,262144)?result:fail();
 }
 if(['stage','review'].includes(route.kind))return review(body,route);
 if(['challenge','complete'].includes(route.kind)){const key=route.kind==='challenge'?'challenge':'receipt';if(!record(body)||!token(body[key])||!uint(body.expiresAt,1))return fail();return {[key]:body[key],expiresAt:body.expiresAt};}
 if(route.kind==='apply'){if(!record(body)||body.ok!==true||body.reviewId!==route.reviewId||!uuid(body.botId)||typeof body.replayed!=='boolean')return fail();return {ok:true,botId:body.botId,reviewId:route.reviewId,replayed:body.replayed};}
 if(!record(body)||body.mode!=='paper'||body.botId!==route.botId||body.status!==(route.kind==='stop'?'stopped':'revoked')||body.running!==false)return fail();
 return {mode:'paper',botId:route.botId,status:body.status,running:false};
}
