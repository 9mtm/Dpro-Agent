/**
 * A project's local databases (PROJECT-TECH-01), kept per project of the owner.
 *
 * "Found on this computer" reads the project's folder (discovery/project-tech.ts
 * findDatabases: metadata and SQLite table names only, never a row, never a
 * password) and hands the list here on every scan; it is stored without
 * asking, since nothing in it is data.
 *
 * Per agent and project the owner sets how much an agent sees:
 *   exists  (default) that a database is there: engine, name, place
 *   tables  + the table names
 *   data    + the agent may ask for rows; every such read asks the owner
 *           (no tool reads rows yet: the level is stored and reported)
 */

import os from 'node:os';
import path from 'node:path';
import { all, one, run, sql } from '../repositories/sql-steps.js';
import type { DatabaseFound } from '../discovery/project-tech.js';
import { ScopeInputError, assertProjectSlug, projectStep } from './scopes/store.js';

export const DB_LEVELS = ['exists', 'tables', 'data'] as const;
export type DbLevel = (typeof DB_LEVELS)[number];
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface DatabaseView {
  id: string; kind: string; engine: string; name: string; path: string;
  host?: string | null; port?: string | null; database?: string | null; service?: string; image?: string;
  tables?: string[] | null; tableCount?: number | null; tablesNote?: string; bytes?: number;
}

const homeRel = (home: string, file: string) => {
  const r = path.relative(home, file);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? `~${path.sep}${r}` : file;
};

async function requireProject(ownerId: string, slug: string): Promise<void> {
  assertProjectSlug(slug);
  if (!(await sql().read(projectStep(ownerId, slug)))) throw new ScopeInputError('Project not found', 404, 'not_found');
}

async function foundOf(ownerId: string, slug: string): Promise<{ list: DatabaseFound[]; updatedAt: string | null }> {
  const row = await sql().read(one<{ found: string; updated_at: string }>('SELECT found, updated_at FROM memory_project_databases WHERE owner_id = ? AND slug = ?', ownerId, slug));
  let list: DatabaseFound[] = [];
  try { list = row ? JSON.parse(row.found) : []; } catch { list = []; }
  return { list: Array.isArray(list) ? list : [], updatedAt: row?.updated_at ?? null };
}

/** One database as a level allows (exists: no tables; tables/data: table names). */
function shown(d: DatabaseFound, level: DbLevel, home: string): DatabaseView {
  const base: DatabaseView = {
    id: d.id, kind: d.kind, engine: d.engine, name: d.name, path: homeRel(home, d.path),
    ...(d.host !== undefined ? { host: d.host } : {}), ...(d.port !== undefined ? { port: d.port } : {}), ...(d.database !== undefined ? { database: d.database } : {}),
    ...(d.service ? { service: d.service } : {}), ...(d.image ? { image: d.image } : {}), ...(d.bytes !== undefined ? { bytes: d.bytes } : {}),
  };
  if (d.kind !== 'sqlite') return base;
  if (level === 'exists') return { ...base, tableCount: d.tables ? d.tables.length : null };
  return { ...base, tables: d.tables ?? null, tableCount: d.tables ? d.tables.length : null, ...(d.tablesNote ? { tablesNote: d.tablesNote } : {}) };
}

/** Store what discovery found (automatic; metadata only). */
export async function recordFoundDatabases(ownerId: string, slug: string, list: DatabaseFound[]): Promise<{ changed: boolean }> {
  const json = JSON.stringify(list);
  const row = await sql().read(one<{ found: string }>('SELECT found FROM memory_project_databases WHERE owner_id = ? AND slug = ?', ownerId, slug));
  if (row?.found === json) return { changed: false };
  await sql().read(run(`INSERT INTO memory_project_databases (owner_id, slug, found, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner_id, slug) DO UPDATE SET found = excluded.found, updated_at = excluded.updated_at`, ownerId, slug, json, new Date().toISOString()));
  return { changed: true };
}

/** The owner's view: every database with its table names, and each agent's level. */
export async function getDatabases(ownerId: string, slug: string, home = os.homedir()) {
  await requireProject(ownerId, slug);
  const { list, updatedAt } = await foundOf(ownerId, slug);
  const access = await sql().read(all<{ agent_id: string; level: DbLevel; updated_at: string }>('SELECT agent_id, level, updated_at FROM memory_project_db_access WHERE owner_id = ? AND slug = ? ORDER BY agent_id', ownerId, slug));
  return {
    project: slug,
    databases: list.map((d) => shown(d, 'tables', home)),
    access: access.map((a) => ({ agentId: a.agent_id, level: a.level, updatedAt: a.updated_at })),
    defaultLevel: 'exists' as DbLevel,
    updatedAt,
  };
}

/** Set one agent's level for this project (null = back to the default, exists). */
export async function setDatabaseAccess(ownerId: string, slug: string, input: { agentId?: unknown; level?: unknown }, by: string) {
  await requireProject(ownerId, slug);
  if (typeof input.agentId !== 'string' || !AGENT_ID.test(input.agentId)) throw new ScopeInputError('agentId is required');
  if (input.level !== null && !(DB_LEVELS as readonly unknown[]).includes(input.level)) throw new ScopeInputError(`level must be ${DB_LEVELS.join(', ')} or null`);
  if (!(await sql().read(one('SELECT 1 AS x FROM agents_config WHERE id = ?', input.agentId)))) throw new ScopeInputError('Agent not found', 404, 'not_found');
  if (input.level === null) await sql().read(run('DELETE FROM memory_project_db_access WHERE owner_id = ? AND slug = ? AND agent_id = ?', ownerId, slug, input.agentId));
  else await sql().read(run(`INSERT INTO memory_project_db_access (owner_id, slug, agent_id, level, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, slug, agent_id) DO UPDATE SET level = excluded.level, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ownerId, slug, input.agentId, input.level as string, by, new Date().toISOString()));
  return { project: slug, agentId: input.agentId, level: (input.level ?? 'exists') as DbLevel };
}

/** What one agent may see of the project's databases. */
export async function databasesForAgent(ownerId: string, slug: string, agentId: string | null, home = os.homedir()) {
  await requireProject(ownerId, slug);
  const row = agentId ? await sql().read(one<{ level: DbLevel }>('SELECT level FROM memory_project_db_access WHERE owner_id = ? AND slug = ? AND agent_id = ?', ownerId, slug, agentId)) : undefined;
  const level: DbLevel = row?.level ?? 'exists';
  const { list } = await foundOf(ownerId, slug);
  return { project: slug, level, databases: list.map((d) => shown(d, level, home)), ...(level === 'data' ? { data: 'ask the owner each time' } : {}) };
}
