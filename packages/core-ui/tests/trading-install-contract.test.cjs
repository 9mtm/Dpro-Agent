require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {tradingInstallRoute,allowedTradingInstall,tradingInstallResponse}=require('../src/trading-install-contract.js');
const {allowedRequest,SessionClient}=require('../src/session.ts'),{allowed,createApplicationServer}=require('../scripts/application-server.cjs');
const base='/api/trading-paper/installation',reviewId='00000000-0000-4000-8000-000000000001',installationId='00000000-0000-4000-8000-000000000002',now=Date.now();
const input={action:'install',expectedRevision:0,manifestDigest:'a'.repeat(64),capabilities:['paper.account.read','paper.bot.manage']};
const review={ok:true,id:reviewId,expiresAt:now+300000,appId:'trading',version:'1.0.0',mode:'paper',...input,currentState:'not_provisioned',schemaDigest:'b'.repeat(64),schemaVersion:1,implementationId:'bundled.trading.paper.v1',dataEffects:{verifiesSchemaTables:15,createsAccounts:false,seedsCash:false,retainsData:true},runtimeConnected:false,createsAccounts:false,retainsData:true};
const status={appId:'trading',version:'1.0.0',mode:'paper',state:'provisioned',revision:1,installationId,capabilities:input.capabilities,access:{state:'ready',readAccounts:true,readBots:true,manageBots:true,executeOrders:false},runtimeConnected:false,createsAccounts:false,retainsData:true};
test('exact bounded installation routes and inputs cross only intended gates',()=>{
 const valid=[['GET',base],['POST',base+'/reviews',input],['GET',base+'/reviews/'+reviewId],['POST',base+'/reviews/'+reviewId+'/challenge',{}],['POST',base+'/reviews/'+reviewId+'/complete',{challenge:'c'.repeat(43),code:'123456'}],['POST',base+'/reviews/'+reviewId+'/apply',{receipt:'r'.repeat(43)}],['POST',base+'/reviews',{...input,action:'disable',expectedRevision:1,capabilities:[]}]];
 for(const gate of [allowedTradingInstall,allowedRequest,allowed]){
  for(const args of valid)assert.equal(gate(...args),true,JSON.stringify(args));
  for(const path of [base+'/',base+'?owner=other',base+'/install',base+'/tick',base+'/execute',base+'/reviews/'+reviewId+'?x=1',base+'/reviews/%30'+reviewId.slice(1),base+'/reviews/'+reviewId+'\n',base+'/reviews/'+reviewId+'/apply\r',base+'/reviews/'+reviewId+'/challenge\n',base+'/reviews/'+reviewId+'/complete\n','https://evil.invalid'+base])for(const method of ['GET','POST'])assert.equal(gate(method,path,{}),false,path);
  for(const body of [{...input,ownerId:'other'},{...input,manifestDigest:'a'.repeat(64)+'\n'},{...input,capabilities:['paper.bot.manage']},{...input,capabilities:['paper.account.read','paper.account.read']},{...input,action:'enable'},{...input,action:'disable',expectedRevision:2,capabilities:[]},{...input,expectedRevision:NaN},{...input,action:'disable',expectedRevision:1}])assert.equal(gate('POST',base+'/reviews',body),false);
  assert.equal(gate('GET',base,{}),false);assert.equal(gate('POST',base+'/reviews/'+reviewId+'/complete',{challenge:'c'.repeat(43),code:'123456\n'}),false);
 }
 let accessed=0;const evil={...input};Object.defineProperty(evil,'capabilities',{enumerable:true,get(){accessed++;return input.capabilities;}});assert.equal(allowedTradingInstall('POST',base+'/reviews',evil),false);assert.equal(accessed,0);assert.equal(tradingInstallRoute(base+'/reviews/'+reviewId).kind,'review');
});
test('sanitized status review and proof results are idempotent under double projection',()=>{
 const cases=[[base,status],[base+'/reviews',review],[base+'/reviews/'+reviewId,review],[base+'/reviews/'+reviewId+'/challenge',{challenge:'c'.repeat(43),expiresAt:now+120000}],[base+'/reviews/'+reviewId+'/complete',{receipt:'r'.repeat(43),expiresAt:now+120000}],[base+'/reviews/'+reviewId+'/apply',{ok:true,reviewId,operationId:reviewId,result:{installationId,revision:1,status:'provisioned'},replayed:false}]];
 for(const [path,value]of cases){const safe=tradingInstallResponse(path,200,{...value,sessionHash:'private',policyJSON:'private',token:'private'});assert.doesNotMatch(JSON.stringify(safe),/private/);assert.deepEqual(tradingInstallResponse(path,200,safe),safe);}
 assert.deepEqual(tradingInstallResponse(base,503,{code:'private',error:'private'}),{code:'paper_installation_unavailable'});assert.deepEqual(tradingInstallResponse(base+'/reviews/'+reviewId+'/complete',403,{code:'verification_refused',raw:'private'}),{code:'verification_refused'});
});
test('cross-field authority runtime revision and review mismatches fail closed',()=>{
 for(const patch of [{runtimeConnected:true},{createsAccounts:true},{retainsData:false},{mode:'live'},{revision:2},{installationId:null},{access:{...status.access,executeOrders:true}},{access:{...status.access,manageBots:false}},{capabilities:['paper.account.read']}])assert.throws(()=>tradingInstallResponse(base,200,{...status,...patch}));
 const disabled={...status,state:'disabled',revision:2,capabilities:[],access:{...status.access,state:'disabled',manageBots:false}};assert.equal(tradingInstallResponse(base,200,disabled).access.readBots,true);
 const absent={...status,state:'not_provisioned',revision:0,installationId:null,capabilities:[],access:{state:'not_provisioned',readAccounts:false,readBots:false,manageBots:false,executeOrders:false}};assert.equal(tradingInstallResponse(base,200,absent).revision,0);
 for(const patch of [{id:installationId},{runtimeConnected:true},{schemaVersion:2},{implementationId:'legacy'},{dataEffects:{...review.dataEffects,seedsCash:true}},{currentState:'provisioned'},{action:'disable',expectedRevision:2,currentState:'disabled',capabilities:[]},{manifestDigest:'c'.repeat(65)}])assert.throws(()=>tradingInstallResponse(base+'/reviews/'+reviewId,200,{...review,...patch}));
});
async function client(role='owner',mode='live',transport=async()=>({status:200,body:status})){
 const user={id:'person',username:'Person',email:'person@example.invalid',role},wire=async request=>request.path==='/api/auth/login'?{status:200,body:{token:'fixture',deviceToken:'d'.repeat(43),user}}:request.path==='/api/auth/me'?{status:200,body:{user}}:transport(request);
 const c=new SessionClient({live:wire,mock:wire});c.selectMode(mode);await c.login(user.email,'Fixture auth only');return c;
}
test('session forbids member and mock authority before transport and discards stale live response',async()=>{
 let calls=0;for(const [role,mode]of [['user','live'],['owner','mock']]){const c=await client(role,mode,async()=>{calls++;return {status:200,body:status};});await assert.rejects(c.request({method:'GET',path:base}));c.cancel();}assert.equal(calls,0);
 let release,entered;const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r),c=await client('owner','live',async()=>{calls++;entered();await waiting;return {status:200,body:status};});
 const pending=c.request({method:'GET',path:base});await started;c.cancel();release();await assert.rejects(pending);assert.equal(calls,1);
});
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
test('real isolated bridge sanitizes installation status and blocks forged execution before upstream',async t=>{
 let calls=0;const backend=http.createServer(async(req,res)=>{calls++;for await(const _ of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...status,raw:'private'}));});const port=await listen(backend),bridge=createApplicationServer({channel:'candidate',upstreamPort:port}),bridgePort=await listen(bridge);t.after(async()=>{await close(bridge);await close(backend);});
 const request=(path,method='GET',body)=>new Promise((resolve,reject)=>{const bytes=body===undefined?undefined:JSON.stringify(body),req=http.request({hostname:'127.0.0.1',port:bridgePort,path,method,headers:{Origin:'http://127.0.0.1:'+bridgePort,Authorization:'Bearer fixture',Accept:'application/json',...(bytes?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.once('error',reject);req.end(bytes);});
 const response=await request(base);assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),status);const before=calls;assert.ok((await request(base+'/tick','POST',{})).status>=400);assert.ok((await request(base+'/reviews','POST',{...input,runtime:true})).status>=400);assert.equal(calls,before);
});
