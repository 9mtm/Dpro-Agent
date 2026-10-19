import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel));
};

/** Resolve a declared extension resource without following links outside its root. */
export function extensionResourcePath(rootDir: string, relativeName: string): string {
  if (typeof relativeName !== 'string' || relativeName.includes('\0') || path.isAbsolute(relativeName)) throw new Error('Invalid extension resource path');
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, relativeName);
  if (!inside(root, candidate)) throw new Error('Extension resource is outside its directory');
  if (!existsSync(candidate)) return candidate;
  const real = realpathSync(candidate);
  if (!inside(realpathSync(root), real)) throw new Error('Extension resource link is outside its directory');
  return real;
}
