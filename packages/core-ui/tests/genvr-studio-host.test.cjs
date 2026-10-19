const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { createStudioHost, motionCatalog } = require('../scripts/genvr-studio-host.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-studio-host-'));
const library = path.join(root, 'library'), state = path.join(root, 'state');
fs.mkdirSync(path.join(library, 'Engine', 'motions'), { recursive: true });
const glb = Buffer.from('glTF fictional motion');
fs.writeFileSync(path.join(library, 'Engine', 'motions', 'wave.glb'), glb);
fs.writeFileSync(path.join(library, 'Engine', 'catalog.json'), JSON.stringify({ entries: [
  { id: 'motion:wave', name: 'Wave', category: 'Gesture', loop: false, duration: 2, contentHash: crypto.createHash('sha256').update(glb).digest('hex'), file: 'motions/wave.glb' },
  { id: 'motion:missing', name: 'Missing', category: 'Gesture', file: 'motions/missing.glb' },
  { id: 'motion:escape', name: 'Escape', category: 'Gesture', file: '../../outside.glb' },
] }));
const vendorRoot = path.resolve(__dirname, '..');
const hasVendor = fs.existsSync(path.join(vendorRoot, 'vendor', 'genvr', 'package', 'live-studio-bridge.mjs'));
const host = createStudioHost({ packageRoot: vendorRoot, env: { DPRO_GENVR_LIBRARY: library, DPRO_GENVR_STATE: state, DPRO_GENVR_VOICES: path.join(root, 'voices') } });
let server, base, token;
test.before(async () => {
  if (!hasVendor) return;
  server = http.createServer(async (req, res) => { if (!(await host.handle(req, res, new URL(req.url, 'http://x').pathname))) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`; await host.listening(base); token = await host.token();
});
test.after(async () => { await host.close(); server?.close(); fs.rmSync(root, { recursive: true, force: true }); });
const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {}) });

test('the motion catalog keeps only files inside the library; problems are reported', () => {
  const m = motionCatalog(library);
  assert.deepEqual(m.entries.map(e => e.id), ['motion:wave']);
  assert.equal(m.problems.length, 2);
});

test('library needs the bridge token AND an owner ticket; bridge and connection file work', { skip: !hasVendor }, async () => {
  const conn = JSON.parse(fs.readFileSync(path.join(state, 'studio-connection.json'), 'utf8'));
  assert.equal(conn.url, base); assert.equal(conn.token, token);
  assert.equal((fs.statSync(path.join(state, 'studio-connection.json')).mode & 0o777), 0o600);
  assert.equal((await post('/studio-library/motions')).status, 401);
  assert.equal((await post('/studio-library/motions', {}, { Authorization: 'Bearer ' + token })).status, 403);
  const { ticket } = host.issueTicket('owner-1');
  const auth = { Authorization: 'Bearer ' + token, 'X-Studio-Library': ticket };
  assert.deepEqual((await (await post('/studio-library/motions', {}, auth)).json()).motions.map(m => m.id), ['motion:wave']);
  const motion = await post('/studio-library/motion', { id: 'motion:wave' }, auth);
  assert.equal(motion.status, 200); assert.deepEqual(Buffer.from(await motion.arrayBuffer()), glb);
  assert.deepEqual(await (await post('/studio-bridge/sessions', {}, { Authorization: 'Bearer ' + token })).json(), { sessions: [] });
  assert.equal((await post('/studio-bridge/sessions', {}, { Authorization: 'Bearer ' + token, Origin: 'http://evil.example' })).status, 403);
});

test('imported characters: hash-checked, stored once, assignable; originals never touched', { skip: !hasVendor }, async () => {
  const { ticket } = host.issueTicket('owner-1');
  const auth = { Authorization: 'Bearer ' + token, 'X-Studio-Library': ticket };
  const data = Buffer.from('fictional converted character');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const metadata = { id: `user.mixamo.${sha256}.character`, kind: 'character', name: 'Fictional', originalFile: 'Fictional.fbx', sha256, importedAt: new Date().toISOString(), source: 'user-import', provider: 'mixamo', sourcePage: 'https://www.mixamo.com/', bundled: false };
  const put = (meta, bytes) => fetch(base + '/studio-library/put', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'X-Library-Metadata': Buffer.from(JSON.stringify(meta)).toString('base64url') }, body: bytes });
  assert.equal((await put(metadata, Buffer.from('other bytes'))).status, 400);
  assert.equal((await (await put(metadata, data)).json()).created, true);
  assert.equal((await (await put(metadata, data)).json()).created, false);
  assert.equal((await (await post('/studio-library/list', {}, auth)).json()).assets.length, 1);
  assert.deepEqual(Buffer.from(await (await post('/studio-library/get', { id: metadata.id }, auth)).arrayBuffer()), data);
  assert.equal((await post('/studio-library/assign', { projectId: 'p1', target: 'self', assetId: metadata.id }, auth)).status, 200);
  assert.equal((await (await post('/studio-library/assignment', { projectId: 'p1', target: 'self' }, auth)).json()).assetId, metadata.id);
  assert.equal((await post('/studio-library/assign', { projectId: 'p1', target: '../x', assetId: metadata.id }, auth)).status, 400);
  assert.ok(fs.existsSync(path.join(library, 'Engine', 'motions', 'wave.glb')));
});
