/** Pure advisory admission. Execution must reserve funds and recheck under a ledger lock. */
type Verdict=Readonly<{allowed:true}|{allowed:false;reason:'invalid'|'unavailable'|'quote'|'limit'}>;
const deny=(reason:'invalid'|'unavailable'|'quote'|'limit'):Verdict=>Object.freeze({allowed:false,reason});
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
const integer=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const identity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export function admitPaperOrder(policy:unknown,order:unknown,state:unknown):Verdict{
 if(!record(policy)||!record(order)||!record(state))return deny('invalid');
 if(!identity(policy.id)||!identity(state.policyId)||!identity(order.policyId)||!identity(state.accountId)||!identity(state.quoteSymbol)||typeof policy.currency!=='string'||!/^[A-Z]{3}$/.test(policy.currency))return deny('invalid');
 for(const source of [policy,order,state])for(const key of source===policy?['revision','appRevision']:['policyRevision','appRevision'])if(!integer(source[key],1))return deny('invalid');
 if(policy.id!==order.policyId||policy.id!==state.policyId||policy.revision!==order.policyRevision||policy.revision!==state.policyRevision||policy.appRevision!==order.appRevision||policy.appRevision!==state.appRevision||policy.accountId!==state.accountId||policy.currency!==order.currency||policy.currency!==state.currency||state.accountMode!=='paper'||state.quoteSymbol!==order.symbol)return deny('unavailable');
 if(!identity(policy.ownerId)||!identity(policy.accountId)||!identity(state.ownerId)||!identity(order.accountId)||!identity(order.symbol)||!['buy','sell'].includes(order.side as string))return deny('invalid');
 for(const key of ['expiresAt','maxOrder','maxExposure','maxDailyLoss','maxOrders','maxQuoteAgeMs'])if(!integer(policy[key],1))return deny('invalid');
 if(!integer(policy.cooldownMs)||!Array.isArray(policy.symbols)||!policy.symbols.length||policy.symbols.length>500||!policy.symbols.every(identity))return deny('invalid');
 for(const key of ['now','quoteAt','exposure','reserved','dailyLoss','orders','lastOrderAt'])if(!integer(state[key]))return deny('invalid');
 if(!integer(order.notional,1)||typeof policy.enabled!=='boolean'||typeof state.appEnabled!=='boolean'||typeof state.stopped!=='boolean')return deny('invalid');
 if(policy.mode!=='paper'||!policy.enabled||!state.appEnabled||state.stopped||policy.ownerId!==state.ownerId||policy.accountId!==order.accountId||Number(policy.expiresAt)<=Number(state.now))return deny('unavailable');
 if(!policy.symbols.includes(order.symbol)||Number(state.quoteAt)>Number(state.now)||Number(state.now)-Number(state.quoteAt)>Number(policy.maxQuoteAgeMs))return deny('quote');
 // Sells are conservatively counted as exposure until an authoritative position ledger proves reduction.
 const reduction=state.verifiedReduction!==undefined||state.exposureReductionMinor!==undefined;
 if(reduction&&(state.verifiedReduction!==true||order.side!=='sell'||!integer(state.exposureReductionMinor)||Number(state.exposureReductionMinor)>Number(state.exposure)))return deny('invalid');
 const projected=reduction?BigInt(state.exposure as number)+BigInt(state.reserved as number)-BigInt(state.exposureReductionMinor as number):BigInt(state.exposure as number)+BigInt(state.reserved as number)+BigInt(order.notional);
 const exposure=projected<=BigInt(Number.MAX_SAFE_INTEGER)?Number(projected):NaN;
 if(!Number.isSafeInteger(exposure)||exposure>Number(policy.maxExposure)||order.notional>Number(policy.maxOrder)||Number(state.dailyLoss)>=Number(policy.maxDailyLoss)||Number(state.orders)>=Number(policy.maxOrders)||Number(state.lastOrderAt)>Number(state.now)||Number(state.now)-Number(state.lastOrderAt)<Number(policy.cooldownMs))return deny('limit');
 return Object.freeze({allowed:true});
}
