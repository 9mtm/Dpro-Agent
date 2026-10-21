/**
 * Back-flow (MEM-BRIDGE-01): what Claude Code, Codex, Gemini CLI or
 * Antigravity write into their OWN memory files for a known project comes
 * back to Dpro as review proposals, never as direct writes.
 *
 * Files read (read only, regular files ≤ 1 MiB, no symlinks), per project folder:
 *   claude-code  CLAUDE.md (outside Dpro's markers), CLAUDE.local.md, .claude/CLAUDE.md,
 *                .claude/rules/*.md, and its auto memory ~/.claude/projects/<folder>/memory/*.md
 *   codex        AGENTS.md (outside Dpro's markers), AGENTS.override.md
 *   gemini-cli   GEMINI.md (outside Dpro's markers)
 *   antigravity  .agents/AGENTS.md, .agents/GEMINI.md, .agents/rules/*.md, .agent/rules/*.md
 *
 * Each file goes through the import pipeline's secret scan and Markdown
 * chunker; each new chunk goes through learning review (learning.ts, review
 * mode) into the project's drawer, so near-copies are dropped and a chunk
 * that contradicts an approved memory becomes a conflict proposal. A chunk
 * is proposed once (its hash is remembered under an opaque file key).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Project } from '../../repositories/chat-conversations.js';
import { redactImportText } from '../import/redact.js';
import { chunkMarkdown } from '../import/pipeline.js';
import { learn } from '../learning.js';
import { projectDrawer } from './brief.js';
import { claudeProjectDir, type BridgeClient } from './clients.js';
import { outsideManaged, MAX_MANAGED_FILE_BYTES } from './managed-files.js';
import { audit, markChunk, seenChunks } from './store.js';

/** At most this many new proposals per project and run (the review queue stays usable). */
export const MAX_BACKFLOW_PROPOSALS = 40;
const MIN_CHUNK_CHARS = 20;

export interface BackflowSource { client: BridgeClient; file: string; outsideOnly: boolean }

const mdIn = (dir: string): string[] => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => path.join(dir, e.name)).sort(); } catch { return []; }
};

/** Every memory file of every CLI that belongs to this folder (only the ones that exist). */
export function backflowSources(folder: string, home = os.homedir()): BackflowSource[] {
  const at = (client: BridgeClient, rel: string, outsideOnly = false) => ({ client, file: path.join(folder, rel), outsideOnly });
  const list: BackflowSource[] = [
    at('claude-code', 'CLAUDE.md', true), at('claude-code', 'CLAUDE.local.md'), at('claude-code', path.join('.claude', 'CLAUDE.md')),
    ...mdIn(path.join(folder, '.claude', 'rules')).map((file) => ({ client: 'claude-code' as const, file, outsideOnly: false })),
    ...mdIn(path.join(claudeProjectDir(folder, home), 'memory')).map((file) => ({ client: 'claude-code' as const, file, outsideOnly: false })),
    at('codex', 'AGENTS.md', true), at('codex', 'AGENTS.override.md'),
    at('gemini-cli', 'GEMINI.md', true),
    at('antigravity', path.join('.agents', 'AGENTS.md')), at('antigravity', path.join('.agents', 'GEMINI.md')),
    ...mdIn(path.join(folder, '.agents', 'rules')).map((file) => ({ client: 'antigravity' as const, file, outsideOnly: false })),
    ...mdIn(path.join(folder, '.agent', 'rules')).map((file) => ({ client: 'antigravity' as const, file, outsideOnly: false })),
  ];
  return list.filter((s) => { try { const st = fs.lstatSync(s.file); return st.isFile() && !st.isSymbolicLink() && st.size <= MAX_MANAGED_FILE_BYTES; } catch { return false; } });
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** Lines that only point elsewhere (imports, Dpro's adapter) are not facts. */
const pointerOnly = (s: string) => s.split('\n').every((l) => !l.trim() || /^@\S+$/.test(l.trim()) || /^#+\s/.test(l.trim()));

export interface BackflowResult { files: number; proposed: number; known: number; skipped: number; proposalIds: string[] }

export async function runBackflow(ownerId: string, project: Project, opts: { home?: string } = {}): Promise<BackflowResult> {
  const out: BackflowResult = { files: 0, proposed: 0, known: 0, skipped: 0, proposalIds: [] };
  if (!project.folder) return out;
  let folder: string;
  try { folder = fs.realpathSync.native(project.folder); } catch { return out; }
  for (const src of backflowSources(folder, opts.home)) {
    let text: string;
    try { text = fs.readFileSync(src.file, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    out.files++;
    if (src.outsideOnly) text = outsideManaged(text);
    let clean: string;
    try { clean = redactImportText(text).text; } catch { continue; }
    // Opaque per-file key: the path never leaves this function.
    const fileKey = sha(`${project.id}\0${src.file}`).slice(0, 32);
    const seen = await seenChunks(ownerId, project.id, fileKey);
    for (const chunk of chunkMarkdown(clean)) {
      const content = chunk.content.trim();
      if (content.length < MIN_CHUNK_CHARS || pointerOnly(content)) continue;
      const h = sha(norm(content));
      if (seen.has(h)) continue;
      if (out.proposed >= MAX_BACKFLOW_PROPOSALS) return out;
      const r = await learn({ userId: ownerId, actor: `bridge:${src.client}`, review: true,
        candidates: [{ content, type: 'fact', importance: 5, drawer: projectDrawer(project), origin: 'extraction' }] });
      const proposal = r.proposed[0];
      if (proposal) {
        out.proposed++; out.proposalIds.push(proposal.id);
        await markChunk(ownerId, project.id, fileKey, h, proposal.id);
      } else if (r.skipped.some((s) => s.reason === 'already known')) {
        out.known++;
        await markChunk(ownerId, project.id, fileKey, h, null);
      } else {
        // Queue full or not allowed now: tried again on the next run.
        out.skipped++;
      }
      seen.add(h);
    }
  }
  if (out.proposed) await audit(ownerId, 'backflow', { projectId: project.id, note: `${out.proposed} proposal(s) from ${out.files} file(s)` });
  return out;
}
