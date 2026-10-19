/**
 * Owner-confirmed world publication to the linked Genvr account.
 *
 * Steps are separate, explicit owner actions: create the private server draft
 * ONCE and keep its server id apart from the local id, upload with the server's
 * current version as base, then publish after a separate confirmation. A 409
 * is reported, never retried over. Only the generated test world is offered
 * here: no private library, voice, model or existing world is read or sent.
 */
import { q } from '../repositories/sql-steps.js';
import { genvrSdk, linkedGenvrClient, GENVR_WEB, errorCode } from './genvr-account.js';

export const TEST_WORLD_ID = 'dpro.publication.test';
const TEST_TITLE = 'Dpro test world';

export interface Publication { localId: string; serverId: string; title: string; status: 'draft' | 'published'; version: number; access: string; link: string | null; updatedAt: string }
export class PublicationError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }

async function table(): Promise<void> {
  await q.run('CREATE TABLE IF NOT EXISTS genvr_publications (user_id TEXT NOT NULL, local_id TEXT NOT NULL, server_id TEXT NOT NULL, account_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, access TEXT NOT NULL, link TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, local_id))');
}
interface Row { local_id: string; server_id: string; title: string; status: Publication['status']; version: number; access: string; link: string | null; updated_at: string }
const view = (r: Row): Publication => ({ localId: r.local_id, serverId: r.server_id, title: r.title, status: r.status, version: r.version, access: r.access, link: r.link, updatedAt: r.updated_at });

export async function listPublications(userId: string): Promise<Publication[]> {
  await table();
  return (await q.all<Row>('SELECT local_id, server_id, title, status, version, access, link, updated_at FROM genvr_publications WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100', userId)).map(view);
}

/** Flat ground with one built-in bench and no embedded assets. */
export async function testWorld() {
  const sdk = await genvrSdk();
  const world = sdk.WorldSession.create({ id: TEST_WORLD_ID, title: TEST_TITLE } as any);
  await world.tool('place_item', { itemId: 'genvr.core.bench', x: 2, z: 3 });
  if (world.export().assets.length !== 0) throw new PublicationError('embedded_assets');
  return world;
}

async function linked(userId: string) {
  const client = await linkedGenvrClient(userId);
  if (!client) throw new PublicationError('relink_required', 401);
  return { sdk: await genvrSdk(), client, identity: await client.linkedIdentity() };
}
const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof PublicationError) throw e;
    const code = errorCode(e); throw new PublicationError(code, code === 'relink_required' ? 401 : code === 'missing_scope' ? 403 : code === 'not_found' ? 404 : code === 'conflict' ? 409 : 502);
  }
};

/** Create the server draft once (kept for later uploads), then upload on the server's current version. */
export async function uploadTestWorld(userId: string): Promise<Publication> {
  return wrap(async () => {
    const { client, identity } = await linked(userId);
    const world = await testWorld();
    await table();
    let r = await q.one<Row & { account_id: string }>('SELECT *, account_id FROM genvr_publications WHERE user_id = ? AND local_id = ?', userId, TEST_WORLD_ID);
    if (r && r.account_id !== identity.id) throw new PublicationError('other_account', 409);
    if (r?.status === 'published') throw new PublicationError('published_unpublish_first', 409);
    if (!r) {
      // An uncertain create is never repeated automatically: the id is stored right away.
      const draft = await client.createDraft(world);
      await q.run('INSERT INTO genvr_publications (user_id, local_id, server_id, account_id, title, status, version, access, link, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        userId, TEST_WORLD_ID, draft.id, identity.id, TEST_TITLE, 'draft', 0, 'private', null, new Date().toISOString());
      r = await q.one('SELECT *, account_id FROM genvr_publications WHERE user_id = ? AND local_id = ?', userId, TEST_WORLD_ID);
    }
    const current = await client.readWorld(r!.server_id);
    const uploaded = await client.uploadWorld(world, { id: r!.server_id, baseVersion: (current.world as any).version });
    await q.run('UPDATE genvr_publications SET version = ?, updated_at = ? WHERE user_id = ? AND local_id = ?', uploaded.version, new Date().toISOString(), userId, TEST_WORLD_ID);
    return view((await q.one<Row>('SELECT * FROM genvr_publications WHERE user_id = ? AND local_id = ?', userId, TEST_WORLD_ID))!);
  });
}

export interface PublishInput { title: string; type: 'game' | 'event' | 'social'; access: 'public' | 'friends' | 'invite'; content: { violence: boolean; blood: boolean; horror: boolean; romance: boolean; userChat: boolean; paidItems: boolean } }

/** The separate publish confirmation; the server checks ownership, content and moderation. */
export async function publishTestWorld(userId: string, input: PublishInput): Promise<Publication> {
  return wrap(async () => {
    const { sdk, client, identity } = await linked(userId);
    await table();
    const r = await q.one<Row & { account_id: string }>('SELECT *, account_id FROM genvr_publications WHERE user_id = ? AND local_id = ?', userId, TEST_WORLD_ID);
    if (!r || r.version < 1) throw new PublicationError('upload_first', 409);
    if (r.account_id !== identity.id) throw new PublicationError('other_account', 409);
    const meta = await client.experience(r.server_id) as { isOwner?: unknown };
    if (meta.isOwner !== true) throw new PublicationError('not_found', 404);
    const published = await client.publishWorld(r.server_id, { title: input.title, type: input.type, access: { mode: input.access }, content: input.content });
    const link = sdk.worldShareUrl(GENVR_WEB, r.server_id);
    const status = (published as { status?: unknown }).status === 'published' ? 'published' : 'draft';
    await q.run('UPDATE genvr_publications SET title = ?, status = ?, access = ?, link = ?, updated_at = ? WHERE user_id = ? AND local_id = ?', input.title, status, input.access, link, new Date().toISOString(), userId, TEST_WORLD_ID);
    return view((await q.one<Row>('SELECT * FROM genvr_publications WHERE user_id = ? AND local_id = ?', userId, TEST_WORLD_ID))!);
  });
}
