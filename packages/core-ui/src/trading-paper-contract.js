import {projectSellSnapshot} from './trading-paper-sell-contract.js';
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
 const reservations=body.reservations.map(r=>{
  if(!record(r)||!id(r.id)||!id(r.policyId)||!uint(r.notional)||r.notional<1||!uint(r.createdAt)||!['pending','cancelled','filled'].includes(r.status))return fail();
  if(r.status==='cancelled'?!uint(r.cancelledAt)||r.cancelledAt<r.createdAt:r.cancelledAt!==null)return fail();
  const value={id:r.id,policyId:r.policyId,notional:r.notional,createdAt:r.createdAt,status:r.status,cancelledAt:r.cancelledAt};
  if(r.status==='filled'){if(!id(r.fillId)||!uint(r.filledAt)||r.filledAt<r.createdAt)return fail();return {...value,fillId:r.fillId,filledAt:r.filledAt};}
  return value;
 });
 if(new Set(policies.map(p=>p.id)).size!==policies.length||new Set(reservations.map(r=>r.id)).size!==reservations.length)return fail();
 const visiblePending=reservations.filter(r=>r.status==='pending'),visibleTotal=visiblePending.reduce((sum,r)=>sum+r.notional,0);
 if(!Number.isSafeInteger(visibleTotal)||visiblePending.length>body.pendingCount||visibleTotal>body.pendingExposure||(body.reservationCount===reservations.length&&(visiblePending.length!==body.pendingCount||visibleTotal!==body.pendingExposure)))return fail();
 if(record(body.execution)&&body.execution.version===2){const mixed=projectSellSnapshot(body,reservations);return {ok:true,accountId:route.accountId,mode:'paper',currency:body.currency,...Object.fromEntries(numbers.map(k=>[k,body[k]])),appEnabled:body.appEnabled,stopped:body.stopped,policies,reservations,...mixed};}
 if(body.sellHistory!==undefined)return fail();
 let execution;
 const filled=reservations.filter(r=>r.status==='filled');
 if(body.execution!==undefined){
  const e=body.execution;
  if(!record(e)||e.version!==1||e.mode!=='paper'||!uint(e.fillCount)||e.fillCount<1||e.fillCount>body.reservationCount||!uint(e.feeTotal)||!uint(e.positionCount)||!uint(e.positionCost)||!uint(e.untrackedExposure)||e.positionCost>body.exposure||e.untrackedExposure!==body.exposure-e.positionCost||!Array.isArray(e.fills)||e.fills.length!==Math.min(200,e.fillCount)||!Array.isArray(e.positions)||e.positions.length!==Math.min(100,e.positionCount))return fail();
  const fills=e.fills.map(f=>{
   if(!record(f)||!id(f.id)||!id(f.reservationId)||!id(f.symbol)||f.side!=='buy'||![f.quantityUnits,f.priceMinor,f.totalMinor].every(v=>uint(v)&&v>0)||!uint(f.feeMinor)||!uint(f.createdAt))return fail();
   const debit=BigInt(f.quantityUnits)*BigInt(f.priceMinor)+BigInt(f.feeMinor);if(debit>BigInt(Number.MAX_SAFE_INTEGER)||debit!==BigInt(f.totalMinor))return fail();
   return {id:f.id,reservationId:f.reservationId,symbol:f.symbol,side:'buy',quantityUnits:f.quantityUnits,priceMinor:f.priceMinor,feeMinor:f.feeMinor,totalMinor:f.totalMinor,createdAt:f.createdAt};
  });
  const positions=e.positions.map(p=>{if(!record(p)||!id(p.symbol)||!uint(p.quantityUnits)||p.quantityUnits<1||!uint(p.costMinor)||p.costMinor<1)return fail();return {symbol:p.symbol,quantityUnits:p.quantityUnits,costMinor:p.costMinor};});
  if(new Set(fills.map(f=>f.id)).size!==fills.length||new Set(fills.map(f=>f.reservationId)).size!==fills.length||new Set(positions.map(p=>p.symbol)).size!==positions.length||new Set(filled.map(r=>r.fillId)).size!==filled.length||filled.length>e.fillCount)return fail();
  const gross=fills.reduce((sum,f)=>sum+BigInt(f.quantityUnits)*BigInt(f.priceMinor),0n),fees=fills.reduce((sum,f)=>sum+BigInt(f.feeMinor),0n),cost=positions.reduce((sum,p)=>sum+BigInt(p.costMinor),0n);
  if(gross>BigInt(e.positionCost)||(fills.length===e.fillCount&&gross!==BigInt(e.positionCost))||fees>BigInt(e.feeTotal)||cost>BigInt(e.positionCost)||(fills.length===e.fillCount&&fees!==BigInt(e.feeTotal))||(positions.length===e.positionCount&&cost!==BigInt(e.positionCost)))return fail();
  const bySymbol=new Map();for(const f of fills){const v=bySymbol.get(f.symbol)??{units:0n,cost:0n};v.units+=BigInt(f.quantityUnits);v.cost+=BigInt(f.quantityUnits)*BigInt(f.priceMinor);bySymbol.set(f.symbol,v);}
  if(fills.length===e.fillCount&&bySymbol.size!==e.positionCount)return fail();
  for(const p of positions){const v=bySymbol.get(p.symbol);if(v&&(v.units>BigInt(p.quantityUnits)||v.cost>BigInt(p.costMinor)))return fail();if(fills.length===e.fillCount&&(!v||v.units!==BigInt(p.quantityUnits)||v.cost!==BigInt(p.costMinor)))return fail();}
  if(positions.length===e.positionCount&&[...bySymbol.keys()].some(symbol=>!positions.some(p=>p.symbol===symbol)))return fail();
  if(body.reservationCount===reservations.length&&filled.length!==e.fillCount)return fail();
  for(const f of fills){const r=reservations.find(r=>r.id===f.reservationId);if(r&&(r.status!=='filled'||r.fillId!==f.id||r.filledAt!==f.createdAt||f.totalMinor>r.notional||f.createdAt<r.createdAt))return fail();}
  for(const r of filled){const f=fills.find(f=>f.id===r.fillId);if(f&&(f.reservationId!==r.id||f.createdAt!==r.filledAt))return fail();if(fills.length===e.fillCount&&!f)return fail();}
  execution={version:1,mode:'paper',fillCount:e.fillCount,feeTotal:e.feeTotal,positionCount:e.positionCount,positionCost:e.positionCost,untrackedExposure:e.untrackedExposure,fills,positions};
 }else if(filled.length)return fail();
 return {ok:true,accountId:route.accountId,mode:'paper',currency:body.currency,...Object.fromEntries(numbers.map(k=>[k,body[k]])),appEnabled:body.appEnabled,stopped:body.stopped,policies,reservations,...(execution?{execution}:{})};
}
