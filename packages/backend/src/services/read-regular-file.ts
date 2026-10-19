import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export class FileReadError extends Error {}

/** Read bounded bytes from the same regular file that was inspected. Never writes. */
export async function readRegularFile(file: string, limit: number, options: { truncate?: boolean; root?: string } = {}) {
  const root = options.root ? await fs.realpath(options.root) : null;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new FileReadError('Not a regular file');
    const entry = await fs.lstat(file);
    if (entry.isSymbolicLink() || entry.dev !== stat.dev || entry.ino !== stat.ino) throw new FileReadError('File changed while opening');
    if (root) {
      const real = await fs.realpath(file);
      const rel = path.relative(root, real);
      if (rel === '..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) throw new FileReadError('File is outside its directory');
    }
    if (stat.size > limit && !options.truncate) throw new FileReadError('File is too large');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit && !options.truncate) throw new FileReadError('File is too large');
    return { data: buffer.subarray(0, Math.min(used, limit)), stat, truncated: stat.size > limit || used > limit };
  } finally {
    await handle.close();
  }
}
