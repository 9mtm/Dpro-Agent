'use strict';
// Standalone packaging guard: run bundled Node outside the checkout, without importing app stores.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
function verifyBundle(app) {
  const root = path.resolve(app);
  const payload = fs.existsSync(path.join(root, 'Contents')) ? path.join(root, 'Contents', 'Resources', 'payload') : path.join(root, 'resources', 'payload');
  const node = path.join(payload, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const backend = path.join(payload, 'backend');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-bundle-check-'));
  try {
    const env = { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd };
    const source = `const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');const r=createRequire(process.argv[1]);(async()=>{r('better-sqlite3');r('bcryptjs');r('fastify');await import(pathToFileURL(r.resolve('@modelcontextprotocol/sdk/client/index.js')));console.log('PASS: isolated bundled runtime dependencies');})().catch(()=>{console.error('Bundled dependency import failed');process.exitCode=1;});`;
    return execFileSync(node, ['-e', source, path.join(backend, 'package.json')], { cwd, env, timeout: 60000, encoding: 'utf8' }).trim();
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
if (require.main === module) { try { console.log(verifyBundle(process.argv[2])); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { verifyBundle };
