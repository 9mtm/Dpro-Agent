import {ScheduledTasks} from './ScheduledTasks';
import {PreferenceGroup,PreferenceRow} from './Preferences';
import {AccountPanel} from './SessionPanels';
import {PermissionsSettings,VerificationSettings} from './SecuritySettings';
import {ReplyAppsSettings} from './ReplyAppsSettings';
import {SpecialtyLibrary} from './SpecialtyLibrary';
import { McpLibrary } from './McpLibrary';
import { SkillLibrary } from './SkillLibrary';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AgentConnectSettings } from './AgentConnectSettings';
import { ConnectionsSettings } from './ConnectionsSettings';
import type { SessionClient } from './session';
import { useAppInfo } from './app-navigation';
import type { ThemePreference } from './app-navigation';
import { MemorySettings, MEMORY_PANES } from './MemorySettings';
import type { MemorySettingsPane } from './MemorySettings';
import { UiIcon } from './ui-icons';
export type SettingsTab='schedules'|'general'|'account'|'models'|'connections'|'channels'|'skills'|'mcp'|'specialties'|'memory'|'about'|'permissions'|'verification'|'apps';
/**
 * Settings. In the signed-in window the sections are the sidebar (the shell
 * gives a slot; Memory has its own sub-places); without a slot (signed out,
 * tests) they stay a short row of views.
 */
export function AppSettings({ signedIn, preference, onTheme, onAccount, onAgents, client, aboutOnly = false, initialTab = 'general', initialMemoryPane = 'rules', sidebarSlot, active = true, onOpenMemory,onOpenTool,onOpenChat,onOpenApps,onApprovals,onBoard,onAgent }: { signedIn: boolean; preference: ThemePreference; onTheme: (v: ThemePreference) => void; onAccount: () => void; onAgents?: () => void; client?: SessionClient; aboutOnly?: boolean; initialTab?: SettingsTab; initialMemoryPane?: MemorySettingsPane; sidebarSlot?: HTMLElement | null; active?: boolean; onOpenMemory?: () => void;onOpenChat?:()=>void;onOpenApps?:()=>void;onApprovals?:()=>void;onBoard?:()=>void;onAgent?:(id:string)=>void;onOpenTool?:(tool:'skills'|'mcp'|'specialties')=>void }) {
  const [query,setQuery]=useState('');
  const info=useAppInfo();const [tab,setTab]=useState<SettingsTab>(initialTab);const active_=aboutOnly?'about':tab;
  const [pane,setPane]=useState<MemorySettingsPane>(initialMemoryPane);
  useEffect(()=>{setTab(initialTab);},[initialTab]);useEffect(()=>{setPane(initialMemoryPane);},[initialMemoryPane]);
  const owner=signedIn&&client?.getSnapshot().user?.role==='owner';
  const tabs:{value:SettingsTab;label:string}[]=[{value:'general',label:'General'},{value:'account',label:'Account'},{value:'models',label:'Models & tools'},...(signedIn?[{value:'apps' as const,label:'Apps'},{value:'verification' as const,label:'Verification'}]:[]),...(owner?[{value:'schedules' as const,label:'Scheduled tasks'},{value:'permissions' as const,label:'Permissions'},{value:'connections' as const,label:'Connections'},{value:'channels' as const,label:'Channels'},{value:'skills' as const,label:'Skills'},{value:'specialties' as const,label:'Specialties'},{value:'mcp' as const,label:'MCP'},{value:'memory' as const,label:'Memory'}]:[]),{value:'about',label:'Application'}];
  const icons={schedules:'clock',general:'sun',account:'contact',models:'cpu',connections:'link',channels:'message',skills:'file',specialties:'layers',mcp:'tool',memory:'brain',about:'info',apps:'layers',permissions:'shield',verification:'check'} as const;
  const choose=(value:SettingsTab)=>{if(value==='apps'&&onOpenApps){onOpenApps();return;}if(onOpenTool&&(value==='skills'||value==='mcp'||value==='specialties'))onOpenTool(value);else setTab(value);};
  const groups=[{name:'Application',keys:['general','account','models']},{name:'Security',keys:['permissions','verification']},{name:'Connections',keys:['connections','channels','memory']},{name:'Workspace',keys:['schedules','apps','skills','specialties','mcp']},{name:'',keys:['about']}];
  const sidebar=<nav className="dk-sidebar settings-sidebar" aria-label="Settings sections"><div className="dk-side-top"><label className="dk-search"><UiIcon name="search" size={13}/><input type="search" aria-label="Search settings sections" placeholder="Search settings" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
    {groups.map(group=>{const rows=group.keys.flatMap(key=>tabs.filter(t=>t.value===key)).filter(t=>!query.trim()||t.label.toLowerCase().includes(query.toLowerCase())||t.value==='memory'&&MEMORY_PANES.some(p=>p.label.toLowerCase().includes(query.toLowerCase())));return rows.length?<div key={group.name} className="settings-nav-group">{group.name&&<p className="section-label dk-label">{group.name}</p>}{rows.map(t=><div key={t.value} className="dk-group"><button type="button" className="nav-item dk-place" aria-current={active_===t.value?'page':undefined} aria-expanded={t.value==='memory'?active_==='memory':undefined} onClick={()=>choose(t.value)}><UiIcon name={icons[t.value]} size={16}/><span className="dk-place-name">{t.label}</span>{['apps','skills','specialties','mcp'].includes(t.value)&&<UiIcon name="chevron" size={11}/>}</button>{t.value==='memory'&&active_==='memory'&&MEMORY_PANES.map(p=><button key={p.key} type="button" className="nav-item dk-place" data-nested aria-current={pane===p.key?'page':undefined} onClick={()=>setPane(p.key)}><span className="dk-place-name">{p.label}</span></button>)}</div>)}</div>:null;})}
  </nav>;
  const descriptions:Partial<Record<SettingsTab,string>>={schedules:'Workspace schedules and recent outcomes.',general:'Appearance on this device.',account:'Your identity and sign-in sessions.',models:'Choose where your agents get their replies.',permissions:'Control the selected agent’s tools and actions.',verification:'Sign-in methods and review responsibilities.',connections:'Accounts connected to this workspace.',channels:'Messaging services and trusted senders.',memory:'Memory rules, sources and access.',about:'Version and installation details.'};
  const activeLabel=aboutOnly?'About Dpro Agent':active_==='memory'?`Memory · ${MEMORY_PANES.find(p=>p.key===pane)?.label??'Settings'}`:tabs.find(t=>t.value===active_)?.label??'Settings';
  return <div className="app-settings settings-workspace page-ui"><header className="settings-heading"><span className="settings-heading-icon"><UiIcon name={icons[active_]} size={19}/></span><div><h2>{activeLabel}</h2><p>{aboutOnly?'Version and installation details.':descriptions[active_]??'Workspace tools and preferences.'}</p></div>
    {!aboutOnly&&!sidebarSlot&&<select aria-label="Settings sections" value={active_} onChange={e=>choose(e.target.value as SettingsTab)}>{tabs.map(t=><option value={t.value} key={t.value}>{t.label}</option>)}</select>}</header>
    {!aboutOnly&&sidebarSlot&&active?createPortal(sidebar,sidebarSlot):null}
    <div id="settings-view-panel" aria-label={activeLabel} className="settings-content" data-pane={active_}><div className="preferences-page">
      {active_==='schedules'&&owner&&client&&<ScheduledTasks client={client} active={active}/>}
      {active_==='permissions'&&owner&&client&&<PermissionsSettings client={client} onApprovals={onApprovals??(()=>{})} onAccount={onAccount} onAgent={onAgent}/>}
      {active_==='verification'&&signedIn&&client&&<VerificationSettings client={client} onApprovals={onApprovals??(()=>{})} onBoard={onBoard??(()=>{})} onAgent={onAgent??(()=>onAgents?.())} onAccount={onAccount}/>}
      {active_==='apps'&&signedIn&&onOpenApps&&<section><p>Applications and local add-ons for this workspace.</p><button onClick={onOpenApps}>Open Apps</button></section>}
      {active_==='general'&&<PreferenceGroup title="Appearance" note="Changes save automatically on this device."><PreferenceRow title="Theme" description="Use your device appearance or choose a theme." icon="sun"><select id="app-theme" aria-label="Theme" value={preference} onChange={e=>onTheme(e.target.value as ThemePreference)}><option value="system">Use system appearance</option><option value="light">Light</option><option value="dark">Dark</option></select></PreferenceRow></PreferenceGroup>}
      {active_==='account'&&(signedIn&&client?<AccountPanel client={client} compact/>:<PreferenceGroup title="Account"><PreferenceRow title="Sign in required" description="Connect to your workspace to manage your account." icon="contact"><button onClick={onAccount}>Sign in</button></PreferenceRow></PreferenceGroup>)}
      {active_==='models'&&<><PreferenceGroup title="Agent replies"><PreferenceRow title="Model for each agent" description="Select an agent to choose its model and provider." icon="cpu"><button onClick={signedIn&&onAgents?onAgents:onAccount}>{signedIn?'Choose agent':'Sign in'}</button></PreferenceRow></PreferenceGroup>{signedIn&&client&&owner&&<ReplyAppsSettings client={client} onOpenChat={onOpenChat}/>}</>}
      {active_==='connections'&&signedIn&&client&&<ConnectionsSettings client={client}/>}
      {active_==='channels'&&signedIn&&client&&<AgentConnectSettings client={client}/>}
      {active_==='mcp'&&signedIn&&client&&<McpLibrary client={client}/>}
      {active_==='specialties'&&signedIn&&client&&<SpecialtyLibrary client={client}/>}
      {active_==='skills'&&signedIn&&client&&<SkillLibrary client={client}/>}
      {active_==='memory'&&owner&&client&&<MemorySettings client={client} pane={pane} onOpenMemory={onOpenMemory}/>}
      {active_==='about'&&<><PreferenceGroup title="Dpro Agent"><PreferenceRow title="Version" icon="info"><span>{info?.version??'Development preview'}</span></PreferenceRow><PreferenceRow title="Connection" icon="link"><span>{info?(info.connection==='local'?'This computer':'Connected installation'):'Local browser preview'}</span></PreferenceRow></PreferenceGroup><PreferenceGroup title="Updates"><PreferenceRow title="Manual updates" description="Automatic updates are not available in this build." icon="refresh"><span className="preference-status">Not available</span></PreferenceRow></PreferenceGroup></>}
    </div>
    </div>
  </div>;
}
