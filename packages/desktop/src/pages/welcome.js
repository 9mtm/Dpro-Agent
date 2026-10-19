'use strict';
const api = window.dproDesktop;
const error = document.getElementById('error');
const run = async fn => { error.textContent = ''; try { const r = await fn(); if (r?.error) error.textContent = r.error; } catch { error.textContent = 'Could not open the workspace. Your existing data was not replaced.'; } };
async function refresh() {
  const rows = await api.discoverData();
  document.getElementById('status').textContent = rows.some(r => r.state === 'existing') ? 'Existing account found. Open its workspace to sign in.' : 'No verified owner found yet. Choose your previous data folder if you used Dpro before.';
  const list = document.getElementById('sources'); list.replaceChildren();
  for (const row of rows.filter(r => r.state !== 'missing')) {
    const p = document.createElement('p'); p.textContent = row.dir + (row.state === 'existing' ? ' — Existing account' : row.state === 'unreadable' ? ' — Could not verify; creation is blocked here' : ' — No owner account'); list.append(p);
    if (row.state === 'existing') { const b = document.createElement('button'); b.textContent = 'Use this workspace'; b.onclick = () => run(() => api.selectData(row.dir)); list.append(b); }
  }
}
document.getElementById('folder').onclick = () => run(async () => { const r = await api.findData(); await refresh(); return r; });
document.getElementById('connect').onclick = () => run(() => api.openConnect());
document.getElementById('confirm').onchange = e => { document.getElementById('new').disabled = !e.target.checked; };
document.getElementById('new').onclick = () => run(() => api.newWorkspace(document.getElementById('confirm').checked));
void refresh().catch(() => { error.textContent = 'Could not inspect existing data. Choose your previous folder; no account has been created.'; });
