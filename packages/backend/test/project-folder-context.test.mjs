import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'dpro-project-context-'));
process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=join(root,'agent-player.db');
process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.AGENT_PLAYER_BACKGROUND='off';process.env.NODE_ENV='test';
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES('context-owner','context@example.invalid','Fictional','unused','owner','active')").run();
const {registerAuthGate}=await import('../src/auth/auth-gate.ts');const {generateToken}=await import('../src/auth/jwt.ts');
const {chatConversationRoutes}=await import('../src/api/routes/chat-conversations.ts');const {default:Fastify}=await import('fastify');
const app=Fastify();registerAuthGate(app);await app.register(chatConversationRoutes);await app.ready();
const api=(url,body)=>app.inject({method:'POST',url,headers:{authorization:'Bearer '+generateToken('context-owner',1)},payload:body});
test.after(async()=>{await app.close();closeDatabase();});
test('new project requires a real folder while general conversations stay folder-free',async()=>{
 for(const folder of [undefined,null,'','   ','relative',root+'/missing']){
  const r=await api('/api/chat/projects',{name:'Fictional project',...(folder===undefined?{}:{folder})});assert.equal(r.statusCode,400);
 }
 assert.equal(db.prepare('SELECT count(*) AS n FROM chat_projects').get().n,0);
 const folder=join(root,'workspace');mkdirSync(folder);
 const created=await api('/api/chat/projects',{name:'Fictional project',folder});assert.equal(created.statusCode,201,created.body);assert.equal(created.json().project.folder,realpathSync(folder));
 const general=await api('/api/chat/conversations',{});assert.equal(general.statusCode,201,general.body);assert.equal(general.json().conversation.projectId,null);
});

test('folder browser stays within its home and returns directories only',async()=>{
 const {projectFolders}=await import('../src/services/project-folder-picker.ts');
 const {writeFileSync,symlinkSync}=await import('node:fs');
 const home=join(root,'picker-home');mkdirSync(home);mkdirSync(join(home,'Visible'));mkdirSync(join(home,'.hidden'));writeFileSync(join(home,'private.txt'),'fictional');symlinkSync(root,join(home,'Outside'));
 const view=await projectFolders(undefined,home);assert.equal(view.selectable,false);assert.equal(view.parent,null);assert.deepEqual(view.entries.map(e=>e.name),['Visible']);
 const child=await projectFolders(join(home,'Visible'),home);assert.equal(child.selectable,true);assert.equal(child.parent,realpathSync(home));
 await assert.rejects(projectFolders(root,home));await assert.rejects(projectFolders(join(home,'Outside'),home));await assert.rejects(projectFolders('relative',home));
 const bad=await api('/api/chat/project-folders',{path:root,extra:true});assert.equal(bad.statusCode,400);
});
