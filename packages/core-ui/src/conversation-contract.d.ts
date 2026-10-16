export const CONVERSATIONS_PATH: '/api/chat/conversations';
export const PROJECTS_PATH: '/api/chat/projects';
export type WireProject = { id: string; name: string; slug: string; folder: string | null; repoUrl: string | null };
export type WireGit = { branch: string | null; remote: string | null; dirty: boolean | null; added?: number | null; removed?: number | null; files?: number | null;
  upstream?: string | null; ahead?: number | null; behind?: number | null; defaultBranch?: string | null;
  lastCommit?: { hash: string; subject: string; author: string; date: string } | null;
  github?: { owner: string; repo: string; repoUrl: string; branchUrl: string | null; compareUrl: string | null } | null };
export type WireChange = { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; added: number | null; removed: number | null; from?: string };
export type WireChanges = { branch: string | null; truncated: boolean; notGit: boolean; changes: WireChange[] };
export type WireDiff = { path: string; diff: string; truncated: boolean; binary: boolean; hidden: boolean };
export type WireEntry = { name: string; kind: 'dir' | 'file'; size: number | null };
export type WireTree = { path: string; truncated: boolean; entries: WireEntry[] };
export type WireFile = { path: string; text: string | null; size: number; binary: boolean; hidden: boolean; truncated: boolean };
export function panePath(id: string, kind: 'diff' | 'tree' | 'file', rel?: string): string;
export const TRANSCRIBE_PATH: '/api/chat/transcribe';
export const MAX_AUDIO_CHARS: number;
export const STT_LANGUAGES: readonly ['auto', 'ar', 'en', 'de'];
export const MAX_MESSAGE: number;
export const MAX_TITLE: number;
export const RUN_STREAM_MS: number;
export const RUN_IDLE_MS: number;
export const RUN_FRAME_BYTES: number;
export function validRunId(x: unknown): x is string;
export type ConversationPath =
  | { kind: 'list' | 'projects' | 'transcribe' | 'approval' } | { kind: 'one' | 'messages' | 'runs' | 'project' | 'project-git'; id: string }
  | { kind: 'events'; run: string; after: number } | { kind: 'stop'; run: string }
  | { kind: 'project-changes'; id: string } | { kind: 'project-diff' | 'project-tree' | 'project-file'; id: string; rel: string };
export function conversationPath(path: string): ConversationPath | null;
export function conversationRoute(path: string): boolean;
export function allowedConversation(method: string, path: string, body?: unknown): boolean;
export function conversationResponse(path: string, status: number, body: unknown): unknown;

export type WireConversation = { id: string; title: string | null; agentId: string | null; projectId: string | null; pinned: boolean; preview: string; createdAt: string; updatedAt: string };
export type WireToolCall = { id: string; name: string; input: string; output?: string; isError?: boolean; ms?: number };
export type WirePart = { kind: 'text'; text: string } | { kind: 'reasoning'; text: string; ms?: number } | { kind: 'tools'; step: number; calls: WireToolCall[] };
export type WireMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; parts: WirePart[] | null; status: 'complete' | 'stopped' | 'error'; runId: string | null; durationMs: number | null; createdAt: string; agentId?: string; code?: 'run_interrupted' };
export type RunEvent = ({ seq: number; at?: number }) & (
  | { type: 'text' | 'reasoning'; content: string }
  | { type: 'tool_start'; step: number; tools: { id: string; name: string; input: string }[] }
  | { type: 'tool_result'; step: number; results: { id: string; name: string; output: string; isError: boolean; ms?: number }[] }
  | { type: 'end'; status: 'complete' | 'stopped' | 'error'; ms: number; code?: 'model_unavailable' | 'lmstudio_not_running' });
export function projectRunEvent(x: unknown): RunEvent | undefined;
export class RunEventParser {
  constructor(after?: number);
  last: number;
  ended: boolean;
  push(bytes: Uint8Array): RunEvent[];
  finish(): void;
}
