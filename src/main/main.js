const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const inputHandler = require('./inputHandler');

let mainWindow = null;
let privacyWindow = null;
let normalBounds = { width: 1040, height: 720 };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: normalBounds.width,
    height: normalBounds.height,
    minWidth: 360,
    minHeight: 74,
    icon: path.join(__dirname, '..', '..', 'assets', 'primedesk.ico'),
    backgroundColor: '#090e17',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
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

app.whenReady().then(() => {
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

// Window mode switching for Hospital floating pill
ipcMain.handle('set-pill-mode', () => {
  if (!mainWindow) return;
  const primary = screen.getPrimaryDisplay();
  const pillWidth = 360;
  const pillHeight = 74;
  const margin = 20;

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
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
  mainWindow.setBounds({
    width: normalBounds.width,
    height: normalBounds.height
  });
  mainWindow.center();
  return true;
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
            <h1 style="font-size:2rem;margin-bottom:8px;">🔒 Hospital EHR Maintenance Active</h1>
            <p style="font-size:1.1rem;color:#94a3b8;">Patient health records protected under Privacy Mode.</p>
            <p style="font-size:0.85rem;color:#64748b;margin-top:16px;">Remote session in progress by authorized IT support.</p>
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
