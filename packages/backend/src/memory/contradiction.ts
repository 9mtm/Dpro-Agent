/**
 * Contradiction check between two memory texts (CORE-MEM-CONFLICT). Pure.
 *
 * Two texts contradict when they talk about the same thing (their content
 * words, without negation and polarity words, overlap: Jaccard >= 0.6) and
 * exactly one of these holds:
 *
 *   negation  one side is negated and the other is not
 *             ("User likes tea" / "User does not like tea", "لا يحب الشاي")
 *   opposite  the sides use opposite words of one pair
 *             (like/dislike, enabled/disabled, always/never, true/false ...)
 *
 * A negated opposite agrees ("does not like" = "dislikes"), so both together
 * cancel out. English, German and Arabic words; Arabic text is normalized
 * first (text-normalize.ts). A plain value change ("blue" -> "green") is not
 * reported here: for a topic key it is the normal evolution of the memory,
 * and the learning classifier has its own close-but-different rule.
 */

import { lexicalTokens, normalizeArabicLetters } from './text-normalize.js';

export type ContradictionKind = 'negation' | 'opposite';

/** Content-word overlap at or above this means "the same subject". */
export const SAME_SUBJECT_JACCARD = 0.6;
/** Only the start of long texts is compared. */
const MAX_WORDS = 400;

const NEGATIONS = new Set([
  'not', 'no', 'never', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'wont', 'cant', 'cannot',
  'nicht', 'kein', 'keine', 'keinen', 'keiner', 'nie', 'niemals',
  'لا', 'لم', 'لن', 'ليس', 'ليست', 'مو', 'مش', 'ما', 'ماكو',
]);

/** Opposite word pairs: [positive forms, negative forms]. */
const OPPOSITES: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [['like', 'likes', 'liked', 'love', 'loves', 'loved', 'enjoy', 'enjoys'], ['dislike', 'dislikes', 'disliked', 'hate', 'hates', 'hated']],
  [['true'], ['false']],
  [['on'], ['off']],
  [['enabled', 'enable', 'active', 'activated'], ['disabled', 'disable', 'inactive', 'deactivated']],
  [['allowed', 'allow', 'allows', 'permitted'], ['denied', 'deny', 'forbidden', 'blocked', 'disallowed']],
  [['accepted', 'accept', 'approved'], ['rejected', 'reject', 'declined']],
  [['open', 'opened'], ['closed']],
  [['available'], ['unavailable']],
  [['يحب', 'احب', 'نحب', 'تحب', 'يحبون'], ['يكره', 'اكره', 'نكره', 'تكره', 'يكرهون']],
  [['mag', 'liebt', 'liebe', 'gerne'], ['hasst', 'hasse']],
  [['ja'], ['nein']],
];
// "never" / "nie" are negations, so "always" vs "never" is covered there.

const PAIR_WORDS = new Set(OPPOSITES.flatMap(([a, b]) => [...a, ...b]));

function words(text: string): string[] {
  return normalizeArabicLetters(String(text ?? ''))
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

/** -1 / 0 / +1 per opposite pair. */
function polarity(ws: readonly string[]): number[] {
  return OPPOSITES.map(([pos, neg]) => (ws.some((w) => pos.includes(w)) ? 1 : ws.some((w) => neg.includes(w)) ? -1 : 0));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

function subject(ws: readonly string[]): Set<string> {
  return new Set(lexicalTokens(ws.filter((w) => !NEGATIONS.has(w) && !PAIR_WORDS.has(w)).join(' ')));
}

/** How `next` contradicts `prev`, or null when it does not. */
export function detectContradiction(prev: string, next: string): ContradictionKind | null {
  const a = words(prev);
  const b = words(next);
  if (jaccard(subject(a), subject(b)) < SAME_SUBJECT_JACCARD) return null;
  const negated = a.some((w) => NEGATIONS.has(w)) !== b.some((w) => NEGATIONS.has(w));
  const pa = polarity(a);
  const pb = polarity(b);
  const opposite = pa.some((p, i) => p !== 0 && pb[i] !== 0 && p !== pb[i]);
  if (negated === opposite) return null;
  return negated ? 'negation' : 'opposite';
}
