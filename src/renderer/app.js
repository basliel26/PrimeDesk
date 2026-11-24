// PrimeDesk Core Engine with P2P Chat, File Transfer & Floating Pill
// Author: Basliel Getu

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

const CHUNK_SIZE = 32 * 1024; // 32KB per file transfer chunk

class PrimeDeskApp {
  constructor() {
    this.ws = null;
    this.peerConnection = null;
    this.inputChannel = null;
    this.chatChannel = null;
    this.fileChannel = null;
    this.localStream = null;
    this.role = null; // 'host' | 'viewer'
    this.myCode = this.generateCode();
    this.signalingUrl = localStorage.getItem('primedesk_signaling_url') || 'ws://localhost:9000';
    this.isHosting = false;
    this.remoteHostResolution = { width: 1920, height: 1080 };

    // Chat & File Transfer State
    this.unreadChatCount = 0;
    this.incomingFile = null;
    this.pingInterval = null;

    this.initDOMElements();
    this.bindEvents();
    this.connectSignaling();
  }

  generateCode() {
    const num = Math.floor(100000 + Math.random() * 900000);
    return num.toString();
  }

  formatCode(code) {
    if (!code || code.length !== 6) return code;
    return `${code.slice(0, 3)} ${code.slice(3)}`;
  }

  initDOMElements() {
    this.dom = {
      appContainer: document.getElementById('appContainer'),
      appHeader: document.getElementById('appHeader'),
      serverDot: document.getElementById('serverDot'),
      serverStatusText: document.getElementById('serverStatusText'),
      settingsBtn: document.getElementById('settingsBtn'),
      settingsModal: document.getElementById('settingsModal'),
      closeSettingsBtn: document.getElementById('closeSettingsBtn'),
      cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
      saveSettingsBtn: document.getElementById('saveSettingsBtn'),
      signalingUrlInput: document.getElementById('signalingUrlInput'),
      
      mySessionCode: document.getElementById('mySessionCode'),
      copyCodeBtn: document.getElementById('copyCodeBtn'),
      toggleHostBtn: document.getElementById('toggleHostBtn'),
      hostStatusPill: document.getElementById('hostStatusPill'),

      remoteCodeInput: document.getElementById('remoteCodeInput'),
      connectBtn: document.getElementById('connectBtn'),

      dashboardView: document.getElementById('dashboardView'),
      floatingPillView: document.getElementById('floatingPillView'),
      pillStopBtn: document.getElementById('pillStopBtn'),
      pillChatBtn: document.getElementById('pillChatBtn'),
      pillChatBadge: document.getElementById('pillChatBadge'),

      remoteViewport: document.getElementById('remoteViewport'),
      remoteVideo: document.getElementById('remoteVideo'),
      remoteSessionTitle: document.getElementById('remoteSessionTitle'),
      fitScreenBtn: document.getElementById('fitScreenBtn'),
      transferFileBtn: document.getElementById('transferFileBtn'),
      filePicker: document.getElementById('filePicker'),
      toggleChatBtn: document.getElementById('toggleChatBtn'),
      chatBadge: document.getElementById('chatBadge'),
      fullscreenBtn: document.getElementById('fullscreenBtn'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      remoteStats: document.getElementById('remoteStats'),

      chatDrawer: document.getElementById('chatDrawer'),
      closeChatBtn: document.getElementById('closeChatBtn'),
      chatMessages: document.getElementById('chatMessages'),
      chatInput: document.getElementById('chatInput'),
      sendChatBtn: document.getElementById('sendChatBtn'),

      transferToast: document.getElementById('transferToast'),
      toastFileName: document.getElementById('toastFileName'),
      toastPercent: document.getElementById('toastPercent'),
      toastProgressBar: document.getElementById('toastProgressBar')
    };

    this.dom.mySessionCode.textContent = this.formatCode(this.myCode);
    this.dom.signalingUrlInput.value = this.signalingUrl;
  }

  bindEvents() {
    // Copy code button
    this.dom.copyCodeBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.myCode);
      const originalText = this.dom.copyCodeBtn.innerHTML;
      this.dom.copyCodeBtn.textContent = 'Copied!';
      setTimeout(() => { this.dom.copyCodeBtn.innerHTML = originalText; }, 1500);
    });

    // Toggle Host Button
    this.dom.toggleHostBtn.addEventListener('click', () => {
      if (this.isHosting) {
        this.stopHosting();
      } else {
        this.startHosting();
      }
    });

    // Hospital Floating Pill Stop
    this.dom.pillStopBtn.addEventListener('click', () => this.stopHosting());

    // Connect Button
    this.dom.connectBtn.addEventListener('click', () => {
      const code = this.dom.remoteCodeInput.value.replace(/\D/g, '');
      if (code.length !== 6) {
        alert('Please enter a valid 6-digit hospital code.');
        return;
      }
      this.connectToRemote(code);
    });

    // Format input as XXX-XXX
    this.dom.remoteCodeInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/\D/g, '');
      if (val.length > 3) {
        val = `${val.slice(0, 3)}-${val.slice(3, 6)}`;
      }
      e.target.value = val;
    });

    // Settings Modal
    this.dom.settingsBtn.addEventListener('click', () => {
      this.dom.settingsModal.style.display = 'flex';
    });
    this.dom.closeSettingsBtn.addEventListener('click', () => {
      this.dom.settingsModal.style.display = 'none';
    });
    this.dom.cancelSettingsBtn.addEventListener('click', () => {
      this.dom.settingsModal.style.display = 'none';
    });
    this.dom.saveSettingsBtn.addEventListener('click', () => {
      const newUrl = this.dom.signalingUrlInput.value.trim();
      if (newUrl) {
        this.signalingUrl = newUrl;
        localStorage.setItem('primedesk_signaling_url', newUrl);
        this.dom.settingsModal.style.display = 'none';
        this.connectSignaling();
      }
    });

    // Remote Viewport controls
    this.dom.disconnectBtn.addEventListener('click', () => this.endSession());
    this.dom.fullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    });

    // Fit Screen Toggle
    this.dom.fitScreenBtn.addEventListener('click', () => {
      const isFit = this.dom.remoteVideo.classList.toggle('fit-screen');
      this.dom.fitScreenBtn.textContent = isFit ? '⛶ 1:1' : '⛶ Fit';
    });

    // Chat Drawer Toggle
    const toggleChat = () => {
      const isVisible = this.dom.chatDrawer.style.display === 'flex';
      this.dom.chatDrawer.style.display = isVisible ? 'none' : 'flex';
      if (!isVisible) {
        this.unreadChatCount = 0;
        this.updateChatBadge();
        this.dom.chatInput.focus();
      }
    };
    this.dom.toggleChatBtn.addEventListener('click', toggleChat);
    this.dom.pillChatBtn.addEventListener('click', toggleChat);
    this.dom.closeChatBtn.addEventListener('click', () => {
      this.dom.chatDrawer.style.display = 'none';
    });

    // Send Chat
    const sendChat = () => {
      const text = this.dom.chatInput.value.trim();
      if (!text) return;
      this.sendChatMessage(text);
      this.appendChatMessage(text, 'sent');
      this.dom.chatInput.value = '';
    };
    this.dom.sendChatBtn.addEventListener('click', sendChat);
    this.dom.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });

    // File Transfer
    this.dom.transferFileBtn.addEventListener('click', () => {
      this.dom.filePicker.click();
    });
    this.dom.filePicker.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.sendFile(file);
      e.target.value = '';
    });

    // Mouse and Keyboard listener setup on remote video
    this.setupRemoteInputCapture();
  }

  connectSignaling() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }

    this.updateServerStatus(false, 'Connecting...');

    try {
      this.ws = new WebSocket(this.signalingUrl);

      this.ws.onopen = () => {
        this.updateServerStatus(true, 'Signaling: Online');
        if (this.isHosting) {
          this.registerHostOnServer();
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleSignalingMessage(msg);
        } catch (e) {
          console.error('[Signaling] Message error:', e);
        }
      };

      this.ws.onclose = () => {
        this.updateServerStatus(false, 'Signaling: Offline');
        setTimeout(() => this.connectSignaling(), 4000);
      };

      this.ws.onerror = () => {
        this.updateServerStatus(false, 'Signaling: Error');
      };
    } catch (e) {
      this.updateServerStatus(false, 'Signaling: Failed');
    }
  }

  updateServerStatus(connected, text) {
    if (connected) {
      this.dom.serverDot.className = 'status-dot connected';
    } else {
      this.dom.serverDot.className = 'status-dot disconnected';
    }
    this.dom.serverStatusText.textContent = text;
  }

  handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        console.log(`[Host] Successfully registered code: ${msg.code}`);
        break;

      case 'viewer-joined':
        console.log('[Host] Remote technician connected. Initializing stream & pill mode...');
        this.initiateHostStream();
        break;

      case 'signal':
        this.handlePeerSignal(msg.data);
        break;

      case 'session-ended':
        alert(`Session ended: ${msg.reason || 'Disconnected'}`);
        this.endSession();
        break;

      case 'error':
        alert(msg.message);
        break;
    }
  }

  // HOST IMPLEMENTATION
  async startHosting() {
    this.role = 'host';
    this.isHosting = true;
    this.dom.toggleHostBtn.innerHTML = '<span class="btn-icon">■</span> Stop Sharing';
    this.dom.toggleHostBtn.classList.remove('btn-primary');
    this.dom.toggleHostBtn.classList.add('btn-danger');
    this.dom.hostStatusPill.classList.add('active');
    this.dom.hostStatusPill.innerHTML = '<span class="dot"></span> Status: Ready & Waiting for Vendor';

    // Start native input worker
    if (window.primeDeskAPI) {
      await window.primeDeskAPI.startInputWorker();
    }

    this.registerHostOnServer();
  }

  registerHostOnServer() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'register-host', code: this.myCode }));
    }
  }

  async initiateHostStream() {
    try {
      // 1. Enter Floating Pill Mode to hide main dashboard and prevent screen-mirroring
      if (window.primeDeskAPI) {
        await window.primeDeskAPI.setPillMode();
      }
      this.dom.appHeader.style.display = 'none';
      this.dom.dashboardView.style.display = 'none';
      this.dom.floatingPillView.style.display = 'flex';

      // 2. Capture Desktop Screen
      const sources = await window.primeDeskAPI.getSources();
      const primarySource = sources[0];

      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: primarySource.id,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080,
            maxFrameRate: 60
          }
        }
      });

      // 3. Setup WebRTC PeerConnection
      this.peerConnection = new RTCPeerConnection(ICE_SERVERS);

      // Add screen tracks
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      // Create DataChannels
      this.inputChannel = this.peerConnection.createDataChannel('input', { ordered: true });
      this.setupHostInputChannel(this.inputChannel);

      this.chatChannel = this.peerConnection.createDataChannel('chat');
      this.setupChatChannel(this.chatChannel);

      this.fileChannel = this.peerConnection.createDataChannel('file');
      this.setupFileChannel(this.fileChannel);

      // Handle ICE Candidates
      this.peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
          this.sendSignal({ candidate: e.candidate });
        }
      };

      // 4. Create Offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      const screenSize = await window.primeDeskAPI.getScreenSize();
      this.sendSignal({ sdp: this.peerConnection.localDescription, screenSize });

    } catch (err) {
      console.error('[Host] Failed to capture screen:', err);
      alert('Could not capture desktop screen: ' + err.message);
      this.stopHosting();
    }
  }

  setupHostInputChannel(dc) {
    dc.onopen = () => console.log('[Host] Input DataChannel Open');
    dc.onmessage = (event) => {
      // Execute command directly via native Windows worker
      if (window.primeDeskAPI && event.data) {
        if (event.data === 'PING') {
          dc.send('PONG');
          return;
        }
        window.primeDeskAPI.sendInput(event.data);
      }
    };
  }

  setupChatChannel(dc) {
    dc.onopen = () => console.log('[Chat] Channel Ready');
    dc.onmessage = (event) => {
      this.appendChatMessage(event.data, 'received');
      if (this.dom.chatDrawer.style.display !== 'flex') {
        this.unreadChatCount++;
        this.updateChatBadge();
      }
    };
  }

  setupFileChannel(dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => console.log('[File] Channel Ready');
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const meta = JSON.parse(event.data);
        if (meta.type === 'file-start') {
          this.incomingFile = {
            name: meta.name,
            size: meta.size,
            receivedSize: 0,
            chunks: []
          };
          this.showTransferToast(`Receiving: ${meta.name}`, 0);
        }
      } else if (event.data instanceof ArrayBuffer && this.incomingFile) {
        this.incomingFile.chunks.push(event.data);
        this.incomingFile.receivedSize += event.data.byteLength;
        const pct = Math.round((this.incomingFile.receivedSize / this.incomingFile.size) * 100);
        this.updateTransferProgress(pct);

        if (this.incomingFile.receivedSize >= this.incomingFile.size) {
          // File completed, trigger download
          const blob = new Blob(this.incomingFile.chunks);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = this.incomingFile.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          this.showTransferToast(`Received: ${this.incomingFile.name}`, 100);
          setTimeout(() => this.hideTransferToast(), 3000);
          this.incomingFile = null;
        }
      }
    };
  }

  stopHosting() {
    this.isHosting = false;
    this.dom.toggleHostBtn.innerHTML = '<span class="btn-icon">▶</span> Start Sharing Session';
    this.dom.toggleHostBtn.classList.remove('btn-danger');
    this.dom.toggleHostBtn.classList.add('btn-primary');
    this.dom.hostStatusPill.classList.remove('active');
    this.dom.hostStatusPill.innerHTML = '<span class="dot"></span> Status: Standby';

    // Restore normal window
    if (window.primeDeskAPI) {
      window.primeDeskAPI.restoreNormalMode();
    }
    this.dom.floatingPillView.style.display = 'none';
    this.dom.appHeader.style.display = 'flex';
    this.dom.dashboardView.style.display = 'flex';

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'leave' }));
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (window.primeDeskAPI) {
      window.primeDeskAPI.stopInputWorker();
    }
  }

  // VIEWER IMPLEMENTATION
  async connectToRemote(code) {
    this.role = 'viewer';
    console.log(`[Viewer] Connecting to session: ${code}`);

    this.peerConnection = new RTCPeerConnection(ICE_SERVERS);

    this.peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal({ candidate: e.candidate });
      }
    };

    // When remote screen stream arrives
    this.peerConnection.ontrack = (event) => {
      console.log('[Viewer] Remote video track received');
      this.dom.remoteVideo.srcObject = event.streams[0];
      this.dom.dashboardView.style.display = 'none';
      this.dom.remoteViewport.style.display = 'flex';
      this.dom.remoteSessionTitle.textContent = `Connected to Hospital (${this.formatCode(code)})`;

      this.startPingMonitor();
    };

    // Listen for data channels created by host
    this.peerConnection.ondatachannel = (e) => {
      if (e.channel.label === 'input') {
        this.inputChannel = e.channel;
        this.inputChannel.onopen = () => console.log('[Viewer] Input DataChannel Open');
      } else if (e.channel.label === 'chat') {
        this.chatChannel = e.channel;
        this.setupChatChannel(this.chatChannel);
      } else if (e.channel.label === 'file') {
        this.fileChannel = e.channel;
        this.setupFileChannel(this.fileChannel);
      }
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'join-session', code }));
    } else {
      alert('Signaling server is not connected!');
    }
  }

  startPingMonitor() {
    let lastPing = performance.now();
    if (this.inputChannel) {
      this.inputChannel.onmessage = (e) => {
        if (e.data === 'PONG') {
          const rtt = Math.round(performance.now() - lastPing);
          this.dom.remoteStats.textContent = `${rtt} ms | 60 FPS`;
        }
      };
    }

    this.pingInterval = setInterval(() => {
      if (this.inputChannel && this.inputChannel.readyState === 'open') {
        lastPing = performance.now();
        this.inputChannel.send('PING');
      }
    }, 2500);
  }

  async handlePeerSignal(data) {
    if (data.screenSize) {
      this.remoteHostResolution = data.screenSize;
      console.log('[Viewer] Remote resolution:', this.remoteHostResolution);
    }

    if (data.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

      if (data.sdp.type === 'offer') {
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.sendSignal({ sdp: this.peerConnection.localDescription });
      }
    } else if (data.candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.error('[WebRTC] ICE candidate error:', e);
      }
    }
  }

  sendSignal(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', data }));
    }
  }

  // MOUSE & KEYBOARD INPUT CAPTURE (ON VIEWER)
  setupRemoteInputCapture() {
    const video = this.dom.remoteVideo;
    let lastMoveTime = 0;

    const getScaledCoords = (e) => {
      const rect = video.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      const scaleX = this.remoteHostResolution.width / rect.width;
      const scaleY = this.remoteHostResolution.height / rect.height;

      const x = Math.round(clickX * scaleX);
      const y = Math.round(clickY * scaleY);
      return { x, y };
    };

    video.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - lastMoveTime < 16) return;
      lastMoveTime = now;

      const { x, y } = getScaledCoords(e);
      this.sendInputCommand(`M ${x} ${y}`);
    });

    video.addEventListener('mousedown', (e) => {
      const btn = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
      const { x, y } = getScaledCoords(e);
      this.sendInputCommand(`M ${x} ${y}`);
      this.sendInputCommand(`D ${btn}`);
    });

    video.addEventListener('mouseup', (e) => {
      const btn = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
      this.sendInputCommand(`U ${btn}`);
    });

    video.addEventListener('contextmenu', (e) => e.preventDefault());

    video.addEventListener('wheel', (e) => {
      const delta = Math.round(-e.deltaY);
      this.sendInputCommand(`W ${delta}`);
    });

    window.addEventListener('keydown', (e) => {
      if (this.dom.remoteViewport.style.display !== 'none' && document.activeElement !== this.dom.chatInput) {
        this.sendInputCommand(`KD ${e.keyCode}`);
        if (['Tab', 'F5', 'Alt'].includes(e.key)) e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (this.dom.remoteViewport.style.display !== 'none' && document.activeElement !== this.dom.chatInput) {
        this.sendInputCommand(`KU ${e.keyCode}`);
      }
    });
  }

  sendInputCommand(cmd) {
    if (this.inputChannel && this.inputChannel.readyState === 'open') {
      this.inputChannel.send(cmd);
    }
  }

  // CHAT SYSTEM
  sendChatMessage(text) {
    if (this.chatChannel && this.chatChannel.readyState === 'open') {
      this.chatChannel.send(text);
    }
  }

  appendChatMessage(text, type) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${type}`;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    bubble.innerHTML = `${text}<span class="chat-time">${timeStr}</span>`;
    this.dom.chatMessages.appendChild(bubble);
    this.dom.chatMessages.scrollTop = this.dom.chatMessages.scrollHeight;
  }

  updateChatBadge() {
    const text = this.unreadChatCount > 0 ? this.unreadChatCount : '';
    const display = this.unreadChatCount > 0 ? 'inline-block' : 'none';

    this.dom.chatBadge.textContent = text;
    this.dom.chatBadge.style.display = display;
    this.dom.pillChatBadge.textContent = text;
    this.dom.pillChatBadge.style.display = display;
  }

  // FILE TRANSFER SYSTEM
  async sendFile(file) {
    if (!this.fileChannel || this.fileChannel.readyState !== 'open') {
      alert('File channel is not open. Connect to hospital first.');
      return;
    }

    this.showTransferToast(`Sending: ${file.name}`, 0);

    // 1. Send metadata
    this.fileChannel.send(JSON.stringify({
      type: 'file-start',
      name: file.name,
      size: file.size
    }));

    // 2. Stream chunks
    const buffer = await file.arrayBuffer();
    let offset = 0;

    const sendChunk = () => {
      while (offset < buffer.byteLength) {
        // Respect backpressure
        if (this.fileChannel.bufferedAmount > 8 * 1024 * 1024) {
          setTimeout(sendChunk, 50);
          return;
        }

        const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
        this.fileChannel.send(chunk);
        offset += chunk.byteLength;

        const pct = Math.round((offset / buffer.byteLength) * 100);
        this.updateTransferProgress(pct);
      }

      this.showTransferToast(`Sent: ${file.name}`, 100);
      setTimeout(() => this.hideTransferToast(), 3000);
    };

    sendChunk();
  }

  showTransferToast(name, pct) {
    this.dom.toastFileName.textContent = name;
    this.dom.toastPercent.textContent = `${pct}%`;
    this.dom.toastProgressBar.style.width = `${pct}%`;
    this.dom.transferToast.style.display = 'block';
  }

  updateTransferProgress(pct) {
    this.dom.toastPercent.textContent = `${pct}%`;
    this.dom.toastProgressBar.style.width = `${pct}%`;
  }

  hideTransferToast() {
    this.dom.transferToast.style.display = 'none';
  }

  endSession() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.role === 'host') {
      this.stopHosting();
    } else {
      if (this.peerConnection) {
        this.peerConnection.close();
        this.peerConnection = null;
      }
      this.dom.remoteVideo.srcObject = null;
      this.dom.remoteViewport.style.display = 'none';
      this.dom.dashboardView.style.display = 'flex';
      if (document.fullscreenElement) document.exitFullscreen();
    }
  }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  new PrimeDeskApp();
});
