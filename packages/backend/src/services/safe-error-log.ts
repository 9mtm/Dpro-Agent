/**
 * Safe fields of an error for server logs (FU-01).
 *
 * CLI and provider errors can carry stderr, the prompt, file paths or tokens
 * in their message, stack, `stderr`, `stdout` or `cmd`. Logs get only the
 * fields below, and each one is checked against a strict shape, so free text
 * never reaches the log.
 */

import { redactImportText } from '../memory/import/redact.js';

export interface SafeErrorFields {
  name: string;
  code?: string | number;
  status?: number;
  signal?: string;
  killed?: boolean;
  durationMs?: number;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const SIGNAL_RE = /^SIG[A-Z0-9]{1,16}$/;

function intIn(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Error name, exit code / error code, HTTP status, signal and duration only. */
export function safeErrorFields(err: unknown, startedAt?: number): SafeErrorFields {
  const e = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
  const out: SafeErrorFields = {
    name: typeof e.name === 'string' && NAME_RE.test(e.name) ? e.name : 'Error',
  };
  const numCode = intIn(e.code, -1_000_000, 1_000_000);
  if (numCode !== undefined) out.code = numCode;
  else if (typeof e.code === 'string' && CODE_RE.test(e.code)) out.code = e.code;
  const status = intIn(e.status, 100, 599) ?? intIn(e.statusCode, 100, 599);
  if (status !== undefined) out.status = status;
  if (typeof e.signal === 'string' && SIGNAL_RE.test(e.signal)) out.signal = e.signal;
  if (e.killed === true) out.killed = true;
  if (typeof startedAt === 'number') out.durationMs = Math.max(0, Date.now() - startedAt);
  return out;
}

/**
 * Client-safe text for a failed CLI bridge call (FU-02).
 *
 * stderr and the error message can hold the prompt, paths or tokens, so the
 * reply names only the exit code or signal, plus a timeout note when the
 * process was killed after `timeoutMs`.
 */
export function cliFailureText(label: string, err: unknown, timeoutMs?: number): string {
  const f = safeErrorFields(err);
  if (f.killed && typeof timeoutMs === 'number') {
    return `${label} CLI timed out after ${timeoutMs}ms${f.signal ? ` (${f.signal})` : ''}.`;
  }
  if (f.code === 'ENOENT') return `${label} CLI was not found.`;
  const parts: string[] = [];
  if (typeof f.code === 'number') parts.push(`exit ${f.code}`);
  else if (typeof f.code === 'string') parts.push(f.code);
  if (f.signal) parts.push(f.signal);
  if (f.killed) parts.push('killed');
  return `${label} CLI failed${parts.length ? ` (${parts.join(', ')})` : ''}.`;
}

/**
 * Client-safe text for a CLI bridge call that exited 0 with no stdout (FU-03).
 *
 * stderr is never used as the answer: it can hold the prompt, paths or tokens.
 */
export function cliNoOutputText(label: string): string {
  return `${label} CLI returned no output.`;
}

/** Untrusted log fields cannot introduce records, terminal controls, or format directives. */
export function logText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value
      : value instanceof Error ? JSON.stringify(safeErrorFields(value))
      : JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unavailable log field]';
  }
  return redactImportText(text).text.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ').slice(0, 4096);
}

export const safeConsole = {
  log: (...args: unknown[]) => console.log('%s', JSON.stringify({ message: args.map(logText).join(' ') })),
  info: (...args: unknown[]) => console.info('%s', JSON.stringify({ message: args.map(logText).join(' ') })),
  warn: (...args: unknown[]) => console.warn('%s', JSON.stringify({ message: args.map(logText).join(' ') })),
  error: (...args: unknown[]) => console.error('%s', JSON.stringify({ message: args.map(logText).join(' ') })),
};
