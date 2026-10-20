/**
 * Stable topic keys (CORE-MEM-TOPIC).
 *
 * A memory may carry a topic key ("favorite-editor", "project-alpha-status").
 * Within one user and one drawer a key names at most one memory (unique
 * index, migration 096): saving the same topic again updates that memory as
 * a new version (memory_versions) instead of adding a near-duplicate.
 *
 * Keys are lower case letters/digits of any script with `-` between words,
 * 1-80 characters. `suggestTopicKey` turns a title into one; `normalizeTopicKey`
 * accepts a key the caller typed in any case/spacing and returns the canonical
 * form (or null when nothing usable is left). Pure functions.
 */

import { normalizeArabicLetters } from './text-normalize.js';

export const MAX_TOPIC_KEY = 80;
const TOPIC_KEY = /^[\p{L}\p{N}]+(-[\p{L}\p{N}]+)*$/u;

export class TopicKeyError extends Error {}

/** Canonical key for a title or a typed key, or null when it has no letters/digits. */
export function suggestTopicKey(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const key = normalizeArabicLetters(title)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TOPIC_KEY)
    .replace(/-+$/g, '');
  return key && TOPIC_KEY.test(key) ? key : null;
}

/** True for a key already in canonical form. */
export function isTopicKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TOPIC_KEY && TOPIC_KEY.test(value);
}

/**
 * Optional input: absent/null/'' -> null; otherwise the canonical key.
 * Throws TopicKeyError for a non-string, an over-long input or one with no
 * letters/digits.
 */
export function normalizeTopicKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200) throw new TopicKeyError('Invalid topic key');
  const key = suggestTopicKey(value);
  if (!key) throw new TopicKeyError('Invalid topic key');
  return key;
}
