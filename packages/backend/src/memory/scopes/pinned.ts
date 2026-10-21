/**
 * Pinned facts per scope (MEM-SCALE-01): short facts the owner pins to the
 * company, a department or a project. The context of every reply in that
 * scope loads them first (`pinnedFactsBlock`, size-limited): company facts,
 * the project's department, then the project. An archived project adds
 * nothing (its department and the company still apply). A reply only gets
 * the facts of drawers its agent may read (company: owner, department and
 * project: project).
 *
 * SECURITY: the text passes the import redactor before it is stored, so a
 * key or password is never pinned into every prompt.
 */

import { randomUUID } from 'node:crypto';
import { all, one, run, sql, type Step } from '../../repositories/sql-steps.js';
import { redactImportText } from '../import/redact.js';
import { GENERAL_DEPARTMENT, GENERAL_NAME, ScopeInputError, assertProjectSlug, departmentStep, projectStep } from './store.js';

export const PINNED_SCOPE_KINDS = ['company', 'department', 'project'] as const;
export type PinnedScopeKind = (typeof PINNED_SCOPE_KINDS)[number];
export interface PinnedScope { kind: PinnedScopeKind; id: string }

export const MAX_FACT_CHARS = 500;
export const MAX_FACTS_PER_SCOPE = 20;
/** Characters of the prompt block (company + department + project). */
export const MAX_PINNED_BLOCK_CHARS = 2000;

export interface PinnedFact { id: string; scope: string; text: string; position: number; createdBy: string | null; createdAt: string; updatedAt: string }

/** `company`, `department:<id>`, `project:<slug>`. Throws ScopeInputError. */
export function parsePinnedScope(value: unknown): PinnedScope {
  if (value === 'company') return { kind: 'company', id: '' };
  if (typeof value !== 'string' || value.length > 100) throw new ScopeInputError('Invalid scope');
  const i = value.indexOf(':');
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  if (i < 0 || !id) throw new ScopeInputError('Invalid scope');
  if (kind === 'department') return { kind, id };
  if (kind === 'project') { assertProjectSlug(id); return { kind, id }; }
  throw new ScopeInputError('Invalid scope');
}

export const pinnedScopeId = (s: PinnedScope): string => (s.kind === 'company' ? 'company' : `${s.kind}:${s.id}`);

interface Row { id: string; scope_kind: PinnedScopeKind; scope_id: string; text: string; position: number; created_by: string | null; created_at: string; updated_at: string }
const toFact = (r: Row): PinnedFact => ({
  id: r.id, scope: pinnedScopeId({ kind: r.scope_kind, id: r.scope_id }), text: r.text, position: Number(r.position),
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

function* listStep(ownerId: string, s: PinnedScope): Step<PinnedFact[]> {
  const rows = yield* all<Row>('SELECT * FROM memory_pinned_facts WHERE owner_id = ? AND scope_kind = ? AND scope_id = ? ORDER BY position, created_at, id', ownerId, s.kind, s.id);
  return rows.map(toFact);
}

export function listPinnedFacts(ownerId: string, scope: PinnedScope): Promise<PinnedFact[]> {
  return sql().read(listStep(ownerId, scope));
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') throw new ScopeInputError('The fact must be text');
  // eslint-disable-next-line no-control-regex
  const text = redactImportText(value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')).text.trim();
  if (!text) throw new ScopeInputError('The fact is empty');
  if (text.length > MAX_FACT_CHARS) throw new ScopeInputError(`A pinned fact is at most ${MAX_FACT_CHARS} characters`);
  return text;
}

function* assertScopeStep(ownerId: string, s: PinnedScope): Step<void> {
  if (s.kind === 'department' && !(yield* departmentStep(ownerId, s.id))) throw new ScopeInputError('Department not found', 404, 'not_found');
  if (s.kind === 'project' && !(yield* projectStep(ownerId, s.id))) throw new ScopeInputError('Project not found', 404, 'not_found');
}

export function addPinnedFact(ownerId: string, scope: PinnedScope, textInput: unknown, by: string): Promise<PinnedFact> {
  const text = cleanText(textInput);
  return sql().tx(function* () {
    yield* assertScopeStep(ownerId, scope);
    const stat = yield* one<{ n: number; max: number | null }>('SELECT COUNT(*) AS n, MAX(position) AS max FROM memory_pinned_facts WHERE owner_id = ? AND scope_kind = ? AND scope_id = ?', ownerId, scope.kind, scope.id);
    if (Number(stat?.n ?? 0) >= MAX_FACTS_PER_SCOPE) throw new ScopeInputError(`At most ${MAX_FACTS_PER_SCOPE} pinned facts per scope`, 409, 'too_many');
    const id = randomUUID();
    const now = new Date().toISOString();
    yield* run('INSERT INTO memory_pinned_facts (id, owner_id, scope_kind, scope_id, text, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, ownerId, scope.kind, scope.id, text, Number(stat?.max ?? -1) + 1, by, now, now);
    return toFact((yield* one<Row>('SELECT * FROM memory_pinned_facts WHERE id = ?', id))!);
  }, { immediate: true });
}

export function updatePinnedFact(ownerId: string, id: string, patch: { text?: unknown; position?: unknown }): Promise<PinnedFact> {
  const text = patch.text === undefined ? undefined : cleanText(patch.text);
  if (patch.position !== undefined && (typeof patch.position !== 'number' || !Number.isInteger(patch.position) || patch.position < 0 || patch.position > 1000)) {
    throw new ScopeInputError('position must be a whole number 0-1000');
  }
  return sql().tx(function* () {
    const row = yield* one<Row>('SELECT * FROM memory_pinned_facts WHERE owner_id = ? AND id = ?', ownerId, typeof id === 'string' ? id : '');
    if (!row) throw new ScopeInputError('Pinned fact not found', 404, 'not_found');
    yield* run('UPDATE memory_pinned_facts SET text = ?, position = ?, updated_at = ? WHERE owner_id = ? AND id = ?',
      text ?? row.text, (patch.position as number | undefined) ?? row.position, new Date().toISOString(), ownerId, id);
    return toFact((yield* one<Row>('SELECT * FROM memory_pinned_facts WHERE id = ?', id))!);
  }, { immediate: true });
}

export async function removePinnedFact(ownerId: string, id: string): Promise<PinnedFact | null> {
  return sql().tx(function* () {
    const row = yield* one<Row>('SELECT * FROM memory_pinned_facts WHERE owner_id = ? AND id = ?', ownerId, typeof id === 'string' ? id : '');
    if (!row) return null;
    yield* run('DELETE FROM memory_pinned_facts WHERE owner_id = ? AND id = ?', ownerId, id);
    return toFact(row);
  });
}

/** The pinned facts of one reply: the prompt block and which facts it holds (for the reply trace). */
export interface ReplyPinnedFacts {
  text: string;
  facts: Array<{ id: string; scope: string; updatedAt: string }>;
}

/**
 * The "Pinned facts" prompt block for a reply of this owner in this project
 * (null = no project: company facts only), or ''. Budget goes to the most
 * specific scope first (project, department, company); the block lists them
 * company first.
 */
export async function pinnedFactsBlock(ownerId: string | null | undefined, projectSlug?: string | null, allow: { company: boolean; project: boolean } = { company: true, project: true }): Promise<string> {
  return (await pinnedFactsForReply(ownerId, projectSlug, allow)).text;
}

/** pinnedFactsBlock with the facts it holds (MEM-CACHE-01 context pack and reply trace). */
export async function pinnedFactsForReply(ownerId: string | null | undefined, projectSlug?: string | null, allow: { company: boolean; project: boolean } = { company: true, project: true }): Promise<ReplyPinnedFacts> {
  if (!ownerId) return { text: '', facts: [] };
  return sql().read((function* () {
    const sections: Array<{ title: string; facts: string[] }> = [];
    const used: ReplyPinnedFacts['facts'] = [];
    // Company facts follow the owner drawer, department and project facts the project drawer.
    const company = allow.company ? yield* listStep(ownerId, { kind: 'company', id: '' }) : [];
    let dept: { title: string; facts: PinnedFact[] } | null = null;
    let project: { title: string; facts: PinnedFact[] } | null = null;
    const p = projectSlug && allow.project ? yield* projectStep(ownerId, projectSlug) : null;
    if (p && !p.archived) {
      const d = yield* departmentStep(ownerId, p.departmentId);
      dept = { title: `Department "${d?.name ?? GENERAL_NAME}"`, facts: yield* listStep(ownerId, { kind: 'department', id: d?.id ?? GENERAL_DEPARTMENT }) };
      project = { title: `Project "${p.name}"`, facts: yield* listStep(ownerId, { kind: 'project', id: p.slug }) };
    }
    let budget = MAX_PINNED_BLOCK_CHARS;
    const take = (facts: PinnedFact[]): Array<{ line: string; fact: PinnedFact }> => {
      const out: Array<{ line: string; fact: PinnedFact }> = [];
      for (const f of facts) {
        const line = `- ${f.text}`;
        if (line.length + 1 > budget) break;
        budget -= line.length + 1;
        out.push({ line, fact: f });
      }
      return out;
    };
    const projectLines = project ? take(project.facts) : [];
    const deptLines = dept ? take(dept.facts) : [];
    const companyLines = take(company);
    const add = (title: string, lines: Array<{ line: string; fact: PinnedFact }>) => {
      if (!lines.length) return;
      sections.push({ title, facts: lines.map((l) => l.line) });
      for (const l of lines) used.push({ id: l.fact.id, scope: l.fact.scope, updatedAt: l.fact.updatedAt });
    };
    add('Company', companyLines);
    if (dept) add(dept.title, deptLines);
    if (project) add(project.title, projectLines);
    if (!sections.length) return { text: '', facts: [] };
    return {
      text: ['## Pinned facts', 'The owner pinned these facts. They hold unless the owner changes them.',
        ...sections.map((s) => `${s.title}:\n${s.facts.join('\n')}`)].join('\n'),
      facts: used,
    };
  })());
}
