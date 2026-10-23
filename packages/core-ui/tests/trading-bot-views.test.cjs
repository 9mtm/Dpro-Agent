require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('../../backend/node_modules/jsdom');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
// jsdom omits these browser dialog methods. React/components/controllers/events remain real.
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
const React=require('../node_modules/react'),{act}=React,{createRoot}=require('../node_modules/react-dom/client');
const {SessionClient}=require('../src/session.ts'),{TradingBotViews}=require('../src/TradingBotViews.tsx');
const base='/api/trading-paper/bots',reviewId='00000000-0000-4000-8000-000000000001',botId='00000000-0000-4000-8000-000000000002';
const unique=(index)=>'saved-'+index;
function descriptor(id=botId){const now=Date.now();return {botId:id,accountId:'account',policyId:'policy',policyRevision:1,appRevision:1,currency:'USD',expiresAt:now+600000,maxSuccessfulTicks:20,cooldownMs:60000,status:'active',successfulTicks:0,lastSuccessAt:null,createdAt:now,running:false};}
async function flush(){await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});}
async function click(node){assert.ok(node,'Expected a rendered interactive element');await act(async()=>{node.click();await new Promise(resolve=>setImmediate(resolve));});await flush();}
async function fill(node,value){assert.ok(node,'Expected a rendered input');await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});}
const text=node=>node.textContent.replace(/\s+/g,' ').trim();
function button(root,name){return [...root.querySelectorAll('button')].find(node=>text(node)===name||node.getAttribute('aria-label')===name);}
function inputByLabel(root,label){return [...root.querySelectorAll('label')].find(node=>text(node).startsWith(label))?.querySelector('input');}
async function fixture(t,initial={}){
 const f={saved:[],listUnavailable:false,partial:false,applyUnknown:false,calls:[],...initial};
 const user={id:'render-owner',username:'Owner',email:'owner@example.invalid',role:'owner'};
 const client=new SessionClient({mock:async request=>{
  if(request.path==='/api/auth/login')return {status:200,body:{token:'fixture-jwt',deviceToken:'d'.repeat(43),user}};
  if(request.path==='/api/auth/me')return {status:200,body:{user}};
  f.calls.push({method:request.method,path:request.path,body:request.body});
  if(request.path===base&&request.method==='GET')return f.listUnavailable?{status:503,body:{code:'paper_bot_management_unavailable'}}:{status:200,body:{mode:'paper',running:false,bots:f.partial?Array.from({length:100},(_,i)=>descriptor(unique(i))):f.saved,hasMore:f.partial}};
  if(request.path===base+'/reviews'){
   const draft=request.body;f.review={ok:true,id:reviewId,botId,expiresAt:Date.now()+300000,accountId:draft.accountId,policyId:draft.policyId,policyRevision:draft.policyRevision,appRevision:draft.appRevision,currency:'USD',botExpiresAt:draft.expiresAt,maxSuccessfulTicks:draft.maxSuccessfulTicks,cooldownMs:draft.cooldownMs,symbols:['AAA'],limits:{symbols:['AAA'],maxOrder:1000,maxExposure:5000,maxDailyLoss:100,maxOrders:10,cooldownMs:0,maxQuoteAgeMs:5000},execution:{feeBps:100,slippageBps:10,unitScale:1}};
   return {status:200,body:f.review};
  }
  if(request.path.endsWith('/challenge'))return {status:200,body:{challenge:'c'.repeat(43),expiresAt:Date.now()+300000}};
  if(request.path.endsWith('/complete'))return {status:200,body:{receipt:'r'.repeat(43),expiresAt:Date.now()+120000}};
  if(request.path.endsWith('/apply')){if(f.applyUnknown)throw Error('Fixture lost response');f.saved=[{...descriptor(),accountId:f.review.accountId,policyId:f.review.policyId,policyRevision:f.review.policyRevision,appRevision:f.review.appRevision,expiresAt:f.review.botExpiresAt,maxSuccessfulTicks:f.review.maxSuccessfulTicks,cooldownMs:f.review.cooldownMs}];return {status:200,body:{ok:true,reviewId,botId,replayed:false}};}
  const action=request.path.match(/\/([^/]+)\/(stop|revoke)$/);if(action){if(f.stopWait)await f.stopWait;const id=decodeURIComponent(action[1]),status=action[2]==='stop'?'stopped':'revoked';f.saved=f.saved.map(row=>row.botId===id?{...row,status}:row);return {status:200,body:{mode:'paper',botId:id,status,running:false}};}
  throw Error('Unexpected fixture request');
 }});
 client.selectMode('mock');await client.login(user.email,'Fixture only');assert.equal(client.getSnapshot().phase,'authenticated');
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>{root.render(React.createElement(TradingBotViews,{client,active:true}));});await flush();
 t.after(async()=>{await act(async()=>root.unmount());client.cancel();container.remove();});
 return {...f,get saved(){return f.saved;},set partial(value){f.partial=value;},set applyUnknown(value){f.applyUnknown=value;},set listUnavailable(value){f.listUnavailable=value;},client,container,root,calls:f.calls};
}
async function reviewed(f){
 await click(button(f.container,'Review a bot'));const dialog=f.container.querySelector('dialog');assert.ok(dialog?.open);
 await fill(inputByLabel(dialog,'Account reference'),'account');await fill(inputByLabel(dialog,'Policy reference'),'policy');
 const expiry=new Date(Date.now()+600000);expiry.setSeconds(0,0);const local=new Date(expiry.getTime()-expiry.getTimezoneOffset()*60000).toISOString().slice(0,16);
 await fill(inputByLabel(dialog,'Expiry (local time)'),local);await click(button(dialog,'Stage review'));
 assert.match(text(f.container),/Fee \/ slippage/);assert.ok(button(f.container,'Verify identity'));
 await click(button(f.container,'Verify identity'));await fill(inputByLabel(f.container,'Authenticator code'),'123456');await click(button(f.container,'Verify code'));
 assert.ok(button(f.container,'Authorize paper bot'));assert.match(text(f.container),/Identity verified/);
}

test('mounted review and TOTP workflow never applies until explicit authorization; saved stop requires confirmation',async t=>{
 const f=await fixture(t);assert.match(text(f.container),/No saved paper bots/);await reviewed(f);
 assert.equal(f.calls.filter(call=>call.path.endsWith('/apply')).length,0);assert.equal(f.saved.length,0);
 await click(button(f.container,'Authorize paper bot'));assert.equal(f.calls.filter(call=>call.path.endsWith('/apply')).length,1);assert.equal(f.saved.length,1);assert.equal(f.container.querySelector('dialog'),null);assert.match(text(f.container),/None are running/);
 await click(f.container.querySelector('[data-bot-row]'));assert.match(text(f.container.querySelector('[aria-label="Selected paper bot"]')),/Successful fills0 of 20/);
 await click(button(f.container,'Stop authorization…'));assert.match(text(f.container.querySelector('dialog')),/cannot be undone/);assert.equal(f.calls.filter(call=>call.path.endsWith('/stop')).length,0);
 await click(button(f.container.querySelector('dialog'),'Cancel'));assert.equal(f.calls.filter(call=>call.path.endsWith('/stop')).length,0);
 await click(button(f.container,'Stop authorization…'));await click(button(f.container.querySelector('dialog'),'Stop authorization'));assert.equal(f.calls.filter(call=>call.path.endsWith('/stop')).length,1);assert.equal(f.saved[0].status,'stopped');assert.equal(button(f.container,'Stop authorization…').disabled,true);
});
test('unavailable list still offers confirmed stop by saved reference without granting or staging',async t=>{
 const f=await fixture(t,{listUnavailable:true});assert.match(text(f.container),/unavailable or not configured/);
 await click(f.container.querySelector('summary[aria-label="Bot actions"]'));await click(button(f.container,'Stop by saved reference…'));
 await fill(inputByLabel(f.container,'Saved bot reference'),'paper:reference');assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 await click(button(f.container.querySelector('dialog'),'Stop authorization'));assert.equal(f.calls.filter(call=>call.path===base+'/paper%3Areference/stop').length,1);assert.equal(f.calls.filter(call=>call.path===base+'/reviews').length,0);assert.equal(f.container.querySelector('dialog'),null);
});
test('unknown apply blocks repeating authorization until complete recovery read and explicit acknowledgment',async t=>{
 const f=await fixture(t,{applyUnknown:true});await reviewed(f);await click(button(f.container,'Authorize paper bot'));
 assert.match(text(f.container),/Authorization may have been saved/);assert.equal(button(f.container,'Review a bot').disabled,true);assert.equal(button(f.container,'I reviewed saved bots').disabled,true);
 f.partial=true;await click(button(f.container,'Refresh saved bots'));assert.match(text(f.container),/not a complete recovery list/);assert.equal(button(f.container,'I reviewed saved bots').disabled,true);
 f.partial=false;await click(button(f.container,'Refresh saved bots'));assert.equal(button(f.container,'I reviewed saved bots').disabled,false);assert.equal(button(f.container,'Review a bot').disabled,true);
 await click(button(f.container,'I reviewed saved bots'));assert.equal(button(f.container,'Review a bot').disabled,false);assert.equal(f.calls.filter(call=>call.path.endsWith('/apply')).length,1);
});
test('signout clears a rendered open review and prevents further calls',async t=>{
 const f=await fixture(t);await reviewed(f);const count=f.calls.length;assert.ok(f.container.querySelector('dialog'));await act(async()=>f.client.cancel());await flush();assert.equal(f.container.textContent,'');assert.equal(f.container.querySelector('dialog'),null);assert.equal(f.calls.length,count);
});

test('late stop success after Cancel cannot close or clear a newly opened review dialog',async t=>{
 let release;const stopWait=new Promise(resolve=>release=resolve),f=await fixture(t,{saved:[descriptor()],stopWait});
 await click(f.container.querySelector('[data-bot-row]'));await click(button(f.container,'Stop authorization…'));await click(button(f.container.querySelector('dialog'),'Stop authorization'));
 assert.equal(inputByLabel(f.container,'Saved bot reference').disabled,true);assert.equal(f.calls.filter(call=>call.path.endsWith('/stop')).length,1);
 await click(button(f.container.querySelector('dialog'),'Cancel'));await click(button(f.container,'Review a bot'));await fill(inputByLabel(f.container,'Account reference'),'new-account');
 await act(async()=>{release();await new Promise(resolve=>setImmediate(resolve));});await flush();
 const dialog=f.container.querySelector('dialog');assert.ok(dialog?.open);assert.match(text(dialog),/Review paper bot/);assert.equal(inputByLabel(dialog,'Account reference').value,'new-account');assert.equal(f.calls.filter(call=>call.path===base+'/reviews').length,0);
});
test.after(()=>dom.window.close());
