/**
 * `agent-player doctor` checks (INST-09).
 *
 * Every check is local and read-only. The only network call is to Ollama on
 * a loopback address. `--fix` applies safe local repairs only: chmod, create
 * missing folders, generate missing secrets into secrets.env. Nothing is ever
 * deleted, no .env content is changed, and no secret value or password is
 * printed (results carry names, counts and modes only).
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import type { InstallPaths } from './install-root.js';
import { BACKEND_PORT, FRONTEND_PORT } from './runtime.js';
import { addMissingSecrets, inspectSecrets, readInstallDotenv, SECRETS_FILE_NAME } from './secrets-file.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Present when --fix can repair it. */
  fixable?: boolean;
  fixed?: string;
}

export const MIN_NODE_MAJOR = 20;
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_MODEL = 'qwen3.5:9b';

/** Passwords published in this repository (same list as backend auth/default-accounts.ts). */
export const PUBLISHED_DEFAULT_PASSWORDS: readonly string[] = ['admin123', 'user123', 'system-user-not-for-login', 'demo-user-password'];

export interface Listener {
  pid?: number;
  command?: string;
  address: string;
}

export interface MiniDb {
  pragma(source: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}

export interface DoctorContext {
  paths: InstallPaths;
  env: NodeJS.ProcessEnv;
  fix: boolean;
  nodeVersion: string;
  platform: NodeJS.Platform;
  fetchFn: typeof fetch;
  /** TCP listeners on a port (never binds the port). null = cannot tell. */
  listListeners(port: number): Listener[] | null;
  /** Open a SQLite file read-only, or throw. */
  openDbReadOnly(file: string): MiniDb;
  bcryptCompare(password: string, hash: string): boolean;
  freeBytes(dir: string): number | null;
}

// ---------------------------------------------------------------------------
// Real OS hooks
// ---------------------------------------------------------------------------

function backendRequire(paths: InstallPaths): NodeRequire {
  return createRequire(path.join(paths.backendDir, 'package.json'));
}

export function parseLsof(output: string): Listener[] {
  const out: Listener[] = [];
  for (const line of output.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const name = cols.slice(8).join(' ').replace(/\s*\(LISTEN\)$/, '');
    out.push({ command: cols[0], pid: Number(cols[1]) || undefined, address: name });
  }
  return out;
}

export function realContext(paths: InstallPaths, fix: boolean): DoctorContext {
  return {
    paths,
    env: process.env,
    fix,
    nodeVersion: process.version,
    platform: process.platform,
    fetchFn: fetch,
    listListeners(port) {
      if (process.platform === 'win32') return null;
      try {
        const outText = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        return parseLsof(outText);
      } catch (err: any) {
        // lsof exits 1 when nothing matches
        if (err?.status === 1) return [];
        return null;
      }
    },
    openDbReadOnly(file) {
      const Database = backendRequire(paths)('better-sqlite3');
      return new Database(file, { readonly: true, fileMustExist: true }) as MiniDb;
    },
    bcryptCompare(password, hash) {
      const bcrypt = backendRequire(paths)('bcryptjs');
      return bcrypt.compareSync(password, hash);
    },
    freeBytes(dir) {
      try {
        const s = fs.statfsSync(dir);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const modeOf = (p: string): number | null => {
  try { return fs.statSync(p).mode & 0o777; } catch { return null; }
};
const octal = (m: number) => `0${m.toString(8)}`;

/** True when an address string (lsof NAME, URL host) is loopback. */
export function isLoopbackAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  let host: string;
  if (a.startsWith('[')) host = a.slice(1, a.indexOf(']'));
  else if ((a.match(/:/g) ?? []).length > 1) host = a; // bare IPv6
  else host = a.replace(/:(\d+|\*)$/, '');
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function dotenvFor(ctx: DoctorContext): Map<string, string> {
  return readInstallDotenv(ctx.paths.backendDir, ctx.paths.root);
}

function setting(ctx: DoctorContext, name: string): string | undefined {
  return ctx.env[name] || dotenvFor(ctx).get(name) || undefined;
}

function dbPath(ctx: DoctorContext): string {
  const configured = setting(ctx, 'DATABASE_PATH') || './.data/agent-player.db';
  return path.resolve(ctx.paths.backendDir, configured);
}

function migrationsDir(ctx: DoctorContext): string | null {
  for (const d of [path.join(ctx.paths.backendDir, 'src', 'db', 'migrations'), path.join(ctx.paths.backendDir, 'dist', 'db', 'migrations')]) {
    if (fs.existsSync(d)) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type Check = (ctx: DoctorContext) => Promise<CheckResult> | CheckResult;

const checkNode: Check = (ctx) => {
  const major = Number(/^v?(\d+)/.exec(ctx.nodeVersion)?.[1] ?? 0);
  return major >= MIN_NODE_MAJOR
    ? { id: 'node', title: 'Node.js version', status: 'ok', detail: `${ctx.nodeVersion} (need ${MIN_NODE_MAJOR}+)` }
    : { id: 'node', title: 'Node.js version', status: 'fail', detail: `${ctx.nodeVersion}; Node ${MIN_NODE_MAJOR} or newer is required` };
};

const checkDeps: Check = (ctx) => {
  const need: Array<[string, string]> = [
    [ctx.paths.root, 'next'],
    [ctx.paths.backendDir, 'fastify'],
    [ctx.paths.backendDir, 'better-sqlite3'],
    [ctx.paths.backendDir, 'bcryptjs'],
  ];
  const missing = need.filter(([dir, pkg]) => {
    try { createRequire(path.join(dir, 'package.json')).resolve(`${pkg}/package.json`); return false; } catch { return true; }
  }).map(([dir, pkg]) => `${pkg} (${path.relative(ctx.paths.root, dir) || '.'})`);
  return missing.length === 0
    ? { id: 'deps', title: 'Dependencies installed', status: 'ok', detail: 'root and backend packages resolve' }
    : { id: 'deps', title: 'Dependencies installed', status: 'fail', detail: `missing: ${missing.join(', ')}; install dependencies first` };
};

const checkDataDir: Check = (ctx) => {
  const title = 'Data folder private (0700)';
  const dirs = [ctx.paths.dataDir, ctx.paths.logsDir, ctx.paths.runDir];
  const missing = dirs.filter((d) => !fs.existsSync(d));
  const loose = ctx.platform === 'win32' ? [] : dirs.filter((d) => { const m = modeOf(d); return m !== null && (m & 0o077) !== 0; });
  if (missing.length === 0 && loose.length === 0) return { id: 'data-dir', title, status: 'ok', detail: ctx.paths.dataDir };
  if (ctx.fix) {
    for (const d of missing) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const d of loose) fs.chmodSync(d, 0o700);
    return { id: 'data-dir', title, status: 'ok', detail: ctx.paths.dataDir, fixable: true, fixed: [...missing.map((d) => `created ${d}`), ...loose.map((d) => `chmod 0700 ${d}`)].join('; ') };
  }
  const parts = [...missing.map((d) => `missing ${d}`), ...loose.map((d) => `${d} is ${octal(modeOf(d)!)}`)];
  return { id: 'data-dir', title, status: missing.includes(ctx.paths.dataDir) ? 'warn' : 'fail', detail: parts.join('; '), fixable: true };
};

const checkSecretsFile: Check = (ctx) => {
  const title = 'Secrets file private (0600)';
  const file = path.join(ctx.paths.dataDir, SECRETS_FILE_NAME);
  const m = modeOf(file);
  if (m === null) return { id: 'secrets-file', title, status: 'warn', detail: `${file} not created yet (created on first start or by --fix)`, fixable: true };
  if (ctx.platform === 'win32' || (m & 0o077) === 0) return { id: 'secrets-file', title, status: 'ok', detail: `${file} ${octal(m)}` };
  if (ctx.fix) {
    fs.chmodSync(file, 0o600);
    return { id: 'secrets-file', title, status: 'ok', detail: file, fixable: true, fixed: `chmod 0600 ${file}` };
  }
  return { id: 'secrets-file', title, status: 'fail', detail: `${file} is ${octal(m)}; other users can read it`, fixable: true };
};

const checkSecretsComplete: Check = (ctx) => {
  const title = 'Required secrets set';
  let statuses = inspectSecrets(ctx.paths.dataDir, dotenvFor(ctx), ctx.env);
  const bad = statuses.filter((s) => s.state === 'placeholder' || s.state === 'bad-format');
  let fixed: string | undefined;
  if (ctx.fix && bad.length === 0) {
    const added = addMissingSecrets(ctx.paths.dataDir, statuses.filter((s) => s.state === 'missing').map((s) => s.name));
    if (added.length) {
      fixed = `generated ${added.join(', ')} in ${SECRETS_FILE_NAME}`;
      statuses = inspectSecrets(ctx.paths.dataDir, dotenvFor(ctx), ctx.env);
    }
  }
  const missing = statuses.filter((s) => s.state === 'missing');
  const weak = statuses.filter((s) => s.state === 'weak');
  const describe = (list: typeof statuses, what: string) => list.map((s) => `${s.name} ${what}${s.source !== 'none' ? ` (${s.source})` : ''}`);
  if (bad.length) {
    return {
      id: 'secrets', title, status: 'fail', fixed,
      detail: [...describe(bad.filter((s) => s.state === 'placeholder'), 'is a known placeholder'),
        ...describe(bad.filter((s) => s.state === 'bad-format'), 'has the wrong format'),
        'remove it from .env/secrets.env so a new one is generated (not done by --fix: encrypted data may depend on it)'].join('; '),
    };
  }
  if (missing.length) {
    return { id: 'secrets', title, status: 'warn', detail: `${missing.map((s) => s.name).join(', ')} missing (generated on next start, or run doctor --fix)`, fixable: true, fixed };
  }
  if (weak.length) return { id: 'secrets', title, status: 'warn', detail: describe(weak, 'is shorter than 32 characters').join('; '), fixed };
  return { id: 'secrets', title, status: 'ok', detail: statuses.map((s) => `${s.name} (${s.source})`).join(', '), fixed };
};

const checkEnvFiles: Check = (ctx) => {
  const title = '.env files not readable by others';
  const files = [path.join(ctx.paths.root, '.env'), path.join(ctx.paths.backendDir, '.env')].filter((f) => fs.existsSync(f));
  if (files.length === 0) return { id: 'env-files', title, status: 'ok', detail: 'no .env file (secrets come from secrets.env)' };
  if (ctx.platform === 'win32') return { id: 'env-files', title, status: 'skip', detail: 'not checked on Windows' };
  const loose = files.filter((f) => ((modeOf(f) ?? 0) & 0o077) !== 0);
  if (loose.length === 0) return { id: 'env-files', title, status: 'ok', detail: files.map((f) => `${path.relative(ctx.paths.root, f)} ${octal(modeOf(f)!)}`).join(', ') };
  if (ctx.fix) {
    for (const f of loose) fs.chmodSync(f, 0o600);
    return { id: 'env-files', title, status: 'ok', detail: files.map((f) => path.relative(ctx.paths.root, f)).join(', '), fixable: true, fixed: loose.map((f) => `chmod 0600 ${f}`).join('; ') };
  }
  const worldReadable = loose.some((f) => ((modeOf(f) ?? 0) & 0o004) !== 0);
  return { id: 'env-files', title, status: worldReadable ? 'fail' : 'warn', detail: loose.map((f) => `${f} is ${octal(modeOf(f)!)}`).join('; '), fixable: true };
};

const checkInstanceJson: Check = (ctx) => {
  const title = 'instance.json present and private';
  const file = path.join(ctx.paths.dataDir, 'instance.json');
  const m = modeOf(file);
  if (m === null) return { id: 'instance', title, status: 'warn', detail: 'not created yet (the backend writes it on first start; the MCP server needs it)' };
  if (ctx.platform === 'win32' || (m & 0o077) === 0) return { id: 'instance', title, status: 'ok', detail: `${file} ${octal(m)}` };
  if (ctx.fix) {
    fs.chmodSync(file, 0o600);
    return { id: 'instance', title, status: 'ok', detail: file, fixable: true, fixed: `chmod 0600 ${file}` };
  }
  return { id: 'instance', title, status: 'fail', detail: `${file} is ${octal(m)}`, fixable: true };
};

/** Opens the DB once for the three DB checks. */
function withDb<T>(ctx: DoctorContext, fn: (db: MiniDb) => T): { value?: T; error?: string; missing?: boolean } {
  const file = dbPath(ctx);
  if (!fs.existsSync(file)) return { missing: true };
  let db: MiniDb | null = null;
  try {
    db = ctx.openDbReadOnly(file);
    return { value: fn(db) };
  } catch (err: any) {
    return { error: err?.message ? String(err.message).split('\n')[0] : 'cannot open' };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

const checkDbIntegrity: Check = (ctx) => {
  const title = 'Database integrity';
  const r = withDb(ctx, (db) => db.pragma('integrity_check') as Array<{ integrity_check: string }> | string);
  if (r.missing) return { id: 'db', title, status: 'warn', detail: 'no database yet (created on first start)' };
  if (r.error) return { id: 'db', title, status: 'fail', detail: `cannot open read-only: ${r.error}` };
  const rows = Array.isArray(r.value) ? r.value.map((x: any) => x?.integrity_check ?? String(x)) : [String(r.value)];
  return rows.length === 1 && rows[0] === 'ok'
    ? { id: 'db', title, status: 'ok', detail: `${dbPath(ctx)}: ok (read-only check)` }
    : { id: 'db', title, status: 'fail', detail: `integrity_check reported ${rows.length} problem(s); back up the .data folder before anything else` };
};

const checkMigrations: Check = (ctx) => {
  const title = 'Database migrations';
  const dir = migrationsDir(ctx);
  if (!dir) return { id: 'migrations', title, status: 'skip', detail: 'no migrations folder found' };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const ids = new Set(files.map((f) => f.split('_')[0]));
  const r = withDb(ctx, (db) => {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get();
    return hasTable ? (db.prepare('SELECT id FROM migrations').all() as Array<{ id: string }>).map((x) => String(x.id)) : [];
  });
  if (r.missing) return { id: 'migrations', title, status: 'warn', detail: `${ids.size} migration(s) will run on first start` };
  if (r.error) return { id: 'migrations', title, status: 'fail', detail: `cannot read: ${r.error}` };
  const applied = new Set(r.value);
  const pending = [...ids].filter((id) => !applied.has(id)).sort();
  return pending.length === 0
    ? { id: 'migrations', title, status: 'ok', detail: `${applied.size} applied, 0 pending` }
    : { id: 'migrations', title, status: 'warn', detail: `${pending.length} pending (${pending.slice(0, 5).join(', ')}${pending.length > 5 ? ', ...' : ''}); applied on next start — back up first` };
};

const checkPasswords: Check = (ctx) => {
  const title = 'No published default passwords in use';
  const r = withDb(ctx, (db) => {
    const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!hasUsers) return [] as string[];
    const rows = db.prepare('SELECT id, password_hash FROM users WHERE password_hash IS NOT NULL').all() as Array<{ id: string; password_hash: string }>;
    const hits: string[] = [];
    for (const row of rows) {
      if (typeof row.password_hash !== 'string' || !/^\$2[aby]\$/.test(row.password_hash)) continue;
      if (PUBLISHED_DEFAULT_PASSWORDS.some((p) => ctx.bcryptCompare(p, row.password_hash))) hits.push(String(row.id));
    }
    return hits;
  });
  if (r.missing) return { id: 'passwords', title, status: 'skip', detail: 'no database yet' };
  if (r.error) return { id: 'passwords', title, status: 'warn', detail: `cannot check: ${r.error}` };
  const hits = r.value ?? [];
  return hits.length === 0
    ? { id: 'passwords', title, status: 'ok', detail: 'no account uses a published password (hashes compared locally)' }
    : { id: 'passwords', title, status: 'fail', detail: `${hits.length} account(s) use a password published in the source (ids: ${hits.join(', ')}); login refuses them — reset or remove these accounts` };
};

const checkHost: Check = (ctx) => {
  const title = 'HOST is loopback';
  const host = setting(ctx, 'HOST');
  if (!host) return { id: 'host', title, status: 'ok', detail: 'not set (backend default 127.0.0.1; start forces 127.0.0.1)' };
  return isLoopbackAddress(host)
    ? { id: 'host', title, status: 'ok', detail: host }
    : { id: 'host', title, status: 'fail', detail: `HOST=${host} in the environment/.env exposes the backend beyond this machine (agent-player start overrides it; npm scripts do not)` };
};

const checkPorts: Check = (ctx) => {
  const title = 'Ports free or bound to 127.0.0.1 only';
  const parts: string[] = [];
  let status: CheckStatus = 'ok';
  for (const port of [BACKEND_PORT, FRONTEND_PORT]) {
    const listeners = ctx.listListeners(port);
    if (listeners === null) return { id: 'ports', title, status: 'skip', detail: 'cannot list listeners here (lsof unavailable)' };
    if (listeners.length === 0) { parts.push(`${port} free`); continue; }
    const exposed = listeners.filter((l) => !isLoopbackAddress(l.address));
    if (exposed.length) {
      status = 'fail';
      parts.push(`${port} listens on ${exposed.map((l) => l.address).join(', ')} (reachable from the network)`);
    } else {
      parts.push(`${port} in use on loopback (${[...new Set(listeners.map((l) => l.command).filter(Boolean))].join(', ') || 'unknown'})`);
    }
  }
  return { id: 'ports', title, status, detail: parts.join('; ') };
};

const checkOllama: Check = async (ctx) => {
  const title = 'Ollama (local) reachable + model present';
  const url = (setting(ctx, 'OLLAMA_URL') || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  let host = '';
  try { host = new URL(url).hostname; } catch { /* invalid */ }
  if (!host || !isLoopbackAddress(host)) {
    return { id: 'ollama', title, status: 'skip', detail: 'OLLAMA_URL is not a loopback address; not contacted (doctor talks to local Ollama only)' };
  }
  const model = setting(ctx, 'DEFAULT_MODEL') || setting(ctx, 'LOCAL_MODEL_NAME') || DEFAULT_MODEL;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await ctx.fetchFn(`${url}/api/tags`, { signal: ac.signal });
    if (!res.ok) return { id: 'ollama', title, status: 'warn', detail: `Ollama answered HTTP ${res.status}` };
    const body = await res.json() as { models?: Array<{ name?: string; model?: string }> };
    const names = (body.models ?? []).map((m) => m.name || m.model || '').filter(Boolean);
    const has = names.some((n) => n === model || n === `${model}:latest` || (!model.includes(':') && n.startsWith(`${model}:`)) || (model.includes(':') && n.startsWith(`${model}-`)));
    return has
      ? { id: 'ollama', title, status: 'ok', detail: `${url}: ${names.length} model(s), ${model} present` }
      : { id: 'ollama', title, status: 'warn', detail: `${url}: model ${model} not pulled (${names.length} model(s) present); pulling needs your OK` };
  } catch {
    return { id: 'ollama', title, status: 'warn', detail: `not reachable at ${url} (optional; local models are off until it runs)` };
  } finally {
    clearTimeout(t);
  }
};

const checkTelemetry: Check = (ctx) => {
  const title = 'Next.js telemetry disabled';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ctx.paths.root, 'package.json'), 'utf-8'));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const nextScripts = Object.entries(scripts).filter(([, cmd]) => /\bnext\b/.test(cmd));
    const direct = nextScripts.filter(([, cmd]) => !cmd.includes('next-local.mjs') && !/NEXT_TELEMETRY_DISABLED=1/.test(cmd));
    const wrapper = path.join(ctx.paths.root, 'scripts', 'next-local.mjs');
    const wrapperOk = fs.existsSync(wrapper) && /NEXT_TELEMETRY_DISABLED:\s*'1'/.test(fs.readFileSync(wrapper, 'utf-8'));
    if (direct.length === 0 && wrapperOk) return { id: 'telemetry', title, status: 'ok', detail: 'all Next scripts run through scripts/next-local.mjs (NEXT_TELEMETRY_DISABLED=1)' };
    if (ctx.env.NEXT_TELEMETRY_DISABLED === '1') return { id: 'telemetry', title, status: 'ok', detail: 'NEXT_TELEMETRY_DISABLED=1 in the environment' };
    return { id: 'telemetry', title, status: 'fail', detail: direct.length ? `scripts call next without the wrapper: ${direct.map(([k]) => k).join(', ')}` : 'scripts/next-local.mjs missing or does not disable telemetry' };
  } catch {
    return { id: 'telemetry', title, status: 'warn', detail: 'cannot read package.json' };
  }
};

const checkDisk: Check = (ctx) => {
  const title = 'Free disk space';
  const target = fs.existsSync(ctx.paths.dataDir) ? ctx.paths.dataDir : ctx.paths.root;
  const free = ctx.freeBytes(target);
  if (free === null) return { id: 'disk', title, status: 'skip', detail: 'cannot read free space' };
  const gib = free / 1024 ** 3;
  const detail = `${gib.toFixed(1)} GiB free`;
  if (gib < 1) return { id: 'disk', title, status: 'fail', detail: `${detail}; the database and logs need room` };
  if (gib < 5) return { id: 'disk', title, status: 'warn', detail: `${detail}; local models need several GiB` };
  return { id: 'disk', title, status: 'ok', detail };
};

export const CHECKS: ReadonlyArray<Check> = [
  checkNode, checkDeps, checkDataDir, checkSecretsComplete, checkSecretsFile, checkEnvFiles, checkInstanceJson,
  checkDbIntegrity, checkMigrations, checkPasswords, checkHost, checkPorts, checkOllama, checkTelemetry, checkDisk,
];

export async function runDoctor(ctx: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    try {
      results.push(await check(ctx));
    } catch (err: any) {
      results.push({ id: check.name || 'check', title: check.name || 'check', status: 'fail', detail: `check crashed: ${err?.message ?? err}` });
    }
  }
  return results;
}
