const { app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class InputHandler {
  constructor() {
    this.process = null;
    this.isReady = false;
    this.active = false;
    this.statusCallback = null;
    this.pendingCommands = [];
  }

  setStatusCallback(cb) {
    this.statusCallback = typeof cb === 'function' ? cb : null;
  }

  start() {
    this.stop();
    this.active = true;
    let exePath = path.join(__dirname, '..', 'native', 'PrimeInput.exe');
    if (app && app.isPackaged) {
      exePath = path.join(process.resourcesPath, 'native', 'PrimeInput.exe');
    }
    if (!fs.existsSync(exePath)) {
      const fallbackPath = path.join(__dirname, '..', 'native', 'PrimeInput.exe');
      if (fs.existsSync(fallbackPath)) {
        exePath = fallbackPath;
      }
    }

    try {
      const child = spawn(exePath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.process = child;

      let outBuf = '';
      child.stdout.on('data', (data) => {
        if (this.process !== child) return;
        outBuf += data.toString();
        let idx;
        while ((idx = outBuf.indexOf('\n')) !== -1) {
          const line = outBuf.slice(0, idx).trim();
          outBuf = outBuf.slice(idx + 1);
          if (!line) continue;
          if (line.includes('PRIMEDESK_INPUT_READY')) {
            this.isReady = true;
            console.log('[PrimeInput] Native input worker ready');
            while (this.pendingCommands.length > 0 && child.stdin && child.stdin.writable) {
              const queued = this.pendingCommands.shift();
              try { child.stdin.write(queued + '\n'); } catch (e) { break; }
            }
          } else if (line.startsWith('PRIMEDESK_INPUT_BLOCKED')) {
            const reason = line.split(' ')[1] || 'UIPI';
            if (this.statusCallback) {
              this.statusCallback({ blocked: true, reason });
            }
          }
        }
      });

      child.on('close', (code) => {
        if (this.process === child) {
          this.process = null;
          this.isReady = false;
        }
        console.log(`[PrimeInput] Native input worker exited with code ${code}`);
      });

      child.on('error', (err) => {
        if (this.process === child) {
          this.process = null;
          this.isReady = false;
        }
        console.error('[PrimeInput] Failed to start native input worker:', err);
      });
    } catch (e) {
      console.error('[PrimeInput] Exception starting input worker:', e);
    }
  }

  send(command) {
    const clean = String(command || '').trim();
    if (!clean) return;
    if (!this.process || !this.process.stdin || !this.process.stdin.writable) {
      if (!this.active) return;
      if (this.pendingCommands.length < 32) {
        this.pendingCommands.push(clean);
      }
      this.start();
      return;
    }
    try {
      this.process.stdin.write(clean + '\n');
    } catch (e) {}
  }

  stop() {
    this.active = false;
    this.pendingCommands = [];
    if (this.process) {
      const target = this.process;
      this.process = null;
      this.isReady = false;
      try {
        if (target.stdin && target.stdin.writable) {
          target.stdin.write('QUIT\n');
        }
        target.kill();
      } catch (e) {}
    }
  }
}

module.exports = new InputHandler();
