import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Run npm's JavaScript entry directly; a batch shim must never parse user text. */
export async function cliInvocation(binary: string, args: string[], platform = process.platform, kind: 'claude' | 'gemini' = 'claude'): Promise<{ file: string; args: string[] }> {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return { file: binary, args };
  const entry = kind === 'gemini' ? ['@google', 'gemini-cli', 'dist', 'index.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
  const script = path.join(path.dirname(binary), 'node_modules', ...entry);
  const metadata = await stat(script);
  if (!metadata.isFile()) throw new Error('The CLI JavaScript entry is unavailable');
  return { file: process.execPath, args: [script, ...args] };
}
