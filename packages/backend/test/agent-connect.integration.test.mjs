import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { registerChannelRoutes, stopChannel, channelRuntimeState } from '../extensions/shared/channel-host.js';
const requireBackend = createRequire(new URL('../package.json', import.meta.url));
const Fastify = requireBackend('fastify');
const Database = requireBackend('better-sqlite3');

async function fixture(id, config = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE extension_configs (extension_id TEXT PRIMARY KEY, enabled INTEGER)');
  db.prepare('INSERT INTO extension_configs VALUES (?, 1)').run(id);
  let saved = { bot_token: 'private-token', allowed_users: 'sender', allowed_channels: 'room', ...config };
  const received = []; const sends = []; let incoming;
  let failSend = false;
  const connector = {
    state: 'disconnected',
    async connect() { this.state = 'connected'; }, async disconnect() { this.state = 'disconnected'; },
    async send(conversationId, text) {
      if (failSend) throw new Error('private-token');
      sends.push({ conversationId, text }); return { id: `sent-${sends.length}`, conversationId };
    },
  };
  const api = { db, getConfig: () => saved, setConfig: value => { saved = value; }, log: () => {},
    authorizeChannelRequest: request => { if (request.headers.authorization !== 'Bearer admin') throw new Error('unauthorized'); return 'owner'; },
    processChannelMessage: async (...args) => { received.push(args); return 'agent response'; },
  };
  const app = Fastify();
  await app.register(async scope => registerChannelRoutes(scope, api, id, {
    createConnector: (_id, _transport, hooks) => { incoming = hooks.receive; return connector; },
  }), { prefix: `/api/ext/${id}` });
  await app.ready();
  const request = (url, method = 'GET', payload, authorized = true) => app.inject({
    url: `/api/ext/${id}/${url}`, method, ...(payload ? { payload } : {}),
    headers: authorized ? { authorization: 'Bearer admin' } : {},
  });
  await request('connect', 'POST');
  return { db, app, request, received, sends, incoming: message => incoming(message),
    saved: () => saved, fail: () => { failSend = true; }, close: async () => { await app.close(); db.close(); } };
}
const message = (channel, overrides = {}) => ({ channel, id: 'message-1', conversationId: 'room',
  senderId: 'sender', senderName: 'Sender', text: 'hello', timestamp: new Date().toISOString(), guildId: 'guild', ...overrides });

for (const id of ['telegram', 'discord']) {
  test(`${id}: authenticated settings, redacted token, provider acknowledgement and failure`, async () => {
    const f = await fixture(id);
    try {
      assert.equal((await f.request('config', 'GET', undefined, false)).statusCode, 403);
      const config = (await f.request('config')).json();
      assert.equal(config.hasToken, true); assert.equal(config.config.bot_token, undefined);
      const payload = id === 'telegram' ? { chatId: 'room', text: 'hi' } : { channelId: 'room', content: 'hi' };
      assert.equal((await f.request('send', 'POST', payload)).json().messageId, 'sent-1');
      f.fail();
      const failure = await f.request('send', 'POST', payload);
      assert.equal(failure.statusCode, 502); assert.ok(!failure.body.includes('private-token'));
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM channel_events WHERE direction = 'outgoing'").get().n, 1);
      assert.equal((await f.request('webhook', 'POST', {})).statusCode, 410);
      assert.equal((await f.request('config', 'PUT', { config: { bot_token: '', allowed_users: 'sender' } })).statusCode, 200);
      assert.equal(f.saved().bot_token, 'private-token');
    } finally { await f.close(); }
  });
  test(`${id}: allowlists, persistent deduplication and isolated agent context`, async () => {
    const f = await fixture(id, { owner_user_id: 'owner', auto_reply: true });
    try {
      await f.incoming(message(id, { senderId: 'stranger' })); assert.equal(f.received.length, 0);
      if (id === 'discord') {
        await f.incoming(message(id, { conversationId: 'other' })); assert.equal(f.received.length, 0);
      }
      await Promise.all([f.incoming(message(id)), f.incoming(message(id))]);
      assert.equal(f.received.length, 1); assert.equal(f.sends.length, 1);
      assert.equal(f.received[0][0], 'owner'); assert.equal(f.received[0][1], `${id}:room:sender`);
      await f.request('connect', 'POST');
      await f.incoming(message(id));
      assert.equal(f.received.length, 1, 'reconnecting does not erase the durable duplicate claim');
      f.db.prepare('UPDATE extension_configs SET enabled = 0').run();
      await f.incoming(message(id, { id: 'message-2' })); assert.equal(f.received.length, 1);
      assert.equal((await f.request('send', 'POST', id === 'telegram' ? { chatId: 'room', text: 'hi' } : { channelId: 'room', content: 'hi' })).statusCode, 502);
      await stopChannel(id); assert.equal((await f.request('status')).json().connected, false);
    } finally { await f.close(); }
  });
}
test('automatic replies are off by default; invalid configuration is rejected', async () => {
  const f = await fixture('telegram');
  try {
    await f.incoming(message('telegram'));
    assert.equal(f.received.length, 0); assert.equal(f.sends.length, 0);
    assert.equal((await f.request('config', 'PUT', { config: { auto_reply: 'true' } })).statusCode, 400);
    assert.equal((await f.request('config', 'PUT', { config: { allowed_users: [{}] } })).statusCode, 400);
  } finally { await f.close(); }
});
test('conversation history excludes other external senders', async () => {
  const f = await fixture('telegram', { owner_user_id: 'owner', auto_reply: true, allowed_users: 'sender,second' });
  try {
    await f.incoming(message('telegram'));
    await f.incoming(message('telegram', { id: '2', senderId: 'second' }));
    assert.deepEqual(f.received[1][3], []);
    await f.incoming(message('telegram', { id: '3' }));
    assert.equal(f.received[2][3].length, 2);
  } finally { await f.close(); }
});

test('shared extension runs two channels concurrently and disables only the chosen channel', async () => {
 const db = new Database(':memory:');
 db.exec("CREATE TABLE extension_configs (extension_id TEXT PRIMARY KEY, enabled INTEGER); INSERT INTO extension_configs VALUES ('agent-connect',1)");
 const configs={ntfy:{configured:true,enabled:true},slack:{configured:true,enabled:true}};
 const connectors={};const app=Fastify();
 for(const id of ['ntfy','slack'])await app.register(async scope=>registerChannelRoutes(scope,{
  db,getConfig:()=>configs[id],authorizeChannelRequest:()=> 'owner',log:()=>{},
 },id,{extensionId:'agent-connect',isConfigured:c=>c.configured,createTransport:()=>({}),createConnector:()=>{
  const connector={state:'disconnected',connect:async()=>{connector.state='connected'},disconnect:async()=>{connector.state='disconnected'}};
  connectors[id]=connector;return connector;
 }}),{prefix:'/'+id});
 try {
  await app.ready();
  for(const id of ['ntfy','slack'])assert.equal((await app.inject({url:'/'+id+'/connect',method:'POST'})).statusCode,200);
  assert.equal(channelRuntimeState('ntfy'),'connected');assert.equal(channelRuntimeState('slack'),'connected');
  configs.ntfy.enabled=false;
  assert.equal(channelRuntimeState('ntfy'),'disabled');assert.equal(channelRuntimeState('slack'),'connected');
  assert.equal((await app.inject({url:'/ntfy/connect',method:'POST'})).statusCode,409);
  assert.equal((await app.inject({url:'/slack/status'})).json().connected,true);
 } finally {await app.close();db.close();}
});
