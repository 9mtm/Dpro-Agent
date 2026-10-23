/** Exact reviewed bundled-paper installation transport. No runtime or execution capability. */
const base='/api/trading-paper/installation';
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const exact=(v,keys)=>record(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uint=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const token=v=>typeof v==='string'&&v.length===43&&/^[A-Za-z0-9_-]{43}$/.test(v);
const caps=v=>Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length<=2&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>Object.getOwnPropertyDescriptor(v,i)).every(d=>d&&Object.hasOwn(d,'value')&&['paper.account.read','paper.bot.manage'].includes(d.value))&&new Set(v).size===v.length;
const bytes=(v,max)=>{try{return new TextEncoder().encode(JSON.stringify(v)).length<=max;}catch{return false;}};
const fail=()=>{throw Error('paper_install_protocol');};
export function tradingInstallRoute(path){
 if(typeof path!=='string'||/[\x00-\x20\x7f]/.test(path))return null;
 if(path===base)return {kind:'status'};
 if(path===base+'/reviews')return {kind:'stage'};
 const match=path.match(/^\/api\/trading-paper\/installation\/reviews\/([^/]+)(?:\/(challenge|complete|apply))?$/);
 return match&&uuid(match[1])?{kind:match[2]??'review',reviewId:match[1]}:null;
}
export function allowedTradingInstall(method,path,body){
 const route=tradingInstallRoute(path);if(!route)return false;
 if(['status','review'].includes(route.kind))return method==='GET'&&body===undefined;
 if(method!=='POST')return false;
 if(route.kind==='stage')return exact(body,['action','expectedRevision','manifestDigest','capabilities'])&&hash(body.manifestDigest)&&caps(body.capabilities)&&uint(body.expectedRevision,0,2)
  &&(body.action==='install'?body.expectedRevision===0&&body.capabilities.includes('paper.account.read'):(body.action==='disable'?body.expectedRevision===1:body.action==='remove_retained'&&body.expectedRevision>=1)&&body.capabilities.length===0)&&bytes(body,2048);
 if(route.kind==='challenge')return exact(body,[]);
 if(route.kind==='complete')return exact(body,['challenge','code'])&&token(body.challenge)&&typeof body.code==='string'&&body.code.length===6&&/^\d{6}$/.test(body.code);
 return route.kind==='apply'&&exact(body,['receipt'])&&token(body.receipt);
}
function access(value){
 if(!record(value)||!['not_provisioned','disabled','ready'].includes(value.state)||value.executeOrders!==false||!['readAccounts','readBots','manageBots'].every(k=>typeof value[k]==='boolean')
  ||value.readBots&&!value.readAccounts||value.manageBots&&(!value.readBots||value.state!=='ready')
  ||value.state==='not_provisioned'&&(value.readAccounts||value.readBots||value.manageBots)||value.state==='disabled'&&(!value.readAccounts||value.manageBots)||value.state==='ready'&&!value.readAccounts)return fail();
 return {state:value.state,readAccounts:value.readAccounts,readBots:value.readBots,manageBots:value.manageBots,executeOrders:false};
}
function status(value){
 if(!record(value)||value.appId!=='trading'||value.version!=='1.0.0'||value.mode!=='paper'||value.runtimeConnected!==false||value.createsAccounts!==false||value.retainsData!==true||!caps(value.capabilities))return fail();
 const grant=access(value.access),absent=value.state==='not_provisioned',removed=value.state==='removed_retained';
 if(absent?value.revision!==0||value.installationId!==null||value.capabilities.length||grant.state!=='not_provisioned':!uuid(value.installationId)||!uint(value.revision,1,3))return fail();
 if(!['not_provisioned','provisioned','disabled','removed_retained'].includes(value.state))return fail();
 if(value.state==='provisioned'&&(value.revision!==1||grant.state!=='ready'||!value.capabilities.includes('paper.account.read')||grant.readBots!==value.capabilities.includes('paper.bot.manage')||grant.manageBots!==grant.readBots))return fail();
 if(value.state==='disabled'&&(value.revision!==2||value.capabilities.length||grant.state!=='disabled'))return fail();
 if(removed&&(value.revision<2||value.capabilities.length||grant.state!=='not_provisioned'))return fail();
 return {appId:'trading',version:'1.0.0',mode:'paper',state:value.state,revision:value.revision,installationId:value.installationId,capabilities:[...value.capabilities],access:grant,runtimeConnected:false,createsAccounts:false,retainsData:true};
}
function review(value,route){
 if(!record(value)||value.ok!==true||!uuid(value.id)||route.reviewId!==undefined&&route.reviewId!==value.id||!uint(value.expiresAt,1)||value.appId!=='trading'||value.version!=='1.0.0'||value.mode!=='paper'
  ||value.runtimeConnected!==false||value.createsAccounts!==false||value.retainsData!==true||!hash(value.schemaDigest)||value.schemaVersion!==1||value.implementationId!=='bundled.trading.paper.v1'
  ||!allowedTradingInstall('POST',base+'/reviews',{action:value.action,expectedRevision:value.expectedRevision,manifestDigest:value.manifestDigest,capabilities:value.capabilities})||!record(value.dataEffects)
  ||value.dataEffects.verifiesSchemaTables!==15||value.dataEffects.createsAccounts!==false||value.dataEffects.seedsCash!==false||value.dataEffects.retainsData!==true)return fail();
 if(value.action==='install'?value.currentState!=='not_provisioned':value.expectedRevision===1?value.currentState!=='provisioned':value.currentState!=='disabled')return fail();
 const result={ok:true,id:value.id,expiresAt:value.expiresAt,appId:'trading',version:'1.0.0',mode:'paper',action:value.action,expectedRevision:value.expectedRevision,capabilities:[...value.capabilities],currentState:value.currentState,manifestDigest:value.manifestDigest,schemaDigest:value.schemaDigest,schemaVersion:1,implementationId:'bundled.trading.paper.v1',dataEffects:{verifiesSchemaTables:15,createsAccounts:false,seedsCash:false,retainsData:true},runtimeConnected:false,createsAccounts:false,retainsData:true};
 return bytes(result,8192)?result:fail();
}
export function tradingInstallResponse(path,httpStatus,body){
 const route=tradingInstallRoute(path);if(!route||!uint(httpStatus,100,599))return fail();
 if(httpStatus!==200){const known=['unauthenticated','forbidden','owner_verification_required','rate_limited','verification_refused','invalid_paper_install_request','paper_installation_unavailable','origin_not_allowed','inactive_user'];return {code:record(body)&&known.includes(body.code)?body.code:'paper_installation_unavailable'};}
 if(route.kind==='status')return status(body);
 if(['stage','review'].includes(route.kind))return review(body,route);
 if(['challenge','complete'].includes(route.kind)){const key=route.kind==='challenge'?'challenge':'receipt';if(!record(body)||!token(body[key])||!uint(body.expiresAt,1))return fail();return {[key]:body[key],expiresAt:body.expiresAt};}
 if(!record(body)||body.ok!==true||body.reviewId!==route.reviewId||!uuid(body.operationId)||typeof body.replayed!=='boolean'||!record(body.result)||!uuid(body.result.installationId)||!uint(body.result.revision,1,3)||!['provisioned','disabled','removed_retained'].includes(body.result.status)
  ||body.result.status==='provisioned'&&body.result.revision!==1||body.result.status==='disabled'&&body.result.revision!==2||body.result.status==='removed_retained'&&body.result.revision<2)return fail();
 return {ok:true,reviewId:route.reviewId,operationId:body.operationId,result:{installationId:body.result.installationId,revision:body.result.revision,status:body.result.status},replayed:body.replayed};
}
