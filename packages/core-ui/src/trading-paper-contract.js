const base='/api/trading-paper/accounts/';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x))&&Reflect.ownKeys(x).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value'));
const uint=x=>Number.isSafeInteger(x)&&x>=0;
const fail=()=>{throw Error('paper_account_protocol');};
export function tradingPaperRoute(path){if(path==='/api/trading-paper/accounts')return {kind:'accounts'};if(path==='/api/trading-paper/availability')return {kind:'availability'};if(typeof path!=='string'||!path.startsWith(base))return null;const encoded=path.slice(base.length);let accountId;try{accountId=decodeURIComponent(encoded);}catch{return null;}return id(accountId)&&encodeURIComponent(accountId)===encoded?{accountId}:null;}
export const allowedTradingPaper=(method,path,body)=>!!tradingPaperRoute(path)&&method==='GET'&&body===undefined;
/** Bounded read projection shared by the desktop bridge and renderer. Never conveys order authority. */
export function tradingPaperResponse(path,status,body){
 const route=tradingPaperRoute(path);if(!route)return fail();
 if(status!==200)return {code:'paper_account_unavailable'};
 if(route.kind==='accounts'){if(!record(body)||body.mode!=='paper'||!Array.isArray(body.accounts)||body.accounts.length>100||typeof body.hasMore!=='boolean'||(body.hasMore&&body.accounts.length!==100))return fail();const accounts=body.accounts.map(a=>{if(!record(a)||!id(a.accountId)||typeof a.currency!=='string'||!/^[A-Z]{3}$/.test(a.currency)||typeof a.appEnabled!=='boolean'||typeof a.stopped!=='boolean')return fail();return {accountId:a.accountId,currency:a.currency,appEnabled:a.appEnabled,stopped:a.stopped};});if(new Set(accounts.map(a=>a.accountId)).size!==accounts.length)return fail();return {mode:'paper',accounts,hasMore:body.hasMore};}
 if(route.kind==='availability'){if(!record(body)||body.appId!=='trading'||body.mode!=='paper'||typeof body.version!=='string'||body.version.length>40||!/^\d+\.\d+\.\d+$/.test(body.version)||!['demo_only','not_provisioned','incompatible','disabled','ready'].includes(body.state)||body.readAccounts!==['ready','disabled'].includes(body.state)||body.executeOrders!==false)return fail();return {appId:'trading',version:body.version,mode:'paper',state:body.state,readAccounts:body.readAccounts,executeOrders:false};}
 if(!record(body)||body.ok!==true||body.accountId!==route.accountId||body.mode!=='paper'||typeof body.currency!=='string'||!/^[A-Z]{3}$/.test(body.currency))return fail();
 const numbers=['cash','availableCash','exposure','pendingExposure','totalExposure','pendingCount','appRevision','reservationCount'];
 if(numbers.some(k=>!uint(body[k]))||body.appRevision<1||typeof body.appEnabled!=='boolean'||typeof body.stopped!=='boolean'||body.availableCash>body.cash||body.cash-body.availableCash!==body.pendingExposure||!Number.isSafeInteger(body.exposure+body.pendingExposure)||body.totalExposure!==body.exposure+body.pendingExposure||body.pendingCount>body.reservationCount)return fail();
 if(!Array.isArray(body.policies)||body.policies.length>100||!Array.isArray(body.reservations)||body.reservations.length>200||body.reservations.length!==Math.min(200,body.reservationCount))return fail();
 const policies=body.policies.map(p=>{if(!record(p)||!id(p.id)||!uint(p.revision)||p.revision<1||typeof p.enabled!=='boolean'||!uint(p.expiresAt))return fail();return {id:p.id,revision:p.revision,enabled:p.enabled,expiresAt:p.expiresAt};});
 const reservations=body.reservations.map(r=>{if(!record(r)||!id(r.id)||!id(r.policyId)||!uint(r.notional)||r.notional<1||!uint(r.createdAt)||!['pending','cancelled'].includes(r.status)||(r.status==='pending'?r.cancelledAt!==null:!uint(r.cancelledAt)||r.cancelledAt<r.createdAt))return fail();return {id:r.id,policyId:r.policyId,notional:r.notional,createdAt:r.createdAt,status:r.status,cancelledAt:r.cancelledAt};});
 if(new Set(policies.map(p=>p.id)).size!==policies.length||new Set(reservations.map(r=>r.id)).size!==reservations.length)return fail();
 const visiblePending=reservations.filter(r=>r.status==='pending'),visibleTotal=visiblePending.reduce((sum,r)=>sum+r.notional,0);
 if(!Number.isSafeInteger(visibleTotal)||visiblePending.length>body.pendingCount||visibleTotal>body.pendingExposure||(body.reservationCount===reservations.length&&(visiblePending.length!==body.pendingCount||visibleTotal!==body.pendingExposure)))return fail();
 return {ok:true,accountId:route.accountId,mode:'paper',currency:body.currency,...Object.fromEntries(numbers.map(k=>[k,body[k]])),appEnabled:body.appEnabled,stopped:body.stopped,policies,reservations};
}
