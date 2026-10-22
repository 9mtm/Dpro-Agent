// Small desktop building blocks: right-click menus, popovers, sheets, a quiet
// notice with Undo, icon buttons with tooltips, project tiles and avatars.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { initial, tileColour } from './memory-desktop';

export type MenuItem = { label: string; run: () => void; icon?: UiIconName; shortcut?: string; danger?: boolean; disabled?: boolean } | 'sep';
export type MenuAt = { x: number; y: number; items: MenuItem[]; invoker?: HTMLElement } | null;

/** Opens a menu at the pointer (right-click) or under a button (⋯). */
export function useMenu() {
  const [menu, setMenu] = useState<MenuAt>(null);
  const at = (e: ReactMouseEvent | ReactKeyboardEvent, items: MenuItem[]) => {
    e.preventDefault(); e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const anchored = e.type === 'click' || e.type === 'keydown';
    setMenu({ x: anchored ? r.right : (e as ReactMouseEvent).clientX, y: anchored ? r.bottom + 4 : (e as ReactMouseEvent).clientY, items, invoker: e.currentTarget as HTMLElement });
  };
  return { menu, at, close: () => setMenu(null) };
}

export function ContextMenu({ menu, onClose }: { menu: MenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); if (menu.invoker?.isConnected) menu.invoker.focus(); } };
    window.addEventListener('mousedown', close, true); window.addEventListener('keydown', key, true); window.addEventListener('blur', onClose);
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); };
  }, [menu, onClose]);
  if (!menu) return null;
  const width = 260;
  const left = typeof window === 'undefined' ? menu.x : Math.max(8, Math.min(menu.x - (menu.x > window.innerWidth - width ? width : 0), window.innerWidth - width - 8));
  const top = typeof window === 'undefined' ? menu.y : Math.min(menu.y, window.innerHeight - 24 - menu.items.length * 28);
  function move(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  }
  return <div ref={ref} className="dk-menu" role="menu" style={{ left, top, inlineSize: width }} onKeyDown={move}>
    {menu.items.map((m, i) => m === 'sep' ? <hr key={i}/> : <button key={i} type="button" role="menuitem" disabled={m.disabled} data-danger={m.danger || undefined} onClick={() => { onClose(); m.run(); }}>
      {m.icon ? <UiIcon name={m.icon} size={14}/> : <span className="dk-menu-gap"/>}<span className="dk-menu-label">{m.label}</span>{m.shortcut && <kbd>{m.shortcut}</kbd>}
    </button>)}
  </div>;
}

/** An icon-only button with a tooltip and an accessible name (shortcut shown in the tooltip). */
export function IconButton({ icon, label, shortcut, onClick, pressed, disabled, badge, danger }: { icon: UiIconName; label: string; shortcut?: string; onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void; pressed?: boolean; disabled?: boolean; badge?: number; danger?: boolean }) {
  const tip = shortcut ? `${label} (${shortcut})` : label;
  return <button type="button" className="dk-icon" aria-label={label} title={tip} aria-pressed={pressed} disabled={disabled} data-danger={danger || undefined} onClick={onClick}>
    <UiIcon name={icon} size={15}/>{badge ? <span className="dk-badge">{badge}</span> : null}
  </button>;
}

/** A small popover under its button; Esc or a click outside closes it. */
export function Popover({ open, onClose, label, children, wide }: { open: boolean; onClose: () => void; label: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { const t = e.target as HTMLElement; if (!ref.current?.contains(t) && !t.closest?.('[data-popover-anchor]')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('mousedown', close, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className="dk-popover" data-wide={wide || undefined} role="dialog" aria-label={label}>{children}</div>;
}

/** A sheet: a short task that blocks only this window (Esc = Cancel, Enter in a field = the main button). */
export function Sheet({ title, onClose, children, actions, wide }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], textarea, input, select, button.primary');
    first?.focus();
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return <div className="dk-sheet-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} className="dk-sheet" data-wide={wide || undefined} role="dialog" aria-modal="true" aria-label={title}>
      <h3 className="dk-sheet-title">{title}</h3>
      <div className="dk-sheet-body">{children}</div>
      {actions && <div className="dk-sheet-actions">{actions}</div>}
    </div>
  </div>;
}

/** The quiet notice at the bottom of the window; fades after a few seconds. */
export function Notice({ toast, onUndo, onShow, onDone }: { toast: { id: number; text: string; undo: boolean; show?: unknown } | null; onUndo: () => void; onShow?: () => void; onDone: (id: number) => void }) {
  useEffect(() => { if (!toast) return; const t = setTimeout(() => onDone(toast.id), toast.undo ? 8000 : 4000); return () => clearTimeout(t); }, [toast?.id]);
  if (!toast) return null;
  return <div className="dk-notice" role="status"><span dir="auto">{toast.text}</span>
    {toast.undo && <button type="button" className="link-button" onClick={onUndo}>Undo</button>}
    {toast.show !== undefined && onShow && <button type="button" className="link-button" onClick={onShow}>Show</button>}
  </div>;
}

/** A project's coloured tile (its first letter on its colour). */
export function Tile({ name, colour, size = 16 }: { name: string; colour?: string; size?: number }) {
  return <span className="dk-tile" aria-hidden="true" style={{ background: colour ?? tileColour(name), inlineSize: size, blockSize: size, fontSize: Math.round(size * .62) }}>{initial(name)}</span>;
}
/** A person's or agent's round avatar. */
export function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  return <span className="dk-avatar" title={name} style={{ background: tileColour(name), inlineSize: size, blockSize: size, fontSize: Math.round(size * .55) }}>{initial(name)}</span>;
}
export function Avatars({ names, max = 3 }: { names: readonly string[]; max?: number }) {
  return <span className="dk-avatars" aria-label={names.join(', ')}>{names.slice(0, max).map(n => <Avatar key={n} name={n}/>)}{names.length > max && <span className="dk-more">+{names.length - max}</span>}</span>;
}
/** A colour value with its swatch. */
export function Swatch({ value, label }: { value: string; label?: string }) {
  return <span className="dk-swatch-wrap"><span className="dk-swatch" style={{ background: value }} aria-hidden="true"/>{label ?? value}</span>;
}
/** Text with every colour code drawn as a swatch ("teal #003f4d" → teal ■ #003f4d). */
export function WithSwatches({ text }: { text: string }) {
  const parts = text.split(/(#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b)/g);
  return <>{parts.map((p, i) => i % 2 ? <span key={i} className="dk-inline-swatch"><span className="dk-swatch" style={{ background: p }} aria-hidden="true"/>{p}</span> : p)}</>;
}
