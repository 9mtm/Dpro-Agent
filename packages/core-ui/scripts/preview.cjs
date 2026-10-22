const http = require('node:http');
const { root, readCurrent } = require('./build-artifacts.cjs');
const HOST = '127.0.0.1';
const PORT = 42522;
// style-src-elem: the terminal screen (xterm) measures characters with its own <style> blocks.
// style= attributes and scripts stay same-origin only.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});
const routes = new Set(['/chat', '/agents', '/memory', '/tasks', '/settings', '/channels']);
function requestPath(target) {
  const raw = target.split('?')[0];
  if (!raw.startsWith('/') || raw.startsWith('//') || /%2f|%5c/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (/[\\%\u0000-\u0020\u007f#]/u.test(decoded) || decoded.includes('//')) return null;
  if (decoded.split('/').some(part => part === '.' || part === '..')) return null;
  return decoded;
}
function createPreviewServer(packageRoot = root) {
  // No default server startup on import. Tests supply fictional assets and port 0.
  return http.createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, (req, res) => {
    for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const expectedHost = `${HOST}:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost) return send(421, 'Misdirected request');
    if ((req.headers.origin && req.headers.origin !== `http://${expectedHost}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return send(405, 'Method not allowed'); }
    const pathname = requestPath(req.url || '');
    if (pathname === null) return send(400, 'Invalid path');
    let name = pathname.slice(1);
    if (pathname === '/') name = 'index.html';
    else if (routes.has(pathname) && /(?:^|,)\s*text\/html(?:\s*;[^,]*)?(?:,|$)/i.test(req.headers.accept || '')) name = 'index.html';
    try {
      // Revalidate the pointer and bytes for every response, including after rebuilds.
      const current = readCurrent(packageRoot);
      const body = current.files.get(name);
      if (!body) return send(404, 'Not found');
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.gif') ? 'image/gif' : 'text/plain; charset=utf-8';
      return send(200, body, type);
    } catch { return send(503, 'Current build unavailable'); }
  });
}
async function startPreview({ packageRoot = root, port = PORT } = {}) {
  readCurrent(packageRoot);
  const server = createPreviewServer(packageRoot);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
if (require.main === module) {
  if (process.argv.length !== 2) { console.error('Preview accepts no host, port or root overrides.'); process.exitCode = 1; }
  else startPreview().then(server => {
    console.log(`Fixture preview: http://${HOST}:${PORT}\nOnly the verified current build is served.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  }).catch(error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is occupied; no fallback or process termination attempted.` : 'Preview unavailable; build successfully first.');
    process.exitCode = 1;
  });
}
module.exports = { createPreviewServer, startPreview, requestPath, HEADERS, CSP, HOST, PORT };
