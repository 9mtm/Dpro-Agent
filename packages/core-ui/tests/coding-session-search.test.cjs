require('./load.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {codingSessionMatches}=require('../src/CodingSessions.tsx');
const row=(id,source,cwd,title,updatedAt)=>({id,source,cwd,title,updatedAt,startedAt:null,bytes:100,turns:2,imported:null});
const rows=[row('a','codex','/test/project','First task','2026-10-17'),row('b','claude-code','/test/project/','Second task','2026-10-18'),row('c','codex','/test/project-other','Private other task','2026-10-19'),row('d','gemini-cli','/test/project','Other app','2026-10-19'),row('e','codex',null,'No folder','2026-10-19')];
test('coding-session search keeps exact folder/source boundaries and deterministic newest order',()=>{
 assert.deepEqual(codingSessionMatches(rows,'/test/project').map(r=>r.id),['b','a']);
 assert.deepEqual(codingSessionMatches(rows,'/test/project/',' TASK ','codex').map(r=>r.id),['a']);
 assert.deepEqual(codingSessionMatches(rows,'/test/project','second','claude-code').map(r=>r.id),['b']);
 assert.deepEqual(codingSessionMatches(rows,'/test/project','missing'),[]);
 assert.equal(rows[0].id,'a','sort must not mutate the source catalogue');
});
