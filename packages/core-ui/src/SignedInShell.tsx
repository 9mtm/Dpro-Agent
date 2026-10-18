import {ApprovalPage,usePendingApprovalCount} from './ApprovalPage';
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
import { MemoryPage } from './MemoryViews';
import type { MemoryFocus } from './MemoryViews';
import { Icon } from './icons';
import type { IconName } from './icons';
import { UiIcon } from './ui-icons';
import { CommandPalette } from './CommandPalette';
import { ChatSearchController } from './chat-search';
import type { Command } from './CommandPalette';

type Page = 'approvals' | 'chat' | 'genvr' | 'agents' | 'board' | 'memory' | 'account' | 'settings' | 'about';
const pages: ReadonlyArray<{ key: Page; label: string; icon: IconName | 'board' }> = [
  { key: 'chat', label: 'Chat', icon: 'message-circle' },
  { key: 'agents', label: 'Agents', icon: 'user' },
  { key: 'board', label: 'Board', icon: 'board' },
  { key: 'approvals', label: 'Approvals', icon: 'clock' },
  { key: 'memory', label: 'Memory', icon: 'database' },
  { key: 'genvr', label: 'GenVR', icon: 'dice' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * The signed-in workspace: a left sidebar (new chat, pages, the current
 * conversation, the account), the page area and a status bar. Every page
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
  const [settingsTab,setSettingsTab]=useState<SettingsTab>('general');
  const [settingsVisit,setSettingsVisit]=useState(0);
  const [terminalRequest,setTerminalRequest]=useState(0);
  const openSettings=(tab:SettingsTab)=>{setSettingsTab(tab);setSettingsVisit(n=>n+1);setPage('settings');};
  const openTerminal=()=>{if(user.role!=='owner')return;setTerminalRequest(n=>n+1);setPage('chat');};
  const tools=[
    {id:'genvr',label:'GenVR',icon:<Icon name="dice"/>,run:()=>setPage('genvr')},
    ...(user.role==='owner'?[
      {id:'terminal',label:'Terminal',icon:<UiIcon name="terminal" size={14}/>,run:openTerminal},
      {id:'skills',label:'Skills',icon:<UiIcon name="file" size={14}/>,run:()=>openSettings('skills')},
      {id:'specialties',label:'Specialties',icon:<Icon name="user"/>,run:()=>openSettings('specialties')},
      {id:'mcp',label:'MCP connections',icon:<UiIcon name="tool" size={14}/>,run:()=>openSettings('mcp')},
    ]:[]),
  ];
  const [connectorsFocus, setConnectorsFocus] = useState(0);
  const [memoryFocus, setMemoryFocus] = useState<MemoryFocus | null>(null);
  const boardState = useSyncExternalStore(board ? board.subscribe : noopSubscribe, board ? board.getSnapshot : nullSnapshot, board ? board.getSnapshot : nullSnapshot);
  // ⌘K / Ctrl+K opens the command box anywhere in the workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(v => !v); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const newChat = () => { chat?.newChat(); setPage('chat'); };
  const commands: Command[] = [
    ...pages.filter(p=>p.key!=='genvr'&&(p.key!=='approvals'||user.role==='owner')).map(p => ({ id: `go-${p.key}`, group: 'Go to', label: p.key==='approvals'?approvalLabel:p.label, icon:p.icon==='board'?<UiIcon name="board" size={14}/>:<Icon name={p.icon}/>, run: () => setPage(p.key) })),
    ...tools.map(t=>({...t,id:'tool-'+t.id,group:'Tools',keywords:t.id==='specialties'?'agent templates':t.id==='skills'?'skill abilities':t.id==='terminal'?'console shell':t.id==='genvr'?'spaces worlds':'connectors'})),
    { id: 'new-chat', group: 'Actions', icon:<UiIcon name="compose" size={14}/>, label: 'New chat', run: newChat },
    ...(chatState?.conversations ?? []).slice(0, 30).map(c => ({ id: `chat-${c.id}`, group: 'Conversations', icon:<Icon name="message-circle"/>, label: c.title || c.preview || 'New chat', run: () => { void chat?.open(c.id); setPage('chat'); } })),
    { id: 'theme', group: 'Actions', icon:<UiIcon name={theme==='dark'?'sun':'moon'} size={14}/>, label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: () => setTheme(t => t === 'dark' ? 'light' : 'dark') },
    { id: 'rail', group: 'Actions', icon:<UiIcon name="sidebar" size={14}/>, label: rail ? 'Hide the sidebar' : 'Show the sidebar', run: () => setRail(v => !v) },
  ];
  const active = chatState?.conversations.find(c => c.id === chatState.activeId);
  const pageTitle = page === 'chat' && active ? (active.title || 'Chat') : pages.find(p => p.key === page)?.label ?? '';
  const openCards = boardState?.boards.reduce((a, b) => a + b.cards, 0);

  return <div className="shell app-shell" data-theme={theme} data-rail={rail ? 'open' : 'closed'} lang="en" dir="ltr">
    <header className="titlebar">
      <div className="titlebar-tools">
        <button type="button" className="tool" aria-label={rail ? 'Hide the sidebar' : 'Show the sidebar'} title={rail ? 'Hide the sidebar' : 'Show the sidebar'} aria-pressed={rail} onClick={() => setRail(v => !v)}><UiIcon name="sidebar" size={14}/></button>
        <button type="button" className="tool" aria-label="New chat" title="New chat" onClick={newChat}><UiIcon name="compose" size={14}/></button>
      </div>
      <p className="titlebar-title">{pageTitle}</p>
      <div className="titlebar-tools end">
        <button type="button" className="titlebar-cmdk" onClick={() => setPalette(true)} aria-label="Commands (⌘K)"><UiIcon name="search" size={13}/>Commands<kbd>⌘K</kbd></button>
        <button type="button" className="tool" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} aria-label="Switch theme" title="Switch theme"><UiIcon name={theme === 'dark' ? 'sun' : 'moon'} size={14}/></button>
      </div>
    </header>
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="workspace-mark" aria-hidden="true"/>Dpro</div>
      <button className="nav-item new-chat" onClick={newChat}>
        <UiIcon name="compose" size={15}/>New chat
      </button>
      <nav aria-label="Workspace">{pages.filter(p=>p.key!=='genvr'&&(p.key!=='approvals'||user.role==='owner')).map(p =>
        <button key={p.key} className="nav-item" aria-current={page === p.key ? 'page' : undefined} onClick={() => setPage(p.key)}>
          {p.icon === 'board' ? <UiIcon name="board" size={14}/> : <Icon name={p.icon}/>}{p.key==='approvals'?approvalLabel:p.label}
        </button>)}
      </nav>
      <p className="section-label"><span className="checker" aria-hidden="true"/>Conversations</p>
      <div className="session-list">
        {chat && <ConversationList controller={chat} search={user.role === 'guest' ? undefined : search?.side} onOpen={() => setPage('chat')}/>}
      </div>
      <div className="sidebar-footer">
        <nav aria-label="Tools">{tools.map(t=><button key={t.id} className="nav-item" onClick={t.run}>{t.icon}{t.label}</button>)}</nav>
        <details className="account-menu"><summary className="user-chip" title="Account">
          <span className="avatar" aria-hidden="true">{(displayName(user) || '?').slice(0, 1).toUpperCase()}</span>
          <span className="user-name"><bdi>{displayName(user)}</bdi><small>{user.role}</small></span>
        </summary><div><button onClick={() => setPage('account')}>Account & sessions</button><button onClick={() => setPage('settings')}>Settings</button><button onClick={() => client.cancel()}>Sign out on this device</button></div></details>
      </div>
    </aside>
    <main id="content" className="page-area">
      {notice && <p className="page-notice" role="status">{notice}</p>}
      <section className="page page-chat" aria-label="Chat" hidden={page !== 'chat'}>
        {chat ? <ChatView terminalRequest={terminalRequest} controller={chat} mode={mode} client={client} onAddConnector={() => { setConnectorsFocus(n => n + 1); setPage('agents'); }}
          onOpenCard={(boardId, cardId) => { setPage('board'); void board?.reveal(boardId, cardId); }}
          onOpenMemory={(drawerId, memoryId) => { setMemoryFocus(f => ({ drawerId, memoryId, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/> : null}
      </section>
      <section className="page page-scroll" hidden={page !== 'agents'}><div className="page-column"><AgentsDestination key={`agents-${connectorsFocus}`} client={client} active={page === 'agents'} focusConnectors={connectorsFocus > 0} onOpenMemory={() => setPage('memory')}/></div></section>
      <section className="page page-scroll page-board page-ui" hidden={page !== 'board'}>{board && <TaskBoard controller={board} active={page === 'board'} onOpenChat={id => { void chat?.open(id); setPage('chat'); }}/>}</section>
      {user.role==='owner'&&<section className="page page-scroll" hidden={page!=='approvals'}><ApprovalPage client={client} active={page==='approvals'} onDecision={pendingApprovals.reload}/></section>}
      <section className="page page-scroll page-wide page-ui" hidden={page !== 'memory'}><MemoryPage client={client} active={page === 'memory'} focus={memoryFocus}/></section>
      <section className="page page-genvr" hidden={page !== 'genvr'}><GenVRPage key={user.id} client={client} active={page === 'genvr'}/></section>
      {(page === 'settings' || page === 'about') && <section className="page page-scroll"><AppSettings key={settingsVisit} initialTab={settingsTab} signedIn client={client} preference={appearance.preference} onTheme={appearance.setPreference} onAccount={() => setPage('account')} onAgents={() => setPage('agents')} aboutOnly={page === 'about'}/></section>}
      <section className="page page-scroll" hidden={page !== 'account'}><div className="page-column"><AccountPanel client={client}/></div></section>
    </main>
    <footer className="statusbar">
      <span className="statusbar-group">
        <span className="status-item"><span className={`status-dot ${mode}`} aria-hidden="true"/>{mode === 'mock' ? 'Offline practice — fictional data' : 'Connected · this installation'}</span>
        <button type="button" className="status-item" onClick={() => setPage('agents')}><Icon name="user"/>Agents</button>
        <button type="button" className="status-item" onClick={() => setPage('board')}>Board{typeof openCards === 'number' && boardState?.boards.length ? ` · ${openCards} cards` : ''}</button>
        <button type="button" className="status-item" onClick={() => setPage('memory')}><Icon name="database"/>Memory</button>
        {user.role==='owner'&&<button type="button" className="status-item" onClick={()=>setPage('approvals')}><Icon name="clock"/>{approvalLabel}</button>}
        {tools.map(t=><button key={t.id} type="button" className="status-item" onClick={t.run}>{t.icon}{t.label}</button>)}
      </span>
      <span className="statusbar-group">
        <button type="button" className="status-item" onClick={() => setPalette(true)}>⌘K</button>
        {client.canUse('mock') && <button className="status-item statusbar-button" onClick={() => client.selectMode('fixture')} title="Clears this local session; the server sign-in stays until you sign out">Leave to fixture</button>}
        <span className="status-item">Dpro</span>
      </span>
    </footer>
    <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)}
      search={chat && search && user.role !== 'guest' ? { controller: search.palette, onOpen: (id, messageId) => { void chat.openAt(id, messageId); setPage('chat'); } } : undefined}/>
  </div>;
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => undefined;
