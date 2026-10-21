import { RecoveryApprovals } from './RecoveryApprovals';
import { ChatAvatar } from './ChatAvatar';
import {CodingSessions} from './CodingSessions';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { ConversationsController, ModelOption } from './conversations';
import { AgentPanel } from './AgentPanel';
import { ChangesPane, FilesPane } from './ProjectPanes';
import { PanesController } from './panes';
import { TerminalPrefsController, TerminalTabs } from './terminal';
import { TerminalPane } from './TerminalPane';
import { MicController } from './mic';
import type { PaneName } from './panes';
import type { SessionClient } from './session';
import { Markdown } from './markdown';
import { UiIcon } from './ui-icons';
import { ClaudeCodeIcon, CodexIcon } from './brand-icons';
import type { UiIconName } from './ui-icons';
import { approxTokens, duration, splitWork, toolCount, toolView, turnOutputs, turnPlan, turnSuggestions, withoutPlan, workSummary } from './turns';
import type { CardSuggestion, PlanStep } from './turns';
import { ChatCardsController, activityLine, cardDraftFrom } from './chat-board';
import type { ChatCard, ChatProgress } from './chat-board';
import type { Priority } from './board';
import { ChatMemoryController, messageRef, proposalsByRun, rememberDraft, MAX_REMEMBER } from './chat-memory';
import type { ChatMemory, RememberDrawer, RememberType } from './chat-memory';
import { drawerLabel } from './MemoryViews';
import { ChatRecallController } from './chat-recall';
import { ContextCard, HandoffCard, RecallChip, RecallPanel, SpeedDetails } from './ChatRecall';
import { MemoryMoveController } from './memory-move';
import { MoveDialog } from './MemoryDialogs';
import { exportConversation, exportNote } from './chat-export';
import { secretLabel, splitSecrets } from './chat-secrets';
import { SavedKeys } from './SavedKeys';
import type { Part, ToolCall, ToolKind, Turn } from './turns';

/** Pixels from the bottom within which the thread keeps following new text. */
export const FOLLOW_PX = 80;
/** How long a message opened from search stays highlighted. */
export const HIGHLIGHT_MS = 2400;
/** A busy turn with no new output for this long shows the working row. */
export const QUIET_MS = 1500;
/** In a long live step only the newest tool rows stay open; older ones fold. */
export const LIVE_ROWS = 4;

const SUGGESTIONS = [
  'Plan this week for the team and put the tasks on the board',
  'Review what the agents did today and list open questions',
  'Draft a short update for the company in Arabic and English',
];

/**
 * The chat page: a reading column (the user's messages right-aligned in a
 * quiet bubble that stays pinned while its answer scrolls; the agent's work
 * as one-line rows; its answer as plain prose) and a docked composer. A
 * finished turn folds its work into "Worked for …". Behaviour lives in
 * ConversationsController; this file is layout and local view state only.
 */
export function ChatView({ controller, mode, productName = 'Dpro Agent', client, onAddConnector, onOpenCard, onOpenMemory, onChooseContext, terminalRequest = 0, active = true }: { controller: ConversationsController; mode: 'live' | 'mock'; productName?: string; terminalRequest?: number; client?: SessionClient; onChooseContext?:()=>void; onAddConnector?: () => void; onOpenCard?: (boardId: string, cardId: string) => void; onOpenMemory?: (drawerId: string, memoryId: string) => void; active?: boolean }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [following, setFollowing] = useState(true);
  const [below, setBelow] = useState(false);
  const running = !!s.runId;
  const busy = running || s.starting;

  // Follow the newest output only while the reader is near the bottom.
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el) return;
    if (following) el.scrollTop = el.scrollHeight;
    else setBelow(true);
  }, [s.turns]);
  // Opening another conversation starts at its end.
  useLayoutEffect(() => { const el = thread.current; if (el) el.scrollTop = el.scrollHeight; setFollowing(true); setBelow(false); }, [s.activeId, s.threadPhase === 'ready']);
  const onScroll = () => {
    const el = thread.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
    setFollowing(near);
    if (near) setBelow(false);
  };
  // CHAT-PRO-02 D: a search hit scrolls to its message and highlights it briefly.
  const [flash, setFlash] = useState<string | null>(null);
  useLayoutEffect(() => {
    const f = s.focus; const el = thread.current;
    if (!f || !el || s.threadPhase !== 'ready') return;
    controller.clearFocus();
    const target = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(n => n.dataset.messageId === f.messageId);
    if (!target) return;
    // Scroll only the thread (never the page around it). A user message is sticky,
    // so its place in the thread is measured with the stickiness off.
    const sticky = target.style.position;
    target.style.position = 'static';
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    target.style.position = sticky;
    el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    setFollowing(false);
    setFlash(f.messageId);
  }, [s.focus, s.threadPhase]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), HIGHLIGHT_MS); return () => clearTimeout(t); }, [flash]);
  const jump = () => { const el = thread.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); setFollowing(true); setBelow(false); };

  // The composer grows with its text up to a cap.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [s.draft]);
  useEffect(() => { input.current?.focus(); }, [s.activeId]);

  const submit = () => { if (s.draft.trim() || s.attachments.length) { setFollowing(true); void controller.send(); } };
  const picker = useRef<HTMLInputElement>(null);
  const [mic, setMic] = useState<MicController | null>(null);
  useEffect(() => {
    if (!client) return;
    const m = new MicController(client, text => { const d = controller.getSnapshot().draft; controller.edit(d.trim() ? `${d.replace(/\s+$/, '')} ${text}` : text); input.current?.focus(); });
    setMic(m); void m.check();
    return () => m.dispose();
  }, [client, controller]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      const files = await Promise.all([...list].map(async f => ({ name: f.name, text: f.size > 2_000_000 ? '\u0000' : await f.text() })));
      setAttachError(controller.attach(files));
    } catch { setAttachError('The file could not be read.'); }
    if (picker.current) picker.current.value = '';
  };
  // CHAT-PRO-02 I: "@" at the start of a word suggests agents; picking one fills in its name.
  const mention = /(^|\s)@([^\s@]{0,40})$/.exec(s.draft);
  const suggestions = mention && s.agents.length > 1 ? s.agents.filter(a => a.name.toLowerCase().startsWith(mention[2].toLowerCase())).slice(0, 6) : [];
  const [pick, setPick] = useState(0);
  const choose = (name: string) => { if (!mention) return; controller.edit(`${s.draft.slice(0, s.draft.length - mention[2].length - 1)}@${name} `); setPick(0); input.current?.focus(); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPick(p => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(suggestions[Math.min(pick, suggestions.length - 1)].name); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!e.repeat) submit(); return; }
    if (e.key === 'Escape' && running) { e.preventDefault(); void controller.stop(); return; }
    if (e.key === 'ArrowUp' && !s.draft) { const last = controller.recall(); if (last) { e.preventDefault(); controller.edit(last); } }
  };

  const lastUser = [...s.turns].reverse().find(t => t.role === 'user');
  const agentName = s.agents.find(a => a.id === s.agentId)?.name;
  const who = whoAnswers(s.model, s.models);
  const activeConv = s.conversations.find(c => c.id === s.activeId);
  const convAgentId = activeConv?.agentId ?? null;
  const nameOf = (id: string | null | undefined) => (id ? s.agents.find(a => a.id === id)?.name : s.agents.find(a => a.primary)?.name) ?? 'Main agent';
  const convAgentName = nameOf(convAgentId);
  // A reply shows who wrote it once more than one agent answers here.
  const writers = new Set(s.turns.filter(t => t.role === 'assistant').map(t => t.agentId ?? convAgentId ?? ''));
  const teamChat = writers.size > 1 || !!s.replyAgent;
  const empty = s.turns.length === 0 && s.threadPhase !== 'loading';

  const project = controller.activeProject();
  const [pane, setPane] = useState<PaneName | null>(() => typeof window === 'undefined' || window.innerWidth >= 1100 ? 'details' : null);
  const [panes, setPanes] = useState<PanesController | null>(null);
  const [terminal, setTerminal] = useState<{ tabs: TerminalTabs; prefs: TerminalPrefsController } | null>(null);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => { if (!client) return; const p = new PanesController(client); setPanes(p); const t = { tabs: new TerminalTabs(client), prefs: new TerminalPrefsController(client) }; setTerminal(t); return () => { p.dispose(); t.tabs.dispose(); t.prefs.dispose(); }; }, [client]);
  const owner = client?.getSnapshot().user?.role === 'owner';
  useEffect(()=>{if(terminalRequest>0&&owner)setPane('terminal');},[terminalRequest,owner]);
  const [keysOpen, setKeysOpen] = useState<string | null>(null);
  // CHAT-PRO-02 I step 2: board cards made from this conversation.
  const [cardsCtl, setCardsCtl] = useState<ChatCardsController | null>(null);
  useEffect(() => { if (!client) return; const c = new ChatCardsController(client); setCardsCtl(c); return () => c.dispose(); }, [client]);
  useEffect(() => { cardsCtl?.setConversation(s.activeId); }, [cardsCtl, s.activeId]);
  // A reply that ends may have moved the work on; read the cards again.
  const wasRunning = useRef(false);
  // CHAT-PRO-02 E: memories from this conversation ("Remember this", agent proposals).
  const [memCtl, setMemCtl] = useState<ChatMemoryController | null>(null);
  useEffect(() => { if (!client) return; const m = new ChatMemoryController(client); setMemCtl(m); return () => m.dispose(); }, [client]);
  useEffect(() => { memCtl?.setConversation(s.activeId); setRemember(null); }, [memCtl, s.activeId]);
  // A memory decided elsewhere (Memory › Review, Approvals, another window) shows here when the chat is seen again.
  useEffect(() => { if (active) void memCtl?.refresh(); }, [active, memCtl]);
  useEffect(() => {
    if (!memCtl || typeof document === 'undefined') return;
    const again = () => { if (document.visibilityState === 'visible' && active) void memCtl.refresh(); };
    document.addEventListener('visibilitychange', again); window.addEventListener('focus', again);
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again); };
  }, [memCtl, active]);
  const mem = useSyncExternalStore(memCtl ? memCtl.subscribe : noopSubscribe, memCtl ? memCtl.getSnapshot : nullSnapshot, memCtl ? memCtl.getSnapshot : nullSnapshot);
  // MEM-UI-01 (board M5): what each reply remembered, and the conversation's handoff.
  const [recallCtl, setRecallCtl] = useState<ChatRecallController | null>(null);
  useEffect(() => { if (!client || !owner) return; const r = new ChatRecallController(client); setRecallCtl(r); return () => r.dispose(); }, [client, owner]);
  useEffect(() => { recallCtl?.setConversation(s.activeId); }, [recallCtl, s.activeId]);
  // Board M15 → M13: a reply's "Wrong place" opens the move dialog; the reply then shows "moved".
  const [moveCtl, setMoveCtl] = useState<MemoryMoveController | null>(null);
  useEffect(() => { if (!client || !owner || !recallCtl) return; const m = new MemoryMoveController(client, (id, drawer) => recallCtl.moved(id, drawer)); setMoveCtl(m); return () => m.dispose(); }, [client, owner, recallCtl]);
  const [remember, setRemember] = useState<RememberSeed | null>(null);
  const canRemember = owner && !!memCtl && !!s.activeId;
  const openRemember = (t: Turn, text: string) => { const ref = messageRef(t); if (ref) setRemember({ ref, text: rememberDraft(text), key: Date.now() }); };
  // ⌘⇧R / Ctrl+Shift+R: Remember this — the last reply (or the last message) of the open chat (board M28).
  useEffect(() => {
    if (!active || !canRemember) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'r') return;
      const last = [...s.turns].reverse().find(t => messageRef(t) && t.content.trim());
      if (!last) return;
      e.preventDefault(); openRemember(last, last.content);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [active, canRemember, s.turns]);
  const byRun = proposalsByRun(mem?.memories ?? [], s.turns);
  useEffect(() => { if (wasRunning.current && !running) { void cardsCtl?.refresh(); void memCtl?.refresh(); } wasRunning.current = running; }, [running, cardsCtl, memCtl]);
  const [cardForm, setCardForm] = useState<CardFormSeed | null>(null);
  const openCardForm = (seed?: CardSuggestion) => {
    const draft = cardDraftFrom(s.turns, activeConv?.title ?? null);
    const ids = (seed?.agents ?? []).map(n => s.agents.find(a => a.name.toLowerCase() === n.toLowerCase() || a.id === n)?.id).filter((x): x is string => !!x);
    setCardForm({ title: seed?.title ?? draft.title, description: seed ? [seed.description, draft.description].filter(Boolean).join('\n\n') : draft.description, agents: ids, priority: seed?.priority ?? 'normal', key: Date.now() });
  };
  // The agent's face beside the conversation (GenVR avatar frame); remembered on this device.
  const avatarOn = useSyncExternalStore(avatarShown.subscribe, avatarShown.get, avatarShown.get);
  const toggleAvatar = avatarShown.toggle;
  const folderProject = project?.folder ? project.id : null;
  useEffect(() => { panes?.setProject(folderProject); }, [panes, folderProject]);
  const paneButtons: { name: PaneName; icon: UiIconName; label: string }[] = [
    { name: 'details', icon: 'sidebar', label: 'Details' },
    ...(panes ? [{ name: 'changes' as const, icon: 'diff' as const, label: 'Changes' }, { name: 'files' as const, icon: 'folder' as const, label: 'Files' }] : []),
    ...(terminal && owner ? [{ name: 'terminal' as const, icon: 'terminal' as const, label: 'Terminal' }] : []),
  ];
  return <div className="chat-layout" data-panel={pane ?? undefined} data-max={(maximized && pane === 'terminal') || undefined}>
  <div className="chat-screen">
    <div className="chat-topbar">
      {project ? <ProjectBar name={project.name} folder={project.folder} repoUrl={project.repoUrl} git={s.git}/> : <span className="project-bar-item" aria-label="Chat context">General chat · no project folder</span>}
      {client && s.activeId && s.threadPhase !== 'loading' && <ExportMenu key={s.activeId} client={client} conversationId={s.activeId} disabled={running}/>}
      {owner && cardsCtl && s.activeId && <button type="button" className="tool chat-to-board" onClick={() => cardForm ? setCardForm(null) : openCardForm()} aria-pressed={!!cardForm} title="Put this task on a board, with the agents it needs">
        <UiIcon name="board" size={14}/><span>Add to board</span></button>}
      {mode === 'live' && <button type="button" className="tool chat-avatar-toggle" aria-pressed={avatarOn} onClick={toggleAvatar} title={avatarOn ? 'Hide the avatar' : 'Show the agent as an avatar that speaks its replies'}><UiIcon name="avatar" size={14}/><span>Avatar</span></button>}
      <span className="pane-bar" role="toolbar" aria-label="Side panes">{paneButtons.map(b =>
        <button key={b.name} type="button" className="tool" aria-pressed={pane === b.name} aria-label={b.label} title={pane === b.name ? `Hide ${b.label.toLowerCase()}` : b.label}
          onClick={() => setPane(p => p === b.name ? null : b.name)}><UiIcon name={b.icon} size={14}/></button>)}</span>
    </div>
    {mode === 'live' && avatarOn && <ChatAvatar turns={s.turns} agentId={convAgentId ?? s.agentId ?? ''} agentName={nameOf(convAgentId ?? s.agentId)} onClose={toggleAvatar}/>}
    <div className="chat-thread" ref={thread} onScroll={onScroll} aria-label="Conversation">
      {s.threadPhase === 'loading' && <p className="chat-loading" role="status"><span className="pulse" aria-hidden="true"/>Opening the conversation</p>}
      {empty ? <div className="chat-empty">
        <p className="chat-wordmark">{productName}</p>
        <p className="chat-tagline">{mode === 'mock'
          ? 'Offline practice: replies are fictional and nothing leaves this page.'
          : 'Brief your team. Your agents work like real staff — each with its own role, memory and permissions.'}</p>
        <div className="chat-suggestions">{SUGGESTIONS.map(t =>
          <button key={t} type="button" className="chat-suggestion" onClick={() => void controller.send(t)}>{t}</button>)}</div>
      </div> : <div className="chat-column" role="log" aria-live="polite" aria-relevant="additions">
        {s.turns.map((t, i) => t.role === 'user'
          ? <UserMessage key={t.key} turn={t} highlight={flash === t.key} onKey={client ? setKeysOpen : undefined} onRemember={canRemember && messageRef(t) ? () => openRemember(t, t.content) : undefined}/>
          : <AssistantTurn recovery={t.code === 'run_interrupted' && client && s.activeId ? <RecoveryApprovals key={`${s.activeId}:${client.getSnapshot().epoch}`} client={client} conversationId={s.activeId}/> : undefined} key={t.key} turn={t} highlight={flash === t.key} writer={teamChat ? nameOf(t.agentId ?? convAgentId) : undefined} last={i === s.turns.length - 1} onRetry={lastUser ? () => void controller.send(t.code === 'run_interrupted' ? 'Continue the interrupted work from the saved checkpoints. Review what is already done and inspect unknown outcomes before repeating any action. Ask me to approve each tool call.' : lastUser.content) : undefined}
            onSuggest={owner && cardsCtl && s.activeId ? openCardForm : undefined} onRemember={canRemember && messageRef(t) ? text => openRemember(t, text) : undefined}
            proposals={t.runId && memCtl ? <MemoryProposals controller={memCtl} items={byRun.get(t.runId) ?? []}/> : null} recall={recallCtl} onWrongPlace={moveCtl ? m => void moveCtl.open(m) : undefined}/>)}
        {moveCtl && <MoveDialog c={moveCtl} from="From a reply’s “wrong place”"/>}
        {cardsCtl && <ChatCards controller={cardsCtl} nameOf={id => s.agents.find(a => a.id === id)?.name ?? 'Former agent'} onOpen={onOpenCard}/>}
        {s.starting && !s.turns.some(t => t.status === 'running') && <WorkingRow since={Date.now()} label="Starting"/>}
      </div>}
    </div>
    {client && keysOpen !== null && <SavedKeys client={client} owner={owner} highlight={keysOpen || undefined} onClose={() => setKeysOpen(null)}/>}
    {below && !empty && <button type="button" className="chat-jump" onClick={jump} aria-label="Jump to the latest message"><UiIcon name="arrow-down" size={15}/></button>}
    <div className="chat-dock">
      {s.notice && <p className="chat-notice" role="status">{s.notice}</p>}
      {mem?.notice && !remember && <p className="chat-notice" role="status">{mem.notice} <button type="button" className="link-button" onClick={() => memCtl?.clearNotice()}>OK</button></p>}
      {remember && memCtl && <RememberForm key={remember.key} controller={memCtl} seed={remember} project={project?.name ?? null} agent={convAgentName} onClose={() => setRemember(null)}/>}
      {cardForm && cardsCtl && <ChatCardForm key={cardForm.key} controller={cardsCtl} seed={cardForm} agents={s.agents} onClose={() => setCardForm(null)}/>}
      {s.reconnecting && <p className="chat-notice" role="status">Reconnecting to the reply…</p>}
      {s.queuePaused && s.queue.length > 0 && <p className="chat-notice" role="status">Stopped. The waiting {s.queue.length === 1 ? 'message stays' : 'messages stay'} here until you send {s.queue.length === 1 ? 'it' : 'them'}.</p>}
      {s.queue.length > 0 && <ul className="chat-queue" aria-label="Waiting to send">
        {s.queue.map((q, i) => <li key={q.key}>
          <span className="chat-queue-n">{i === 0 ? 'Next' : `${i + 1}.`}</span>
          <span className="chat-queue-text" dir="auto">{q.text}</span>
          {s.queuePaused && !busy && <button type="button" className="ghost-action strong" onClick={() => controller.sendQueued(q.key)}>Send now</button>}
          <button type="button" className="ghost-action" onClick={() => controller.editQueued(q.key)}>Edit</button>
          <button type="button" className="ghost-action" aria-label="Remove from the queue" onClick={() => controller.removeQueued(q.key)}><UiIcon name="trash" size={13}/></button>
        </li>)}
      </ul>}
      {(s.attachments.length > 0 || attachError) && <div className="chat-attachments" aria-label="Attached files">
        {s.attachments.map(f => <span key={f.name} className="attach-chip" dir="ltr"><UiIcon name="file" size={12}/>{f.name}<small>{Math.ceil(f.text.length / 1000)}k</small>
          <button type="button" className="row-tool" aria-label={`Remove ${f.name}`} onClick={() => controller.detach(f.name)}><UiIcon name="trash" size={11}/></button></span>)}
        {attachError && <span className="attach-error" role="alert">{attachError}</span>}
      </div>}

      {!s.activeId&&onChooseContext&&<button type="button" className="composer-context" onClick={onChooseContext}>{project?.folder?'Folder: '+project.name:'General chat · Choose a folder…'}</button>}
      {s.model.startsWith('subscription:')&&<p className="fine-print">Uses your signed-in coding app in this project. Its native file tools are separate from agent skills and MCP grants. Stop cancels the local process.</p>}
      <form className="chat-composer" method="post" onSubmit={e => { e.preventDefault(); submit(); }}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void onFiles(e.dataTransfer.files); } }}>
        <label htmlFor="chat-input" className="sr-only">Message</label>
        {suggestions.length > 0 && <ul className="mention-list" role="listbox" aria-label="Agents">{suggestions.map((a, i) =>
          <li key={a.id} role="option" aria-selected={i === Math.min(pick, suggestions.length - 1)}><button type="button" onMouseDown={e => { e.preventDefault(); choose(a.name); }}>
            <span className="avatar" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>{a.name}</button></li>)}</ul>}
        <textarea id="chat-input" ref={input} rows={1} dir="auto" value={s.draft} maxLength={100000}
          placeholder={running ? 'Type the next message; it is sent when this reply ends' : agentName ? `Message ${agentName}` : s.turns.length ? 'Send a follow-up' : "What's on your mind?"}
          onChange={e => controller.edit(e.target.value)} onKeyDown={onKeyDown} disabled={s.access === 'denied'}/>
        <div className="chat-composer-row">
          <input ref={picker} type="file" multiple hidden onChange={e => void onFiles(e.target.files)}
            accept=".txt,.md,.csv,.json,.yml,.yaml,.xml,.toml,.ini,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.php,.sh,.sql,.html,.css,text/*"/>
          <button type="button" className="tool composer-attach" aria-label="Attach text files" title="Attach text files (code, notes, CSV…)" onClick={() => picker.current?.click()}><UiIcon name="plus" size={14}/></button>
          {s.agents.length > 0
            ? <label className="composer-agent" title={s.activeId ? 'Who writes the next reply (or type @ and a name)' : 'Who you talk to (or type @ and a name)'}><span className="sr-only">{s.activeId ? 'Reply from' : 'Agent'}</span>
              {s.activeId
                ? <select value={s.replyAgent} onChange={e => controller.setReplyAgent(e.target.value)}>
                  <option value="">{convAgentName}</option>
                  {s.agents.filter(a => a.id !== convAgentId && !(a.primary && !convAgentId)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                : <select value={s.agentId} onChange={e => controller.selectAgent(e.target.value)}>
                  {/* "" is the primary agent: name it once instead of listing it twice. */}
                  <option value="">{s.agents.find(a => a.primary)?.name ?? 'Main agent'}</option>
                  {s.agents.filter(a => !a.primary).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>}</label>
            : <span className="composer-hint">{agentName ? agentName : ''}</span>}
          {/* Who answers is chosen at the top of the Details panel (CORE-PICKER-02); the composer only shows a coding app when one answers. */}
          {who.app && <button type="button" className="composer-who" onClick={() => setPane('details')} title="Change who answers (Details panel)">
            <AppIcon id={who.app.id} size={12}/><span>{who.text}</span></button>}
          {mic && <MicButton mic={mic}/>}
          <span className="composer-keys" aria-hidden="true">{running ? 'Esc stops' : 'Enter sends · Shift+Enter new line'}</span>
          {running && !s.draft.trim()
            ? <button type="button" className="round-button stop" onClick={() => void controller.stop()} disabled={s.stopping} aria-label={s.stopping ? 'Stopping' : 'Stop the reply'}><UiIcon name="stop" size={10}/></button>
            : <button type="submit" className="round-button" disabled={(!s.draft.trim() && !s.attachments.length) || s.access === 'denied'} aria-label={busy ? 'Queue the message' : 'Send'}><UiIcon name="arrow-up" size={14}/></button>}
        </div>
      </form>
    </div>
  </div>
  {pane === 'details' && <ChatSidePanel controller={controller} client={client} onAddConnector={onAddConnector} memory={memCtl} onOpenMemory={onOpenMemory} recall={recallCtl}/>}
  {panes && (pane === 'changes' || pane === 'files') && <aside className="chat-panel chat-pane" aria-label={pane === 'changes' ? 'Changes' : 'Files'}>
    {pane === 'changes' ? <ChangesPane panes={panes}/> : <FilesPane panes={panes}/>}
  </aside>}
  {terminal && pane === 'terminal' && <aside className="chat-panel chat-pane" aria-label="Terminal"><TerminalPane tabs={terminal.tabs} prefs={terminal.prefs} projectId={folderProject} maximized={maximized} onToggleMax={() => setMaximized(v => !v)} onClose={() => { setMaximized(false); setPane(null); }}/></aside>}
  </div>;
}

const TERMINAL_APPS = [{ id: 'subscription:claude', label: 'Claude Code' }, { id: 'subscription:codex', label: 'Codex' }] as const;
type TerminalApp = (typeof TERMINAL_APPS)[number];

function AppIcon({ id, size }: { id: string; size: number }) {
  return id === 'subscription:claude' ? <ClaudeCodeIcon size={size}/> : <CodexIcon size={size}/>;
}

/** Which coding app answers (if any), with its chosen model: `subscription:<app>[:<session>][/<model>]`. */
export function whoAnswers(model: string, models: readonly ModelOption[]): { app: TerminalApp | null; base: string; variant: string; text: string } {
  const [base, variant = ''] = model.split('/');
  const app = model.startsWith('subscription:') ? TERMINAL_APPS.find(a => base === a.id || base.startsWith(`${a.id}:`)) ?? null : null;
  if (!app) return { app: null, base: '', variant: '', text: '' };
  const label = variant ? models.find(m => m.id === app.id)?.variants?.find(v => v.id === variant)?.label ?? variant : '';
  return { app, base, variant, text: [app.label, base !== app.id ? 'previous session' : '', label].filter(Boolean).join(' · ') };
}

/** Top of the Details panel: the agent with its own model, or Claude Code / Codex in the terminal with one of their models (CORE-PICKER-02). */
function WhoAnswers({ controller, agent }: { controller: ConversationsController; agent: string }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const project = controller.activeProject();
  useEffect(() => { void controller.loadModels(true); }, [controller]);
  const who = whoAnswers(s.model, s.models);
  const listed = s.models.some(m => m.provider === 'subscription');
  const variants = who.app ? s.models.find(m => m.id === who.app!.id)?.variants ?? [] : [];
  return <section className="panel-card who-answers">
    <h3>Who answers</h3>
    <div className="who-list" role="radiogroup" aria-label="Who answers">
      <button type="button" role="radio" aria-checked={!who.app} onClick={() => controller.selectModel('')}>
        <span className="who-icon"><UiIcon name="brain" size={14}/></span><span className="who-name">{agent}<small>Own model · set in Settings</small></span></button>
      {TERMINAL_APPS.map(a => {
        const ready = s.models.some(m => m.id === a.id && m.provider === 'subscription');
        // CORE-PICKER-03: without a project folder the app works in this chat's own private folder.
        const why = !ready ? (listed ? 'Not on this computer' : 'Desktop app only') : project?.folder ? 'In the project folder' : 'In a private chat folder';
        return <button key={a.id} type="button" role="radio" aria-checked={who.app?.id === a.id} disabled={!ready} onClick={() => controller.selectModel(a.id)}>
          <span className="who-icon"><AppIcon id={a.id} size={14}/></span><span className="who-name">{a.label}<small>{why}</small></span></button>;
      })}
    </div>
    {who.app && <label className="who-model"><span>Model</span>
      <select value={who.variant} onChange={e => controller.selectModel(who.base + (e.target.value ? `/${e.target.value}` : ''))}>
        <option value="">Default</option>
        {variants.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
        {who.variant && !variants.some(v => v.id === who.variant) && <option value={who.variant}>{who.variant}</option>}
      </select></label>}
  </section>;
}

/** Details of the open conversation: where it works, how big it is, what it produced. */
function ChatSidePanel({ controller, client, onAddConnector, memory, onOpenMemory, recall }: { controller: ConversationsController; client?: SessionClient; onChooseContext?:()=>void; onAddConnector?: () => void; memory?: ChatMemoryController | null; onOpenMemory?: (drawerId: string, memoryId: string) => void; recall?: ChatRecallController | null }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const project = controller.activeProject();
  const conv = s.conversations.find(c => c.id === s.activeId);
  const outputs = turnOutputs(s.turns);
  const tokens = approxTokens(s.turns);
  const agent = s.agents.find(a => a.id === (conv?.agentId ?? s.agentId))?.name ?? 'Main agent';
  const who = whoAnswers(s.model, s.models);
  const model = who.app ? who.text : s.model ? `Saved model: ${s.model}` : "Agent's own model";
  const replies = s.turns.filter(t => t.role === 'assistant');
  const worked = replies.reduce((n, t) => n + (t.durationMs ?? 0), 0);
  const tools = workSummary(s.turns.flatMap(t => withoutPlan(t.parts)));
  const home = project?.folder?.match(/^\/Users\/[^/]+/)?.[0];
  return <aside className="chat-panel" aria-label="Conversation details">
    <WhoAnswers controller={controller} agent={agent}/>
    {recall && s.activeId && <HandoffCard c={recall} agentId={conv?.agentId || s.agentId || s.agents[0]?.id || ''} agentName={agent}/>}
    {recall && <RecallContext c={recall} keys={replies.map(t => t.key)}/>}
    {recall && <SpeedDetails c={recall}/>}
    <section className="panel-card">
      <h3>Environment</h3>
      <dl className="panel-list">
        <div><dt><UiIcon name="board" size={12}/></dt><dd>{project ? project.name : <span className="muted">No project</span>}</dd></div>
        {project?.folder && <div><dt><UiIcon name="file" size={12}/></dt><dd dir="ltr" title={project.folder}>{home ? `~${project.folder.slice(home.length)}` : project.folder}</dd></div>}
        {s.git?.branch && <div><dt aria-label="Branch">⎇</dt><dd dir="ltr">{s.git.branch}</dd></div>}
        {(project?.repoUrl ?? s.git?.remote) && <div><dt><UiIcon name="globe" size={12}/></dt><dd dir="ltr">{(project?.repoUrl ?? s.git?.remote ?? '').replace(/^https:\/\//, '')}</dd></div>}
        <div><dt><UiIcon name="brain" size={12}/></dt><dd>{agent} · {model}</dd></div>
      </dl>
    </section>
    {client&&project?.folder&&<section className="panel-card"><h3>Local coding sessions</h3><p className="fine-print">Saved Dpro chats stay in the sidebar. Memory imports are managed in Memory.</p><CodingSessions key={project.id+':'+project.folder} client={client} controller={controller} folder={project.folder}/></section>}
    <section className="panel-card">
      <h3>Conversation</h3>
      <dl className="panel-list">
        <div><dt>Size</dt><dd>≈ {tokens.toLocaleString('en')} tokens</dd></div>
        <div><dt>Replies</dt><dd>{replies.length}{worked ? ` · worked ${duration(worked)}` : ''}</dd></div>
        {tools && <div><dt>Tools</dt><dd>{tools}</dd></div>}
      </dl>
    </section>
    <section className="panel-card">
      <h3>Outputs</h3>
      {outputs.length ? <ul className="panel-files">{outputs.slice(-8).reverse().map(o => <li key={o.path} dir="ltr"><UiIcon name={o.kind === 'edit' ? 'pencil' : 'file'} size={12}/><span title={o.path}>{o.path.split('/').at(-1)}</span></li>)}</ul>
        : <p className="muted">Files the agent writes appear here.</p>}
    </section>
    {project?.folder && <section className="panel-card">
      <h3>Changes</h3>
      {s.git && s.git.added !== null && s.git.added !== undefined
        ? (s.git.files ? <p className="panel-changes"><span className="plus">+{s.git.added}</span> <span className="minus">−{s.git.removed ?? 0}</span> <span className="muted">in {s.git.files} {s.git.files === 1 ? 'file' : 'files'} not committed</span></p>
          : <p className="muted">No uncommitted changes.</p>)
        : <p className="muted">Not a git folder.</p>}
    </section>}
    {memory && s.activeId && <ChatMemoryCard controller={memory} onOpen={onOpenMemory}/>}
    {project?.folder && s.git?.branch && <GitHubCard git={s.git} onRefresh={() => void controller.refreshGit()}/>}
    {client && <AgentPanel client={client} onAddConnector={onAddConnector} agentId={conv?.agentId || s.agentId || s.agents[0]?.id || ''}/>}
  </aside>;
}

/** Details › Context of the newest reply that has a trace. */
function RecallContext({ c, keys }: { c: ChatRecallController; keys: readonly string[] }) {
  useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  return <ContextCard trace={c.latest(keys)} c={c}/>;
}

/** The branch against GitHub: upstream, ahead/behind (last known state, offline), last commit, links to open on github.com. */
function GitHubCard({ git, onRefresh }: { git: NonNullable<ReturnType<ConversationsController['getSnapshot']>['git']>; onRefresh: () => void }) {
  const gh = git.github;
  const when = git.lastCommit?.date ? new Date(git.lastCommit.date) : null;
  return <section className="panel-card" aria-label="GitHub">
    <h3>{gh ? 'GitHub' : 'Git'} <button type="button" className="row-tool panel-head-tool" aria-label="Reload git status" title="Reload" onClick={onRefresh}><UiIcon name="refresh" size={11}/></button></h3>
    <dl className="panel-list">
      {gh && <div><dt><UiIcon name="globe" size={12}/></dt><dd dir="ltr"><a href={gh.repoUrl} target="_blank" rel="noopener noreferrer">{gh.owner}/{gh.repo}</a></dd></div>}
      <div><dt aria-label="Branch">⎇</dt><dd dir="ltr">{git.branch}</dd></div>
      <div><dt aria-label="Upstream">↕</dt><dd className="panel-wrap">{git.upstream
        ? <><span dir="ltr">{git.upstream}</span>{git.ahead !== null && git.ahead !== undefined && <span className="git-sync"> · ↑{git.ahead} ↓{git.behind ?? 0}</span>}</>
        : <span className="muted">Not on GitHub yet (never pushed)</span>}</dd></div>
      {git.lastCommit && <div><dt aria-label="Last commit"><UiIcon name="check" size={12}/></dt><dd title={`${git.lastCommit.author}${when ? ` · ${when.toLocaleString()}` : ''}`}><code dir="ltr">{git.lastCommit.hash}</code> <span dir="auto">{git.lastCommit.subject}</span></dd></div>}
    </dl>
    {git.upstream && (git.ahead ?? 0) > 0 && <p className="muted git-note">{git.ahead} {git.ahead === 1 ? 'commit is' : 'commits are'} only on this computer. Pushing is your call.</p>}
    {(git.behind ?? 0) > 0 && <p className="muted git-note">GitHub has {git.behind} newer {git.behind === 1 ? 'commit' : 'commits'} (as of the last sync with GitHub).</p>}
    {gh && <div className="git-links">
      {gh.branchUrl && <a className="link-button" href={gh.branchUrl} target="_blank" rel="noopener noreferrer">Open branch</a>}
      {gh.compareUrl && <a className="link-button" href={gh.compareUrl} target="_blank" rel="noopener noreferrer" title={`Compare ${git.defaultBranch} with ${git.branch} and open a pull request on GitHub`}>Compare / pull request</a>}
    </div>}
    <p className="muted git-note">Counts are from the last sync with GitHub; nothing is sent to GitHub from here.</p>
  </section>;
}

/** Dictation: record, then the words land in the composer (transcribed on this computer). */
function MicButton({ mic }: { mic: MicController }) {
  const m = useSyncExternalStore(mic.subscribe, mic.getSnapshot, mic.getSnapshot);
  // Shown only when speech-to-text is set up on this computer (nothing to fix from here otherwise).
  if (m.phase === 'unknown' || m.phase === 'off') return null;
  const clock = `${Math.floor(m.seconds / 60)}:${String(m.seconds % 60).padStart(2, '0')}`;
  return <span className="composer-mic">
    {m.error && <span className="mic-error" role="alert">{m.error}</span>}
    {m.phase === 'recording' && <><span className="mic-clock" aria-live="polite"><i className="mic-dot" aria-hidden="true"/>{clock}</span>
      <button type="button" className="row-tool" aria-label="Discard the recording" title="Discard" onClick={() => void mic.cancel()}><UiIcon name="close" size={11}/></button></>}
    <button type="button" className="tool mic-button" data-phase={m.phase} disabled={m.phase === 'transcribing'}
      aria-label={m.phase === 'recording' ? 'Stop and turn into text' : m.phase === 'transcribing' ? 'Turning speech into text' : 'Dictate'}
      title={m.phase === 'recording' ? 'Stop and turn into text' : m.phase === 'transcribing' ? 'Turning speech into text…' : 'Dictate (speech to text on this computer)'}
      onClick={() => void (m.phase === 'recording' ? mic.stop() : mic.start())}>
      {m.phase === 'recording' ? <UiIcon name="stop" size={11}/> : m.phase === 'transcribing' ? <span className="pulse" aria-hidden="true"/> : <UiIcon name="mic" size={14}/>}
    </button>
  </span>;
}

/** Where this conversation works: project, folder, git branch and repository. */
/** CHAT-PRO-02 F: "Export" — the conversation as a Markdown file, optionally with a summary of the tool calls. */
function ExportMenu({ client, conversationId, disabled }: { client: SessionClient; conversationId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setNote(null);
    const r = await exportConversation(client, conversationId, tools);
    setBusy(false);
    setNote(r.ok ? exportNote(r.file) : r.message);
  };
  return <span className="chat-export">
    <button type="button" className="tool chat-export-button" aria-expanded={open} aria-haspopup="dialog" title="Save this conversation as a Markdown file"
      onClick={() => { setOpen(v => !v); setNote(null); }}><UiIcon name="download" size={14}/><span>Export</span></button>
    {open && <div className="chat-export-pop" role="dialog" aria-label="Export this conversation" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
      <strong>Export as Markdown</strong>
      <label className="chat-export-check"><input type="checkbox" checked={tools} onChange={e => setTools(e.target.checked)}/> Include tool calls (collapsed summary)</label>
      <p className="chat-export-hint">Your messages and the agents' answers. Secret values such as keys and passwords are left out.</p>
      <div className="chat-export-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Preparing…' : 'Download .md'}</button>
        <button type="button" className="link-button" onClick={() => setOpen(false)}>Close</button>
      </div>
      {disabled && !note && <p className="chat-export-hint">The agent is still answering; the file has what is saved so far.</p>}
      {note && <p className="chat-export-note" role="status">{note}</p>}
    </div>}
  </span>;
}

function ProjectBar({ name, folder, repoUrl, git }: { name: string; folder: string | null; repoUrl: string | null; git: { branch: string | null; remote: string | null; dirty: boolean | null } | null }) {
  const home = folder?.match(/^\/Users\/[^/]+/)?.[0];
  const shortFolder = folder && home ? `~${folder.slice(home.length)}` : folder;
  const repo = repoUrl ?? git?.remote ?? null;
  const repoHref = repo && /^https:\/\//.test(repo) ? repo : null;
  return <div className="project-bar" aria-label="Project">
    <span className="project-bar-name"><UiIcon name="board" size={12}/>{name}</span>
    {shortFolder && <span className="project-bar-item" dir="ltr" title={folder ?? undefined}><UiIcon name="file" size={11}/>{shortFolder}</span>}
    {git?.branch && <span className="project-bar-item" dir="ltr" title={git.dirty ? 'Uncommitted changes' : 'Clean'}>⎇ {git.branch}{git.dirty ? <i className="project-dirty" aria-label="uncommitted changes"/> : null}</span>}
    {repo && (repoHref ? <a className="project-bar-item" href={repoHref} target="_blank" rel="noopener noreferrer" dir="ltr"><UiIcon name="globe" size={11}/>{repo.replace(/^https:\/\//, '')}</a>
      : <span className="project-bar-item" dir="ltr"><UiIcon name="globe" size={11}/>{repo}</span>)}
  </div>;
}

/** The user's message: right-aligned, pinned while its answer scrolls; long text folds. */
function UserMessage({ turn, onRemember, onKey, highlight }: { turn: Turn; onRemember?: () => void; onKey?: (id: string) => void; highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  // The pinned bubble stays short (3 lines) so the answer under it stays readable.
  const long = turn.content.length > 220 || turn.content.split('\n').length > 3;
  return <div className="chat-user" data-pending={turn.pending || undefined} data-message-id={turn.key} data-highlight={highlight || undefined}>
    <div className="user-bubble" data-folded={long && !open || undefined}>
      <p className="sr-only">You</p>
      <div className="turn-text" dir="auto">{splitSecrets(turn.content).map((p, i) => p.kind === 'text' ? p.text
        : <SecretChip key={i} type={p.type} id={p.id} onOpen={onKey}/>)}</div>
    </div>
    <div className="user-actions">
      {long && <button type="button" className="chat-more" onClick={() => setOpen(v => !v)}>{open ? 'Show less' : 'Show all'}</button>}
      {onRemember && <RememberButton onClick={onRemember}/>}
    </div>
  </div>;
}

/** CHAT-SECRETS-01: a secret of the message, kept in the key store; the chip opens the saved keys. */
function SecretChip({ type, id, onOpen }: { type: string; id: string; onOpen?: (id: string) => void }) {
  const label = `${secretLabel(type)} saved securely`;
  const body = <><UiIcon name="lock" size={11}/>{label}</>;
  return onOpen
    ? <button type="button" className="secret-chip" title="Stored encrypted in the key store. Open saved keys" onClick={() => onOpen(id)}>{body}</button>
    : <span className="secret-chip" title="Stored encrypted in the key store">{body}</span>;
}

/** One assistant turn: live parts in order while running; work folded once finished. */
function AssistantTurn({ turn, last, onRetry, writer, recovery, onSuggest, onRemember, proposals, highlight, recall, onWrongPlace }: { turn: Turn; last: boolean; onRetry?: () => void; writer?: string; recovery?: ReactNode; onSuggest?: (s: CardSuggestion) => void; onRemember?: (text: string) => void; proposals?: ReactNode; highlight?: boolean; recall?: ChatRecallController | null; onWrongPlace?: (m: { id: string; text: string; drawerId: string }) => void }) {
  const live = turn.status === 'running';
  const plan = turnPlan(turn.parts);
  const suggestions = turnSuggestions(turn.parts);
  const parts = plan || suggestions.length ? withoutPlan(turn.parts) : turn.parts;
  const { work, answer } = splitWork(parts);
  const tools = toolCount(parts);
  const answerText = answer.filter(p => p.kind === 'text').map(p => (p as { text: string }).text).join('');
  const [quiet, since] = useQuiet(turn, live);
  return <article className="chat-assistant" aria-busy={live || undefined} data-message-id={turn.key} data-highlight={highlight || undefined}>
    {writer ? <p className="reply-writer"><span className="avatar" aria-hidden="true">{writer.slice(0, 1).toUpperCase()}</span>{writer}</p> : <p className="sr-only">Agent</p>}
    {plan && <PlanCard steps={plan} live={live} status={turn.status}/>}
    {live
      ? <>{parts.map((p, i) => <PartView key={i} part={p} live last={i === parts.length - 1}/>)}
        {(quiet || parts.length === 0) && <WorkingRow since={since} label={parts.length ? 'Working' : 'Thinking'}/>}</>
      : <>
        {tools > 0
          ? <WorkedRow parts={work} ms={turn.durationMs}/>
          : work.map((p, i) => <PartView key={i} part={p}/>)}
        {answer.map((p, i) => <PartView key={`a${i}`} part={p}/>)}
        {turn.status === 'error' && <div className="chat-error" role="alert">
          <strong>{turn.code === 'run_interrupted' ? 'Work interrupted by restart' : turn.code === 'subscription_org_blocked' ? 'Claude subscription access is disabled' : turn.code === 'lmstudio_not_running' ? 'LM Studio is not running' : turn.code === 'local_model_missing' ? 'The local model is not installed' : turn.code === 'model_unavailable' ? 'The model could not be reached' : 'This reply failed'}</strong>
          <span>{turn.code === 'run_interrupted' ? 'Your request and tool checkpoints are saved. Continue safely after reviewing them; previous actions are not replayed automatically.' : turn.code === 'subscription_org_blocked' ? 'Your organization has disabled Claude Code subscription access. Ask its administrator to enable access, or choose another signed-in coding app.' : turn.code === 'lmstudio_not_running' ? 'Open LM Studio, load the model and start its local server (port 1234), then try again.' : turn.code === 'local_model_missing' ? 'This agent answers with a local model that is not on this computer. Pick an installed model or add a Claude key in Settings, then try again.' : turn.code === 'model_unavailable' ? 'Check that the model is running, then try again.' : 'Anything above was written before the failure.'}</span>
          {last && onRetry && <button type="button" className="chat-error-action" onClick={onRetry}><UiIcon name="refresh" size={12}/>{turn.code === 'run_interrupted' ? 'Continue safely' : 'Try again'}</button>}
        </div>}
        {suggestions.map((g, i) => <CardSuggestionView key={i} suggestion={g} onCreate={onSuggest}/>)}
        {proposals}
        {recovery}
        <TurnFooter text={answerText || turn.content} ms={turn.durationMs} stopped={turn.status === 'stopped'} onRemember={onRemember} recall={recall ? <RecallChip c={recall} turn={turn}/> : null}/>
        {recall && <RecallPanel c={recall} turnKey={turn.key} onWrongPlace={onWrongPlace}/>}
      </>}
  </article>;
}

/** An agent's suggestion to put the task on the board; only the owner creates the card. */
function CardSuggestionView({ suggestion, onCreate }: { suggestion: CardSuggestion; onCreate?: (s: CardSuggestion) => void }) {
  return <section className="card-suggestion" aria-label="Suggested board card">
    <UiIcon name="board" size={13}/>
    <span className="card-suggestion-text"><span className="card-suggestion-label">Suggested card</span><strong dir="auto">{suggestion.title}</strong>
      {suggestion.agents.length > 0 && <small>for {suggestion.agents.join(', ')}</small>}</span>
    {onCreate ? <button type="button" className="ghost-action strong" onClick={() => onCreate(suggestion)}>Review and create</button> : <small>The owner decides.</small>}
  </section>;
}

type CardFormSeed = { title: string; description: string; agents: string[]; priority: Priority; key: number };

/** "Add to board": pick a board and column, the title, the description and the agents the task needs. */
function ChatCardForm({ controller, seed, agents, onClose }: { controller: ChatCardsController; seed: CardFormSeed; agents: readonly { id: string; name: string }[]; onClose: () => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [boardId, setBoardId] = useState('');
  const [columnId, setColumnId] = useState('');
  const [title, setTitle] = useState(seed.title);
  const [description, setDescription] = useState(seed.description);
  const [picked, setPicked] = useState<string[]>(seed.agents);
  const [priority, setPriority] = useState<Priority>(seed.priority);
  useEffect(() => { void controller.loadBoards().then(id => { if (id) setBoardId(b => b || id); }); }, [controller]);
  useEffect(() => { if (st.columns.length && !st.columns.some(c => c.id === columnId)) setColumnId((st.columns.find(c => c.name.toLowerCase() === 'to do') ?? st.columns[0]).id); }, [st.columns, columnId]);
  const submit = async () => { if (await controller.create({ boardId, columnId: columnId || undefined, title, description, priority, agents: picked })) onClose(); };
  return <form className="chat-card-form" aria-label="Add this task to a board" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <div className="chat-card-form-head"><UiIcon name="board" size={14}/><strong>Add this task to a board</strong>
      <button type="button" className="row-tool" aria-label="Close" onClick={onClose}><UiIcon name="close" size={12}/></button></div>
    <div className="chat-card-form-row">
      <label>Board<select value={boardId} onChange={e => { setBoardId(e.target.value); setColumnId(''); void controller.pickBoard(e.target.value); }} disabled={!st.boards.length}>
        {st.boards.length ? st.boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>) : <option value="">Reading the boards…</option>}</select></label>
      <label>Column<select value={columnId} onChange={e => setColumnId(e.target.value)} disabled={!st.columns.length}>
        {st.columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Priority<select value={priority} onChange={e => setPriority(e.target.value as Priority)}>
        {(['low', 'normal', 'high', 'urgent'] as const).map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></label>
    </div>
    <label>Title<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} dir="auto" required/></label>
    <label>Description<textarea value={description} rows={3} maxLength={5000} onChange={e => setDescription(e.target.value)} dir="auto"/></label>
    {agents.length > 0 && <fieldset className="chat-card-agents"><legend>Agents it needs</legend>
      {agents.map(a => <label key={a.id} className="chat-card-agent"><input type="checkbox" checked={picked.includes(a.id)} onChange={e => setPicked(p => e.target.checked ? [...p, a.id] : p.filter(x => x !== a.id))}/>
        <span className="avatar" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>{a.name}</label>)}</fieldset>}
    {st.notice && <p className="chat-card-notice" role="status">{st.notice}</p>}
    <div className="chat-card-form-actions">
      <span className="fine-print">The card links back to this chat; its moves and comments show up here.</span>
      <button type="button" className="ghost-action" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary" disabled={st.saving || !boardId || !title.trim()}>{st.saving ? 'Adding…' : 'Add card'}</button>
    </div>
  </form>;
}

/** The board cards made from this conversation: column, agents and their progress, newest board activity. */
function ChatCards({ controller, nameOf, onOpen }: { controller: ChatCardsController; nameOf: (agentId: string) => string; onOpen?: (boardId: string, cardId: string) => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!st.owner || !st.cards.length) return null;
  return <>{st.cards.map(c => <ChatCardBlock key={c.id} card={c} progress={st.progress} nameOf={nameOf} onOpen={onOpen}/>)}</>;
}

function ChatCardBlock({ card, progress, nameOf, onOpen }: { card: ChatCard; progress: ChatProgress; nameOf: (agentId: string) => string; onOpen?: (boardId: string, cardId: string) => void }) {
  const [open, setOpen] = useState(false);
  const status = card.archived ? 'archived' : card.done ? 'done' : 'open';
  const people = card.agents.map(id => ({ id, p: progress.agents.find(a => a.agentId === id) }));
  const recent = open ? card.activity : card.activity.slice(-3);
  return <section className="chat-card-block" data-status={status} aria-label={`Board card ${card.title}`}>
    <div className="chat-card-head">
      <UiIcon name="board" size={13}/>
      <span className="chat-card-where">{card.boardName} · <b>{card.archived ? 'Archived' : card.column}</b></span>
      {card.done && !card.archived && <span className="chat-card-badge">Done</span>}
      {onOpen && !card.archived && <button type="button" className="ghost-action strong" onClick={() => onOpen(card.boardId, card.id)}>Open card</button>}
    </div>
    <p className="chat-card-title" dir="auto">{card.title}</p>
    {people.length > 0 && <ul className="chat-card-people" aria-label="Agents on this card">{people.map(({ id, p }) =>
      <li key={id} data-running={p?.running || undefined}>
        <span className="avatar" aria-hidden="true">{nameOf(id).slice(0, 1).toUpperCase()}</span>
        <span>{nameOf(id)}</span>
        <small>{p?.running ? (p.plan?.active ? `working: ${p.plan.active}` : 'working now')
          : p?.plan ? `plan ${p.plan.done} of ${p.plan.total}` : p?.replies ? `${p.replies} ${p.replies === 1 ? 'reply' : 'replies'}` : 'not started'}</small>
        {p?.plan && p.plan.total > 0 && <span className="plan-bar" aria-hidden="true"><i style={{ inlineSize: `${Math.round((p.plan.done / p.plan.total) * 100)}%` }}/></span>}
      </li>)}</ul>}
    {(card.checklist.total > 0 || card.comments > 0) && <p className="chat-card-meta">
      {card.checklist.total > 0 && <span>Checklist {card.checklist.done}/{card.checklist.total}</span>}
      {card.comments > 0 && <span>{card.comments} {card.comments === 1 ? 'comment' : 'comments'}</span>}</p>}
    {recent.length > 0 && <ol className="chat-card-activity" aria-label="Board updates">{recent.map(a =>
      <li key={a.id} data-kind={a.kind}><span dir="auto">{activityLine(a, nameOf)}</span><time>{a.createdAt.slice(5, 16).replace('T', ' ')}</time></li>)}</ol>}
    {card.activity.length > 3 && <button type="button" className="ghost-action" onClick={() => setOpen(v => !v)}>{open ? 'Fewer updates' : `All ${card.activity.length} updates`}</button>}
  </section>;
}

/** The agent's task plan as a live checklist; folds to one line once every step is done. */
function PlanCard({ steps, live, status }: { steps: readonly PlanStep[]; live: boolean; status: Turn['status'] }) {
  const done = steps.filter(s => s.status === 'done').length;
  const counted = steps.filter(s => s.status !== 'skipped').length;
  const finished = !live && steps.every(s => s.status === 'done' || s.status === 'skipped');
  const [open, setOpen] = useState(!finished);
  // Fold once the run ends with every step done (the owner can open it again).
  useEffect(() => { if (finished) setOpen(false); }, [finished]);
  const halted = !live && status !== 'complete';
  const active = steps.find(s => s.status === 'active');
  return <section className="plan-card" aria-label="Task plan" data-live={live || undefined}>
    <button type="button" className="plan-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <UiIcon name="check" size={12}/>
      <span className="plan-title">{finished ? 'Plan done' : 'Plan'}</span>
      <span className="plan-count">{done} of {counted}</span>
      <span className="plan-bar" aria-hidden="true"><i style={{ inlineSize: `${counted ? Math.round((done / counted) * 100) : 0}%` }}/></span>
      {!open && active && <span className="plan-now" dir="auto">{active.title}</span>}
      <span className="plan-chevron" aria-hidden="true"><UiIcon name="chevron" size={10}/></span>
    </button>
    {open && <ol className="plan-steps">{steps.map((s, i) => {
      const state = s.status === 'active' && halted ? 'halted' : s.status;
      return <li key={i} data-status={state}>
        <span className="plan-mark" aria-hidden="true">{state === 'done' ? <UiIcon name="check" size={10}/> : state === 'active' ? <i className="plan-spin"/> : null}</span>
        <span className="plan-step" dir="auto">{s.title}</span>
        <span className="sr-only">{state === 'done' ? 'done' : state === 'active' ? 'in progress' : state === 'halted' ? 'stopped here' : state === 'skipped' ? 'skipped' : 'to do'}</span>
      </li>;
    })}</ol>}
  </section>;
}

/** True when a live turn produced nothing for QUIET_MS; returns when that quiet began. */
function useQuiet(turn: Turn, live: boolean): [boolean, number] {
  const [quiet, setQuiet] = useState(false);
  const [since, setSince] = useState(() => turn.startedAt ?? Date.now());
  useEffect(() => {
    if (!live) { setQuiet(false); return; }
    setQuiet(false); const t0 = Date.now(); setSince(t0);
    const timer = setTimeout(() => setQuiet(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [turn.lastSeq, live]);
  return [quiet, since];
}

function PartView({ part, live = false, last = false }: { part: Part; live?: boolean; last?: boolean }) {
  if (part.kind === 'text') return part.text ? <div className="chat-prose turn-text md-host"><Markdown text={part.text}/></div> : null;
  if (part.kind === 'reasoning') return part.text.trim() ? <Thinking part={part} live={live && last && part.endedAt === undefined}/> : null;
  return <ToolStep calls={part.calls} live={live}/>;
}

function Thinking({ part, live }: { part: Extract<Part, { kind: 'reasoning' }>; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const shown = open ?? live;
  useLayoutEffect(() => { if (live && body.current) body.current.scrollTop = body.current.scrollHeight; }, [part.text, live]);
  const secs = part.startedAt !== undefined && part.endedAt !== undefined ? Math.round((part.endedAt - part.startedAt) / 1000) : undefined;
  const label = live ? 'Thinking' : secs === undefined ? 'Thought' : secs < 1 ? 'Thought briefly' : `Thought for ${duration(secs * 1000)}`;
  return <div className="scaffold thinking" data-open={shown || undefined}>
    <button type="button" className="scaffold-row" aria-expanded={shown} onClick={() => setOpen(!shown)}>
      <UiIcon name="brain" size={12}/><span className={live ? 'shimmer' : undefined}>{label}</span>
      {live && part.startedAt !== undefined && <Elapsed since={part.startedAt}/>}
      <span className="caret" aria-hidden="true"><UiIcon name="chevron" size={11}/></span>
    </button>
    {shown && <div ref={body} className="thinking-body" data-live={live || undefined} dir="auto"><Markdown text={part.text}/></div>}
  </div>;
}

/** One model step's tool calls; in a long live step the older rows fold under a count. */
function ToolStep({ calls, live }: { calls: readonly ToolCall[]; live: boolean }) {
  const [all, setAll] = useState(false);
  const hidden = live && !all && calls.length > LIVE_ROWS ? calls.length - LIVE_ROWS : 0;
  return <div className="scaffold tool-step">
    {hidden > 0 && <button type="button" className="scaffold-row muted" onClick={() => setAll(true)}>{hidden} earlier {hidden === 1 ? 'step' : 'steps'}</button>}
    {calls.slice(hidden).map(c => <ToolRow key={c.id} call={c}/>)}
  </div>;
}

const KIND_ICON: Record<ToolKind, UiIconName> = { command: 'terminal', read: 'file', write: 'file', edit: 'pencil', search: 'search', web: 'globe', browser: 'globe', memory: 'brain', board: 'board', other: 'tool' };

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const v = toolView(call);
  const hasDetail = !!(call.output || call.input.length > 2);
  return <div className="tool-row" data-error={call.isError || undefined} data-open={open || undefined}>
    {(() => { const Row = hasDetail ? 'button' : 'div'; return <Row {...(hasDetail ? { type: 'button' as const, 'aria-expanded': open, onClick: () => setOpen(v => !v) } : {})} className="scaffold-row" data-static={hasDetail ? undefined : true}>
      {call.running ? <span className="spinner" aria-hidden="true"/> : <UiIcon name={call.isError ? 'alert' : KIND_ICON[v.kind]} size={12}/>}
      <span className="tool-title"><span className={call.running ? 'shimmer' : 'tool-verb'}>{v.verb}</span>{v.target && <span className="tool-target" dir="auto">{v.kind === 'command' ? <code>{v.target}</code> : v.target}</span>}</span>
      {call.isError && <span className="tool-meta error">failed</span>}
      {!call.running && call.ms !== undefined && call.ms >= 100 && <span className="tool-meta">{duration(call.ms) === '0s' ? `${(call.ms / 1000).toFixed(1)}s` : duration(call.ms)}</span>}
      {hasDetail && <span className="caret" aria-hidden="true"><UiIcon name="chevron" size={11}/></span>}
    </Row>; })()}
    {open && <ToolDetail call={call} kind={v.kind} command={v.command} args={v.args}/>}
  </div>;
}

function ToolDetail({ call, kind, command, args }: { call: ToolCall; kind: ToolKind; command?: string; args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([k]) => !(kind === 'command' && ['command', 'cmd'].includes(k)));
  return <div className="tool-detail">
    {kind === 'command' && command && <pre className="tool-cmd" dir="ltr"><span aria-hidden="true">$ </span>{command}</pre>}
    {entries.length > 0 && <dl className="tool-args">{entries.slice(0, 12).map(([k, val]) =>
      <div key={k}><dt>{k}</dt><dd dir="auto">{typeof val === 'string' ? val.slice(0, 400) : JSON.stringify(val).slice(0, 400)}</dd></div>)}</dl>}
    {call.output !== undefined && <div className="tool-output">
      <div className="tool-output-head"><span>{call.isError ? 'Error' : 'Output'}</span><Copy text={call.output} label="Copy output"/></div>
      <pre dir="ltr">{call.output || '(no output)'}</pre>
    </div>}
    {call.running && <p className="tool-running">Running…</p>}
  </div>;
}

function WorkedRow({ parts, ms }: { parts: Part[]; ms: number | null }) {
  const [open, setOpen] = useState(false);
  const summary = workSummary(parts);
  return <div className="scaffold worked" data-open={open || undefined}>
    <button type="button" className="scaffold-row" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <UiIcon name="tool" size={12}/><span>{ms !== null ? `Worked for ${duration(ms)}` : 'Worked'}</span>
      {summary && <span className="worked-summary">· {summary}</span>}
      <span className="caret" aria-hidden="true"><UiIcon name="chevron" size={11}/></span>
    </button>
    {open && <div className="worked-body">{parts.map((p, i) => <PartView key={i} part={p}/>)}</div>}
  </div>;
}

function WorkingRow({ since, label }: { since: number; label: string }) {
  return <p className="scaffold working" role="status"><span className="pulse" aria-hidden="true"/><span className="shimmer">{label}</span><Elapsed since={since}/></p>;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="elapsed">{s >= 1 ? duration(s * 1000) : ''}</span>;
}

function TurnFooter({ text, ms, stopped, onRemember, recall }: { text: string; ms: number | null; stopped: boolean; onRemember?: (text: string) => void; recall?: ReactNode }) {
  return <div className="turn-actions">
    {recall}
    {stopped && <span className="turn-chip">Stopped</span>}
    {ms !== null && <span className="turn-time" title={`This reply took ${duration(ms)}`}>{duration(ms)}</span>}
    {text && <Copy text={text} label="Copy reply"/>}
    {text && onRemember && <RememberButton onClick={() => onRemember(text)}/>}
  </div>;
}

function RememberButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="ghost-action" aria-label="Remember this" title="Remember this (⌘⇧R)" onClick={onClick}><UiIcon name="brain" size={13}/></button>;
}

type RememberSeed = { ref: { messageId: string } | { runId: string }; text: string; key: number };
const TYPE_CHOICES: { value: RememberType; label: string }[] = [
  { value: 'fact', label: 'Fact' }, { value: 'preference', label: 'Preference' }, { value: 'context', label: 'Context' }, { value: 'insight', label: 'Insight' },
  { value: 'event', label: 'Event' }, { value: 'task', label: 'Task' }, { value: 'skill', label: 'Skill' }, { value: 'relationship', label: 'Relationship' },
];

/** "Remember this": the message text (editable) and the drawer it goes to. */
export function RememberForm({ controller, seed, project, agent, onClose }: { controller: ChatMemoryController; seed: RememberSeed; project: string | null; agent: string; onClose: () => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [text, setText] = useState(seed.text);
  const [drawer, setDrawer] = useState<RememberDrawer>(project ? 'project' : 'owner');
  const [type, setType] = useState<RememberType>('fact');
  const [importance, setImportance] = useState(7);
  const left = MAX_REMEMBER - [...text].length;
  const save = async () => { if (await controller.remember({ ...seed.ref, content: text, drawer, type, importance })) onClose(); };
  return <form className="chat-card-form remember-form" aria-label="Remember this" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="chat-card-form-head"><UiIcon name="brain" size={13}/><strong>Remember this</strong>
      <button type="button" className="row-tool" aria-label="Close" onClick={onClose}><UiIcon name="close" size={11}/></button></div>
    <label className="field"><span>What to remember <small className="muted">(edit it to keep only what matters)</small></span>
      <textarea rows={Math.min(8, Math.max(3, text.split('\n').length + 1))} value={text} dir="auto" onChange={e => setText(e.target.value)} autoFocus/></label>
    <div className="chat-card-form-row">
      <label className="field"><span>Drawer</span>
        <select value={drawer} onChange={e => setDrawer(e.target.value as RememberDrawer)}>
          {project && <option value="project">Project: {project}</option>}
          <option value="owner">About you</option>
          <option value="experience">{agent}'s lessons</option>
        </select></label>
      <label className="field"><span>Type</span>
        <select value={type} onChange={e => setType(e.target.value as RememberType)}>{TYPE_CHOICES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
      <label className="field"><span>Importance {importance}</span><input type="range" min={1} max={10} value={importance} onChange={e => setImportance(Number(e.target.value))}/></label>
    </div>
    {st.notice && <p className="card-notice" role="alert">{st.notice}</p>}
    <div className="remember-actions">
      <span className={left < 0 ? 'attach-error' : 'muted'}>{left < 0 ? `${-left} characters too long` : `${left} characters left`} · secrets are left out</span>
      <button type="submit" className="primary" disabled={st.saving || !text.trim() || left < 0}>{st.saving ? 'Saving…' : 'Save to memory'}</button>
      <button type="button" className="ghost" onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

const STATUS_LABEL: Record<ChatMemory['status'], string> = { saved: 'Saved', removed: 'Removed from memory', pending: 'Waiting for you', rejected: 'Not saved', stale: 'Out of date', cancelled: 'Withdrawn' };

/** An agent's memory proposals under its reply: Accept or Reject (never saved by itself). */
export function MemoryProposals({ controller, items }: { controller: ChatMemoryController; items: readonly ChatMemory[] }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!items.length) return null;
  return <>{items.map(m => {
    const live = st.memories.find(x => x.id === m.id) ?? m;
    const review = live.proposalId ? st.reviews[live.proposalId] : undefined;
    return <section key={m.id} className="memory-proposal" data-status={live.status} aria-label="Memory suggested by the agent">
      <UiIcon name="brain" size={13}/>
      <span className="card-suggestion-text"><span className="card-suggestion-label">Remember this? · {drawerLabel(drawerRef(review?.drawerId ?? live.drawerId))}</span>
        <span className="memory-proposal-text" dir="auto">{review?.text ?? live.text}</span></span>
      {live.status === 'pending'
        ? <span className="memory-proposal-actions">
          <button type="button" className="ghost-action strong" disabled={!!st.deciding || !review} onClick={() => void controller.decide(live, 'approve')}>{st.deciding === live.proposalId ? '…' : 'Accept'}</button>
          <button type="button" className="ghost-action" disabled={!!st.deciding || !review} onClick={() => void controller.decide(live, 'reject')}>Reject</button></span>
        : <small className="turn-chip">{STATUS_LABEL[live.status]}</small>}
    </section>;
  })}</>;
}

/** The side panel list: what this conversation put into memory, each opening on the Memory page. */
export function ChatMemoryCard({ controller, onOpen }: { controller: ChatMemoryController; onOpen?: (drawerId: string, memoryId: string) => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!st.owner) return null;
  const items = [...st.memories].reverse();
  return <section className="panel-card" aria-label="Memory from this chat">
    <h3>Memory from this chat</h3>
    {items.length === 0 ? <p className="muted">Use the brain button on a message to remember it. Memories the agent suggests wait here for you.</p>
      : <ul className="panel-memories">{items.slice(0, 30).map(m => <li key={m.id} data-status={m.status}>
        <span className="panel-memory-text" dir="auto" title={m.text}>{m.text}</span>
        <span className="panel-memory-meta">{drawerLabel(drawerRef(m.drawerId))} · {m.kind === 'proposed' ? 'suggested by the agent' : 'remembered'} · {STATUS_LABEL[m.status]}
          {m.status === 'saved' && m.memoryId && onOpen && <> · <button type="button" className="link-button" onClick={() => onOpen(m.drawerId, m.memoryId!)}>Open in Memory</button></>}</span>
      </li>)}</ul>}
  </section>;
}

const drawerRef = (id: string) => { const i = id.indexOf(':'); return (i < 0 ? { kind: id } : { kind: id.slice(0, i), key: id.slice(i + 1) }) as { kind: 'owner' }; };
const noopSubscribe = () => () => {};
const nullSnapshot = () => undefined;

function Copy({ text, label }: { text: string; label: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = () => {
    const done = (s: 'done' | 'failed') => { setState(s); setTimeout(() => setState('idle'), 1500); };
    if (!navigator.clipboard) { done('failed'); return; }
    navigator.clipboard.writeText(text).then(() => done('done'), () => done('failed'));
  };
  return <button type="button" className="ghost-action" aria-label={state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label} onClick={copy}>
    <UiIcon name={state === 'done' ? 'check' : 'copy'} size={13}/>
  </button>;
}
/** Whether the chat avatar is shown; one shared value for every chat view, kept in memory for this session (no browser storage). */
const avatarShown = (() => {
  let on = false; const listeners = new Set<() => void>();
  return { get: () => on, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, toggle: () => { on = !on; listeners.forEach(listener => listener()); } };
})();
