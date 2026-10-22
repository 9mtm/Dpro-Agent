import {VerificationSettings} from './VerificationSettings';
import {ReviewerPoliciesSettings} from './ReviewerPoliciesSettings';
import {SpecialtyLibrary} from './SpecialtyLibrary';
import { McpLibrary } from './McpLibrary';
import { SkillLibrary } from './SkillLibrary';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AgentConnectSettings } from './AgentConnectSettings';
import { ConnectionsSettings } from './ConnectionsSettings';
import type { SessionClient } from './session';
import { ViewTabs } from './ViewTabs';
import { useAppInfo } from './app-navigation';
import type { ThemePreference } from './app-navigation';
import { MemorySettings, MEMORY_PANES } from './MemorySettings';
import type { MemorySettingsPane } from './MemorySettings';
import { UiIcon } from './ui-icons';
export type SettingsTab='general'|'account'|'models'|'connections'|'channels'|'skills'|'mcp'|'specialties'|'memory'|'approval-rules'|'about';
/**
 * Settings. In the signed-in window the sections are the sidebar (the shell
 * gives a slot; Memory has its own sub-places); without a slot (signed out,
 * tests) they stay a short row of views.
 */
export function AppSettings({ signedIn, preference, onTheme, onAccount, onAgents, client, aboutOnly = false, initialTab = 'general', initialMemoryPane = 'rules', sidebarSlot, active = true, onOpenMemory }: { signedIn: boolean; preference: ThemePreference; onTheme: (v: ThemePreference) => void; onAccount: () => void; onAgents?: () => void; client?: SessionClient; aboutOnly?: boolean; initialTab?: SettingsTab; initialMemoryPane?: MemorySettingsPane; sidebarSlot?: HTMLElement | null; active?: boolean; onOpenMemory?: () => void }) {
  const info=useAppInfo();const [tab,setTab]=useState<SettingsTab>(initialTab);const active_=aboutOnly?'about':tab;
  const [pane,setPane]=useState<MemorySettingsPane>(initialMemoryPane);
  useEffect(()=>{setTab(initialTab);},[initialTab]);useEffect(()=>{setPane(initialMemoryPane);},[initialMemoryPane]);
  const owner=signedIn&&client?.getSnapshot().user?.role==='owner';
  const tabs:{value:SettingsTab;label:string}[]=[{value:'general',label:'General'},{value:'account',label:'Account'},{value:'models',label:'Models & tools'},...(owner?[{value:'connections' as const,label:'Connections'},{value:'channels' as const,label:'Channels'},{value:'skills' as const,label:'Skills'},{value:'specialties' as const,label:'Specialties'},{value:'mcp' as const,label:'MCP'},{value:'memory' as const,label:'Memory'}]:[]),{value:'about',label:'Application'}];
  if(owner)tabs.splice(tabs.length-1,0,{value:'approval-rules',label:'Approval rules'});
  const sidebar=<nav className="dk-sidebar" aria-label="Settings sections">
    <p className="section-label dk-label"><span>Settings</span></p>
    {tabs.map(t=><div key={t.value} className="dk-group">
      <button type="button" className="nav-item dk-place" aria-current={active_===t.value&&(t.value!=='memory')?'page':undefined} aria-expanded={t.value==='memory'?active_==='memory':undefined} onClick={()=>setTab(t.value)}>
        {t.value==='memory'&&<span className="dk-chevron" data-open={active_==='memory'||undefined}><UiIcon name="chevron" size={11}/></span>}{t.value==='approval-rules'&&<UiIcon name="shield" size={15}/>}<span className="dk-place-name">{t.label}</span></button>
      {t.value==='memory'&&active_==='memory'&&MEMORY_PANES.map(p=><button key={p.key} type="button" className="nav-item dk-place" data-nested aria-current={pane===p.key?'page':undefined} onClick={()=>setPane(p.key)}><span className="dk-place-name">{p.label}</span></button>)}
    </div>)}
  </nav>;
  return <div className="page-column app-settings"><header className="settings-heading"><h2>{aboutOnly?'About Dpro Agent':'Settings'}</h2></header>
    {!aboutOnly&&(sidebarSlot?(active?createPortal(sidebar,sidebarSlot):null):<ViewTabs id="settings-view" label="Settings sections" value={active_} tabs={tabs} onChange={setTab}/>)}
    <div id="settings-view-panel" role={aboutOnly||sidebarSlot?undefined:'tabpanel'} aria-labelledby={aboutOnly||sidebarSlot?undefined:`settings-view-${active_}`} className="settings-content">
      {active_==='general'&&<section aria-label="General settings"><h3>Appearance</h3><div className="settings-row"><label htmlFor="app-theme">Theme<span className="fine-print">Saved on this device.</span></label><select id="app-theme" value={preference} onChange={e=>onTheme(e.target.value as ThemePreference)}><option value="system">Use system appearance</option><option value="light">Light</option><option value="dark">Dark</option></select></div></section>}
      {active_==='account'&&<section aria-label="Account and privacy"><h3>Account &amp; privacy</h3><div className="settings-row"><div><span>{signedIn?'Workspace account':'Sign in required'}</span><p className="fine-print">{signedIn?'Profile, active sessions and sign-out controls.':'Conversations, agents, memory and tools stay locked until sign-in.'}</p></div><button onClick={onAccount}>{signedIn?'Manage account':'Sign in'}</button></div>{signedIn&&client&&<VerificationSettings client={client}/>}</section>}
      {active_==='models'&&<section aria-label="Models and permissions"><h3>Models &amp; tools</h3><div className="settings-row"><div><span>Agent configuration</span><p className="fine-print">Models and tool permissions are managed per agent.</p></div><button onClick={signedIn&&onAgents?onAgents:onAccount}>{signedIn?'Open agents & permissions':'Sign in to manage agents'}</button></div></section>}
      {active_==='approval-rules'&&owner&&client&&<ReviewerPoliciesSettings client={client} onAccount={onAccount}/>}
      {active_==='connections'&&signedIn&&client&&<ConnectionsSettings client={client}/>}
      {active_==='channels'&&signedIn&&client&&<AgentConnectSettings client={client}/>}
      {active_==='mcp'&&signedIn&&client&&<McpLibrary client={client}/>}
      {active_==='specialties'&&signedIn&&client&&<SpecialtyLibrary client={client}/>}
      {active_==='skills'&&signedIn&&client&&<SkillLibrary client={client}/>}
      {active_==='memory'&&owner&&client&&<MemorySettings client={client} pane={pane} onOpenMemory={onOpenMemory}/>}
      {active_==='about'&&<section aria-label="Application information"><h3>Dpro Agent</h3><dl className="settings-facts"><dt>Version</dt><dd>{info?.version??'Web application'}</dd><dt>Connection</dt><dd>{info?(info.connection==='local'?'This computer':'Existing Dpro Agent connection'):'Browser connection'}</dd></dl><div className="settings-row"><div><span>Updates</span><p className="fine-print">Automatic updates are not available in this build. Install a verified newer package while keeping your existing workspace.</p></div></div></section>}
    </div>
  </div>;
}
