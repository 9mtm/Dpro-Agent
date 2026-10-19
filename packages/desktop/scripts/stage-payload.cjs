'use strict';
/**
 * Put the pieces the desktop app runs into packages/desktop/payload
 * (copied into the app by electron-builder as extraResources):
 *
 *   payload/node/node[.exe]  the Node runtime that runs the backend
 *   payload/backend/         backend source + its installed node_modules
 *   payload/node_modules/    hoisted dependencies, copied by an explicit resource mapping
 *   payload/core-ui/         UI bridge scripts + contracts + the candidate UI build
 *
 * Local builds only: the Node runtime is the one running this script (or
 * --node), the modules are the ones already installed (--backend-modules).
 * Nothing is downloaded. Release bundles with a pinned, checksummed Node and
 * production-only modules are INSTALLER-04.
 *
 * Usage: node scripts/stage-payload.cjs [--node <path>] [--backend-modules <dir>] [--root-modules <dir>] [--core-ui-dist <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');

const here = path.resolve(__dirname, '..');
const packages = path.resolve(here, '..');
const out = path.join(here, 'payload');

/** Backend parts the server needs at run time (no tests, no one-off maintenance scripts). */
const BACKEND_PARTS = ['package.json', 'tsconfig.json', 'src', 'extensions', 'skills', 'python-scripts'];
/** Bridge parts: its scripts and the plain-JS contracts it requires. */
const CORE_UI_SCRIPTS = ['application-server.cjs', 'build-artifacts.cjs', 'preview.cjs', 'memory-response.cjs'];

function parseArgs(argv) {
  const options = { node: process.execPath, backendModules: path.join(packages, 'backend', 'node_modules'), rootModules: path.join(packages, '..', 'node_modules'), coreUiDist: path.join(packages, 'core-ui', 'dist') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--node': 'node', '--backend-modules': 'backendModules', '--root-modules': 'rootModules', '--core-ui-dist': 'coreUiDist' }[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    options[key] = path.resolve(argv[i + 1]);
  }
  return options;
}

const SKIP_MODULES = new Set(['.bin', '.cache', '.vite']);
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, filter });
const noSecrets = src => !/(^|[\\/])\.env(\.|$)(?!example)/.test(src) && !src.split(path.sep).includes('.data');

/** A build made with --dev-quick-login carries test passwords: never put it into an app. */
function refuseDevAccounts(coreUi, buildDir) {
  const html = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
  if (!/<meta name="core-ui-dev-quick-login" content="disabled"\s*\/?\s*>/.test(html)) throw new Error('refusing UI without explicit disabled dev quick-login provenance');
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(path.join(coreUi, 'dev-accounts.local.json'), 'utf8')); } catch { return; }
  const needles = (Array.isArray(accounts) ? accounts : []).flatMap(a => [a && a.email, a && a.password]).filter(x => typeof x === 'string' && x.length >= 4);
  for (const file of fs.readdirSync(path.join(buildDir, 'assets'))) {
    const text = fs.readFileSync(path.join(buildDir, 'assets', file), 'utf8');
    if (needles.some(n => text.includes(n))) throw new Error('refusing a core-ui build with dev quick-login accounts compiled in; rebuild without --dev-quick-login');
  }
}

function stage(options) {
  for (const [label, p] of [['Node runtime', options.node], ['backend node_modules', options.backendModules], ['root node_modules', options.rootModules], ['core-ui dist', options.coreUiDist]]) {
    if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.mkdirSync(path.join(out, 'node'));
  fs.copyFileSync(fs.realpathSync(options.node), path.join(out, 'node', nodeName));
  fs.chmodSync(path.join(out, 'node', nodeName), 0o755);

  const backend = path.join(packages, 'backend');
  for (const part of BACKEND_PARTS) copy(path.join(backend, part), path.join(out, 'backend', part), noSecrets);
  const moduleFilter = src => !SKIP_MODULES.has(path.basename(src)) && noSecrets(src);
  copy(fs.realpathSync(options.backendModules), path.join(out, 'backend', 'node_modules'), moduleFilter);
  copy(fs.realpathSync(options.rootModules), path.join(out, 'node_modules'), moduleFilter);
  // node-pty's helper must stay executable (npm may have installed it without the bit).
  for (const helper of ['build/Release/spawn-helper', `prebuilds/${process.platform}-${process.arch}/spawn-helper`]) {
    const file = path.join(out, 'backend', 'node_modules', 'node-pty', helper);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }

  const coreUi = path.join(packages, 'core-ui');
  const ui = path.join(out, 'core-ui');
  fs.mkdirSync(path.join(ui, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(coreUi, 'package.json'), path.join(ui, 'package.json'));
  for (const file of CORE_UI_SCRIPTS) fs.copyFileSync(path.join(coreUi, 'scripts', file), path.join(ui, 'scripts', file));
  copy(path.join(coreUi, 'src'), path.join(ui, 'src'), src => fs.statSync(src).isDirectory() || /\.(c?js)$/.test(src));
  // Only the candidate build the pointer names, nothing older.
  const pointer = JSON.parse(fs.readFileSync(path.join(options.coreUiDist, 'candidate.json'), 'utf8'));
  if (pointer.status !== 'ready' || !/^build-[a-f0-9-]{36}$/.test(pointer.buildId)) throw new Error('core-ui candidate build is not ready');
  if (pointer.entryMode !== 'live-candidate') throw new Error('core-ui candidate build is not a live build (build it with --candidate --live-entry)');
  fs.mkdirSync(path.join(ui, 'dist'));
  fs.copyFileSync(path.join(options.coreUiDist, 'candidate.json'), path.join(ui, 'dist', 'candidate.json'));
  copy(path.join(options.coreUiDist, pointer.buildId), path.join(ui, 'dist', pointer.buildId));
  refuseDevAccounts(coreUi, path.join(ui, 'dist', pointer.buildId));
  return out;
}

if (require.main === module) {
  try {
    console.log(`Payload staged in ${stage(parseArgs(process.argv.slice(2)))}`);
  } catch (error) {
    console.error(`Stage failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { stage, parseArgs, BACKEND_PARTS, refuseDevAccounts };
