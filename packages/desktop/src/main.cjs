'use strict';
/**
 * Dpro desktop app, Electron main process (INSTALLER-05, D-INSTALL-SHELL).
 *
 * - One instance only; a second launch focuses the open window.
 * - "This computer" (default): the bundled backend + UI bridge on 127.0.0.1,
 *   random ports, per-launch token (local-runtime.cjs). First run opens the
 *   owner setup with a one-time code in the URL fragment (INSTALLER-07).
 * - "Existing Dpro": the window opens another Dpro's address (https, or http
 *   on this computer); nothing runs locally.
 * - Quit (menu, Cmd/Ctrl+Q, last window closed) stops the backend first.
 */
const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalRuntime, openLog } = require('./local-runtime.cjs');
const { resolvePayload, backendArgs, checkPayload } = require('./payload.cjs');
const { loadSettings, saveSettings, remoteOrigin } = require('./settings.cjs');

const discovery = require('./data-discovery.cjs');
let selectedData = null;
let discovered = [];
const PAGES = path.join(__dirname, 'pages');
const PAGES_URL = `${pathToFileURL(PAGES).href}/`;
let mainWindow = null;
let connectWindow = null;
let runtime = null;
let log = null;
let appOrigin = null;
let quitting = false;
let stopped = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(boot);
}

/** Data for "this computer": <userData>/data (DPRO_DESKTOP_DATA_DIR overrides, e.g. for tests). */
const dataDir = () => selectedData || (process.env.DPRO_DESKTOP_DATA_DIR ? path.resolve(process.env.DPRO_DESKTOP_DATA_DIR) : path.join(app.getPath('userData'), 'data'));
const settingsDir = () => app.getPath('userData');

function hardenSession() {
  // Only the microphone (dictation) and clipboard writes, only for the app's own origin.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = (() => { try { return new URL(details.requestingUrl || contents.getURL()).origin; } catch { return null; } })();
    callback(origin !== null && origin === appOrigin && (permission === 'media' || permission === 'clipboard-sanitized-write'));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => requestingOrigin === appOrigin && (permission === 'media' || permission === 'clipboard-sanitized-write'));
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') shell.openExternal(url);
  } catch { /* not a URL */ }
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: 'Dpro', show: false, backgroundColor: '#111111',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.once('ready-to-show', () => win.show());
  // Links to other sites open in the normal browser; the window stays on the app.
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    let origin = null;
    try { origin = new URL(url).origin; } catch { /* invalid */ }
    if (url.startsWith(PAGES_URL)) return;
    if (origin !== appOrigin) { event.preventDefault(); openExternal(url); }
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('closed', () => { mainWindow = null; });
  return win;
}

function showPage(name, query = {}) {
  appOrigin = null;
  return mainWindow.loadFile(path.join(PAGES, name), { query });
}

async function startLocal() {
  await showPage('starting.html');
  const payload = resolvePayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const problems = checkPayload(payload);
  if (problems.length) return showPage('failed.html', { reason: problems.join(', ') });
  log = log || openLog(path.join(app.getPath('userData'), 'logs', 'backend.log'));
  const { createApplicationServer } = require(path.join(payload.coreUiDir, 'scripts', 'application-server.cjs'));
  runtime = createLocalRuntime({
    node: payload.node,
    readyTimeoutMs: 30000,
    args: backendArgs(payload.backendDir),
    cwd: path.basename(dataDir()) === '.data' ? path.dirname(dataDir()) : dataDir(),
    dataDir: dataDir(),
    extraEnv: { AGENT_TERMINAL: 'true', ...(path.basename(dataDir()) === '.data' ? { AGENT_PLAYER_DATA_DIR: undefined } : {}) },
    createBridge: ({ upstreamPort, launchToken }) => createApplicationServer({ packageRoot: payload.coreUiDir, channel: 'candidate', upstreamPort, launchToken }),
    onLog: line => log.write(line),
    onBackendExit: ({ code, signal }) => {
      log.write(`backend stopped unexpectedly (${signal || code})`);
      if (!quitting && mainWindow) showPage('failed.html', { reason: 'The Dpro engine stopped unexpectedly.' });
      runtime = null;
    },
  });
  try {
    const started = await runtime.start();
    appOrigin = started.origin;
    await mainWindow.loadURL(started.url);
  } catch (error) {
    runtime = null;
    log.write(`start failed: ${error.message}`);
    for (const line of error.logTail || []) log.write(`  ${line}`);
    await showPage('failed.html', { reason: error.message });
  }
}

async function startRemote(origin) {
  appOrigin = origin;
  try { await mainWindow.loadURL(`${origin}/`); }
  catch { await showPage('failed.html', { reason: `Could not open ${origin}.`, remote: '1' }); }
}

async function stopLocal() {
  const current = runtime;
  runtime = null;
  if (current) await current.stop();
}

async function applyMode() {
  const settings = loadSettings(settingsDir());
  if (settings.mode === 'remote' && settings.remoteUrl) {
    await stopLocal();
    return startRemote(settings.remoteUrl);
  }
  if (!runtime) {
    if (!selectedData) {
      await showPage('starting.html');
      await scanData();
      let decision = discovery.decide(discovered, readSelection());
      try { const saved = JSON.parse(fs.readFileSync(path.join(settingsDir(), 'workspace.json'), 'utf8')); if (saved.newWorkspace === true && saved.dir.startsWith(path.join(settingsDir(), 'workspaces') + path.sep) && discovered.find(r => r.dir === saved.dir)?.state === 'unconfigured') decision = { kind: 'existing', dir: saved.dir }; } catch { /* no confirmed new workspace */ }
      if (decision.kind !== 'existing') return showPage('welcome.html');
      selectedData = decision.dir;
      if (!readSelection()) {
        const file = path.join(settingsDir(), 'workspace.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify({ dir: selectedData }), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
      }
    }
    return startLocal();
  }
}

function readSelection() { return require('./workspace-selection.cjs').readSelection(settingsDir()); }
async function scanData(extra) {
  const payload = resolvePayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const dirs = discovery.candidates({ defaultDir: path.join(settingsDir(), 'data'), home: app.getPath('home'), cwd: process.cwd(), backendDir: payload.backendDir, savedDir: readSelection(), explicitDir: process.env.DPRO_DESKTOP_DATA_DIR });
  if (extra && !dirs.includes(extra)) dirs.push(extra);
  discovered = await discovery.discover(payload.node, payload.backendDir, dirs, extra ? null : readSelection());
  fs.writeFileSync(path.join(settingsDir(), 'workspace-discovery.json'), JSON.stringify(discovered), { mode: 0o600 });
  return discovered;
}
// Only the active local workspace can open this user-driven folder chooser.
ipcMain.handle('dpro:choose-project-folders', async event => {
  if (!runtime || !mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return [];
  let origin;try {origin=new URL(event.senderFrame.url).origin;}catch{return [];}
  if (origin !== appOrigin || !appOrigin.startsWith('http://127.0.0.1:')) return [];
  const result=await dialog.showOpenDialog(mainWindow,{title:'Choose project folders to scan for documentation',properties:['openDirectory','multiSelections']});
  return result.canceled ? [] : result.filePaths.slice(0,8);
});
const fromWelcome = event => mainWindow && event.sender === mainWindow.webContents && mainWindow.webContents.getURL().split('?')[0] === pathToFileURL(path.join(PAGES, 'welcome.html')).href;
ipcMain.handle('dpro:discover-data', event => fromWelcome(event) ? discovered : []);
ipcMain.handle('dpro:find-data', async event => {
  if (!fromWelcome(event)) return { ok: false };
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose the folder containing agent-player.db', properties: ['openDirectory', 'showHiddenFiles'] });
  if (!result.canceled) await scanData(result.filePaths[0]);
  return { ok: true };
});
ipcMain.handle('dpro:select-data', async (event, dir) => {
  if (!fromWelcome(event) || !discovered.some(r => r.dir === dir && r.state === 'existing')) return { ok: false };
  const payload = resolvePayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  if ((await discovery.probe(payload.node, payload.backendDir, dir)).state !== 'existing') return { error: 'The existing account could not be verified. No new account was created.' };
  selectedData = dir;
  const file = path.join(settingsDir(), 'workspace.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ dir }), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  await applyMode(); return { ok: true };
});
ipcMain.handle('dpro:new-workspace', async (event, confirmed) => {
  if (!fromWelcome(event) || confirmed !== true) return { ok: false };
  selectedData = path.join(settingsDir(), 'workspaces', require('node:crypto').randomUUID());
  fs.mkdirSync(selectedData, { recursive: true, mode: 0o700 });
  const file = path.join(settingsDir(), 'workspace.json');
  fs.writeFileSync(file, JSON.stringify({ dir: selectedData, newWorkspace: true }), { mode: 0o600 });
  await startLocal(); return { ok: true };
});

function openConnectWindow() {
  if (connectWindow) return connectWindow.focus();
  connectWindow = new BrowserWindow({
    parent: mainWindow || undefined, modal: Boolean(mainWindow), width: 520, height: 360, resizable: false,
    title: 'Connect to an existing Dpro', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  connectWindow.setMenu(null);
  connectWindow.once('ready-to-show', () => connectWindow.show());
  connectWindow.webContents.on('will-navigate', event => event.preventDefault());
  connectWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectWindow.on('closed', () => { connectWindow = null; });
  const { remoteUrl } = loadSettings(settingsDir());
  connectWindow.loadFile(path.join(PAGES, 'connect.html'), { query: remoteUrl ? { current: remoteUrl } : {} });
}

const fromConnectWindow = event => connectWindow && event.sender === connectWindow.webContents;

ipcMain.handle('dpro:connect', async (event, input) => {
  if (!fromConnectWindow(event)) return { ok: false };
  const origin = remoteOrigin(input);
  if (!origin) return { ok: false, error: 'Use an https:// address, or http:// on this computer (127.0.0.1 or localhost).' };
  try { await require('./connection-check.cjs').checkConnection(origin); } catch (error) { return { ok: false, error: error.message }; }
  saveSettings(settingsDir(), { mode: 'remote', remoteUrl: origin });
  connectWindow.close();
  await applyMode();
  return { ok: true };
});

ipcMain.handle('dpro:use-local', async event => {
  if (!fromConnectWindow(event) && !(mainWindow && event.sender === mainWindow.webContents && !appOrigin)) return { ok: false };
  const settings = loadSettings(settingsDir());
  saveSettings(settingsDir(), { mode: 'local', remoteUrl: settings.remoteUrl });
  if (connectWindow) connectWindow.close();
  await applyMode();
  return { ok: true };
});

ipcMain.handle('dpro:retry', async event => {
  if (!(mainWindow && event.sender === mainWindow.webContents && !appOrigin)) return { ok: false };
  await applyMode();
  return { ok: true };
});

ipcMain.handle('dpro:open-connect', event => {
  if (!(mainWindow && event.sender === mainWindow.webContents && !appOrigin)) return { ok: false };
  openConnectWindow();
  return { ok: true };
});

function navigate(destination) {
  if (mainWindow && appOrigin) mainWindow.webContents.send('dpro:navigate', destination);
}
ipcMain.handle('dpro:app-info', event => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !appOrigin) return null;
  return { version: app.getVersion(), connection: loadSettings(settingsDir()).mode };
});
async function chooseWorkspace() {
  const result = await dialog.showMessageBox(mainWindow, { type: 'question', message: 'Open another workspace?', detail: 'This closes your current session and stops this local engine. Your saved conversations and keys stay in their existing folders.', buttons: ['Cancel', 'Choose workspace'], defaultId: 0, cancelId: 0 });
  if (result.response !== 1) return;
  await stopLocal(); selectedData = null; await scanData(); await showPage('welcome.html');
}
function buildMenu() {
  const mac = process.platform === 'darwin';
  const settings = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => navigate('settings') };
  const about = { label: 'About Dpro', click: () => app.showAboutPanel() };
  app.setAboutPanelOptions({ applicationName: 'Dpro', applicationVersion: app.getVersion() });
  const template = [
    ...(mac ? [{ label: 'Dpro', submenu: [about, settings, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Choose Workspace…', click: chooseWorkspace },
      { label: 'Use Dpro on This Computer', click: async () => { saveSettings(settingsDir(), { ...loadSettings(settingsDir()), mode: 'local' }); await applyMode(); } },
      { label: 'Connect to an Existing Dpro…', click: openConnectWindow },
      { type: 'separator' }, { label: 'Account…', click: () => navigate('account') },
      ...(!mac ? [settings, about, { role: 'quit' }] : []),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Welcome / Workspace', click: () => navigate('home') }, { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Getting Started', click: () => dialog.showMessageBox(mainWindow, { message: 'Getting started with Dpro', detail: 'Open your existing workspace from File, then sign in with its existing account. Conversations and tools stay locked until sign-in. Settings contains appearance, account access and version information.' }) },
      { label: 'Show Log Folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
      { label: 'Version & Updates', click: () => navigate('about') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  fs.mkdirSync(settingsDir(), { recursive: true, mode: 0o700 });
  hardenSession();
  buildMenu();
  mainWindow = createMainWindow();
  await applyMode();
}

// The app lives in one window: closing it quits (and stops the backend) on every OS.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  stopLocal()
    .catch(error => { if (log) log.write(`stop failed: ${error.message}`); })
    .finally(() => { stopped = true; if (log) log.close(); app.quit(); });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault());
});

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.quit());
