'use strict';
/**
 * Dpro on this computer: the UI bridge plus the backend, started and stopped
 * together (INSTALLER-05). No Electron here, so it is tested with plain Node.
 *
 * start():
 *  1. new per-launch token;
 *  2. UI bridge (core-ui application server) on 127.0.0.1, random port;
 *  3. backend on 127.0.0.1, random port, allowed origin = the bridge origin,
 *     token required on every request (the bridge adds it);
 *  4. while the owner does not exist yet: a one-time setup code, put in the
 *     returned URL's fragment only.
 * stop(): backend first (it may still be writing), then the bridge.
 */
const fs = require('node:fs');
const path = require('node:path');
const { startBackend, backendEnv, newLaunchToken } = require('./backend-process.cjs');
const { issueSetupCode } = require('./setup-code.cjs');

const HOST = '127.0.0.1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port: 0, exclusive: true }, () => { server.off('error', reject); resolve(server.address().port); });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/**
 * options: node, args, cwd (backend working folder), dataDir, createBridge({ upstreamPort, launchToken }) → http.Server,
 * onLog(line), onBackendExit(result) (unexpected stop after start), extraEnv, baseEnv, spawn, readyTimeoutMs.
 */
function createLocalRuntime(options) {
  const { node, args, cwd, dataDir, createBridge, onLog = () => {}, onBackendExit = () => {}, extraEnv, baseEnv, spawn, readyTimeoutMs } = options;
  let backend = null, bridge = null, state = 'idle';
  let startupAbort, pendingBackend;

  async function start() {
    if (state !== 'idle') throw new Error(`Cannot start while ${state}`);
    state = 'starting';
    startupAbort = new AbortController();
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const token = newLaunchToken();
      bridge = createBridge({ upstreamPort: () => (backend && backend.running ? backend.port : null), launchToken: token });
      const uiPort = await listen(bridge);
      const origin = `http://${HOST}:${uiPort}`;
      const launch = () => (pendingBackend = startBackend({
        node, args, cwd, spawn, readyTimeoutMs, onLog, signal: startupAbort.signal,
        env: backendEnv({ base: baseEnv, dataDir, token, allowedOrigin: origin, extra: extraEnv }),
        onExit: result => { if (state === 'running') onBackendExit(result); },
      }));
      try { backend = await launch(); }
      catch (error) {
        // A silent native startup can stall in getcwd before application code.
        // Retry once, only after the first child is fully reaped. Never retry
        // crashes or starts which emitted logs (they may have performed work).
        if (state !== 'starting' || error.code !== 'STARTUP_TIMEOUT' || error.logTail?.length) throw error;
        onLog('Silent backend startup timed out; retrying once with the same workspace.');
        backend = await launch();
      }
      if (state !== 'starting') { await backend.stop(); throw new Error('Startup cancelled.'); }
      const code = issueSetupCode(dataDir);
      state = 'running';
      return { origin, backendPort: backend.port, url: `${origin}/${code ? `#setup=${code}` : ''}`, setupCode: code !== null };
    } catch (error) {
      await stopAll();
      state = 'idle';
      throw error;
    }
  }

  async function stopAll() {
    let result = null;
    if (backend) { result = await backend.stop(); backend = null; }
    if (bridge) { if (bridge.listening) await closeServer(bridge); bridge = null; }
    return result;
  }

  async function stop() {
    if (state === 'idle' || state === 'stopped') return null;
    state = 'stopping';
    startupAbort?.abort();
    await pendingBackend?.catch(() => {});
    const result = await stopAll();
    state = 'stopped';
    return result;
  }

  return { start, stop, get state() { return state; }, get backendPid() { return backend ? backend.pid : null; } };
}

/** Append-only redacted log file (0600); cut to empty when it grows past maxBytes at open. */
function openLog(file, maxBytes = 5 * 1024 * 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if (fs.statSync(file).size > maxBytes) fs.truncateSync(file, 0); } catch { /* new file */ }
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.fchmodSync(fd, 0o600); } catch { /* not supported (Windows) */ }
  return {
    write: line => { try { fs.writeSync(fd, `${new Date().toISOString()} ${line}\n`); } catch { /* disk full: drop */ } },
    close: () => { try { fs.closeSync(fd); } catch { /* closed */ } },
  };
}

module.exports = { createLocalRuntime, openLog, listen, closeServer };
