const { spawn } = require('child_process');
const path = require('path');

class InputHandler {
  constructor() {
    this.process = null;
    this.isReady = false;
  }

  start() {
    const exePath = path.join(__dirname, '..', 'native', 'PrimeInput.exe');
    try {
      this.process = spawn(exePath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.stdout.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('PRIMEDESK_INPUT_READY')) {
          this.isReady = true;
          console.log('[PrimeInput] Native input worker ready');
        }
      });

      this.process.on('close', (code) => {
        this.isReady = false;
        console.log(`[PrimeInput] Native input worker exited with code ${code}`);
      });

      this.process.on('error', (err) => {
        console.error('[PrimeInput] Failed to start native input worker:', err);
      });
    } catch (e) {
      console.error('[PrimeInput] Exception starting input worker:', e);
    }
  }

  send(command) {
    if (this.process && this.process.stdin.writable) {
      this.process.stdin.write(command.trim() + '\n');
    }
  }

  stop() {
    if (this.process) {
      try {
        this.send('QUIT');
        this.process.kill();
      } catch (e) {}
      this.process = null;
      this.isReady = false;
    }
  }
}

module.exports = new InputHandler();
