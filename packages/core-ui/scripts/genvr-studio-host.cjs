'use strict';
/**
 * Local Studio host services for the GenVR frame (same origin, loopback only):
 * - the SDK's live bridge (live MCP control and the local voice service), and
 * - the owner's private character/motion library, read from local files.
 *
 * Nothing here is published or uploaded. The motion catalog is served from its
 * own folder (no copy); characters converted by the Studio importer are kept
 * in this host's state folder, outside browser storage and world files. Every
 * request needs the bridge token, a loopback Host and a same-origin Origin.
 *
 * Configuration (all optional; without a library folder only the bridge runs):
 *   DPRO_GENVR_LIBRARY     private library root (Engine/catalog.json, Engine/motions…)
 *   DPRO_GENVR_STATE       host state folder (default ~/.genvr/dpro-studio)
 *   DPRO_GENVR_VOICES      saved voice library (default ~/.genvr/voices)
 *   GENVR_VOICE_PYTHON     Python of the optional voice runtime
 *   DPRO_GENVR_CONNECTION  live MCP connection file (default <state>/studio-connection.json)
 */
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const MAX_ASSET = 64 * 1024 * 1024;
const ASSET_ID = /^user\.mixamo\.[a-f0-9]{64}\.(character|motion)$/;
const SAFE = /^[A-Za-z0-9._-]{1,120}$/;

function json(res, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' }); res.end(data);
}
async function body(req, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await fsp.rename(temp, file);
}

/** The motion catalog of a private library: entries checked against their recorded hashes on first use. */
function motionCatalog(root) {
  if (!root) return { entries: [], problems: [] };
  const engine = path.join(root, 'Engine');
  let catalog; try { catalog = JSON.parse(fs.readFileSync(path.join(engine, 'catalog.json'), 'utf8')); } catch { return { entries: [], problems: ['Engine/catalog.json is missing or unreadable'] }; }
  const entries = [], problems = [], seen = new Set();
  for (const e of Array.isArray(catalog.entries) ? catalog.entries : []) {
    const file = typeof e?.file === 'string' ? path.resolve(engine, e.file) : '';
    if (typeof e?.id !== 'string' || seen.has(e.id) || !file.startsWith(engine + path.sep) || !/\.glb$/i.test(file)) { problems.push(`invalid catalog entry ${String(e?.id ?? '?')}`); continue; }
    let size; try { const st = fs.statSync(file); if (!st.isFile()) throw Error(); size = st.size; } catch { problems.push(`missing motion file ${e.file}`); continue; }
    if (size > MAX_ASSET) { problems.push(`motion file over 64 MB ${e.file}`); continue; }
    seen.add(e.id);
    entries.push({ id: e.id, name: String(e.name ?? e.id).slice(0, 150), category: String(e.category ?? 'Other').slice(0, 80), loop: e.loop === true, duration: Number(e.duration) || null, contentHash: typeof e.contentHash === 'string' ? e.contentHash : null, file });
  }
  return { entries, problems };
}

function createStudioHost({ env = process.env, packageRoot } = {}) {
  const home = os.homedir();
  const state = path.resolve(env.DPRO_GENVR_STATE || path.join(home, '.genvr', 'dpro-studio'));
  const libraryRoot = env.DPRO_GENVR_LIBRARY ? path.resolve(env.DPRO_GENVR_LIBRARY) : null;
  const connectionFile = path.resolve(env.DPRO_GENVR_CONNECTION || path.join(state, 'studio-connection.json'));
  const vendor = path.join(packageRoot, 'vendor', 'genvr', 'package');
  const indexFile = path.join(state, 'user-library.json');
  const motions = motionCatalog(libraryRoot);
  const verified = new Set();
  let bridge = null, voice = null, ready = null, origin = null;

  async function start() {
    const { createLiveStudioBridge } = await import(pathToFileURL(path.join(vendor, 'live-studio-bridge.mjs')).href);
    const { createLocalVoice } = await import(pathToFileURL(path.join(vendor, 'local-voice.mjs')).href);
    voice = createLocalVoice({
      directory: path.resolve(env.DPRO_GENVR_VOICES || path.join(home, '.genvr', 'voices')),
      python: env.GENVR_VOICE_PYTHON || undefined,
      modelCache: path.resolve(env.DPRO_GENVR_VOICE_MODELS || path.join(home, '.genvr', 'voice-models')),
      generated: (audio, sessionId, projectId) => { const rows = bridge.list().filter(row => row.projectId === projectId); return bridge.call(audio.control ? 'avatar_speech_control' : 'avatar_speech', audio, sessionId ?? (rows.length === 1 ? rows[0].id : undefined)); },
    });
    bridge = createLiveStudioBridge({ voice });
  }
  const available = () => fs.existsSync(path.join(vendor, 'live-studio-bridge.mjs'));
  const ensure = () => (ready ??= start());

  /** Tell the host where it listens; writes the live MCP connection file (mode 600). */
  async function listening(url) {
    if (!available()) return;
    await ensure(); origin = new URL(url).origin;
    await atomicWrite(connectionFile, JSON.stringify({ version: 1, url: origin, token: bridge.token }));
  }

  async function readIndex() { try { const v = JSON.parse(await fsp.readFile(indexFile, 'utf8')); return { assets: Array.isArray(v.assets) ? v.assets : [], assignments: v.assignments && typeof v.assignments === 'object' ? v.assignments : {} }; } catch { return { assets: [], assignments: {} }; } }
  let queue = Promise.resolve();
  const update = fn => (queue = queue.then(async () => { const index = await readIndex(); const out = await fn(index); await atomicWrite(indexFile, JSON.stringify(index)); return out; }));
  const assetFile = id => path.join(state, 'user-library', `${id}.glb`);

  function allowedRequest(req) {
    let host; try { host = new URL('http://' + req.headers.host); } catch { return false; }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
    if (req.headers.origin && req.headers.origin !== host.origin) return false;
    const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + bridge.token);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async function library(req, res, pathname) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST required.' });
    if (pathname === '/studio-library/put') {
      // Metadata travels in a header (base64url JSON): request URLs are kept short.
      let metadata = null; try { metadata = JSON.parse(Buffer.from(String(req.headers['x-library-metadata'] ?? ''), 'base64url').toString('utf8')); } catch { /* invalid below */ }
      if (!metadata || !ASSET_ID.test(metadata.id) || metadata.kind !== metadata.id.split('.').pop() || metadata.bundled !== false || metadata.provider !== 'mixamo' || JSON.stringify(metadata).length > 200000) return json(res, 400, { error: 'Invalid library item.' });
      const data = await body(req, MAX_ASSET);
      if (crypto.createHash('sha256').update(data).digest('hex') !== metadata.sha256 || metadata.id !== `user.mixamo.${metadata.sha256}.${metadata.kind}`) return json(res, 400, { error: 'Library item does not match its hash.' });
      const created = await update(async index => {
        if (index.assets.some(a => a.id === metadata.id)) return false; // same bytes already imported: keep the first copy and its provenance
        await atomicWrite(assetFile(metadata.id), data); index.assets.push(metadata); return true;
      });
      return json(res, 200, { ok: true, created });
    }
    const input = JSON.parse((await body(req, 65536)).toString() || '{}');
    switch (pathname) {
      case '/studio-library/list': return json(res, 200, { assets: (await readIndex()).assets });
      case '/studio-library/get': {
        if (!ASSET_ID.test(input.id)) return json(res, 400, { error: 'Invalid id.' });
        const meta = (await readIndex()).assets.find(a => a.id === input.id); if (!meta) return json(res, 404, { error: 'Not found.' });
        const data = await fsp.readFile(assetFile(input.id));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' }); res.end(data); return;
      }
      case '/studio-library/remove': {
        // Removes Dpro's converted copy only; the original download is never touched.
        if (!ASSET_ID.test(input.id)) return json(res, 400, { error: 'Invalid id.' });
        await update(async index => { index.assets = index.assets.filter(a => a.id !== input.id); for (const k of Object.keys(index.assignments)) if (index.assignments[k] === input.id) delete index.assignments[k]; await fsp.rm(assetFile(input.id), { force: true }); });
        return json(res, 200, { ok: true });
      }
      case '/studio-library/assignment': case '/studio-library/assign': {
        if (!SAFE.test(input.projectId) || !/^(self|[A-Za-z0-9_-]{1,100})$/.test(input.target)) return json(res, 400, { error: 'Invalid assignment.' });
        const key = `${input.projectId}\u0000${input.target}`;
        if (pathname === '/studio-library/assignment') return json(res, 200, { assetId: (await readIndex()).assignments[key] ?? null });
        if (!(input.assetId === null || ASSET_ID.test(input.assetId))) return json(res, 400, { error: 'Invalid id.' });
        await update(async index => { if (input.assetId === null) delete index.assignments[key]; else if (index.assets.some(a => a.id === input.assetId)) index.assignments[key] = input.assetId; else throw Object.assign(Error('Unknown library item.'), { status: 404 }); });
        return json(res, 200, { ok: true });
      }
      case '/studio-library/motions': return json(res, 200, { motions: motions.entries.map(({ file, contentHash, ...m }) => m) });
      case '/studio-library/motion': {
        const entry = motions.entries.find(m => m.id === input.id); if (!entry) return json(res, 404, { error: 'Not found.' });
        const data = await fsp.readFile(entry.file);
        if (entry.contentHash && !verified.has(entry.id)) { if (crypto.createHash('sha256').update(data).digest('hex') !== entry.contentHash) return json(res, 409, { error: 'Motion file changed since the catalog was made.' }); verified.add(entry.id); }
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': data.length, 'Cache-Control': 'no-store' }); res.end(data); return;
      }
      default: return json(res, 404, { error: 'Unknown library endpoint.' });
    }
  }

  /** Handle /studio-bridge/* and /studio-library/*; false for any other path. */
  async function handle(req, res, pathname) {
    const isBridge = pathname.startsWith('/studio-bridge/'), isLibrary = pathname.startsWith('/studio-library/');
    if (!isBridge && !isLibrary) return false;
    if (!available()) { json(res, 503, { error: 'GenVR is unavailable in this build.' }); return true; }
    await ensure();
    if (isBridge) return bridge.handle(req, res);
    if (!allowedRequest(req)) { json(res, 401, { error: 'Studio authentication required.' }); return true; }
    if (!libraryRoot && !pathname.match(/^\/studio-library\/(list|get|put|remove|assignment|assign)$/)) { json(res, 404, { error: 'No private library is configured.' }); return true; }
    try { await library(req, res, pathname); } catch (e) { if (!res.headersSent) json(res, e?.status ?? 400, { error: e instanceof Error ? e.message.slice(0, 300) : 'Library request failed.' }); }
    return true;
  }

  /** Token for the Studio frame shell (served only on loopback by the application server). */
  async function token() { if (!available()) return null; await ensure(); return bridge.token; }
  function status() { return { library: !!libraryRoot, motions: motions.entries.length, motionProblems: motions.problems, connectionFile: origin ? connectionFile : null }; }
  async function close() { if (!ready) return; await ready.catch(() => {}); voice?.close?.(); bridge?.close?.(); }
  return { handle, listening, token, status, close };
}
module.exports = { createStudioHost, motionCatalog };
