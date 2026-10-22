import {syncDepartmentBoards,relatedBoardTasks} from '../../services/task-board.js';
/**
 * Task board API (BOARD-01). Owner only (auth gate owner tier, route access
 * 'owner', handler role check).
 *
 *   GET   /api/boards?archived=1                       -> { boards: [summary], templates: [{id, name, description, columns}], colors }
 *                                                         (first call creates the company board)
 *   POST  /api/boards   { name, description?, template?, color?, departments? } -> 201 board
 *   PUT   /api/boards/:id { expectedVersion, name?, description?, color?, departments?, archived? } -> board
 *   GET   /api/boards/:id?archived=1                   -> { id, name, columns, cards }
 *   POST  /api/boards/:id/columns          { name }    -> board
 *   PUT   /api/boards/:id/columns/:columnId { name }   -> board
 *   POST  /api/boards/:id/cards            { columnId, title, description?, priority?, dueDate?, agents?, departments? } -> 201 card
 *   PUT   /api/boards/:id/cards/:cardId    { expectedVersion, title?, description?, priority?, dueDate?, agents?, departments?,
 *                                            columnId?, beforeCardId?, archived? } -> card; 409 { code: 'version_conflict', card }
 *   GET   /api/boards/:id/cards/:cardId/comments        -> { comments }
 *   POST  /api/boards/:id/cards/:cardId/comments { body } -> 201 { comments }
 *   POST  /api/boards/:id/labels { name, color } -> 201 board;  PUT /api/boards/:id/labels/:labelId { name?, color? } -> board
 *   GET   /api/boards/:id/cards/:cardId/checklist -> { items }
 *   POST  /api/boards/:id/cards/:cardId/checklist { text } -> 201 { items }
 *   PUT   /api/boards/:id/cards/:cardId/checklist/:itemId { text?, done?, remove? } -> { items }
 *   GET   /api/boards/:id/cards/:cardId/chat -> { conversation: { id, title } | null, progress } (CHAT-PRO-02 I step 2: the chat it came from, who works on it)
 *   Cards also take type (task|idea|bug|milestone|request), startDate, cover (colour or null) and labels (label ids).
 * Errors: 400 { code: 'invalid_board' | 'invalid_version' }, 404 { code: 'not_found' }.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import {
  BoardError, addChecklistItem, addColumn, addComment, addLabel, createBoard, createCard, getBoard, listBoards, listChecklist, listComments, renameColumn,
  updateBoard, updateCard, updateChecklistItem, updateLabel,
} from '../../services/task-board.js';
import { BOARD_COLORS, BOARD_TEMPLATES } from '../../services/board-templates.js';
import { cardConversation, chatProgress } from '../../services/chat-board.js';
import { chatRuns } from '../../services/chat-runs.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const actor = actorOrReply(reply, actorOf(request), requireOwner);
  return actor ? actor.userId ?? null : null;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new BoardError(400, 'invalid_board', 'Body must be a JSON object');
  return body as Record<string, unknown>;
}

function fail(err: unknown, reply: FastifyReply) {
  if (err instanceof BoardError) {
    const extra = (err as BoardError & { current?: unknown }).current;
    const board = (err as BoardError & { currentBoard?: unknown }).currentBoard;
    return reply.code(err.status).send({ error: err.message, code: err.code, ...(extra ? { card: extra } : {}), ...(board ? { board } : {}) });
  }
  throw err;
}

export async function taskBoardRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  type P = { id: string; columnId?: string; cardId?: string; labelId?: string; itemId?: string };
  const ids = (p: P) => [p.id, p.columnId, p.cardId, p.labelId, p.itemId].every((x) => x === undefined || ID.test(x));

  fastify.post('/api/boards/sync-departments',{config},async(request,reply)=>{
    const owner=ownerOf(request,reply);if(owner===null)return reply;
    try{if(request.body!==undefined&&Object.keys(objectBody(request.body)).length)throw new BoardError(400,'invalid_board','No fields accepted');return await syncDepartmentBoards(owner);}catch(err){return fail(err,reply);}
  });
  fastify.get<{Params:P}>('/api/boards/:id/overview',{config},async(request,reply)=>{
    const owner=ownerOf(request,reply);if(owner===null)return reply;if(!ids(request.params))return reply.code(404).send({code:'not_found'});
    try{return await relatedBoardTasks(owner,request.params.id);}catch(err){return fail(err,reply);}
  });
  fastify.get<{ Querystring: { archived?: string } }>('/api/boards', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    return {
      boards: await listBoards(owner, request.query?.archived === '1'),
      templates: BOARD_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, columns: [...t.columns] })),
      colors: [...BOARD_COLORS],
    };
  });

  fastify.post<{ Body: unknown }>('/api/boards', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    try { return reply.code(201).send(await createBoard(owner, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return await updateBoard(owner, request.params.id, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });

  fastify.get<{ Params: P; Querystring: { archived?: string } }>('/api/boards/:id', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return await getBoard(owner, request.params.id, request.query?.archived === '1'); } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/columns', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return reply.code(201).send(await addColumn(owner, request.params.id, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/columns/:columnId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Column not found', code: 'not_found' });
    try { return await renameColumn(owner, request.params.id, request.params.columnId!, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/cards', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return reply.code(201).send(await createCard(owner, request.params.id, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try { return await updateCard(owner, request.params.id, request.params.cardId!, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });

  fastify.get<{ Params: P }>('/api/boards/:id/cards/:cardId/comments', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try { return { comments: await listComments(owner, request.params.id, request.params.cardId!) }; } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId/comments', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try {
      return reply.code(201).send({ comments: await addComment(owner, request.params.id, request.params.cardId!, objectBody(request.body), { kind: 'user', id: owner }) });
    } catch (err) { return fail(err, reply); }
  });

  // CHAT-PRO-02 I step 2: the conversation a card came from and the progress of the agents on it
  fastify.get<{ Params: P }>('/api/boards/:id/cards/:cardId/chat', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try {
      const { conversation, agents } = await cardConversation(owner, request.params.id, request.params.cardId!);
      const active = conversation ? chatRuns.activeFor(conversation.id) : undefined;
      const progress = conversation
        ? await chatProgress(conversation.id, conversation.agentId, agents, active ? { agentId: active.agentId, parts: active.parts } : null)
        : { running: false, agents: agents.map((agentId) => ({ agentId, replies: 0, lastAt: null, running: false, plan: null })) };
      return { conversation: conversation ? { id: conversation.id, title: conversation.title } : null, progress };
    } catch (err) { return fail(err, reply); }
  });

  // BOARD-03 step B: labels and checklists
  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/labels', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return reply.code(201).send(await addLabel(owner, request.params.id, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/labels/:labelId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Label not found', code: 'not_found' });
    try { return await updateLabel(owner, request.params.id, request.params.labelId!, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });

  fastify.get<{ Params: P }>('/api/boards/:id/cards/:cardId/checklist', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try { return { items: await listChecklist(owner, request.params.id, request.params.cardId!) }; } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId/checklist', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try { return reply.code(201).send({ items: await addChecklistItem(owner, request.params.id, request.params.cardId!, objectBody(request.body)) }); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId/checklist/:itemId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Item not found', code: 'not_found' });
    try { return { items: await updateChecklistItem(owner, request.params.id, request.params.cardId!, request.params.itemId!, objectBody(request.body)) }; } catch (err) { return fail(err, reply); }
  });
}
