import { createHash } from 'node:crypto';
import { ChannelConnector, TelegramTransport, DiscordTransport, channelInfo } from 'agent-connect-dpro';

const runtimes = new Map();
export function channelRuntimeState(id) { return runtimes.get(id)?.status() ?? 'restart_required'; }
export function refreshChannel(id) { void runtimes.get(id)?.refresh().catch(() => {}); }
export async function stopChannel(id) { await runtimes.get(id)?.stop(); }
export async function sendChannel(id, destination, text) {
  const runtime = runtimes.get(id);
  if (!runtime) throw new Error('Channel is unavailable');
  return runtime.send(destination, text);
}

/** Agent Player integration boundary: storage, identity and agent execution stay here. */
export async function registerChannelRoutes(fastify, api, id, options = {}) {
  const db = api.db;
  db.exec(`CREATE TABLE IF NOT EXISTS channel_events (
    channel TEXT NOT NULL, conversation_id TEXT NOT NULL, id TEXT NOT NULL,
    sender_id TEXT NOT NULL, sender_name TEXT, content TEXT NOT NULL,
    timestamp TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY (channel, conversation_id, id, direction)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS channel_events_recent ON channel_events (channel, timestamp DESC)');
  let connector;
  let fingerprint = '';
  let stopped = false;
  let timer;
  let transition = Promise.resolve();
  const queues = new Map();
  const read = () => api.getConfig() || {};
  const enabled = () => db.prepare('SELECT enabled FROM extension_configs WHERE extension_id = ?').get(options.extensionId || id)?.enabled === 1;
  const configured = config => options.isConfigured ? options.isConfigured(config) : Boolean(config.bot_token);
  const values = value => Array.isArray(value) ? value.map(String) : String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  const active = () => !stopped && enabled() && read().enabled !== false;
  const insert = (message, direction, state) => db.prepare(`INSERT OR IGNORE INTO channel_events
    (channel, conversation_id, id, sender_id, sender_name, content, timestamp, direction, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, message.conversationId, message.id,
      message.senderId, message.senderName || '', message.text, message.timestamp, direction, state).changes > 0;

  async function send(destination, text, senderId = 'bot') {
    if (!active() || !connector) throw new Error('Channel is disabled or unconfigured');
    const delivery = await connector.send(destination, text);
    insert({ ...delivery, senderId, senderName: 'Agent Player', text, timestamp: new Date().toISOString() }, 'outgoing', delivery.acknowledgement === 'adapter' ? 'accepted' : 'delivered');
    return delivery;
  }
  function allowed(message, config) {
    const senders = values(config.allowed_users);
    if (!senders.includes(message.senderId)) return false;
    if (id === 'discord' && (!values(config.allowed_channels).includes(message.conversationId)
      || (config.guild_id && config.guild_id !== message.guildId))) return false;
    if (options.requireChannels && !values(config.allowed_channels).includes(message.conversationId)) return false;
    return true;
  }
  async function receive(message) {
    const config = read();
    if (!active() || !allowed(message, config)) return;
    if (!insert(message, 'incoming', 'pending')) return;
    const key = `${message.conversationId}:${message.senderId}`;
    const previous = queues.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      try {
        if (!active() || !allowed(message, read()) || JSON.stringify(config) !== JSON.stringify(read())) throw new Error('Channel access revoked');
        if (config.auto_reply === true) {
          if (!config.owner_user_id) throw new Error('Channel owner is not configured');
          const history = db.prepare(`SELECT content, direction FROM channel_events
            WHERE channel = ? AND conversation_id = ? AND state IN ('processed', 'delivered', 'accepted')
            AND sender_id = ? ORDER BY timestamp DESC LIMIT 20`)
            .all(id, message.conversationId, message.senderId).reverse()
            .map(row => ({ role: row.direction === 'incoming' ? 'user' : 'assistant', content: row.content }));
          // The turn runs with the restricted channel tool set; send tools may only
          // answer this conversation or a configured allowed channel.
          const response = await api.processChannelMessage(config.owner_user_id,
            `${id}:${message.conversationId}:${message.senderId}`, message.text, history,
            { channel: id, conversationId: message.conversationId, allowedDestinations: values(config.allowed_channels) });
          if (!active() || !allowed(message, read()) || JSON.stringify(config) !== JSON.stringify(read())) throw new Error('Channel access revoked');
          // Split plain text at provider limits; outbound mentions are disabled by the Discord transport.
          const size = Math.max(1, channelInfo(id).maxTextLength - 100);
          for (let offset = 0; offset < response.length; offset += size) await send(message.conversationId, response.slice(offset, offset + size), message.senderId);
        }
        db.prepare(`UPDATE channel_events SET state = 'processed' WHERE channel = ? AND conversation_id = ? AND id = ? AND direction = 'incoming'`)
          .run(id, message.conversationId, message.id);
      } catch {
        db.prepare(`UPDATE channel_events SET state = 'failed' WHERE channel = ? AND conversation_id = ? AND id = ? AND direction = 'incoming'`)
          .run(id, message.conversationId, message.id);
        api.log('warn', `${id} inbound processing failed; inspect channel event state`);
      }
    });
    queues.set(key, work);
    await work;
    if (queues.get(key) === work) queues.delete(key);
  }

  function refresh() {
    transition = transition.catch(() => {}).then(async () => {
      if (stopped) return;
      const config = read();
      const next = createHash('sha256').update(JSON.stringify({ config, enabled: enabled() })).digest('hex');
      if (next === fingerprint) return;
      await connector?.disconnect();
      connector = undefined;
      fingerprint = next;
      if (!active() || !configured(config)) return;
      const createConnector = options.createConnector || ((channelId, transport, hooks) => new ChannelConnector(channelId, transport, hooks));
      const transport = options.createTransport ? options.createTransport(id, config) : id === 'telegram'
        ? new TelegramTransport(config.bot_token) : new DiscordTransport(config.bot_token);
      connector = createConnector(id, transport, {
        receive, onError: operation => api.log('warn', `${id} ${operation} failed`),
      });
      await connector.connect();
    });
    return transition;
  }
  async function stop() {
    stopped = true;
    clearInterval(timer);
    await transition.catch(() => {});
    await connector?.disconnect();
    await Promise.allSettled(queues.values());
  }
  runtimes.set(id, { stop, send, refresh, status: () => stopped ? 'restart_required' : !active() ? 'disabled' : connector?.state || 'disconnected' });
  fastify.addHook('onReady', async () => {
    // Defer network startup so a bad provider credential does not prevent HTTP startup.
    timer = setInterval(() => { void refresh().catch(() => {}); }, 5000);
    timer.unref();
    void refresh().catch(() => {});
  });
  fastify.addHook('onClose', stop);
  fastify.addHook('preHandler', async (request, reply) => {
    try { api.authorizeChannelRequest(request); }
    catch { return reply.code(403).send({ error: 'Channel administration requires an active owner or admin account' }); }
  });
  fastify.get('/status', async () => {
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(direction = 'incoming') AS incoming,
      SUM(direction = 'outgoing') AS outgoing, SUM(state = 'failed') AS failed FROM channel_events WHERE channel = ?`).get(id);
    return { configured: configured(read()), connected: active() && connector?.state === 'connected',
      state: connector?.state || 'disconnected', enabled: active(),
      stats: { total: stats.total || 0, totalMessages: stats.total || 0, incoming: stats.incoming || 0, outgoing: stats.outgoing || 0, failed: stats.failed || 0 } };
  });
  fastify.get('/config', async () => {
    if (options.redactConfig) return options.redactConfig(read());
    const { bot_token, ...config } = read();
    return { config, hasToken: Boolean(bot_token) };
  });
  fastify.put('/config', async (request, reply) => {
    const input = request.body?.config || request.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return reply.code(400).send({ error: 'Invalid channel configuration' });
    const current = read();
    const config = { ...current };
    for (const key of options.configKeys || ['bot_token', 'allowed_users', 'allowed_channels', 'guild_id', 'client_id', 'auto_reply']) {
      if (input[key] !== undefined && !(key === 'bot_token' && input[key] === '')) config[key] = input[key];
    }
    if ((options.validateConfig ? !options.validateConfig(config) : typeof config.bot_token !== 'string' || !config.bot_token.trim())
      || (config.auto_reply !== undefined && typeof config.auto_reply !== 'boolean')
      || ['guild_id', 'client_id'].some(key => config[key] !== undefined && typeof config[key] !== 'string')
      || ['allowed_users', 'allowed_channels'].some(key => config[key] !== undefined && typeof config[key] !== 'string' && !Array.isArray(config[key]))
      || ['allowed_users', 'allowed_channels'].some(key => Array.isArray(config[key]) && config[key].some(value => typeof value !== 'string'))) {
      return reply.code(400).send({ error: 'A bot token and valid access lists are required' });
    }
    config.owner_user_id = api.authorizeChannelRequest(request);
    api.setConfig(config);
    // Configuration is persisted even if the provider is temporarily unavailable.
    void refresh().catch(() => {});
    return { success: true, message: 'Settings saved. Connection will update in the background.' };
  });
  fastify.post('/connect', async (_request, reply) => {
    if (!active() || !configured(read())) return reply.code(409).send({ error: 'Enable and configure the extension first' });
    fingerprint = '';
    try { await refresh(); return { success: connector?.state === 'connected' }; }
    catch { return reply.code(502).send({ error: 'Provider connection failed. Check credentials and provider settings.' }); }
  });
  fastify.post('/send', async (request, reply) => {
    const destination = id === 'telegram' ? request.body?.chatId : request.body?.channelId;
    const text = id === 'telegram' ? request.body?.text : request.body?.content;
    if (typeof destination !== 'string' || typeof text !== 'string' || !text.trim()
      || text.length > channelInfo(id).maxTextLength) return reply.code(400).send({ error: 'Invalid destination or message length' });
    try { const delivery = await send(destination, text); return { success: true, messageId: delivery.id }; }
    catch { return reply.code(502).send({ error: 'Message was not delivered. Check the channel connection.' }); }
  });
  fastify.get('/messages', async request => {
    const limit = Math.max(1, Math.min(100, Number(request.query?.limit) || 20));
    const rows = db.prepare('SELECT * FROM channel_events WHERE channel = ? ORDER BY timestamp DESC LIMIT ?').all(id, Math.floor(limit));
    return { messages: rows.map(row => ({ ...row, chat_id: row.conversation_id, channel_id: row.conversation_id,
      text: row.content, from_username: row.sender_name, author_username: row.sender_name })) };
  });
  // Provider-authenticated polling/Gateway replaces unauthenticated legacy webhook ingestion.
  fastify.post('/webhook', async (_request, reply) => reply.code(410).send({ error: 'This channel uses a persistent provider connection' }));
}
