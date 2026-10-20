/**
 * Graph extraction for one memory (CORE-MEM-GRAPH).
 *
 * The local model (llm/model-call.ts: local Ollama chat model, installed
 * model resolved by resolveLocalModel; never a paid provider) names the
 * entities and typed links of the memory as JSON. When no model answers, or
 * its answer holds nothing usable, a deterministic fallback reads the same
 * from the text: capitalized names, a few verb patterns per link type
 * (English, Arabic, German) and the memory's project drawer.
 *
 * Both outputs pass `sanitizeExtraction`: known kinds and link types only,
 * every entity name must occur in the memory text (no invented entities),
 * every link must join two listed entities, sizes capped.
 */

import { modelCall } from '../../llm/model-call.js';
import { lexicalTokens } from '../text-normalize.js';
import type { DrawerRef } from '../drawers.js';
import {
  MAX_ALIASES,
  MAX_ENTITIES_PER_MEMORY,
  MAX_LINKS_PER_MEMORY,
  cleanName,
  containsName,
  isEntityKind,
  isLinkType,
  normalizeName,
  type EntityKind,
  type ExtractedEntity,
  type ExtractedLink,
  type GraphExtraction,
  type LinkType,
} from './types.js';

/** The owner, when a memory speaks of "the user" / "I". */
export const OWNER_ENTITY = 'Owner';

const GRAPH_PROMPT = (text: string) => `Read this memory note and list the named things in it and how they relate.
Return ONE JSON object (no markdown, no explanation):
{"entities":[{"name":"...","kind":"person|project|place|topic|agent|task|decision","aliases":["..."]}],
 "links":[{"from":"<entity name>","type":"works_on|prefers|decided|part_of|depends_on|replaces|contradicts","to":"<entity name>"}]}

Rules:
- Only names written in the note (same spelling). Use "${OWNER_ENTITY}" for the user / "I".
- kind: person, project, place, topic, agent (an AI agent), task, decision (what was decided).
- A link only when the note says it. "from" and "to" must be entity names from your list.
- Nothing to list: {"entities":[],"links":[]}

Note:
${text}`;

function parseJsonObject(raw: string): any {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

/**
 * Validate an extraction against the memory text (pure). Entities whose name
 * is not in the text are dropped (the owner entity is always allowed), kinds
 * and link types must be known, links must join listed entities.
 */
export function sanitizeExtraction(content: string, raw: { entities?: unknown; links?: unknown }, method: GraphExtraction['method']): GraphExtraction {
  const tokens = lexicalTokens(content);
  const byNorm = new Map<string, ExtractedEntity>();
  for (const e of Array.isArray(raw?.entities) ? raw.entities : []) {
    const name = cleanName((e as any)?.name);
    const norm = normalizeName(name);
    if (!norm) continue;
    const owner = name === OWNER_ENTITY;
    if (!owner && !containsName(tokens, norm)) continue;
    const kind: EntityKind = owner ? 'person' : isEntityKind((e as any)?.kind) ? (e as any).kind : 'topic';
    const aliases = (Array.isArray((e as any)?.aliases) ? (e as any).aliases : [])
      .map(cleanName).filter((a: string) => a && normalizeName(a) && normalizeName(a) !== norm).slice(0, MAX_ALIASES);
    const prev = byNorm.get(norm);
    if (prev) {
      if (prev.kind === 'topic' && kind !== 'topic') prev.kind = kind;
      prev.aliases = [...new Set([...(prev.aliases || []), ...aliases])].slice(0, MAX_ALIASES);
      continue;
    }
    if (byNorm.size >= MAX_ENTITIES_PER_MEMORY) continue;
    byNorm.set(norm, { name, kind, ...(aliases.length ? { aliases } : {}) });
  }
  const resolve = (name: unknown): string | null => {
    const norm = normalizeName(cleanName(name));
    if (byNorm.has(norm)) return byNorm.get(norm)!.name;
    for (const [n, e] of byNorm) if ((e.aliases || []).some((a) => normalizeName(a) === norm) && n) return e.name;
    return null;
  };
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(raw?.links) ? raw.links : []) {
    if (!isLinkType((l as any)?.type)) continue;
    const from = resolve((l as any)?.from);
    const to = resolve((l as any)?.to);
    if (!from || !to || normalizeName(from) === normalizeName(to)) continue;
    const key = `${normalizeName(from)}|${(l as any).type}|${normalizeName(to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ from, type: (l as any).type as LinkType, to });
    if (links.length >= MAX_LINKS_PER_MEMORY) break;
  }
  return { entities: [...byNorm.values()], links, method };
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

/** Verb patterns per link type; the subject is before, the object after. */
const LINK_PATTERNS: Array<[LinkType, RegExp]> = [
  ['works_on', /\b(?:works|working|worked|work) on\b|\b(?:leads|is leading|builds|is building|manages|maintains|owns)\b|يعمل على|تعمل على|يشتغل على|تشتغل على|\barbeitet an\b/iu],
  ['prefers', /\b(?:prefers|preferred|likes|loves|prefer)\b|يفضل|تفضل|يحب|تحب|\b(?:bevorzugt|mag)\b/iu],
  ['decided', /\b(?:decided|has decided|decides)(?: to| on| that)?\b|قرر|قررت|قررنا|\b(?:entschied|hat entschieden)\b/iu],
  ['part_of', /\b(?:is part of|are part of|is a part of|belongs to|is in the)\b|جزء من|ينتمي إلى|\b(?:gehört zu|ist teil von)\b/iu],
  ['depends_on', /\b(?:depends on|depend on|relies on|rely on|requires|is blocked by)\b|يعتمد على|تعتمد على|\b(?:basiert auf|braucht)\b/iu],
  ['replaces', /\b(?:replaces|replaced|supersedes|is replacing)\b|يستبدل|بدلا من|\bersetzt\b/iu],
  ['contradicts', /\b(?:contradicts|conflicts with|is against)\b|يناقض|يتعارض مع|\bwiderspricht\b/iu],
];

const OWNER_WORDS = /^(?:i|me|we|user|the user|owner|the owner|mohamed's owner|انا|أنا|المستخدم|المالك|ich)$/iu;
/** Capitalized words that start sentences without naming anything. */
const STARTER_WORDS = new Set(['today', 'tomorrow', 'yesterday', 'also', 'then', 'please', 'every', 'always', 'never', 'after', 'before', 'next', 'last', 'remember', 'note']);
const CAP_WORD = "\\p{Lu}[\\p{L}\\p{N}'’&.-]*";
const CAP_PHRASE = new RegExp(`${CAP_WORD}(?:\\s+(?:of\\s+|de\\s+|von\\s+)?${CAP_WORD}){0,4}`, 'gu');
const STOP_TAIL = /\s+(?:with|and|for|by|in|at|from|since|until|because|while|when|to|on|every|each|و|مع|في|من|منذ|لان|mit|und|für|seit|weil)\s.*$/iu;
const ARABIC_LETTER = /[؀-ۿ]/;
const PLACE_BEFORE = /\b(?:in|at|from|near|lives in|based in)\s*$|في\s*$|\b(?:in|aus|bei)\s*$/iu;
/** "in March", "on Fridays": a time, not a place. */
const TIME_WORD = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januar|februar|märz|mai|juni|juli|oktober|dezember|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|(?:mon|diens|donners|frei|sams|sonn)tag|mittwoch|q[1-4])$/iu;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?؟؛;])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
}

/** Capitalized phrases of a sentence (with their start offsets). */
function capitalized(sentence: string): Array<{ name: string; index: number }> {
  const out: Array<{ name: string; index: number }> = [];
  for (const m of sentence.matchAll(CAP_PHRASE)) {
    const phrase = m[0].replace(/[.'’-]+$/u, '');
    let name = phrase;
    let index = m.index ?? 0;
    // A sentence-initial article or starter word is not part of the name.
    if (index === 0) {
      const words = name.split(/\s+/);
      while (words.length && (lexicalTokens(words[0]).length === 0 || STARTER_WORDS.has(words[0].toLowerCase()))) words.shift();
      name = words.join(' ');
      index += phrase.length - name.length;
    }
    if (name && normalizeName(name)) out.push({ name, index });
  }
  return out;
}

/** Subject of a link: the last capitalized phrase, or the last 1-2 words (Arabic / owner words). */
function subjectOf(left: string): string | null {
  const l = left.replace(/[,:;]+\s*$/u, '').trim();
  if (!l) return null;
  const words = l.split(/\s+/);
  const last1 = words[words.length - 1];
  const last2 = words.slice(-2).join(' ');
  if (OWNER_WORDS.test(last2)) return OWNER_ENTITY;
  if (OWNER_WORDS.test(last1)) return OWNER_ENTITY;
  const caps = capitalized(l);
  const lastCap = caps[caps.length - 1];
  if (lastCap && lastCap.index + lastCap.name.length >= l.length - 1) return lastCap.name;
  if (ARABIC_LETTER.test(last1)) return words.slice(-Math.min(2, words.length)).join(' ').replace(/^(?:و|ف)(?=\S{3})/u, '');
  return null;
}

/** Object of a link: a leading capitalized phrase, else up to 4 words before a stop word. */
function objectOf(right: string): string | null {
  let r = right.replace(/^[\s,:]+/u, '').replace(/^(?:to|that|on|the|a|an|using|use of)\s+/iu, '');
  r = r.split(/[,;:()!?.؟]/u)[0].trim();
  if (!r) return null;
  const caps = capitalized(r);
  if (caps[0] && caps[0].index === 0) return caps[0].name;
  r = r.replace(STOP_TAIL, '');
  const words = r.split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length ? words.join(' ') : null;
}

const SUBJECT_KIND: Partial<Record<LinkType, EntityKind>> = { works_on: 'person', prefers: 'person', decided: 'person' };
const OBJECT_KIND: Partial<Record<LinkType, EntityKind>> = { works_on: 'project', decided: 'decision', prefers: 'topic' };

/** Deterministic extraction (pure): names, verb patterns, project drawer. */
export function fallbackExtraction(content: string, drawer?: DrawerRef | null): GraphExtraction {
  const entities: ExtractedEntity[] = [];
  const add = (name: string, kind: EntityKind) => {
    const norm = normalizeName(name);
    if (!norm) return;
    const prev = entities.find((e) => normalizeName(e.name) === norm);
    if (prev) { if (prev.kind === 'topic' && kind !== 'topic') prev.kind = kind; return; }
    entities.push({ name, kind });
  };
  const links: ExtractedLink[] = [];
  for (const s of sentences(content)) {
    for (const [type, re] of LINK_PATTERNS) {
      const m = re.exec(s);
      if (!m) continue;
      const from = subjectOf(s.slice(0, m.index));
      const to = objectOf(s.slice(m.index + m[0].length));
      if (!from || !to) continue;
      add(from, from === OWNER_ENTITY ? 'person' : SUBJECT_KIND[type] ?? 'topic');
      add(to, /^project\b/i.test(to) ? 'project' : OBJECT_KIND[type] ?? 'topic');
      links.push({ from, type, to });
    }
    for (const c of capitalized(s)) {
      if (TIME_WORD.test(c.name)) continue;
      const before = s.slice(0, c.index);
      add(c.name, /^project\b/i.test(c.name) ? 'project' : PLACE_BEFORE.test(before) ? 'place' : 'topic');
    }
  }
  // A memory in a project drawer is about that project.
  if (drawer?.kind === 'project' && drawer.key) {
    const keyNorm = normalizeName(drawer.key.replace(/[-_]+/g, ' '));
    const named = entities.find((e) => e.kind === 'project' && containsName(normalizeName(e.name).split(' '), keyNorm));
    if (named) named.aliases = [drawer.key];
    else if (keyNorm) entities.push({ name: drawer.key, kind: 'project' });
  }
  // The drawer key is not in the text: keep it out of the text check.
  const drawerEntity = drawer?.kind === 'project' && drawer.key ? entities.find((e) => e.name === drawer.key) : undefined;
  const checked = sanitizeExtraction(content, { entities: entities.filter((e) => e !== drawerEntity), links }, 'fallback');
  if (drawerEntity && !checked.entities.some((e) => normalizeName(e.name) === normalizeName(drawerEntity.name))) {
    checked.entities.push(drawerEntity);
  }
  return checked;
}

/** Turn off the model step (tests, or an owner who wants no background model calls). */
function modelDisabled(): boolean {
  return /^(?:0|off|false|no)$/i.test(process.env.MEMORY_GRAPH_MODEL || '');
}

/**
 * Entities and links of a memory: the local model first, the deterministic
 * fallback when no model answers or its answer holds no entity. Never throws.
 */
export async function extractGraph(content: string, opts: { userId: string; drawer?: DrawerRef | null }): Promise<GraphExtraction> {
  const text = String(content || '').slice(0, 4000);
  if (!text.trim()) return { entities: [], links: [], method: 'fallback' };
  if (!modelDisabled()) {
    try {
      const r = await modelCall({ actor: opts.userId }, {
        purpose: 'memory_graph', prompt: GRAPH_PROMPT(text), maxOutputTokens: 800, temperature: 0, timeoutMs: 45_000,
      });
      if (r.ok) {
        const parsed = parseJsonObject(r.text);
        const out = parsed ? sanitizeExtraction(text, parsed, 'model') : null;
        if (out && out.entities.length) {
          // The project drawer still names the project (the model cannot see it).
          const fb = fallbackExtraction('', opts.drawer);
          for (const e of fb.entities) if (!out.entities.some((x) => normalizeName(x.name) === normalizeName(e.name))) out.entities.push(e);
          return out;
        }
      }
    } catch { /* fall through to the rules */ }
  }
  return fallbackExtraction(text, opts.drawer);
}
