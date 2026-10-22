import {UiIcon} from './ui-icons';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionClient } from './session';
import type { Connection, Publication } from './connections-contract.js';
import { CONNECTIONS_PATH } from './connections-contract.js';

const GENVR = `${CONNECTIONS_PATH}/genvr`;
const STATUS: Record<Connection['status'], string> = { not_connected: 'Not connected', connecting: 'Connecting…', connected: 'Connected', expired: 'Expired — connect again', error: 'Not connected' };
const MESSAGES: Record<string, string> = {
  relink_required: 'The Genvr link has expired or was revoked. Connect again.',
  missing_scope: 'This link does not allow that action. Connect again to grant it.',
  not_found: 'Genvr says this world is not yours or no longer exists.',
  conflict: 'The world changed on Genvr. Nothing was overwritten; try again to read the latest version.',
  link_expired: 'The approval code expired before it was approved. Start again.',
  other_account: 'The test world belongs to another Genvr account.',
  published_unpublish_first: 'The test world is already published.',
  upload_first: 'Upload the test world before publishing it.',
  forbidden: 'Only the owner can manage connections.',
  unavailable: 'Genvr could not be reached. Check the connection and try again.',
};
const message = (code?: string) => (code && MESSAGES[code]) || 'The request failed. Try again.';
const CONTENT = { violence: false, blood: false, horror: false, romance: false, userChat: false, paidItems: false };
const CONTENT_LABELS: Record<keyof typeof CONTENT, string> = { violence: 'Violence', blood: 'Blood', horror: 'Horror', romance: 'Romance', userChat: 'Visitors can chat', paidItems: 'Paid items' };
const date = (v: string | null) => v ? new Date(v).toLocaleString() : '';

/** Settings → Connections: applications linked to this Dpro (owner only). */
export function ConnectionsSettings({ client }: { client: SessionClient }) {
  const owner = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).user?.role === 'owner';
  const [genvr, setGenvr] = useState<Connection>();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [confirmOff, setConfirmOff] = useState(false);
  const send = useCallback(async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await client.request({ method, path, ...(body === undefined ? {} : { body }) } as never);
    return { ok: r.status === 200, body: r.body as Record<string, any> };
  }, [client]);
  const load = useCallback(async () => {
    try { const r = await send('GET', CONNECTIONS_PATH); if (!r.ok) { setPhase('error'); return; } setGenvr(r.body.connections.find((c: Connection) => c.id === 'genvr')); setPhase('ready'); }
    catch { setPhase('error'); }
  }, [send]);
  useEffect(() => { if (owner) void load(); }, [owner, load]);
  // While the owner approves on the Genvr website, the backend polls; the page only reads the state.
  useEffect(() => { if (genvr?.status !== 'connecting') return; const t = setInterval(() => void load(), 3000); return () => clearInterval(t); }, [genvr?.status, load]);
  const act = async (path: string, body: unknown) => {
    if (busy) return; setBusy(true); setNotice('');
    try { const r = await send('POST', path, body); if (r.ok) setGenvr(r.body.connection); else setNotice(message(r.body?.code)); }
    catch { setNotice(message()); } finally { setBusy(false); setConfirmOff(false); }
  };
  if (!owner) return <section aria-label="Connections"><h3>Connections</h3><p className="fine-print">Only the owner can see and manage connected applications.</p></section>;
  return <section aria-label="Connections" className="connections">

    {phase === 'loading' && <p role="status">Loading connections…</p>}
    {phase === 'error' && <p role="alert" className="error">Connections could not be loaded. <button type="button" onClick={() => void load()}>Try again</button></p>}
    {genvr && <article className="connection-card" aria-label="Genvr connection">
      <header className="connection-head"><span className="preference-icon"><UiIcon name="layers" size={22}/></span><div><strong>GenVR</strong><p className="fine-print">Your world account</p></div>
        <span className={`connection-state is-${genvr.status}`} role="status">{STATUS[genvr.status]}</span></header>
      {genvr.status === 'connecting' && genvr.pending && <div className="connection-pending">
        <p>Open Genvr, sign in, and approve <b>Dpro Agent</b>. Check that this code is shown there:</p>
        <p className="connection-code" aria-label="Approval code">{genvr.pending.userCode}</p>
        <div className="connection-actions"><a className="button primary" href={genvr.pending.verificationUri} target="_blank" rel="noopener noreferrer">Open Genvr to approve</a>
          <button type="button" disabled={busy} onClick={() => void act(`${GENVR}/cancel`, {})}>Cancel</button></div>
        <p className="fine-print">Waiting for approval · code valid until {date(genvr.pending.expiresAt)}. Your Genvr password is never entered in Dpro.</p>
      </div>}
      {genvr.status === 'connected' && genvr.account && <dl className="settings-facts"><dt>Account</dt><dd>{genvr.account.name}</dd><dt>Allowed</dt><dd>{genvr.scopes.join(', ')}</dd><dt>Linked</dt><dd>{date(genvr.linkedAt)}</dd><dt>Valid until</dt><dd>{date(genvr.expiresAt)}</dd></dl>}
      {genvr.error && genvr.status !== 'connecting' && <p role="alert" className="error">{message(genvr.error)}</p>}
      <div className="connection-actions">
        {(genvr.status === 'not_connected' || genvr.status === 'error' || genvr.status === 'expired') && <button type="button" className="primary" disabled={busy} onClick={() => void act(`${GENVR}/link`, {})}>{genvr.status === 'expired' ? 'Connect again' : 'Connect Genvr'}</button>}
        {(genvr.status === 'connected' || genvr.status === 'expired') && (confirmOff
          ? <><button type="button" className="danger" disabled={busy} onClick={() => void act(`${GENVR}/disconnect`, { confirm: true })}>Confirm disconnect</button><button type="button" onClick={() => setConfirmOff(false)}>Keep</button></>
          : <button type="button" disabled={busy} onClick={() => setConfirmOff(true)}>Disconnect</button>)}
      </div>
      {notice && <p role="alert" className="error">{notice}</p>}
      {genvr.status === 'connected' && <details className="preference-help"><summary>Test world publication</summary><TestPublication send={send}/></details>}
    </article>}<details className="preference-help"><summary>How account connections work</summary><p>Approve each link on the provider website. Credentials stay in the encrypted key store. Disconnecting removes the link from this workspace.</p></details>
  </section>;
}

function TestPublication({ send }: { send: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ ok: boolean; body: Record<string, any> }> }) {
  const [pub, setPub] = useState<Publication | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [uploadOk, setUploadOk] = useState(false), [publishOk, setPublishOk] = useState(false);
  const [title, setTitle] = useState('Dpro test world'), [type, setType] = useState<'social' | 'game' | 'event'>('social'), [access, setAccess] = useState<'public' | 'friends' | 'invite'>('public');
  const [content, setContent] = useState(CONTENT);
  useEffect(() => { void send('GET', `${GENVR}/publications`).then(r => { if (r.ok) setPub(r.body.publications.find((p: Publication) => p.localId === 'dpro.publication.test') ?? null); }).catch(() => undefined); }, [send]);
  const run = async (path: string, body: unknown) => {
    if (busy) return; setBusy(true); setNotice('');
    try { const r = await send('POST', path, body); if (r.ok) setPub(r.body.publication); else setNotice(message(r.body?.code)); }
    catch { setNotice(message()); } finally { setBusy(false); setUploadOk(false); setPublishOk(false); }
  };
  return <section className="connection-publish" aria-label="Test world publication">
    <h4>Test world publication</h4>
    <p className="fine-print">A new small world made here: flat ground and one built-in bench. No private library, voice, model or existing world is sent.</p>
    {pub && <dl className="settings-facts"><dt>Genvr world</dt><dd>{pub.serverId}</dd><dt>State</dt><dd>{pub.status === 'published' ? `Published (${pub.access})` : 'Private draft'} · version {pub.version}</dd>{pub.link && <><dt>Link</dt><dd><a href={pub.link} target="_blank" rel="noopener noreferrer">{pub.link}</a></dd></>}</dl>}
    {pub?.status !== 'published' && <>
      <label className="check"><input type="checkbox" checked={uploadOk} disabled={busy} onChange={e => setUploadOk(e.target.checked)}/>{pub ? 'Upload the test world again to the same private draft.' : 'Create one private draft on my Genvr account and upload the test world.'}</label>
      <div className="connection-actions"><button type="button" disabled={busy || !uploadOk} onClick={() => void run(`${GENVR}/test-world/upload`, { confirm: true })}>{pub ? 'Upload again' : 'Create draft and upload'}</button></div>
    </>}
    {pub && pub.status === 'draft' && pub.version > 0 && <fieldset className="connection-form" disabled={busy}><legend>Publish (separate confirmation)</legend>
      <label className="field"><span>Title</span><input value={title} maxLength={120} onChange={e => setTitle(e.target.value)}/></label>
      <label className="field"><span>Type</span><select value={type} onChange={e => setType(e.target.value as typeof type)}><option value="social">Social</option><option value="game">Game</option><option value="event">Event</option></select></label>
      <label className="field"><span>Who can enter</span><select value={access} onChange={e => setAccess(e.target.value as typeof access)}><option value="public">Everyone (public)</option><option value="friends">Friends</option><option value="invite">Invite only</option></select></label>
      <p className="fine-print">Content questions (answer truthfully; Genvr checks them):</p>
      {(Object.keys(CONTENT) as (keyof typeof CONTENT)[]).map(k => <label key={k} className="check"><input type="checkbox" checked={content[k]} onChange={e => setContent({ ...content, [k]: e.target.checked })}/>{CONTENT_LABELS[k]}</label>)}
      <label className="check"><input type="checkbox" checked={publishOk} onChange={e => setPublishOk(e.target.checked)}/>Publish this world on Genvr as “{title.trim() || '…'}” ({access}).</label>
      <div className="connection-actions"><button type="button" className="primary" disabled={!publishOk || !title.trim()} onClick={() => void run(`${GENVR}/test-world/publish`, { confirm: true, title: title.trim(), type, access, content })}>Publish</button></div>
    </fieldset>}
    {notice && <p role="alert" className="error">{notice}</p>}
  </section>;
}
