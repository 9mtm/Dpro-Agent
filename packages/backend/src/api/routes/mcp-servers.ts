/**
 * MCP client server registry API (M1). Owner only (auth gate owner tier for
 * /api/mcp, route access 'owner', handler role check). Every change is
 * written to the audit log (env/header names only, never values). Secret
 * values are stored in the credential manager and returned masked.
 *
 *   GET    /api/mcp/servers                      list (masked)
 *   POST   /api/mcp/servers                      add (always starts disabled)
 *   GET    /api/mcp/servers/:id                  one server + discovered tools
 *   PUT    /api/mcp/servers/:id                  change (a launch/URL change disables it)
 *   DELETE /api/mcp/servers/:id                  remove (tools and stored secrets too)
 *   POST   /api/mcp/servers/:id/enable           { launchHash? } stdio: 409 launch_approval_required
 *                                                with the exact launch + launchHash until approved;
 *                                                needs AGENT_EXEC_TOOLS=true (403 otherwise)
 *   POST   /api/mcp/servers/:id/disable
 *   POST   /api/mcp/servers/:id/refresh          connect + tools/list, store validated schemas
 *   PUT    /api/mcp/servers/:id/tools/:tool      { requiresApproval: true | false | null }
 *
 * Granting MCP tools to an agent is done with the grants API
 * (PUT /api/agents/:id/tool-grants, names mcp__<server>__<tool> or mcp:<server>:<tool>).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logAudit } from '../../services/audit-logger.js';
import {
  createServer, deleteServer, disableServer, enableServer, getServer, listServers, McpConfigError, McpPolicyError,
  refreshServer, reconnectServer, connectionState, setToolApproval, updateServer, type McpServerView,
} from '../../mcp-client/index.js';
import { handleError } from '../error-handler.js';

const ID = /^[0-9a-f-]{36}$/;
const liveView=(server:McpServerView)=>({...server,connectionState:connectionState(server.id)});

function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const user = request.authUser;
  if (!user) { reply.code(401).send({ error: 'Authentication required' }); return null; }
  if (user.role !== 'owner') { reply.code(403).send({ error: 'This action requires the owner account' }); return null; }
  return user.id;
}

/** Non-secret summary for the audit log. */
function summary(s: Pick<McpServerView, 'name' | 'transport' | 'command' | 'args' | 'url' | 'allowRemote' | 'env' | 'headers' | 'enabled'>) {
  return {
    name: s.name, transport: s.transport, command: s.command, argsCount: s.args.length, url: s.url, allowRemote: s.allowRemote,
    envNames: Object.keys(s.env), headerNames: Object.keys(s.headers), enabled: s.enabled,
  };
}

export async function mcpServersRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };

  const audit = (request: FastifyRequest, ownerId: string, action: string, success: boolean, resourceId: string | undefined, metadata: Record<string, unknown>, error?: string) => {
    logAudit({
      event_type: 'mcp.server.change', event_category: 'system', severity: success ? 'info' : 'warning',
      user_id: ownerId, ip_address: request.ip, user_agent: request.headers['user-agent'],
      request_method: request.method, request_path: request.routeOptions?.url ?? undefined,
      resource_type: 'mcp_server', resource_id: resourceId, action, success, error_message: error, metadata,
    });
  };

  const fail = (request: FastifyRequest, reply: FastifyReply, ownerId: string, action: string, id: string | undefined, err: unknown) => {
    if (err instanceof McpPolicyError) {
      if (err.status !== 404) audit(request, ownerId, action, false, id, { code: err.code }, err.message);
      return reply.code(err.status).send({ error: err.message, code: err.code, ...err.extra });
    }
    if (err instanceof McpConfigError) {
      audit(request, ownerId, action, false, id, { code: 'invalid_input' }, err.message);
      return reply.code(400).send({ error: err.message, code: 'invalid_input' });
    }
    return handleError(reply, err, 'internal', '[MCP] request failed');
  };

  const badId = (id: string, reply: FastifyReply) => {
    if (ID.test(id)) return false;
    reply.code(400).send({ error: 'Invalid server id' });
    return true;
  };

  fastify.get('/api/mcp/servers', { config }, async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    return { servers: (await listServers()).map(liveView) };
  });

  fastify.post<{ Body: Record<string, unknown> }>('/api/mcp/servers', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      const server = await createServer(request.body || {}, ownerId);
      audit(request, ownerId, 'mcp_server.add', true, server.id, summary(server));
      return reply.code(201).send(liveView(server));
    } catch (err) {
      return fail(request, reply, ownerId, 'mcp_server.add', undefined, err);
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/mcp/servers/:id', { config }, async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    if (badId(request.params.id, reply)) return reply;
    const server = await getServer(request.params.id);
    if (!server) return reply.code(404).send({ error: 'MCP server not found' });
    return liveView(server);
  });

  fastify.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/mcp/servers/:id', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id } = request.params;
    if (badId(id, reply)) return reply;
    try {
      const { server, disabled, revokedGrants } = await updateServer(id, request.body || {}, ownerId);
      audit(request, ownerId, 'mcp_server.update', true, id, { ...summary(server), disabledByChange: disabled, revokedGrants: revokedGrants.length });
      return { ...liveView(server), disabledByChange: disabled, revokedGrants };
    } catch (err) {
      return fail(request, reply, ownerId, 'mcp_server.update', id, err);
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/mcp/servers/:id', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id } = request.params;
    if (badId(id, reply)) return reply;
    try {
      const row = await deleteServer(id, ownerId);
      audit(request, ownerId, 'mcp_server.delete', true, id, { name: row.name, transport: row.transport, revokedGrants: row.revokedGrants.length });
      return { deleted: true, id, revokedGrants: row.revokedGrants };
    } catch (err) {
      return fail(request, reply, ownerId, 'mcp_server.delete', id, err);
    }
  });

  fastify.post<{ Params: { id: string }; Body: { launchHash?: unknown } }>('/api/mcp/servers/:id/enable', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id } = request.params;
    if (badId(id, reply)) return reply;
    try {
      const server = await enableServer(id, request.body || {}, ownerId);
      audit(request, ownerId, 'mcp_server.enable', true, id, {
        ...summary(server), launchApproved: server.transport === 'stdio' ? server.launchHash : null,
      });
      return liveView(server);
    } catch (err) {
      return fail(request, reply, ownerId, 'mcp_server.enable', id, err);
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/mcp/servers/:id/disable', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id } = request.params;
    if (badId(id, reply)) return reply;
    try {
      const server = await disableServer(id);
      audit(request, ownerId, 'mcp_server.disable', true, id, { name: server.name });
      return liveView(server);
    } catch (err) {
      return fail(request, reply, ownerId, 'mcp_server.disable', id, err);
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/mcp/servers/:id/refresh', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id } = request.params;
    if (badId(id, reply)) return reply;
    try {
      const result = await refreshServer(id, ownerId);
      audit(request, ownerId, 'mcp_server.refresh', true, id, {
        name: result.server.name, discovered: result.discovered, skipped: result.skipped.map((s) => s.tool), truncated: result.truncated, revokedGrants: result.revokedGrants.length,
      });
      return {...result,server:liveView(result.server)};
    } catch (err) {
      return fail(request, reply, ownerId, 'mcp_server.refresh', id, err);
    }
  });

  fastify.post<{Params:{id:string}}>('/api/mcp/servers/:id/reconnect',{config},async(request,reply)=>{
    const ownerId=ownerOf(request,reply);if(ownerId===null)return reply;
    const {id}=request.params;if(badId(id,reply))return reply;
    try{const result=await reconnectServer(id,ownerId);audit(request,ownerId,'mcp_server.reconnect',true,id,{name:result.server.name,discovered:result.discovered,revokedGrants:result.revokedGrants.length});return {...result,server:liveView(result.server)};}catch(err){return fail(request,reply,ownerId,'mcp_server.reconnect',id,err);}
  });

  fastify.put<{ Params: { id: string; tool: string }; Body: { requiresApproval?: unknown } }>('/api/mcp/servers/:id/tools/:tool', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const { id, tool } = request.params;
    if (badId(id, reply)) return reply;
    try {
      const value = (request.body || {}).requiresApproval;
      const server = await setToolApproval(id, tool, value === undefined ? Symbol('missing') : value);
      audit(request, ownerId, 'mcp_tool.approval_setting', true, id, { name: server.name, tool, requiresApproval: value });
      return liveView(server);
    } catch (err) {
      return fail(request, reply, ownerId, 'mcp_tool.approval_setting', id, err);
    }
  });
}
