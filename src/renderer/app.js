// PrimeDesk Core Engine
// Author: Basliel Getu

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

class PrimeDeskApp {
  constructor() {
    this.ws = null;
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.role = null; // 'host' | 'viewer'
    this.myCode = this.generateCode();
    this.signalingUrl = localStorage.getItem('primedesk_signaling_url') || 'ws://localhost:9000';
    this.isHosting = false;
    this.remoteHostResolution = { width: 1920, height: 1080 };

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
      remoteViewport: document.getElementById('remoteViewport'),
      remoteVideo: document.getElementById('remoteVideo'),
      remoteSessionTitle: document.getElementById('remoteSessionTitle'),
      fullscreenBtn: document.getElementById('fullscreenBtn'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      remoteStats: document.getElementById('remoteStats')
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
        // If we were hosting, re-register
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
        console.log('[Host] Remote technician connected. Initializing stream...');
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
      this.dom.hostStatusPill.innerHTML = '<span class="dot"></span> Status: Connected to Support Technician';

      // 1. Capture Screen
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

      // 2. Setup WebRTC PeerConnection
      this.peerConnection = new RTCPeerConnection(ICE_SERVERS);

      // Add screen tracks
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      // Create DataChannel for receiving remote input
      this.dataChannel = this.peerConnection.createDataChannel('input', { ordered: true });
      this.setupHostDataChannel(this.dataChannel);

      // Handle ICE Candidates
      this.peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
          this.sendSignal({ candidate: e.candidate });
        }
      };

      // 3. Create Offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      // Also send local screen resolution so viewer can accurately map coordinates
      const screenSize = await window.primeDeskAPI.getScreenSize();
      this.sendSignal({ sdp: this.peerConnection.localDescription, screenSize });

    } catch (err) {
      console.error('[Host] Failed to capture screen:', err);
      alert('Could not capture desktop screen: ' + err.message);
      this.stopHosting();
    }
  }

  setupHostDataChannel(dc) {
    dc.onopen = () => console.log('[Host] Input DataChannel Open');
    dc.onmessage = (event) => {
      // Execute command directly via native Windows worker
      if (window.primeDeskAPI && event.data) {
        window.primeDeskAPI.sendInput(event.data);
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
    };

    // Listen for data channel created by host
    this.peerConnection.ondatachannel = (e) => {
      this.dataChannel = e.channel;
      this.dataChannel.onopen = () => console.log('[Viewer] DataChannel to Host is Open');
    };

    // Send join request to signaling server
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'join-session', code }));
    } else {
      alert('Signaling server is not connected!');
    }
  }

  async handlePeerSignal(data) {
    if (data.screenSize) {
      this.remoteHostResolution = data.screenSize;
      console.log('[Viewer] Remote resolution:', this.remoteHostResolution);
    }

    if (data.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // If we are viewer and received an offer, reply with an answer
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

      // Scale to remote desktop resolution
      const scaleX = this.remoteHostResolution.width / rect.width;
      const scaleY = this.remoteHostResolution.height / rect.height;

      const x = Math.round(clickX * scaleX);
      const y = Math.round(clickY * scaleY);
      return { x, y };
    };

    video.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - lastMoveTime < 16) return; // Cap at ~60fps input updates
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
      // Invert delta for standard scroll direction
      const delta = Math.round(-e.deltaY);
      this.sendInputCommand(`W ${delta}`);
    });

    // Keystroke capture when remote viewport is active
    window.addEventListener('keydown', (e) => {
      if (this.dom.remoteViewport.style.display !== 'none') {
        const vk = this.mapKeyCodeToVK(e.keyCode);
        if (vk) {
          this.sendInputCommand(`KD ${vk}`);
          // Prevent browser defaults like Tab or F5 during remote session
          if (['Tab', 'F5', 'Alt'].includes(e.key)) e.preventDefault();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (this.dom.remoteViewport.style.display !== 'none') {
        const vk = this.mapKeyCodeToVK(e.keyCode);
        if (vk) {
          this.sendInputCommand(`KU ${vk}`);
        }
      }
    });
  }

  sendInputCommand(cmd) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(cmd);
    }
  }

  mapKeyCodeToVK(keyCode) {
    // Direct JavaScript keyCode to Windows VK mapping
    return keyCode;
  }

  endSession() {
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
