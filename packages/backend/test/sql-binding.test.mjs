import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { sqliteRowStore } from '../src/encryption/row-store.ts';
import { KeyManager, keysSchemaSql } from '../src/encryption/key-manager.ts';
import { CredentialVault, vaultSchemaSql } from '../src/encryption/credential-vault.ts';
import { AUDIT_INSERT_SQL, auditLogParams } from '../src/services/audit-logger.ts';
import { convertPlaceholders } from '../src/db/pg/placeholders.ts';

test('key type filter values cannot change the SQL selection', t => {
  const db = new Database(':memory:');
  const keys = new KeyManager({}, 'sqlite'); keys.rows = sqliteRowStore(db);
  t.after(() => keys.close());
  db.exec(keysSchemaSql());
  const insert = db.prepare('INSERT INTO keys (id,type,algorithm,created_at) VALUES (?,?,?,?)');
  insert.run('key-a', 'fixture-a', 'AES-256-GCM', new Date().toISOString());
  insert.run('key-b', 'fixture-b', 'AES-256-GCM', new Date().toISOString());
  assert.equal(keys.listKeys('fixture-a').length, 1);
  assert.deepEqual(keys.listKeys("fixture-a' OR 1=1 --"), []);
  assert.equal(keys.listKeys().length, 2);
});

test('vault filter and update values stay literal and cannot alter ownership or other rows', async t => {
  const db = new Database(':memory:');
  const vault = new CredentialVault('sqlite', new KeyManager({}, 'sqlite'));
  vault.rows = sqliteRowStore(db); t.after(() => vault.close());
  db.exec(vaultSchemaSql());
  const insert = db.prepare('INSERT INTO credentials (id,name,type,encrypted_data,owner_id,owner_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  insert.run('a', 'first', 'fixture-a', '{}', 'owner-a', 'user', now, now);
  insert.run('b', 'second', 'fixture-b', '{}', 'owner-b', 'user', now, now);
  assert.deepEqual(vault.query({ ownerId: "owner-a' OR 1=1 --", includeExpired: true }), []);
  assert.deepEqual(vault.query({ search: "x' OR 1=1 --", includeExpired: true }), []);
  assert.equal(vault.query({ type: ['fixture-a', "x') OR 1=1 --"], includeExpired: true }).length, 1);
  const name = "literal', owner_id='owner-b' --";
  await vault.update('a', { name, metadata: { note: "'); DROP TABLE credentials; --" } });
  assert.equal(vault.getById('a').name, name);
  assert.equal(vault.getById('a').ownerId, 'owner-a');
  assert.equal(vault.getById('b').name, 'second');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 2);
});

test('audit metadata remains a bound value after PostgreSQL placeholder conversion', () => {
  const payload = "'); DROP TABLE audit_logs; --";
  const values = auditLogParams({ event_type: 'auth.login', event_category: 'auth', success: true, user_id: payload, metadata: { payload } });
  const converted = convertPlaceholders(AUDIT_INSERT_SQL);
  assert.equal(converted.count, values.length);
  assert.ok(!converted.text.includes(payload));
  assert.ok(values.includes(payload));
  assert.equal(JSON.parse(values.at(-1)).payload, payload);
  assert.match(converted.text, /\$1/);
});
