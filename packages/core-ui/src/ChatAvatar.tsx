import { useEffect, useRef, useState } from 'react';
import type { Turn } from './turns';

type Voice = { id: string; name: string; language: string | null };
type Choices = { voiceId: string; speak: boolean; size: 's' | 'm' | 'l' };
type Phase = 'loading' | 'ready' | 'thinking' | 'preparing' | 'speaking' | 'unavailable';
const DEFAULTS: Choices = { voiceId: '', speak: true, size: 'm' };
// The owner's choices come from the package's own Avatar Live Settings window. Dpro keeps them
// in memory for this session only (no browser storage); a saved per-agent voice belongs to the agent's server record.
const remembered = new Map<string, Choices>();
const readChoices = (agentId: string): Choices => remembered.get(agentId || 'default') ?? DEFAULTS;
const HEIGHT = { s: 180, m: 260, l: 360 } as const;
const LABEL: Record<Phase, string> = { loading: 'Loading the avatar…', ready: 'Ready', thinking: 'Thinking…', preparing: 'Preparing the voice…', speaking: 'Speaking…', unavailable: 'The avatar is not available in this build.' };

/** Plain, short text for speech: no code blocks, links or Markdown marks. */
export function speakable(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '')
    .replace(/^[#>*\-\s]+/gm, '').replace(/[*_~|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** The agent's face in the chat: it shows when the agent works and speaks finished replies with its saved voice. */
export function ChatAvatar({ turns, agentId, agentName, onClose }: { turns: readonly Turn[]; agentId: string; agentName: string; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null), channel = useRef(crypto.randomUUID());
  const [phase, setPhase] = useState<Phase>('loading'), [voices, setVoices] = useState<Voice[]>([]), [notice, setNotice] = useState('');
  const [choices, setChoicesState] = useState<Choices>(() => readChoices(agentId));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const setChoices = (patch: Partial<Choices>) => setChoicesState(current => { const next = { ...current, ...patch }; remembered.set(agentId || 'default', next); return next; });
  const post = (value: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ type: 'dpro-avatar', channel: channel.current, ...value }, window.location.origin);
  const latest = useRef({ agentName, choices }); latest.current = { agentName, choices };
  useEffect(() => { const next = readChoices(agentId); setChoicesState(next); post({ operation: 'agent', agentName, voiceId: next.voiceId }); }, [agentId, agentName]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || event.data?.type !== 'dpro-avatar' || event.data.channel !== channel.current) return;
      const data = event.data;
      if (data.operation === 'ready') { post({ operation: 'start', layout: 'compact', agentName: latest.current.agentName, voiceId: latest.current.choices.voiceId }); return; }
      if (data.operation === 'mounted') { setPhase('ready'); return; }
      if (data.operation === 'unavailable') { setPhase('unavailable'); return; }
      if (data.operation === 'voices') { if (Array.isArray(data.voices)) setVoices(data.voices as Voice[]); else setNotice('Saved voices could not be loaded. Speech stays off.'); return; }
      if (data.operation === 'voice' && typeof data.voiceId === 'string') { setChoices({ voiceId: data.voiceId }); return; }
      if (data.operation === 'prefs' && data.prefs && typeof data.prefs === 'object') { setChoices({ speak: data.prefs.speak === true, size: ['s', 'm', 'l'].includes(data.prefs.size) ? data.prefs.size : 'm' }); return; }
      if (data.operation === 'settings') { setSettingsOpen(data.open === true); return; }
      if (data.operation === 'state') { setPhase(data.state === 'speaking' ? 'speaking' : data.state === 'preparing' ? 'preparing' : 'ready'); if (typeof data.error === 'string') setNotice(/library is full/i.test(data.error) ? 'The voice library is full (100 recordings). Remove old recordings in the Studio voice library.' : data.error); }
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, []);
  // Running reply: thinking face. A reply that just finished: spoken once with the chosen voice.
  const last = [...turns].reverse().find(t => t.role === 'assistant');
  const spoken = useRef<string | null>(null), wasRunning = useRef(false);
  useEffect(() => {
    if (phase === 'loading' || phase === 'unavailable' || !last) return;
    if (last.status === 'running') { if (!wasRunning.current) { wasRunning.current = true; setPhase('thinking'); post({ operation: 'mood', expression: 'thinking', duration: 60000 }); } return; }
    if (!wasRunning.current) { spoken.current = last.key; return; }
    wasRunning.current = false; setPhase(p => p === 'thinking' ? 'ready' : p);
    if (last.status !== 'complete' || spoken.current === last.key) return;
    spoken.current = last.key; post({ operation: 'mood', expression: 'smile', duration: 2500 });
    const voice = voices.find(v => v.id === choices.voiceId);
    const text = speakable(last.content);
    if (choices.speak && voice && text) post({ operation: 'speak', text, voiceId: voice.id, language: voice.language ?? 'ar' });
  }, [last?.key, last?.status, phase === 'loading', voices, choices.speak, choices.voiceId]);
  const voice = voices.find(v => v.id === choices.voiceId);
  // Full screen fills the Dpro window and also asks the system for real full screen where it is allowed.
  // While the package Settings window is open the frame gets the whole window too, so the window has room.
  const box = useRef<HTMLElement>(null), [full, setFull] = useState(false);
  useEffect(() => { const sync = () => { if (!document.fullscreenElement) setFull(false); }; document.addEventListener('fullscreenchange', sync); return () => document.removeEventListener('fullscreenchange', sync); }, []);
  useEffect(() => { if (!full) return; const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); }; window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc); }, [full]);
  const toggleFull = () => { if (full) { setFull(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); } else { setFull(true); void box.current?.requestFullscreen?.().catch(() => { /* the window-filling view stays */ }); } };
  const wide = full || settingsOpen;
  return <section ref={box} className={`chat-avatar${wide ? ' is-full' : ''}`} aria-label={`${agentName} avatar`} style={wide ? undefined : { height: HEIGHT[choices.size] }}>
    <iframe ref={frame} title={`${agentName} avatar`} className="chat-avatar-frame" src={`/genvr/avatar.html#${channel.current}`} sandbox="allow-scripts allow-same-origin"/>
    {settingsOpen ? null : <div className="chat-avatar-bar">
      <span className={`chat-avatar-state is-${phase}`} role="status"><span aria-hidden="true" className="dot"/>{agentName} · {LABEL[phase]}</span>
      <span className="chat-avatar-voice">{choices.speak ? voice ? `Voice: ${voice.name}` : 'Choose a voice in Settings to hear replies' : 'Speech off'}</span>
      <button type="button" className="tool" aria-pressed={full} onClick={toggleFull}>{full ? 'Exit full screen' : 'Full screen'}</button>
      <button type="button" className="tool" aria-label="Hide avatar" onClick={onClose}>✕</button>
    </div>}
    {notice ? <p className="chat-avatar-notice" role="alert">{notice}</p> : null}
  </section>;
}
