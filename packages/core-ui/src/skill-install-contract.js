const rec=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,k)=>rec(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash=(v,n=64)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const int=(v,min=0,max=2147483646)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const time=v=>int(v,1,Number.MAX_SAFE_INTEGER);
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v);
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(v);
const sourcePath=v=>typeof v==='string'&&v.length<=300&&v.split('/').length>=2&&v.split('/').length<=6&&v.split('/')[0]==='skills'&&v.split('/').every(p=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p)&&!p.includes('..'));
const source=v=>exact(v,['commit','sourcePath','targetName'])&&hash(v.commit,40)&&!/^0+$/.test(v.commit)&&sourcePath(v.sourcePath)&&name(v.targetName);
const base='/api/skills/reviewed-installs';
export const skillInstallRoute=p=>typeof p==='string'&&(p===base||p.startsWith(base+'/')||p.startsWith(base+'?'));
function route(p){if(p===base+'/catalogue')return {phase:'catalogue'};if(p===base+'/stage')return {phase:'stage'};const m=typeof p==='string'&&p.match(/^\/api\/skills\/reviewed-installs\/([^/]+)(?:\/(challenge|complete|apply))?$/);return m&&uuid(m[1])?{id:m[1],phase:m[2]??'review'}:null;}
export function allowedSkillInstall(method,path,body){const r=route(path);if(!r)return false;if(r.phase==='review'||r.phase==='catalogue')return method==='GET'&&body===undefined;if(method!=='POST')return false;if(r.phase==='stage')return source(body);if(r.phase==='challenge')return exact(body,[]);if(r.phase==='complete')return exact(body,['challenge','code'])&&token(body.challenge)&&typeof body.code==='string'&&/^\d{6}$/.test(body.code);return exact(body,['receipt'])&&token(body.receipt);}
const fail=()=>{throw Error('protocol');};
/** The bridge and renderer accept only the reviewed document domain, never auth/session material. */
export function skillInstallResponse(path,status,body){
 const r=route(path);if(!r||!rec(body))return fail();
 if(status!==200)return {code:['unauthenticated','forbidden','owner_verification_required','rate_limited','verification_refused','invalid_skill_installation','skill_source_unavailable','skill_installation_unavailable'].includes(body.code)?body.code:'skill_installation_unavailable'};
 if(r.phase==='catalogue'){if(!exact(body,['provider','commit','skills'])||body.provider!=='anthropic-skills'||!hash(body.commit,40)||/^0+$/.test(body.commit)||!Array.isArray(body.skills)||body.skills.length>500||!body.skills.every(s=>source(s)&&s.commit===body.commit)||new Set(body.skills.map(s=>s.targetName)).size!==body.skills.length||new Set(body.skills.map(s=>s.sourcePath)).size!==body.skills.length)return fail();return {provider:body.provider,commit:body.commit,skills:body.skills.map(s=>({...s}))};}
 if(r.phase==='stage'){if(!exact(body,['id','expiresAt'])||!uuid(body.id)||!time(body.expiresAt))return fail();return {...body};}
 if(r.phase==='challenge'||r.phase==='complete'){const k=r.phase==='challenge'?'challenge':'receipt';if(!exact(body,[k,'expiresAt'])||!token(body[k])||!time(body.expiresAt))return fail();return {[k]:body[k],expiresAt:body.expiresAt};}
 if(r.phase==='apply'){if(!exact(body,['reviewId','skillId','name','revision','hash'])||body.reviewId!==r.id||!uuid(body.skillId)||!name(body.name)||!int(body.revision,1,2147483647)||!hash(body.hash))return fail();return {...body};}
 if(!exact(body,['id','expiresAt','reviewHash','operation','files'])||body.id!==r.id||!time(body.expiresAt)||!hash(body.reviewHash))return fail();
 const o=body.operation;if(!exact(o,['kind','version','source','target','contentHash','byteLength','effect','enabled','bundle'])||o.kind!=='skill_install'||o.version!==1||o.effect!=='store-markdown-only'||o.enabled!==false||!hash(o.contentHash)||!int(o.byteLength,1,200000))return fail();
 const s=o.source,t=o.target,b=o.bundle;if(!exact(s,['provider','commit','path'])||s.provider!=='anthropic-skills'||!source({commit:s.commit,sourcePath:s.path,targetName:t?.name})||!exact(t,['name','expectedRevision','previousContentHash'])||!int(t.expectedRevision)||!(t.expectedRevision===0?t.previousContentHash===null:hash(t.previousContentHash)))return fail();
 if(!exact(b,['hash','name','description','version','redactions','byteLength'])||!hash(b.hash)||b.name!==t.name||!text(b.description,2000)||!text(b.version,80)||!int(b.redactions)||!int(b.byteLength,1,200000)||!Array.isArray(body.files)||body.files.length!==1)return fail();
 const f=body.files[0];if(!exact(f,['path','content'])||f.path!=='SKILL.md'||!text(f.content,200000)||new TextEncoder().encode(f.content).length!==b.byteLength)return fail();
 return {id:body.id,expiresAt:body.expiresAt,reviewHash:body.reviewHash,operation:{...o,source:{...s},target:{...t},bundle:{...b}},files:[{path:f.path,content:f.content}]};
}
