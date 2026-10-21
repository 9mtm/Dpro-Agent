/**
 * Memory System Types
 * Enhanced memory architecture with temporal layers and relationships
 */

import { dataPathOr } from '../config/data-root.js';

// ============ Core Types ============

/** Memory entry type */
export type MemoryType =
  | 'fact'        // Permanent facts (user name, preferences)
  | 'event'       // Time-bound events (meetings, deadlines)
  | 'context'     // Conversation context
  | 'insight'     // Derived insights
  | 'preference'  // User preferences
  | 'skill'       // Learned skills/patterns
  | 'relationship' // Entity relationships
  | 'task';       // User tasks and todos

/** Every valid MemoryType (used to validate API input; the type is part of a file name). */
export const MEMORY_TYPES: readonly MemoryType[] = [
  'fact', 'event', 'context', 'insight', 'preference', 'skill', 'relationship', 'task'
];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** Memory temporal layer (legacy) */
export type MemoryLayer =
  | 'session'     // Current session (volatile)
  | 'daily'       // Today's memories
  | 'weekly'      // This week's memories
  | 'archive';    // Long-term storage

/** Multi-Tier Memory Layer (new system) */
export type MultiTierLayer =
  | 'working'      // Temporary, current session only
  | 'experiential' // Medium-term learned patterns
  | 'factual';     // Permanent verified knowledge

/** Consolidation status for experiential memories */
export type ConsolidationStatus =
  | 'pending'      // Not yet consolidated
  | 'consolidated' // Processed by consolidation
  | 'promoted';    // Promoted to higher tier

/** Memory importance level (1-10) */
export type ImportanceLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Memory status */
export type MemoryStatus = 'active' | 'decaying' | 'archived' | 'deleted';

// ============ Memory Structure ============

/** Core memory entry */
export interface Memory {
  /** Unique identifier */
  id: string;
  /** User/agent ID this memory belongs to */
  userId: string;
  /** Memory type */
  type: MemoryType;
  /** Main content */
  content: string;
  /** Summary for quick access */
  summary?: string;
  /** Vector embedding */
  embedding?: number[];
  /** Model id of `embedding` (CORE-06), e.g. `ollama:qwen3-embedding:0.6b`, `hash-v2` */
  embeddingModel?: string;
  /** Current temporal layer (legacy) */
  layer?: MemoryLayer;
  /** Multi-Tier Memory Layer (new system) */
  memoryLayer?: MultiTierLayer;
  /** Importance score (1-10, legacy) */
  importance?: ImportanceLevel;
  /** Importance score (0-1, new system) */
  importanceScore?: number;
  /** Original importance (before decay) */
  originalImportance?: ImportanceLevel;
  /** Status */
  status: MemoryStatus;
  /** Creation timestamp */
  createdAt: Date;
  /** Last accessed (legacy) */
  lastAccessed?: Date;
  /** Last accessed timestamp (new system, Unix epoch ms) */
  lastAccessedAt?: number | null;
  /** Access count */
  accessCount: number;
  /** Decay factor (0-1, lower = more decay) */
  decayFactor?: number;
  /** Related memory IDs */
  relatedMemories?: string[];
  /** Tags for categorization */
  tags?: string[];
  /** Source (session ID, file, etc.) */
  source?: string;
  /** Expires at (legacy) */
  expiresAt?: Date;
  /** Expiry timestamp (new system, Unix epoch ms) */
  expiryTimestamp?: number | null;
  /** Consolidation status (new system) */
  consolidationStatus?: ConsolidationStatus;
  /** Custom metadata */
  metadata: Record<string, unknown>;
  /** Drawer this memory belongs to (CORE-03); default by type when absent. */
  drawer?: import('./drawers.js').DrawerRef;
  /** Stable topic key (CORE-MEM-TOPIC): unique per user + drawer; null/absent = none. */
  topicKey?: string | null;
  /** agents_config.id of the agent whose run saved it (set on insert only, MEM-GAPS-02); null = not an agent. */
  sourceAgentId?: string | null;
}

/** Memory relationship */
export interface MemoryRelation {
  /** Source memory ID */
  sourceId: string;
  /** Target memory ID */
  targetId: string;
  /** Relationship type */
  type: 'similar' | 'related' | 'contradicts' | 'supports' | 'follows';
  /** Relationship strength (0-1) */
  strength: number;
  /** Created at */
  createdAt: Date;
}

/** Daily journal entry */
export interface DailyJournal {
  /** Date (YYYY-MM-DD) */
  date: string;
  /** User ID */
  userId: string;
  /** Summary of the day */
  summary: string;
  /** Key events */
  events: string[];
  /** Key decisions */
  decisions: string[];
  /** Key learnings */
  learnings: string[];
  /** Mood/sentiment score (-1 to 1) */
  sentiment?: number;
  /** Memory IDs from this day */
  memoryIds: string[];
  /** Created at */
  createdAt: Date;
  /** Updated at */
  updatedAt: Date;
}

// ============ Search Types ============

/** Memory search query */
export interface MemorySearchQuery {
  /** Search text */
  query: string;
  /** User ID to search within */
  userId: string;
  /** Filter by memory types */
  types?: MemoryType[];
  /** Filter by layers (legacy) */
  layers?: MemoryLayer[];
  /** Filter by Multi-Tier Memory layer (new system) */
  layer?: MultiTierLayer;
  /** Filter by tags */
  tags?: string[];
  /** Minimum importance (legacy) */
  minImportance?: ImportanceLevel;
  /** Minimum importance score (new system, 0-1) */
  minImportanceScore?: number;
  /** Date range start */
  fromDate?: Date;
  /** Date range end */
  toDate?: Date;
  /** Maximum results */
  limit?: number;
  /** Include related memories */
  includeRelated?: boolean;
  /** Search mode */
  mode?: 'semantic' | 'keyword' | 'hybrid';
  /** Boost recent memories */
  recencyBoost?: boolean;
  /** Legacy: single type filter */
  type?: MemoryType;
  /** Only these drawers (CORE-03). Absent = all of the user's drawers; [] = none. */
  drawers?: import('./drawers.js').DrawerRef[];
}

/** Memory search result */
export interface MemorySearchResult {
  /** The memory */
  memory: Memory;
  /** Similarity/relevance score (0-1) */
  similarity: number;
  /** Score breakdown */
  scoreBreakdown?: {
    vectorScore: number;
    keywordScore: number;
    recencyScore: number;
    importanceScore: number;
  };
  /** Matching snippet */
  snippet?: string;
  /** Highlight positions */
  highlights?: Array<{ start: number; end: number }>;
  /** Related memories if requested */
  relatedMemories?: Memory[];
}

// ============ Index Types ============

/** Memory chunk for indexing */
export interface MemoryChunk {
  /** Chunk ID */
  id: string;
  /** Parent memory ID */
  memoryId: string;
  /** Chunk content */
  content: string;
  /** Chunk embedding */
  embedding: number[];
  /** Position in original content */
  position: number;
  /** Character offset start */
  offsetStart: number;
  /** Character offset end */
  offsetEnd: number;
}

/** Index statistics */
export interface IndexStats {
  /** Total memories */
  totalMemories: number;
  /** Total chunks */
  totalChunks: number;
  /** Index size (bytes) */
  indexSize: number;
  /** Last sync time */
  lastSync: Date;
  /** Pending updates */
  pendingUpdates: number;
}

// ============ Configuration ============

/** Memory system configuration */
export interface MemoryConfig {
  /** Storage directory for markdown files */
  storageDir: string;
  /** Database path */
  dbPath: string;
  /** Embedding provider */
  embeddingProvider: 'local' | 'openai' | 'ollama';
  /** Embedding model */
  embeddingModel?: string;
  /** Chunk size (tokens) */
  chunkSize: number;
  /** Chunk overlap (tokens) */
  chunkOverlap: number;
  /** Enable decay */
  enableDecay: boolean;
  /** Decay rate per day (0-1) */
  decayRate: number;
  /** Minimum importance before archiving */
  archiveThreshold: ImportanceLevel;
  /** Days before moving to weekly */
  dailyRetention: number;
  /** Days before moving to archive */
  weeklyRetention: number;
  /** Enable auto-consolidation */
  enableConsolidation: boolean;
  /** Similarity threshold for consolidation */
  consolidationThreshold: number;
  /** Maximum search results */
  maxSearchResults: number;
  /** Search weights */
  searchWeights: {
    vector: number;
    keyword: number;
    recency: number;
    importance: number;
  };
}

/** Default memory configuration */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  storageDir: dataPathOr('./.data/memory', 'memory'),
  dbPath: dataPathOr('./.data/memory/memory.db', 'memory', 'memory.db'),
  embeddingProvider: 'local',
  chunkSize: 400,
  chunkOverlap: 80,
  enableDecay: true,
  decayRate: 0.05, // 5% per day
  archiveThreshold: 3,
  dailyRetention: 7,
  weeklyRetention: 30,
  enableConsolidation: true,
  consolidationThreshold: 0.85,
  maxSearchResults: 10,
  searchWeights: {
    vector: 0.4,
    keyword: 0.25,
    recency: 0.2,
    importance: 0.15,
  },
};

// ============ Interfaces ============

/** Memory storage interface */
export interface IMemoryStorage {
  initialize(): Promise<void>;
  save(memory: Memory): Promise<void>;
  get(id: string): Promise<Memory | null>;
  getByUser(userId: string, layer?: string): Promise<Memory[]>;
  update(id: string, updates: Partial<Memory>): Promise<void>;
  delete(id: string): Promise<void>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
}

/** Memory retrieval interface */
export interface IMemoryRetrieval {
  findRelevant(query: string, userId: string, limit?: number): Promise<Memory[]>;
  extractMemories(text: string, userId: string): Promise<Memory[]>;
}

/** Embedding service interface */
export interface IEmbeddingService {
  embed(text: string): Promise<number[]>;
  similarity(embedding1: number[], embedding2: number[]): number;
}

/** Memory extraction result */
export interface MemoryExtractionResult {
  type: MemoryType;
  content: string;
  importance: ImportanceLevel;
  metadata: Record<string, unknown>;
}

/** Memory indexer interface */
export interface IMemoryIndexer {
  index(memory: Memory): Promise<void>;
  remove(memoryId: string): Promise<void>;
  search(query: string, embedding: number[], limit: number): Promise<MemorySearchResult[]>;
  sync(): Promise<void>;
  getStats(): IndexStats;
}

/** Memory consolidator interface */
export interface IMemoryConsolidator {
  findSimilar(memory: Memory, threshold: number): Promise<Memory[]>;
  merge(memories: Memory[]): Promise<Memory>;
  consolidate(userId: string): Promise<number>;
}

/** Memory decay manager interface */
export interface IMemoryDecayManager {
  applyDecay(userId: string): Promise<number>;
  refreshMemory(memoryId: string): Promise<void>;
  archiveOldMemories(userId: string): Promise<number>;
}
