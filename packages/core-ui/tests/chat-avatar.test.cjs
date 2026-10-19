require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { ChatAvatar, speakable } = require('../src/ChatAvatar.tsx');
const { createGenVRAssets } = require('../scripts/genvr-assets.cjs');

test('speech text drops code, links and Markdown marks and stays short', () => {
  assert.equal(speakable('**Done.** See [the plan](https://x.example/p) and `notes.md`.\n```js\nsecret()\n```\n- next step'), 'Done. See the plan and notes.md. next step');
  assert.ok(speakable('a'.repeat(2000)).length <= 600);
});

test('the chat avatar is an isolated same-origin frame with its own channel', () => {
  const html = renderToStaticMarkup(React.createElement(ChatAvatar, { turns: [], agentId: 'agent-1', agentName: 'Main agent', onClose: () => {} }));
  assert.match(html, /<iframe[^>]+src="\/genvr\/avatar\.html#[0-9a-f-]{36}"/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin"/);
  assert.match(html, /Main agent · Loading the avatar/);
});

test('the avatar shell is served with the bridge token, and its host script exists', () => {
  const serve = createGenVRAssets(path.resolve(__dirname, '..'), () => 'a'.repeat(64));
  const out = {}; const res = { writeHead: (status, headers) => { out.status = status; out.headers = headers; }, end: data => { out.body = data ? data.toString() : ''; } };
  assert.equal(serve({ method: 'GET' }, res, '/genvr/avatar.html'), true);
  if (out.status === 200) {
    assert.match(out.body, /name="genvr-studio-token" content="a{64}"/);
    assert.match(out.body, /<div id="avatar"/);
    assert.match(out.body, /\/genvr\/avatar-host\.js/);
    assert.equal(serve({ method: 'GET' }, res, '/genvr/avatar-host.js'), true);
    assert.equal(out.status, 200); assert.match(out.body, /mountAvatarLive/);
  } else assert.equal(out.status, 503); // no vendor SDK in this checkout
});
