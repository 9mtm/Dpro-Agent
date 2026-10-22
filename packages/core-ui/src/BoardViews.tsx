import { useState } from 'react';
import {UiIcon} from './ui-icons';
import { cardTypeLabel, matches, priorityLabel } from './board';
import type { BoardController, Card } from './board';
import { OVERLOAD, cardsByDue, monthGrid, sortCards, workloadMatrix } from './board-views';
import type { SortKey, WorkloadRow } from './board-views';

export type BoardView = 'board' | 'table' | 'calendar' | 'workload';
export const viewLabel: Record<BoardView, string> = { board: 'Board', table: 'Table', calendar: 'Calendar', workload: 'Workload' };
const today = () => new Date().toISOString().slice(0, 10);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Board / Table / Calendar / Workload switcher. */
export function ViewSwitch({ view, onChange }: { view: BoardView; onChange: (v: BoardView) => void }) {
  return <div className="board-views" role="tablist" aria-label="Board views">{(Object.keys(viewLabel) as BoardView[]).map(v =>
    <button key={v} type="button" role="tab" id={`board-view-${v}`} aria-controls="board-view-content" aria-selected={view === v} className="board-view-tab" tabIndex={view===v?0:-1} onKeyDown={e=>{const views=Object.keys(viewLabel) as BoardView[];if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const at=views.indexOf(v),next=e.key==='Home'?0:e.key==='End'?3:(at+(e.key==='ArrowRight'?1:-1)+4)%4;onChange(views[next]);(e.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();}}} onClick={() => onChange(v)}>{viewLabel[v]}</button>)}
  </div>;
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'title', label: 'Card' }, { key: 'type', label: 'Type' }, { key: 'column', label: 'Status' }, { key: 'priority', label: 'Priority' },
  { key: 'agents', label: 'Agents' }, { key: 'start', label: 'Start' }, { key: 'due', label: 'Due' }, { key: 'checklist', label: 'Checklist' },
];

/** Every card in one sortable table; status can be changed in place; the title opens the card. */
export function TableView({ controller, busy }: { controller: BoardController; busy: boolean }) {
  const s = controller.getSnapshot();
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'column', dir: 'asc' });
  const rows = sortCards(s.cards.filter(c => matches(c, s.filter)), s.columns, sort.key, sort.dir);
  const now = today();
  const by = (key: SortKey) => setSort(cur => ({ key, dir: cur.key === key && cur.dir === 'asc' ? 'desc' : 'asc' }));
  return <div className="board-table-wrap">
    <table className="board-table">
      <thead><tr>{COLUMNS.map(c => <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" onClick={() => by(c.key)}>{c.label}{sort.key === c.key ? <span className={sort.dir==='desc'?'board-sort-desc':''}><UiIcon name="arrow-up" size={12}/></span> : ''}</button>
      </th>)}<th scope="col">Labels</th></tr></thead>
      <tbody>{rows.map(c => <tr key={c.id} data-priority={c.priority}>
        <td><button type="button" className="board-link" onClick={() => void controller.openCard(c.id)}>{c.title}</button>
          {c.departments.length > 0 && <small className="board-table-deps">{c.departments.join(', ')}</small>}</td>
        <td>{cardTypeLabel[c.type]}</td>
        <td><select aria-label={`Status of ${c.title}`} value={c.columnId} disabled={busy} onChange={e => void controller.move(c.id, e.target.value, null)}>
          {s.columns.map(col => <option key={col.id} value={col.id}>{col.name}</option>)}</select></td>
        <td><span className={`board-priority p-${c.priority}`}>{priorityLabel[c.priority]}</span></td>
        <td>{c.agents.length?<span className="board-table-assignees">{c.agents.map(a=><span key={a} title={controller.agentName(a)}><span className="board-avatar" aria-hidden="true">{controller.agentName(a).slice(0,1).toUpperCase()}</span>{controller.agentName(a)}</span>)}</span>:'Not assigned'}</td>
        <td>{c.startDate ?? '—'}</td>
        <td className={c.dueDate && c.dueDate < now ? 'board-due overdue' : undefined}>{c.dueDate ?? '—'}</td>
        <td>{c.checklist.total ? `${c.checklist.done}/${c.checklist.total}` : '—'}</td>
        <td><span className="board-labels">{c.labels.map(id => { const l = s.labels.find(x => x.id === id); return l ? <span key={id} className="board-label" data-color={l.color}>{l.name}</span> : null; })}</span></td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p className="fine-print">No cards match.</p>}
  </div>;
}

/** A month of due dates; cards without a due date are listed below. */
export function CalendarView({ controller }: { controller: BoardController }) {
  const s = controller.getSnapshot();
  const now = new Date();
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const { byDay, undated } = cardsByDue(s.cards.filter(c => matches(c, s.filter)));
  const weeks = monthGrid(month.y, month.m);
  const shift = (d: number) => setMonth(cur => { const t = new Date(cur.y, cur.m + d, 1); return { y: t.getFullYear(), m: t.getMonth() }; });
  const todayIso = today();
  const tile = (c: Card) => <li key={c.id}><button type="button" className="board-cal-card" data-priority={c.priority} data-color={c.cover ?? undefined} onClick={() => void controller.openCard(c.id)} title={c.title}>{c.title}</button></li>;
  return <div className="board-calendar">
    <div className="board-cal-head">
      <button type="button" aria-label="Previous month" onClick={() => shift(-1)}><UiIcon name="arrow-left" size={16}/></button>
      <h3>{MONTHS[month.m]} {month.y}</h3>
      <button type="button" aria-label="Next month" onClick={() => shift(1)}><UiIcon name="chevron" size={16}/></button>
      <button type="button" onClick={() => setMonth({ y: now.getFullYear(), m: now.getMonth() })}>Today</button>
    </div>
    <div className="board-cal-grid" role="grid" aria-label={`${MONTHS[month.m]} ${month.y}`}>
      {WEEKDAYS.map(d => <div key={d} className="board-cal-weekday" role="columnheader">{d}</div>)}
      {weeks.flat().map(day => <div key={day.date} role="gridcell" className="board-cal-day" data-out={!day.inMonth || undefined} data-today={day.date === todayIso || undefined} aria-label={day.date}>
        <span className="board-cal-num">{day.day}</span>
        <ul>{(byDay.get(day.date) ?? []).map(tile)}</ul>
      </div>)}
    </div>
    {undated.length > 0 && <section className="board-cal-undated" aria-label="No due date"><h4>No due date ({undated.length})</h4><ul>{undated.map(tile)}</ul></section>}
  </div>;
}

/** Who has too much, who is free, and where work waits: agents × board columns. */
export function WorkloadView({ controller }: { controller: BoardController }) {
  const s = controller.getSnapshot();
  const [open, setOpen] = useState<{ row: string; column: string } | null>(null);
  const [showFree, setShowFree] = useState(false);
  const visible = s.cards.filter(c => matches(c, s.filter));
  const { rows, unassigned, lastColumn } = workloadMatrix(visible, s.columns, s.agents, today());
  const columns = [...s.columns].sort((a, b) => a.position - b.position);
  const busyRows = rows.filter(r => r.open > 0 || [...r.byColumn.values()].some(l => l.length));
  const freeRows = rows.filter(r => !busyRows.includes(r));
  const peak = Math.max(1, ...[...busyRows, unassigned].flatMap(r => [...r.byColumn.values()].map(l => l.length)));
  const totals = { open: busyRows.reduce((a, r) => a + r.open, 0), overdue: busyRows.reduce((a, r) => a + r.overdue, 0), over: busyRows.filter(r => r.open > OVERLOAD).length };
  const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map(w => w.slice(0, 1).toUpperCase()).join('') || '?';
  const shown = open && [...busyRows, unassigned].find(r => r.key === open.row)?.byColumn.get(open.column);

  const line = (r: WorkloadRow) => <tbody key={r.key} className="wl-group">
    <tr className="wl-row" data-over={r.open > OVERLOAD || undefined}>
      <th scope="row" className="wl-agent">
        {r.agent ? <span className="board-avatar" aria-hidden="true">{initials(r.agent.name)}</span> : <span className="wl-none" aria-hidden="true"/>}
        <span className="wl-name">{r.agent ? r.agent.name : 'Not assigned'}</span>
        {r.agent && <span className="wl-ticks" role="img" aria-label={`${r.open} open of ${OVERLOAD}`}>
          {Array.from({ length: OVERLOAD }, (_, i) => <i key={i} data-on={i < r.open || undefined}/>)}
          {r.open > OVERLOAD && <b>+{r.open - OVERLOAD}</b>}
        </span>}
      </th>
      {columns.map(c => {
        const n = r.byColumn.get(c.id)?.length ?? 0;
        const active = open?.row === r.key && open.column === c.id;
        return <td key={c.id} className="wl-cell">
          {n > 0 ? <button type="button" className="wl-heat" data-done={c.id === lastColumn || undefined} aria-pressed={active}
            style={{ ['--heat' as string]: String(0.18 + 0.82 * (n / peak)) }} aria-label={`${r.agent?.name ?? 'Not assigned'}: ${n} in ${c.name}`}
            onClick={() => setOpen(active ? null : { row: r.key, column: c.id })}>{n}</button> : <span className="wl-zero" aria-hidden="true"/>}
        </td>;
      })}
      <td className="wl-num">{r.open}</td>
      <td className="wl-num" data-alert={r.overdue > 0 || undefined}>{r.overdue || ''}</td>
      <td className="wl-num">{r.dueSoon || ''}</td>
    </tr>
    {shown && open?.row === r.key && <tr className="wl-detail"><td colSpan={columns.length + 4}>
      <ul>{shown.map(c => <li key={c.id}>
        <button type="button" className="board-link" onClick={() => void controller.openCard(c.id)}>{c.title}</button>
        <span className={`board-priority p-${c.priority}`}>{priorityLabel[c.priority]}</span>
        {c.dueDate && <span className={c.dueDate < today() ? 'board-due overdue' : 'board-due'}>Due {c.dueDate}</span>}
      </li>)}</ul>
    </td></tr>}
  </tbody>;

  return <div className="wl">
    <p className="wl-summary"><strong>{totals.open}</strong> open {totals.open === 1 ? 'card' : 'cards'} with agents, <strong data-alert={totals.overdue > 0 || undefined}>{totals.overdue}</strong> overdue,
      {' '}<strong data-alert={totals.over > 0 || undefined}>{totals.over}</strong> {totals.over === 1 ? 'agent' : 'agents'} over {OVERLOAD} open cards, <strong>{unassigned.open}</strong> open {unassigned.open === 1 ? 'card' : 'cards'} not assigned.</p>
    <div className="board-table-wrap">
      <table className="wl-table">
        <thead><tr><th scope="col" className="wl-agent">Agent</th>
          {columns.map(c => <th key={c.id} scope="col" data-done={c.id === lastColumn || undefined}>{c.name}</th>)}
          <th scope="col" className="wl-num">Open</th><th scope="col" className="wl-num">Overdue</th><th scope="col" className="wl-num">Due in 7 days</th></tr></thead>
        {busyRows.map(line)}
        {unassigned.byColumn.size > 0 && [...unassigned.byColumn.values()].some(l => l.length) && line(unassigned)}
      </table>
    </div>
    {busyRows.length === 0 && <p className="fine-print">No agent has cards on this board yet. Open a card and add agents to share out the work.</p>}
    {freeRows.length > 0 && <div className="wl-free">
      <button type="button" className="board-ghost" aria-expanded={showFree} onClick={() => setShowFree(v => !v)}>{freeRows.length} {freeRows.length === 1 ? 'agent has' : 'agents have'} no cards on this board</button>
      {showFree && <p>{freeRows.map(r => r.agent!.name).join(', ')}</p>}
    </div>}
  </div>;
}
