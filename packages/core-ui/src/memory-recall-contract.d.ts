export const MAX_CORRECTION: number;
export type RecallReason = 'pinned' | 'topic' | 'graph' | 'meaning' | 'keyword' | 'handoff';
export const RECALL_REASONS: readonly RecallReason[];
export type RecallState = 'active' | 'changed' | 'moved' | 'deleted' | 'forgotten';
export const RECALL_STATES: readonly RecallState[];
export type SummarySource = 'model' | 'fallback' | 'inline';
export const SUMMARY_SOURCES: readonly SummarySource[];
export const CACHE_METRICS_PATH: string;
export type RecallItem = {
  kind: 'memory' | 'handoff'; id: string; drawer: string | null; why: RecallReason; state: RecallState;
  score?: number; type?: string; preview?: string; nowIn?: string;
};
export type RecallTrace = {
  runId: string; messageId: string | null; agentId: string | null; createdAt: string; items: RecallItem[];
  context: {
    keptTurns: number; summarisedTurns: number; droppedTurns: number;
    summaries: Array<{ id: string; turns: number; source: SummarySource }>;
    fromCache: { pack: boolean; recall: boolean };
    budgetTokens: number; numCtx: number; packChars: number; promptTokens: number; ttftMs: number | null;
  };
};
export type CacheCounter = { hits: number; misses: number; hitRate: number | null };
export type CacheMetrics = {
  process: {
    since: string;
    caches: { pack: CacheCounter; recall: CacheCounter; embedding: CacheCounter };
    packChars: { last: number | null; avg: number | null; samples: number };
    ttftMs: { last: number | null; p50: number | null; p90: number | null; samples: number };
  };
  recent: { turns: number; packHitRate: number | null; avgPackChars: number | null; avgPromptTokens: number | null; ttftMs: { p50: number | null; p90: number | null } };
  budget: { numCtx: number; promptTokens: number; summaryTokens: number; keepAlive: string };
};
export type TurnSummary = { id: string; level: number; firstTurn: number; lastTurn: number; turns: number; text: string; source: SummarySource; createdAt: string };
export function recallMessagePath(id: string): string;
export function recallRunPath(id: string): string;
export function recallCorrectPath(id: string): string;
export function recallForgetPath(id: string): string;
export function conversationSummariesPath(id: string): string;
export function memoryMovePath(id: string): string;
export function memoryRecallPath(path: string): { route: 'metrics' | 'message' | 'correct' | 'forget' | 'run' | 'summaries' | 'move'; id?: string } | null;
export function memoryRecallRoute(path: string): boolean;
export function allowedMemoryRecall(method: string, path: string, body?: unknown): boolean;
export function memoryRecallResponse(path: string, status: number, body: unknown): unknown;
