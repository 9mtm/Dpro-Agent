import { useEffect, useState } from 'react';
export type AppDestination = 'home' | 'settings' | 'account' | 'about';
type AppInfo = { version: string; connection: 'local' | 'remote' };
declare global { interface Window { dproApp?: { onNavigate: (fn: (page: AppDestination) => void) => () => void; info: () => Promise<AppInfo> }; } }
export function useAppNavigation(open: (page: AppDestination) => void) {
  useEffect(() => window.dproApp?.onNavigate(page => { if (['home', 'settings', 'account', 'about'].includes(page)) open(page); }), [open]);
}
export function useAppInfo() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { let active = true; void window.dproApp?.info().then(value => { if (active && typeof value.version === 'string') setInfo(value); }).catch(() => {}); return () => { active = false; }; }, []);
  return info;
}
export type ThemePreference = 'system' | 'light' | 'dark';
export function useAppTheme() {
  const [preference, update] = useState<ThemePreference>(() => { try { const value = localStorage.getItem('dpro.theme'); if (value === 'light' || value === 'dark') return value; } catch { /* optional preference store */ } return 'system'; });
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  useEffect(() => { const media = window.matchMedia?.('(prefers-color-scheme: dark)'); const changed = () => setSystemDark(!!media?.matches); media?.addEventListener('change', changed); return () => media?.removeEventListener('change', changed); }, []);
  const setPreference = (value: ThemePreference) => { update(value); try { localStorage.setItem('dpro.theme', value); } catch { /* session-only if storage unavailable */ } };
  return { preference, setPreference, theme: preference === 'system' ? (systemDark ? 'dark' : 'light') : preference };
}
