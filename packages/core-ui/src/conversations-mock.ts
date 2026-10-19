import type { WireRequest, WireResponse } from './session';
import { conversationPath } from './conversation-contract.js';
import { searchPath } from './chat-search-contract.js';
import { exportPath } from './chat-export-contract.js';

type Msg = { id: string; role: 'user' | 'assistant'; content: string; parts: unknown[] | null; status: 'complete' | 'stopped' | 'error'; runId: string | null; durationMs: number | null; createdAt: string; agentId?: string };
type Proj = { id: string; name: string; slug: string; folder: string | null; repoUrl: string | null };
type Conv = { id: string; title: string | null; agentId: string | null; projectId: string | null; pinned: boolean; preview: string; createdAt: string; updatedAt: string; messages: Msg[]; order: number };
type Run = { id: string; conv: Conv; events: Record<string, unknown>[]; done: boolean; stopped: boolean; started: number; agentId?: string };

/** Fictional GitHub links (the scheme is joined here so no full address appears in the source). */
const GH = ['https:', '', 'github.com'].join('/');

const ANSWER = [
  'Here is a fictional plan for **offline practice**. Nothing ran on a real machine.\n\n',
  '| Step | Owner | Status |\n|---|---|---|\n| Draft the brief | Writer | Done |\n| Review | Lead | Next |\n\n',
  '```ts\nexport function greet(name: string) {\n  return `Hello, ${name}`;\n}\n```\n\n',
  '- [x] Read the notes\n- [ ] Send the summary\n\nمرحباً — Arabic text aligns on its own.',
];

/** Fictional, in-memory conversations and runs for offline practice and tests. Never a live fallback. */
export function createConversationsMock(options: { stepMs?: number } = {}) {
  const stepMs = options.stepMs ?? 60;
  const convs = new Map<string, Conv>();
  const runs = new Map<string, Run>();
  const projects = new Map<string, Proj>();
  let n = 0; let clock = 0;
  const now = () => `2026-10-15 12:${String(Math.floor(clock / 60) % 60).padStart(2, '0')}:${String(clock++ % 60).padStart(2, '0')}`;
  const view = (c: Conv) => ({ id: c.id, title: c.title, agentId: c.agentId, projectId: c.projectId, pinned: c.pinned, preview: c.preview, createdAt: c.createdAt, updatedAt: c.updatedAt });
  const list = () => [...convs.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.order - a.order).map(view);
  const script = (prompt: string) => {
    const ev: Record<string, unknown>[] = [
      { type: 'reasoning', content: 'The owner wants a short plan. ' }, { type: 'reasoning', content: 'I will check the notes first.' },
      { type: 'tool_start', step: 1, tools: [{ id: 'c1', name: 'read_file', input: JSON.stringify({ path: 'notes/brief.md' }) }, { id: 'c2', name: 'exec', input: JSON.stringify({ command: 'ls notes' }) }] },
      { type: 'tool_result', step: 1, results: [{ id: 'c1', name: 'read_file', output: '# Brief\nFictional notes for practice.', isError: false, ms: 12 }, { id: 'c2', name: 'exec', output: 'brief.md\nideas.md', isError: false, ms: 30 }] },
      ...ANSWER.map(content => ({ type: 'text', content })),
    ];
    if (/make a plan/i.test(prompt)) {
      const plan = (a: string, b: string, c: string) => JSON.stringify({ steps: [{ title: 'Read the notes', status: a }, { title: 'Draft the plan', status: b }, { title: 'Check with the owner', status: c }] });
      ev.splice(2, 0, { type: 'tool_start', step: 0, tools: [{ id: 'p0', name: 'plan_steps', input: plan('active', 'pending', 'pending') }] },
        { type: 'tool_result', step: 0, results: [{ id: 'p0', name: 'plan_steps', output: 'Plan shown to the owner.', isError: false, ms: 1 }] });
      ev.splice(ev.length - 1, 0, { type: 'tool_start', step: 2, tools: [{ id: 'p1', name: 'plan_steps', input: plan('done', 'done', 'active') }] },
        { type: 'tool_result', step: 2, results: [{ id: 'p1', name: 'plan_steps', output: 'Plan shown to the owner.', isError: false, ms: 1 }] });
    }
    if (/fail/i.test(prompt)) ev.splice(2, ev.length - 2, { type: 'text', content: 'Partial answer before a fictional failure.' });
    return ev;
  };

  function eventsFor(run: Run, after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
    let i = after; let cancelled = false;
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise(r => setTimeout(r, stepMs));
        if (cancelled) return;
        if (signal.aborted) { c.close(); return; }
        const total = run.events.length;
        if (i < total) { const e = run.events[i++]; c.enqueue(enc.encode(`id: ${i}\ndata: ${JSON.stringify({ seq: i, ...e })}\n\n`)); if (e.type === 'end') c.close(); return; }
        c.enqueue(enc.encode(': ping\n\n'));
      },
      cancel() { cancelled = true; },
    });
  }

  function advance(run: Run, script: Record<string, unknown>[], failing: boolean) {
    let k = 0;
    const tick = () => {
      if (run.done) return;
      if (run.stopped || k >= script.length) {
        const status = run.stopped ? 'stopped' : failing ? 'error' : 'complete';
        const text = run.events.filter(e => e.type === 'text').map(e => e.content).join('');
        const parts: unknown[] = [];
        for (const e of run.events) {
          const last = parts.at(-1) as { kind: string; text?: string } | undefined;
          if (e.type === 'text' || e.type === 'reasoning') { if (last?.kind === e.type) last.text += String(e.content); else parts.push({ kind: e.type, text: e.content }); }
          if (e.type === 'tool_start') parts.push({ kind: 'tools', step: e.step, calls: (e.tools as { id: string }[]).map(t => ({ ...t })) });
          if (e.type === 'tool_result') { const p = parts.find((x: any) => x.kind === 'tools' && x.step === e.step) as any; (e.results as any[]).forEach(r => { const c = p.calls.find((x: any) => x.id === r.id); Object.assign(c, r); }); }
        }
        const ms = (k + 1) * stepMs;
        run.conv.messages.push({ id: `m-${++n}`, role: 'assistant', content: text, parts, status, runId: run.id, durationMs: ms, createdAt: now(), ...(run.agentId ? { agentId: run.agentId } : {}) });
        run.conv.updatedAt = now();
        run.events.push({ type: 'end', status, ms, ...(failing ? { code: 'model_unavailable' } : {}) });
        run.done = true;
        return;
      }
      run.events.push(script[k++]);
      setTimeout(tick, stepMs);
    };
    setTimeout(tick, stepMs);
  }

  /** CHAT-PRO-02 D: a simple search over the fictional conversations (same answer shape as the backend). */
  function search(query: string, projectId: string | null): WireResponse {
    const lower = query.toLowerCase();
    const snip = (text: string) => {
      const flat = text.replace(/\s+/g, ' ').trim(); const i = flat.toLowerCase().indexOf(lower);
      if (i < 0) return null;
      const start = Math.max(0, i - 40); const snippet = `${start ? '…' : ''}${flat.slice(start, i + query.length + 80)}`;
      const at = snippet.toLowerCase().indexOf(lower);
      return { snippet, ranges: [[at, at + query.length]] };
    };
    const results = [...convs.values()].filter(c => !projectId || c.projectId === projectId).sort((a, b) => b.order - a.order).flatMap(c => {
      const hits: unknown[] = [];
      const t = c.title ? snip(c.title) : null;
      if (t) hits.push({ kind: 'title', messageId: null, createdAt: c.updatedAt, ...t });
      const found = [...c.messages].reverse().flatMap(m => { const s = snip(m.content); return s ? [{ kind: m.role, messageId: m.id, createdAt: m.createdAt, ...s }] : []; });
      hits.push(...found.slice(0, 5));
      return hits.length ? [{ conversationId: c.id, title: c.title, projectId: c.projectId, updatedAt: c.updatedAt, matchCount: found.length, hits }] : [];
    });
    return { status: 200, body: { query, results, truncated: false } };
  }

  /** CHAT-PRO-02 F: a simple Markdown export of a fictional conversation (same answer shape as the backend). */
  function exported(id: string, tools: boolean): WireResponse {
    const c = convs.get(id);
    if (!c) return { status: 404, body: { code: 'not_found' } };
    const turns = c.messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const blocks = turns.map(m => {
      const calls = tools && m.role === 'assistant' ? ((m.parts ?? []) as any[]).flatMap(p => (p.kind === 'tools' ? p.calls : [])) : [];
      const summary = calls.length ? `\n\n<details>\n<summary>Tool calls (${calls.length})</summary>\n\n${calls.map((t: any) => `- \`${t.name}\` — ${t.isError ? 'error' : 'ok'}`).join('\n')}\n\n</details>` : '';
      return `\n---\n\n### ${m.role === 'user' ? 'You' : 'Main agent'} · ${m.createdAt.slice(0, 16)}\n\n${m.content}${summary}\n`;
    });
    const markdown = `# ${c.title ?? 'Conversation'}\n\n- Date: ${c.createdAt.slice(0, 16)}\n- Agent: Main agent\n${blocks.join('')}\n---\n\n_Exported from Dpro Agent._\n`;
    return { status: 200, body: { filename: `${(c.title ?? 'conversation').replace(/[^\p{L}\p{N} _.-]+/gu, ' ').trim() || 'conversation'}.md`, markdown, turns: turns.length, totalTurns: turns.length, truncated: false, redacted: 0 } };
  }

  return function transport(request: WireRequest): WireResponse {
    const sp = searchPath(request.path);
    if (sp) return search(sp.query, sp.projectId);
    const ep = exportPath(request.path);
    if (ep) return exported(ep.id, ep.tools);
    const p = conversationPath(request.path);
    const body = request.body as Record<string, any> | undefined;
    if (!p) return { status: 404, body: { code: 'not_found' } };
    if (p.kind === 'projects') {
      if (request.method === 'GET') return { status: 200, body: { projects: [...projects.values()] } };
      if (body?.folder && !String(body.folder).startsWith('/')) return { status: 400, body: { code: 'invalid_project' } };
      const pr: Proj = { id: `proj-${String(++n).padStart(8, '0')}`, name: body!.name.trim(), slug: body!.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), folder: body?.folder || null, repoUrl: body?.repoUrl || null };
      projects.set(pr.id, pr); return { status: 201, body: { project: pr } };
    }
    if (p.kind === 'project-changes' || p.kind === 'project-diff' || p.kind === 'project-tree' || p.kind === 'project-file') {
      const pr = projects.get(p.id);
      if (!pr) return { status: 404, body: { code: 'not_found' } };
      if (!pr.folder) return { status: 400, body: { code: 'no_folder' } };
      if (p.kind === 'project-changes') return { status: 200, body: { branch: 'main', truncated: false, changes: [{ path: 'src/app.ts', status: 'modified', added: 2, removed: 1 }, { path: 'notes/plan.md', status: 'untracked', added: 3, removed: 0 }, { path: '.env', status: 'modified', added: 1, removed: 0 }] } };
      if (p.kind === 'project-diff') return { status: 200, body: p.rel === '.env' ? { path: p.rel, diff: '', truncated: false, binary: false, hidden: true }
        : { path: p.rel, diff: `diff --git a/${p.rel} b/${p.rel}\n--- a/${p.rel}\n+++ b/${p.rel}\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n`, truncated: false, binary: false, hidden: false } };
      if (p.kind === 'project-tree') return { status: 200, body: p.rel === '' ? { path: '', truncated: false, entries: [{ name: 'src', kind: 'dir', size: null }, { name: 'README.md', kind: 'file', size: 120 }] }
        : { path: p.rel, truncated: false, entries: [{ name: 'app.ts', kind: 'file', size: 2048 }] } };
      return { status: 200, body: { path: p.rel, text: '# Fictional project\nPractice data only.', size: 39, binary: false, hidden: false, truncated: false } };
    }
    if (p.kind === 'project' || p.kind === 'project-git') {
      const pr = projects.get(p.id);
      if (!pr) return { status: 404, body: { code: 'not_found' } };
      if (p.kind === 'project-git') return { status: 200, body: { git: pr.folder ? { branch: 'feature/panel', remote: pr.repoUrl, dirty: true, added: 12, removed: 3, files: 2, upstream: 'origin/feature/panel', ahead: 3, behind: 1, defaultBranch: 'main', lastCommit: { hash: 'a1b2c3d', subject: 'Fictional commit', author: 'Practice', date: '2026-10-15T12:00:00Z' }, github: { owner: 'example', repo: 'app', repoUrl: `${GH}/example/app`, branchUrl: `${GH}/example/app/tree/feature/panel`, compareUrl: `${GH}/example/app/compare/main...feature/panel?expand=1` } } : { branch: null, remote: null, dirty: null } } };
      if (request.method === 'DELETE') { projects.delete(pr.id); for (const c of convs.values()) if (c.projectId === pr.id) c.projectId = null; return { status: 200, body: { ok: true } }; }
      Object.assign(pr, Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => v !== undefined)));
      return { status: 200, body: { project: pr } };
    }
    if (p.kind === 'list') {
      if (request.method === 'GET') return { status: 200, body: { conversations: list() } };
      const c: Conv = { id: `conv-${String(++n).padStart(8, '0')}`, title: body?.title ?? null, agentId: body?.agentId ?? null, projectId: body?.projectId ?? null, pinned: false, preview: '', createdAt: now(), updatedAt: now(), messages: [], order: n };
      convs.set(c.id, c);
      return { status: 201, body: { conversation: view(c) } };
    }
    if (p.kind === 'events' || p.kind === 'stop') {
      const run = runs.get(p.run);
      if (!run) return { status: 404, body: { code: 'not_found' } };
      if (p.kind === 'stop') { run.stopped = true; return { status: 200, body: { ok: true, status: run.done ? 'complete' : 'stopping' } }; }
      return { status: 200, body: null, stream: eventsFor(run, p.after, request.signal) };
    }
    const c = convs.get((p as { id: string }).id);
    if (!c) return { status: 404, body: { code: 'not_found' } };
    if (p.kind === 'one') {
      if (request.method === 'DELETE') { convs.delete(c.id); return { status: 200, body: { ok: true } }; }
      if (body?.title !== undefined) c.title = body.title?.trim() || null;
      if (body?.pinned !== undefined) c.pinned = body.pinned;
      if (body?.projectId !== undefined) c.projectId = body.projectId;
      return { status: 200, body: { conversation: view(c) } };
    }
    if (p.kind === 'messages') {
      const active = [...runs.values()].find(r => r.conv === c && !r.done);
      return { status: 200, body: { conversation: view(c), messages: c.messages.map(m => ({ ...m })), activeRunId: active?.id ?? null } };
    }
    // runs
    const busy = [...runs.values()].find(r => r.conv === c && !r.done);
    if (busy) return { status: 409, body: { code: 'conversation_busy', runId: busy.id } };
    if (runs.has(body!.runId)) return { status: 202, body: { runId: body!.runId, replayed: true } };
    const user: Msg = { id: `m-${++n}`, role: 'user', content: body!.message, parts: null, status: 'complete', runId: body!.runId, durationMs: null, createdAt: now() };
    c.messages.push(user);
    c.title ??= String(body!.message).split('\n')[0].split(/\s+/).slice(0, 7).join(' ').slice(0, 60);
    c.preview = String(body!.message).slice(0, 140); c.updatedAt = now(); c.order = ++n;
    const run: Run = { id: body!.runId, conv: c, events: [], done: false, stopped: false, started: Date.now(), ...(typeof body!.agentId === 'string' ? { agentId: body!.agentId } : {}) };
    runs.set(run.id, run);
    advance(run, script(body!.message), /fail/i.test(body!.message));
    return { status: 202, body: { runId: run.id, userMessage: user } };
  };
}
