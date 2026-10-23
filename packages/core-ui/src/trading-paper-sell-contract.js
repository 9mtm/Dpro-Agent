const MAX=BigInt(Number.MAX_SAFE_INTEGER);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x))&&Reflect.ownKeys(x).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value'));
const uint=x=>Number.isSafeInteger(x)&&x>=0;
const fail=()=>{throw Error('paper_account_protocol');};
/** Validates and strips the bounded mixed-side read model. It grants no execution authority. */
export function projectSellSnapshot(body,buyReservations){
 const e=body.execution,h=body.sellHistory;
 const totals=['fillCount','buyFillCount','sellFillCount','feeTotal','buyFeeTotal','sellFeeTotal','buyGrossTotal','sellGrossTotal','removedCostTotal','marketLossTotal','positionCount','positionCost','untrackedExposure'];
 if(!record(e)||e.version!==2||e.mode!=='paper'||totals.some(k=>!uint(e[k]))||!Number.isSafeInteger(e.realizedPnLTotal)||e.buyFillCount<1||BigInt(e.fillCount)!==BigInt(e.buyFillCount)+BigInt(e.sellFillCount)||e.buyFillCount>body.reservationCount||BigInt(e.feeTotal)!==BigInt(e.buyFeeTotal)+BigInt(e.sellFeeTotal)||BigInt(e.positionCost)!==BigInt(e.buyGrossTotal)-BigInt(e.removedCostTotal)||BigInt(e.realizedPnLTotal)!==BigInt(e.sellGrossTotal)-BigInt(e.sellFeeTotal)-BigInt(e.removedCostTotal)||e.marketLossTotal>e.removedCostTotal||BigInt(e.marketLossTotal)<(BigInt(e.removedCostTotal)>BigInt(e.sellGrossTotal)?BigInt(e.removedCostTotal)-BigInt(e.sellGrossTotal):0n)||e.sellFeeTotal>e.sellGrossTotal||e.positionCost>body.exposure||e.untrackedExposure!==body.exposure-e.positionCost||!Array.isArray(e.fills)||e.fills.length!==Math.min(200,e.fillCount)||!Array.isArray(e.positions)||e.positions.length!==Math.min(100,e.positionCount))return fail();
 if(!record(h)||!['reservationCount','pendingCount','reservedUnits'].every(k=>uint(h[k]))||h.reservationCount<1||h.pendingCount>h.reservationCount||e.sellFillCount>h.reservationCount||!Array.isArray(h.reservations)||h.reservations.length!==Math.min(200,h.reservationCount))return fail();
 const sellReservations=h.reservations.map(r=>{
  if(!record(r)||!id(r.id)||!id(r.policyId)||!id(r.symbol)||!uint(r.quantityUnits)||r.quantityUnits<1||!uint(r.createdAt)||!['pending','cancelled','filled'].includes(r.status)||(r.status==='cancelled'?!uint(r.cancelledAt)||r.cancelledAt<r.createdAt:r.cancelledAt!==null))return fail();
  const safe={id:r.id,policyId:r.policyId,symbol:r.symbol,quantityUnits:r.quantityUnits,createdAt:r.createdAt,status:r.status,cancelledAt:r.cancelledAt};
  if(r.status==='filled'){if(!id(r.fillId)||!uint(r.filledAt)||r.filledAt<r.createdAt)return fail();return {...safe,fillId:r.fillId,filledAt:r.filledAt};}
  return safe;
 });
 if(new Set([...buyReservations,...sellReservations].map(r=>r.id)).size!==buyReservations.length+sellReservations.length)return fail();
 const pending=sellReservations.filter(r=>r.status==='pending'),reserved=pending.reduce((sum,r)=>sum+BigInt(r.quantityUnits),0n);
 if(pending.length>h.pendingCount||reserved>BigInt(h.reservedUnits)||(sellReservations.length===h.reservationCount&&(pending.length!==h.pendingCount||reserved!==BigInt(h.reservedUnits))))return fail();
 const fills=e.fills.map(f=>{
  if(!record(f)||!id(f.id)||!id(f.reservationId)||!id(f.symbol)||!['buy','sell'].includes(f.side)||![f.quantityUnits,f.priceMinor].every(v=>uint(v)&&v>0)||!uint(f.feeMinor)||!uint(f.createdAt))return fail();
  const gross=BigInt(f.quantityUnits)*BigInt(f.priceMinor);if(gross>MAX)return fail();
  const common={id:f.id,reservationId:f.reservationId,symbol:f.symbol,side:f.side,quantityUnits:f.quantityUnits,priceMinor:f.priceMinor,feeMinor:f.feeMinor,createdAt:f.createdAt};
  if(f.side==='buy'){if(!uint(f.totalMinor)||gross+BigInt(f.feeMinor)!==BigInt(f.totalMinor))return fail();return {...common,totalMinor:f.totalMinor};}
  if(!['grossMinor','netMinor','removedCostMinor','marketLossMinor'].every(k=>uint(f[k]))||!Number.isSafeInteger(f.realizedPnLMinor)||gross!==BigInt(f.grossMinor)||gross-BigInt(f.feeMinor)!==BigInt(f.netMinor)||BigInt(f.netMinor)-BigInt(f.removedCostMinor)!==BigInt(f.realizedPnLMinor)||BigInt(f.marketLossMinor)!==(BigInt(f.removedCostMinor)>gross?BigInt(f.removedCostMinor)-gross:0n))return fail();
  return {...common,grossMinor:f.grossMinor,netMinor:f.netMinor,removedCostMinor:f.removedCostMinor,realizedPnLMinor:f.realizedPnLMinor,marketLossMinor:f.marketLossMinor};
 });
 const positions=e.positions.map(p=>{if(!record(p)||!id(p.symbol)||!uint(p.quantityUnits)||p.quantityUnits<1||!uint(p.costMinor)||p.costMinor<1)return fail();return {symbol:p.symbol,quantityUnits:p.quantityUnits,costMinor:p.costMinor};});
 if(new Set(fills.map(f=>f.id)).size!==fills.length||new Set(fills.map(f=>f.reservationId)).size!==fills.length||new Set(positions.map(p=>p.symbol)).size!==positions.length)return fail();
 if(positions.length===e.positionCount){const pendingBySymbol=new Map();for(const r of pending)pendingBySymbol.set(r.symbol,(pendingBySymbol.get(r.symbol)??0n)+BigInt(r.quantityUnits));for(const [symbol,units] of pendingBySymbol){const p=positions.find(p=>p.symbol===symbol);if(!p||units>BigInt(p.quantityUnits))return fail();}}
 const sum=(rows,key)=>rows.reduce((n,r)=>n+BigInt(r[key]),0n),buys=fills.filter(f=>f.side==='buy'),sells=fills.filter(f=>f.side==='sell'),buyGross=buys.reduce((n,f)=>n+BigInt(f.quantityUnits)*BigInt(f.priceMinor),0n),allVisible=fills.length===e.fillCount;
 for(const [visible,total] of [[BigInt(buys.length),e.buyFillCount],[BigInt(sells.length),e.sellFillCount],[buyGross,e.buyGrossTotal],[sum(buys,'feeMinor'),e.buyFeeTotal],[sum(sells,'feeMinor'),e.sellFeeTotal],[sum(sells,'grossMinor'),e.sellGrossTotal],[sum(sells,'removedCostMinor'),e.removedCostTotal],[sum(sells,'marketLossMinor'),e.marketLossTotal]])if(visible>BigInt(total)||(allVisible&&visible!==BigInt(total)))return fail();
 if(allVisible&&sum(sells,'realizedPnLMinor')!==BigInt(e.realizedPnLTotal))return fail();
 const visibleCost=sum(positions,'costMinor');if(visibleCost>BigInt(e.positionCost)||(positions.length===e.positionCount&&visibleCost!==BigInt(e.positionCost)))return fail();
 const grouped=new Map();for(const f of fills){const p=grouped.get(f.symbol)??{units:0n,cost:0n};p.units+=(f.side==='buy'?1n:-1n)*BigInt(f.quantityUnits);p.cost+=f.side==='buy'?BigInt(f.quantityUnits)*BigInt(f.priceMinor):-BigInt(f.removedCostMinor);grouped.set(f.symbol,p);}
 if(allVisible){const open=[...grouped].filter(([,p])=>p.units!==0n||p.cost!==0n);if(open.some(([,p])=>p.units<1n||p.cost<1n)||open.length!==e.positionCount)return fail();for(const p of positions){const g=grouped.get(p.symbol);if(!g||g.units!==BigInt(p.quantityUnits)||g.cost!==BigInt(p.costMinor))return fail();}}
 const allReservations=[...buyReservations,...sellReservations],filled=allReservations.filter(r=>r.status==='filled');
 if(new Set(filled.map(r=>r.fillId)).size!==filled.length)return fail();
 const buyFilled=buyReservations.filter(r=>r.status==='filled'),sellFilled=sellReservations.filter(r=>r.status==='filled');
 if(buyFilled.length>e.buyFillCount||sellFilled.length>e.sellFillCount||(buyReservations.length===body.reservationCount&&buyFilled.length!==e.buyFillCount)||(sellReservations.length===h.reservationCount&&sellFilled.length!==e.sellFillCount))return fail();
 for(const f of fills){const right=f.side==='buy'?buyReservations:sellReservations,wrong=f.side==='buy'?sellReservations:buyReservations;if(wrong.some(r=>r.id===f.reservationId))return fail();const r=right.find(r=>r.id===f.reservationId);if(r&&(r.status!=='filled'||r.fillId!==f.id||r.filledAt!==f.createdAt||f.createdAt<r.createdAt||(f.side==='buy'?f.totalMinor>r.notional:r.symbol!==f.symbol||r.quantityUnits!==f.quantityUnits)))return fail();}
 for(const r of filled){const f=fills.find(f=>f.id===r.fillId);if(f&&(f.reservationId!==r.id||f.createdAt!==r.filledAt))return fail();if(allVisible&&!f)return fail();}
 return {execution:{version:2,mode:'paper',...Object.fromEntries(totals.map(k=>[k,e[k]])),realizedPnLTotal:e.realizedPnLTotal,fills,positions},sellHistory:{reservationCount:h.reservationCount,pendingCount:h.pendingCount,reservedUnits:h.reservedUnits,reservations:sellReservations}};
}
