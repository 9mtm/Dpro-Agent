require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {tradingPaperResponse}=require('../src/trading-paper-contract.js');
const path='/api/trading-paper/accounts/account';
const fixture=require('./fixtures/trading-paper-mixed.cjs');
test('mixed snapshot preserves signed sell result and distinct units, double projects and strips secrets',()=>{const b=fixture();b.execution.secret='private';b.sellHistory.reservations[0].owner='private';const value=tradingPaperResponse(path,200,b);assert.equal(value.execution.realizedPnLTotal,-109);assert.equal(value.sellHistory.reservations[0].quantityUnits,1);assert.deepEqual(tradingPaperResponse(path,200,value),value);assert.equal(JSON.stringify(value).includes('private'),false);});
test('mixed snapshot refuses inconsistent totals, side links, units, arithmetic and storage disclosure',()=>{for(const mutate of [b=>b.execution.realizedPnLTotal=-108,b=>b.execution.feeTotal=28,b=>b.execution.removedCostTotal=999,b=>b.execution.marketLossTotal=99,b=>b.execution.fills[1].netMinor=892,b=>b.execution.fills[1].realizedPnLMinor=0,b=>b.execution.fills[1].side='buy',b=>b.execution.fills[1].reservationId='buy',b=>b.execution.positions[0].quantityUnits=2,b=>b.sellHistory.reservations[0].quantityUnits=2,b=>b.sellHistory.reservations[0].fillId='other',b=>b.sellHistory.reservations[0].cancelledAt=3,b=>b.execution.fills[1].feeMinor=NaN,b=>b.execution.positions[0].quantityUnits=0,b=>b.execution.buyFillCount=0,b=>b.sellHistory=undefined,b=>b.execution=undefined]){const b=fixture();mutate(b);assert.throws(()=>tradingPaperResponse(path,200,b));}});
test('pending sell reservations reserve units without changing reserved cash, malformed counts refuse',()=>{const b=fixture();b.sellHistory.reservationCount=2;b.sellHistory.pendingCount=1;b.sellHistory.reservedUnits=1;b.sellHistory.reservations.push({id:'pending',policyId:'policy',symbol:'ABC',quantityUnits:1,createdAt:5,status:'pending',cancelledAt:null});assert.equal(tradingPaperResponse(path,200,b).pendingExposure,0);for(const change of [{reservedUnits:0},{pendingCount:0},{reservationCount:3}])assert.throws(()=>tradingPaperResponse(path,200,{...b,sellHistory:{...b.sellHistory,...change}}));});

test('partial fill windows still enforce aggregate market loss floor and nonnegative sell proceeds',()=>{
 const b=fixture(),e=b.execution;b.reservationCount=201;
 b.reservations=Array.from({length:200},(_,i)=>({...b.reservations[0],id:'r'+i,fillId:'f'+i}));
 e.fills=Array.from({length:200},(_,i)=>({...e.fills[0],id:'f'+i,reservationId:'r'+i}));
 Object.assign(e,{fillCount:202,buyFillCount:201,buyGrossTotal:402000,buyFeeTotal:4020,feeTotal:4029,positionCost:401000});
 e.positions=[{symbol:'ABC',quantityUnits:401,costMinor:401000}];b.exposure=401000;b.totalExposure=401000;
 assert.equal(tradingPaperResponse(path,200,b).execution.fillCount,202);
 assert.throws(()=>tradingPaperResponse(path,200,{...b,execution:{...e,marketLossTotal:0}}));
 assert.throws(()=>tradingPaperResponse(path,200,{...b,execution:{...e,sellFeeTotal:901,feeTotal:4921,realizedPnLTotal:-1001}}));
});
