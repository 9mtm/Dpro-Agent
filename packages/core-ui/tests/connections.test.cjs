require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedConnections, connectionsResponse, connectionsRoute } = require('../src/connections-contract.js');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { ConnectionsSettings } = require('../src/ConnectionsSettings.tsx');
const content = { violence: false, blood: false, horror: false, romance: false, userChat: false, paidItems: false };

test('connections contract: exact bodies, same rule in the browser and the bridge', () => {
  for (const allow of [allowedConnections, allowedRequest, allowed]) {
    assert.equal(allow('GET', '/api/connections'), true);
    assert.equal(allow('GET', '/api/connections?x=1'), false);
    assert.equal(allow('POST', '/api/connections/genvr/link', {}), true);
    assert.equal(allow('POST', '/api/connections/genvr/link', { scopes: ['items:submit'] }), false);
    assert.equal(allow('POST', '/api/connections/genvr/link', { accessToken: 'x' }), false);
    assert.equal(allow('POST', '/api/connections/genvr/disconnect', {}), false);
    assert.equal(allow('POST', '/api/connections/genvr/disconnect', { confirm: true }), true);
    assert.equal(allow('POST', '/api/connections/genvr/test-world/upload', { confirm: true }), true);
    assert.equal(allow('POST', '/api/connections/genvr/test-world/upload', { confirm: true, projectId: 'other' }), false);
    assert.equal(allow('POST', '/api/connections/genvr/test-world/publish', { confirm: true, title: 'World', type: 'social', access: 'public', content }), true);
    assert.equal(allow('POST', '/api/connections/genvr/test-world/publish', { title: 'World', type: 'social', access: 'public', content }), false);
    assert.equal(allow('POST', '/api/connections/genvr/test-world/publish', { confirm: true, title: 'World', type: 'social', access: 'password', content }), false);
    assert.equal(allow('DELETE', '/api/connections'), false);
  }
  assert.equal(connectionsRoute('/api/connections/other/link'), false);
});

test('responses keep only reviewed fields; a token never reaches the page', () => {
  const body = { connections: [{ id: 'genvr', name: 'Genvr', status: 'connecting', account: null, scopes: [], linkedAt: null, expiresAt: null, accessToken: 'secret', pending: { userCode: 'ABCD-EFGH', verificationUri: 'https://genvr.net/link', expiresAt: '2026-10-19T10:10:00Z', deviceCode: 'secret' }, error: null }] };
  const safe = connectionsResponse('/api/connections', 200, body);
  assert.ok(!JSON.stringify(safe).includes('secret'));
  assert.equal(safe.connections[0].pending.userCode, 'ABCD-EFGH');
  assert.throws(() => connectionsResponse('/api/connections', 200, { connections: [{ ...body.connections[0], pending: { ...body.connections[0].pending, verificationUri: 'javascript:alert(1)' } }] }));
  assert.deepEqual(connectionsResponse('/api/connections/genvr/link', 503, { code: 'unavailable', detail: 'x' }), { code: 'unavailable' });
  assert.equal(connectionsResponse('/api/connections/genvr/link', 500, { code: 'stack trace' }), null);
  const pub = connectionsResponse('/api/connections/genvr/test-world/publish', 200, { publication: { localId: 'dpro.publication.test', serverId: 'exp-1', title: 'T', status: 'published', version: 1, access: 'public', link: 'https://genvr.net/places/exp-1', updatedAt: '2026-10-19T10:00:00Z', ownerId: 'x' } });
  assert.equal(pub.publication.link, 'https://genvr.net/places/exp-1'); assert.equal(pub.publication.ownerId, undefined);
});

test('the Connections page is for the owner; others see no controls', () => {
  const fake = role => ({ subscribe: () => () => {}, getSnapshot: () => ({ user: { role } }), request: async () => { throw Error('no request during render'); } });
  assert.match(renderToStaticMarkup(React.createElement(ConnectionsSettings, { client: fake('owner') })), /Loading connections/);
  const other = renderToStaticMarkup(React.createElement(ConnectionsSettings, { client: fake('user') }));
  assert.match(other, /Only the owner/); assert.doesNotMatch(other, /Connect Genvr/);
});
