'use strict';
// Process lifecycle of the desktop app (INSTALLER-05), with a stand-in backend.
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { startBackend, backendEnv, newLaunchToken, redactor } = require('../src/backend-process.cjs');
const { createLocalRuntime, openLog } = require('../src/local-runtime.cjs');
const { issueSetupCode, SETUP_TOKEN_FILE, SETUP_FLAG_FILE } = require('../src/setup-code.cjs');

const FAKE = path.join(__dirname, 'fixtures', 'fake-backend.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-desktop-'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function get(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers, agent: false }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
  });
}

function fakeEnv(dataDir, extra = {}) {
  return backendEnv({ base: { PATH: process.env.PATH, HOME: os.homedir(), FAKE_SECRET: 'must-not-pass' }, dataDir, token: newLaunchToken(), allowedOrigin: 'http://127.0.0.1:1', extra });
}

/** A tiny bridge with the real bridge's contract: it adds the token and forwards to the current backend port. */
function fakeBridge({ upstreamPort, launchToken }) {
  return http.createServer((_req, res) => {
    const port = upstreamPort();
    if (!port) { res.writeHead(503); return res.end(); }
    http.get({ host: '127.0.0.1', port, path: '/', headers: { 'X-Agent-Player-Launch': launchToken }, agent: false }, up => {
      res.writeHead(up.statusCode, up.headers); up.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end(); });
  });
}

test('launch token: 43 url-safe characters, new every time', () => {
  const a = newLaunchToken(), b = newLaunchToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('backend env: loopback, random port, data dir, token; no unrelated variables', () => {
  const env = backendEnv({ base: { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-x', DATABASE_PATH: '/real.db' }, dataDir: '/d', token: 't'.repeat(43), allowedOrigin: 'http://127.0.0.1:5' });
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PORT, '0');
  assert.equal(env.AGENT_PLAYER_DATA_DIR, '/d');
  assert.equal(env.ALLOWED_ORIGINS, 'http://127.0.0.1:5');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_PATH, undefined);
});

test('redactor removes secrets from log lines', () => {
  const r = redactor(['secret-value-123']);
  assert.equal(r('a secret-value-123 b secret-value-123'), 'a [redacted] b [redacted]');
});

test('starts on a random loopback port, needs the token, stops cleanly', async t => {
  const dir = tmp();
  const env = fakeEnv(dir);
  const lines = [];
  const backend = await startBackend({ node: process.execPath, args: [FAKE], cwd: dir, env, onLog: l => lines.push(l) });
  assert.ok(backend.port > 0);
  assert.ok(alive(backend.pid));
  assert.equal((await get(backend.port)).status, 403);
  const ok = await get(backend.port, { 'x-agent-player-launch': env.AGENT_PLAYER_LAUNCH_TOKEN });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.leaked, null);
  assert.equal(ok.body.dataDir, dir);
  const result = await backend.stop(2000);
  assert.equal(result.forced, false);
  assert.equal(result.code, 0);
  assert.equal(alive(backend.pid), false);
  assert.ok(lines.some(l => l.includes('token=[redacted]')));
  assert.ok(!lines.join('\n').includes(env.AGENT_PLAYER_LAUNCH_TOKEN));
});

test('a backend that ignores the stop request is killed after the grace period', async t => {
  const dir = tmp();
  const backend = await startBackend({ node: process.execPath, args: [FAKE], cwd: dir, env: fakeEnv(dir, { FAKE_MODE: 'ignore-stop' }) });
  const result = await backend.stop(300);
  assert.equal(result.forced, true);
  assert.equal(alive(backend.pid), false);
});

test('a crash while starting is reported with a redacted log tail', async t => {
  const dir = tmp();
  const env = fakeEnv(dir, { FAKE_MODE: 'crash' });
  await assert.rejects(startBackend({ node: process.execPath, args: [FAKE], cwd: dir, env }), error => {
    assert.match(error.message, /exit code 3/);
    assert.ok(error.logTail.some(l => l.includes('boom [redacted]')));
    return true;
  });
});

test('no ready message in time: start fails and the process is gone', async t => {
  const dir = tmp();
  const pids = [];
  const spawn = (...a) => { const c = require('node:child_process').spawn(...a); pids.push(c.pid); return c; };
  await assert.rejects(startBackend({ node: process.execPath, args: [FAKE], cwd: dir, env: fakeEnv(dir, { FAKE_MODE: 'never-ready' }), spawn, readyTimeoutMs: 500 }), /did not start in time/);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(alive(pids[0]), false);
});

test('a backend that reports a non-loopback address is refused', async t => {
  const dir = tmp();
  await assert.rejects(startBackend({ node: process.execPath, args: [FAKE], cwd: dir, env: fakeEnv(dir, { FAKE_MODE: 'wrong-host' }) }), /not bound to 127\.0\.0\.1/);
});

test('missing Node runtime: clear start error', async t => {
  const dir = tmp();
  await assert.rejects(startBackend({ node: path.join(dir, 'no-node'), args: [FAKE], cwd: dir, env: fakeEnv(dir) }), /could not be started|stopped while starting/);
});

test('local runtime: bridge + backend up, setup code in the fragment only, everything down after stop', async t => {
  const dir = tmp();
  const runtime = createLocalRuntime({ node: process.execPath, args: [FAKE], cwd: dir, dataDir: path.join(dir, 'data'), createBridge: fakeBridge, baseEnv: { PATH: process.env.PATH } });
  t.after(() => runtime.stop());
  const started = await runtime.start();
  assert.equal(runtime.state, 'running');
  const url = new URL(started.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.hash, /^#setup=[A-Za-z0-9_-]{43}$/);
  assert.equal(started.setupCode, true);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'data', SETUP_TOKEN_FILE), 'utf8'));
  assert.equal(stored.hash, createHash('sha256').update(url.hash.slice(7)).digest('hex'));
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(dir, 'data', SETUP_TOKEN_FILE)).mode & 0o777), 0o600);
  // Through the bridge the token is added; the page never needs it.
  const through = await get(Number(url.port));
  assert.equal(through.status, 200);
  assert.equal(through.body.origin, started.origin);
  const pid = runtime.backendPid;
  await runtime.stop();
  assert.equal(runtime.state, 'stopped');
  assert.equal(alive(pid), false);
  await assert.rejects(get(Number(url.port)));
  await assert.rejects(get(started.backendPort));
});

test('local runtime: no setup code once the owner exists', async t => {
  const dir = tmp();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, SETUP_FLAG_FILE), '');
  const runtime = createLocalRuntime({ node: process.execPath, args: [FAKE], cwd: dir, dataDir, createBridge: fakeBridge, baseEnv: { PATH: process.env.PATH } });
  t.after(() => runtime.stop());
  const started = await runtime.start();
  assert.equal(new URL(started.url).hash, '');
  assert.equal(fs.existsSync(path.join(dataDir, SETUP_TOKEN_FILE)), false);
  await runtime.stop();
});

test('local runtime: a failed start leaves no bridge port and no process', async t => {
  const dir = tmp();
  let bridge;
  const createBridge = o => (bridge = fakeBridge(o));
  const runtime = createLocalRuntime({ node: process.execPath, args: [FAKE], cwd: dir, dataDir: path.join(dir, 'data'), createBridge, baseEnv: { PATH: process.env.PATH }, extraEnv: { FAKE_MODE: 'crash' } });
  t.after(() => runtime.stop());
  await assert.rejects(runtime.start());
  assert.equal(bridge.listening, false);
  assert.equal(runtime.state, 'idle');
});

test('local runtime: an unexpected backend exit is reported, the bridge answers 503', async t => {
  const dir = tmp();
  let exited;
  const gone = new Promise(r => { exited = r; });
  const runtime = createLocalRuntime({ node: process.execPath, args: [FAKE], cwd: dir, dataDir: path.join(dir, 'data'), createBridge: fakeBridge, baseEnv: { PATH: process.env.PATH }, onBackendExit: exited });
  t.after(() => runtime.stop());
  const started = await runtime.start();
  process.kill(runtime.backendPid, 'SIGKILL');
  const result = await gone;
  if (process.platform === 'win32') assert.notEqual(result.code, 0); else assert.equal(result.signal, 'SIGKILL');
  assert.equal((await get(Number(new URL(started.url).port))).status, 503);
  await runtime.stop();
});

test('setup code file: hash only, replaced on each issue', () => {
  const dir = tmp();
  const a = issueSetupCode(dir), b = issueSetupCode(dir);
  assert.notEqual(a, b);
  const raw = fs.readFileSync(path.join(dir, SETUP_TOKEN_FILE), 'utf8');
  assert.ok(!raw.includes(a) && !raw.includes(b));
  assert.equal(JSON.parse(raw).hash, createHash('sha256').update(b).digest('hex'));
});

test('log file is 0600 and cut when too large', () => {
  const dir = tmp();
  const file = path.join(dir, 'logs', 'backend.log');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'x'.repeat(100));
  const log = openLog(file, 50);
  log.write('hello');
  log.close();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('xxx') && text.includes('hello'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('silent native startup timeout reaps first child before one successful retry', async t => {
  const dir=tmp(), pids=[];
  const spawn=(node,args,opts)=>{
    if(pids.length) assert.equal(alive(pids[0]),false);
    const child=require('node:child_process').spawn(node,pids.length ? args : ['-e','setInterval(()=>{},1000)'],opts);
    pids.push(child.pid);return child;
  };
  const runtime=createLocalRuntime({node:process.execPath,args:[FAKE],cwd:dir,dataDir:dir,createBridge:fakeBridge,spawn,readyTimeoutMs:250});
  t.after(() => runtime.stop());
  try {await runtime.start();assert.equal(pids.length,2);assert.equal(runtime.state,'running');}
  finally {await runtime.stop();}
  assert.ok(pids.every(pid=>!alive(pid)));
});

test('silent startup retry is bounded and leaves no child alive', async t => {
  const dir=tmp(),pids=[];
  const spawn=(node,args,opts)=>{const c=require('node:child_process').spawn(node,['-e','setInterval(()=>{},1000)'],opts);pids.push(c.pid);return c;};
  const runtime=createLocalRuntime({node:process.execPath,args:[FAKE],cwd:dir,dataDir:dir,createBridge:fakeBridge,spawn,readyTimeoutMs:150});
  t.after(() => runtime.stop());
  await assert.rejects(runtime.start(),/did not start in time/);assert.equal(pids.length,2);assert.ok(pids.every(pid=>!alive(pid)));
});

test('stop during silent startup cancels without launching a retry', async t => {
  const dir=tmp(),pids=[];
  let launched;const launch=new Promise(r=>launched=r);
  const spawn=(node,args,opts)=>{const c=require('node:child_process').spawn(node,['-e','setInterval(()=>{},1000)'],opts);pids.push(c.pid);launched();return c;};
  const runtime=createLocalRuntime({node:process.execPath,args:[FAKE],cwd:dir,dataDir:dir,createBridge:fakeBridge,spawn,readyTimeoutMs:5000});
  t.after(() => runtime.stop());
  const pending=assert.rejects(runtime.start(),/cancelled/);await launch;await runtime.stop();assert.ok(pids.every(pid=>!alive(pid)));await pending;
  assert.equal(pids.length,1);assert.ok(pids.every(pid=>!alive(pid)));
});
