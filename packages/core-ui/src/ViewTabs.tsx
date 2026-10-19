import type { KeyboardEvent } from 'react';

/** Compact pane tabs with automatic activation and direction-aware keyboard navigation. */
export function ViewTabs<T extends string>({ id, label, value, tabs, onChange }: {
  id: string; label: string; value: T; tabs: readonly { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const rtl = event.currentTarget.ownerDocument.defaultView?.getComputedStyle(event.currentTarget).direction === 'rtl';
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'ArrowRight') next = (index + (rtl ? -1 : 1) + tabs.length) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + (rtl ? 1 : -1) + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
    onChange(tabs[next].value);
  }
  return <div className="pane-tabs" role="tablist" aria-label={label}>{tabs.map((tab, index) =>
    <button key={tab.value} type="button" role="tab" id={`${id}-${tab.value}`} aria-controls={`${id}-panel`} aria-selected={value === tab.value} tabIndex={value === tab.value ? 0 : -1} onClick={() => onChange(tab.value)} onKeyDown={event => navigate(event, index)}>{tab.label}</button>
  )}</div>;
}
