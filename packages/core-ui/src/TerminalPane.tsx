import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TerminalController, TerminalPrefsController, TerminalTabs } from './terminal';
import { MAX_TERMINAL_TABS } from './terminal';
import { TERMINAL_CURSORS, TERMINAL_FONTS, TERMINAL_THEMES } from './terminal-contract.js';
import type { TerminalPrefs } from './terminal-contract.js';
import { FONTS, PALETTES } from './terminal-themes';
import { UiIcon } from './ui-icons';

type Xterm = import('@xterm/xterm').Terminal;
const shortPath = (p: string) => { const home = p.match(/^\/Users\/[^/]+/)?.[0]; return home ? `~${p.slice(home.length)}` : p; };
const xtermOptions = (p: TerminalPrefs) => ({
  theme: PALETTES[p.theme], fontFamily: FONTS[p.fontFamily].stack, fontSize: p.fontSize, lineHeight: p.lineHeight, letterSpacing: p.letterSpacing,
  cursorStyle: p.cursorStyle, cursorBlink: p.cursorBlink, scrollback: p.scrollback,
});

/**
 * The terminal pane: tabs of real shells in the project folder, a toolbar
 * (new tab, clear, settings, maximize) and a status line. The look is the
 * owner's saved terminal settings, applied live.
 */
export function TerminalPane({ tabs, prefs, projectId, maximized, onToggleMax, onClose }: { tabs: TerminalTabs; prefs: TerminalPrefsController; projectId: string | null; maximized: boolean; onToggleMax: () => void; onClose?: () => void }) {
  const t = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot, tabs.getSnapshot);
  const p = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot, prefs.getSnapshot);
  const [settings, setSettings] = useState(false);
  const [size, setSize] = useState<Record<string, string>>({});
  const project = useRef<string | null | undefined>(undefined);
  useEffect(() => { void prefs.load(); }, [prefs]);
  // Opening the pane, or a different project, starts one shell in its folder. Closing the
  // last tab closes the pane instead of starting a new shell.
  useEffect(() => {
    if (project.current !== undefined && project.current !== projectId) tabs.closeAll();
    project.current = projectId;
    if (!tabs.getSnapshot().tabs.length) tabs.add();
  }, [tabs, projectId]);
  const closeTab = (key: string) => { const last = tabs.getSnapshot().tabs.length === 1; tabs.close(key); if (last) onClose?.(); };
  const active = t.tabs.find(x => x.key === t.active) ?? null;
  const pal = PALETTES[p.theme];
  return <div className="pane terminal-pane" aria-label="Terminal" data-term-dark={pal.dark || undefined}
    style={{ ['--term-bg' as string]: pal.background, ['--term-fg' as string]: pal.foreground }}>
    <div className="term-bar">
      <div className="term-tabs" role="tablist" aria-label="Terminals">
        {t.tabs.map(x => <TabButton key={x.key} n={x.n} terminal={x.terminal} active={x.key === t.active} onSelect={() => tabs.select(x.key)} onClose={() => closeTab(x.key)}/>)}
        <button type="button" className="term-tool" aria-label="New terminal" title={t.tabs.length >= MAX_TERMINAL_TABS ? `Up to ${MAX_TERMINAL_TABS} terminals` : 'New terminal'}
          disabled={t.tabs.length >= MAX_TERMINAL_TABS} onClick={() => tabs.add()}><UiIcon name="plus" size={12}/></button>
      </div>
      <div className="term-actions">
        <button type="button" className="term-tool" aria-label="Clear" title="Clear the screen" disabled={!active} onClick={() => active?.terminal.clear()}><UiIcon name="eraser" size={12}/></button>
        <button type="button" className="term-tool" aria-label="Terminal settings" aria-expanded={settings} title="Theme, font and cursor" onClick={() => setSettings(v => !v)}><UiIcon name="gear" size={12}/></button>
        <button type="button" className="term-tool" aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'} onClick={onToggleMax}><UiIcon name={maximized ? 'shrink' : 'expand'} size={12}/></button>
        {onClose && <button type="button" className="term-tool" aria-label="Hide terminal" title="Hide terminal (shells keep running)" onClick={onClose}><UiIcon name="close" size={11}/></button>}
      </div>
    </div>
    {settings && <TerminalSettings prefs={prefs} p={p} onClose={() => setSettings(false)}/>}
    <div className="term-body">
      {t.tabs.map(x => <TerminalScreen key={x.key} terminal={x.terminal} p={p} projectId={projectId} visible={x.key === t.active} onSize={s => setSize(v => ({ ...v, [x.key]: s }))}/>)}
    </div>
    {active && <TermStatus terminal={active.terminal} size={size[active.key]} theme={pal.label}/>}
  </div>;
}

function TabButton({ n, terminal, active, onSelect, onClose }: { n: number; terminal: TerminalController; active: boolean; onSelect: () => void; onClose: () => void }) {
  const s = useSyncExternalStore(terminal.subscribe, terminal.getSnapshot, terminal.getSnapshot);
  const folder = s.cwd ? s.cwd.split('/').filter(Boolean).at(-1) : '';
  return <span className="term-tab" role="tab" aria-selected={active} data-phase={s.phase}>
    <button type="button" className="term-tab-open" onClick={onSelect} title={s.cwd ? shortPath(s.cwd) : undefined}>
      <i className="term-dot" aria-hidden="true"/>{s.shell || 'shell'} {n}{folder ? <span className="term-tab-dir"> · {folder}</span> : null}
    </button>
    <button type="button" className="term-tab-close" aria-label={`Close terminal ${n}`} onClick={onClose}><UiIcon name="close" size={9}/></button>
  </span>;
}

function TermStatus({ terminal, size, theme }: { terminal: TerminalController; size?: string; theme: string }) {
  const s = useSyncExternalStore(terminal.subscribe, terminal.getSnapshot, terminal.getSnapshot);
  return <div className="term-status" dir="ltr">
    <span className="term-status-item" title={s.cwd}><UiIcon name="folder" size={10}/>{s.cwd ? shortPath(s.cwd) : '…'}</span>
    <span className="term-status-item">{s.phase === 'open' ? 'running' : s.phase === 'starting' ? 'starting' : s.phase}</span>
    <span className="term-status-spacer"/>
    {size && <span className="term-status-item">{size}</span>}
    <span className="term-status-item">{theme}</span>
  </div>;
}

/** One shell's screen. Stays mounted while hidden so its scrollback is kept. */
function TerminalScreen({ terminal, p, projectId, visible, onSize }: { terminal: TerminalController; p: TerminalPrefs; projectId: string | null; visible: boolean; onSize: (s: string) => void }) {
  const s = useSyncExternalStore(terminal.subscribe, terminal.getSnapshot, terminal.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const size = useRef({ cols: 80, rows: 24 });
  const prefsRef = useRef(p); prefsRef.current = p;

  useEffect(() => { if (s.phase === 'idle') void terminal.open(projectId, size.current); }, [terminal, projectId, s.phase]);
  useEffect(() => {
    const el = host.current; if (!el) return;
    let stop = () => {}; let cancelled = false;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]);
      if (cancelled) return;
      const x = new Terminal({ ...xtermOptions(prefsRef.current), allowProposedApi: false, macOptionIsMeta: true, rightClickSelectsWord: true, drawBoldTextInBrightColors: true });
      const fit = new FitAddon(); x.loadAddon(fit);
      x.open(el); term.current = x;
      const refit = () => { if (!el.offsetParent) return; try { fit.fit(); size.current = { cols: x.cols, rows: x.rows }; terminal.resize(x.cols, x.rows); onSize(`${x.cols}×${x.rows}`); } catch { /* hidden */ } };
      fitRef.current = refit; refit();
      const offOut = terminal.onOutput(d => x.write(d));
      const offClear = terminal.onClear(() => x.clear());
      const input = x.onData(d => terminal.write(d));
      const sel = x.onSelectionChange(() => { const text = x.getSelection(); if (prefsRef.current.copyOnSelect && text) void navigator.clipboard?.writeText(text).catch(() => {}); });
      const ro = new ResizeObserver(refit); ro.observe(el);
      if (el.offsetParent) x.focus();
      stop = () => { ro.disconnect(); input.dispose(); sel.dispose(); offOut(); offClear(); x.dispose(); term.current = null; fitRef.current = null; };
    })();
    return () => { cancelled = true; stop(); };
  }, [terminal]);
  // Settings apply live; the grid is measured again after a font change.
  useEffect(() => { const x = term.current; if (!x) return; Object.assign(x.options, xtermOptions(p)); fitRef.current?.(); }, [p]);
  useEffect(() => { if (visible) { fitRef.current?.(); term.current?.focus(); } }, [visible]);

  return <div className="term-screen-wrap" hidden={!visible}>
    {(s.phase === 'off' || s.phase === 'error' || s.phase === 'exited') && <p className={s.phase === 'exited' ? 'term-note' : 'term-note error'} role="status">
      {s.phase === 'exited' ? 'The shell has exited.' : s.message} {s.phase !== 'off' && <button type="button" className="link-button" onClick={() => void terminal.close()}>Start again</button>}</p>}
    <div className="terminal-screen" ref={host} dir="ltr"/>
  </div>;
}

/** Theme, font, cursor and buffer settings, saved for this owner. */
function TerminalSettings({ prefs, p, onClose }: { prefs: TerminalPrefsController; p: TerminalPrefs; onClose: () => void }) {
  const set = (c: Partial<TerminalPrefs>) => prefs.update(c);
  return <section className="term-settings" aria-label="Terminal settings" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <div className="term-settings-head"><strong>Terminal</strong><button type="button" className="term-tool" aria-label="Close settings" onClick={onClose}><UiIcon name="close" size={10}/></button></div>
    <fieldset className="term-themes"><legend>Theme</legend>
      {TERMINAL_THEMES.map(id => { const pal = PALETTES[id]; return <button key={id} type="button" className="term-theme" aria-pressed={p.theme === id} onClick={() => set({ theme: id })} title={pal.label}
        style={{ background: pal.background, color: pal.foreground, borderColor: p.theme === id ? pal.cursor : undefined }}>
        <span className="term-theme-name">{pal.label}</span>
        <span className="term-theme-dots" aria-hidden="true">{[pal.red, pal.green, pal.yellow, pal.blue, pal.magenta, pal.cyan].map(c => <i key={c} style={{ background: c }}/>)}</span>
      </button>; })}
    </fieldset>
    <div className="term-grid">
      <label>Font<select value={p.fontFamily} onChange={e => set({ fontFamily: e.target.value as TerminalPrefs['fontFamily'] })}>
        {TERMINAL_FONTS.map(f => <option key={f} value={f}>{FONTS[f].label}</option>)}</select></label>
      <label>Size<span className="term-stepper">
        <button type="button" aria-label="Smaller text" onClick={() => set({ fontSize: Math.max(9, p.fontSize - 1) })}>−</button>
        <output>{p.fontSize}px</output>
        <button type="button" aria-label="Larger text" onClick={() => set({ fontSize: Math.min(24, p.fontSize + 1) })}>+</button></span></label>
      <label>Line height<input type="range" min={1} max={1.8} step={0.05} value={p.lineHeight} onChange={e => set({ lineHeight: Number(e.target.value) })}/><output>{p.lineHeight.toFixed(2)}</output></label>
      <label>Letter spacing<input type="range" min={0} max={3} step={0.5} value={p.letterSpacing} onChange={e => set({ letterSpacing: Number(e.target.value) })}/><output>{p.letterSpacing}</output></label>
      <label>Cursor<span className="seg small" role="radiogroup" aria-label="Cursor style">{TERMINAL_CURSORS.map(c =>
        <button key={c} type="button" role="radio" aria-checked={p.cursorStyle === c} onClick={() => set({ cursorStyle: c })}>{c === 'block' ? '█' : c === 'bar' ? '▏' : '▁'} {c}</button>)}</span></label>
      <label className="term-check"><input type="checkbox" checked={p.cursorBlink} onChange={e => set({ cursorBlink: e.target.checked })}/>Blinking cursor</label>
      <label>History<select value={p.scrollback} onChange={e => set({ scrollback: Number(e.target.value) })}>
        {[1000, 5000, 10000, 25000, 50000].map(n => <option key={n} value={n}>{n.toLocaleString('en')} lines</option>)}</select></label>
      <label className="term-check"><input type="checkbox" checked={p.copyOnSelect} onChange={e => set({ copyOnSelect: e.target.checked })}/>Copy on select</label>
    </div>
    <div className="term-settings-foot"><button type="button" className="link-button" onClick={() => prefs.reset()}>Reset to defaults</button><span className="muted">Saved for your account.</span></div>
  </section>;
}
