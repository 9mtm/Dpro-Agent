import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
/**
 * Agent Files API Routes
 *
 * RESTful endpoints for managing agent PERSONALITY.md and MEMORY.md files
 */

import type { FastifyInstance } from 'fastify';
import {
  readPersonality,
  writePersonality,
  readMemorySnapshot,
  writeMemoryCAS,
  listKnowledgeFiles,
  readKnowledgeFile,
  writeKnowledgeFile,
  deleteKnowledgeFile,
  getAgentFiles,
  initializeAgentDir
} from '../../services/agent-files.js';
import { sendInternalError } from '../error-handler.js';

export async function agentFilesRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/agents/:id/personality - Get PERSONALITY.md
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/agents/:id/personality',
    async (request, reply) => {
      const { id } = request.params;

      try {
        const content = await readPersonality(id);
        return {
          success: true,
          content
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] GET /api/agents/:id/personality', err);
      }
    }
  );

  /**
   * PUT /api/agents/:id/personality - Update PERSONALITY.md
   */
  fastify.put<{ Params: { id: string }; Body: { content: string } }>(
    '/api/agents/:id/personality',
    async (request, reply) => {
      const { id } = request.params;
      const { content } = request.body;

      if (!content) {
        return reply.code(400).send({
          success: false,
          error: 'content is required'
        });
      }

      try {
        await writePersonality(id, content);
        return {
          success: true,
          message: 'Personality updated'
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] PUT /api/agents/:id/personality', err);
      }
    }
  );

  const memoryOwner=async(request:any,reply:any)=>{
    reply.header('Cache-Control','no-store');
    try{const verified=await verifyRequestTokenAsync(request),actor=request.actor;
      if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||verified.user.role!=='owner'){reply.code(403).send({code:'forbidden'});return false;}return true;
    }catch(error){reply.code(error instanceof AuthTokenError?401:503).send({code:'memory_unavailable'});return false;}
  };
  fastify.get<{Params:{id:string}}>('/api/agents/:id/memory',{config:{access:'owner'}},async(request,reply)=>{
    if(!await memoryOwner(request,reply))return;
    if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_memory_request'});
    try{return {success:true,...await readMemorySnapshot(request.params.id)};}catch{return reply.code(503).send({code:'memory_unavailable'});}
  });
  fastify.put<{Params:{id:string};Body:{content?:unknown;expectedHash?:unknown}}>('/api/agents/:id/memory',{config:{access:'owner'}},async(request,reply)=>{
    if(!await memoryOwner(request,reply))return;
    const body=request.body;
    if(!body||typeof body.content!=='string'||Buffer.byteLength(body.content,'utf8')>32768||Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_memory_request'});
    if(!Object.hasOwn(body,'expectedHash')||!(body.expectedHash===null||typeof body.expectedHash==='string'&&/^[a-f0-9]{64}$/.test(body.expectedHash)))return reply.code(409).send({code:'memory_review_required'});
    try{return {success:true,...await writeMemoryCAS(request.params.id,body.content,body.expectedHash)};}catch(error){return reply.code(error instanceof Error&&/conflict|reviewed_memory_required|memory_too_large/.test(error.message)?409:503).send({code:error instanceof Error&&/conflict|reviewed_memory_required|memory_too_large/.test(error.message)?'memory_not_written':'memory_write_unconfirmed'});}
  });
  fastify.post('/api/agents/:id/memory/append',{config:{access:'owner'}},async(request,reply)=>{
    if(!await memoryOwner(request,reply))return;
    return reply.code(409).send({code:'memory_review_required'});
  });

  /**
   * GET /api/agents/:id/knowledge - List knowledge files
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/agents/:id/knowledge',
    async (request, reply) => {
      const { id } = request.params;

      try {
        const files = await listKnowledgeFiles(id);
        return {
          success: true,
          files
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] GET /api/agents/:id/knowledge', err);
      }
    }
  );

  /**
   * GET /api/agents/:id/knowledge/:filename - Read knowledge file
   */
  fastify.get<{ Params: { id: string; filename: string } }>(
    '/api/agents/:id/knowledge/*',
    async (request, reply) => {
      const { id } = request.params;
      const filename = (request.params as any)['*'];

      try {
        const content = await readKnowledgeFile(id, filename);
        return {
          success: true,
          filename,
          content
        };
      } catch (err: any) {
        return reply.code(404).send({
          success: false,
          error: 'File not found'
        });
      }
    }
  );

  /**
   * PUT /api/agents/:id/knowledge/:filename - Write knowledge file
   */
  fastify.put<{ Params: { id: string }; Body: { filename: string; content: string } }>(
    '/api/agents/:id/knowledge',
    async (request, reply) => {
      const { id } = request.params;
      const { filename, content } = request.body;

      if (!filename || !content) {
        return reply.code(400).send({
          success: false,
          error: 'filename and content are required'
        });
      }

      try {
        await writeKnowledgeFile(id, filename, content);
        return {
          success: true,
          message: 'File saved'
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] PUT /api/agents/:id/knowledge', err);
      }
    }
  );

  /**
   * DELETE /api/agents/:id/knowledge/:filename - Delete knowledge file
   */
  fastify.delete<{ Params: { id: string }; Body: { filename: string } }>(
    '/api/agents/:id/knowledge',
    async (request, reply) => {
      const { id } = request.params;
      const { filename } = request.body;

      if (!filename) {
        return reply.code(400).send({
          success: false,
          error: 'filename is required'
        });
      }

      try {
        await deleteKnowledgeFile(id, filename);
        return {
          success: true,
          message: 'File deleted'
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] DELETE /api/agents/:id/knowledge', err);
      }
    }
  );

  /**
   * GET /api/agents/:id/files - Get all agent files
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/agents/:id/files',
    {config:{access:'owner'}},
    async (request, reply) => {
      if(!await memoryOwner(request,reply))return;
      const { id } = request.params;

      try {
        const files = await getAgentFiles(id);
        return {
          success: true,
          ...files
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] GET /api/agents/:id/files', err);
      }
    }
  );

  /**
   * POST /api/agents/:id/initialize - Initialize agent directory
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/agents/:id/initialize',
    {config:{access:'owner'}},
    async (request, reply) => {
      if(!await memoryOwner(request,reply))return;
      const { id } = request.params;

      try {
        await initializeAgentDir(id);
        return {
          success: true,
          message: 'Agent directory initialized'
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] POST /api/agents/:id/initialize', err);
      }
    }
  );
}
