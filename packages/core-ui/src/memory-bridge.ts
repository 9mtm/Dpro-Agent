// MEM-FINISH-01 (board M11): Memory › Coding apps. Claude Code, Codex, Gemini
// CLI and Antigravity read approved facts and the latest handoff of the folder
// they work in through the dpro-memory server, and can only propose. Nothing
// is written to an app's config or a project's files before the owner sees
// the preview and confirms it with the preview's hash.
import { Store, codeOf } from './memory-store';
import type { Requester } from './memory-store';
import {
  BRIDGE_PATH, bridgeBackflowPath, bridgeClientPath, bridgeFilesPath, bridgeProjectPath, bridgeRegistrationPath, bridgeUndoPath,
} from './memory-bridge-contract.js';
import type { BridgeClient, BridgeEntry, BridgeStatus, FilesPreview, RegistrationPreview } from './memory-bridge-contract.js';

export type BridgePreview = { kind: 'registration'; client: BridgeClient; preview: RegistrationPreview } | { kind: 'files'; projectId: string; preview: FilesPreview };
export type BridgeState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string; result?: string; busy: boolean;
  status: BridgeStatus | null; audit: readonly BridgeEntry[]; preview: BridgePreview | null; previewBusy: boolean; confirmUndo: BridgeClient | null;
}>;

const NOTICES: Record<string, string> = {
  preview_stale: 'The file changed after this preview. Nothing was written; here is a new preview.',
  conflict: 'Dpro cannot change this file safely (see the preview). Nothing was written.',
  config_unparsable: 'The app’s config file cannot be read as its format. Nothing was written.',
  markers_broken: 'Dpro’s markers in a managed file are broken. Fix or remove them, then preview again.',
  folder_missing: 'The project folder does not exist on this computer.',
  no_folder: 'This project has no folder yet.',
  already_undone: 'This registration was already undone.',
  backup_missing: 'The backup is missing; Dpro removed only its own entry.',
  not_found: 'It no longer exists.',
};

export class MemoryBridgeController extends Store<BridgeState> {
  constructor(client: Requester) {
    super({ phase: 'idle', busy: false, status: null, audit: [], preview: null, previewBusy: false, confirmUndo: null }, client);
  }

  async load() {
    if (this.getSnapshot().phase !== 'ready') this.publish({ phase: 'loading', notice: undefined });
    const [status, audit] = await Promise.all([this.read<BridgeStatus>(BRIDGE_PATH), this.read<{ entries: BridgeEntry[] }>('/api/memory-bridge/audit?limit=20')]);
    if (!status) { this.publish({ phase: 'error', notice: 'The coding apps could not be loaded.' }); return; }
    this.publish({ phase: 'ready', status, audit: audit?.entries ?? [] });
  }

  private fail(r: { status: number; body: unknown }, fallback: string) { this.publish({ busy: false, previewBusy: false, notice: NOTICES[codeOf(r as never) ?? ''] ?? fallback }); }

  /** The kill switch: off refuses every call of that app at once. */
  async setEnabled(client: BridgeClient, enabled: boolean) {
    this.publish({ busy: true, notice: undefined, result: undefined });
    try {
      const r = await this.req('PUT', bridgeClientPath(client), { enabled });
      if (r.status !== 200) { this.fail(r, 'The switch did not change.'); return; }
      this.publish({ busy: false });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The switch did not change (no connection).' }); }
  }

  /** Step 1 of 2: what Dpro would add to the app's config (changes nothing). */
  async previewRegistration(client: BridgeClient) {
    this.publish({ previewBusy: true, notice: undefined, result: undefined, confirmUndo: null });
    try {
      const r = await this.req('GET', bridgeRegistrationPath(client));
      if (r.status !== 200) { this.fail(r, 'The preview could not be made.'); return; }
      this.publish({ previewBusy: false, preview: { kind: 'registration', client, preview: (r.body as { preview: RegistrationPreview }).preview } });
    } catch { this.publish({ previewBusy: false, notice: 'The preview could not be made (no connection).' }); }
  }
  /** Step 1 of 2 for a folder: Dpro's sections in AGENTS.md / CLAUDE.md / GEMINI.md. */
  async previewFiles(projectId: string) {
    this.publish({ previewBusy: true, notice: undefined, result: undefined, confirmUndo: null });
    try {
      const r = await this.req('GET', bridgeFilesPath(projectId));
      if (r.status !== 200) { this.fail(r, 'The preview could not be made.'); return; }
      this.publish({ previewBusy: false, preview: { kind: 'files', projectId, preview: (r.body as { preview: FilesPreview }).preview } });
    } catch { this.publish({ previewBusy: false, notice: 'The preview could not be made (no connection).' }); }
  }
  cancelPreview() { this.publish({ preview: null, notice: undefined }); }

  /** Step 2 of 2: writes exactly what the preview showed (the server checks the hash). */
  async confirm() {
    const p = this.getSnapshot().preview;
    if (!p) return;
    this.publish({ previewBusy: true, notice: undefined });
    try {
      const path = p.kind === 'registration' ? bridgeRegistrationPath(p.client) : bridgeFilesPath(p.projectId);
      const r = await this.req('POST', path, { previewHash: p.preview.previewHash, confirm: true });
      if (r.status !== 200) {
        const stale = codeOf(r) === 'preview_stale';
        this.fail(r, 'Nothing was written.');
        if (stale) { if (p.kind === 'registration') await this.previewRegistration(p.client); else await this.previewFiles(p.projectId); this.publish({ notice: NOTICES.preview_stale }); }
        return;
      }
      const name = p.kind === 'registration' ? p.preview.name : this.getSnapshot().status?.projects.find(x => x.projectId === p.projectId)?.name ?? 'the project';
      this.publish({ previewBusy: false, preview: null, result: p.kind === 'registration' ? `Dpro memory registered in ${name}. A backup of the config was kept.` : `Managed files written for ${name}; Dpro keeps them in sync.` });
      await this.load();
    } catch { this.publish({ previewBusy: false, notice: 'The result is unknown (no connection). Open the preview again.' }); }
  }

  askUndo(client: BridgeClient | null) { this.publish({ confirmUndo: client, result: undefined }); }
  /** Restores the backup (or removes only Dpro's entry when the app changed its config since). */
  async undo(client: BridgeClient) {
    const id = this.getSnapshot().status?.clients.find(x => x.client === client)?.registrationId;
    if (!id) return;
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', bridgeUndoPath(id));
      if (r.status !== 200) { this.fail(r, 'The registration was not undone.'); return; }
      const mode = (r.body as { mode: string }).mode;
      this.publish({ busy: false, confirmUndo: null, result: mode === 'restored' ? 'Registration undone: the config is back as it was.' : 'Registration undone: Dpro’s entry was removed (the app changed its config since).' });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The registration was not undone (no connection).' }); }
  }

  /** Folder settings: stop updating the files, keep them out of Git, bring app notes back as reviews. */
  async setFolder(projectId: string, patch: { filesEnabled?: false; gitExclude?: boolean; backflowEnabled?: boolean }) {
    this.publish({ busy: true, notice: undefined, result: undefined });
    try {
      const r = await this.req('PATCH', bridgeProjectPath(projectId), patch);
      if (r.status !== 200) { this.fail(r, 'The folder setting did not change.'); return; }
      this.publish({ busy: false });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The folder setting did not change (no connection).' }); }
  }
  async backflowNow(projectId: string) {
    this.publish({ busy: true, notice: undefined, result: undefined });
    try {
      const r = await this.req('POST', bridgeBackflowPath(projectId));
      if (r.status !== 200) { this.fail(r, 'The app notes were not read.'); return; }
      const x = (r.body as { result: { files: number; proposed: number } }).result;
      this.publish({ busy: false, result: x.proposed ? `${x.proposed} new ${x.proposed === 1 ? 'note' : 'notes'} from ${x.files} ${x.files === 1 ? 'file' : 'files'} wait in Review.` : `Nothing new in ${x.files} ${x.files === 1 ? 'file' : 'files'}.` });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The app notes were not read (no connection).' }); }
  }
}

const APP: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity' };
const READ: Record<string, (p: string) => string> = {
  project_brief: p => `read the ${p} brief`, pinned_facts: p => `read the pinned facts of ${p}`, latest_handoff: p => `read the latest handoff of ${p}`, memory_search: p => `searched ${p}`,
};
/** One activity line in plain words. */
export function activityText(e: BridgeEntry, projectName: (id: string) => string): string {
  const app = e.client ? APP[e.client] : 'Dpro';
  const p = e.projectId ? projectName(e.projectId) : 'a project';
  switch (e.action) {
    case 'mcp-read': return `${app} ${(READ[e.detail ?? ''] ?? (() => `read ${p}`))(p)}`;
    case 'mcp-propose': return `${app} proposed a fact for ${p} → Review`;
    case 'mcp-handoff': return `${app} wrote a handoff for ${p}`;
    case 'session': return `${app} started a session`;
    case 'registered': return `${app} registered by you (backup kept)`;
    case 'unregistered': return `${app} registration undone by you`;
    case 'client-on': return `${app} turned on by you`;
    case 'client-off': return `${app} turned off by you`;
    case 'files-written': return `Managed files written for ${p}`;
    case 'files-synced': return `Managed files of ${p} updated`;
    case 'files-conflict': return `Managed files of ${p}: a conflict, nothing written`;
    case 'folder-settings': return `Folder settings of ${p} changed`;
    case 'backflow': case 'backflow-run': return `App notes of ${p} brought back → Review`;
    default: return `${app}: ${e.action}`;
  }
}
