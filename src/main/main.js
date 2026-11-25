const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, session, dialog, net } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const inputHandler = require('./inputHandler');

let mainWindow = null;
let privacyWindow = null;
let normalBounds = { width: 1040, height: 720 };
let lastProxyAuthIssue = false;

app.on('login', (event, webContents, request, authInfo) => {
  if (authInfo && authInfo.isProxy) {
    lastProxyAuthIssue = true;
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: normalBounds.width,
    height: normalBounds.height,
    minWidth: 360,
    minHeight: 74,
    maximizable: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'primedesk.ico'),
    backgroundColor: '#090e17',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    inputHandler.stop();
    if (privacyWindow) {
      try { privacyWindow.close(); } catch (e) {}
    }
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy({ mode: 'system' });
    console.log('[PrimeDesk] System network proxy initialized on startup');
  } catch (err) {
    console.warn('[PrimeDesk] Could not initialize system proxy:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  inputHandler.stop();
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

ipcMain.handle('get-screen-size', () => {
  const primary = screen.getPrimaryDisplay();
  return {
    width: primary.size.width,
    height: primary.size.height,
    scaleFactor: primary.scaleFactor || 1
  };
});

ipcMain.handle('get-local-ips', () => {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push({ name, address: iface.address });
      }
    }
  }
  return results;
});

ipcMain.handle('start-input-worker', () => {
  inputHandler.start();
  return true;
});

ipcMain.handle('stop-input-worker', () => {
  inputHandler.stop();
  return true;
});

ipcMain.handle('send-input', (event, command) => {
  inputHandler.send(command);
  return true;
});

// Clipboard Sync APIs
ipcMain.handle('read-clipboard', () => {
  return clipboard.readText();
});

ipcMain.handle('write-clipboard', (event, text) => {
  if (typeof text === 'string') {
    clipboard.writeText(text);
  }
  return true;
});

// Window mode switching for remote session floating pill
ipcMain.handle('set-pill-mode', () => {
  if (!mainWindow) return;
  const primary = screen.getPrimaryDisplay();
  const pillWidth = 390;
  const pillHeight = 74;
  const margin = 20;

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setMaximizable(false);
  mainWindow.setMinimizable(false);
  mainWindow.setResizable(false);
  mainWindow.setBounds({
    x: primary.workArea.width - pillWidth - margin,
    y: margin,
    width: pillWidth,
    height: pillHeight
  });
  return true;
});

ipcMain.handle('restore-normal-mode', () => {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setMaximizable(false);
  mainWindow.setMinimizable(true);
  mainWindow.setResizable(true);
  mainWindow.setBounds({
    width: normalBounds.width,
    height: normalBounds.height
  });
  mainWindow.center();
  return true;
});

// File Transfer Storage Handler
ipcMain.handle('save-received-file', async (event, { filename, buffer }) => {
  try {
    const downloadsDir = app.getPath('downloads') || path.join(os.homedir(), 'Downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }
    let targetPath = path.join(downloadsDir, filename);
    if (fs.existsSync(targetPath)) {
      const ext = path.extname(filename);
      const name = path.basename(filename, ext);
      targetPath = path.join(downloadsDir, `${name}_${Date.now()}${ext}`);
    }
    fs.writeFileSync(targetPath, Buffer.from(buffer));
    console.log('[FileTransfer] Saved received file to:', targetPath);
    return { success: true, path: targetPath };
  } catch (err) {
    console.error('[FileTransfer] Failed to save received file:', err);
    return { success: false, error: err.message };
  }
});

// Privacy Mode (Black Screen Overlay)
ipcMain.handle('set-privacy-mode', (event, enabled) => {
  if (enabled) {
    if (!privacyWindow) {
      const primary = screen.getPrimaryDisplay();
      privacyWindow = new BrowserWindow({
        x: primary.bounds.x,
        y: primary.bounds.y,
        width: primary.bounds.width,
        height: primary.bounds.height,
        frame: false,
        alwaysOnTop: true,
        transparent: false,
        backgroundColor: '#000000',
        skipTaskbar: true,
        focusable: false
      });
      privacyWindow.loadURL(`data:text/html;charset=utf-8,
        <html>
          <body style="background:#000;color:#38bdf8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
            <h1 style="font-size:2rem;margin-bottom:8px;">🔒 Remote Maintenance Active</h1>
            <p style="font-size:1.1rem;color:#94a3b8;">Screen control is active by authorized technical support.</p>
            <p style="font-size:0.85rem;color:#64748b;margin-top:16px;">Confidential data protected under Privacy Mode.</p>
          </body>
        </html>
      `);
    }
  } else {
    if (privacyWindow) {
      try { privacyWindow.close(); } catch (e) {}
      privacyWindow = null;
    }
  }
  return true;
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.handle('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// Proxy Management & Network Diagnostics Helpers
function normalizeProxyRules(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes('=') || /^socks/i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

async function applyProxyConfig(config) {
  const bypass = (config && config.bypass) ? config.bypass : '<local>;127.0.0.1;localhost';
  const rules = config && config.rules ? normalizeProxyRules(config.rules) : null;
  if (!config || config.mode === 'system') {
    await session.defaultSession.setProxy({ mode: 'system' });
  } else if (config.mode === 'manual' && rules) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: rules,
      proxyBypassRules: bypass
    });
  } else if (config.mode === 'direct') {
    await session.defaultSession.setProxy({ mode: 'direct' });
  } else {
    await session.defaultSession.setProxy({ mode: 'system' });
  }
}

function getEnvProxy() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
}

function getWinHttpProxy() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('netsh', ['winhttp', 'show', 'proxy'], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve('');
      const match = stdout.match(/Proxy Server\(s\)\s*:\s*(.+)/i);
      if (!match) return resolve('');
      const val = match[1].trim();
      if (!val || /\(none\)|direct access/i.test(val)) return resolve('');
      resolve(val);
    });
  });
}

async function probeHttpTarget(probeTarget, timeoutMs = 10000) {
  lastProxyAuthIssue = false;
  try {
    const res = await net.fetch(probeTarget, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: res.ok, status: res.status, proxyAuth: lastProxyAuthIssue || res.status === 407 };
  } catch (err) {
    const msg = [err && err.message, err && err.cause && err.cause.message].filter(Boolean).join(' | ');
    return { ok: false, error: msg || 'Network probe failed', proxyAuth: lastProxyAuthIssue };
  }
}

function classifyNetworkFailure(probeResult, resolvedProxy) {
  const errMsg = probeResult.error || '';
  const status = probeResult.status || 0;

  if (probeResult.proxyAuth || status === 407) {
    return {
      reason: 'proxy-auth',
      summary: 'Proxy Auth Required',
      errorCode: 'HTTP_407',
      details: `The network proxy (${resolvedProxy}) requested username/password authentication. Configure an authenticated or direct connection.`
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      reason: 'server-waking',
      summary: 'Waking Cloud Server...',
      errorCode: `HTTP_${status}`,
      details: `Cloud signaling service returned HTTP ${status} while spinning up. Retrying automatically.`
    };
  }
  if (/ERR_INTERNET_DISCONNECTED/i.test(errMsg)) {
    return {
      reason: 'no-internet',
      summary: 'No Internet',
      errorCode: 'ERR_INTERNET_DISCONNECTED',
      details: 'No active internet connection detected on this computer. Connect to Wi-Fi/Ethernet or switch to Offline Mode.'
    };
  }
  if (/ERR_NAME_NOT_RESOLVED/i.test(errMsg)) {
    return {
      reason: 'dns-error',
      summary: 'DNS Resolution Failed',
      errorCode: 'ERR_NAME_NOT_RESOLVED',
      details: `Cannot resolve primedesk-signal.onrender.com (Proxy: ${resolvedProxy}). Check DNS or network proxy settings.`
    };
  }
  if (/ERR_CERT_|CERT_|SSL/i.test(errMsg)) {
    return {
      reason: 'ssl-error',
      summary: 'Check PC Clock / TLS',
      errorCode: 'ERR_CERT_INVALID',
      details: `TLS certificate verification failed (${errMsg}). Check that this computer's date and time are accurate, or check HTTPS inspection proxy certificates.`
    };
  }
  if (/ERR_PROXY_|ERR_TUNNEL_/i.test(errMsg)) {
    return {
      reason: 'proxy-unreachable',
      summary: 'Proxy Unreachable',
      errorCode: 'ERR_PROXY_CONNECTION_FAILED',
      details: `Cannot connect through configured proxy (${resolvedProxy}). Open Settings → Network & Proxy to verify the proxy address or switch to Direct Connection.`
    };
  }
  if (/TimeoutError|aborted due to timeout|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/i.test(errMsg)) {
    const isDirect = !resolvedProxy || resolvedProxy === 'DIRECT';
    return {
      reason: 'timeout',
      summary: isDirect ? 'Direct Blocked / Timeout' : 'Proxy Timed Out',
      errorCode: errMsg.match(/ERR_[A-Z_]+/)?.[0] || 'ERR_TIMED_OUT',
      details: isDirect
        ? 'Direct connection to Cloud Server timed out (Resolved Proxy: DIRECT). If this network uses a proxy server, configure it in Windows Internet Settings or PrimeDesk Settings → Network & Proxy, or wait if the cloud server is waking up.'
        : `Connection via proxy (${resolvedProxy}) timed out. Check if the proxy server is reachable or switch to Direct Connection.`
    };
  }
  return {
    reason: 'unknown',
    summary: 'Cloud Unreachable',
    errorCode: errMsg || (status ? `HTTP_${status}` : 'UNKNOWN'),
    details: `Could not reach Cloud Server (Proxy: ${resolvedProxy}). Error: ${errMsg || `HTTP ${status}`}`
  };
}

ipcMain.handle('set-network-proxy', async (event, config) => {
  try {
    await applyProxyConfig(config);
    return { success: true };
  } catch (err) {
    console.error('[Proxy] Failed to apply proxy configuration:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('probe-and-recover-cloud', async (event, config = {}) => {
  const signalingUrl = config.signalingUrl || 'wss://primedesk-signal.onrender.com';
  const probeTarget = signalingUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  const configuredMode = config.proxyMode || 'system';
  const initialConfig = {
    mode: configuredMode,
    rules: config.proxyServer || null,
    bypass: config.proxyBypass || '<local>;127.0.0.1;localhost'
  };

  try {
    await applyProxyConfig(initialConfig);
    const resolvedProxy = await session.defaultSession.resolveProxy(probeTarget);
    const firstProbe = await probeHttpTarget(probeTarget, 15000);

    if (firstProbe.ok) {
      return { ok: true, recovered: false, activeMode: configuredMode, resolvedProxy };
    }

    // Attempt intelligent automatic fallback only when in default 'system' mode and server wasn't merely returning 502/503 waking up
    const isWaking = firstProbe.status === 502 || firstProbe.status === 503 || firstProbe.status === 504;
    if (configuredMode === 'system' && !isWaking) {
      const hasConfiguredProxy = resolvedProxy && !/^DIRECT$/i.test(resolvedProxy.trim());

      if (hasConfiguredProxy) {
        // Windows has a system proxy that failed/timed out — test if Direct Internet works!
        await applyProxyConfig({ mode: 'direct' });
        const directProbe = await probeHttpTarget(probeTarget, 7000);
        if (directProbe.ok) {
          console.log('[Proxy] System proxy failed; auto-recovered via Direct connection');
          return {
            ok: true,
            recovered: true,
            activeMode: 'direct',
            resolvedProxy: 'DIRECT',
            note: `System proxy (${resolvedProxy}) failed; automatically connected directly.`
          };
        }
      }

      // Check ENV & WinHTTP fallback proxies if Direct/System didn't succeed
      const candidates = [getEnvProxy(), await getWinHttpProxy()]
        .map(normalizeProxyRules)
        .filter(Boolean);
      const uniqueCandidates = [...new Set(candidates)];

      for (const candidate of uniqueCandidates) {
        if (resolvedProxy && resolvedProxy.includes(candidate)) continue;
        await applyProxyConfig({ mode: 'manual', rules: candidate, bypass: initialConfig.bypass });
        const proxyProbe = await probeHttpTarget(probeTarget, 7000);
        if (proxyProbe.ok) {
          console.log('[Proxy] Auto-recovered via detected proxy:', candidate);
          return {
            ok: true,
            recovered: true,
            activeMode: 'auto-detected',
            detectedProxy: candidate,
            resolvedProxy: `PROXY ${candidate}`,
            note: `Auto-detected working proxy (${candidate}).`
          };
        }
      }

      // No fallback worked — restore original configured strategy
      await applyProxyConfig(initialConfig);
    }

    const classified = classifyNetworkFailure(firstProbe, resolvedProxy);
    return {
      ok: false,
      resolvedProxy,
      ...classified
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'unknown',
      summary: 'Network Probe Error',
      errorCode: 'PROBE_EXCEPTION',
      details: err.message
    };
  }
});

// Directory selection for Session Recordings
ipcMain.handle('select-directory', async (event, defaultPath) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath || app.getPath('videos')
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Get default recordings directory
ipcMain.handle('get-default-recordings-dir', () => {
  const base = app.getPath('videos');
  const dir = path.join(base, 'PrimeDesk Recordings');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }
  return dir;
});

// Save Session Recording file (.webm)
ipcMain.handle('save-recording', async (event, { buffer, filename, directory }) => {
  try {
    const saveDir = directory || path.join(app.getPath('videos'), 'PrimeDesk Recordings');
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }
    const targetPath = path.join(saveDir, filename);
    fs.writeFileSync(targetPath, Buffer.from(buffer));
    return { success: true, path: targetPath };
  } catch (err) {
    console.error('[Recording] Failed to save file:', err);
    return { success: false, error: err.message };
  }
});

// Auto-start on Windows startup
ipcMain.handle('get-auto-start', () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('set-auto-start', (event, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath
    });
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
});
