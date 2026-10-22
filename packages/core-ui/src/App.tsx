import {DproMark} from './DproMark';
import { AuthBoundary } from './AuthBoundary';
import type { SessionClient } from './session';
import { useEffect, useReducer, useRef, useState } from 'react';
import { catalogs } from './catalogs';
import { destinations, filterDestinations, initialState, isPaletteShortcut, nextResult, reducer } from './model';
import type { Destination, Locale, Scenario, State } from './model';
import { Icon } from './icons';
import { MemoryDestination } from './MemoryDestination';
import type { IconName } from './icons';
const icons: Record<Destination, IconName> = { chat: 'message-circle', agents: 'user', memory: 'database', tasks: 'clock', settings: 'settings', channels: 'messages' };

export function App({ seed, client }: { seed?: State; client?: SessionClient }) {
  return <AuthBoundary client={client}><FixtureShell seed={seed}/></AuthBoundary>;
}
function FixtureShell({ seed }: { seed?: State }) {
  const [state, dispatch] = useReducer(reducer, seed ?? initialState());
  const c = catalogs[state.locale];
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const shouldFocusHeading = useRef(false);
  const results = filterDestinations(query, c);
  function openPalette() {
    if (palette) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQuery(''); setActive(0); setPalette(true);
  }
  function closePalette() { setPalette(false); }
  function navigate(destination: Destination) {
    shouldFocusHeading.current = true;
    if (!palette && destination === state.destination) { heading.current?.focus(); shouldFocusHeading.current = false; }
    dispatch({ type: 'navigate', destination });
    closePalette();
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event)) { event.preventDefault(); openPalette(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  });
  useEffect(() => {
    document.documentElement.lang = state.locale;
    document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr';
  }, [state.locale]);
  useEffect(() => {
    if (palette) { dialog.current?.showModal(); search.current?.focus(); }
    else {
      if (dialog.current?.open) { dialog.current.close(); returnFocus.current?.focus(); }
      if (shouldFocusHeading.current) { heading.current?.focus(); shouldFocusHeading.current = false; }
    }
  }, [palette, state.destination]);
  const invalid = state.notice === 'invalid' || state.notice === 'reserved';
  return <div className="shell" data-theme={state.theme} lang={state.locale} dir={state.locale === 'ar' ? 'rtl' : 'ltr'}>
    <a className="skip" href="#content">{c.skip}</a>
    <header className="titlebar">
      <span className="brand"><DproMark/>Dpro</span>
      <div className="toolbar">
        <button className="ghost" onClick={openPalette} aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K"><Icon name="command"/>{c.commands} <kbd>⌘K / Ctrl K</kbd></button>
        <button className="ghost" onClick={() => dispatch({ type: 'theme' })}>{c.theme}</button>
        <label className="sr-only" htmlFor="locale">{c.language}</label>
        <select id="locale" value={state.locale} onChange={e => dispatch({ type: 'locale', value: e.target.value as Locale })}>
          <option value="en">English</option><option value="ar">العربية</option><option value="de">Deutsch</option>
        </select>
      </div>
    </header>
    <aside className="sidebar">
      <p className="section-label"><span className="checker" aria-hidden="true"/>{c.workspace}</p>
      <nav aria-label={c.workspace}>{destinations.map(key => <button key={key} className="nav-item" aria-current={state.destination === key ? 'page' : undefined} onClick={() => navigate(key)}><Icon name={icons[key]}/>{c[key]}</button>)}</nav>
      <div className="sidebar-note"><span>{c.disconnected}</span><bdi>{state.name}</bdi><p>{c.draftTranslations}</p></div>
    </aside>
    <main id="content" tabIndex={-1}>
      <div className="pane-heading"><h1 ref={heading} tabIndex={-1}>{c[state.destination]}</h1>
        {state.destination !== 'memory' && <label className="scenario">{c.scenario}<select value={state.scenario} onChange={e => dispatch({ type: 'scenario', value: e.target.value as Scenario })}>{(['empty', 'error', 'stale'] as const).map(key => <option key={key} value={key}>{c[key]}</option>)}</select></label>}
      </div>
      <div className="pane-content">
        {state.destination === 'agents' ? <section aria-labelledby="identity">
          <h2 id="identity">{c.identity}: <bdi>{state.name}</bdi></h2>
          <form onSubmit={e => { e.preventDefault(); dispatch({ type: 'save' }); }}>
            <label htmlFor="agent-name">{c.name}</label>
            <input id="agent-name" autoComplete="off" dir="auto" value={state.draft} aria-invalid={invalid || undefined} aria-describedby={`name-help${state.notice ? ' name-notice' : ''}`} onChange={e => dispatch({ type: 'draft', value: e.target.value })}/>
            <p id="name-help" className="muted">{c.nameHelp}</p>
            <div className="actions"><button type="button" onClick={() => dispatch({ type: 'generate', entropy: crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 })}><Icon name="dice"/>{c.generate}</button><button type="submit" className="primary" disabled={state.draft === state.name}>{c.save}</button><button type="button" onClick={() => dispatch({ type: 'cancel' })}>{c.cancel}</button></div>
            <p id="name-notice" role="status" className={invalid ? 'error' : ''}>{state.notice ? c[state.notice] : ''}</p>
          </form><p>{c.personality}</p>
        </section> : null}
        {state.destination === 'memory' ? <MemoryDestination locale={state.locale}/> : null}
        {state.destination === 'tasks' ? <p>{c.taskHelp}</p> : null}
        {state.destination === 'settings' ? <section aria-labelledby="security"><h2 id="security">{c.security}</h2><ul className="policy">{[c.auth, c.execution, c.sandbox, c.remote, c.credentials].map(line => <li key={line}>{line}</li>)}</ul></section> : null}
        {state.destination === 'channels' ? <section><p className="badge">{c.restricted}</p><p>{c.channelHelp}</p><ul className="policy">{[c.tools, c.never, c.scope].map(line => <li key={line}>{line}</li>)}</ul></section> : null}
        {state.destination !== 'memory' && <section className={`state-panel ${state.scenario}`} aria-live="polite" aria-atomic="true">
          <h2>{c[`${state.scenario}Title`]}</h2><p>{c[`${state.scenario}Body`]}</p>
        </section>}
        {state.destination === 'chat' ? <form className="composer" onSubmit={e => e.preventDefault()}><label htmlFor="message">{c.message}</label><textarea id="message" disabled aria-describedby="chat-help"/><div className="actions"><p id="chat-help" className="muted">{c.chatHelp}</p><button disabled>{c.send}</button></div></form> : null}
      </div>
    </main>
    <footer className="statusbar"><span>{c.fixture}</span><span>{c.disconnected}</span><span>{c.unknown}</span></footer>
    <dialog ref={dialog} className="palette" aria-labelledby="commands-title" onCancel={e => { e.preventDefault(); closePalette(); }} onClose={() => setPalette(false)}>
      <h2 id="commands-title" className="sr-only">{c.commands}</h2>
      <div className="search-row"><label className="sr-only" htmlFor="command-search">{c.search}</label><input ref={search} id="command-search" role="combobox" aria-autocomplete="list" aria-expanded={palette} aria-controls="command-results" aria-activedescendant={results[active] ? `command-${results[active]}` : undefined} value={query} placeholder={c.search} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={e => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(nextResult(active, results.length, e.key)); }
        if (e.key === 'Enter' && results[active]) { e.preventDefault(); navigate(results[active]); }
      }}/></div>
      <div id="command-results" role="listbox" aria-label={c.commands}>{results.map((key, index) => <div id={`command-${key}`} role="option" aria-selected={active === index} key={key} className="command-result" onMouseDown={e => e.preventDefault()} onClick={() => navigate(key)}><Icon name={icons[key]}/>{c[key]}</div>)}</div>
      {!results.length && <p role="status">{c.noResults}</p>}<p className="palette-hint">{c.keyboard}</p><button className="palette-close" onClick={closePalette}>{c.close}</button>
    </dialog>
  </div>;
}
