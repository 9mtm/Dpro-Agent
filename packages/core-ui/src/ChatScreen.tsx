import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import type { ChatController, Turn } from './chat';
import { UiIcon } from './ui-icons';
import { Markdown } from './markdown';

/**
 * The chat screen: an empty state with the product name, the conversation
 * as a reading column (the user's turns in quiet bubbles, the assistant's as
 * plain text), and a docked composer. Enter sends, Shift+Enter adds a line;
 * Stop ends reading (the controller decides what that means for the server).
 * All behavior stays in ChatController; this file is layout only.
 */
export function ChatScreen({ controller, productName = 'Dpro Agent', mode }: { controller: ChatController; productName?: string; mode: 'live' | 'mock' }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const sending = s.phase === 'sending';
  const blocked = sending || s.phase === 'unknown' || s.phase === 'denied';
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [multiline, setMultiline] = useState(false);

  // Keep the newest text in view while it streams.
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.turns]);
  // The composer grows with its text up to a cap.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
    setMultiline(el.scrollHeight > 36);
  }, [s.draft]);

  const submit = () => { if (!blocked && s.draft.trim()) void controller.send(); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };

  return <div className="chat-screen">
    <div className="chat-thread" ref={thread} aria-label="Current conversation" aria-live="polite">
      {s.turns.length === 0 ? <div className="chat-empty">
        <p className="chat-wordmark">{productName}</p>
        <p className="chat-tagline">{mode === 'mock'
          ? 'Offline practice: replies are fictional and nothing leaves this page.'
          : 'Brief your team. Your agents work like real staff — each with its own role, memory and permissions.'}</p>
      </div> : <div className="chat-column">
        {s.turns.map((t, i) => <TurnView key={t.key} turn={t} last={i === s.turns.length - 1} sending={sending}/>)}
      </div>}
    </div>
    <div className="chat-dock">
      {/* A normal completed reply needs no notice; problems and uncertain outcomes do. */}
      {((s.notice && s.phase !== 'complete') || s.phase === 'denied') && <p className="chat-notice" role="status">{s.notice ?? 'Chat needs an active, non-guest account.'}</p>}
      <form className={`chat-composer${multiline ? ' stacked' : ''}`} method="post" onSubmit={e => { e.preventDefault(); submit(); }}>
        <label className="composer-agent" title="Agent for this conversation. Blank uses the server's primary agent.">
          <span className="sr-only">Agent ID (optional)</span>
          <input value={s.agentId} placeholder="Agent: default" disabled={!!s.turns.length || s.phase !== 'ready'}
            onChange={e => controller.selectAgent(e.target.value)} maxLength={128}/>
        </label>
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <textarea id="chat-input" ref={input} rows={1} placeholder={s.turns.length ? 'Send a follow-up' : "What's on your mind?"} value={s.draft}
          onChange={e => controller.edit(e.target.value)} onKeyDown={onKeyDown} maxLength={32768} disabled={blocked}/>
        {sending
          ? <button type="button" className="round-button" onClick={() => controller.cancel()} aria-label="Stop reading the reply"><UiIcon name="stop" size={10}/></button>
          : <button type="submit" className="round-button" disabled={blocked || !s.draft.trim()} aria-label="Send"><UiIcon name="arrow-up" size={14}/></button>}
      </form>
    </div>
  </div>;
}

function TurnView({ turn, last, sending }: { turn: Turn; last: boolean; sending: boolean }) {
  const streaming = last && sending;
  return <article className="turn">
    <div className="user-bubble"><p className="sr-only">You</p><div className="turn-text">{turn.prompt}</div></div>
    <div className={`assistant-text${streaming ? ' streaming' : ''}`}>
      <p className="sr-only">Assistant</p>
      {turn.content
        ? <div className="turn-text md-host"><Markdown text={turn.content}/></div>
        : <div className="turn-pending">{streaming ? <span className="typing" aria-label="Waiting for the reply"><i/><i/><i/></span> : 'No message text received.'}</div>}
      {turn.content && !streaming && <div className="turn-actions"><CopyButton text={turn.content}/></div>}
      {(turn.events > 0 || turn.partial || turn.replayed) && <p className="turn-meta">
        {turn.events > 0 && <span>{turn.events} tool event{turn.events === 1 ? '' : 's'}</span>}
        {turn.partial && <span>incomplete</span>}
        {turn.replayed && <span>replayed</span>}
      </p>}
    </div>
  </article>;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="ghost-action" aria-label={done ? 'Copied' : 'Copy reply'}
    onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }, () => {}); }}>
    <UiIcon name={done ? 'check' : 'copy'} size={14}/>
  </button>;
}
