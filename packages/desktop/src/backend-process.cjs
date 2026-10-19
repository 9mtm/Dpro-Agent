'use strict';
/**
 * The backend as a child process of the desktop app (INSTALLER-05).
 *
 * The backend runs on the bundled plain Node runtime (not on Electron's own
 * Node), so its native modules keep the ABI they were built for. It listens on
 * 127.0.0.1 with PORT=0 (a random free port) and reports the real port over
 * the IPC channel; every request must carry the per-launch token
 * (packages/backend/src/api/launch-token.ts).
 *
 * Stop: an IPC "shutdown" message (works on every OS; SIGTERM when the
 * channel is already closed), then SIGKILL after the grace period. The backend also shuts itself
 * down when the IPC channel closes, so a crashed app leaves nothing behind.
 */
const { spawn: nodeSpawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const READY_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 15_000;
const LOG_TAIL_LINES = 40;

/** 32 random bytes, base64url: 43 characters (the shape the backend accepts). */
const newLaunchToken = () => randomBytes(32).toString('base64url');

/** OS variables the backend may need (PATH for git/docker/python, home, locale, temp). Nothing else leaks in. */
const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles'];

function backendEnv({ base = process.env, dataDir, token, allowedOrigin, extra = {} }) {
  const env = {};
  for (const key of PASS_THROUGH) if (typeof base[key] === 'string') env[key] = base[key];
  return {
    ...env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '0',
    AGENT_PLAYER_DATA_DIR: dataDir,
    AGENT_PLAYER_LAUNCH_TOKEN: token,
    ALLOWED_ORIGINS: allowedOrigin,
    FRONTEND_URL: allowedOrigin,
    ...extra,
  };
}

/** Replace every secret value with a marker before a line reaches a log. */
function redactor(secrets) {
  const list = secrets.filter(s => typeof s === 'string' && s.length >= 8);
  return line => list.reduce((out, s) => out.split(s).join('[redacted]'), line);
}

/**
 * Start the backend; resolves once it listens.
 * options: node (path of the bundled Node), args (e.g. ['--import', <tsx loader>, 'src/api/server.ts']),
 * cwd, env (from backendEnv), secrets (values to redact), onLog(line), onExit({ code, signal }) after ready,
 * spawn (tests), readyTimeoutMs.
 */
function startBackend({ node, args, cwd, env, secrets = [], onLog = () => {}, onExit = () => {}, spawn = nodeSpawn, readyTimeoutMs = READY_TIMEOUT_MS, signal }) {
  const redact = redactor([env.AGENT_PLAYER_LAUNCH_TOKEN, ...secrets]);
  const tail = [];
  const log = line => {
    const clean = redact(line);
    tail.push(clean);
    if (tail.length > LOG_TAIL_LINES) tail.shift();
    onLog(clean);
  };
  const child = spawn(node, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: false });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop();
      for (const line of parts) log(line);
    });
    stream.on('end', () => { if (rest) log(rest); rest = ''; });
  }
  let exited = false;
  let timedOut = false;
  const exitedPromise = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));

  return new Promise((resolve, reject) => {
    let ready = false, failed = false;
    const cancel = () => { timedOut = true; stopChild(child, () => exited, exitedPromise, 2000).then(() => fail('Startup cancelled.', 'STARTUP_CANCELLED')); };
    const fail = (message, code) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      const error = new Error(message);
      error.logTail = tail.slice();
      if (code) error.code = code;
      reject(error);
    };
    const timer = setTimeout(() => {
      if (ready) return;
      timedOut = true;
      // Finish cleanup before allowing a retry to touch the same workspace.
      stopChild(child, () => exited, exitedPromise, 2000).then(() => fail('The backend did not start in time.', 'STARTUP_TIMEOUT'));
    }, readyTimeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', error => { if (!ready) fail(`The backend could not be started (${error.code || 'error'}).`); });
    child.on('message', message => {
      if (ready || failed || timedOut || signal?.aborted || !message || message.type !== 'listening' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
      if (message.host !== undefined && message.host !== '127.0.0.1') {
        fail('The backend is not bound to 127.0.0.1.');
        stopChild(child, () => exited, exitedPromise, 2000);
        return;
      }
      ready = true;
      signal?.removeEventListener('abort', cancel);
      clearTimeout(timer);
      let stopping = false;
      exitedPromise.then(result => { if (!stopping) onExit(result); });
      resolve({
        port: message.port,
        pid: child.pid,
        exited: exitedPromise,
        get running() { return !exited; },
        logTail: () => tail.slice(),
        stop: (graceMs = STOP_GRACE_MS) => { stopping = true; return stopChild(child, () => exited, exitedPromise, graceMs); },
      });
    });
    exitedPromise.then(({ code, signal }) => { if (!ready && !timedOut) fail(`The backend stopped while starting (${signal || `exit code ${code}`}).`); });
  });
}

/** Ask politely (IPC, else SIGTERM), force after graceMs. Resolves with { code, signal, forced }. */
async function stopChild(child, isExited, exitedPromise, graceMs) {
  if (isExited()) return { ...(await exitedPromise), forced: false };
  let asked = false;
  try { if (child.connected) { child.send({ type: 'shutdown' }); asked = true; } } catch { /* channel already closed */ }
  if (!asked && process.platform !== 'win32') { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  let timer;
  const forced = await Promise.race([
    exitedPromise.then(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(true), graceMs); }),
  ]);
  clearTimeout(timer);
  if (forced) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  return { ...(await exitedPromise), forced };
}

module.exports = { startBackend, backendEnv, newLaunchToken, redactor, READY_TIMEOUT_MS, STOP_GRACE_MS };
