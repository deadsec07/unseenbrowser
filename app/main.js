const { app, BrowserWindow, BrowserView, session, ipcMain, Menu, shell, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { v4: uuidv4 } = require('uuid');
const { autoUpdater } = require('electron-updater');
const { TorManager } = require('./tor');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');

// ---- Hardening ----
app.commandLine.appendSwitch('disable-features', [
  'InterestCohort','TopicsAPI','TrustTokens','FirstPartySets',
  'NetworkTimeServiceQuerying','NotificationTriggers','IdleDetection'
].join(','));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy','disable_non_proxied_udp');

let win;
let adblocker = null; // shared instance across sessions
let adblockerPromise = null;

async function getAdblocker() {
  if (adblocker) return adblocker;
  if (adblockerPromise) return adblockerPromise;
  const cachePath = path.join(app.getPath('userData'), 'adblocker-engine.bin');
  adblockerPromise = ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: cachePath,
    read: fsp.readFile,
    write: fsp.writeFile,
  }).then((b) => { adblocker = b; return b; }).catch(async (e) => {
    // Fallback without cache params if file I/O fails
    try { const b = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch); adblocker = b; return b; } catch { throw e; }
  });
  return adblockerPromise;
}
const tor = new TorManager(app);

const FIRST_RUN_FILE = path.join(app.getPath('userData'), 'first-run.json');
function isFirstRun() { return !fs.existsSync(FIRST_RUN_FILE); }
function markFirstRunDone() { try { fs.writeFileSync(FIRST_RUN_FILE, JSON.stringify({ done: true })); } catch {} }

// ---- Config & Session files ----
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');

// ---- Containers ----
const containers = new Map(); // name -> { partition, persistent, torEnabled }
function ensureContainer(name, persistent=false) {
  if (containers.has(name)) return containers.get(name);
  const partition = (persistent ? 'persist:' : '') + `c-${name}`;
  const info = { partition, persistent, torEnabled: false };
  containers.set(name, info);
  return info;
}
ensureContainer('Private', false);
ensureContainer('Work', true);
ensureContainer('Social', true);

// ---- Tabs ----
const tabs = new Map(); // id -> { id, container, view, favicon }
let activeTabId = null;

// ---- Permissions allowlist ----
const ALLOW_FILE = path.join(app.getPath('userData'), 'permissions.json');
let allowDB = { media: {}, geo: {} };
try { if (fs.existsSync(ALLOW_FILE)) allowDB = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')); } catch {}
const saveAllowDB = () => { try { fs.writeFileSync(ALLOW_FILE, JSON.stringify(allowDB, null, 2)); } catch {} };

// ---- URL Normalizer ----
const STRIP = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','dclid','fbclid','msclkid']);
function normalizeInput(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (/^about:blank$/i.test(s)) return 'about:blank';
  if (/^[a-zA-Z]+:\/\//.test(s)) return s;
  const hasSpace = /\s/.test(s);
  const looksHost = /^[a-z0-9.-]+$/i.test(s) && s.includes('.');
  if (hasSpace || !looksHost) return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  return 'https://' + s;
}

// ---- UI helpers ----
function sendUI(ch, payload){ if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
let __topBarHeight = 56;
function layoutViews(){
  if (!win || !activeTabId) return;
  const view = tabs.get(activeTabId)?.view; if (!view) return;
  // Use content bounds to avoid including OS chrome/titlebar sizes
  const { width, height } = win.getContentBounds();
  const topBar = __topBarHeight;
  view.setBounds({ x:0, y:topBar, width:Math.max(100,width), height:Math.max(100,height-topBar) });
  view.setAutoResize({ width:true, height:true });
}

// Measure the actual height of the top UI bar from the renderer
function measureTopBar(){
  if (!win) return;
  try {
    win.webContents.executeJavaScript(
      '(() => { const el = document.querySelector(".bar"); return el ? Math.ceil(el.getBoundingClientRect().height) : 56; })()'
    , true).then((h) => {
      if (typeof h === 'number' && h > 0 && h < 500) { __topBarHeight = h; layoutViews(); }
    }).catch(()=>{});
  } catch {}
}
function getActiveWC() { const t = tabs.get(activeTabId); return t ? t.view.webContents : null; }
function toggleDevToolsActive() { const wc = getActiveWC(); if (wc) wc.toggleDevTools(); }

// ---- Context Menus ----
function showPageContextMenu(wc, params) {
  const template = [];

  if (params.linkURL) {
    template.push(
      { label: 'Open Link in New Tab', click: () => {
          const container = tabs.get(activeTabId)?.container || 'Private';
          createTab({ container, startURL: params.linkURL });
        } },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }

  if (params.isEditable) {
    template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  } else {
    if (params.selectionText) template.push({ role: 'copy' });
    template.push({ role: 'selectAll' });
  }

  template.push({ type: 'separator' });
  template.push({
    label: 'Inspect Element',
    click: () => { wc.inspectElement(params.x, params.y); if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' }); }
  });

  Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(wc) });
}
function wireUIContextMenu() {
  if (!win) return;
  win.webContents.on('context-menu', (_e, params) => {
    const template = [];
    if (params.isEditable) template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else {
      if (params.selectionText) template.push({ role: 'copy' });
      template.push({ role: 'selectAll' });
    }
    // no Inspect in UI bar
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

// ---- Proxy (Tor) ----
async function applyProxyFor(containerName) {
  const { partition, torEnabled } = ensureContainer(containerName);
  const ses = session.fromPartition(partition);

  if (torEnabled) {
    sendUI('tor:boot', { container: containerName, pct: 0, msg: 'Starting Tor…' });
    try {
      await tor.startAndWait((pct, msg) => sendUI('tor:boot', { container: containerName, pct, msg }));
      await ses.setProxy({ proxyRules: tor.proxyRules(), proxyBypassRules: '<-loopback>' });
    } catch (e) {
      sendUI('tor:error', { container: containerName, error: e.message });
      await ses.setProxy({ mode: 'direct' });
    }
  } else {
    await ses.setProxy({ mode: 'direct' });
  }
  try { await ses.clearHostResolverCache?.(); } catch {}
}

// ---- Session init per container ----
async function initSessionForContainer(containerName) {
  const { partition } = ensureContainer(containerName);
  const ses = session.fromPartition(partition);

  if (!ses.__adblockInitialized) {
    try {
      const blocker = await getAdblocker();
      blocker.enableBlockingInSession(ses);
      ses.__adblockInitialized = true;
    } catch {}
  }
  if (!ses.__headersHandler) {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      delete headers['Referer']; delete headers['referrer']; delete headers['DNT'];
      headers['User-Agent'] = 'Mozilla/5.0 (X11; Linux x86_64; rv:115.0) Gecko/20100101 Firefox/115.0';
      callback({ requestHeaders: headers });
    });
    ses.__headersHandler = true;
  }
  if (!ses.__requestHandler) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      try{
        const u = new URL(details.url);
        if (details.method === 'GET' && u.protocol === 'http:' &&
            !['localhost','127.0.0.1','0.0.0.0'].includes(u.hostname)) {
          u.protocol = 'https:'; return callback({ redirectURL: u.toString() });
        }
        let changed=false;
        for (const k of [...u.searchParams.keys()]) {
          if (STRIP.has(k.toLowerCase())) { u.searchParams.delete(k); changed=true; }
        }
        if (changed) return callback({ redirectURL: u.toString() });
      } catch {}
      callback({});
    });
    ses.__requestHandler = true;
  }
  if (!ses.__permHandler) {
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      try {
        const url = new URL(wc.getURL()); const host = url.hostname;
        if (permission === 'media') return callback(!!allowDB.media[host]);
        if (permission === 'geolocation') return callback(!!allowDB.geo[host]);
        return callback(false);
      } catch { return callback(false); }
    });
    ses.__permHandler = true;
  }
  if (!ses.__downloadHandler) {
    ses.on('will-download', (event, item) => {
      try { item.setSavePath(path.join(app.getPath('downloads'), item.getFilename())); } catch {}
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sendUI('download:progress', { id, name: item.getFilename(), received: 0, total: item.getTotalBytes() });
      item.on('updated', () => {
        sendUI('download:progress', { id, name: item.getFilename(), received: item.getReceivedBytes(), total: item.getTotalBytes() });
      });
      item.once('done', (_e, state) => {
        sendUI('download:done', { id, name: item.getFilename(), state, path: item.getSavePath() });
        if (state === 'completed') shell.showItemInFolder(item.getSavePath());
      });
    });
    ses.__downloadHandler = true;
  }
  return ses;
}

// ---- Probe ----
async function probeContainer(containerName) {
  const info = ensureContainer(containerName);
  const { partition, torEnabled } = info;
  // Ensure session hooks + proxy are applied before probing
  await initSessionForContainer(containerName).catch(()=>{});
  await applyProxyFor(containerName).catch(()=>{});

  return new Promise(async (resolve) => {
    const probe = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    const result = { container: containerName, torExpected: !!torEnabled, ok: false, ip: null, isTor: null, error: null };
    const done = () => { try { probe.destroy(); } catch {} ; sendUI('container:status', result); resolve(result); };

    // Helper to load a URL with a timeout
    const loadWithTimeout = (url, ms = 12000) => new Promise((resolveLoad, rejectLoad) => {
      let finished = false;
      const t = setTimeout(() => { if (!finished) { finished = true; try { probe.webContents.stop(); } catch {} ; rejectLoad(new Error('timeout')); } }, ms);
      probe.loadURL(url).then(() => { if (!finished) { finished = true; clearTimeout(t); resolveLoad(); } })
        .catch((e) => { if (!finished) { finished = true; clearTimeout(t); rejectLoad(e); } });
    });

    try {
      // Try multiple IP endpoints to avoid single-provider failures
      const candidates = [
        { url: 'https://api.ipify.org?format=text', parse: (s) => s.trim() },
        { url: 'https://checkip.amazonaws.com/', parse: (s) => s.trim() },
        { url: 'https://icanhazip.com/', parse: (s) => s.trim() },
        { url: 'https://ifconfig.me/ip', parse: (s) => s.trim() }
      ];
      let ip = null; let lastErr = null;
      for (const c of candidates) {
        try {
          await loadWithTimeout(c.url, 12000);
          const text = await probe.webContents.executeJavaScript('document.body.innerText', true);
          ip = c.parse(String(text || '')) || null;
          if (ip) break;
        } catch (e) { lastErr = e; }
      }
      result.ip = ip;

      // Tor detection via API first, then fallback to page text
      try {
        await loadWithTimeout('https://check.torproject.org/api/ip', 15000);
        const apiText = await probe.webContents.executeJavaScript('document.body.innerText', true);
        try {
          const data = JSON.parse(apiText);
          if (typeof data.IsTor === 'boolean') {
            result.isTor = data.IsTor;
          }
          if (!ip && data.IP) result.ip = data.IP;
        } catch {}
      } catch {}
      if (typeof result.isTor !== 'boolean') {
        try {
          await loadWithTimeout('https://check.torproject.org/', 15000);
          const html = await probe.webContents.executeJavaScript('document.documentElement.innerText', true);
          result.isTor = /Congratulations\. This browser is configured to use Tor/i.test(html);
        } catch {}
      }

      result.ok = !!(result.ip || typeof result.isTor === 'boolean');
      if (!result.ok && lastErr) result.error = String(lastErr && lastErr.message || lastErr);
    } catch (e) {
      result.error = String(e && e.message || e);
    }
    done();
  });
}

// ---- Tab helpers ----
function broadcastTabsState() {
  sendUI('tab:state', {
    activeTabId,
    tabs: [...tabs.values()].map(t => ({
      id: t.id,
      container: t.container,
      title: t.view.webContents.getTitle() || 'New Tab',
      url: t.view.webContents.getURL() || t.pendingURL || '',
      favicon: t.favicon || null
    })),
    containers: [...containers.entries()].map(([name, info]) => ({ name, tor: info.torEnabled }))
  });
}

async function createTab({ container='Private', startURL='https://start.duckduckgo.com/', activate=true, deferLoad=false } = {}) {
  const id = uuidv4();
  ensureContainer(container, container !== 'Private');
  await initSessionForContainer(container);
  await applyProxyFor(container);

  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      partition: ensureContainer(container).partition
    }
  });

  tabs.set(id, { id, container, view, favicon: null, pendingURL: deferLoad ? startURL : null });
  if (activate) {
    win.addBrowserView(view);
    activeTabId = id;
    layoutViews();
  }

  const wc = view.webContents;

  wc.on('did-start-loading', () => { sendUI('loading', { id, loading: true }); try { win.setProgressBar(2); } catch {} });
  const stopLoad = () => { sendUI('loading', { id, loading: false }); try { win.setProgressBar(-1); } catch {} };
  wc.on('did-stop-loading', stopLoad);
  wc.on('did-fail-load', stopLoad);

  wc.on('page-favicon-updated', (_e, favicons) => {
    const first = Array.isArray(favicons) && favicons[0];
    if (first) { const t = tabs.get(id); if (t) t.favicon = first; broadcastTabsState(); }
  });

  wc.on('context-menu', (_e, params) => showPageContextMenu(wc, params));

  const emit = () => broadcastTabsState();
  wc.on('page-title-updated', emit);
  wc.on('did-navigate', emit);
  wc.on('did-navigate-in-page', emit);

  if (!deferLoad) wc.loadURL(startURL);
  broadcastTabsState();
  return id;
}

function activateTab(id){
  if (!tabs.has(id)) return;
  for (const t of tabs.values()) win.removeBrowserView(t.view);
  const t = tabs.get(id);
  win.addBrowserView(t.view);
  activeTabId = id;
  // Load deferred URL on activation if needed
  try {
    if (t.pendingURL) { t.view.webContents.loadURL(t.pendingURL); t.pendingURL = null; }
  } catch {}
  layoutViews();
  broadcastTabsState();
}

function closeTab(id){
  const t = tabs.get(id); if (!t) return;
  win.removeBrowserView(t.view);
  try { t.view.webContents.destroy(); } catch {}
  try { t.view.destroy(); } catch {}
  tabs.delete(id);
  if (activeTabId === id) {
    const list = [...tabs.values()];
    activeTabId = list.length ? list[list.length-1].id : null;
    if (activeTabId) { win.addBrowserView(tabs.get(activeTabId).view); layoutViews(); }
  }
  broadcastTabsState();
}

async function setContainerTor(containerName, enabled){
  const info = ensureContainer(containerName, containerName !== 'Private');
  info.torEnabled = !!enabled;
  await applyProxyFor(containerName);
  for (const t of tabs.values()) if (t.container === containerName) t.view.webContents.reload();
  broadcastTabsState();
  probeContainer(containerName);
}

// ---- Menu & Shortcuts ----
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }]
    }] : []),
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }] } // no devtools here
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function registerShortcuts(){
  // devtools shortcuts
  globalShortcut.register('F12', toggleDevToolsActive);
  globalShortcut.register('CommandOrControl+Shift+I', toggleDevToolsActive);
  // browser shortcuts
  globalShortcut.register('CommandOrControl+T', () => {
    const current = tabs.get(activeTabId);
    const container = current ? current.container : 'Private';
    createTab({ container, startURL: 'https://start.duckduckgo.com/' });
  });
  globalShortcut.register('CommandOrControl+W', () => { if (activeTabId) closeTab(activeTabId); });
  for (let i=1;i<=9;i++){
    globalShortcut.register(`CommandOrControl+${i}`, () => {
      const arr = [...tabs.values()];
      const idx = i-1;
      if (arr[idx]) activateTab(arr[idx].id);
    });
  }
}

// ---- Session Save/Restore ----
function saveSession() {
  try {
    const arr = [...tabs.values()];
    const state = {
      activeIndex: Math.max(0, arr.findIndex(t => t.id === activeTabId)),
      tabs: arr.map(t => ({ container: t.container, url: t.view.webContents.getURL() || 'https://start.duckduckgo.com/' })),
      containers: [...containers.entries()].map(([name, info]) => ({ name, tor: info.torEnabled, persistent: info.persistent }))
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
  } catch {}
}
async function restoreSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (Array.isArray(state.containers)) {
      for (const c of state.containers) {
        ensureContainer(c.name, !!c.persistent);
        containers.get(c.name).torEnabled = !!c.tor;
      }
    }
    if (Array.isArray(state.tabs) && state.tabs.length) {
      const target = Math.min(state.activeIndex ?? 0, state.tabs.length-1);
      for (let i = 0; i < state.tabs.length; i++) {
        const t = state.tabs[i];
        const activate = (i === target);
        const deferLoad = !activate; // lazy-load background tabs to reduce startup CPU/memory
        await createTab({ container: t.container || 'Private', startURL: t.url || 'https://start.duckduckgo.com/', activate, deferLoad });
      }
      return true;
    }
  } catch {}
  return false;
}

// ---- Window ----
function createWindow(){
  win = new BrowserWindow({
    width: 1200, height: 800, title: 'Unseen Browser',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  if (process.platform === 'darwin') {
    try { app.dock.setIcon(path.join(__dirname, 'assets', 'logo.png')); } catch {}
  }
  buildMenu();
  wireUIContextMenu();
  win.loadFile('index.html');
  // Keep BrowserView sized correctly across window state changes
  win.on('resize', () => { measureTopBar(); layoutViews(); });
  win.on('maximize', () => { measureTopBar(); layoutViews(); });
  win.on('unmaximize', () => { measureTopBar(); layoutViews(); });
  win.on('enter-full-screen', () => { measureTopBar(); layoutViews(); });
  win.on('leave-full-screen', () => { measureTopBar(); layoutViews(); });
  win.on('restore', () => { measureTopBar(); layoutViews(); });
  win.on('show', () => { measureTopBar(); layoutViews(); });
  win.webContents.on('did-finish-load', () => { measureTopBar(); layoutViews(); });
  win.on('close', () => saveSession());
  win.on('closed', async () => {
    for (const [name, info] of containers) {
      const ses = session.fromPartition(info.partition);
      try { if (!info.persistent) await ses.clearStorageData(); } catch {}
    }
    tor.stop();
  });
}

app.whenReady().then(async () => {
  try { autoUpdater.checkForUpdatesAndNotify().catch(()=>{}); } catch {}
  createWindow();
  registerShortcuts();
  const restored = await restoreSession();
  if (!restored) {
    const startURL = isFirstRun()
      ? pathToFileURL(path.join(__dirname, 'welcome.html')).toString()
      : 'https://start.duckduckgo.com/';
    await createTab({ container: 'Private', startURL });
    if (isFirstRun()) markFirstRunDone();
  }
  probeContainer('Private');
});
app.on('window-all-closed', () => { tor.stop(); app.quit(); });

// ---- IPC ----
ipcMain.handle('tabs:new', async (_e, { container, url }) => {
  if (container && !containers.has(container)) ensureContainer(container, container !== 'Private');
  const id = await createTab({ container: container || 'Private', startURL: url || 'https://start.duckduckgo.com/' });
  return { id };
});
ipcMain.handle('tabs:activate', (_e, id) => { activateTab(id); return { ok:true }; });
ipcMain.handle('tabs:close', (_e, id) => { closeTab(id); return { ok:true }; });

ipcMain.handle('nav:goto', (_e, raw) => {
  const t = tabs.get(activeTabId); if (!t) return;
  const url = normalizeInput(raw);
  if (!url) return { ok:false };
  t.view.webContents.loadURL(url);
  return { ok:true, url };
});
ipcMain.handle('nav:back', () => { const t = tabs.get(activeTabId); if (t && t.view.webContents.canGoBack()) t.view.webContents.goBack(); });
ipcMain.handle('nav:forward', () => { const t = tabs.get(activeTabId); if (t && t.view.webContents.canGoForward()) t.view.webContents.goForward(); });
ipcMain.handle('nav:reload', () => { const t = tabs.get(activeTabId); if (t) t.view.webContents.reload(); });

ipcMain.handle('containers:list', () => ([...containers.entries()].map(([name, info]) => ({ name, tor: info.torEnabled })) ));
ipcMain.handle('containers:add', async (_e, { name, persistent }) => { ensureContainer(name, !!persistent); await initSessionForContainer(name); return { ok:true }; });
ipcMain.handle('containers:setTor', async (_e, { name, enabled }) => { await setContainerTor(name, !!enabled); return { ok:true }; });

ipcMain.handle('perm:get', (_e, host) => ({ media: !!allowDB.media[host], geo: !!allowDB.geo[host] }));
ipcMain.handle('perm:set', (_e, { host, type, allow }) => {
  if (!host) return { ok:false };
  if (type === 'media') allowDB.media[host] = !!allow;
  if (type === 'geo') allowDB.geo[host] = !!allow;
  saveAllowDB();
  return { ok:true };
});

ipcMain.handle('net:probe', async (_e, container) => probeContainer(container));

// Tor control (optional buttons in UI)
ipcMain.handle('tor:start', async () => {
  try {
    await tor.startAndWait((pct, msg) => sendUI('tor:boot', { container: 'system', pct, msg }));
    return { ok: true, port: tor.port };
  } catch (e) {
    sendUI('tor:error', { container: 'system', error: e.message });
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('tor:stop', async () => { tor.stop(); return { ok: true }; });
ipcMain.handle('tor:status', async () => ({ running: tor.isRunning(), ready: tor.isReady(), port: tor.port }));
