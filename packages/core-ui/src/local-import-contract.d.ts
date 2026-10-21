export type LocalSource = 'claude-code' | 'codex' | 'antigravity' | 'gemini-cli';
export const LOCAL_SOURCES: readonly LocalSource[];
/** `root`: the project folder the conversation belongs to; `project`: where its project facts go (`linked`: one of the owner's Dpro projects; else a project drawer named after the folder); `turns` is null when only the start of a large log was read. */
export type LocalSession = { id: string; source: LocalSource; cwd: string | null; root: string | null; rootName: string | null; project: { slug: string; name: string; linked: boolean } | null; title: string; startedAt: string | null; updatedAt: string; bytes: number; turns: number | null; imported: { importedAt: string; proposed: number } | null };
export type ImportJob = { id: string; total: number; done: number; proposed: number; errors: number; status: 'running' | 'done' | 'error' | 'paused'; notice: string | null; automatic?: boolean };
export const LOCAL_IMPORT_PATH: '/api/memory/import/local';
export const MAX_IMPORT_SESSIONS: number;
export const MAX_LISTED_SESSIONS: number;
export function localImportPath(path: string): { kind: 'local' | 'documents' | 'automatic' } | { kind: 'job' | 'resume' | 'pause' | 'preview' | 'document'; id: string } | null;
export function localImportRoute(path: string): boolean;
export function allowedLocalImport(method: string, path: string, body?: unknown): boolean;
export function localImportResponse(path: string, status: number, body: unknown): unknown;
