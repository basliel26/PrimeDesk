const { app, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const readHandles = new Map();
const writeHandles = new Map();
let nextHandleId = 1;

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

async function listRoots() {
  const drives = [];
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    await Promise.all(letters.map(async (letter) => {
      const drivePath = `${letter}:\\`;
      try {
        await fs.promises.access(drivePath);
        drives.push(drivePath);
      } catch (e) {}
    }));
    drives.sort();
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
    const rawNames = await fs.promises.readdir(target);
    const entries = [];

    for (const name of rawNames) {
      const fullPath = path.join(target, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        entries.push({
          name,
          path: fullPath,
          isDir: stat.isDirectory(),
          size: stat.isDirectory() ? 0 : stat.size,
          modified: stat.mtimeMs
        });
      } catch (e) {
        // Skip locked OS entries (e.g. System Volume Information / pagefile.sys)
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

async function walkItem(fullPath, relPrefix, files, emptyDirs) {
  const stat = await fs.promises.stat(fullPath);
  if (stat.isDirectory()) {
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
        dirTotal += await walkItem(childFull, childRel, files, emptyDirs);
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
      const stat = await fs.promises.stat(resolved);
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
