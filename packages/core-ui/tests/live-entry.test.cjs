require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { App } = require('../src/App.tsx');
const { createEntryClient } = require('../src/entry-client.ts');
const { parseBuildArgs } = require('../scripts/build.cjs');
const { beginBuild, completeBuild, readCurrent, packageCurrent } = require('../scripts/build-artifacts.cjs');
const origin = 'http://127.0.0.1:42522';
function browser(handler = () => { throw Error('fictional unavailable'); }) {
  const calls = [];
  const instance = { location: { origin }, fetch(url, init) { assert.equal(this, instance); calls.push([url, init]); return handler(url, init); } };
  return { instance, calls };
}
function entry(instance, enabled) {
  let rendered;
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = { exports: {}, window: instance, document: { getElementById: () => ({}) }, require(name) {
    if (name === './styles.css') return {};
    if (name === 'react-dom/client') return { createRoot: () => ({ render: value => { rendered = value; } }) };
    if (name === './entry-client') return { createEntryClient };
    if (name === './App') return { App };
    return require(name);
  } };
  if (enabled !== undefined) context.__LIVE_ENTRY_CANDIDATE__ = enabled;
  vm.runInNewContext(source, context);
  return rendered.props.children.props.client;
}
test('default entry and absent compile constant ignore browser selectors and remain offline', () => {
  for (const flag of [false, undefined]) {
    const instance = { get location() { throw Error('must not read runtime selector'); }, get fetch() { throw Error('must not access fetch'); } };
    const client = entry(instance, flag);
    assert.equal(client, undefined);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(App, { client })), /Use live sign-in/);
  }
});
test('compiled opt-in injects live only and shows no fictional workspace; nothing is sent while rendering', () => {
  const b = browser(); const client = entry(b.instance, true);
  assert.equal(client.getSnapshot().mode, 'fixture');
  assert.equal(client.canUse('mock'), false);
  // Owner decision 2026-10-15: real data only; the page opens the real sign-in (on mount) instead of a fixture.
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(App, { client })), /Use live sign-in|Fixture workspace|Nothing here yet/);
  client.selectMode('live');
  assert.match(renderToStaticMarkup(React.createElement(App, { client })), /Welcome to Dpro/);
  assert.equal(b.calls.length, 0);
});
for (const value of ['http://localhost:42522', 'http://[::1]:42522', 'http://127.0.0.2:42522', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:042522', 'http://127.0.0.1:65536', 'https://127.0.0.1:42522', 'null', 'https://example.invalid', origin + '/', origin + '?live=true']) test(`wrong origin fails before mounting: ${value}`, () => {
  const b = browser(); b.instance.location.origin = value;
  assert.throws(() => entry(b.instance, true), /loopback application origin/);
  assert.equal(b.calls.length, 0);
});
test('desktop app: a random 127.0.0.1 port is the page origin and every request stays on it', async () => {
  const appOrigin = 'http://127.0.0.1:50550';
  const b = browser(() => Promise.resolve(new Response(JSON.stringify({ setupComplete: true, setupRequired: false, message: 'Setup already completed' }), { headers: { 'Content-Type': 'application/json' } })));
  b.instance.location.origin = appOrigin;
  const client = entry(b.instance, true); client.selectMode('live');
  await client.discoverSetup();
  assert.deepEqual(b.calls.map(c => c[0]), [appOrigin + '/api/setup/status']);
  assert.equal(b.calls[0][1].mode, 'same-origin');
});
test('explicit setup and login use bound fetch; no retry or fallback after live error', async () => {
  const b = browser(url => url.endsWith('/setup/status') ? Promise.resolve(new Response(JSON.stringify({ setupComplete: true, setupRequired: false, message: 'Setup already completed' }), { headers: { 'Content-Type': 'application/json' } })) : Promise.reject(Error('fictional failure')));
  const client = entry(b.instance, true); client.selectMode('live');
  await client.discoverSetup();
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0][0], origin + '/api/setup/status');
  assert.equal(b.calls[0][1].credentials, 'omit');
  assert.equal(b.calls[0][1].mode, 'same-origin');
  assert.equal(client.getSnapshot().setup, 'login');
  await client.login('fixture@example.invalid', 'fictional-password');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.length, 2);
  assert.equal(client.getSnapshot().mode, 'live');
  assert.equal(client.getSnapshot().phase, 'signed-out');
  assert.equal(client.getSnapshot().notice, 'unavailable');
  client.selectMode('mock'); assert.equal(client.getSnapshot().mode, 'live');
});
test('setup network error remains live/unavailable without retry or fallback', async () => {
  const b = browser(); const client = entry(b.instance, true); client.selectMode('live');
  await client.discoverSetup(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.length, 1); assert.equal(client.getSnapshot().setup, 'unavailable');
  assert.equal(client.getSnapshot().mode, 'live');
});
test('build selection is explicit and defaults fictional', () => {
  assert.deepEqual(parseBuildArgs([]), { channel: 'current', entryMode: 'fictional' });
  assert.deepEqual(parseBuildArgs(['--candidate']), { channel: 'candidate', entryMode: 'fictional' });
  assert.deepEqual(parseBuildArgs(['--live-entry', '--candidate']), { channel: 'candidate', entryMode: 'live-candidate' });
});
for (const args of [['--live-entry'], ['--current', '--live-entry'], ['--candidate', '--candidate'], ['--candidate', '--live-entry', '--live-entry'], ['--candidate', '--origin=' + origin], ['--candidate', '--live-entry=true'], ['--candidate', '--promote'], ['--mode=live']]) test(`reject build args ${args}`, () => assert.throws(() => parseBuildArgs(args)));
function artifact(root, mode, channel = 'candidate') {
  const pending = beginBuild(root, channel, mode);
  fs.mkdirSync(path.join(pending.output, 'assets'));
  fs.writeFileSync(path.join(pending.output, 'index.html'), `<meta name="core-ui-entry" content="${mode}">`);
  fs.writeFileSync(path.join(pending.output, 'THIRD_PARTY_NOTICES.txt'), 'fictional');
  fs.writeFileSync(path.join(pending.output, 'assets/a.js'), 'void 0;');
  fs.writeFileSync(path.join(pending.output, 'assets/a.css'), 'body{}');
  return completeBuild(root, pending.buildId, channel);
}
test('candidate provenance prevents current creation, copied promotion and stripped metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ui-entry-'));
  const old = artifact(root, 'fictional', 'current');
  const before = fs.readFileSync(path.join(root, 'dist/current.json'));
  assert.throws(() => beginBuild(root, 'current', 'live-candidate'), /candidate only/);
  assert.throws(() => beginBuild(root, 'candidate', 'unknown'), /provenance/);
  const live = artifact(root, 'live-candidate');
  assert.equal(readCurrent(root, 'candidate').manifest.entryMode, 'live-candidate');
  assert.deepEqual(fs.readFileSync(path.join(root, 'dist/current.json')), before);
  assert.equal(readCurrent(root).manifest.buildId, old.buildId);
  for (const entryMode of ['live-candidate', undefined, 'fictional']) {
    fs.writeFileSync(path.join(root, 'dist/current.json'), JSON.stringify({ ...live, entryMode }));
    assert.throws(() => readCurrent(root)); assert.throws(() => packageCurrent(root));
  }
});
test('build disables Vite env loading and injects only the parsed compile constant', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build.cjs'), 'utf8');
  assert.match(source, /configFile: false/); assert.match(source, /envDir: false/);
  assert.match(source, /__LIVE_ENTRY_CANDIDATE__: JSON.stringify\(entryMode === 'live-candidate'\)/);
  assert.doesNotMatch(source, /process\.env|loadEnv/);
});

test('packaged logo GIF stays integrity-checked and serves only from the manifest',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'core-ui-logo-'));
 const pending=beginBuild(root,'candidate','fictional');fs.mkdirSync(path.join(pending.output,'assets'));
 for(const [name,data] of [['index.html','<meta name="core-ui-entry" content="fictional">'],['THIRD_PARTY_NOTICES.txt','fixture'],['assets/a.js','void 0;'],['assets/a.css','body{}'],['assets/dpro-startup-verified.gif','GIF89a']])fs.writeFileSync(path.join(pending.output,name),data);
 completeBuild(root,pending.buildId,'candidate');assert.equal(readCurrent(root,'candidate').files.get('assets/dpro-startup-verified.gif').toString(),'GIF89a');
 fs.writeFileSync(path.join(pending.output,'assets/dpro-startup-verified.gif'),'changed');assert.throws(()=>readCurrent(root,'candidate'),/integrity mismatch/);
});
