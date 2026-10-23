import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'paper-manifest-history-'));
Object.assign(process.env,{DATABASE_PATH:join(root,'main.db'),AGENT_PLAYER_DATA_DIR:root,JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex')});
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const main=getDatabase();await main.initialize();const db=main.getDb();
const source=await import('../src/services/trading-paper-manifest.ts');
const registry=await import('../src/services/trading-paper-installation.ts');
const catalog=await import('../src/services/trading-paper-manifest-catalog.ts');
const review=await import('../src/services/trading-paper-install-review.ts');
const {enrollInstallOwner,reviewedInstall}=await import('./fixtures/reviewed-paper-install.mjs');
const now=Date.now();
async function fixture(){const ownerId='history-'+randomUUID();db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x','owner','active',1)").run(ownerId,ownerId+'@example.test',ownerId);const f=await enrollInstallOwner(ownerId,now-90000);await reviewedInstall(db,f,{now:now-60000});return {...f,ownerId};}
test.after(()=>closeDatabase());
test('original source identity property order and digest are preserved and candidate has no historical decoder',()=>{
 const v=source.BUNDLED_PAPER_INSTALLATION;assert.equal(v,registry.BUNDLED_PAPER_INSTALLATION);assert.equal(v,catalog.lookupSupportedPaperHistoryManifest(v.version,v.manifestDigest));assert.ok(Object.isFrozen(v));assert.ok(Object.isFrozen(v.capabilities));
 assert.deepEqual(Object.keys(v),['appId','implementationId','version','kind','mode','schemaVersion','schemaDigest','capabilities','manifestDigest']);const {manifestDigest,...declaration}=v;assert.equal(createHash('sha256').update(JSON.stringify(declaration)).digest('hex'),manifestDigest);
 const c=catalog.PAPER_EXECUTION_UPGRADE_CANDIDATE;assert.equal(catalog.lookupSupportedPaperHistoryManifest(c.version,c.manifestDigest),null);assert.equal(catalog.lookupSupportedPaperHistoryManifest(v.version,c.manifestDigest),null);assert.equal(catalog.lookupSupportedPaperHistoryManifest(c.version,v.manifestDigest),null);
});
test('real reviewed original provenance remains readable; candidate or mismatched persisted version/digest refuses public access without mutation',async()=>{
 const f=await fixture();assert.equal(review.readReviewedPaperInstallationAccess(db,f.ownerId,()=>now).state,'ready');
 const candidate=catalog.PAPER_EXECUTION_UPGRADE_CANDIDATE;
 for(const [version,digest] of [[candidate.version,candidate.manifestDigest],['1.0.0',candidate.manifestDigest],[candidate.version,source.BUNDLED_PAPER_INSTALLATION.manifestDigest]]){
  assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE paper_installations SET version=?,manifest_digest=? WHERE owner_id=?').run(version,digest,f.ownerId);const before=db.prepare('SELECT total_changes() n').get().n;assert.equal(registry.readPaperInstallation(db,f.ownerId,()=>now).ok,false);assert.equal(review.readReviewedPaperInstallationAccess(db,f.ownerId,()=>now).state,'incompatible');assert.equal(db.prepare('SELECT total_changes() n').get().n,before);throw Error('fixture rollback');}).immediate(),/fixture rollback/);
 }
 assert.equal(review.readReviewedPaperInstallationAccess(db,f.ownerId,()=>now).state,'ready');
});

test('tampered original reviewed manifest is refused by public history even with original registry intact',async()=>{
 const f=await fixture();
 assert.throws(()=>db.transaction(()=>{
  const r=db.prepare("SELECT * FROM paper_install_reviews WHERE owner_id=? AND status='applied'").get(f.ownerId),d=JSON.parse(r.definition_json);d.manifest=catalog.PAPER_EXECUTION_UPGRADE_CANDIDATE;const text=JSON.stringify(d);
  db.prepare('UPDATE paper_install_reviews SET definition_json=?,definition_hash=? WHERE id=?').run(text,createHash('sha256').update(text).digest('hex'),r.id);
  assert.equal(review.readReviewedPaperInstallationAccess(db,f.ownerId,()=>now).state,'incompatible');throw Error('fixture rollback');
 }).immediate(),/fixture rollback/);
 assert.equal(review.readReviewedPaperInstallationAccess(db,f.ownerId,()=>now).state,'ready');
});
