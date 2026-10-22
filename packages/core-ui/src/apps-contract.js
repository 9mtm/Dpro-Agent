export const APPS_CATALOGUE_PATH='/api/marketplace/search?limit=100&offset=0';
export const appsCatalogueRoute=path=>path===APPS_CATALOGUE_PATH;
export const allowedAppsCatalogue=(method,path,body)=>appsCatalogueRoute(path)&&method==='GET'&&body===undefined;
const text=(x,max)=>typeof x==='string'?x.slice(0,max).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,''):'';
export function appsCatalogueResponse(status,body){
 if(status!==200)return {code:'catalogue_unavailable'};
 if(!body||!(body.success===true||Array.isArray(body.items))||!Array.isArray(body.extensions??body.items)||(body.extensions??body.items).length>100||!Number.isSafeInteger(body.total)||body.total<0)throw Error('protocol');
 return {total:body.total,items:(body.extensions??body.items).map(x=>{if(!x||typeof x.id!=='string'||!x.id.length||x.id.length>180||!['app','channel','tool','integration'].includes(x.type))throw Error('protocol');return {id:text(x.id,180),name:text(x.name,180),description:text(x.description,1500),author:text(x.author,180),version:text(x.version,80),type:x.type,permissions:Array.isArray(x.permissions)?x.permissions.filter(p=>typeof p==='string').slice(0,60).map(p=>text(p,120)):[],installed:x.installed===true,verified:x.verified===true};})};
}
export const SOURCE_CATALOGUE_PATH='/api/chat/addons/catalogue';
export const sourceCatalogueRoute=path=>path===SOURCE_CATALOGUE_PATH;
export const allowedSourceCatalogue=(method,path,body)=>sourceCatalogueRoute(path)&&method==='GET'&&body===undefined;
export function sourceCatalogueResponse(status,body){
 if(status!==200)return {code:'catalogue_unavailable'};
 if(!body||!Array.isArray(body.items)||body.items.length>800||!Array.isArray(body.sources)||body.sources.length>60)throw Error('protocol');
 const source=x=>['claude-code','codex'].includes(x);
 return {items:body.items.map(x=>{if(!x||typeof x.id!=='string'||x.id.length>320||!source(x.source)||typeof x.present!=='boolean')throw Error('protocol');return {id:text(x.id,320),name:text(x.name,150),description:text(x.description,1000),publisher:text(x.publisher,150),source:x.source,present:x.present};}),sources:body.sources.map(x=>{if(!x||!source(x.source)||!['limited','local_snapshot'].includes(x.status))throw Error('protocol');return {source:x.source,name:text(x.name,150),status:x.status};})};
}
