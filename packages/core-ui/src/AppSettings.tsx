import {SpecialtyLibrary} from './SpecialtyLibrary';
import { McpLibrary } from './McpLibrary';
import { SkillLibrary } from './SkillLibrary';
import { useState } from 'react';
import { AgentConnectSettings } from './AgentConnectSettings';
import { ConnectionsSettings } from './ConnectionsSettings';
import type { SessionClient } from './session';
import { ViewTabs } from './ViewTabs';
import { useAppInfo } from './app-navigation';
import type { ThemePreference } from './app-navigation';
export type SettingsTab='general'|'account'|'models'|'connections'|'channels'|'skills'|'mcp'|'specialties'|'about';
export function AppSettings({ signedIn, preference, onTheme, onAccount, onAgents, client, aboutOnly = false, initialTab = 'general' }: { signedIn: boolean; preference: ThemePreference; onTheme: (v: ThemePreference) => void; onAccount: () => void; onAgents?: () => void; client?: SessionClient; aboutOnly?: boolean; initialTab?: SettingsTab }) {
  const info=useAppInfo();const [tab,setTab]=useState<SettingsTab>(initialTab);const active=aboutOnly?'about':tab;
  const tabs:{value:SettingsTab;label:string}[]=[{value:'general',label:'General'},{value:'account',label:'Account'},{value:'models',label:'Models & tools'},...(signedIn&&client?.getSnapshot().user?.role==='owner'?[{value:'connections' as const,label:'Connections'},{value:'channels' as const,label:'Channels'},{value:'skills' as const,label:'Skills'},{value:'specialties' as const,label:'Specialties'},{value:'mcp' as const,label:'MCP'}]:[]),{value:'about',label:'Application'}];
  return <div className="page-column app-settings"><header className="settings-heading"><h2>{aboutOnly?'About Dpro Agent':'Settings'}</h2></header>
    {!aboutOnly&&<ViewTabs id="settings-view" label="Settings sections" value={active} tabs={tabs} onChange={setTab}/>}
    <div id="settings-view-panel" role={aboutOnly?undefined:'tabpanel'} aria-labelledby={aboutOnly?undefined:`settings-view-${active}`} className="settings-content">
      {active==='general'&&<section aria-label="General settings"><h3>Appearance</h3><div className="settings-row"><label htmlFor="app-theme">Theme<span className="fine-print">Saved on this device.</span></label><select id="app-theme" value={preference} onChange={e=>onTheme(e.target.value as ThemePreference)}><option value="system">Use system appearance</option><option value="light">Light</option><option value="dark">Dark</option></select></div></section>}
      {active==='account'&&<section aria-label="Account and privacy"><h3>Account &amp; privacy</h3><div className="settings-row"><div><span>{signedIn?'Workspace account':'Sign in required'}</span><p className="fine-print">{signedIn?'Profile, active sessions and sign-out controls.':'Conversations, agents, memory and tools stay locked until sign-in.'}</p></div><button onClick={onAccount}>{signedIn?'Manage account':'Sign in'}</button></div></section>}
      {active==='models'&&<section aria-label="Models and permissions"><h3>Models &amp; tools</h3><div className="settings-row"><div><span>Agent configuration</span><p className="fine-print">Models and tool permissions are managed per agent.</p></div><button onClick={signedIn&&onAgents?onAgents:onAccount}>{signedIn?'Open agents & permissions':'Sign in to manage agents'}</button></div></section>}
      {active==='connections'&&signedIn&&client&&<ConnectionsSettings client={client}/>}
      {active==='channels'&&signedIn&&client&&<AgentConnectSettings client={client}/>}
      {active==='mcp'&&signedIn&&client&&<McpLibrary client={client}/>}
      {active==='specialties'&&signedIn&&client&&<SpecialtyLibrary client={client}/>}
      {active==='skills'&&signedIn&&client&&<SkillLibrary client={client}/>}
      {active==='about'&&<section aria-label="Application information"><h3>Dpro Agent</h3><dl className="settings-facts"><dt>Version</dt><dd>{info?.version??'Web application'}</dd><dt>Connection</dt><dd>{info?(info.connection==='local'?'This computer':'Existing Dpro Agent connection'):'Browser connection'}</dd></dl><div className="settings-row"><div><span>Updates</span><p className="fine-print">Automatic updates are not available in this build. Install a verified newer package while keeping your existing workspace.</p></div></div></section>}
    </div>
  </div>;
}
