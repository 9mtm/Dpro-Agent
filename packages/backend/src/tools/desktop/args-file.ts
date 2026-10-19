import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Private, exclusive IPC file; desktop arguments may contain typed secrets. */
export function desktopArgsFile(args: Record<string, unknown>): { file: string; cleanup: () => void } {
  const json = JSON.stringify(args);
  const directory = mkdtempSync(join(tmpdir(), 'dpro-desktop-'));
  const cleanup = () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    const file = join(directory, 'args.json');
    writeFileSync(file, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { file, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
