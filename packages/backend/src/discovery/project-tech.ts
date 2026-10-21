/**
 * A project's design and local databases, found in its folder (read only).
 *
 * Design (DESIGN-FIND-01): colours and fonts from Tailwind configs, CSS custom
 * properties (incl. Tailwind v4 @theme), design-token JSON and brand-kit /
 * style-guide Markdown; rules from those Markdown files and from the owner's
 * own text in DESIGN.md (outside Dpro's markers); logo / icon / favicon images
 * in brand, assets, public, static and image folders (named and linked, never
 * opened as text, never moved).
 *
 * Databases (PROJECT-TECH-01): SQLite files (by their header) with table
 * names read from a read-only COPY in a throwaway folder (never a row, the
 * original is never opened); .env files read only for the DB_* connection
 * names and DATABASE_URL without its user and password (no other line is
 * kept, never a password); docker-compose database services (image, ports;
 * never their environment).
 *
 * Every walk is bounded (depth, entries, file sizes, time) and skips
 * dependency, build and VCS folders and symbolic links.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { readRegularFile } from '../services/read-regular-file.js';
import { redactImportText } from '../memory/import/redact.js';

const SKIP = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', 'Pods', 'target', 'venv', '.venv', '__pycache__', '.cache', '.turbo', '.idea', '.vscode', 'tmp', '.local-runtime', '.claude', 'worktrees']);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;
const MAX_TEXT = 256 * 1024;
const MAX_TOKENS_JSON = 512 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_SQLITE_COPY = 200 * 1024 * 1024;
const WALK_MS = 8_000;

export interface DesignColour { name: string; value: string; source: string }
export interface DesignFont { name: string; source: string }
export interface DesignLogo { path: string; kind: 'logo' | 'icon' | 'favicon'; bytes: number }
export interface DesignRule { text: string; source: string }
export interface DesignSource { path: string; kind: 'tailwind' | 'css' | 'tokens' | 'brand-kit' | 'design-md' | 'image' }
export interface DesignFound { root: string; colours: DesignColour[]; fonts: DesignFont[]; logos: DesignLogo[]; rules: DesignRule[]; sources: DesignSource[]; hash: string }

export interface DatabaseFound {
  id: string; kind: 'sqlite' | 'env' | 'compose'; engine: string; name: string; path: string;
  host?: string | null; port?: string | null; database?: string | null; service?: string; image?: string;
  tables?: string[] | null; tablesNote?: 'too-large' | 'unreadable'; bytes?: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function readText(file: string, max = MAX_TEXT): Promise<string | null> {
  try {
    const { data } = await readRegularFile(file, max);
    const text = data.toString('utf8');
    return text.includes('\0') ? null : text;
  } catch { return null; }
}

/** Files under `root` (bounded walk, no symlinks, dependency/build folders skipped). */
async function walkFiles(root: string, keep: (rel: string, name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let entries = 0;
  const until = Date.now() + WALK_MS;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || entries > MAX_ENTRIES || Date.now() > until || out.length >= 2000) return;
    let list: fsSync.Dirent[];
    try { list = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries += list.length;
    for (const e of list) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && (!e.name.startsWith('.') || e.name === '.github')) await walk(abs, depth + 1); continue; }
      if (e.isFile() && keep(path.relative(root, abs).split(path.sep).join('/'), e.name)) out.push(abs);
    }
  };
  await walk(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

const COLOUR = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([^)]{1,80}\))$/;
const isColour = (v: string) => COLOUR.test(v.trim());
const TAILWIND = /^tailwind\.config\.(js|cjs|mjs|ts)$/;
const TOKENS = /(^|[.-])(design-)?tokens?\.json$/i;
const BRAND_MD = /^(brand[-_ ]?kit|brand|brand[-_ ]?guide|style[-_ ]?guide|design[-_ ]?system|DESIGN)\.md$/i;
const IMAGE = /\.(svg|png|jpe?g|webp|ico)$/i;
const LOGO_NAME = /(logo|icon|favicon|brand|wordmark|apple-touch|symbol|mark)/i;
const IMAGE_DIRS = /(^|\/)(brand|branding|assets|public|static|images?|img|media|icons?|logos?|docs)(\/|$)/i;

/** DESIGN.md section Dpro writes (memory/project-design.ts); the finder reads only the owner's text around it. */
export const DESIGN_MARK_START = '<!-- dpro-design:start — managed by Dpro: the text between these two markers is replaced when the design changes; write your own rules outside them -->';
export const DESIGN_MARK_END = '<!-- dpro-design:end -->';
const DESIGN_SECTION = /<!-- dpro-design:start\b[^\n]*?-->[\s\S]*?<!-- dpro-design:end -->/g;

/** Colour entries of a Tailwind config: keys under `colors` (nested keys joined, DEFAULT dropped). */
export function tailwindColours(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const stack: string[] = [];
  const re = /(['"]?)([\w-]+)\1\s*:\s*(\{|\[|(['"`])([^'"`\n]{1,120})\4)|(\{)|(\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[7]) { stack.pop(); continue; }
    if (m[6]) { stack.push(''); continue; }
    const key = m[2];
    if (m[3] === '{') { stack.push(key); continue; }
    if (m[3] === '[') continue;
    const value = m[5];
    if (!stack.some((k) => /^(colors|colours|backgroundColor|textColor)$/.test(k)) || !isColour(value)) continue;
    const parent = stack.filter(Boolean).filter((k) => !/^(theme|extend|colors|colours|backgroundColor|textColor)$/.test(k));
    const name = [...parent, key === 'DEFAULT' ? '' : key].filter(Boolean).join('-');
    out.push({ name: name || key, value: value.trim() });
  }
  return out;
}

/** Font families of a Tailwind config (`fontFamily: { sans: ['Inter', …] }` → Inter). */
export function tailwindFonts(text: string): string[] {
  const block = /fontFamily\s*:\s*\{([\s\S]{0,4000}?)\n\s*\}/.exec(text)?.[1] ?? '';
  return [...block.matchAll(/[\w-]+['"]?\s*:\s*\[\s*['"`]([^'"`]{1,60})['"`]/g)].map((m) => m[1].trim());
}

/** CSS custom properties that hold colours, and font families (custom properties and @font-face). */
export function cssDesign(text: string): { colours: Array<{ name: string; value: string }>; fonts: string[] } {
  const colours: Array<{ name: string; value: string }> = [];
  const fonts: string[] = [];
  for (const m of text.matchAll(/--([\w-]{1,60})\s*:\s*([^;{}]{1,120});/g)) {
    const name = m[1].replace(/^colou?r-/, '');
    const value = m[2].trim();
    if (isColour(value)) colours.push({ name, value });
    else if (/^font(-family)?(-|$)/.test(m[1])) { const f = value.split(',')[0].replace(/['"]/g, '').trim(); if (f && !f.startsWith('var(')) fonts.push(f); }
  }
  for (const m of text.matchAll(/@font-face\s*\{[^}]*font-family\s*:\s*['"]?([^;'"]{1,60})/g)) fonts.push(m[1].trim());
  return { colours, fonts };
}

/** Colours and fonts of a design-token JSON ($value / value leaves; names = their path). */
export function tokenDesign(json: unknown): { colours: Array<{ name: string; value: string }>; fonts: string[] } {
  const colours: Array<{ name: string; value: string }> = [];
  const fonts: string[] = [];
  let seen = 0;
  const walk = (node: unknown, names: string[]) => {
    if (++seen > 5000 || !node || typeof node !== 'object' || names.length > 8) return;
    const o = node as Record<string, unknown>;
    const v = o.$value ?? o.value;
    const type = String(o.$type ?? o.type ?? '');
    if (typeof v === 'string') {
      if (isColour(v)) colours.push({ name: names.join('-'), value: v.trim() });
      else if (/font/i.test(type) || /font/i.test(names.join('-'))) fonts.push(v.split(',')[0].replace(/['"]/g, '').trim());
      return;
    }
    if (Array.isArray(v) && /font/i.test(type) && typeof v[0] === 'string') { fonts.push(v[0]); return; }
    for (const [k, child] of Object.entries(o)) if (!k.startsWith('$')) walk(child, [...names, k]);
  };
  walk(json, []);
  return { colours, fonts };
}

/** Colours named on a Markdown line (`teal #003f4d`) and rule bullets of a brand kit. */
export function markdownDesign(text: string): { colours: Array<{ name: string; value: string }>; rules: string[] } {
  const outside = text.replace(DESIGN_SECTION, '');
  const colours: Array<{ name: string; value: string }> = [];
  const rules: string[] = [];
  for (const line of outside.split(/\r?\n/)) {
    for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
      const before = line.slice(0, m.index).replace(/[`*_|:()[\]]/g, ' ').trim().split(/\s+/).slice(-2).join(' ');
      colours.push({ name: (before || 'colour').toLowerCase().slice(0, 40), value: m[0] });
    }
    const bullet = /^\s*[-*]\s+(.{8,200})$/.exec(line);
    if (bullet && rules.length < 30 && /\b(use|never|always|do not|don't|keep|only|avoid|must|should)\b/i.test(bullet[1])) rules.push(bullet[1].trim());
  }
  return { colours, rules };
}

const MAIN_NAME = /^(primary|brand|main|accent)(-(500|600|default|main))?$|(^|-)(primary|brand)$/i;

/** The colours that claim to be the main one (distinct values). */
export function mainColourCandidates(colours: DesignColour[]): DesignColour[] {
  const out: DesignColour[] = [];
  for (const c of colours) if (MAIN_NAME.test(c.name) && !out.some((o) => o.value.toLowerCase() === c.value.toLowerCase())) out.push(c);
  return out;
}

/** The project's design (read only). Null when nothing was found. */
export async function findDesign(root: string): Promise<DesignFound | null> {
  const files = await walkFiles(root, (rel, name) => TAILWIND.test(name) || /\.(css|scss)$/i.test(name) || TOKENS.test(name) || BRAND_MD.test(name) || (IMAGE.test(name) && LOGO_NAME.test(name) && IMAGE_DIRS.test(rel)));
  const colours: DesignColour[] = [];
  const fonts: DesignFont[] = [];
  const logos: DesignLogo[] = [];
  const rules: DesignRule[] = [];
  const sources: DesignSource[] = [];
  const addColours = (list: Array<{ name: string; value: string }>, source: string) => {
    for (const c of list) {
      const value = c.value.startsWith('#') ? c.value.toLowerCase() : c.value;
      if (colours.length < 60 && !colours.some((x) => x.value.toLowerCase() === value.toLowerCase())) colours.push({ name: c.name, value, source });
    }
  };
  const addFonts = (list: string[], source: string) => {
    for (const f of list) if (f && fonts.length < 20 && !/^(inherit|system-ui|sans-serif|serif|monospace|ui-sans-serif|ui-monospace)$/i.test(f) && !fonts.some((x) => x.name === f)) fonts.push({ name: f.slice(0, 60), source });
  };
  let css = 0;
  // Named sources first (Tailwind, tokens, CSS), so a colour keeps its token name; Markdown last.
  const rank = (f: string) => { const n = path.basename(f); return TAILWIND.test(n) ? 0 : TOKENS.test(n) ? 1 : /\.(css|scss)$/i.test(n) ? 2 : BRAND_MD.test(n) ? 3 : 4; };
  for (const file of files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const name = path.basename(file);
    const rel = path.relative(root, file);
    if (IMAGE.test(name)) {
      if (logos.length >= 40) continue;
      const st = await fs.stat(file).catch(() => null);
      if (!st || st.size > MAX_IMAGE) continue;
      const kind = /favicon|apple-touch/i.test(name) ? 'favicon' : /icon/i.test(name) && !/logo/i.test(name) ? 'icon' : 'logo';
      logos.push({ path: file, kind, bytes: st.size });
      continue;
    }
    if (TAILWIND.test(name)) {
      const t = await readText(file); if (!t) continue;
      const c = tailwindColours(t), f = tailwindFonts(t);
      if (!c.length && !f.length) continue;
      addColours(c, rel); addFonts(f, rel); sources.push({ path: file, kind: 'tailwind' });
    } else if (/\.(css|scss)$/i.test(name)) {
      if (++css > 80) continue;
      const t = await readText(file); if (!t) continue;
      const d = cssDesign(t);
      if (!d.colours.length && !d.fonts.length) continue;
      addColours(d.colours, rel); addFonts(d.fonts, rel); sources.push({ path: file, kind: 'css' });
    } else if (TOKENS.test(name)) {
      const t = await readText(file, MAX_TOKENS_JSON); if (!t) continue;
      let json: unknown; try { json = JSON.parse(t); } catch { continue; }
      const d = tokenDesign(json);
      if (!d.colours.length && !d.fonts.length) continue;
      addColours(d.colours, rel); addFonts(d.fonts, rel); sources.push({ path: file, kind: 'tokens' });
    } else if (BRAND_MD.test(name)) {
      const t = await readText(file); if (!t) continue;
      const d = markdownDesign(t);
      if (!d.colours.length && !d.rules.length) continue;
      addColours(d.colours, rel);
      for (const r of d.rules) if (rules.length < 40) rules.push({ text: redactImportText(r).text, source: rel });
      sources.push({ path: file, kind: /^DESIGN\.md$/i.test(name) ? 'design-md' : 'brand-kit' });
    }
  }
  if (logos.length) sources.push(...logos.map((l) => ({ path: l.path, kind: 'image' as const })));
  if (!colours.length && !fonts.length && !logos.length && !rules.length) return null;
  const hash = sha(JSON.stringify([colours, fonts, logos.map((l) => [l.path, l.kind, l.bytes]), rules]));
  return { root, colours, fonts, logos, rules, sources, hash };
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const SQLITE_NAME = /\.(sqlite3?|db3?)$/i;
const ENV_NAMES = new Set(['.env', '.env.local', '.env.development', '.env.example']);
const COMPOSE_NAMES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const ENV_KEYS = /^\s*(?:export\s+)?(DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE|DATABASE_URL|POSTGRES_DB|MYSQL_DATABASE)\s*=\s*(.*)$/;
const DB_IMAGE = /(postgres|postgis|timescale|mysql|mariadb|mongo|redis|valkey|mssql|sqlserver|cockroach|clickhouse|couchdb|cassandra|elasticsearch|opensearch|neo4j|influxdb|memcached|surrealdb)/i;
const dbId = (kind: string, file: string, key = '') => sha(`${kind}\0${file}\0${key}`).slice(0, 16);

async function isSqlite(file: string): Promise<boolean> {
  let h: fs.FileHandle | undefined;
  try {
    h = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const buf = Buffer.alloc(16);
    await h.read(buf, 0, 16, 0);
    return buf.toString('latin1') === 'SQLite format 3\0';
  } catch { return false; } finally { await h?.close().catch(() => undefined); }
}

/** Table names of a SQLite file, read from a copy in a throwaway folder (never a row; the original is never opened by SQLite). */
export async function sqliteTables(file: string): Promise<{ tables: string[] | null; note?: 'too-large' | 'unreadable'; bytes: number }> {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return { tables: null, note: 'unreadable', bytes: 0 };
  if (st.size > MAX_SQLITE_COPY) return { tables: null, note: 'too-large', bytes: st.size };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpro-sqlite-copy-'));
  try {
    const copy = path.join(dir, 'copy.sqlite');
    await fs.copyFile(file, copy);
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 500").all() as Array<{ name: string }>;
      return { tables: rows.map((r) => String(r.name).slice(0, 120)), bytes: st.size };
    } finally { db.close(); }
  } catch {
    return { tables: null, note: 'unreadable', bytes: st.size };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const unquote = (v: string) => v.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim();

/** DB_* connection names of an .env text; DATABASE_URL without user and password. Nothing else is kept. */
export function envDatabase(text: string): { engine: string; host: string | null; port: string | null; database: string | null } | null {
  const v: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_KEYS.exec(line);
    if (m && !m[2].includes('${')) v[m[1]] = unquote(m[2]).slice(0, 200);
  }
  if (v.DATABASE_URL) {
    try {
      const u = new URL(v.DATABASE_URL);
      return { engine: u.protocol.replace(/:$/, ''), host: u.hostname || null, port: u.port || null, database: u.pathname.replace(/^\/+/, '') || null };
    } catch { /* not a URL: fall back to the DB_* names */ }
  }
  const engine = v.DB_CONNECTION || (v.POSTGRES_DB ? 'pgsql' : v.MYSQL_DATABASE ? 'mysql' : '');
  if (!engine && !v.DB_HOST && !v.DB_DATABASE) return null;
  return { engine: engine || 'unknown', host: v.DB_HOST || null, port: v.DB_PORT || null, database: v.DB_DATABASE || v.POSTGRES_DB || v.MYSQL_DATABASE || null };
}

/** Database services of a compose file: name, image, published ports (never their environment). */
export function composeDatabases(text: string): Array<{ service: string; image: string; ports: string[] }> {
  let doc: any;
  try { doc = yaml.load(text, { schema: yaml.JSON_SCHEMA }); } catch { return []; }
  const services = doc && typeof doc === 'object' ? doc.services : null;
  if (!services || typeof services !== 'object') return [];
  const out: Array<{ service: string; image: string; ports: string[] }> = [];
  for (const [name, s] of Object.entries(services as Record<string, any>).slice(0, 50)) {
    const image = typeof s?.image === 'string' ? s.image : '';
    if (!DB_IMAGE.test(image) && !DB_IMAGE.test(name)) continue;
    const ports = Array.isArray(s?.ports) ? s.ports.filter((p: unknown) => typeof p === 'string' || typeof p === 'number').map(String).slice(0, 5) : [];
    out.push({ service: name.slice(0, 80), image: image.slice(0, 120), ports });
  }
  return out;
}

/** The project's local databases (metadata and table names only). */
export async function findDatabases(root: string): Promise<DatabaseFound[]> {
  const files = await walkFiles(root, (rel, name) => SQLITE_NAME.test(name) || (ENV_NAMES.has(name) && rel.split('/').length <= 2) || (COMPOSE_NAMES.has(name) && rel.split('/').length <= 2));
  const out: DatabaseFound[] = [];
  let sqlite = 0;
  for (const file of files.sort()) {
    const name = path.basename(file);
    if (SQLITE_NAME.test(name)) {
      if (sqlite >= 20 || !(await isSqlite(file))) continue;
      sqlite++;
      const t = await sqliteTables(file);
      out.push({ id: dbId('sqlite', file), kind: 'sqlite', engine: 'sqlite', name, path: file, tables: t.tables, ...(t.note ? { tablesNote: t.note } : {}), bytes: t.bytes });
    } else if (ENV_NAMES.has(name)) {
      const t = await readText(file, 64 * 1024); if (!t) continue;
      const d = envDatabase(t); if (!d) continue;
      out.push({ id: dbId('env', file), kind: 'env', engine: d.engine, name: `${d.database ?? d.engine} (${name})`, path: file, host: d.host, port: d.port, database: d.database });
    } else if (COMPOSE_NAMES.has(name)) {
      const t = await readText(file); if (!t) continue;
      for (const s of composeDatabases(t)) {
        const engine = (DB_IMAGE.exec(s.image) ?? DB_IMAGE.exec(s.service))?.[1].toLowerCase() ?? 'unknown';
        out.push({ id: dbId('compose', file, s.service), kind: 'compose', engine, name: `${s.service} (${name})`, path: file, service: s.service, image: s.image, port: s.ports[0] ?? null });
      }
    }
  }
  return out;
}
