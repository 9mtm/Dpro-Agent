import { generatePassword, passwordStrength } from './password-tools.js';
import { PublicShell } from './PublicShell';
import { SignedInShell } from './SignedInShell';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { SessionClient } from './session';
import { createLoginMock } from './session-mock';

import { retryAfterNotice } from './retry-after.js';
import { devQuickLoginAccounts } from './dev-quick-login';
import { devSessionKeep } from './dev-session-keep';
import { setupCodeFromFragment } from './owner-setup-contract.js';
import type { OwnerSetupCode } from './owner-setup-contract.js';

const notices = {
  published_password: 'Sign-in refused because the password is a published default. Reset it from the CLI.',
  account_inactive: 'This account is unavailable for sign-in. Ask the installation owner to review its status.',
  rate_limited: 'Request rate limit reached. Try again later; no retry was sent.',
  origin_not_allowed: 'The installation refused this application origin. Its connection configuration needs review.',
  host_not_allowed: 'The installation refused this host. Its connection configuration needs review.',

  invalid: 'Sign-in refused. Check your credentials.', denied: 'Account access denied.', limited: 'Too many attempts. Try again later.',
  unavailable: 'Request unavailable. No automatic retry was sent.', expired: 'Session expired or revoked. Sign in again.',
  'logout-confirmed': 'Server confirmed sign-out on all devices.', 'logout-unknown': 'Local session cleared. Server sign-out on other devices is unconfirmed. No retry was sent.',
};
export function AuthBoundary({ client: supplied, children, initialPage }: { client?: SessionClient; children: ReactNode; initialPage?: 'home' | 'account' }) {
  const fallback = useMemo(() => supplied ? undefined : new SessionClient({ mock: createLoginMock() }), [supplied]);
  const client = supplied ?? fallback!;
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  // INSTALLER-07: a local setup link carries the one-time code in the
  // fragment. Read it once, keep it in memory only, drop it from the address bar.
  const [setupCode] = useState(readSetupLink);
  useEffect(() => () => client.cancel(), [client]);
  // A build for real data (live transport only, no practice mode) opens the
  // real sign-in at once: no fictional workspace in between.
  const liveOnly = client.canUse('live') && !client.canUse('mock');
  useEffect(() => {
    if (!liveOnly) return;
    const s = client.getSnapshot();
    if (s.mode === 'fixture') client.selectMode('live');
    if (client.getSnapshot().phase !== 'signed-out' || client.getSnapshot().setup) return;
    // Local test build: a refresh signs back in (dev-session-keep.ts).
    const keep = devSessionKeep(typeof window !== 'undefined' ? window.location.hostname : '');
    if (keep) void client.resume(keep).then(ok => { if (!ok && client.getSnapshot().phase === 'signed-out') void client.discoverSetup(); });
    else void client.discoverSetup();
  }, [client, liveOnly, state.mode, state.epoch]);
  // Signed in: the workspace's own status bar carries the mode and the way out.
  const signedIn = state.mode !== 'fixture' && state.phase === 'authenticated';
  return <div className={`auth-boundary${signedIn ? ' signed-in' : ''}`}>
    {!signedIn && !liveOnly && <section className="auth-controls" aria-label="Session mode" lang="en" dir="ltr">
      <strong>{state.mode === 'fixture' ? 'Fixture workspace — fictional data' : state.mode === 'mock' ? 'Offline login mock — fictional identity, no network' : 'Live session — explicitly enabled deployment'}</strong>
      {state.mode === 'fixture' ? <>
        {client.canUse('mock') && <button onClick={() => client.selectMode('mock')}>Open offline login mock</button>}
        {client.canUse('live') && <button onClick={() => client.selectMode('live')}>Use live sign-in</button>}
      </> : <button disabled={state.phase === 'signing-out'} onClick={() => client.selectMode('fixture')}>Return to fixture (local session cleared)</button>}
      <span>Authentication copy: English draft.</span>
    </section>}
    {state.mode === 'fixture' ? (liveOnly ? null : children) : <SessionWorkspace key={`${state.mode}:${state.epoch}`} client={client} setupCode={setupCode} initialPage={initialPage}/>}
  </div>;
}
function SessionWorkspace({ client, setupCode, initialPage }: { client: SessionClient; setupCode: string | null; initialPage?: 'home' | 'account' }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  // Signed in: the full workspace (sidebar, chat, agents, memory, account).
  if (state.phase === 'authenticated' && state.user) return <SignedInShell client={client} notice={state.notice ? <>{notices[state.notice]}{retryAfterNotice(state.retryAfterSeconds)}</> : null}/>;
  return <PublicShell setup={state.setup} initialPage={initialPage}><section className="auth-workspace" aria-label="Account sign-in" lang="en" dir="ltr">
    <h1>Dpro · {state.mode === 'mock' ? 'Offline login exercise' : 'Account'}</h1>
    {state.notice && <p role="status">{notices[state.notice]}{retryAfterNotice(state.retryAfterSeconds)}</p>}
    {state.phase === 'authenticated' && state.user ? null : state.phase === 'signed-out' && state.setup === 'required' ? <OwnerSetup client={client} setupCode={setupCode} initialPage={initialPage}/> : state.phase === 'signing-out' ? <><p role="status">Signing out on all devices…</p><button onClick={() => client.cancel()}>Clear locally; server outcome remains unknown</button></> : state.phase === 'signed-out' && state.setup !== 'login' ? <section aria-label="Setup discovery">
      <p role="status">{state.setup === 'checking' ? 'Checking installation setup…' : state.setup === 'unavailable' ? 'Setup status unavailable. Sign-in is withheld; no automatic retry was sent.'
        : 'Check installation setup before signing in. No request has been sent automatically.'}</p>
      <p>Discovery does not verify an account, installation identity, or system readiness.</p>
      {state.setup === 'checking' ? <button onClick={() => client.cancel()}>Cancel setup check</button>
        : <button onClick={() => void client.discoverSetup()}>{state.setup ? 'Check setup again' : 'Check setup status'}</button>}
    </section> : <form method="post" onSubmit={e => {
      e.preventDefault(); const submittedPassword = password; setPassword(''); void client.login(email, submittedPassword);
    }}>
      {state.setup === 'login' && <p>Setup reports complete. Sign in to verify your account.</p>}
      {state.mode === 'mock' && <p>Fictional credentials only: demo@example.invalid / mock-only. Never enter a real password here.</p>}
      <label htmlFor="auth-email">Email</label><input id="auth-email" type="email" name={state.mode === 'live' ? 'username' : undefined} autoComplete={state.mode === 'live' ? 'username' : 'off'} required value={email} onChange={e => setEmail(e.target.value)} disabled={state.phase === 'signing-in'}/>
      <label htmlFor="auth-password">Password</label><input id="auth-password" type="password" name={state.mode === 'live' ? 'password' : undefined} autoComplete={state.mode === 'live' ? 'current-password' : 'off'} required value={password} onChange={e => setPassword(e.target.value)} disabled={state.phase === 'signing-in'}/>
      {state.mode === 'live' && <DevQuickLogin disabled={state.phase === 'signing-in'} onFill={(a) => { setEmail(a.email); setPassword(a.password); }}/>}
      <button className="primary" disabled={state.phase === 'signing-in'}>Sign in</button>
      {state.phase === 'signing-in' && <button type="button" onClick={() => client.cancel()}>Cancel sign-in</button>}
    </form>}
    <p>Settings credentials remain masked-only; no credential values are fetched.</p>
  </section></PublicShell>;
}
// Read once per page load (a repeated initializer must not lose the code).
let linkCode: string | null | undefined;
function readSetupLink(): string | null {
  if (linkCode !== undefined) return linkCode;
  if (typeof window === 'undefined') return null;
  linkCode = setupCodeFromFragment(window.location.hash);
  if (linkCode) try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* keep going */ }
  return linkCode;
}
const ownerSetupNotices: Record<OwnerSetupCode | 'unavailable' | 'mismatch', string> = {
  setup_token_missing: 'No setup code is active. Run `agent-player setup` in a terminal on this computer, then enter the code it shows.',
  setup_token_invalid: 'This setup code is not valid. Check it, or run `agent-player setup` again for a new one.',
  setup_token_expired: 'This setup code has expired (it lasts 24 hours). Run `agent-player setup` again for a new one.',
  setup_not_local: 'The owner can only be created on the installation computer itself.',
  setup_complete: 'An owner already exists. Sign in instead.',
  missing_fields: 'Fill in every field. The password needs at least 12 characters.',
  weak_password: 'Choose a stronger password: at least 12 characters, not a published default.',
  invalid_email: 'Enter a valid email address.',
  user_exists: 'An account with this email already exists.',
  unavailable: 'The installation did not answer. Nothing was created; try again.',
  mismatch: 'The two passwords do not match.',
};
/** First run (INSTALLER-07): create the owner with the one-time code from this computer's terminal. */
function OwnerSetup({ client, setupCode, initialPage }: { client: SessionClient; setupCode: string | null; initialPage?: 'home' | 'account' }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(password);
  const [code, setCode] = useState(setupCode ?? ''); const [editCode, setEditCode] = useState(!setupCode);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<keyof typeof ownerSetupNotices | null>(null);
  return <form className="owner-setup" aria-label="Create the owner account" method="post" onSubmit={async e => {
    e.preventDefault();
    if (password !== confirm) { setNotice('mismatch'); return; }
    setBusy(true); setNotice(null);
    const result = await client.createOwner({ name: name.trim(), email: email.trim(), password, setupToken: code.trim() });
    setBusy(false);
    if (!result.ok) {
      setNotice(result.code);
      if (['setup_token_invalid', 'setup_token_expired', 'setup_token_missing'].includes(result.code)) setEditCode(true);
    }
  }}>
    <h2>Create the owner account</h2>
    <p>Set up the owner of this new workspace. If you used Dpro before, open your existing workspace from the desktop setup instead. The owner controls agents, keys and settings.</p>
    {notice && <p role="alert">{ownerSetupNotices[notice]}</p>}
    <label htmlFor="owner-name">Your name</label><input id="owner-name" required maxLength={100} autoComplete="name" value={name} onChange={e => setName(e.target.value)} disabled={busy}/>
    <label htmlFor="owner-email">Email</label><input id="owner-email" type="email" name="username" required maxLength={320} autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} disabled={busy}/>
    <label htmlFor="owner-password">Password (at least 12 characters)</label><input id="owner-password" type={visible ? 'text' : 'password'} name="new-password" required minLength={12} maxLength={4096} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy}/>
    <label htmlFor="owner-confirm">Repeat the password</label><input id="owner-confirm" type={visible ? 'text' : 'password'} required minLength={12} maxLength={4096} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} disabled={busy}/>
    <div className="row">
      <button type="button" disabled={busy} onClick={() => { const value = generatePassword(); setPassword(value); setConfirm(value); }}>Generate password</button>
      <button type="button" disabled={busy} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? 'Hide password' : 'Show password'}</button>
    </div>
    <label htmlFor="password-strength">Password strength: {strength.label}</label>
    <meter id="password-strength" min={0} max={3} low={2} high={3} optimum={3} value={strength.value} aria-describedby="password-guidance" />
    <p id="password-guidance">{strength.hint} This estimate does not check leaked passwords.</p>
    {editCode ? <>
      <label htmlFor="owner-code">Setup code</label>
      <input id="owner-code" required autoComplete="one-time-code" spellCheck={false} pattern="[A-Za-z0-9_\-]{43}" title="The 43-character code from agent-player setup" value={code} onChange={e => setCode(e.target.value)} disabled={busy}/>
      <p>Run <code>agent-player setup</code> in a terminal on this computer: it shows a one-time code (valid 24 hours) and a link that fills it in.</p>
    </> : <p>Setup code received from the local link. <button type="button" onClick={() => setEditCode(true)} disabled={busy}>Enter a different code</button></p>}
    <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create owner and sign in'}</button>
    <button type="button" onClick={() => void client.discoverSetup()} disabled={busy}>Check setup again</button>
  </form>;
}
/** Local test accounts (dev-quick-login.ts): fills the form only; local builds on a loopback host only. */
function DevQuickLogin({ disabled, onFill, hostname }: { disabled: boolean; onFill: (a: { email: string; password: string }) => void; hostname?: string }) {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const accounts = devQuickLoginAccounts(host);
  if (accounts.length === 0) return null;
  return <fieldset className="dev-quick-login" aria-label="Development quick sign-in">
    <legend>Development quick sign-in — local test accounts only</legend>
    {accounts.map(a => <button key={a.email} type="button" disabled={disabled} onClick={() => onFill(a)}>Fill {a.label}</button>)}
  </fieldset>;
}
export { DevQuickLogin };
