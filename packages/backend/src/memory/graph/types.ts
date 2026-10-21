/**
 * Memory knowledge graph (CORE-MEM-GRAPH): shared types, limits and the
 * name normalization every part of the graph uses.
 *
 * Entities are things named in a user's memories; typed links join two
 * entities; every memory is attached to the entities it names. Plain SQLite /
 * PostgreSQL tables (migrations 100-102), per user, like memory itself.
 */

import { lexicalTokens } from '../text-normalize.js';

export const ENTITY_KINDS = ['person', 'project', 'place', 'topic', 'agent', 'task', 'decision'] as const;
export type EntityKind = typeof ENTITY_KINDS[number];

export const LINK_TYPES = ['works_on', 'prefers', 'decided', 'part_of', 'depends_on', 'replaces', 'contradicts'] as const;
export type LinkType = typeof LINK_TYPES[number];

export type LinkStatus = 'active' | 'pending' | 'rejected';

/**
 * Link types that are important like important memories (CORE-05): a
 * preference, a standing decision, a replacement or a contradiction. A new
 * one learned from a memory the owner has not seen waits for the owner.
 */
export const IMPORTANT_LINK_TYPES: ReadonlySet<LinkType> = new Set(['prefers', 'decided', 'replaces', 'contradicts']);

/** At most this many entities / links are taken from one memory. */
export const MAX_ENTITIES_PER_MEMORY = 12;
export const MAX_LINKS_PER_MEMORY = 12;
export const MAX_NAME_LENGTH = 80;
export const MAX_ALIASES = 8;

export interface ExtractedEntity {
  name: string;
  kind: EntityKind;
  aliases?: string[];
}

export interface ExtractedLink {
  /** Entity names, as in `entities`. */
  from: string;
  type: LinkType;
  to: string;
}

export interface GraphExtraction {
  entities: ExtractedEntity[];
  links: ExtractedLink[];
  method: 'model' | 'fallback';
}

export function isEntityKind(v: unknown): v is EntityKind {
  return typeof v === 'string' && (ENTITY_KINDS as readonly string[]).includes(v);
}

export function isLinkType(v: unknown): v is LinkType {
  return typeof v === 'string' && (LINK_TYPES as readonly string[]).includes(v);
}

/**
 * Normalized name: the lexical tokens of the name (Arabic normalization,
 * Iraqi -> MSA, umlaut folding, stop words dropped, light stemming; see
 * text-normalize.ts) joined by one space. '' when nothing is left (a name
 * made only of stop words cannot be matched and is not stored).
 */
export function normalizeName(name: string): string {
  return lexicalTokens(String(name || '').slice(0, MAX_NAME_LENGTH)).join(' ');
}

/** True when the normalized name occurs as whole tokens, in order, in `tokens`. */
export function containsName(tokens: readonly string[], norm: string): boolean {
  if (!norm) return false;
  const parts = norm.split(' ');
  outer: for (let i = 0; i + parts.length <= tokens.length; i++) {
    for (let j = 0; j < parts.length; j++) if (tokens[i + j] !== parts[j]) continue outer;
    return true;
  }
  return false;
}

/** Display form of a name: trimmed, inner spaces collapsed, length-capped. */
export function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH) : '';
}
