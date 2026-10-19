const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, beginBuild, completeBuild, failBuild } = require('./build-artifacts.cjs');
const { copyNotices } = require('./copy-notices.cjs');
function parseBuildArgs(args) {
  if (args.some(arg => !['--candidate', '--live-entry', '--dev-quick-login'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Invalid build arguments');
  const channel = args.includes('--candidate') ? 'candidate' : 'current';
  const entryMode = args.includes('--live-entry') ? 'live-candidate' : 'fictional';
  if (entryMode === 'live-candidate' && channel !== 'candidate') throw new Error('Live entry requires candidate build');
  // Local testing only (src/dev-quick-login.ts): never in a current or fictional build.
  if (args.includes('--dev-quick-login')) {
    if (entryMode !== 'live-candidate') throw new Error('Dev quick login requires --candidate --live-entry');
    return { channel, entryMode, devQuickLogin: true };
  }
  return { channel, entryMode };
}

/**
 * Test accounts for a --dev-quick-login build: a JSON array of
 * { label?, email, password } in the Git-ignored dev-accounts.local.json
 * next to package.json (a fixed path: the build reads no environment).
 * Refuses anything else.
 */
function loadDevAccounts(file = path.join(root, 'dev-accounts.local.json')) {
  let list;
  try { list = JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch { throw new Error(`Dev quick login: cannot read a JSON account list from ${file}`); }
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) throw new Error('Dev quick login: the file must hold 1-10 accounts');
  return list.map((a, i) => {
    if (!a || typeof a.email !== 'string' || !a.email || typeof a.password !== 'string' || !a.password) throw new Error(`Dev quick login: account ${i + 1} needs email and password`);
    return { label: typeof a.label === 'string' && a.label ? a.label : a.email, email: a.email, password: a.password };
  });
}
async function main(args = process.argv.slice(2)) {
  const { channel, entryMode, devQuickLogin } = parseBuildArgs(args);
  const devAccounts = devQuickLogin ? loadDevAccounts() : null;
  const { buildId, output } = beginBuild(root, channel, entryMode);
  try {
    const check = spawnSync(process.execPath, [path.join(__dirname, 'typecheck.cjs')], { cwd: root, stdio: 'inherit' });
    if (check.error || check.status !== 0) throw new Error('Typecheck failed');
    const { build } = await import('vite');
    await build({ configFile: false, root, base: '/', envDir: false, publicDir: false,
      define: { __LIVE_ENTRY_CANDIDATE__: JSON.stringify(entryMode === 'live-candidate'), __DEV_QUICK_LOGIN__: JSON.stringify(devAccounts) },
      plugins: [{ name: 'entry-provenance', transformIndexHtml: () => [
        { tag: 'meta', attrs: { name: 'core-ui-entry', content: entryMode }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'core-ui-dev-quick-login', content: devQuickLogin ? 'enabled' : 'disabled' }, injectTo: 'head' },
      ] }],
      css: { postcss: { plugins: [] } },
      build: { outDir: output, emptyOutDir: false, license: true } });
    copyNotices(output);
    completeBuild(root, buildId, channel);
    console.log(`${channel} build: ${output}\nManifest: ${path.join(root, 'dist', `${channel}.json`)}`);
    if (devAccounts) console.log(`WARNING: local test build with ${devAccounts.length} dev quick-login account(s) compiled in. Serve it on 127.0.0.1 only; never publish it.`);
  } catch (error) {
    failBuild(root, buildId, channel);
    throw error;
  }
}
module.exports = { parseBuildArgs, loadDevAccounts };
if (require.main === module) main().catch(() => { console.error('Build failed; preview disabled for this result. Previous outputs retained.'); process.exitCode = 1; });
