import {Icon} from './icons';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ChatSearchController, ChatSearchState } from './chat-search';
import { HitSnippet, resultTitle } from './ChatSearch';

export type Command = { id: string; label: string; group: string; hint?: string; icon?: ReactNode; keywords?: string; detail?: ReactNode; run: () => void };
/** CHAT-PRO-02 D: the ⌘K box also searches inside the chats. */
export type PaletteSearch = { controller: ChatSearchController; onOpen: (conversationId: string, messageId: string | null) => void };

const noSearch = () => () => {};
const idleSearch = (): ChatSearchState => ({ query: '', phase: 'idle', results: [], truncated: false });
/** Hits from inside the chats the ⌘K box lists. */
export const PALETTE_HITS = 12;

/** The ⌘K command box: a floating HUD at the top centre; type to filter, arrows to move, Enter to run, Esc to close. */
export function CommandPalette({ open, commands, onClose, search }: { open: boolean; commands: readonly Command[]; onClose: () => void; search?: PaletteSearch }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const found = useSyncExternalStore(search ? search.controller.subscribe : noSearch, search ? search.controller.getSnapshot : idleSearch, search ? search.controller.getSnapshot : idleSearch);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = commands.filter(c => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q) || c.keywords?.toLowerCase().includes(q));
    if (!search || found.phase !== 'ready' || found.query !== query.trim()) return matched;
    const hits: Command[] = found.results.flatMap(r => r.hits.filter(h => h.kind !== 'title').map(h => ({
      id: `hit-${h.messageId}`, icon:<Icon name="message-circle"/>, group: 'In conversations', label: resultTitle(r), detail: <HitSnippet hit={h}/>,
      run: () => search.onOpen(r.conversationId, h.messageId),
    }))).slice(0, PALETTE_HITS);
    return [...matched, ...hits];
  }, [commands, query, found, search]);
  useEffect(() => { if (open) { setQuery(''); setIndex(0); search?.controller.clear(); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => { if (open) search?.controller.setQuery(query); }, [query]);
  useEffect(() => { setIndex(0); }, [query]);
  if (!open) return null;
  const run = (c: Command | undefined) => { if (!c) return; onClose(); c.run(); };
  let lastGroup = '';
  return <div className="cmdk-layer" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="cmdk" role="dialog" aria-label="Commands" aria-modal="true">
      <input ref={input} className="cmdk-input" aria-label="Type a command" placeholder={search ? 'Type a command, a page or words from a chat…' : 'Type a command or a page…'} value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(i + 1, list.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); run(list[index]); }
        }}/>
      <ul className="cmdk-list" role="listbox" aria-label="Commands">
        {list.map((c, i) => {
          const heading = c.group !== lastGroup ? (lastGroup = c.group) : null;
          return <li key={c.id} role="presentation">
            {heading && <p className="cmdk-group">{heading}</p>}
            <button type="button" role="option" aria-selected={i === index} className="cmdk-item" data-detail={c.detail ? true : undefined} onMouseEnter={() => setIndex(i)} onClick={() => run(c)}>
              {c.icon&&<span className="cmdk-icon" aria-hidden="true">{c.icon}</span>}{c.detail ? <span className="cmdk-hit"><span dir="auto">{c.label}</span>{c.detail}</span> : <span>{c.label}</span>}{c.hint && <kbd>{c.hint}</kbd>}
            </button>
          </li>;
        })}
        {search && found.phase === 'searching' && <li className="cmdk-empty" role="status">Searching the chats…</li>}
        {list.length === 0 && found.phase !== 'searching' && <li className="cmdk-empty">Nothing matches “{query}”.</li>}
      </ul>
    </div>
  </div>;
}
