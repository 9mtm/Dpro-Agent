import {AppsWorkspace} from './AppsWorkspace';
import {SpecialtyLibrary} from './SpecialtyLibrary';
import {NewChatDialog} from './NewChatDialog';
import {usePendingApprovalCount} from './ApprovalPage';
import {ApprovalsWorkspace} from './HumanReviewsPage';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { SessionClient } from './session';
import { displayName } from './session';
import { ConversationsController } from './conversations';
import { ChatView } from './ChatView';
import { ConversationList } from './ConversationList';
import { AgentsDestination } from './AgentsDestination';
import { BoardController } from './board';
import { TaskBoard } from './TaskBoard';
import { GenVRPage } from './GenVRPage';
import type {SettingsTab} from './AppSettings';
import { AppSettings } from './AppSettings';
import { useAppNavigation, useAppTheme } from './app-navigation';
import { AccountPanel } from './SessionPanels';
import { MemoryWindow } from './MemoryDesktop';
import type { MemoryFocus, SettingsTarget } from './MemoryDesktop';
import type { MemorySettingsPane } from './MemorySettings';
import { McpSection, SkillsSection, TerminalSection } from './ToolSections';
import { Icon } from './icons';
import type { IconName } from './icons';
import { UiIcon } from './ui-icons';
import { CommandPalette } from './CommandPalette';
import { ChatSearchController } from './chat-search';
import type { Command } from './CommandPalette';

type Page = 'apps' | 'approvals' | 'chat' | 'genvr' | 'agents' | 'board' | 'memory' | 'skills' | 'mcp' | 'terminal' | 'account' | 'settings' | 'about' | 'specialties';
/** Sections that own the sidebar with their own places (the chat list shows only in Chat). */
const OWN_SIDEBAR: ReadonlyArray<Page> = ['memory', 'settings', 'agents', 'skills', 'mcp', 'terminal','specialties','board','approvals','apps'];
const pages: ReadonlyArray<{ key: Page; label: string; icon: IconName | 'board' }> = [
  { key: 'chat', label: 'Chat', icon: 'message-circle' },
  { key: 'agents', label: 'Agents', icon: 'user' },
  { key: 'board', label: 'Board', icon: 'board' },
  { key: 'approvals', label: 'Approvals', icon: 'clock' },
  { key: 'memory', label: 'Memory', icon: 'database' },
  { key: 'genvr', label: 'GenVR', icon: 'dice' },
  { key: 'apps', label: 'Apps', icon: 'settings' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * The signed-in workspace: one left sidebar owned by the open section (the
 * chat list in Chat; Memory, Settings, Agents, Skills, MCP connections and
 * Terminal show their own places in it), every page in the status bar, the
 * page area and a status bar. Every page
 * stays mounted and only the active one is shown, so a conversation or an
 * unsaved agent draft survives switching pages.
 */
export function SignedInShell({ client, notice }: { client: SessionClient; notice: ReactNode }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [page, setPage] = useState<Page>('chat');
  const appearance = useAppTheme();
  const theme = appearance.theme;
  const setTheme = (fn: (v: 'light' | 'dark') => 'light' | 'dark') => appearance.setPreference(fn(theme));
  useAppNavigation(destination => setPage(destination === 'home' ? 'chat' : destination));
  const [chat, setChat] = useState<ConversationsController>();
  useEffect(() => { const c = new ConversationsController(client); setChat(c); void c.load(); return () => c.dispose(); }, [client]);
  // CHAT-PRO-02 D: search inside the chats (the sidebar box and the ⌘K box each keep their own).
  const [search, setSearch] = useState<{ side: ChatSearchController; palette: ChatSearchController }>();
  useEffect(() => { const s = { side: new ChatSearchController(client), palette: new ChatSearchController(client) }; setSearch(s); return () => { s.side.dispose(); s.palette.dispose(); }; }, [client]);
  const [board, setBoard] = useState<BoardController>();
  useEffect(() => { const b = new BoardController(client); setBoard(b); return () => b.dispose(); }, [client]);
  const chatState = useSyncExternalStore(
    chat ? chat.subscribe : noopSubscribe,
    chat ? chat.getSnapshot : nullSnapshot,
    chat ? chat.getSnapshot : nullSnapshot);
  const user = state.user!;
  const pendingApprovals=usePendingApprovalCount(client,user.role==='owner');
  const approvalLabel=pendingApprovals.count?`Approvals · ${pendingApprovals.count===100?'100+':pendingApprovals.count}`:'Approvals';
  const mode = state.mode === 'mock' ? 'mock' : 'live';
  const [rail, setRail] = useState(true);
  const [palette, setPalette] = useState(false);
  const [choosingChat,setChoosingChat]=useState(false);
  const [settingsTab,setSettingsTab]=useState<SettingsTab>('general');
  const [memoryPane,setMemoryPane]=useState<MemorySettingsPane>('rules');
  const [slot,setSlot]=useState<HTMLElement|null>(null);
  const ownSidebar=OWN_SIDEBAR.includes(page);
  const [settingsVisit,setSettingsVisit]=useState(0);
  const [terminalRequest,setTerminalRequest]=useState(0);
  const openSettings=(tab:SettingsTab)=>{if(tab==='specialties'||tab==='skills'||tab==='mcp'){setPage(tab);return;}setSettingsTab(tab);setSettingsVisit(n=>n+1);setPage('settings');};
  const openTerminal=()=>{if(user.role!=='owner')return;setTerminalRequest(n=>n+1);setPage('chat');};
  const openMemorySettings=(target:SettingsTarget)=>{setMemoryPane(target);setSettingsTab('memory');setSettingsVisit(n=>n+1);setPage('settings');};
  const tools=[
    {id:'genvr',label:'GenVR',icon:<Icon name="dice"/>,run:()=>setPage('genvr')},
    ...(user.role==='owner'?[
      {id:'terminal',label:'Terminal',icon:<UiIcon name="terminal" size={14}/>,run:()=>setPage('terminal')},
      {id:'skills',label:'Skills',icon:<UiIcon name="file" size={14}/>,run:()=>setPage('skills')},
      {id:'specialties',label:'Specialties',icon:<Icon name="user"/>,run:()=>setPage('specialties')},
      {id:'mcp',label:'MCP connections',icon:<UiIcon name="tool" size={14}/>,run:()=>setPage('mcp')},
    ]:[]),
  ];
  const [agentFocus,setAgentFocus]=useState<{id:string;n:number}|null>(null);
  const [connectorsFocus, setConnectorsFocus] = useState(0);
  const [memoryFocus, setMemoryFocus] = useState<MemoryFocus | null>(null);
  const boardState = useSyncExternalStore(board ? board.subscribe : noopSubscribe, board ? board.getSnapshot : nullSnapshot, board ? board.getSnapshot : nullSnapshot);
  // ⌘K / Ctrl+K opens the command box anywhere in the workspace; ⌘, / Ctrl+, opens Settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(v => !v); }
      else if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setPage('settings'); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const newChat = () => {setChoosingChat(true);setPage('chat');};
  const commands: Command[] = [
    ...pages.filter(p=>p.key!=='genvr'&&(p.key!=='approvals'||user.role!=='guest')).map(p => ({ id: `go-${p.key}`, group: 'Go to', label: p.key==='approvals'?approvalLabel:p.label, icon:p.icon==='board'?<UiIcon name="board" size={14}/>:<Icon name={p.icon}/>, run: () => setPage(p.key) })),
    ...tools.map(t=>({...t,id:'tool-'+t.id,group:'Tools',keywords:t.id==='specialties'?'agent templates':t.id==='skills'?'skill abilities':t.id==='terminal'?'console shell':t.id==='genvr'?'spaces worlds':'connectors'})),
    ...(user.role==='owner'?[{id:'scheduled-tasks',group:'Settings',label:'Scheduled tasks',keywords:'schedule cron automation paused active',icon:<UiIcon name="clock" size={14}/>,run:()=>openSettings('schedules')}]:[]),
    { id: 'new-chat', group: 'Actions', icon:<UiIcon name="compose" size={14}/>, label: 'New chat', run: newChat },
    ...(chatState?.conversations ?? []).slice(0, 30).map(c => ({ id: `chat-${c.id}`, group: 'Conversations', icon:<Icon name="message-circle"/>, label: c.title || c.preview || 'New chat', run: () => { void chat?.open(c.id); setPage('chat'); } })),
    { id: 'theme', group: 'Actions', icon:<UiIcon name={theme==='dark'?'sun':'moon'} size={14}/>, label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: () => setTheme(t => t === 'dark' ? 'light' : 'dark') },
    { id: 'rail', group: 'Actions', icon:<UiIcon name="sidebar" size={14}/>, label: rail ? 'Hide the sidebar' : 'Show the sidebar', run: () => setRail(v => !v) },
  ];
  const active = chatState?.conversations.find(c => c.id === chatState.activeId);
  const pageTitle = page === 'specialties'?'Specialties':page === 'chat' && active ? (active.title || 'Chat') : page === 'skills' ? 'Skills' : page === 'mcp' ? 'MCP connections' : page === 'terminal' ? 'Terminal' : pages.find(p => p.key === page)?.label ?? '';
  const openCards = boardState?.boards.reduce((a, b) => a + b.cards, 0);

  const sidebarShown = rail && (page === 'chat' || ownSidebar);
  return <div className="shell app-shell" data-theme={theme} data-rail={sidebarShown ? 'open' : 'closed'} data-section={page} lang="en" dir="ltr">
    {choosingChat&&chat&&<NewChatDialog controller={chat} onClose={()=>setChoosingChat(false)}/>}
    <header className="titlebar">
      <div className="titlebar-tools">
        <button type="button" className="tool" aria-label={rail ? 'Hide the sidebar' : 'Show the sidebar'} title={rail ? 'Hide the sidebar' : 'Show the sidebar'} aria-pressed={rail} onClick={() => setRail(v => !v)}><UiIcon name="sidebar" size={14}/></button>
        {page === 'chat' && <button type="button" className="tool" aria-label="New chat" title="New chat" onClick={newChat}><UiIcon name="compose" size={14}/></button>}
      </div>
      <p className="titlebar-title">{pageTitle}</p>
      <div className="titlebar-tools end">
        <button type="button" className="titlebar-cmdk" onClick={() => setPalette(true)} aria-label="Commands (⌘K)"><UiIcon name="search" size={13}/>Commands<kbd>⌘K</kbd></button>
        <button type="button" className="tool" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} aria-label="Switch theme" title="Switch theme"><UiIcon name={theme === 'dark' ? 'sun' : 'moon'} size={14}/></button>
      </div>
    </header>
    <aside className="sidebar">
      {/* The open section owns the sidebar: the chat list only in Chat; other sections render their places into the slot. */}
      <div className="section-sidebar" ref={setSlot} hidden={page === 'chat'}/>
      {page === 'chat' && <><button className="nav-item new-chat" onClick={newChat}>
        <UiIcon name="compose" size={15}/>New chat
      </button>
      <p className="section-label"><span className="checker" aria-hidden="true"/>Conversations</p>
      <div className="session-list">
        {chat && <ConversationList controller={chat} search={user.role === 'guest' ? undefined : search?.side} onOpen={() => setPage('chat')}/>}
      </div></>}
      <div className="sidebar-footer">
        <details className="account-menu"><summary className="user-chip" title="Account">
          <span className="avatar" aria-hidden="true">{(displayName(user) || '?').slice(0, 1).toUpperCase()}</span>
          <span className="user-name"><bdi>{displayName(user)}</bdi><small>{user.role}</small></span>
        </summary><div><button onClick={() => setPage('account')}>Account & sessions</button><button onClick={() => setPage('settings')}>Settings</button><button onClick={() => client.cancel()}>Sign out on this device</button></div></details>
        <button type="button" className="tool sidebar-settings" aria-label="Settings" title="Settings" onClick={() => setPage('settings')}><Icon name="settings"/></button>
      </div>
    </aside>
    <main id="content" className="page-area">
      {notice && <p className="page-notice" role="status">{notice}</p>}
      <section className="page page-chat" aria-label="Chat" hidden={page !== 'chat'}>
        {chat ? <ChatView active={page === 'chat'} onChooseContext={newChat} terminalRequest={terminalRequest} controller={chat} mode={mode} client={client} onAddConnector={() => setPage('mcp')}
          onOpenCard={(boardId, cardId) => { setPage('board'); void board?.reveal(boardId, cardId); }}
          onOpenMemory={(drawerId, memoryId) => { setMemoryFocus(f => ({ drawerId, memoryId, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/> : null}
      </section>
      <section className="page page-agents" hidden={page !== 'agents'}><AgentsDestination key={`agents-${connectorsFocus}`} client={client} active={page === 'agents'} sidebarSlot={slot} focusConnectors={connectorsFocus > 0} focusAgent={agentFocus} onOpenMemory={agentId => { if (agentId) setMemoryFocus(f => ({ scope: `agent:${agentId}`, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/></section>
      <section className="page page-board" hidden={page !== 'board'}>{board && <TaskBoard controller={board} sidebarSlot={slot} active={page === 'board'} onOpenChat={id => { void chat?.open(id); setPage('chat'); }}/>}</section>
      {user.role!=='guest'&&<section className="page page-approvals" hidden={page!=='approvals'}><ApprovalsWorkspace client={client} active={page==='approvals'} slot={slot} onDecision={pendingApprovals.reload} onAccount={()=>setPage('account')}/></section>}
      <section className="page page-ui mem-desk" hidden={page !== 'memory'}><MemoryWindow client={client} active={page === 'memory'} focus={memoryFocus} sidebarSlot={slot} onOpenChat={id => { void chat?.open(id); setPage('chat'); }} onOpenSettings={openMemorySettings}/></section>
      {user.role === 'owner' && <>
        <section className="page page-specialties" hidden={page !== 'specialties'}><SpecialtyLibrary client={client} active={page==='specialties'} sidebarSlot={slot} onOpenAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}} onOpenConnections={()=>setPage('mcp')}/></section>
        <section className="page page-skills mem-desk" hidden={page !== 'skills'}><SkillsSection client={client} active={page === 'skills'} slot={slot} onOpenAgents={()=>setPage('agents')}/></section>
        <section className="page page-mcp mem-desk" hidden={page !== 'mcp'}><McpSection client={client} active={page === 'mcp'} slot={slot} onOpenAgents={()=>setPage('agents')}/></section>
        <section className="page page-ui mem-desk" hidden={page !== 'terminal'}><TerminalSection client={client} active={page === 'terminal'} slot={slot} onOpenTerminal={openTerminal}/></section>
      </>}
      <section className="page page-apps" hidden={page!=='apps'}><AppsWorkspace client={client} active={page==='apps'} sidebarSlot={slot} onOpen={id=>setPage(id)} onConnections={()=>setPage('mcp')} onChat={()=>setPage('chat')} onPermissions={()=>{setSettingsTab('permissions');setSettingsVisit(n=>n+1);setPage('settings');}}/></section>
      <section className="page page-genvr" hidden={page !== 'genvr'}><GenVRPage key={user.id} client={client} active={page === 'genvr'}/></section>
      {(page === 'settings' || page === 'about') && <section className="page page-settings"><AppSettings onOpenApps={()=>setPage('apps')} onApprovals={()=>setPage('approvals')} onBoard={()=>setPage('board')} onAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}} onOpenChat={()=>setPage('chat')} onOpenTool={tool=>setPage(tool)} key={settingsVisit} initialTab={settingsTab} initialMemoryPane={memoryPane} sidebarSlot={page === 'settings' ? slot : null} active={page === 'settings'} signedIn client={client} preference={appearance.preference} onTheme={appearance.setPreference} onAccount={() => setPage('account')} onAgents={() => setPage('agents')} onOpenMemory={() => setPage('memory')} aboutOnly={page === 'about'}/></section>}
      <section className="page page-scroll" hidden={page !== 'account'}><div className="page-column"><AccountPanel client={client}/></div></section>
    </main>
    <footer className="statusbar">
      <span className="statusbar-group">
        {/* A quiet dot with a tooltip; words only when it is not the normal state. */}
        {mode === 'mock' ? <span className="status-item"><span className={`status-dot ${mode}`} aria-hidden="true"/>Offline practice — fictional data</span>
          : <span className="status-item status-dot-only" title="Connected · this installation" aria-label="Connected · this installation" role="img"><span className={`status-dot ${mode}`} aria-hidden="true"/></span>}
        <button type="button" className="status-item" aria-current={page === 'chat' ? 'page' : undefined} onClick={() => setPage('chat')}><Icon name="message-circle"/>Chat</button>
        <button type="button" className="status-item" aria-current={page === 'agents' ? 'page' : undefined} onClick={() => setPage('agents')}><Icon name="user"/>Agents</button>
        <button type="button" className="status-item" aria-current={page === 'board' ? 'page' : undefined} onClick={() => setPage('board')}>Board{typeof openCards === 'number' && boardState?.boards.length ? ` · ${openCards} cards` : ''}</button>
        <button type="button" className="status-item" aria-current={page === 'memory' ? 'page' : undefined} onClick={() => setPage('memory')}><Icon name="database"/>Memory</button>
        {user.role!=='guest'&&<button type="button" className="status-item" aria-current={page === 'approvals' ? 'page' : undefined} onClick={()=>setPage('approvals')}><Icon name="clock"/>{approvalLabel}</button>}
        <button type="button" className="status-item" aria-current={page==='apps'?'page':undefined} onClick={()=>setPage('apps')}><UiIcon name="layers" size={14}/>Apps</button>
        {tools.map(t=><button key={t.id} type="button" className="status-item" aria-current={page === t.id ? 'page' : undefined} onClick={t.run}>{t.icon}{t.label}</button>)}
        <button type="button" className="status-item" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}><Icon name="settings"/>Settings</button>
      </span>
      <span className="statusbar-group">
        <button type="button" className="status-item" onClick={() => setPalette(true)}>⌘K</button>
        {client.canUse('mock') && <button className="status-item statusbar-button" onClick={() => client.selectMode('fixture')} title="Clears this local session; the server sign-in stays until you sign out">Leave to fixture</button>}
        <span className="status-item">Dpro Agent</span>
      </span>
    </footer>
    <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)}
      search={chat && search && user.role !== 'guest' ? { controller: search.palette, onOpen: (id, messageId) => { void chat.openAt(id, messageId); setPage('chat'); } } : undefined}/>
  </div>;
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => undefined;
