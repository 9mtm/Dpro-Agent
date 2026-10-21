// B2.2c part 1: scheduler (cron_jobs, job_executions, one run per tick under
// concurrent clients), the MCP server and tool registry (discovery, grants
// and bindings, atomic revocation, a name race), the settings manager,
// notifications (settings, schedules fired once under concurrent runners),
// the audit_logs read side, extension analytics and the security event
// store in the main database, on PostgreSQL, end to end.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on
// 127.0.0.1 that the PostgreSQL runner has already migrated (it writes test
// rows and never cleans up: drop the database afterwards). Otherwise every
// test skips. scripts/pg/integration.sh runs it.
//
// The SQLite file (a temp file, never the real .data) is watched: any
// statement on a ported table that reaches SQLite during these tests is a
// failure (last test). No security event file is created either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

const PORTED_TABLES = /\b(cron_jobs|job_executions|mcp_servers|mcp_server_tools|mcp_grant_bindings|app_settings|notifications|notification_settings|notification_schedules|audit_logs|audit_events|extension_usage_stats|extension_configs|login_attempts|login_devices)\b/i;
const sqliteHits = [];

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-platform-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  // SQLite still backs the modules that are not ported yet: a temp file, never the real .data.
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.AUDIT_DB_PATH = join(dir, '.data', 'audit', 'audit.db');
  process.env.MCP_SERVERS_DIR = join(dir, 'mcp-servers');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  process.env.AGENT_PLAYER_PG_POOL_MAX = '8';
  delete process.env.AGENT_EXEC_TOOLS;

  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize(); // B2.2d-17: an explicit temp SQLite file, watched for strays
  // Watch SQLite: a ported table must never be touched there on PostgreSQL.
  const mgr = getDatabase();
  const raw = mgr.getDb();
  for (const target of [mgr, raw]) {
    const original = target.prepare;
    target.prepare = function (sql) {
      if (PORTED_TABLES.test(String(sql))) sqliteHits.push(String(sql).replace(/\s+/g, ' ').slice(0, 120));
      return original.call(this, sql);
    };
  }
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    repos: await import('../src/repositories/index.ts'),
    actor: await import('../src/repositories/actor.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    cron: await import('../src/scheduler/store.ts'),
    engine: await import('../src/scheduler/engine.ts'),
    memoryJobs: await import('../src/memory/jobs.ts'),
    mcp: await import('../src/mcp-client/index.ts'),
    grants: await import('../src/tools/grants.ts'),
    tools: await import('../src/tools/index.ts'),
    settings: await import('../src/settings/settings-manager.ts'),
    notif: await import('../src/services/notification-service.ts'),
    audit: await import('../src/services/audit-logger.ts'),
    analytics: await import('../src/services/extension-analytics.ts'),
    auditStorage: await import('../src/audit/audit-storage.ts'),
    fixture: await import('./fixtures/mcp-fixture-server.mjs'),
    httpTransport: (await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')).WebStandardStreamableHTTPServerTransport,
  };
}

const tag = randomBytes(4).toString('hex');
const one = (sql, ...p) => m.pool.pgOne(sql, ...p);
const all = (sql, ...p) => m.pool.pgAll(sql, ...p);
const pgRun = (sql, ...p) => m.pool.pgRun(sql, ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = async (fn) => {
  const s = { log: console.log, warn: console.warn, info: console.info };
  console.log = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, s); }
};

/**
 * Hold a lock on a second pool client while `work` starts, so the
 * concurrent calls inside really overlap; released after `ms`.
 */
async function withHeldLock(lockSql, params, work, ms = 250) {
  const pool = await m.pool.getPgPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(lockSql, params);
    const pending = work();
    await sleep(ms);
    await c.query('COMMIT');
    return await pending;
  } finally {
    c.release();
  }
}

const ids = {};
const A = {};

test.before(async () => {
  if (!URL_) return;
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  const admin = await m.users.create({ email: `admin-${tag}@pg.test`, username: `admin_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'admin' });
  ids.owner = owner.id;
  A.admin = m.actor.userActor({ id: admin.id, role: 'admin' });
});

test.after(async () => {
  if (!URL_) return;
  m.mcp.__setMcpFetchForTests(null);
  await m.mcp.closeAllConnections();
  await m.audit.flushAuditWrites();
  await m.pool.closePgPool();
  m.closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

test('cron store: CRUD, run times, history (ISO on the way out), named jobs', { skip }, async () => {
  const now = new Date();
  const job = { id: `cj-${tag}`, name: `job ${tag}`, description: 'd', cronExpression: '*/5 * * * *', actionType: 'custom', actionData: { a: 1 }, enabled: true, createdAt: now, updatedAt: now };
  ids.job = job.id;
  await m.cron.insertJob(job);
  const loaded = (await m.cron.listEnabledJobs()).find((j) => j.id === job.id);
  assert.deepEqual(loaded.actionData, { a: 1 });
  assert.equal(loaded.createdAt.toISOString(), now.toISOString(), 'timestamptz read back as the same moment');
  assert.equal(loaded.lastRun, undefined);
  await m.cron.updateJobDefinition({ ...job, name: `job ${tag} v2`, updatedAt: new Date() });
  assert.equal((await one('SELECT name FROM cron_jobs WHERE id = ?', job.id)).name, `job ${tag} v2`);
  await m.cron.setJobEnabled(job.id, false, new Date());
  assert.ok(!(await m.cron.listEnabledJobs()).some((j) => j.id === job.id));
  await m.cron.setJobEnabled(job.id, true, new Date());
  const ran = new Date(Date.now() - 5000);
  await m.cron.recordRunTimes({ ...job, lastRun: ran, nextRun: new Date(Date.now() + 60_000) });
  const again = (await m.cron.listEnabledJobs()).find((j) => j.id === job.id);
  assert.equal(again.lastRun.toISOString(), ran.toISOString());
  await m.cron.saveExecution({ jobId: job.id, success: true, output: '"ok"', executedAt: new Date(Date.now() - 1000), duration: 3 });
  await m.cron.saveExecution({ jobId: job.id, success: false, error: 'boom', executedAt: new Date(), duration: 4 });
  const hist = await m.cron.jobHistory(job.id);
  assert.deepEqual(hist.map((h) => h.success), [false, true], 'newest first');
  assert.match(hist[0].executedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(typeof hist[0].id, 'number');
  assert.equal(hist[0].duration, 4);
  // A deleted job cascades its history.
  const tmp = { ...job, id: `cj-del-${tag}`, name: `del ${tag}` };
  await m.cron.insertJob(tmp);
  await m.cron.saveExecution({ jobId: tmp.id, success: true, executedAt: new Date(), duration: 1 });
  await m.cron.deleteJob(tmp.id);
  assert.equal((await one('SELECT COUNT(*) AS n FROM job_executions WHERE job_id = ?', tmp.id)).n, 0);
});

test('cron claim: of two concurrent clients exactly one runs a tick; the next slot is claimable again', { skip }, async () => {
  const slot = m.cron.tickSlot('*/5 * * * *', Date.now() + 3_600_000);
  const results = await withHeldLock('SELECT id FROM cron_jobs WHERE id = $1 FOR UPDATE', [ids.job],
    () => Promise.all([m.cron.claimRun(ids.job, slot), m.cron.claimRun(ids.job, slot)]));
  assert.deepEqual(results.sort(), [false, true], 'one winner');
  assert.equal(await m.cron.claimRun(ids.job, slot), false, 'the same slot again: already run');
  // Five slots, four clients each: one winner per slot.
  for (let i = 1; i <= 5; i++) {
    const s = new Date(slot.getTime() + i * 300_000);
    const r = await Promise.all([1, 2, 3, 4].map(() => m.cron.claimRun(ids.job, s)));
    assert.equal(r.filter(Boolean).length, 1, `slot ${i}`);
  }
  // A disabled job claims nothing.
  await m.cron.setJobEnabled(ids.job, false, new Date());
  assert.equal(await m.cron.claimRun(ids.job, new Date(slot.getTime() + 3_600_000)), false);
  await m.cron.setJobEnabled(ids.job, true, new Date());
});

test('cron engine: two engines on one database, one tick runs once; background off schedules nothing', { skip }, async () => {
  const { CronEngine } = m.engine;
  const job = { id: `cj-eng-${tag}`, name: `engine ${tag}`, cronExpression: '* * * * * *', actionType: 'custom', actionData: {}, enabled: true, createdAt: new Date(), updatedAt: new Date() };
  await m.cron.insertJob(job);
  // Both engines claim the same second slot right now (what their tick does first).
  const slot = m.cron.tickSlot(job.cronExpression);
  const won = await Promise.all([m.cron.claimRun(job.id, slot), m.cron.claimRun(job.id, slot)]);
  assert.equal(won.filter(Boolean).length, 1);
  // AGENT_PLAYER_BACKGROUND=off: the job is known, no task is created.
  const saved = process.env.AGENT_PLAYER_BACKGROUND;
  process.env.AGENT_PLAYER_BACKGROUND = 'off';
  try {
    const e = new CronEngine();
    await silent(() => e.start());
    assert.ok(e.getJob(job.id), 'loaded from PostgreSQL');
    assert.equal(e.tasks.size, 0, 'no cron task');
    await silent(() => e.stop());
  } finally {
    if (saved === undefined) delete process.env.AGENT_PLAYER_BACKGROUND; else process.env.AGENT_PLAYER_BACKGROUND = saved;
  }
  await m.cron.deleteJob(job.id);
});

test('named jobs and memory jobs: created once under concurrent processes', { skip }, async () => {
  const def = { name: `named ${tag}`, description: null, cronExpression: '0 4 * * *', actionType: 'memory-job', actionData: { job: 'x' } };
  const made = await Promise.all([1, 2, 3, 4].map((i) => m.cron.ensureNamedJob(`nj-${tag}-${i}`, def)));
  assert.equal(made.filter(Boolean).length, 1);
  assert.equal((await one('SELECT COUNT(*) AS n FROM cron_jobs WHERE name = ?', def.name)).n, 1);
  const runs = await Promise.all([m.memoryJobs.ensureMemoryJobs(), m.memoryJobs.ensureMemoryJobs()]);
  const mine = runs.flat().filter((j) => j.actionData.userId === ids.owner);
  assert.equal(mine.length, 2, 'weekly summary + retention, once');
  for (const name of ['weekly-summary', 'retention', 'trash']) {
    assert.equal((await one('SELECT COUNT(*) AS n FROM cron_jobs WHERE name = ?', m.memoryJobs.memoryJobName(name, ids.owner))).n, 1);
  }
  assert.deepEqual((await m.memoryJobs.ensureMemoryJobs()).filter((j) => j.actionData.userId === ids.owner), []);
});

// ---------------------------------------------------------------------------
// MCP registry
// ---------------------------------------------------------------------------

function fakeHttpServer() {
  const server = m.fixture.createFixtureServer({});
  const transport = new m.httpTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  const ready = server.connect(transport);
  m.mcp.__setMcpFetchForTests(async (url, init) => {
    await ready;
    const req = new Request(new URL(String(url)), init);
    if (req.method === 'GET') return new Response(null, { status: 405 });
    return transport.handleRequest(req);
  });
}

test('MCP registry round trip: add, enable, discover, view, approval setting, tools, grants bound to the fingerprint', { skip }, async () => {
  const name = `pg${tag.slice(0, 6)}`;
  ids.mcpName = name;
  const added = await m.mcp.createServer({ name, transport: 'http', url: 'http://127.0.0.1:65535/mcp' }, ids.owner);
  ids.mcp = added.id;
  assert.equal(added.enabled, false);
  assert.equal(added.status, 'disabled');
  assert.deepEqual(added.tools, []);
  assert.match(added.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'TEXT timestamp in the SQLite format');
  const row = await one('SELECT * FROM mcp_servers WHERE id = ?', added.id);
  assert.equal(typeof row.allow_remote, 'number');
  assert.ok(row.generation);

  const enabled = await m.mcp.enableServer(added.id, {}, ids.owner);
  assert.equal(enabled.enabled, true);
  fakeHttpServer();
  const disc = await silent(() => m.mcp.refreshServer(added.id, ids.owner));
  assert.ok(disc.discovered > 0);
  assert.equal(disc.server.status, 'ready');
  const echo = `mcp__${name}__echo`;
  assert.ok(disc.server.tools.some((t) => t.registryName === echo));
  const fp = await one('SELECT server_id, fingerprint FROM mcp_server_tools WHERE registry_name = ?', echo);
  assert.deepEqual(await m.mcp.currentMcpTool(echo), { serverId: added.id, fingerprint: fp.fingerprint });
  assert.ok((await m.mcp.listServers()).some((s) => s.id === added.id));
  assert.equal((await m.mcp.getServer(added.id)).tools.length, disc.discovered);

  const set = await m.mcp.setToolApproval(added.id, 'echo', false);
  assert.equal(set.tools.find((t) => t.name === 'echo').requiresApproval, false);
  await assert.rejects(() => m.mcp.setToolApproval(added.id, 'no-such-tool', true), /tool not found/);

  m.mcp.invalidateMcpTools();
  const toolsNow = await m.mcp.getMcpTools();
  assert.ok(toolsNow.some((t) => t.name === echo), 'async tool list from PostgreSQL');
  assert.ok(m.mcp.getMcpToolsSync().some((t) => t.name === echo), 'the synchronous registry sees the warmed cache');

  // Grant it to an agent: the binding is written with the grant and holds the current fingerprint.
  const agent = await silent(() => m.repos.repositories.agents.createConfig(A.admin, { name: `MCP Agent ${tag}` }));
  ids.agent = agent.id;
  const available = (await silent(() => m.tools.createAgentToolsRegistry({ workspaceDir: dir }))).listRegistered();
  await m.grants.setAgentGrants(agent.id, { grants: [echo] }, ids.owner, available);
  const b = await one('SELECT server_id, fingerprint FROM mcp_grant_bindings WHERE agent_id = ? AND tool_name = ?', agent.id, echo);
  assert.deepEqual(b, { server_id: added.id, fingerprint: fp.fingerprint });
  assert.ok((await m.grants.loadAgentGrants(agent.id, available)).tools.has(echo), 'bound grant is effective');
  // A changed fingerprint (tool changed on the server) makes the grant ineffective.
  await pgRun('UPDATE mcp_server_tools SET fingerprint = ? WHERE registry_name = ?', '0'.repeat(64), echo);
  assert.ok(!(await m.grants.loadAgentGrants(agent.id, available)).tools.has(echo));
  await pgRun('UPDATE mcp_server_tools SET fingerprint = ? WHERE registry_name = ?', fp.fingerprint, echo);
  await assert.rejects(() => m.grants.setAgentGrants(agent.id, { grants: [`mcp__${name}__nope`] }, ids.owner, available), /not a discovered MCP tool/);
});

test('MCP: a target change revokes grants, bindings and tools in one transaction; delete too; a name race is 409', { skip }, async () => {
  const echo = `mcp__${ids.mcpName}__echo`;
  const res = await m.mcp.updateServer(ids.mcp, { url: 'http://127.0.0.1:65534/mcp' }, ids.owner);
  assert.equal(res.disabled, true);
  assert.deepEqual(res.revokedGrants, [{ agentId: ids.agent, tool: echo }]);
  assert.equal((await one('SELECT COUNT(*) AS n FROM mcp_server_tools WHERE server_id = ?', ids.mcp)).n, 0);
  assert.equal((await one('SELECT COUNT(*) AS n FROM agent_tool_grants WHERE tool_name = ?', echo)).n, 0);
  assert.equal((await one('SELECT COUNT(*) AS n FROM mcp_grant_bindings WHERE tool_name = ?', echo)).n, 0);

  // A change computed from a row that changes meanwhile is refused (409) and changes nothing:
  // another client holds the row, the update reads it, then the holder renews the generation.
  const pool = await m.pool.getPgPool();
  const c = await pool.connect();
  let conflict;
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM mcp_servers WHERE id = $1 FOR UPDATE', [ids.mcp]);
    const pending = m.mcp.updateServer(ids.mcp, { url: 'http://127.0.0.1:65533/mcp' }, ids.owner).then(() => null, (e) => e);
    await sleep(200);
    await c.query('UPDATE mcp_servers SET generation = $1 WHERE id = $2', [randomUUID(), ids.mcp]);
    await c.query('COMMIT');
    conflict = await pending;
  } finally {
    c.release();
  }
  assert.equal(conflict?.code, 'conflict');
  assert.equal(conflict?.status, 409);
  assert.equal((await one('SELECT url FROM mcp_servers WHERE id = ?', ids.mcp)).url, 'http://127.0.0.1:65534/mcp', 'unchanged');

  // Delete: grants of the server's prefix and the row in one transaction.
  await pgRun(`INSERT INTO agent_tool_grants (agent_id, tool_name, granted_by) VALUES (?, ?, 'forged')`, ids.agent, `mcp__${ids.mcpName}__echo`);
  const del = await m.mcp.deleteServer(ids.mcp, ids.owner);
  assert.deepEqual(del.revokedGrants, [{ agentId: ids.agent, tool: echo }]);
  assert.equal(await one('SELECT id FROM mcp_servers WHERE id = ?', ids.mcp), undefined);
  assert.equal((await one('SELECT COUNT(*) AS n FROM agent_tool_grants WHERE tool_name = ?', echo)).n, 0);

  // Two adds with one name at the same time: one wins, the other is 409 name_taken.
  const name = `race${tag.slice(0, 4)}`;
  const results = await Promise.allSettled([1, 2].map(() => m.mcp.createServer({ name, transport: 'http', url: 'http://127.0.0.1:65535/mcp' }, ids.owner)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.equal(lost.reason.code, 'name_taken');
  assert.equal(lost.reason.status, 409);
  assert.equal((await one('SELECT COUNT(*) AS n FROM mcp_servers WHERE name = ?', name)).n, 1);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('settings: get/set round trip, keys encrypted at rest, concurrent updates keep both fields', { skip }, async () => {
  const mgr = new m.settings.SettingsManager();
  const defaults = await mgr.getSettings();
  assert.equal(defaults.provider, 'local');
  const key = `sk-test-${randomBytes(8).toString('hex')}`; // throwaway, test only
  await silent(() => mgr.updateSettings({ provider: 'claude', claude: { apiKey: key, model: 'm1' } }));
  const row = await one(`SELECT value, updated_at FROM app_settings WHERE key = 'agent_settings'`);
  assert.ok(!row.value.includes(key), 'API key encrypted at rest');
  assert.equal(typeof row.updated_at, 'number');
  const got = await mgr.getSettings();
  assert.equal(got.provider, 'claude');
  assert.equal(got.claude.apiKey, key);
  assert.equal(await mgr.getApiKey('claude'), key);
  assert.equal(await mgr.hasApiKey('claude'), true);
  assert.notEqual((await mgr.getSettingsMasked()).claude.apiKey, key);
  // A masked key keeps the stored one.
  const masked = (await mgr.getSettingsMasked()).claude.apiKey;
  await silent(() => mgr.updateSettings({ claude: { apiKey: masked, model: 'm2' } }));
  assert.equal(await mgr.getApiKey('claude'), key);
  // Two writers of different fields at the same time: neither is lost (one transaction under a lock).
  await silent(() => withHeldLock(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['app_settings:agent_settings'],
    () => Promise.all([mgr.updateSettings({ publicRooms: { allowAnonymous: true } }), mgr.updateSettings({ claude: { model: 'm3' } })])));
  const both = await mgr.getSettings();
  assert.deepEqual(both.publicRooms, { allowAnonymous: true });
  assert.equal(both.claude.model, 'm3');
  assert.equal(both.claude.apiKey, key);
  await silent(() => mgr.updateSettings({ publicRooms: { allowAnonymous: false } }));
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test('notifications: create (RETURNING), list, unread count, read, delete, stats by source', { skip }, async () => {
  const u = ids.owner;
  const a = await silent(() => m.notif.notify({ userId: u, title: 'A', body: 'x', source: `ext-${tag}`, meta: { k: 1 } }));
  const b = await silent(() => m.notif.notify({ userId: u, title: 'B' }));
  assert.equal(a.title, 'A');
  assert.equal(a.isRead, false);
  assert.equal(a.source, `ext-${tag}`);
  assert.equal(typeof a.id, 'string');
  assert.notEqual(a.id, b.id);
  let list = await m.notif.listNotifications(u, { limit: 50, offset: 0 });
  assert.deepEqual(list.rows.slice(0, 2).map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.equal(list.unreadCount, 2);
  assert.equal(typeof list.unreadCount, 'number');
  await m.notif.markNotificationRead(u, a.id);
  list = await m.notif.listNotifications(u, { unread: true, limit: 50, offset: 0 });
  assert.deepEqual(list.rows.map((r) => r.id), [b.id]);
  assert.deepEqual(await m.notif.notificationStatsBySource(`ext-${tag}`), { total: 1, unread: 0, byType: { info: 1 } });
  await m.notif.deleteReadNotifications(u);
  await m.notif.markAllNotificationsRead(u);
  await m.notif.deleteNotification(u, b.id);
  assert.equal((await m.notif.listNotifications(u, { limit: 50, offset: 0 })).rows.length, 0);

  const s1 = await m.notif.getNotificationSettings(u);
  assert.equal(s1.channelInApp, true);
  const both = await Promise.all([m.notif.getNotificationSettings(u), m.notif.saveNotificationSettings(u, { dndEnabled: true, dndStart: '23:00' })]);
  assert.equal(both[1].dndEnabled, true);
  assert.equal((await one('SELECT COUNT(*) AS n FROM notification_settings WHERE user_id = ?', u)).n, 1);
});

test('notification schedules: a due schedule fires once under two concurrent runners', { skip }, async () => {
  const u = ids.owner;
  const past = new Date(Date.now() - 60_000).toISOString();
  const sched = await m.notif.createSchedule({
    userId: u, title: `Due ${tag}`, body: '', type: 'reminder', scheduleType: 'daily', scheduleTime: '09:00',
    scheduleDays: null, scheduleDate: null, channels: JSON.stringify(['in_app', 'email']), nextFireAt: past,
  });
  assert.equal(typeof sched.id, 'string');
  const updated = await m.notif.updateSchedule(u, sched.id, () => ({ fields: ['body = ?'], vals: ['b'] }));
  assert.equal(updated.body, 'b');
  assert.equal(await m.notif.updateSchedule('someone-else', sched.id, () => ({ fields: [], vals: [] })), null);
  await silent(() => withHeldLock('SELECT id FROM notification_schedules WHERE id = $1 FOR UPDATE', [sched.id],
    () => Promise.all([m.notif.processScheduledNotifications(), m.notif.processScheduledNotifications()])));
  const fired = await all('SELECT channel FROM notifications WHERE user_id = ? AND title = ? ORDER BY channel', u, `Due ${tag}`);
  assert.deepEqual(fired.map((r) => r.channel), ['email', 'in_app'], 'one notification per channel, once');
  const after = (await m.notif.listSchedules(u)).find((r) => r.id === sched.id);
  assert.ok(Date.parse(after.next_fire_at.replace(' ', 'T') + 'Z') > Date.now(), 'next fire moved forward');
  await silent(() => m.notif.processScheduledNotifications());
  assert.equal((await one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = ?', u, `Due ${tag}`)).n, 2, 'not fired again');
  await m.notif.deleteSchedule(u, sched.id);
});

// ---------------------------------------------------------------------------
// Audit and analytics
// ---------------------------------------------------------------------------

test('audit_logs: write -> query (filters, newest first) -> cleanup', { skip }, async () => {
  const marker = `res-${tag}`;
  m.audit.logAudit({ event_type: 'data.create', event_category: 'data_modification', success: true, resource_id: marker, action: 'a1', user_id: ids.owner });
  m.audit.logAudit({ event_type: 'data.delete', event_category: 'data_modification', severity: 'warning', success: false, resource_id: marker, action: 'a2', user_id: ids.owner });
  await m.audit.flushAuditWrites();
  await pgRun(`INSERT INTO audit_logs (event_type, event_category, severity, success, action, resource_id, user_id, created_at)
               VALUES ('data.read', 'data_access', 'info', 1, 'old', ?, ?, '2000-01-01 00:00:00+00')`, marker, ids.owner);
  const mine = await m.audit.queryAuditLogs({ user_id: ids.owner, limit: 1000 });
  const rows = mine.filter((r) => r.resource_id === marker);
  assert.deepEqual(rows.map((r) => r.action), ['a2', 'a1', 'old'], 'newest first, id breaks the tie');
  assert.equal(typeof rows[0].id, 'number');
  assert.deepEqual((await m.audit.queryAuditLogs({ user_id: ids.owner, severity: 'warning' })).filter((r) => r.resource_id === marker).map((r) => r.action), ['a2']);
  assert.deepEqual((await m.audit.queryAuditLogs({ user_id: ids.owner, start_date: '2001-01-01T00:00:00Z', limit: 1000 })).filter((r) => r.resource_id === marker).map((r) => r.action), ['a2', 'a1']);
  assert.ok(await m.audit.cleanupAuditLogs(30) >= 1);
  assert.deepEqual((await all('SELECT action FROM audit_logs WHERE resource_id = ? ORDER BY id', marker)).map((r) => r.action), ['a1', 'a2']);
});

test('extension analytics: concurrent calls are all counted; periods, top errors, overview', { skip }, async () => {
  const ext = `ext-an-${tag}`;
  await pgRun('INSERT INTO extension_configs (extension_id, enabled) VALUES (?, 1)', ext);
  for (let i = 0; i < 20; i++) m.analytics.recordApiCall(ext, i % 5 === 0 ? { success: false } : undefined);
  let row;
  for (let i = 0; i < 100; i++) {
    row = await one('SELECT api_calls, error_count FROM extension_usage_stats WHERE extension_id = ?', ext);
    if (row?.api_calls === 20) break;
    await sleep(20);
  }
  assert.deepEqual(row, { api_calls: 20, error_count: 4 }, 'no lost count (one upsert per call)');
  m.audit.logAudit({ event_type: 'extension.api.call', event_category: 'extension', success: false, resource_id: ext, error_message: 'boom' });
  m.audit.logAudit({ event_type: 'extension.api.call', event_category: 'extension', success: false, resource_id: ext, error_message: 'boom' });
  await m.audit.flushAuditWrites();
  const a = await m.analytics.getExtensionAnalytics(ext);
  assert.deepEqual(a.today, { apiCalls: 20, errorCount: 4, errorRate: 20 });
  assert.equal(typeof a.allTime.apiCalls, 'number', 'numeric sums read as numbers');
  assert.equal(a.dailyBreakdown.length, 1);
  assert.deepEqual(a.topErrors.map((e) => [e.errorType, e.count]), [['boom', 2]]);
  const o = await m.analytics.getOverviewAnalytics();
  assert.ok(o.extensionStats.some((e) => e.extensionId === ext && e.apiCalls === 20));
  await silent(() => m.analytics.updateAllExtensionStorageStats());
  assert.equal((await one('SELECT api_calls, storage_files FROM extension_usage_stats WHERE extension_id = ?', ext)).api_calls, 20, 'storage update keeps the count');
});

test('security event store: in the main database (security_audit_events), write/read/stats/cleanup, no SQLite file', { skip }, async () => {
  const store = m.auditStorage.getAuditStorage(undefined, { retentionDays: 1, maxEvents: 100000 });
  await silent(() => store.initialize());
  const ev = (id, ms, action = 'login_failed') => ({
    id, timestamp: new Date(ms), category: 'auth', action, severity: 'medium',
    actor: { type: 'user', id: ids.owner, ip: '10.0.0.1' }, target: { type: 'account', id: 'x' },
    result: 'failure', details: { note: `Note ${id}` }, request: { method: 'POST' }, sessionId: `s-${tag}`,
  });
  const e1 = `ev1-${tag}`;
  const e2 = `ev2-${tag}`;
  await Promise.all([store.store(ev(e1, Date.now())), store.store(ev(e1, Date.now())), store.store(ev(e2, Date.now() - 3 * 86_400_000, 'execute_blocked'))]);
  assert.equal((await one('SELECT COUNT(*) AS n FROM security_audit_events WHERE id = ?', e1)).n, 1, 'a duplicate id is ignored');
  const got = await store.getById(e1);
  assert.equal(got.actor.id, ids.owner);
  assert.equal(got.target.id, 'x');
  assert.deepEqual(got.details, { note: `Note ${e1}` });
  assert.ok(got.timestamp instanceof Date);
  assert.equal(await store.getById('missing'), null);
  const found = await store.query({ search: `NOTE ${e1.toUpperCase()}`, actorId: ids.owner });
  assert.deepEqual(found.map((e) => e.id), [e1], 'search ignores case like SQLite');
  const recent = await store.getRecent(1000);
  assert.ok(recent.findIndex((e) => e.id === e1) < recent.findIndex((e) => e.id === e2), 'newest first');
  const stats = await store.getStats();
  assert.ok(stats.totalEvents >= 2);
  assert.ok(stats.failedLogins24h >= 1);
  assert.equal(typeof stats.byCategory.auth, 'number');
  assert.ok(JSON.parse(await store.exportToJson({ actorId: ids.owner })).some((e) => e.id === e1));
  assert.ok(await store.cleanup() >= 1);
  assert.equal(await store.getById(e2), null, 'older than the retention removed');
  // The audit repository reads it with its scope rules (admin).
  const repoRecent = await m.repos.repositories.audit.recent(A.admin, 1000);
  assert.ok(repoRecent.some((e) => e.id === e1));
  assert.ok((await m.repos.repositories.audit.stats(A.admin)).totalEvents >= 1);
  store.close();
  assert.equal(existsSync(process.env.AUDIT_DB_PATH), false, 'no SQLite audit file on PostgreSQL');
});

test('no ported statement reached SQLite', { skip }, async () => {
  assert.deepEqual(sqliteHits, []);
});
