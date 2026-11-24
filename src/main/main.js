const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const inputHandler = require('./inputHandler');

let mainWindow = null;
let normalBounds = { width: 1000, height: 680 };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: normalBounds.width,
    height: normalBounds.height,
    minWidth: 320,
    minHeight: 64,
    icon: path.join(__dirname, '..', '..', 'assets', 'primedesk.ico'),
    backgroundColor: '#0f172a',
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
