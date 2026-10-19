'use strict';
const path = require('node:path');
try {
  const Database = require(require.resolve('better-sqlite3', { paths: [process.argv[2]] }));
  const db = new Database(path.join(process.argv[3], 'agent-player.db'), { readonly: true, fileMustExist: true });
  const owner = db.prepare("SELECT 1 FROM users WHERE role IN ('owner', 'admin') AND id NOT IN ('mock-user', '1') LIMIT 1").get();
  db.close();
  process.stdout.write(JSON.stringify({ state: owner ? 'existing' : 'unconfigured' }));
} catch (error) { process.stdout.write(JSON.stringify({ state: 'unreadable', reason: typeof error.code === 'string' ? error.code : error.name })); }
