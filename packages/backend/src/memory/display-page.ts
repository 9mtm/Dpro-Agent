import { all, one, sql, type Step } from '../repositories/sql-steps.js';
import { defaultDrawerForType, normalizeDrawer } from './drawers.js';

type Position = { at: string; id: string };
type Cursor = { upper: Position; after: Position };
export class MemoryCursorError extends Error {}
const position = (x: any): x is Position => x && typeof x.at === 'string' && x.at.length <= 64 && Number.isFinite(Date.parse(x.at)) && typeof x.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x.id);
function decode(value?: string): Cursor | null {
  if (value === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!position(c.upper) || !position(c.after)) throw Error();
    return c;
  } catch { throw new MemoryCursorError('Invalid memory cursor'); }
}

function display(row: any) {
  let drawer = defaultDrawerForType(row.type);
  try { if (row.drawer_kind) drawer = normalizeDrawer({ kind: row.drawer_kind, ...(row.drawer_key ? { key: row.drawer_key } : {}) }); } catch { /* retain the type default */ }
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags || '[]').filter((t: unknown) => typeof t === 'string').slice(0, 20).map((t: string) => t.slice(0, 60)); } catch { /* malformed legacy tags are not displayed */ }
  return { id: row.id, type: row.type, content: row.content.slice(0, 50000), importanceScore: row.importance_score ?? 0.5,
    memoryLayer: row.memory_layer || 'factual', createdAt: new Date(row.created_at).toISOString(), drawer, tags };
}

/** Display-only SQL: vectors and private metadata never enter the response. */
export function memoryDisplayPage(userId: string, token?: string) {
  const cursor = decode(token);
  return sql().read((function* (): Step<{ memories: ReturnType<typeof display>[]; nextCursor: string | null; total: number }> {
    const upper = cursor?.upper ?? (yield* one<{ at: string | Date; id: string }>('SELECT created_at AS at, id FROM memories WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', userId));
    if (!upper) return { memories: [], nextCursor: null, total: 0 };
    const upperAt = upper.at instanceof Date ? upper.at.toISOString() : upper.at;
    const bound = 'user_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))';
    const args = [userId, upperAt, upperAt, upper.id];
    const count = yield* one<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE ${bound}`, ...args);
    const after = cursor?.after;
    const rows = yield* all<any>(`SELECT id, type, content, importance_score, memory_layer, created_at, tags, drawer_kind, drawer_key FROM memories WHERE ${bound}${after ? ' AND (created_at > ? OR (created_at = ? AND id > ?))' : ''} ORDER BY created_at, id LIMIT 101`, ...args, ...(after ? [after.at, after.at, after.id] : []));
    const memories: ReturnType<typeof display>[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, 100)) {
      const item = display(row), size = Buffer.byteLength(JSON.stringify(item));
      if (memories.length && bytes + size > 512 * 1024) break;
      memories.push(item); bytes += size;
    }
    const last = rows[memories.length - 1];
    const nextCursor = last && rows.length > memories.length ? Buffer.from(JSON.stringify({ upper: { at: upperAt, id: upper.id }, after: { at: last.created_at instanceof Date ? last.created_at.toISOString() : last.created_at, id: last.id } })).toString('base64url') : null;
    return { memories, nextCursor, total: Number(count?.n ?? 0) };
  })());
}
