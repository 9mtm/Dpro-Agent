'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function candidates({ defaultDir, home, cwd, backendDir, savedDir, explicitDir }) {
  const values = explicitDir ? [explicitDir] : [savedDir, defaultDir, path.join(home, '.agent-player'), path.join(home, '.dpro')];
  if (!explicitDir) for (const start of [cwd, backendDir]) {
    let dir = path.resolve(start);
    for (let i = 0; i < 7; i++) {
      values.push(path.join(dir, '.data'), path.join(dir, 'packages', 'backend', '.data'));
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
  }
  return [...new Set(values.filter(Boolean).map(p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }))];
}

// Run only the SQLite driver in bundled plain Node, never import application modules.
async function probe(node, backendDir, dir) {
  const first = await probeOnce(node, backendDir, dir);
  return first.reason === 'probe_timeout' ? probeOnce(node, backendDir, dir) : first;
}

function probeOnce(node, backendDir, dir) {
  if (!fs.existsSync(path.join(dir, 'agent-player.db'))) return Promise.resolve({ dir, state: 'missing' });
  return new Promise(resolve => execFile(node, ['-e', "process.argv.splice(1, 0, 'probe-data.cjs');\n" + fs.readFileSync(path.join(__dirname, 'probe-data.cjs'), 'utf8'), backendDir, dir],
    { cwd: path.dirname(node), timeout: 30000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      try { const value = JSON.parse(stdout); resolve({ dir, ...value }); }
      catch { resolve({ dir, state: 'unreadable', reason: error?.killed ? 'probe_timeout' : error?.code || 'invalid_probe_response' }); }
    }));
}
/** A verified saved owner wins selection; unrelated legacy probes must not delay startup. */
async function discover(node, backendDir, dirs, savedDir, probeCandidate = probe) {
  let saved;
  if (savedDir && dirs.includes(savedDir)) {
    saved = await probeCandidate(node, backendDir, savedDir);
    if (saved.state === 'existing') return [saved];
  }
  return Promise.all(dirs.map(dir => saved && dir === savedDir ? saved : probeCandidate(node, backendDir, dir)));
}

function decide(rows, savedDir) {
  const saved = savedDir && rows.find(r => r.dir === savedDir);
  if (saved?.state === 'existing') return { kind: 'existing', dir: saved.dir };
  // Never interpret a broken database or stale saved selection as a new installation.
  if (savedDir || rows.some(r => r.state === 'unreadable')) return { kind: 'choose' };
  const owners = rows.filter(r => r.state === 'existing');
  return owners.length === 1 ? { kind: 'existing', dir: owners[0].dir } : { kind: 'choose' };
}
module.exports = { candidates, probe, decide, discover };
