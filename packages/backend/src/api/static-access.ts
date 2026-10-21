/**
 * Which files under the repo `public/` folder the backend serves without a
 * token (S0-A.7).
 *
 * Decision: nothing under `public/storage/` is served statically. Runtime
 * uploads moved to `.data/uploads` (CL-05, src/services/uploads.ts) and are
 * served only through authenticated routes (`/api/uploads/*`,
 * `/api/storage/:id`); a leftover `public/storage` folder stays unreachable.
 * Files outside storage/ are the shipped (bundled) public assets.
 * PUBLIC_STORAGE_SUBTREES is the (now empty) allow-list.
 *
 * The check does not trust string normalization alone (the file system may
 * be case-insensitive, normalize Unicode, follow symlinks):
 *   - any path segment with non-ASCII or control characters, or ending with
 *     a dot or a space, is refused; backslashes and NUL are refused;
 *   - the canonical on-disk path (fs.realpathSync.native) must be inside the
 *     root, and when it is under root/storage it must be inside an allowed
 *     subtree; if the path cannot be resolved it is refused.
 */

import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export const PUBLIC_STORAGE_SUBTREES: readonly string[] = [];

// Printable ASCII; first char not a space; last char not a dot or space.
const SAFE_SEGMENT = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x2d\x2f-\x7e])?$/;

function segmentsOk(segments: string[]): boolean {
  return segments.every((s) => s === '' || (SAFE_SEGMENT.test(s) && s !== '.' && s !== '..'));
}

function allowedRelative(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return true; // the root itself
  if (parts[0].toLowerCase() !== 'storage') return true;
  if (parts.length < 2) return false; // storage/ itself
  return PUBLIC_STORAGE_SUBTREES.includes(parts[1].toLowerCase());
}

function canonical(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

export function isPublicStaticPath(pathName: string, root: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathName);
  } catch {
    return false;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return false;
  if (!segmentsOk(decoded.split('/'))) return false;

  // String-level allow-list first (cheap).
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (normalized === '..' || normalized.startsWith('../')) return false;
  if (!allowedRelative(normalized)) return false;

  // Then the canonical on-disk path.
  const realRoot = canonical(root);
  if (!realRoot) return false;
  const real = canonical(path.join(root, normalized));
  if (!real) return false;
  const rel = path.relative(realRoot, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return allowedRelative(rel);
}

/**
 * Serve `root` at `/` with the allow-list above. Registered in its own scope:
 * @fastify/static answers 403 for non-canonical or differently-cased
 * spellings of a real file, which would tell a caller that the file exists.
 * Here every refusal answers 404, like any path outside the allow-list.
 */
export async function registerPublicStatic(fastify: FastifyInstance, root: string): Promise<void> {
  await fastify.register(async scope => {
    scope.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
      if (error.statusCode === 403) return reply.callNotFound();
      throw error;
    });
    await scope.register(fastifyStatic, { root, prefix: '/', allowedPath: (pathName, base) => isPublicStaticPath(pathName, base) });
  });
}
