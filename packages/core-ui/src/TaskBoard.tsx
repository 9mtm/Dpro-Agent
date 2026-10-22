import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent, ReactNode } from 'react';
import {createPortal} from 'react-dom';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {DocumentEditor,MarkdownDocument} from './DocumentEditor';
import { allCardTypes, allPriorities, cardTypeLabel, cardsIn, matches, priorityLabel } from './board';
import type { BoardColor, BoardController, BoardSummary, Card, CardType, Column } from './board';
import { Icon } from './icons';
import { CalendarView, TableView, ViewSwitch, WorkloadView } from './BoardViews';
import type { BoardView } from './BoardViews';

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w.slice(0, 1).toUpperCase()).join('') || '?';
const DRAG_TYPE = 'application/x-dpro-card';

const kindLabel = { company: 'Whole company', department: 'Department', shared: 'Shared' } as const;
const typeMark: Record<CardType, UiIconName> = {task:'check',idea:'sun',bug:'alert',milestone:'pin',request:'message'};
const colorLabel: Record<BoardColor, string> = { blue: 'Blue', green: 'Green', orange: 'Orange', red: 'Red', purple: 'Purple', pink: 'Pink', teal: 'Teal', gray: 'Gray' };

/** The company's boards: a list of boards (company, per department, shared), the open board's columns, and a card panel. */
export function TaskBoard({controller,active=false,onOpenChat,sidebarSlot}:{controller:BoardController;active?:boolean;onOpenChat?:(id:string)=>void;sidebarSlot?:HTMLElement|null}){
 const s=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const [mode,setMode]=useState<'board'|'new'|'settings'|'column'|'task'>('board'),[view,setView]=useState<BoardView>('board'),[menu,setMenu]=useState(false),[filters,setFilters]=useState(false),[newColumn,setNewColumn]=useState(''),[title,setTitle]=useState(''),[target,setTarget]=useState('');
 const search=useRef<HTMLInputElement>(null),popup=useRef<HTMLDivElement>(null),commentDrafts=useRef(new Map<string,string>());
 useEffect(()=>{if(!s.owner)commentDrafts.current.clear();},[s.owner]);
 const busy=s.phase==='loading'||s.phase==='saving',departments=[...new Set(s.cards.flatMap(c=>c.departments))].sort(),openCard=s.cards.find(c=>c.id===s.open);
 useEffect(()=>{if(active&&s.owner&&!controller.hasUnsavedDraft())void controller.load(s.boardId);},[active,s.owner,controller]);
 useEffect(()=>{if(!menu)return;const close=(e:PointerEvent)=>{if(!popup.current?.contains(e.target as Node))setMenu(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[menu]);
 const rail=<BoardRail controller={controller} onNew={()=>setMode('new')} onPick={id=>{setMode('board');void controller.openBoard(id);}} busy={busy}/>;
 return <section aria-label="Task board" className={`board board-desktop ${openCard?'board-task-open':''} ${sidebarSlot?'board-portal':''}`} data-color={s.meta?.color} onKeyDown={e=>{if(!active)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();search.current?.focus();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();setMode('task');}if(e.key==='Escape')setMenu(false);}}>
 {sidebarSlot?(active?createPortal(rail,sidebarSlot):null):rail}
 <div className="board-main"><header className="board-commandbar"><span className="board-swatch" data-color={s.meta?.color} aria-hidden="true"/><h2>{s.name||'Boards'}</h2><label className="mcp-search"><UiIcon name="search" size={14}/><input ref={search} type="search" aria-label="Search cards" placeholder="Search tasks" value={s.filter.text} onChange={e=>controller.setFilter({text:e.target.value})}/></label><ViewSwitch view={view} onChange={setView}/><button className={openCard?'':'primary'} disabled={busy||!s.columns.length} onClick={()=>{setTitle('');setTarget(s.columns[0]?.id??'');setMode('task');}}><UiIcon name="plus" size={16}/>New task</button><button className="mcp-command" aria-label="Filter tasks" title="Filter tasks by agent or department" aria-pressed={filters} onClick={()=>setFilters(v=>!v)}><UiIcon name="sliders" size={17}/></button><div className="mcp-menu" ref={popup}><button className="mcp-command" aria-label="Board actions" title="Board actions" aria-expanded={menu} onClick={()=>setMenu(v=>!v)}><UiIcon name="more" size={18}/></button>{menu&&<div role="menu"><button role="menuitem" disabled={busy} onClick={()=>{setMode('new');setMenu(false);}}>New board…</button><button role="menuitem" disabled={busy||!s.boardId} onClick={()=>{setMode('column');setMenu(false);}}>Add column…</button><button role="menuitem" disabled={busy||!s.meta} onClick={()=>{setMode('settings');setMenu(false);}}>Board settings…</button><button role="menuitem" disabled={busy} onClick={()=>{setMenu(false);void controller.load(s.boardId);}}>Reload board</button><button role="menuitem" onClick={()=>{setMenu(false);controller.setFilter({text:'',agent:'',department:''});}}>Clear filters</button></div>}</div></header>
 {filters&&<div className="board-filterbar" role="search"><label>Assigned agent<select aria-label="Filter by agent" value={s.filter.agent} onChange={e=>controller.setFilter({agent:e.target.value})}><option value="">All agents</option>{s.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Department<select aria-label="Filter by department" value={s.filter.department} onChange={e=>controller.setFilter({department:e.target.value})}><option value="">All departments</option>{departments.map(d=><option key={d}>{d}</option>)}</select></label><button onClick={()=>controller.setFilter({agent:'',department:''})}>Clear filters</button></div>}
 {(s.notice||s.phase==='loading')&&<p role="status" className="board-notice">{s.notice??'Reading the board…'}</p>}
 {s.boardId&&<RelatedTasks controller={controller}/>}
 {!s.boardId?<div className="mcp-empty"><UiIcon name="board" size={28}/><p>{s.owner?'Open a board to organise tasks and assign work.':'Only the owner can use the company board.'}</p>{s.owner&&<button disabled={busy} onClick={()=>void controller.load()}>Open the boards</button>}</div>:<div className="board-view-content" id="board-view-content" role="tabpanel" aria-labelledby={`board-view-${view}`}>{view==='board'&&<div className="board-columns">{s.columns.map(col=><BoardColumn key={col.id} col={col} controller={controller} busy={busy}/>)}{!s.columns.length&&<div className="mcp-empty"><p>Add a column to start organising tasks.</p><button onClick={()=>setMode('column')}>Add column</button></div>}</div>}{view==='table'&&<TableView controller={controller} busy={busy}/>}{view==='calendar'&&<CalendarView controller={controller}/>}{view==='workload'&&<WorkloadView controller={controller}/>}</div>}
 </div>
 {openCard&&s.draft&&<CardPanel draftCache={commentDrafts.current} key={openCard.id} card={openCard} controller={controller} busy={busy} onOpenChat={onOpenChat}/>}
 {mode!=='board'&&<BoardSheet title={mode==='new'?'New board':mode==='settings'?'Board settings':mode==='column'?'Add column':'New task'} onClose={()=>{if(!busy)setMode('board');}}>{mode==='new'?<NewBoardForm controller={controller} busy={busy} onDone={()=>setMode('board')}/>:mode==='settings'&&s.meta?<BoardSettings controller={controller} busy={busy} onDone={()=>setMode('board')}/>:mode==='column'?<form className="board-form" onSubmit={e=>{e.preventDefault();void controller.addColumn(newColumn).then(ok=>{if(ok){setNewColumn('');setMode('board');}});}}><label>Column name<input autoFocus value={newColumn} maxLength={60} onChange={e=>setNewColumn(e.target.value)}/></label><button className="primary" disabled={busy||!newColumn.trim()}>Add column</button>{s.notice&&<p role="status">{s.notice}</p>}</form>:<form className="board-form" onSubmit={e=>{e.preventDefault();void controller.addCard(target||s.columns[0]?.id,title).then(ok=>{if(ok){setTitle('');setMode('board');}});}}><label>Task title<input autoFocus value={title} maxLength={200} onChange={e=>setTitle(e.target.value)} placeholder="What needs to be done?"/></label><label>Status<select value={target||s.columns[0]?.id} onChange={e=>setTarget(e.target.value)}>{s.columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><p className="fine-print">Create the task, then open it to add its description, assignees, dates and checklist.</p><button className="primary" disabled={busy||!title.trim()||!s.columns.length}>Create task</button>{s.notice&&<p role="status">{s.notice}</p>}</form>}</BoardSheet>}
 </section>;
}
function RelatedTasks({controller}:{controller:BoardController}){
 const s=controller.getSnapshot(),[query,setQuery]=useState('');const rows=(s.overview?.tasks??[]).filter(t=>`${t.title} ${t.boardName} ${t.status}`.toLowerCase().includes(query.trim().toLowerCase()));
 return <details className="board-related" open={s.meta?.kind==='company'}><summary><UiIcon name="board" size={14}/>{s.meta?.kind==='company'?'Across departments':'Related department tasks'}<button className="tool" aria-label="Refresh related tasks" title="Refresh related tasks" disabled={s.phase==='loading'||s.phase==='saving'} onClick={e=>{e.preventDefault();e.stopPropagation();void controller.refreshOverview();}}><UiIcon name="reconnect" size={14}/></button></summary><div><p>Opens the original task and its board. Status and comments stay in one place.</p>{s.overviewError?<p role="status">Related tasks could not be loaded. Refresh to try again.</p>:!s.overview?<p role="status">Reading related tasks…</p>:<>{s.overview.tasks.length>8&&<input type="search" aria-label="Search related tasks" placeholder="Search related tasks" value={query} onChange={e=>setQuery(e.target.value)}/>}<ul>{rows.map(t=><li key={t.cardId}><button onClick={()=>void controller.reveal(t.boardId,t.cardId)}><strong>{t.title}</strong><span>{t.boardName} · {t.status}</span></button></li>)}</ul>{!rows.length&&<p>{query?'No related tasks match.':s.meta?.kind==='company'?'Tasks from department and shared boards appear here.':'Tasks linked to this department from other boards appear here.'}</p>}{s.overview.limited&&<p>Showing the latest 500 of {s.overview.total} tasks. Open individual boards for all their work.</p>}</>}</div></details>;
}
function BoardSheet({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);return <dialog ref={dialog} className="mcp-sheet board-sheet" aria-label={title} onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();onClose();}}><header><h2>{title}</h2><button className="tool" aria-label={`Close ${title}`} onClick={onClose}><UiIcon name="close" size={17}/></button></header><div className="mcp-sheet-body">{children}</div></dialog>;}

/** Boards grouped: whole company, each department, shared by departments. */
function BoardRail({ controller, onNew, onPick, busy }: { controller: BoardController; onNew: () => void; onPick: (id: string) => void; busy: boolean }) {
  const s = controller.getSnapshot();
  const company = s.boards.filter(b => b.kind === 'company');
  const past=s.boards.filter(b=>b.managedDepartment&&b.departmentActive===false);
  const byDep = new Map<string, BoardSummary[]>();
  for (const b of s.boards.filter(x => x.kind === 'department'&&x.departmentActive!==false)) byDep.set(b.departments[0], [...(byDep.get(b.departments[0]) ?? []), b]);
  const shared = s.boards.filter(b => b.kind === 'shared');
  const item = (b: BoardSummary) => <li key={b.id}>
    <button type="button" className="board-rail-item" aria-current={b.id === s.boardId ? 'page' : undefined} disabled={busy} onClick={() => onPick(b.id)} title={b.description || b.name}>
      <span className="board-swatch small" data-color={b.color} aria-hidden="true"/><span className="board-rail-name">{b.name}</span><span className="board-count">{b.cards}</span>
    </button>
  </li>;
  return <nav className="board-rail" aria-label="Boards">
    <button type="button" className="board-new" disabled={busy} onClick={onNew}><UiIcon name="plus" size={15}/>New board</button>
    {company.length > 0 && <><p className="board-rail-label">Whole company</p><ul>{company.map(item)}</ul></>}
    {[...byDep.keys()].sort().map(dep => <div key={dep}><p className="board-rail-label">{dep}</p><ul>{byDep.get(dep)!.map(item)}</ul></div>)}
    {shared.length > 0 && <><p className="board-rail-label">Shared by departments</p><ul>{shared.map(item)}</ul></>}{past.length>0&&<><p className="board-rail-label">Past departments</p><ul>{past.map(item)}</ul></>}
  </nav>;
}

function ColorPicker({ value, onChange, colors }: { value: BoardColor; onChange: (c: BoardColor) => void; colors: readonly BoardColor[] }) {
  return <div className="board-colors" role="radiogroup" aria-label="Board colour">{colors.map(c =>
    <label key={c} className="board-color" title={colorLabel[c]}>
      <input type="radio" name="board-color" aria-label={colorLabel[c]} checked={value === c} onChange={() => onChange(c)}/>
      <span className="board-swatch" data-color={c} aria-hidden="true"/>
    </label>)}
  </div>;
}

function DepartmentsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [dep, setDep] = useState('');
  const add = () => { const d = dep.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); if (d && !value.includes(d) && value.length < 12) onChange([...value, d]); setDep(''); };
  return <div className="board-panel-deps">
    <span className="board-chips">{value.map(x => <span key={x} className="board-chip">{x} <button type="button" aria-label={`Remove ${x}`} onClick={() => onChange(value.filter(v => v !== x))}><UiIcon name="close" size={13}/></button></span>)}
      {value.length === 0 && <span className="fine-print">None — the board is for the whole company.</span>}</span>
    <div className="board-inline"><input aria-label="Add a department" placeholder="e.g. marketing" maxLength={64} value={dep} onChange={e => setDep(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}/><button type="button" disabled={!dep.trim()} onClick={add}>Add</button></div>
  </div>;
}

function NewBoardForm({ controller, busy, onDone }: { controller: BoardController; busy: boolean; onDone: () => void }) {
  const s = controller.getSnapshot();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState(s.templates[0]?.id ?? 'kanban');
  const [color, setColor] = useState<BoardColor>('blue');
  const [deps, setDeps] = useState<string[]>([]);
  return <form className="board-form" aria-label="New board" onSubmit={e => { e.preventDefault(); void controller.createBoard({ name, description, template, color, departments: deps }).then(ok => { if (ok) onDone(); }); }}>
    <h2>New board</h2>
    {s.notice && <p role="status" className="board-notice">{s.notice}</p>}
    <label>Name<input value={name} maxLength={80} placeholder="e.g. Marketing content" onChange={e => setName(e.target.value)}/></label>
    <label>Description <small className="fine-print">(optional)</small><input value={description} maxLength={500} onChange={e => setDescription(e.target.value)}/></label>
    <fieldset className="board-templates"><legend>Start from a template</legend>
      {s.templates.map(t => <label key={t.id} className="board-template" data-on={template === t.id || undefined}>
        <input type="radio" name="board-template" checked={template === t.id} onChange={() => setTemplate(t.id)}/>
        <span><strong>{t.name}</strong><small>{t.description}</small><span className="board-template-cols">{t.columns.map(c => <span key={c}>{c}</span>)}</span></span>
      </label>)}
    </fieldset>
    <fieldset className="board-fieldset"><legend>Colour</legend><ColorPicker value={color} onChange={setColor} colors={s.colors}/></fieldset>
    <fieldset className="board-fieldset"><legend>Departments</legend><p className="fine-print">One department makes it that team's board; several make it a shared board.</p><DepartmentsInput value={deps} onChange={setDeps}/></fieldset>
    <div className="hire-actions"><button type="submit" className="primary" disabled={busy || !name.trim()}>Create board</button><button type="button" disabled={busy} onClick={onDone}>Cancel</button></div>
  </form>;
}

function BoardSettings({ controller, busy, onDone }: { controller: BoardController; busy: boolean; onDone: () => void }) {
  const m = controller.getSnapshot().meta!;
  const colors = controller.getSnapshot().colors;
  const [name, setName] = useState(m.name);
  const [description, setDescription] = useState(m.description);
  const [color, setColor] = useState<BoardColor>(m.color);
  const [deps, setDeps] = useState<string[]>([...m.departments]);
  const [confirmArchive, setConfirmArchive] = useState(false);
  return <form className="board-form" aria-label="Board settings" onSubmit={e => { e.preventDefault(); void controller.updateBoard({ name, description, color, departments: deps }).then(ok => { if (ok) onDone(); }); }}>
    <h2>Board settings</h2>
    {controller.getSnapshot().notice && <p role="status" className="board-notice">{controller.getSnapshot().notice}</p>}
    <label>Name<input value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>
    <label>Description<input value={description} maxLength={500} onChange={e => setDescription(e.target.value)}/></label>
    <fieldset className="board-fieldset"><legend>Colour</legend><ColorPicker value={color} onChange={setColor} colors={colors}/></fieldset>
    <fieldset className="board-fieldset" disabled={m.managedDepartment}><legend>Departments</legend>{m.managedDepartment&&<p className="fine-print">Linked to the company department. Rename the department at its source; this board keeps its tasks and customised columns.</p>}<DepartmentsInput value={deps} onChange={setDeps}/></fieldset>
    <div className="hire-actions"><button type="submit" className="primary" disabled={busy}>Save</button><button type="button" disabled={busy} onClick={onDone}>Cancel</button></div>
    <fieldset className="board-fieldset danger"><legend>Archive this board</legend>
      <p className="fine-print">The board and its cards are kept but hidden from the list and from agents.</p>
      <label className="check"><input type="checkbox" checked={confirmArchive} onChange={e => setConfirmArchive(e.target.checked)}/> I want to archive “{m.name}”</label>
      <button type="button" disabled={busy || !confirmArchive} onClick={() => void controller.updateBoard({ archived: true }).then(ok => { if (ok) onDone(); })}>Archive board</button>
    </fieldset>
  </form>;
}

function BoardColumn({ col, controller, busy }: { col: Column; controller: BoardController; busy: boolean }) {
  const s = controller.getSnapshot();
  const cards = cardsIn(s.cards, col.id).filter(c => matches(c, s.filter));
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent, before: string | null) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id) void controller.move(id, col.id, before);
  };
  return <section className="board-column" aria-label={col.name} data-over={over || undefined}
    onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={e => drop(e, null)}>
    <header className="board-column-head">
      {renaming === null
        ? <><h3>{col.name}</h3><span className="board-count">{cards.length}</span>
          <button type="button" className="board-ghost" aria-label={`Rename ${col.name}`} disabled={busy} onClick={() => setRenaming(col.name)}><UiIcon name="pencil" size={13}/></button></>
        : <form className="board-rename" onSubmit={e => { e.preventDefault(); void controller.renameColumn(col.id, renaming).then(ok => { if (ok) setRenaming(null); }); }}>
          <input aria-label="Column name" value={renaming} maxLength={60} autoFocus onChange={e => setRenaming(e.target.value)}/>
          <button type="submit" disabled={busy}>Save</button><button type="button" onClick={() => setRenaming(null)}>Cancel</button>
        </form>}
    </header>
    <ol className="board-cards">
      {cards.map(card => <li key={card.id} onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault(); }} onDrop={e => drop(e, card.id)}>
        <CardTile card={card} controller={controller}/>
      </li>)}
    </ol>
    {adding
      ? <form className="board-new-card" onSubmit={e => { e.preventDefault(); const text = title; if (!text.trim()) return;
        // Clear at once so the next title can be typed while this one saves; put it back if it was not added.
        setTitle(''); void controller.addCard(col.id, text).then(ok => { if (!ok) setTitle(cur => cur || text); }); }}>
        <input aria-label={`New card in ${col.name}`} placeholder="What needs to be done? (Enter adds, Esc closes)" maxLength={200} value={title} autoFocus
          onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } if (e.key === 'Escape') setAdding(false); }}/>
        <div className="board-new-actions"><button type="submit" className="primary" disabled={busy || !title.trim()}>Add card</button><button type="button" onClick={() => { setAdding(false); setTitle(''); }}>Cancel</button></div>
      </form>
      : <button type="button" className="board-add-card" disabled={busy} onClick={() => setAdding(true)}><UiIcon name="plus" size={14}/>Add task</button>}
  </section>;
}

function CardTile({ card, controller }: { card: Card; controller: BoardController }) {
  const overdue = card.dueDate !== null && card.dueDate < new Date().toISOString().slice(0, 10);
  return <article className="board-card" data-priority={card.priority} draggable
    onDragStart={e => { e.dataTransfer.setData(DRAG_TYPE, card.id); e.dataTransfer.effectAllowed = 'move'; }}>
    {card.cover && <span className="board-cover" data-color={card.cover} aria-hidden="true"/>}
    <button type="button" className="board-card-open" onClick={() => void controller.openCard(card.id)} aria-label={`Open ${cardTypeLabel[card.type].toLowerCase()} ${card.title}`}>
      {card.labels.length > 0 && <span className="board-labels">{card.labels.map(id => { const l = controller.getSnapshot().labels.find(x => x.id === id); return l ? <span key={id} className="board-label" data-color={l.color}>{l.name}</span> : null; })}</span>}
      {card.departments.length > 0 && <span className="board-chips">{card.departments.map(d => <span key={d} className="board-chip">{d}</span>)}</span>}
      <span className="board-card-title">{card.type !== 'task' && <span className={`board-type t-${card.type}`} title={cardTypeLabel[card.type]}><UiIcon name={typeMark[card.type]} size={13}/> {cardTypeLabel[card.type]}</span>}{card.title}</span>
      <span className="board-card-meta">
        {card.priority !== 'normal' && <span className={`board-priority p-${card.priority}`}>{priorityLabel[card.priority]}</span>}
        {card.startDate && <span className="board-due">From {card.startDate}</span>}
        {card.dueDate && <span className={overdue ? 'board-due overdue' : 'board-due'}>Due {card.dueDate}</span>}
        {card.checklist.total > 0 && <span className={card.checklist.done === card.checklist.total ? 'board-check complete' : 'board-check'} aria-label={`Checklist ${card.checklist.done} of ${card.checklist.total}`}><UiIcon name="check" size={12}/>{card.checklist.done}/{card.checklist.total}</span>}
        {card.comments > 0 && <span className="board-comments" aria-label={`${card.comments} comments`}><Icon name="message-circle"/>{card.comments}</span>}
        <span className="board-avatars">{card.agents.slice(0, 4).map(a => <span key={a} className="board-avatar" title={controller.agentName(a)}>{initials(controller.agentName(a))}</span>)}
          {card.agents.length > 4 && <span className="board-avatar more">+{card.agents.length - 4}</span>}</span>
      </span>
    </button>
  </article>;
}

function CardPanel({card,controller,busy,onOpenChat,draftCache}:{card:Card;controller:BoardController;busy:boolean;onOpenChat?:(id:string)=>void;draftCache:Map<string,string>}){
 const s=controller.getSnapshot(),d=s.draft!;
 const [dep,setDep]=useState(''),[comment,setComment]=useState(draftCache.get(card.id)??''),[agentQuery,setAgentQuery]=useState(''),[editing,setEditing]=useState<'description'|'comment'|null>(null),[closing,setClosing]=useState(false);
 useEffect(()=>{draftCache.set(card.id,comment);},[card.id,comment,draftCache]);
 const matchingAgents=s.agents.filter(a=>d.agents.includes(a.id)||!agentQuery.trim()||a.name.toLowerCase().includes(agentQuery.trim().toLowerCase()));
 const shownAgents=matchingAgents.slice(0,60);
 const changed=d.title!==card.title||d.description!==card.description||d.priority!==card.priority||(d.dueDate||null)!==card.dueDate||d.type!==card.type||(d.startDate||null)!==card.startDate||d.cover!==card.cover||[...d.agents].sort().join()!==[...card.agents].sort().join()||[...d.departments].sort().join()!==[...card.departments].sort().join()||[...d.labels].sort().join()!==[...card.labels].sort().join();
 const close=()=>{if(changed||comment.trim())setClosing(true);else controller.closeCard();};
 return <aside className="board-panel task-inspector" aria-label={`Card: ${card.title}`} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();if(changed&&!busy)void controller.saveCard();}}}>
 <header className="task-inspector-header"><div><small>{s.name}</small><h2><UiIcon name={typeMark[d.type]} size={18}/>{cardTypeLabel[d.type]}</h2></div><button className="tool" aria-label="Close task" title="Close task (Esc)" disabled={busy} onClick={close}><UiIcon name="close" size={18}/></button></header>
 <div className="task-inspector-body"><label className="task-title">Title<input value={d.title} maxLength={200} disabled={busy} onChange={e=>controller.editDraft({title:e.target.value})}/></label>
 <div className="task-properties"><label>Status<select value={card.columnId} disabled={busy} onChange={e=>void controller.move(card.id,e.target.value,null)}>{s.columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Priority<select value={d.priority} disabled={busy} onChange={e=>controller.editDraft({priority:e.target.value as never})}>{allPriorities.map(p=><option key={p} value={p}>{priorityLabel[p]}</option>)}</select></label><label>Start date<input type="date" value={d.startDate} disabled={busy} onInput={e=>controller.editDraft({startDate:e.currentTarget.value})} onChange={e=>controller.editDraft({startDate:e.target.value})}/></label><label>Due date<input type="date" value={d.dueDate} disabled={busy} onInput={e=>controller.editDraft({dueDate:e.currentTarget.value})} onChange={e=>controller.editDraft({dueDate:e.target.value})}/></label></div>
 <section className="task-description"><header><h3><UiIcon name="file" size={15}/>Description</h3><button disabled={busy} onClick={()=>setEditing('description')}><UiIcon name="pencil" size={13}/>{d.description?'Edit…':'Add description…'}</button></header>{d.description?<article><MarkdownDocument text={d.description}/></article>:<p className="fine-print">Explain the outcome, steps and acceptance criteria.</p>}</section>
 <details className="task-section" open><summary><UiIcon name="users" size={15}/>Assigned agents <small>{d.agents.length?d.agents.map(id=>controller.agentName(id)).join(', '):'Not assigned'}</small></summary><fieldset className="board-panel-agents" disabled={busy}><legend className="sr-only">Agents working on it</legend><input type="search" aria-label="Find an agent" placeholder="Find an agent" value={agentQuery} onChange={e=>setAgentQuery(e.target.value)}/><ul>{shownAgents.map(a=><li key={a.id}><label className="check"><input type="checkbox" checked={d.agents.includes(a.id)} onChange={()=>controller.toggleAgent(a.id)}/><span className="board-avatar" aria-hidden="true">{initials(a.name)}</span><span>{a.name}</span></label></li>)}</ul>{matchingAgents.length>shownAgents.length&&<small>Search to narrow the team list.</small>}{!s.agents.length&&<p>No agents yet. Hire them on the Agents page.</p>}</fieldset><p className="fine-print">Assignment records responsibility. It does not start an agent run.</p></details>
 <details className="task-section"><summary><UiIcon name="sliders" size={15}/>Labels and organisation</summary><div className="board-panel-row"><label>Type<select value={d.type} disabled={busy} onChange={e=>controller.editDraft({type:e.target.value as CardType})}>{allCardTypes.map(t=><option key={t} value={t}>{cardTypeLabel[t]}</option>)}</select></label><label>Cover<select value={d.cover??''} disabled={busy} onChange={e=>controller.editDraft({cover:(e.target.value||null) as BoardColor|null})}><option value="">None</option>{s.colors.map(c=><option key={c} value={c}>{colorLabel[c]}</option>)}</select></label></div><LabelPicker controller={controller} selected={d.labels} busy={busy}/><div className="board-panel-deps"><span>Departments taking part</span><span className="board-chips">{d.departments.map(x=><span key={x} className="board-chip">{x}<button type="button" aria-label={`Remove ${x}`} disabled={busy} onClick={()=>controller.removeDepartment(x)}><UiIcon name="close" size={12}/></button></span>)}</span><form onSubmit={e=>{e.preventDefault();if(controller.addDepartment(dep))setDep('');}}><input aria-label="Add a department" placeholder="Department" value={dep} maxLength={64} disabled={busy} onChange={e=>setDep(e.target.value)}/><button disabled={busy||!dep.trim()}>Add</button></form></div></details>
 <Checklist controller={controller} busy={busy}/>
 <section className="board-thread" aria-label="Comments"><h3><UiIcon name="message" size={15}/>Comments</h3>{s.commentsPhase==='loading'&&<p role="status">Reading comments…</p>}{s.commentsPhase==='error'&&<p role="status">Comments could not be read. Close and reopen this task to retry.</p>}{s.commentsPhase==='ready'&&!s.comments.length&&<p className="fine-print">No comments yet. Add context or an update for the team.</p>}<ol>{s.comments.map(c=><li key={c.id}><span className="board-avatar" aria-hidden="true">{c.authorKind==='agent'?initials(controller.agentName(c.authorId)):'U'}</span><div><small><strong>{controller.commentAuthor(c.authorKind,c.authorId)}</strong> · <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time></small><article><MarkdownDocument text={c.body}/></article></div></li>)}</ol><div className="task-comment-composer"><button disabled={busy} onClick={()=>setEditing('comment')}><UiIcon name="compose" size={15}/>{comment?'Edit comment draft…':'Write a comment…'}</button>{comment&&<article><MarkdownDocument text={comment}/></article>}<small>Comments are shared with people and agents who can access this board.</small><button disabled={busy||!comment.trim()} onClick={()=>void controller.addComment(comment).then(ok=>{if(ok)setComment('');})}>Post comment</button></div></section>
 {s.chat&&<CardChat chat={s.chat} nameOf={controller.agentName} onOpenChat={onOpenChat} onRefresh={()=>controller.refreshChat()}/>}
 <details className="task-section"><summary><UiIcon name="archive" size={15}/>Archive task</summary><p className="fine-print">Keeps the task but hides it from this board. This page does not offer restore.</p><button disabled={busy} onClick={()=>{if(changed||comment.trim())setClosing(true);else void controller.archiveCard();}}>Archive</button></details>
 </div><footer className="task-savebar"><small role="status">{busy?'Saving…':changed?'Unsaved task changes':'Task saved'}{comment?' · Comment draft not posted':''}</small><button className="primary" disabled={busy||!changed} onClick={()=>void controller.saveCard()}>Save changes</button></footer>
 {editing&&<DocumentEditor key={editing} title={editing==='description'?'Task description':'Comment draft'} files={[{id:editing,name:editing==='description'?'Description.md':'Comment.md',content:editing==='description'?d.description:comment}]} maxLength={editing==='description'?5000:4000} onChange={(_,text)=>editing==='description'?controller.editDraft({description:text}):setComment(text)} onClose={()=>setEditing(null)}/>}
 {closing&&<BoardSheet title="Unsaved task draft" onClose={()=>setClosing(false)}><p>This task has unsaved changes or a comment that has not been posted.</p><div className="hire-actions"><button onClick={()=>setClosing(false)}>Keep editing</button><button onClick={()=>{draftCache.delete(card.id);controller.closeCard();}}>Discard draft and close</button></div></BoardSheet>}
 </aside>;
}

/** Board labels: tick to put them on the card; add a new label to the board. */
function LabelPicker({ controller, selected, busy }: { controller: BoardController; selected: readonly string[]; busy: boolean }) {
  const s = controller.getSnapshot();
  const [name, setName] = useState('');
  const [color, setColor] = useState<BoardColor>('blue');
  return <div className="board-panel-deps">
    <span>Labels</span>
    <span className="board-labels pick">{s.labels.map(l => <button key={l.id} type="button" className="board-label" data-color={l.color} aria-pressed={selected.includes(l.id)} disabled={busy} onClick={() => controller.toggleLabel(l.id)}>{l.name}</button>)}
      {s.labels.length === 0 && <span className="fine-print">This board has no labels yet.</span>}</span>
    <div className="board-inline">
      <input aria-label="New label name" placeholder="New label" maxLength={40} value={name} onChange={e => setName(e.target.value)}/>
      <select aria-label="New label colour" value={color} onChange={e => setColor(e.target.value as BoardColor)}>{s.colors.map(c => <option key={c} value={c}>{colorLabel[c]}</option>)}</select>
      <button type="button" disabled={busy || !name.trim()} onClick={() => void controller.addLabel(name, color).then(ok => { if (ok) setName(''); })}>Add label</button>
    </div>
  </div>;
}

/** The card's checklist with progress; items are saved one by one. */
function Checklist({ controller, busy }: { controller: BoardController; busy: boolean }) {
  const items = controller.getSnapshot().checklist;
  const [text, setText] = useState('');
  const done = items.filter(i => i.done).length;
  return <section className="board-checklist" aria-label="Checklist">
    <div className="board-checklist-head"><h4>Checklist</h4>{items.length > 0 && <span className="fine-print">{done} of {items.length}</span>}</div>
    {items.length > 0 && <progress className="company-progress" max={items.length} value={done} aria-label="Checklist progress"/>}
    <ul>{items.map(i => <li key={i.id}>
      <label className="check"><input type="checkbox" checked={i.done} disabled={busy} onChange={e => void controller.updateCheckItem(i.id, { done: e.target.checked })}/><span className={i.done ? 'board-done' : undefined}>{i.text}</span></label>
      <button type="button" className="board-ghost" aria-label={`Remove ${i.text}`} disabled={busy} onClick={() => void controller.updateCheckItem(i.id, { remove: true })}><UiIcon name="close" size={13}/></button>
    </li>)}</ul>
    <form className="board-inline" onSubmit={e => { e.preventDefault(); const t = text; setText(''); void controller.addCheckItem(t).then(ok => { if (!ok) setText(cur => cur || t); }); }}>
      <input aria-label="New checklist item" placeholder="Add an item" maxLength={300} value={text} onChange={e => setText(e.target.value)}/>
      <button type="submit" disabled={!text.trim()}>Add</button>
    </form>
  </section>;
}

/** CHAT-PRO-02 I step 2: the chat this card came from and how far each agent on it is. */
function CardChat({ chat, nameOf, onOpenChat, onRefresh }: { chat: NonNullable<ReturnType<BoardController['getSnapshot']>['chat']>; nameOf: (id: string) => string; onOpenChat?: (conversationId: string) => void; onRefresh: () => void }) {
  const { conversation, progress } = chat;
  if (!conversation && !progress.agents.length) return null;
  return <section className="board-card-chat" aria-label="Work in the chat">
    <div className="board-card-chat-head">
      <strong>{conversation ? 'From the chat' : 'Agents on it'}</strong>
      {conversation && <span className="fine-print" dir="auto">{conversation.title || 'Untitled chat'}</span>}
      {progress.running && <span className="chat-card-badge live">Working now</span>}
      <button type="button" className="ghost-action" onClick={onRefresh} aria-label="Read the progress again">Refresh</button>
      {conversation && onOpenChat && <button type="button" className="ghost-action strong" onClick={() => onOpenChat(conversation.id)}>Open chat</button>}
    </div>
    {progress.agents.length > 0 && <ul className="chat-card-people">{progress.agents.map(a => <li key={a.agentId} data-running={a.running || undefined}>
      <span className="avatar" aria-hidden="true">{nameOf(a.agentId).slice(0, 1).toUpperCase()}</span>
      <span>{nameOf(a.agentId)}</span>
      <small>{a.running ? (a.plan?.active ? `working: ${a.plan.active}` : 'working now') : a.plan ? `plan ${a.plan.done} of ${a.plan.total}${a.plan.active ? ` · next: ${a.plan.active}` : ''}` : a.replies ? `${a.replies} ${a.replies === 1 ? 'reply' : 'replies'} in the chat` : 'not started'}</small>
      {a.plan && a.plan.total > 0 && <span className="plan-bar" aria-hidden="true"><i style={{ inlineSize: `${Math.round((a.plan.done / a.plan.total) * 100)}%` }}/></span>}
    </li>)}</ul>}
  </section>;
}
