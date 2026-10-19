import { useAppInfo } from './app-navigation';
import type { ThemePreference } from './app-navigation';
export function AppSettings({ signedIn, preference, onTheme, onAccount, onAgents, aboutOnly = false }: { signedIn: boolean; preference: ThemePreference; onTheme: (v: ThemePreference) => void; onAccount: () => void; onAgents?: () => void; aboutOnly?: boolean }) {
  const info = useAppInfo();
  return <div className="page-column app-settings"><h1>{aboutOnly ? 'About Dpro' : 'Settings'}</h1>
    {!aboutOnly && <><section aria-label="General settings"><h2>General</h2><label htmlFor="app-theme">Appearance</label><select id="app-theme" value={preference} onChange={e => onTheme(e.target.value as ThemePreference)}><option value="system">Use system appearance</option><option value="light">Light</option><option value="dark">Dark</option></select><p className="fine-print">Only this device’s appearance preference is saved here.</p></section>
    <section aria-label="Account and privacy"><h2>Account &amp; privacy</h2><p>{signedIn ? 'Your workspace is available to your signed-in account. Manage your profile and sessions separately.' : 'Sign in to access conversations, agents, memory and tools. Your private workspace is not loaded on this screen.'}</p><button onClick={onAccount}>{signedIn ? 'Manage account' : 'Sign in'}</button></section>
    <section aria-label="Models and permissions"><h2>Models &amp; tools</h2><p>Choose models and review tool permissions on each agent’s profile.</p><button onClick={signedIn && onAgents ? onAgents : onAccount}>{signedIn ? 'Open agents & permissions' : 'Sign in to manage agents'}</button></section></>}
    <section aria-label="Application information"><h2>Application</h2><dl><dt>Version</dt><dd>{info?.version ?? 'Web application'}</dd><dt>Connection</dt><dd>{info ? (info.connection === 'local' ? 'This computer' : 'Existing Dpro connection') : 'Browser connection'}</dd></dl><h3>Updates</h3><p>Automatic updates are not available in this build. Install a verified newer package while keeping your existing workspace.</p></section>
  </div>;
}
