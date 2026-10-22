export const COVERAGE_PATH='/api/security/coverage';
export const coverageRoute=path=>path===COVERAGE_PATH;
export const allowedCoverage=(method,path,body)=>coverageRoute(path)&&method==='GET'&&body===undefined;
const categories=['browser','network','message','delete','install','money','settings'];
const paths=['coding_apps','terminal','workspace_scheduler'];
const clean=x=>x.slice(0,240).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'');
export function coverageResponse(status,body){
 if(status!==200)return {code:'coverage_unavailable'};
 if(!body||body.scope!=='workspace_catalogue'||!Array.isArray(body.tools)||body.tools.length>1500||typeof body.limited!=='boolean'||!Array.isArray(body.separatePaths)||body.separatePaths.length>3||!body.separatePaths.every(x=>paths.includes(x)))throw Error('protocol');
 const names=new Set();
 return {scope:'workspace_catalogue',limited:body.limited,separatePaths:[...body.separatePaths],tools:body.tools.map(x=>{
  if(!x||typeof x.name!=='string'||!x.name.length||x.name.length>240||names.has(x.name)||!(x.category===null||categories.includes(x.category))||!['builtin','mcp','extension'].includes(x.origin)||!['independentApproval','executionClass','allowedByServer','selfOnly'].every(k=>typeof x[k]==='boolean'))throw Error('protocol');
  names.add(x.name);return {name:clean(x.name),category:x.category,origin:x.origin,independentApproval:x.independentApproval,executionClass:x.executionClass,allowedByServer:x.allowedByServer,selfOnly:x.selfOnly};
 })};
}
