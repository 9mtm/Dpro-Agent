import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const backend=process.cwd(),root=mkdtempSync(join(tmpdir(),'ap-chat-addons-'));
process.chdir(root);process.env.HOME=root;process.env.DATABASE_PATH=join(root,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const oldLog=console.log,oldWarn=console.warn;console.log=()=>{};console.warn=()=>{};
const {getDatabase,closeDatabase}=await import(join(backend,'src/db/database.ts'));const db=getDatabase();await db.initialize();
for(const [id,role] of [['addon-owner','owner'],['addon-member','user']])db.prepare("INSERT INTO users (id,email,username,password_hash,role,status) VALUES (?,?,?,'x',?,'active')").run(id,id+'@example.test',id,role);
const {chatAddons}=await import(join(backend,'src/services/chat-addons.ts'));const {chatAddonsRoutes}=await import(join(backend,'src/api/routes/chat-addons.ts'));const {registerAuthGate}=await import(join(backend,'src/auth/auth-gate.ts'));const {generateToken}=await import(join(backend,'src/auth/jwt.ts'));const {default:Fastify}=await import('fastify');
console.log=oldLog;console.warn=oldWarn;
const home=join(root,'source-home');mkdirSync(join(home,'.claude/plugins'),{recursive:true});mkdirSync(join(home,'.codex'));
writeFileSync(join(home,'.claude/settings.json'),JSON.stringify({enabledPlugins:{'sample@publisher':true,'disabled@publisher':false},hooks:{PreToolUse:[{hooks:[{command:'PRIVATE-HOOK-COMMAND'}]}]},apiKey:'PRIVATE-KEY'}));
writeFileSync(join(home,'.claude/plugins/installed_plugins.json'),JSON.stringify({plugins:{'sample@publisher':[{installPath:'/PRIVATE/PATH'}]}}));
writeFileSync(join(home,'.codex/config.toml'),'api_key="PRIVATE-TOKEN"\n[plugins."higgsfield@publisher"]\nenabled=true\nsecret="PRIVATE-SECRET"\n[mcp_servers.private]\ncommand="PRIVATE-COMMAND"\n');
const app=Fastify();registerAuthGate(app);await app.register(chatAddonsRoutes,{home});await app.ready();
const auth=id=>({authorization:'Bearer '+generateToken(id,1)});
test.after(async()=>{await app.close();closeDatabase();rmSync(root,{recursive:true,force:true});});
test('source inventory returns bounded names and source flags without secrets, commands or paths',async()=>{const data=await chatAddons(home),text=JSON.stringify(data);assert.equal(data.items.length,4);assert.ok(!/PRIVATE-|\/PRIVATE/.test(text));assert.deepEqual(data.items.find(x=>x.source==='codex'),{name:'higgsfield@publisher',source:'codex',kind:'plugin',installed:null,enabled:true,count:0});assert.equal(data.items.find(x=>x.kind==='hook').count,1);assert.equal(data.items.find(x=>x.name==='sample@publisher').installed,true);assert.equal(data.items.find(x=>x.name==='disabled@publisher').enabled,false);});
test('owner and loopback gate are enforced; query inputs and non-read routes are refused',async()=>{assert.equal((await app.inject({url:'/api/chat/addons'})).statusCode,401);assert.equal((await app.inject({url:'/api/chat/addons',headers:auth('addon-member')})).statusCode,403);assert.equal((await app.inject({url:'/api/chat/addons',headers:auth('addon-owner')})).statusCode,200);assert.equal((await app.inject({url:'/api/chat/addons',headers:{...auth('addon-owner'),'x-forwarded-for':'127.0.0.1'},remoteAddress:'203.0.113.5'})).statusCode,403);assert.equal((await app.inject({url:'/api/chat/addons?home=/private',headers:auth('addon-owner')})).statusCode,400);assert.equal((await app.inject({method:'POST',url:'/api/chat/addons',headers:auth('addon-owner'),payload:{}})).statusCode,404);});
test('missing and out-of-home symlinked metadata stay unavailable and do not expose data',async()=>{const missing=await chatAddons(join(root,'missing'));assert.equal(missing.items.length,0);const other=join(root,'other');mkdirSync(join(other,'.claude'),{recursive:true});symlinkSync(join(home,'.claude/settings.json'),join(other,'.claude/settings.json'));const blocked=await chatAddons(other);assert.equal(blocked.items.length,0);assert.equal(blocked.sources.find(x=>x.source==='claude-code').status,'unavailable');});

test('cached plugin manifests expose human labels and presence without activation or private fields',async()=>{const dir=join(home,'.codex/plugins/cache/publisher/cached-app/1.0/.codex-plugin');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'plugin.json'),JSON.stringify({name:'cached-app',interface:{displayName:'Sample Studio'},command:'PRIVATE-EXECUTABLE',token:'PRIVATE-TOKEN'}));const data=await chatAddons(home);const cached=data.items.find(x=>x.name==='cached-app@publisher');assert.equal(cached?.label,'Sample Studio');assert.equal(cached?.installed,true);assert.equal(cached?.enabled,null);assert.ok(!JSON.stringify(data).includes('PRIVATE-'));});
test('available catalogues project local snapshots only and refuse external manifests',async()=>{
 const {addonCatalogue}=await import(join(backend,'src/services/addon-catalogue.ts'));
 const dir=join(home,'.claude/plugins/marketplaces/publisher/.claude-plugin');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'marketplace.json'),JSON.stringify({name:'publisher',plugins:[{name:'sample',description:'Sample available plugin',source:{url:'https://PRIVATE-DOWNLOAD',command:'PRIVATE-COMMAND'},author:{email:'PRIVATE-EMAIL'}},{name:'../escape',description:'Bad path'}]}));
 const data=await addonCatalogue(home);assert.equal(data.items.length,1);assert.equal(data.items[0].id,'sample@publisher');assert.equal(data.items[0].present,true);assert.ok(!JSON.stringify(data).includes('PRIVATE-'));
 const outside=join(root,'outside-marketplace.json');writeFileSync(outside,JSON.stringify({name:'escape',plugins:[{name:'outside'}]}));const link=join(home,'.claude/plugins/marketplaces/escape/.claude-plugin');mkdirSync(link,{recursive:true});symlinkSync(outside,join(link,'marketplace.json'));assert.equal((await addonCatalogue(home)).items.length,1);
});
test('available catalogue is owner/loopback read-only with no path selection input',async()=>{
 assert.equal((await app.inject({url:'/api/chat/addons/catalogue',headers:auth('addon-owner')})).statusCode,200);
 assert.equal((await app.inject({url:'/api/chat/addons/catalogue',headers:auth('addon-member')})).statusCode,403);
 assert.equal((await app.inject({url:'/api/chat/addons/catalogue',headers:auth('addon-owner'),remoteAddress:'203.0.113.5'})).statusCode,403);
 assert.equal((await app.inject({url:'/api/chat/addons/catalogue?path=/private',headers:auth('addon-owner')})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/chat/addons/catalogue',headers:auth('addon-owner'),payload:{}})).statusCode,404);
});
