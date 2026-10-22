import { pathToFileURL } from 'node:url';
const loadFile = file => import(pathToFileURL(file).href);
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const backend=process.argv[2], root=process.env.HOME, mode=process.argv[3];
console.log=()=>{};console.warn=()=>{};
process.chdir(root);
const {getDatabase,closeDatabase}=await loadFile(path.join(backend,'src/db/database.ts'));
const db=getDatabase();await db.initialize();
const L=await loadFile(path.join(backend,'src/memory/import/local-import.ts'));
const S=await loadFile(path.join(backend,'src/memory/import/local-import-store.ts'));
const {listLocalSessions}=await loadFile(path.join(backend,'src/memory/import/local-agents.ts'));
let calls=0;const extract=async text=>{
 calls++;process.send?.({phase:'extract',calls});
 if(mode==='crash'&&calls===2)await new Promise(()=>{});
 const content=text.split('Owner: ')[1]?.trim();
 return [{title:'Fixture fact',content,scope:'owner',evidence:content}];
};
const wait=async id=>{let j;for(let i=0;i<150;i++){j=await L.getJob('durable-owner',id);if(j?.status!=='running')return j;await new Promise(r=>setTimeout(r,20))}throw Error('Job timeout: '+JSON.stringify({status:j?.status,done:j?.done,total:j?.total,errors:j?.errors,calls}))};
try {
 if(mode==='crash'){
  db.prepare("INSERT INTO users (id,email,username,password_hash,role,status,email_verified) VALUES ('durable-owner','durable@example.invalid','durable','fixture','owner','active',1)").run();
  const ids=(await listLocalSessions(root)).map(s=>s.id);const j=await L.startImport('durable-owner',ids,{home:root,extract});await wait(j.id);
 } else {
  const before=(await S.savedImports())[0];if(before.cursor!==1)throw Error('First conversation progress was not durable');
  await L.resumePendingImports({home:root,extract});const job=await wait(before.id);if(job.status!=='done'||job.done!==3||calls!==2)throw Error('Resume repeated completed extraction or lost progress');
  await L.stopLocalImports();
  const n=db.prepare('SELECT COUNT(*) AS n FROM memory_file_proposals').get().n;
  const duplicate=await L.startImport('durable-owner',before.ids,{home:root,extract:async()=>{throw Error('Completed conversation re-extracted')}});const skipped=await wait(duplicate.id);
  if(skipped.status!=='done'||skipped.errors||db.prepare('SELECT COUNT(*) AS n FROM memory_file_proposals').get().n!==n)throw Error('Duplicate submission created proposals');
  await L.stopLocalImports();
  // Reconstruct the precise crash window: committed preview, no import marker/cursor yet.
  const imported=db.prepare('SELECT * FROM local_agent_imports LIMIT 1').get();
  const batch=db.prepare('SELECT * FROM memory_import_batches WHERE id=?').get(imported.batch_id);
  const replay={...before,automatic:true,id:randomUUID(),ids:[imported.session_id],cursor:0,total:1,done:0,proposed:0,dropped:0,skipped:0,status:'running',current:{id:imported.session_id,source:imported.source,archive:imported.archive_name,dropped:0,previews:[{id:batch.id,version:batch.committed_version,hash:batch.committed_hash,key:batch.operation_key,include:true}]}};
  const {configureAutomaticImport}=await loadFile(path.join(backend,'src/memory/import/automatic-project-import.ts'));await configureAutomaticImport('durable-owner',{enabled:true,intervalMinutes:60});
  db.prepare('DELETE FROM local_agent_imports WHERE session_id=?').run(imported.session_id);await S.saveImport(replay);
  await L.resumePendingImports({home:root,extract:async()=>{throw Error('Prepared checkpoint re-extracted')}});const recovered=await wait(replay.id);
  if(recovered.status!=='done'||recovered.proposed!==1||db.prepare('SELECT COUNT(*) AS n FROM memory_file_proposals').get().n!==n)throw Error('Committed preview replay duplicated proposals');
  if(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id='durable-owner'").get().n!==1)throw Error('Automatic checkpoint did not save its own approved memory');
  if(await L.getJob('another-owner',replay.id))throw Error('Another owner saw private progress');
  const files=fs.readdirSync(path.join(root,'.data/local-import-jobs')).filter(f=>f.endsWith('.json'));
  if(process.platform !== 'win32' && files.some(f=>(fs.statSync(path.join(root,'.data/local-import-jobs',f)).mode&0o777)!==0o600))throw Error('Journal is not private');
  await L.stopLocalImports();
  // An uncommitted preview can expire while the application is closed.
  const fact='The Nimbus service uses a dedicated SQLite database.';
  fs.writeFileSync(path.join(root,'.claude/projects/fixture/expired.jsonl'),JSON.stringify({type:'user',message:{content:fact}}));
  const session=(await listLocalSessions(root)).find(s=>s.title.includes('Nimbus'));
  const {createPreview}=await loadFile(path.join(backend,'src/memory/import/pipeline.ts'));
  const preview=await createPreview('durable-owner',{files:[{name:'Fixture.md',content:'### Nimbus database\n\n'+fact}],source:'text'});
  db.prepare("UPDATE memory_import_batches SET expires_at='2000-01-01' WHERE id=?").run(preview.batchId);
  const expired={...replay,id:randomUUID(),ids:[session.id],current:{id:session.id,source:session.source,archive:'fixture.md',dropped:0,previews:[{id:preview.batchId,version:preview.version,hash:preview.contentHash,key:randomUUID(),include:true}]}};
  await S.saveImport(expired);
  await L.resumePendingImports({home:root,extract:async()=>[{title:'Nimbus database',content:fact,scope:'owner',evidence:fact}]});
  const rebuilt=await wait(expired.id);
  if(rebuilt.status!=='done'||rebuilt.proposed!==1)throw Error('Expired preview failed to resume');
  await L.stopLocalImports();closeDatabase();process.send?.({phase:'pass',calls,proposals:n,processed:3,committedReplay:true});process.exit(0);
 }
} catch(e){process.send?.({phase:'error',message:e.message});await L.stopLocalImports();closeDatabase();process.exit(1)}
