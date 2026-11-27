const { app, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const readHandles = new Map();
const writeHandles = new Map();
let nextHandleId = 1;
let clipWatchProcess = null;

function resolveNativeExe(filename) {
  let exePath = path.join(__dirname, '..', 'native', filename);
  if (app && app.isPackaged) {
    const prodPath = path.join(process.resourcesPath, 'native', filename);
    if (fs.existsSync(prodPath)) return prodPath;
  }
  return exePath;
}

function getClipboardFiles() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const exePath = resolveNativeExe('PrimeClipboard.exe');
    if (!fs.existsSync(exePath)) return resolve([]);

    execFile(exePath, ['GET_FILES'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const paths = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(p => p && fs.existsSync(p));
      resolve(paths);
    });
  });
}

function setClipboardFiles(filePaths) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !Array.isArray(filePaths) || filePaths.length === 0) {
      return resolve(false);
    }
    const exePath = resolveNativeExe('PrimeClipboard.exe');
    if (!fs.existsSync(exePath)) return resolve(false);

    const valid = filePaths.filter(p => p && fs.existsSync(p));
    if (valid.length === 0) return resolve(false);

    const child = spawn(exePath, ['SET_FILES', '--stdin'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore']
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      resolve(false);
    }, 5000);

    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    try {
      child.stdin.write(valid.join('\n') + '\n', 'utf8');
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function createClipboardStageDir() {
  const baseRoot = path.join(os.tmpdir(), 'PrimeDesk_Clipboard');
  try {
    if (!fs.existsSync(baseRoot)) {
      fs.mkdirSync(baseRoot, { recursive: true });
    } else {
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      for (const entry of fs.readdirSync(baseRoot)) {
        const full = path.join(baseRoot, entry);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs < cutoff) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  const stageDir = path.join(baseRoot, `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(stageDir, { recursive: true });
  return stageDir;
}

function stopClipboardWatch() {
  if (!clipWatchProcess) return false;
  const proc = clipWatchProcess;
  clipWatchProcess = null;
  try {
    if (proc.stdin && proc.stdin.writable) {
      proc.stdin.write('QUIT\n');
      proc.stdin.end();
    }
  } catch (e) {}
  try { proc.kill(); } catch (e) {}
  return true;
}

function startClipboardWatch(onFilesChanged) {
  stopClipboardWatch();
  if (process.platform !== 'win32') return false;
  const exePath = resolveNativeExe('PrimeClipboard.exe');
  if (!fs.existsSync(exePath)) return false;

  const child = spawn(exePath, ['WATCH', String(process.pid)], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  });
  clipWatchProcess = child;

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    if (clipWatchProcess !== child) return;
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && Array.isArray(parsed.files)) {
          const valid = parsed.files.filter(p => p && fs.existsSync(p));
          if (typeof onFilesChanged === 'function') {
            onFilesChanged(valid);
          }
        }
      } catch (e) {}
    }
  });

  child.on('close', () => {
    if (clipWatchProcess === child) {
      clipWatchProcess = null;
    }
  });
  child.on('error', () => {
    if (clipWatchProcess === child) {
      clipWatchProcess = null;
    }
  });

  return true;
}

function raceTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

function getWindowsMountedDrives() {
  return new Promise((resolve) => {
    execFile('fsutil', ['fsinfo', 'drives'], { windowsHide: true, encoding: 'utf8', timeout: 1500 }, async (err, stdout) => {
      if (err || !stdout) {
        return resolve(null);
      }
      const matches = stdout.match(/[A-Z]:\\/gi) || [];
      const unique = [...new Set(matches.map(d => d.toUpperCase()))];
      const checks = await Promise.all(unique.map(async (drivePath) => {
        const isNet = await new Promise((resType) => {
          execFile('fsutil', ['fsinfo', 'drivetype', drivePath], { windowsHide: true, encoding: 'utf8', timeout: 700 }, (e2, out2) => {
            resType(Boolean(!e2 && out2 && /network|remote/i.test(out2)));
          });
        });
        try {
          // Offline corporate mapped drives can hang SMB for 30s+; skip fast if unresponsive
          await raceTimeout(fs.promises.access(drivePath), isNet ? 500 : 1200);
          return drivePath;
        } catch (e) {
          return null;
        }
      }));
      resolve(checks.filter(Boolean).sort());
    });
  });
}

async function listRoots() {
  let drives = [];
  if (process.platform === 'win32') {
    const fastDrives = await getWindowsMountedDrives();
    if (fastDrives && fastDrives.length > 0) {
      drives = fastDrives;
    } else {
      const homeRoot = path.parse(app.getPath('home')).root || 'C:\\';
      drives = [homeRoot];
    }
  } else {
    drives.push('/');
  }

  return {
    drives,
    specialDirs: {
      desktop: app.getPath('desktop'),
      downloads: app.getPath('downloads'),
      documents: app.getPath('documents'),
      home: app.getPath('home')
    }
  };
}

async function listDir(dirPath) {
  try {
    const target = path.resolve(dirPath || app.getPath('desktop'));
    const dirents = await fs.promises.readdir(target, { withFileTypes: true });
    const entries = [];
    const batchSize = 32;

    for (let i = 0; i < dirents.length; i += batchSize) {
      const slice = dirents.slice(i, i + batchSize);
      const mapped = await Promise.all(slice.map(async (dirent) => {
        const name = dirent.name;
        const fullPath = path.join(target, name);
        try {
          if (dirent.isDirectory()) {
            return { name, path: fullPath, isDir: true, size: 0, modified: 0 };
          }
          if (dirent.isSymbolicLink()) {
            return null;
          }
          const stat = await fs.promises.lstat(fullPath);
          return {
            name,
            path: fullPath,
            isDir: stat.isDirectory(),
            size: stat.isDirectory() ? 0 : stat.size,
            modified: stat.mtimeMs
          };
        } catch (e) {
          return null;
        }
      }));
      for (const item of mapped) {
        if (item) entries.push(item);
      }
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const parsed = path.parse(target);
    const parent = parsed.root === target ? null : path.dirname(target);
    return { ok: true, path: target, parent, entries };
  } catch (err) {
    return { ok: false, path: dirPath, error: err.message };
  }
}

async function makeDir(dirPath) {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return { ok: true, path: dirPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function trashPaths(paths) {
  try {
    for (const p of paths) {
      if (p && fs.existsSync(p)) {
        await shell.trashItem(p);
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function walkItem(fullPath, relPrefix, files, emptyDirs, seenDirs = new Set()) {
  const stat = await fs.promises.lstat(fullPath);
  if (stat.isSymbolicLink()) return 0;

  if (stat.isDirectory()) {
    const realDir = await fs.promises.realpath(fullPath).catch(() => fullPath);
    if (seenDirs.has(realDir)) return 0;
    seenDirs.add(realDir);

    const children = await fs.promises.readdir(fullPath);
    if (children.length === 0) {
      emptyDirs.push(relPrefix.replace(/\\/g, '/'));
      return 0;
    }
    let dirTotal = 0;
    for (const child of children) {
      const childFull = path.join(fullPath, child);
      const childRel = relPrefix ? `${relPrefix}/${child}` : child;
      try {
        dirTotal += await walkItem(childFull, childRel, files, emptyDirs, seenDirs);
      } catch (e) {}
    }
    return dirTotal;
  }

  files.push({
    fullPath,
    relPath: relPrefix.replace(/\\/g, '/'),
    size: stat.size
  });
  return stat.size;
}

async function collectTransferItems(inputPaths) {
  const files = [];
  const emptyDirs = [];
  const rootItems = [];
  let totalSize = 0;

  for (const rawPath of inputPaths || []) {
    if (!rawPath || !fs.existsSync(rawPath)) continue;
    try {
      const resolved = path.resolve(rawPath);
      const stat = await fs.promises.lstat(resolved);
      if (stat.isSymbolicLink()) continue;
      const baseName = path.basename(resolved);
      const itemBytes = await walkItem(resolved, baseName, files, emptyDirs);
      totalSize += itemBytes;
      rootItems.push({
        name: baseName,
        path: resolved,
        isDir: stat.isDirectory(),
        size: itemBytes
      });
    } catch (e) {}
  }

  return { files, emptyDirs, rootItems, totalSize };
}

function resolveSafeTarget(baseDir, relPath) {
  const cleanRel = (relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...cleanRel.split('/').filter(Boolean));
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Invalid relative path');
  }
  return resolvedTarget;
}

async function openRead(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  const stat = await handle.stat();
  const readId = nextHandleId++;
  readHandles.set(readId, handle);
  return { readId, size: stat.size };
}

async function readChunk(readId, offset, length) {
  const handle = readHandles.get(readId);
  if (!handle) throw new Error('Read handle not open');
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buf, 0, length, offset);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

async function closeRead(readId) {
  const handle = readHandles.get(readId);
  if (!handle) return;
  readHandles.delete(readId);
  try { await handle.close(); } catch (e) {}
}

async function beginWrite(baseDir, relPath) {
  const targetPath = resolveSafeTarget(baseDir, relPath);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.promises.open(targetPath, 'w');
  const writeId = nextHandleId++;
  writeHandles.set(writeId, { handle, targetPath });
  return { writeId, targetPath };
}

async function writeChunk(writeId, data) {
  const entry = writeHandles.get(writeId);
  if (!entry) throw new Error('Write handle not open');
  const buf = Buffer.from(data);
  if (buf.length > 0) {
    await entry.handle.write(buf, 0, buf.length, null);
  }
  return true;
}

async function endWrite(writeId) {
  const entry = writeHandles.get(writeId);
  if (!entry) return { ok: false };
  writeHandles.delete(writeId);
  try { await entry.handle.close(); } catch (e) {}
  return { ok: true, targetPath: entry.targetPath };
}

async function abortWrite(writeId) {
  const entry = writeHandles.get(writeId);
  if (!entry) return;
  writeHandles.delete(writeId);
  try { await entry.handle.close(); } catch (e) {}
  try { await fs.promises.unlink(entry.targetPath); } catch (e) {}
}

async function createEmptyDir(baseDir, relPath) {
  const targetPath = resolveSafeTarget(baseDir, relPath);
  await fs.promises.mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function cleanupAllHandles() {
  for (const id of [...readHandles.keys()]) {
    await closeRead(id);
  }
  for (const id of [...writeHandles.keys()]) {
    await abortWrite(id);
  }
}

module.exports = {
  getClipboardFiles,
  setClipboardFiles,
  createClipboardStageDir,
  startClipboardWatch,
  stopClipboardWatch,
  listRoots,
  listDir,
  makeDir,
  trashPaths,
  collectTransferItems,
  resolveSafeTarget,
  openRead,
  readChunk,
  closeRead,
  beginWrite,
  writeChunk,
  endWrite,
  abortWrite,
  createEmptyDir,
  cleanupAllHandles
};
