/**
 * Memory knowledge graph (CORE-MEM-GRAPH). See types.ts (model), extract.ts
 * (local model + deterministic fallback), store.ts (incremental writes,
 * forget, orphans, link review), recall.ts (graph recall merged with the
 * hybrid search), read.ts (owner graph view and the memory_graph tool).
 */

export * from './types.js';
export { extractGraph, fallbackExtraction, sanitizeExtraction, OWNER_ENTITY } from './extract.js';
export {
  decideLink,
  forgetMemoryGraphStep,
  graphIdle,
  indexMemoryGraph,
  onMemorySaved,
  pruneGraphStep,
  syncMemoryGraph,
} from './store.js';
export { graphRecall, mergeRecall, withGraphRecall, entitiesNamedIn, expandEntities, type GraphScope } from './recall.js';
export { entityDetail, entityTimeline, findEntity, listEntities, listLinks, memoryEntities, type GraphEntity, type GraphLink, type MemoryEntities, type TimelineEntry } from './read.js';
