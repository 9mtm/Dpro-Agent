import { useEffect,useState } from 'react';
import type { ReactNode } from 'react';
import { AppSettings } from './AppSettings';
import { useAppNavigation, useAppTheme } from './app-navigation';
import type { AppDestination } from './app-navigation';
export function PublicShell({ children, setup, notice, initialPage = 'home', blocking=false, accountStep=false }: { children: ReactNode; setup?: string; notice?: ReactNode; initialPage?: 'home' | 'account';blocking?:boolean;accountStep?:boolean }) {
  const [page, setPage] = useState<AppDestination>(accountStep?'account':initialPage);
  useEffect(()=>{if(accountStep)setPage('account');},[accountStep]);
  const activePage=blocking?'account':page;
  const appearance = useAppTheme(); useAppNavigation(setPage);
  const ready = setup === 'login' || setup === 'required';
  return <div className="shell app-shell public-shell" data-theme={appearance.theme} lang="en" dir="ltr">
    <header className="titlebar" inert={blocking}><span className="sidebar-brand">Dpro Agent</span><span className="titlebar-title">Your workspace</span><div className="titlebar-tools end"><button onClick={() => setPage('settings')}>Settings</button><button onClick={() => setPage('account')}>Sign in</button></div></header>
    <aside className="sidebar" inert={blocking}><nav aria-label="Application"><button className="nav-item" aria-current={activePage === 'home' ? 'page' : undefined} onClick={() => setPage('home')}>Welcome</button><button className="nav-item" disabled>Conversations · Sign in required</button><button className="nav-item" disabled>Agents &amp; tools · Sign in required</button><button className="nav-item" disabled>Memory · Sign in required</button><button className="nav-item" onClick={() => setPage('settings')}>Settings</button><button className="nav-item" onClick={() => setPage('about')}>About Dpro Agent</button></nav><div className="sidebar-bottom"><button className="user-chip" onClick={() => setPage('account')}>Not signed in</button></div></aside>
    <main className="page-area public-content">{notice && <p role="status" className="page-notice">{notice}</p>}
      {activePage === 'home' ? <section className="public-welcome"><p className="fine-print">Your agents. Your workspace.</p><h1>Welcome to Dpro Agent</h1><p>Your conversations and tools stay private until you sign in.</p><button className="primary" onClick={() => setPage('account')}>{setup === 'required' ? 'Finish workspace setup' : 'Sign in to your workspace'}</button><button onClick={() => setPage('settings')}>Open settings</button><p className="fine-print">{setup === 'required' ? 'This workspace still needs its first owner. Existing users should open their previous workspace from File.' : ready ? 'An existing workspace is ready. Use your previous account.' : 'Checking the workspace connection. No private data has been loaded.'}</p></section>
      : activePage === 'account' ? <div className="public-account">{!blocking&&<button onClick={() => setPage('home')}>Back to welcome</button>}{children}</div>
      : <AppSettings signedIn={false} preference={appearance.preference} onTheme={appearance.setPreference} onAccount={() => setPage('account')} aboutOnly={activePage === 'about'}/>}
    </main><footer className="statusbar"><span role="status">{ready ? 'Engine available' : setup === 'unavailable' ? 'Engine unavailable' : 'Checking engine…'}</span><span>Not signed in · Private tools locked</span></footer>
  </div>;
}
