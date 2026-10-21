/**
 * discovery / discovery_apply (DISCOVER-01, board M17): the "Found on this
 * computer" page for agents, with the same operations and gates as the owner.
 *
 * discovery        read only: the list (filter by kind, state, project), a fresh
 *                  scan, one item's redacted preview with its previewHash
 * discovery_apply  every call needs one-time owner approval (approvals.ts,
 *                  'settings'); the approval is the confirm. Import carries the
 *                  previewHash of the preview; a changed file is refused.
 *
 * Owner's own turns only. An agent proposes; it never decides where a token goes
 * on its own: an MCP secret stays out unless the call says "credentials" and the
 * owner approves that call.
 */
import type { Tool, ToolResult, ToolExecutionContext } from './types.js';
import { toolActor } from '../repositories/actor.js';
import * as D from '../discovery/service.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Found on this computer: ${msg}` }], error: msg });
const ok = (text: string, data: unknown): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...(data as object) } } as ToolResult);

function ownerOf(context?: ToolExecutionContext): string | { refused: string } {
  if (context?.toolPolicy) return { refused: 'not available when answering someone else' };
  let a;
  try { a = toolActor(context); } catch { return { refused: 'no user for this run' }; }
  if (a.channel) return { refused: 'not available in a channel turn' };
  if (a.role !== 'owner' || !a.userId) return { refused: 'only for the owner' };
  return a.userId;
}
async function guarded(context: ToolExecutionContext | undefined, fn: (owner: string) => Promise<ToolResult>): Promise<ToolResult> {
  const owner = ownerOf(context);
  if (typeof owner !== 'string') return fail(owner.refused);
  try { return await fn(owner); } catch (e) {
    if (e instanceof D.DiscoveryError) return fail(e.code.replace(/_/g, ' '));
    throw e;
  }
}

export const discoveryTool: Tool = {
  name: 'discovery',
  description: `What coding agents left on this computer (read only): Claude Code memory files, project notes (CLAUDE / AGENTS / HANDOFF / BACKLOG.md …), skills, MCP servers and SSH hosts, grouped by project folder.
action "list" (optional kind: memory | note | skill | mcp | ssh, state: new | changed | decision | imported | ignored | gone, project_id, limit): items with where each would go in Dpro.
action "scan": read the computer again now.
action "preview" (item_id): the item's redacted text and its previewHash.
action "places" (optional parent_id): the folders and drives the owner can allow, with their state (allowed, left out, inherited).
Private keys, .env files and secrets are never read or shown. To import, ignore, remove or keep an item, call discovery_apply (the owner approves the call).`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'scan', 'preview', 'places'] },
      parent_id: { type: 'string' },
      kind: { type: 'string', enum: [...D.DISCOVERY_KINDS] },
      state: { type: 'string', enum: ['new', 'changed', 'decision', 'imported', 'ignored', 'gone'] },
      project_id: { type: 'string' },
      item_id: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 500 },
    },
    required: ['action'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    return guarded(context, async (owner) => {
      if (params.action === 'list' || params.action === 'scan') {
        const v = await D.view(owner, { rescan: params.action === 'scan' });
        const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(params.limit))) : 50;
        const items = v.items.filter((i) => (!params.kind || i.kind === params.kind) && (!params.state || i.state === params.state) && (!params.project_id || (i.rootId ?? 'computer') === params.project_id)).slice(0, limit);
        const roots = v.roots.map((r) => `${r.name} (${r.id}) ${r.count} items, ${r.fresh} new`).join('; ');
        const text = `${v.items.length} items in ${v.roots.length} places. Projects: ${roots}\n${items.map((i) => `- ${i.id} [${i.kind}] ${i.name} · ${i.state} · → ${i.to}`).join('\n') || 'Nothing matches.'}`;
        return ok(text, { scannedAt: v.scannedAt, roots: v.roots, items });
      }
      if (params.action === 'places') {
        const r = await D.places(owner, typeof params.parent_id === 'string' ? params.parent_id : undefined);
        return ok(r.places.map((p) => `- ${p.id} ${p.path} · ${p.state ?? (p.inherited ? `${p.inherited} (inherited)` : 'not allowed')}`).join('\n') || 'No folders.', r);
      }
      if (params.action === 'preview') {
        if (typeof params.item_id !== 'string') return fail('item_id is required');
        const p = await D.preview(owner, params.item_id);
        return ok(`${p.kind} ${p.name} → ${p.to} (${p.state}). previewHash ${p.previewHash}${p.secrets.length ? `\nSecrets inside (values hidden): ${p.secrets.join(', ')}` : ''}${p.blocked ? `\nCannot be added: ${p.blocked}` : ''}\n\n${p.text.slice(0, 4000)}`, { item: p });
      }
      return fail('unknown action');
    });
  },
};

export const discoveryApplyTool: Tool = {
  name: 'discovery_apply',
  description: `Change what Dpro takes from this computer, after the owner approves this call.
action "import" (items: [{ id, preview_hash, secret? }]): import or update previewed items. Memory files become memories; project notes are read by the local model; skills join the library assigned to no agent; MCP servers are added switched off (secret "credentials" stores their token encrypted, "leave" adds them without it); SSH hosts are saved by name only.
action "ignore" (item_id, on): ignore an item, or stop ignoring it.
action "remove" (item_id): take an imported item out of Dpro; the file on the computer stays.
action "keep" (item_id): an item gone from the computer stays in Dpro.
action "set_watch" (enabled, interval_minutes 15 | 30 | 60): read the computer again on a schedule (nothing is imported on its own).
action "set_project_watch" (project_id, enabled): stop or start watching one project folder.
action "set_places" (allow?, deny?, exclude?: place ids from discovery "places"): allow several folders at once, take allowed ones back, leave subfolders out.
action "add_place" (path): allow a folder or drive by its full path.
action "set_kinds" (kinds: { notes?, tools?, skills?, mcp?, ssh? }): which kinds a scan reads.
action "hide_kind" (project_id, kind, on): don't show one kind from one project (or show it again).
action "merge" (name, project_ids): show several project folders as one project (the folders stay where they are).
action "separate" (group_id): show a merged project's folders apart again.
action "dismiss_suggestion" (key): a suggested merge is not the same project.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['import', 'ignore', 'remove', 'keep', 'set_watch', 'set_project_watch', 'set_places', 'add_place', 'set_kinds', 'hide_kind', 'merge', 'separate', 'dismiss_suggestion'] },
      allow: { type: 'array', items: { type: 'string' } },
      deny: { type: 'array', items: { type: 'string' } },
      exclude: { type: 'array', items: { type: 'string' } },
      path: { type: 'string' },
      kinds: { type: 'object' },
      kind: { type: 'string' },
      name: { type: 'string' },
      project_ids: { type: 'array', items: { type: 'string' } },
      group_id: { type: 'string' },
      key: { type: 'string' },
      items: { type: 'array', description: '1-100 items', items: { type: 'object', properties: { id: { type: 'string' }, preview_hash: { type: 'string' }, secret: { type: 'string', enum: ['credentials', 'leave'] } }, required: ['id', 'preview_hash'] } },
      item_id: { type: 'string' },
      project_id: { type: 'string' },
      on: { type: 'boolean' },
      enabled: { type: 'boolean' },
      interval_minutes: { type: 'number', description: '15, 30 or 60' },
    },
    required: ['action'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    // The owner's approval of this call is the explicit confirm.
    return guarded(context, async (owner) => {
      switch (params.action) {
        case 'import': {
          if (!Array.isArray(params.items) || !params.items.length || params.items.length > 100) return fail('items: 1-100 previewed items');
          const items = (params.items as Record<string, unknown>[]).map((i) => ({ id: String(i?.id ?? ''), previewHash: String(i?.preview_hash ?? ''), ...(i?.secret === 'credentials' || i?.secret === 'leave' ? { secret: i.secret as 'credentials' | 'leave' } : { secret: 'leave' as const }) }));
          if (items.some((i) => !/^[a-f0-9]{32}$/.test(i.id) || !/^[a-f0-9]{64}$/.test(i.previewHash))) return fail('each item needs an id and the preview_hash from "preview"');
          const results = await D.importItems(owner, items);
          return ok(`${results.filter((r) => r.ok).length} of ${results.length} imported.${results.some((r) => !r.ok) ? ` Not imported: ${results.filter((r) => !r.ok).map((r) => `${r.id} (${r.code})`).join(', ')}` : ''}`, { results });
        }
        case 'ignore': { const r = await D.ignore(owner, String(params.item_id ?? ''), params.on as boolean); return ok(r.ignored ? 'Ignored.' : 'No longer ignored.', r); }
        case 'remove': { const r = await D.remove(owner, String(params.item_id ?? '')); return ok('Taken out of Dpro; the file on the computer is unchanged.', r); }
        case 'keep': { const r = await D.keep(owner, String(params.item_id ?? '')); return ok('Kept in Dpro.', r); }
        case 'set_watch': { const s = await D.setSettings(owner, { watch: params.enabled, intervalMinutes: params.interval_minutes }); return ok(`Watching ${s.watch ? `every ${s.intervalMinutes} min` : 'off'}.`, { settings: s }); }
        case 'set_project_watch': { const r = await D.setRootWatch(owner, String(params.project_id ?? ''), params.enabled); return ok(r.watch ? 'Watching this folder again.' : 'This folder is no longer watched.', r); }
        case 'set_places': {
          const list = (x: unknown) => (x === undefined ? undefined : Array.isArray(x) && x.length <= 200 && x.every((i) => typeof i === 'string' && /^[a-f0-9]{32}$/.test(i)) ? x as string[] : null);
          const allow = list(params.allow), deny = list(params.deny), exclude = list(params.exclude);
          if (allow === null || deny === null || exclude === null || (!allow && !deny && !exclude)) return fail('allow / deny / exclude: lists of place ids');
          const r = await D.setPlaces(owner, { allow, deny, exclude }); return ok(`${r.allowed} allowed, ${r.removed} taken back, ${r.excluded} left out.`, r);
        }
        case 'add_place': { const r = await D.addPlace(owner, params.path); return ok(`Allowed ${r.place.path}.`, r); }
        case 'set_kinds': { const k = await D.setKinds(owner, params.kinds); return ok(`Kinds read: ${Object.entries(k).filter(([, v]) => v).map(([n]) => n).join(', ') || 'none'}.`, { kinds: k }); }
        case 'hide_kind': { const r = await D.hideKind(owner, String(params.project_id ?? ''), params.kind, params.on); return ok(r.hidden ? 'Hidden for this project.' : 'Shown again.', r); }
        case 'merge': { const r = await D.mergeRoots(owner, params.name, params.project_ids); return ok(`${r.group.folders} folders are now shown as "${r.group.name}".`, r); }
        case 'separate': { const r = await D.separateGroup(owner, String(params.group_id ?? '')); return ok('Shown apart again.', r); }
        case 'dismiss_suggestion': { const r = await D.dismissSuggestion(owner, String(params.key ?? '')); return ok('Not suggested again.', r); }
        default: return fail('unknown action');
      }
    });
  },
};
