import fs from 'node:fs';

/** Validate and read one descriptor, refusing symlink swaps and bounding allocation/read size. */
export function readRegularFile(file: string, limit: number): { bytes: Buffer; mode: number } {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw Object.assign(new Error('Not a regular file'), { code: 'ENOTREG' });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw Object.assign(new Error('File changed during open'), { code: 'ENOTREG' });
    if (opened.size > limit) throw Object.assign(new Error('File is too large'), { code: 'EFBIG' });
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw Object.assign(new Error('File is too large'), { code: 'EFBIG' });
    return { bytes: bytes.subarray(0, length), mode: opened.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
