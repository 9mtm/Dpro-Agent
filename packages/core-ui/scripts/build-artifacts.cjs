const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const idPattern = /^build-[a-f0-9-]{36}$/;
const assetPattern = /^assets\/[A-Za-z0-9_-]+\.(?:js|css|gif)$/;
const allowed = name => name === 'index.html' || name === 'THIRD_PARTY_NOTICES.txt' || assetPattern.test(name);
const hash = data => createHash('sha256').update(data).digest('hex');
function directory(folder) {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe artifact directory');
}
function checkedRead(base, name) {
  const segments = name.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Unsafe artifact path');
  directory(base);
  for (let i = 1; i < segments.length; i++) directory(path.join(base, ...segments.slice(0, i)));
  const file = path.join(base, ...segments);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Unsafe artifact file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function outputRoot(packageRoot) {
  directory(packageRoot);
  const dist = path.join(packageRoot, 'dist');
  directory(dist);
  return dist;
}
function channelName(channel) {
  if (channel !== 'current' && channel !== 'candidate') throw new Error('Invalid build channel');
  return `${channel}.json`;
}
function readPointer(packageRoot, channel = 'current') {
  return JSON.parse(checkedRead(outputRoot(packageRoot), channelName(channel)).toString('utf8'));
}
function writePointer(packageRoot, value, channel = 'current') {
  const pointerName = channelName(channel);
  const dist = outputRoot(packageRoot);
  // Atomic replacement of metadata only; no output directory or file is deleted.
  const temporary = path.join(dist, `current-${randomUUID()}.json`);
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, path.join(dist, pointerName));
}
function checkEntry(entryMode, channel) {
  if (entryMode !== undefined && !['fictional', 'live-candidate'].includes(entryMode)) throw new Error('Invalid entry provenance');
  if (entryMode === 'live-candidate' && channel !== 'candidate') throw new Error('Live entry is candidate only');
}
function checkEntryHtml(entryMode, channel, html) {
  checkEntry(entryMode, channel);
  const live = html.includes('content="live-candidate"');
  if (live && (entryMode !== 'live-candidate' || channel !== 'candidate')) throw new Error('Live entry provenance mismatch');
  if (entryMode === 'live-candidate' && !live) throw new Error('Missing live entry provenance');
}
function beginBuild(packageRoot = root, channel = 'current', entryMode = 'fictional') {
  channelName(channel);
  checkEntry(entryMode, channel);
  directory(packageRoot);
  const dist = path.join(packageRoot, 'dist');
  if (!fs.existsSync(dist)) fs.mkdirSync(dist);
  directory(dist);
  const buildId = `build-${randomUUID()}`;
  const output = path.join(dist, buildId);
  fs.mkdirSync(output);
  writePointer(packageRoot, { schema: 1, status: 'building', buildId, entryMode }, channel);
  return { buildId, output };
}
function completeBuild(packageRoot, buildId, channel = 'current') {
  if (!idPattern.test(buildId)) throw new Error('Invalid build ID');
  const pointer = readPointer(packageRoot, channel);
  if (pointer.status !== 'building' || pointer.buildId !== buildId) throw new Error('Build superseded');
  const output = path.join(outputRoot(packageRoot), buildId);
  directory(output);
  directory(path.join(output, 'assets'));
  const names = ['index.html', 'THIRD_PARTY_NOTICES.txt', ...fs.readdirSync(path.join(output, 'assets')).map(name => `assets/${name}`)];
  if (!names.some(name => name.endsWith('.js')) || !names.some(name => name.endsWith('.css'))) throw new Error('Incomplete build');
  const files = names.sort().map(name => {
    if (!allowed(name)) throw new Error('Unexpected build asset');
    const data = checkedRead(output, name);
    return { path: name, size: data.length, sha256: hash(data) };
  });
  checkEntryHtml(pointer.entryMode, channel, checkedRead(output, 'index.html').toString('utf8'));
  const manifest = { schema: 1, status: 'ready', buildId, entryMode: pointer.entryMode, files };
  writePointer(packageRoot, manifest, channel);
  return manifest;
}
function failBuild(packageRoot, buildId, channel = 'current') {
  const pointer = readPointer(packageRoot, channel);
  if (pointer.buildId === buildId) writePointer(packageRoot, { schema: 1, status: 'failed', buildId }, channel);
}
function readCurrent(packageRoot = root, channel = 'current') {
  const manifest = readPointer(packageRoot, channel);
  if (manifest.schema !== 1 || manifest.status !== 'ready' || !idPattern.test(manifest.buildId)
      || !Array.isArray(manifest.files) || manifest.files.length > 100) throw new Error('No verified current build');
  checkEntry(manifest.entryMode, channel);
  const output = path.join(outputRoot(packageRoot), manifest.buildId);
  directory(output);
  const files = new Map();
  let total = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !allowed(entry.path) || files.has(entry.path)) throw new Error('Invalid artifact manifest');
    const data = checkedRead(output, entry.path);
    total += data.length;
    if (total > 40 * 1024 * 1024 || entry.size !== data.length || entry.sha256 !== hash(data)) throw new Error('Artifact integrity mismatch');
    files.set(entry.path, data);
  }
  if (!files.has('index.html') || !files.has('THIRD_PARTY_NOTICES.txt')
      || ![...files.keys()].some(name => name.endsWith('.js')) || ![...files.keys()].some(name => name.endsWith('.css'))) throw new Error('Incomplete artifact manifest');
  checkEntryHtml(manifest.entryMode, channel, files.get('index.html').toString('utf8'));
  return { manifest, output, files };
}
function packageCurrent(packageRoot = root) {
  const current = readCurrent(packageRoot);
  const evidence = path.join(packageRoot, '.build-evidence');
  if (!fs.existsSync(evidence)) fs.mkdirSync(evidence);
  directory(evidence);
  const output = fs.mkdtempSync(path.join(evidence, 'preview-package-'));
  fs.mkdirSync(path.join(output, 'assets'));
  for (const [name, data] of current.files) fs.writeFileSync(path.join(output, name), data, { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'BUILD_MANIFEST.json'), JSON.stringify(current.manifest, null, 2) + '\n', { flag: 'wx' });
  return output;
}
module.exports = { root, beginBuild, completeBuild, failBuild, readCurrent, packageCurrent };
