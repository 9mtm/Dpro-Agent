import {subscriptionModel,subscriptionEnabled} from '../../services/subscription-chat.js';
import {projectFolders} from '../../services/project-folder-picker.js';
/**
 * Saved conversations and resumable chat runs (CHAT-REBUILD-01).
 *
 *   GET    /api/chat/conversations                 the caller's conversations (pinned first)
 *   GET    /api/chat/search?q=&projectId=&limit=   the caller's conversations containing q, grouped, newest first (CHAT-PRO-02 D)
 *   POST   /api/chat/conversations                 { title?, agentId? } → new conversation
 *   PUT    /api/chat/conversations/:id             { title?, pinned? }
 *   DELETE /api/chat/conversations/:id
 *   GET    /api/chat/conversations/:id/messages    turns with their work + the running run id
 *   GET    /api/chat/conversations/:id/export[?tools=1]  the conversation as Markdown { filename, markdown, … } (CHAT-PRO-02 F)
 *   POST   /api/chat/conversations/:id/runs        { runId, message } → starts a turn (202)
 *   GET    /api/chat/runs/:runId/events?after=N    SSE: the run's events after N, then live
 *   POST   /api/chat/runs/:runId/stop              stop; the partial reply is kept
 *   GET    /api/chat/conversations/:id/cards       owner: board cards made from it + who works on it (CHAT-PRO-02 I step 2)
 *   POST   /api/chat/conversations/:id/cards       owner: { boardId, columnId?, title, description?, priority?, type?, agents? } → 201 { card }
 *   GET    /api/chat/conversations/:id/memories    owner: memories and agent proposals from it (CHAT-PRO-02 E)
 *   POST   /api/chat/conversations/:id/memories    owner: "Remember this" { messageId, content, drawer, type?, importance? } → 201 { memory }
 *   GET    /api/chat/secrets                       the caller's keys saved from the chat (never values) (CHAT-SECRETS-01)
 *   DELETE /api/chat/secrets/:id                   delete one of them
 *   POST   /api/chat/secrets/cleanup               owner: { apply: boolean } move secrets of older saved messages into the key store
 *
 * SECURITY: an active signed-in user (auth gate 'user' tier + the handler's
 * own check). Conversations and runs of other users answer 404. The model
 * history is built here from the stored turns, never taken from the client.
 * A run uses the same turn code as POST /api/chat (tool grants, approvals,
 * memory drawers, personality).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateActiveUser } from '../../auth/route-guards.js';
import {
  addUserMessage, createConversation, createProject, deleteConversation, deleteProject, findConversation, findProject, gitInfo,
  listConversationMessages, listConversations, listProjects, patchConversation, patchProject, ProjectInputError, type ConversationMessage,
} from '../../repositories/chat-conversations.js';
import { ProjectPathError, gitChanges, gitFileDiff, listFolder, readFolderFile } from '../../repositories/project-files.js';
import { MAX_AUDIO_BYTES, STT_LANGUAGES, SttError, sttSetup, transcribe } from '../../services/local-stt.js';
import { chatRuns, MAX_RUNNING_PER_USER, type RunEvent } from '../../services/chat-runs.js';
import { openSseStream } from '../../services/chat-sse.js';
import { executeChatTurn } from './chat.js';
import { q } from '../../repositories/sql-steps.js';
import { chatProgress, conversationCards, createChatCard } from '../../services/chat-board.js';
import { BoardError } from '../../services/task-board.js';
import { ChatMemoryError, conversationMemories, rememberFromChat } from '../../services/chat-memory.js';
import { actorOf } from '../../auth/auth-gate.js';
import { ChatSearchError, parseSearch, searchConversations } from '../../services/chat-search.js';
import { exportConversation } from '../../services/chat-export.js';
import { cleanupChatSecrets, deleteChatSecret, listChatSecrets, vaultSecretsInText } from '../../services/chat-secrets.js';
import { redactImportText, SECRET_REF_RE } from '../../memory/import/redact.js';
import { isLmStudioModelId } from '../../llm/lmstudio.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
/** A model id the chat may pick (local model names like qwen3.8:27b, or claude-…). */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,99}$/;
/** Which provider a picked model belongs to (`lmstudio:` ids run on LM Studio, CHAT-PRO-02 G). */
const modelProvider = (model: string) => (/^claude-/.test(model) ? 'claude' as const : isLmStudioModelId(model) ? 'lmstudio' as const : 'ollama' as const);
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const MESSAGE_CHARS = 100_000;
/** Characters of earlier turns given to the model (the newest are kept). */
export const HISTORY_CHARS = 200_000;
const TITLE_CHARS = 120;

type Req = FastifyRequest<{ Params: { id?: string; runId?: string }; Querystring: { after?: string }; Body: any }>;

/** CHAT-SECRETS-01: a title is never a place for a secret; one typed there is removed. */
const cleanTitle = (t: unknown) => (typeof t === 'string' ? redactImportText(t).text : t as null | undefined);

function caller(request: FastifyRequest): string { return (request as any).chatUserId as string; }

/** The team's agents by id (name), for choosing who answers and naming earlier replies. */
async function agentNames(): Promise<Map<string, string>> {
  const rows = await q.all<{ id: string; name: string | null }>('SELECT id, name FROM agents_config');
  return new Map(rows.map((r) => [r.id, r.name || r.id]));
}

/** Replies written by another agent than the one answering now carry that agent's name, so the history stays honest. */
export function namedReplies(messages: readonly ConversationMessage[], team: ReadonlyMap<string, string>, current: string | undefined, conversationAgent: string | null = null): ConversationMessage[] {
  return messages.map((m) => {
    const writer = m.agentId ?? conversationAgent;
    if (m.role !== 'assistant' || (writer ?? null) === (current ?? null)) return m;
    return { ...m, content: `[${(writer && team.get(writer)) || 'Main agent'}] ${m.content}` };
  });
}

/** The model history from stored turns: user/assistant text only, newest kept within the budget. */
export function historyFor(messages: readonly ConversationMessage[], budget = HISTORY_CHARS): { role: 'user' | 'assistant'; content: string }[] {
  const turns = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.status === 'stopped' ? `${m.content}\n\n[This reply was stopped by the user before it finished.]` : m.content }));
  const out: typeof turns = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    used += turns[i].content.length;
    if (used > budget && out.length) break;
    out.unshift(turns[i]);
  }
  // Providers want the history to start with the user and alternate roles.
  while (out.length && out[0].role !== 'user') out.shift();
  const merged: typeof out = [];
  for (const t of out) {
    const last = merged.at(-1);
    if (last && last.role === t.role) last.content += `\n\n${t.content}`;
    else merged.push({ ...t });
  }
  return merged;
}

/** A short system note so the agent knows which project it works in. */
export function projectNote(name: string, folder: string | null, repo: string | null): string {
  return [`## Current project\nYou are working in the project "${name}".`,
    folder ? `Its folder on this computer is ${folder}; the read tool reads files from that folder (paths relative to it).` : '',
    repo ? `Its git repository: ${repo}.` : ''].filter(Boolean).join(' ');
}

export async function chatConversationRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request, reply) => {
    const user = authenticateActiveUser(request);
    if (!user || user.role === 'guest') return reply.code(401).send({ error: 'Authentication required' });
    (request as any).chatUserId = user.id;
    (request as any).chatUserRole = user.role;
  });
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found', code: 'not_found' });
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error, code: 'invalid_request' });

  fastify.get('/api/chat/conversations', async (request) => ({ conversations: await listConversations(caller(request)) }));

  // ---- search inside conversations (CHAT-PRO-02 D): the caller's own conversations only ----
  fastify.get('/api/chat/search', async (request, reply) => {
    try {
      const { query, projectId, limit } = await parseSearch(caller(request), (request.query ?? {}) as Record<string, unknown>);
      return await searchConversations(caller(request), query, { projectId, limit });
    } catch (err) {
      if (err instanceof ChatSearchError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  fastify.post('/api/chat/conversations', async (request: Req, reply) => {
    const b: any = request.body ?? {};
    if (b.model !== undefined && (typeof b.model !== 'string' || (b.model !== '' && !MODEL.test(b.model)))) return bad(reply, 'invalid model');
    if (subscriptionModel(b.model) && (request as any).chatUserRole !== 'owner') return reply.code(403).send({code:'forbidden'});
    if (b.title !== undefined && (typeof b.title !== 'string' || b.title.length > TITLE_CHARS)) return bad(reply, 'title must be text of at most 120 characters');
    if (b.agentId !== undefined && b.agentId !== null && (typeof b.agentId !== 'string' || !AGENT_ID.test(b.agentId))) return bad(reply, 'invalid agentId');
    if (b.projectId !== undefined && b.projectId !== null && (typeof b.projectId !== 'string' || !(await findProject(caller(request), b.projectId)))) return bad(reply, 'unknown project');
    return reply.code(201).send({ conversation: await createConversation(caller(request), { title: cleanTitle(b.title), agentId: b.agentId, projectId: b.projectId, model: b.model }) });
  });

  fastify.put('/api/chat/conversations/:id', async (request: Req, reply) => {
    const b: any = request.body ?? {};
    if (b.model !== undefined && (typeof b.model !== 'string' || (b.model !== '' && !MODEL.test(b.model)))) return bad(reply, 'invalid model');
    if (subscriptionModel(b.model) && (request as any).chatUserRole !== 'owner') return reply.code(403).send({code:'forbidden'});
    if (b.title !== undefined && b.title !== null && (typeof b.title !== 'string' || b.title.length > TITLE_CHARS)) return bad(reply, 'title must be text of at most 120 characters');
    if (b.pinned !== undefined && typeof b.pinned !== 'boolean') return bad(reply, 'pinned must be true or false');
    if (b.projectId !== undefined && b.projectId !== null && (typeof b.projectId !== 'string' || !(await findProject(caller(request), b.projectId)))) return bad(reply, 'unknown project');
    const c = await patchConversation(caller(request), request.params.id!, { title: cleanTitle(b.title), pinned: b.pinned, projectId: b.projectId, model: b.model });
    return c ? { conversation: c } : notFound(reply);
  });

  fastify.delete('/api/chat/conversations/:id', async (request: Req, reply) => {
    const id = request.params.id!;
    const active = chatRuns.activeFor(id);
    if (active && active.userId === caller(request)) active.requestStop();
    return (await deleteConversation(caller(request), id)) ? { ok: true } : notFound(reply);
  });

  fastify.get('/api/chat/conversations/:id/messages', async (request: Req, reply) => {
    const c = await findConversation(caller(request), request.params.id!);
    if (!c) return notFound(reply);
    const active = chatRuns.activeFor(c.id);
    return { conversation: c, messages: await listConversationMessages(c.id), activeRunId: active?.id ?? null };
  });

  // ---- export as Markdown (CHAT-PRO-02 F): the caller's own conversation, secrets removed ----
  fastify.get('/api/chat/conversations/:id/export', async (request: Req, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (Object.keys(query).some((k) => k !== 'tools') || (query.tools !== undefined && query.tools !== '1')) return bad(reply, 'the only option is tools=1');
    if (!ID.test(request.params.id ?? '')) return notFound(reply);
    const out = await exportConversation(caller(request), request.params.id!, { tools: query.tools === '1' });
    if (!out) return notFound(reply);
    reply.header('Cache-Control', 'no-store');
    return out;
  });

  fastify.post('/api/chat/conversations/:id/runs', async (request: Req, reply) => {
    const userId = caller(request);
    const c = await findConversation(userId, request.params.id!);
    if (!c) return notFound(reply);
    const b: any = {...(request.body as any ?? {})};
    if(b.model===undefined&&c.model)b.model=c.model;
    if (typeof b.runId !== 'string' || !ID.test(b.runId)) return bad(reply, 'runId must be 8-128 characters (A-Z, a-z, 0-9, _ . : -)');
    if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > MESSAGE_CHARS) return bad(reply, 'message must be 1-100000 characters');
    if (b.model !== undefined && (typeof b.model !== 'string' || !MODEL.test(b.model))) return bad(reply, 'invalid model');
    // CHAT-PRO-02 I: another agent of the team may write this reply (owner only: other users talk to the conversation's agent).
    if (b.agentId !== undefined && (typeof b.agentId !== 'string' || !AGENT_ID.test(b.agentId))) return bad(reply, 'invalid agentId');
    const team = await agentNames();
    if (b.agentId !== undefined && (!team.has(b.agentId) || (request as any).chatUserRole !== 'owner')) return bad(reply, 'unknown agent');
    const replyAgent: string | undefined = b.agentId ?? c.agentId ?? undefined;
    const existing = chatRuns.get(b.runId);
    if (existing) return existing.userId === userId && existing.sessionId === c.id ? reply.code(202).send({ runId: existing.id, replayed: true }) : reply.code(409).send({ error: 'runId already used', code: 'run_id_reused' });
    const busy = chatRuns.activeFor(c.id);
    if (busy) return reply.code(409).send({ error: 'This conversation is still answering', code: 'conversation_busy', runId: busy.id });
    if (chatRuns.runningCount(userId) >= MAX_RUNNING_PER_USER) {
      reply.header('Retry-After', '10');
      return reply.code(429).send({ error: 'Too many chat turns are running', code: 'rate_limited' });
    }
    // CHAT-PRO-02 A: a project conversation reads the project folder and opens its memory drawer.
    const project = c.projectId ? await findProject(userId, c.projectId) : undefined;
    if(subscriptionModel(b.model)&&(!subscriptionEnabled()||(request as any).chatUserRole!=='owner'||!project?.folder))return reply.code(400).send({code:'no_folder',error:'Choose a project folder for subscription chat.'});
    const prior = await listConversationMessages(c.id);
    if (prior.some((m) => m.runId === b.runId)) return reply.code(409).send({ error: 'runId already used', code: 'run_id_reused' });
    // CHAT-SECRETS-01: secrets go encrypted into the key store; the message keeps references only.
    const vaulted = await vaultSecretsInText(userId, c.id, b.message);
    const userMessage = await addUserMessage(c.id, vaulted.text, b.runId);
    const messages = historyFor(namedReplies([...prior, userMessage], team, replyAgent, c.agentId));
    chatRuns.start({
      runId: b.runId, userId, sessionId: c.id, agentId: b.agentId ?? null,
      execute: (runReply) => executeChatTurn(runReply, {
        agentId: replyAgent, messages, stream: true, sessionId: c.id, userId, uiSet: 'chat',
        ...(project ? { memoryScope: { project: project.slug }, ...(project.folder ? { fileReadRoot: project.folder } : {}) } : {}),
        systemPromptAppend: [project ? projectNote(project.name, project.folder, project.repoUrl) : '', PLAN_NOTE, [...prior, userMessage].some((m) => new RegExp(SECRET_REF_RE.source).test(m.content)) ? SECRET_NOTE : '', prior.some((m) => m.role === 'assistant' && (m.agentId ?? c.agentId ?? null) !== (replyAgent ?? null)) ? TEAM_NOTE : ''].filter(Boolean).join('\n\n'),
        ...(b.model ? { model: b.model, provider: modelProvider(b.model) } : {}),
      }),
    });
    console.log('[ChatRuns] Run started', { runId: b.runId, history: messages.length });
    return reply.code(202).send({ runId: b.runId, userMessage, secretsSaved: vaulted.saved.length });
  });

  // ---- board cards made from a conversation (CHAT-PRO-02 I step 2): owner only, like the board ----
  const boardError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BoardError) return reply.code(err.status).send({ error: err.message, code: err.code });
    throw err;
  };
  fastify.get('/api/chat/conversations/:id/cards', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const userId = caller(request);
    const c = await findConversation(userId, request.params.id!);
    if (!c) return notFound(reply);
    try {
      const cards = await conversationCards(userId, c.id);
      const active = chatRuns.activeFor(c.id);
      const assigned = [...new Set(cards.filter((k) => !k.archived).flatMap((k) => k.agents))];
      const progress = await chatProgress(c.id, c.agentId, assigned, active ? { agentId: active.agentId, parts: active.parts } : null);
      return { cards, progress };
    } catch (err) { return boardError(reply, err); }
  });
  fastify.post('/api/chat/conversations/:id/cards', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const b = request.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return bad(reply, 'Body must be a JSON object');
    try { return reply.code(201).send({ card: await createChatCard(caller(request), request.params.id!, b as Record<string, unknown>) }); } catch (err) { return boardError(reply, err); }
  });

  // ---- chat memory (CHAT-PRO-02 E): owner only, like the memory files and proposals ----
  const memoryError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ChatMemoryError) return reply.code(err.status).send({ error: err.message, code: err.code });
    throw err;
  };
  fastify.get('/api/chat/conversations/:id/memories', { config: { access: 'owner' } }, async (request: Req, reply) => {
    try { return { memories: await conversationMemories(caller(request), request.params.id!) }; } catch (err) { return memoryError(reply, err); }
  });
  fastify.post('/api/chat/conversations/:id/memories', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const b = request.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return bad(reply, 'Body must be a JSON object');
    const actor = actorOf(request);
    if (!actor) return reply.code(401).send({ error: 'Authentication required' });
    try { return reply.code(201).send(await rememberFromChat(actor, caller(request), request.params.id!, b as Record<string, unknown>)); } catch (err) { return memoryError(reply, err); }
  });

  // ---- keys saved from the chat (CHAT-SECRETS-01): the caller's own, values never returned ----
  fastify.get('/api/chat/secrets', async (request) => ({ secrets: await listChatSecrets(caller(request)) }));
  fastify.delete('/api/chat/secrets/:id', async (request: Req, reply) => {
    if (!/^[a-z0-9]{6,32}$/.test(request.params.id ?? '')) return notFound(reply);
    return (await deleteChatSecret(caller(request), request.params.id!)) ? { deleted: true } : notFound(reply);
  });
  fastify.post('/api/chat/secrets/cleanup', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const b = request.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b) || typeof (b as any).apply !== 'boolean' || Object.keys(b).some((k) => k !== 'apply')) return bad(reply, 'Body must be { apply: true | false }');
    return { report: await cleanupChatSecrets(caller(request), (b as any).apply) };
  });

  // ---- projects (CHAT-PRO-02 A): owner only (a project names a folder the agent may read) ----
  const projectError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ProjectInputError) return reply.code(400).send({ error: err.message, code: 'invalid_project' });
    throw err;
  };
  fastify.post('/api/chat/project-folders', {config:{access:'owner'}}, async (request: Req,reply) => {
    const b:any=request.body??{};
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>k!=='path')||(b.path!==undefined&&typeof b.path!=='string'))return reply.code(400).send({code:'invalid_project'});
    try{return await projectFolders(b.path);}catch{return reply.code(400).send({code:'invalid_project'});}
  });
  fastify.get('/api/chat/projects', { config: { access: 'owner' } }, async (request) => ({ projects: await listProjects(caller(request)) }));
  fastify.post('/api/chat/projects', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const b: any = request.body ?? {};
    if (typeof b.name !== 'string' || (b.folder !== undefined && b.folder !== null && typeof b.folder !== 'string') || (b.repoUrl !== undefined && b.repoUrl !== null && typeof b.repoUrl !== 'string')) return bad(reply, 'name, folder and repoUrl must be text');
    if (typeof b.folder !== 'string' || !b.folder.trim()) return reply.code(400).send({ code: 'invalid_project', error: 'Choose a working folder for this project. Use General chat without a folder.' });
    try { return reply.code(201).send({ project: await createProject(caller(request), { name: b.name, folder: b.folder, repoUrl: b.repoUrl }) }); } catch (err) { return projectError(reply, err); }
  });
  fastify.put('/api/chat/projects/:id', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const b: any = request.body ?? {};
    for (const k of ['name', 'folder', 'repoUrl']) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') return bad(reply, `${k} must be text`);
    try { const p = await patchProject(caller(request), request.params.id!, { name: b.name, folder: b.folder, repoUrl: b.repoUrl }); return p ? { project: p } : notFound(reply); } catch (err) { return projectError(reply, err); }
  });
  fastify.delete('/api/chat/projects/:id', { config: { access: 'owner' } }, async (request: Req, reply) => ((await deleteProject(caller(request), request.params.id!)) ? { ok: true } : notFound(reply)));
  fastify.get('/api/chat/projects/:id/git', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const p = await findProject(caller(request), request.params.id!);
    if (!p) return notFound(reply);
    return { git: p.folder ? await gitInfo(p.folder) : { branch: null, remote: null, dirty: null } };
  });

  /** CHAT-PRO-02 I: more than one agent has answered in this conversation. */
  const TEAM_NOTE = 'Several agents of the team answer in this conversation. Earlier replies written by another agent start with that agent\'s name in brackets, like [Name]. Build on their work; do not repeat it, and do not write as them.';
  /** CHAT-PRO-02 H: how the agent shows its work in the chat. */
  const SECRET_NOTE = 'Secrets in this chat (keys, tokens, passwords the owner typed or a tool showed) were moved to the encrypted key store; you see a reference like [SECRET:github_token:abc123] instead. Never ask for the value again and never try to reveal it. When a tool needs it, put the reference itself in the tool input; the tool gets the real value after the owner approves that call.';
  const PLAN_NOTE = 'When a request needs several steps (3 or more), first call plan_steps with the whole plan so the owner sees it, then work through it and call plan_steps again with the whole list as each step finishes. Keep steps short. Skip the plan for a quick question or a one-step answer. When the owner gives a larger task that other agents of the team should share, you may call board_suggest_card once; the owner decides whether it becomes a board card. When the owner shares a lasting fact, preference or decision worth keeping, you may call memory_save; in this chat it is shown to the owner, who accepts or rejects it.';

  // ---- microphone (CHAT-PRO-02 C): a recorded clip → text, on this computer only (owner) ----
  fastify.get('/api/chat/transcribe', { config: { access: 'owner' } }, async () => { const s = sttSetup(); return { available: s.available, missing: s.missing }; });
  fastify.post('/api/chat/transcribe', { config: { access: 'owner' }, bodyLimit: Math.ceil(MAX_AUDIO_BYTES * 1.4) + 1024 }, async (request: Req, reply) => {
    const b: any = request.body ?? {};
    if (typeof b.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.audio) || (b.language !== undefined && !(STT_LANGUAGES as readonly string[]).includes(b.language))) return bad(reply, 'audio must be base64 text; language must be auto, ar, en or de');
    try { return await transcribe(Buffer.from(b.audio, 'base64'), b.language ?? 'auto'); }
    catch (err) {
      if (err instanceof SttError) return reply.code(err.code === 'unavailable' ? 503 : err.code === 'busy' ? 429 : err.code === 'invalid' ? 400 : 500).send({ error: err.message, code: `stt_${err.code}` });
      throw err;
    }
  });

  // ---- project panes (CHAT-PANES-01): read-only changes, diff, folder and file ----
  const folderOf = async (request: Req, reply: FastifyReply) => {
    const p = await findProject(caller(request), request.params.id!);
    if (!p) { notFound(reply); return null; }
    if (!p.folder) { reply.code(400).send({ error: 'This project has no folder', code: 'no_folder' }); return null; }
    return p.folder;
  };
  const paneError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ProjectPathError) return reply.code(400).send({ error: err.message, code: 'bad_path' });
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    throw err;
  };
  fastify.get('/api/chat/projects/:id/changes', { config: { access: 'owner' } }, async (request: Req, reply) => {
    const folder = await folderOf(request, reply); if (!folder) return reply;
    const c = await gitChanges(folder);
    return c ?? { branch: null, changes: [], truncated: false, notGit: true };
  });
  for (const [route, fn] of [['diff', gitFileDiff], ['tree', listFolder], ['file', readFolderFile]] as const) {
    fastify.get(`/api/chat/projects/:id/${route}`, { config: { access: 'owner' } }, async (request: Req, reply) => {
      const folder = await folderOf(request, reply); if (!folder) return reply;
      try { return await fn(folder, (request.query as Record<string, unknown>).path); } catch (err) { return paneError(reply, err); }
    });
  }

  fastify.get('/api/chat/runs/:runId/events', async (request: Req, reply) => {
    const run = chatRuns.get(request.params.runId!);
    if (!run || run.userId !== caller(request)) return notFound(reply);
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return bad(reply, 'after must be a whole number');
    const raw = reply.raw;
    openSseStream(raw);
    const send = (e: RunEvent) => { if (!raw.writableEnded) raw.write(`id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, ...e.frame })}\n\n`); };
    const backlog = run.since(after);
    backlog.forEach(send);
    if (run.status !== 'running') { raw.end(); return reply; }
    const onEvent = (e: RunEvent) => send(e);
    const onEnd = () => { cleanup(); raw.end(); };
    const cleanup = () => { run.emitter.off('event', onEvent); run.emitter.off('end', onEnd); };
    run.emitter.on('event', onEvent);
    run.emitter.once('end', onEnd);
    raw.once('close', cleanup); // a reader leaving never stops the run
    return reply;
  });

  fastify.post('/api/chat/runs/:runId/stop', async (request: Req, reply) => {
    const run = chatRuns.get(request.params.runId!);
    if (!run || run.userId !== caller(request)) return notFound(reply);
    run.requestStop();
    return { ok: true, status: run.status === 'running' ? 'stopping' : run.status };
  });
}
