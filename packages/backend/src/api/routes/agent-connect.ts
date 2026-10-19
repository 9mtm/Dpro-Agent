/** Owner configuration of the shared channel catalog; saving never starts a provider. */
import type { FastifyInstance } from 'fastify';
import { CHANNEL_CATALOG } from 'agent-connect-dpro';
import { actorOf } from '../../auth/auth-gate.js';
import { requireOwner, ScopeError } from '../../repositories/scope.js';
import { q, sql, one, run, type Step } from '../../repositories/sql-steps.js';
import { isValidEnvironment, isValidSettings } from '../../../extensions/agent-connect/policy.js';

import { channelRuntimeState, refreshChannel } from '../../../extensions/shared/channel-host.js';

const catalog = new Map(CHANNEL_CATALOG.map(c => [c.id as string, c]));
const native = (id: string) => id === 'telegram' || id === 'discord';
const extensionId = (id: string) => native(id) ? id : 'agent-connect';
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const accessList = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 200 && !/[\r\n\0]/.test(x));
function visible(id: string, root: Record<string, any>, enabled: boolean) {
  const c = native(id) ? root : root.channels?.[id] ?? {};
  const active = enabled && c.enabled !== false;
  const runtime = channelRuntimeState(id);
  const state = !active ? 'disabled' : ['connected','connecting','reconnecting','error','disconnected','restart_required'].includes(runtime) ? runtime : 'disconnected';
  return { id, enabled: active, state, configured: native(id) ? !!c.bot_token : c.configured === true,
    allowedUsers: Array.isArray(c.allowed_users) ? c.allowed_users : typeof c.allowed_users === 'string' ? c.allowed_users.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    allowedChannels: Array.isArray(c.allowed_channels) ? c.allowed_channels : typeof c.allowed_channels === 'string' ? c.allowed_channels.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    hasSecrets: !!c.bot_token || !!Object.keys(c.environment ?? {}).length || !!Object.keys(c.settings ?? {}).length };
}
export async function agentConnectRoutes(app: FastifyInstance) {
  const config = { access: 'owner' as const };
  const deny = (reply: any, error: unknown) => reply.code(error instanceof ScopeError ? error.status : error instanceof TypeError ? 400 : 500).send({ code: error instanceof ScopeError ? error.code : error instanceof TypeError ? 'invalid_input' : 'unavailable' });
  app.get('/api/agent-connect/catalog', { config }, async (request, reply) => {
    try {
      requireOwner(actorOf(request));
      const rows = await q.all<{ extension_id: string; enabled: number; config_json: string }>("SELECT extension_id, enabled, config_json FROM extension_configs WHERE extension_id IN ('agent-connect', 'telegram', 'discord')");
      const byId = new Map(rows.map(r => [r.extension_id, r]));
      return { channels: CHANNEL_CATALOG.map(c => { const row = byId.get(extensionId(c.id)); return {
        label: c.label, runtime: native(c.id) ? 'node' : 'python', requiredEnv: [...c.requiredEnv], prerequisites: c.prerequisites,
        ...visible(c.id, row ? JSON.parse(row.config_json) : {}, row?.enabled === 1),
      }; }), configurable: q.dialect === 'sqlite' };
    } catch (error) { return deny(reply, error); }
  });
  app.put<{ Params: { id: string } }>('/api/agent-connect/:id/activation', { config, bodyLimit: 1024 }, async (request, reply) => {
    try {
      const owner = requireOwner(actorOf(request)), id = request.params.id;
      if (!catalog.has(id)) return reply.code(404).send({ code: 'not_found' });
      if (q.dialect !== 'sqlite') return reply.code(409).send({ code: 'unsupported_store' });
      const body = request.body;
      if (!record(body) || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new TypeError();
      const channel = await sql().tx(function* (): Step<ReturnType<typeof visible>> {
        const ext = extensionId(id);
        const row = yield* one<{config_json:string;enabled:number}>('SELECT config_json, enabled FROM extension_configs WHERE extension_id=?', ext);
        if (!row) throw new TypeError();
        const root = JSON.parse(row.config_json), current = native(id) ? root : root.channels?.[id];
        if (!record(current) || (body.enabled && !visible(id, root, true).configured)) throw new TypeError();
        const updated = { ...current, enabled: body.enabled, owner_user_id: owner.userId };
        // When first enabling a shared extension, leave every other saved channel off.
        const siblings = Object.fromEntries(Object.entries(root.channels ?? {}).map(([key, value]) => [key,
          row.enabled !== 1 && record(value) && value.enabled === undefined ? { ...value, enabled: false } : value]));
        const next = native(id) ? updated : { ...root, channels: { ...siblings, [id]: updated } };
        const hostEnabled = native(id) ? body.enabled : row.enabled === 1 || body.enabled;
        yield* run('UPDATE extension_configs SET config_json=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE extension_id=?', JSON.stringify(next), hostEnabled ? 1 : 0, ext);
        return visible(id, next, hostEnabled);
      });
      refreshChannel(id);
      return { saved: true, channel };
    } catch (error) { return deny(reply, error); }
  });
  app.put<{ Params: { id: string } }>('/api/agent-connect/:id/config', { config, bodyLimit: 65536 }, async (request, reply) => {
    try {
      const owner = requireOwner(actorOf(request)), id = request.params.id, item = catalog.get(id);
      if (!item) return reply.code(404).send({ code: 'not_found' });
      if (q.dialect !== 'sqlite') return reply.code(409).send({ code: 'unsupported_store' });
      const b = request.body;
      if (!record(b) || Object.keys(b).some(k => !['allowedUsers', 'allowedChannels', 'environment', 'settings'].includes(k)) || !accessList(b.allowedUsers) || !accessList(b.allowedChannels) || !isValidEnvironment(id, b.environment) || !isValidSettings(id, b.settings)) throw new TypeError();
      const env = record(b.environment) ? Object.fromEntries(Object.entries(b.environment).filter(([,v]) => v !== '')) : undefined;
      if (native(id) && (b.settings !== undefined || (env && Object.keys(env).some(k => !item.requiredEnv.includes(k as never))))) throw new TypeError();
      const channel = await sql().tx(function* (): Step<ReturnType<typeof visible>> {
        const ext = extensionId(id);
        const row = yield* one<{config_json:string;enabled:number}>('SELECT config_json, enabled FROM extension_configs WHERE extension_id=?', ext);
        const root = row ? JSON.parse(row.config_json) : {};
        const current = native(id) ? root : root.channels?.[id] ?? {};
        const updated = { ...current, enabled: current.enabled ?? (native(id) ? undefined : current.configured === true ? undefined : false), owner_user_id: owner.userId, allowed_users: b.allowedUsers, allowed_channels: b.allowedChannels, auto_reply: current.auto_reply === true };
        if (native(id)) {
          const tokenKey = item.requiredEnv[0];
          const token = tokenKey ? env?.[tokenKey] : undefined;
          if (token) updated.bot_token = token;
          if (typeof updated.bot_token !== 'string' || !updated.bot_token.trim()) throw new TypeError();
        } else {
          updated.environment = { ...current.environment, ...env };
          if (b.settings !== undefined) updated.settings = { ...current.settings, ...b.settings, ...(b.settings.extra ? {extra:{...current.settings?.extra,...b.settings.extra}} : {}) };
          if (!isValidEnvironment(id, updated.environment) || !isValidSettings(id, updated.settings)) throw new TypeError();
          if (current.configured !== true && item.requiredEnv.some(key => !updated.environment[key])) throw new TypeError();
          updated.configured = true;
        }
        const next = native(id) ? updated : { ...root, channels: { ...root.channels, [id]: updated } };
        yield* run('INSERT INTO extension_configs (extension_id, config_json, enabled) VALUES (?, ?, 0) ON CONFLICT(extension_id) DO UPDATE SET config_json=excluded.config_json, updated_at=CURRENT_TIMESTAMP', ext, JSON.stringify(next));
        return visible(id, next, row?.enabled === 1);
      });
      return { channel, saved: true };
    } catch (error) { return deny(reply, error); }
  });
}
