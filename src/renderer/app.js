// PrimeDesk Core Engine: Enterprise Remote Desktop Suite
// Features: Auto-Ready, AnyDesk-style Incoming Accept/Decline, Unattended Password,
// Clipboard Sync, P2P File Transfer, Support Chat, Special Keys & Privacy Blackout.
// Author: Basliel Getu

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

const CHUNK_SIZE = 32 * 1024; // 32KB per file transfer chunk
const DEFAULT_CLOUD_SIGNALING_URL = 'wss://primedesk-signal.onrender.com';

class PrimeDeskApp {
  constructor() {
    this.ws = null;
    this.peerConnection = null;
    this.inputChannel = null;
    this.chatChannel = null;
    this.fileChannel = null;
    this.clipboardChannel = null;
    this.localStream = null;
    this.role = null; // 'host' | 'viewer'
    this.myCode = this.generateCode();
    this.remoteHostResolution = { width: 1920, height: 1080 };

    // Enterprise Preferences State
    this.autoStart = false;
    this.closeAction = localStorage.getItem('primedesk_close_action') || 'tray';
    this.preventSleep = localStorage.getItem('primedesk_prevent_sleep') !== 'false';

    this.serverMode = localStorage.getItem('primedesk_server_mode') || 'cloud';
    const savedUrl = localStorage.getItem('primedesk_signaling_url');
    if (!savedUrl || savedUrl === 'ws://localhost:9000') {
      this.signalingUrl = DEFAULT_CLOUD_SIGNALING_URL;
      localStorage.setItem('primedesk_signaling_url', this.signalingUrl);
    } else {
      this.signalingUrl = savedUrl;
    }
    this.stunServer = localStorage.getItem('primedesk_stun_server') || 'stun:stun.l.google.com:19302';

    this.proxyMode = localStorage.getItem('primedesk_proxy_mode') || 'direct';
    this.proxyServer = localStorage.getItem('primedesk_proxy_server') || '';
    this.proxyBypass = localStorage.getItem('primedesk_proxy_bypass') || '<local>;127.0.0.1;localhost';

    this.targetFps = parseInt(localStorage.getItem('primedesk_target_fps') || '30', 10);
    this.qualityProfile = localStorage.getItem('primedesk_quality_profile') || 'balanced';
    this.hwAccel = localStorage.getItem('primedesk_hw_accel') !== 'false';

    this.audioEnabled = localStorage.getItem('primedesk_audio_enabled') !== 'false';
    this.muteHostSpeakers = localStorage.getItem('primedesk_mute_host_speakers') === 'true';

    this.permControl = localStorage.getItem('primedesk_perm_control') !== 'false';
    this.permClipboard = localStorage.getItem('primedesk_perm_clipboard') !== 'false';
    this.permFile = localStorage.getItem('primedesk_perm_file') !== 'false';
    this.permPrivacy = localStorage.getItem('primedesk_perm_privacy') !== 'false';
    this.autoLock = localStorage.getItem('primedesk_auto_lock') !== 'false';

    this.autoRecord = localStorage.getItem('primedesk_auto_record') === 'true';
    this.recordingDir = localStorage.getItem('primedesk_recording_dir') || '';
    this.auditLog = localStorage.getItem('primedesk_audit_log') !== 'false';

    // Session Recording State
    this.mediaRecorder = null;
    this.recordedChunks = [];

    // In-Session Features State
    this.unreadChatCount = 0;
    this.incomingFile = null;
    this.pingInterval = null;
    this.clipboardPollInterval = null;
    this.lastCopiedText = '';
    this.privacyModeActive = false;

    // Unattended Access State
    this.unattendedEnabled = localStorage.getItem('primedesk_unattended_enabled') === 'true';
    this.unattendedPassHash = localStorage.getItem('primedesk_unattended_hash') || '';
    this.pendingConnectCode = null;
    this.savedPass = null;

    // Address Book
    this.addressBook = JSON.parse(localStorage.getItem('primedesk_address_book') || '[]');

    this.initDOMElements();
    this.bindEvents();
    this.renderAddressBook();
    this.applyProxySettings();
    this.initSystemSettings();
    this.connectSignaling();
  }

  async applyProxySettings() {
    if (!window.primeDeskAPI || !window.primeDeskAPI.setNetworkProxy) return;
    let rules = null;
    if (this.proxyMode === 'manual' && this.proxyServer.trim()) {
      rules = `http=${this.proxyServer.trim()};https=${this.proxyServer.trim()}`;
    }
    await window.primeDeskAPI.setNetworkProxy({
      mode: this.proxyMode,
      rules
    });
  }

  async initSystemSettings() {
    if (window.primeDeskAPI) {
      if (window.primeDeskAPI.getAutoStart) {
        this.autoStart = await window.primeDeskAPI.getAutoStart();
        if (this.dom.autoStartToggle) this.dom.autoStartToggle.checked = this.autoStart;
      }
      if (!this.recordingDir && window.primeDeskAPI.getDefaultRecordingsDir) {
        this.recordingDir = await window.primeDeskAPI.getDefaultRecordingsDir();
        if (this.dom.recordingDirInput) this.dom.recordingDirInput.value = this.recordingDir;
      }
    }
  }

  startSessionRecording(stream) {
    if (!stream || this.mediaRecorder) return;
    try {
      this.recordedChunks = [];
      const mimeType = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9'))
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      this.mediaRecorder = new MediaRecorder(stream, { mimeType });
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.mediaRecorder.onstop = async () => {
        if (this.recordedChunks.length === 0) return;
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const filename = `PrimeDesk_${this.role === 'host' ? 'Host' : 'Viewer'}_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        if (window.primeDeskAPI && window.primeDeskAPI.saveRecording) {
          const res = await window.primeDeskAPI.saveRecording({
            buffer: arrayBuffer,
            filename,
            directory: this.recordingDir
          });
          if (res && res.success) {
            console.log('[Recording] Session video saved successfully:', res.path);
          }
        }
        this.recordedChunks = [];
      };
      this.mediaRecorder.start(2000);
      console.log('[Recording] Session recording active');
    } catch (err) {
      console.warn('[Recording] Unable to initialize MediaRecorder:', err);
    }
  }

  stopSessionRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
    this.mediaRecorder = null;
  }

  appendAuditLog(action, details = {}) {
    if (!this.auditLog) return;
    try {
      const logs = JSON.parse(localStorage.getItem('primedesk_audit_logs') || '[]');
      logs.push({
        time: new Date().toISOString(),
        action,
        role: this.role,
        target: this.pendingConnectCode || this.myCode,
        details
      });
      if (logs.length > 250) logs.shift();
      localStorage.setItem('primedesk_audit_logs', JSON.stringify(logs));
    } catch (e) {}
  }

  getIceServers() {
    if (this.serverMode === 'lan' || !this.stunServer.trim()) {
      return { iceServers: [] };
    }
    return {
      iceServers: [
        { urls: this.stunServer.trim() }
      ]
    };
  }

  generateCode() {
    const num = Math.floor(100000 + Math.random() * 900000);
    return num.toString();
  }

  formatCode(code) {
    if (!code || code.length !== 6) return code;
    return `${code.slice(0, 3)} ${code.slice(3)}`;
  }

  async hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + "_primedesk_salt");
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
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
      settingsNavItems: document.querySelectorAll('.settings-nav-item'),
      settingsSections: document.querySelectorAll('.settings-section'),

      // Enterprise General
      autoStartToggle: document.getElementById('autoStartToggle'),
      closeActionSelect: document.getElementById('closeActionSelect'),
      preventSleepToggle: document.getElementById('preventSleepToggle'),

      // Enterprise Network & Proxy
      modeCloud: document.getElementById('modeCloud'),
      modeLan: document.getElementById('modeLan'),
      detectLocalIpBtn: document.getElementById('detectLocalIpBtn'),
      stunInput: document.getElementById('stunInput'),
      proxyModeSelect: document.getElementById('proxyModeSelect'),
      manualProxyHostRow: document.getElementById('manualProxyHostRow'),
      manualProxyBypassRow: document.getElementById('manualProxyBypassRow'),
      proxyServerInput: document.getElementById('proxyServerInput'),
      proxyBypassInput: document.getElementById('proxyBypassInput'),

      // Enterprise Display & Audio
      targetFpsSelect: document.getElementById('targetFpsSelect'),
      qualityProfileSelect: document.getElementById('qualityProfileSelect'),
      hwAccelToggle: document.getElementById('hwAccelToggle'),
      audioEnabledToggle: document.getElementById('audioEnabledToggle'),
      muteHostSpeakersToggle: document.getElementById('muteHostSpeakersToggle'),

      // Enterprise Security
      unattendedToggleSettings: document.getElementById('unattendedToggleSettings'),
      unattendedPassRowSettings: document.getElementById('unattendedPassRowSettings'),
      unattendedPasswordInputSettings: document.getElementById('unattendedPasswordInputSettings'),
      saveUnattendedPassSettingsBtn: document.getElementById('saveUnattendedPassSettingsBtn'),
      permControlToggle: document.getElementById('permControlToggle'),
      permClipboardToggle: document.getElementById('permClipboardToggle'),
      permFileToggle: document.getElementById('permFileToggle'),
      permPrivacyToggle: document.getElementById('permPrivacyToggle'),
      autoLockToggle: document.getElementById('autoLockToggle'),

      // Enterprise Recording & Audit
      autoRecordToggle: document.getElementById('autoRecordToggle'),
      recordingDirInput: document.getElementById('recordingDirInput'),
      browseRecordingDirBtn: document.getElementById('browseRecordingDirBtn'),
      auditLogToggle: document.getElementById('auditLogToggle'),

      // Navigation
      tabSupportBtn: document.getElementById('tabSupportBtn'),
      tabAddressBookBtn: document.getElementById('tabAddressBookBtn'),
      addressBookCount: document.getElementById('addressBookCount'),
      dashboardView: document.getElementById('dashboardView'),
      addressBookView: document.getElementById('addressBookView'),
      
      // Host side
      mySessionCode: document.getElementById('mySessionCode'),
      copyCodeBtn: document.getElementById('copyCodeBtn'),
      unattendedToggle: document.getElementById('unattendedToggle'),
      unattendedInputBox: document.getElementById('unattendedInputBox'),
      unattendedPasswordInput: document.getElementById('unattendedPasswordInput'),
      saveUnattendedPassBtn: document.getElementById('saveUnattendedPassBtn'),

      // Viewer side
      remoteCodeInput: document.getElementById('remoteCodeInput'),
      connectBtn: document.getElementById('connectBtn'),

      // Address Book DOM
      addHospitalBtn: document.getElementById('addHospitalBtn'),
      hospitalCardsGrid: document.getElementById('hospitalCardsGrid'),
      emptyAddressBook: document.getElementById('emptyAddressBook'),
      addHospitalModal: document.getElementById('addHospitalModal'),
      closeAddHospitalBtn: document.getElementById('closeAddHospitalBtn'),
      cancelAddHospitalBtn: document.getElementById('cancelAddHospitalBtn'),
      saveHospitalBtn: document.getElementById('saveHospitalBtn'),
      hospitalNameInput: document.getElementById('hospitalNameInput'),
      hospitalCodeInput: document.getElementById('hospitalCodeInput'),
      hospitalPasswordInput: document.getElementById('hospitalPasswordInput'),

      // Incoming Request Modal
      incomingModal: document.getElementById('incomingModal'),
      incomingCallerText: document.getElementById('incomingCallerText'),
      acceptBtn: document.getElementById('acceptBtn'),
      declineBtn: document.getElementById('declineBtn'),

      // Password Prompt Modal
      passwordPromptModal: document.getElementById('passwordPromptModal'),
      closePassPromptBtn: document.getElementById('closePassPromptBtn'),
      cancelPassPromptBtn: document.getElementById('cancelPassPromptBtn'),
      submitPassPromptBtn: document.getElementById('submitPassPromptBtn'),
      targetUnattendedPassInput: document.getElementById('targetUnattendedPassInput'),

      // Floating pill
      floatingPillView: document.getElementById('floatingPillView'),
      pillStopBtn: document.getElementById('pillStopBtn'),
      pillChatBtn: document.getElementById('pillChatBtn'),
      pillChatBadge: document.getElementById('pillChatBadge'),

      // Remote Viewport
      remoteViewport: document.getElementById('remoteViewport'),
      remoteVideo: document.getElementById('remoteVideo'),
      remoteSessionTitle: document.getElementById('remoteSessionTitle'),
      fitScreenBtn: document.getElementById('fitScreenBtn'),
      fitBtnText: document.getElementById('fitBtnText'),
      transferFileBtn: document.getElementById('transferFileBtn'),
      filePicker: document.getElementById('filePicker'),
      toggleChatBtn: document.getElementById('toggleChatBtn'),
      chatBadge: document.getElementById('chatBadge'),
      fullscreenBtn: document.getElementById('fullscreenBtn'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      remoteStats: document.getElementById('remoteStats'),
      specialKeysBtn: document.getElementById('specialKeysBtn'),
      specialKeysMenu: document.getElementById('specialKeysMenu'),
      keyTaskMgrBtn: document.getElementById('keyTaskMgrBtn'),
      keyDesktopBtn: document.getElementById('keyDesktopBtn'),
      keyLockBtn: document.getElementById('keyLockBtn'),
      privacyToggleBtn: document.getElementById('privacyToggleBtn'),
      privacyBtnText: document.getElementById('privacyBtnText'),

      // Chat
      chatDrawer: document.getElementById('chatDrawer'),
      closeChatBtn: document.getElementById('closeChatBtn'),
      chatMessages: document.getElementById('chatMessages'),
      chatInput: document.getElementById('chatInput'),
      sendChatBtn: document.getElementById('sendChatBtn'),

      // File transfer toast
      transferToast: document.getElementById('transferToast'),
      toastFileName: document.getElementById('toastFileName'),
      toastPercent: document.getElementById('toastPercent'),
      toastProgressBar: document.getElementById('toastProgressBar')
    };

    this.dom.mySessionCode.textContent = this.formatCode(this.myCode);
    this.dom.unattendedToggle.checked = this.unattendedEnabled;
    if (this.unattendedEnabled) {
      this.dom.unattendedInputBox.style.display = 'flex';
      this.dom.unattendedPasswordInput.placeholder = '•••••• (Password active)';
    }

    this.syncSettingsToUI();
  }

  syncSettingsToUI() {
    if (this.dom.autoStartToggle) this.dom.autoStartToggle.checked = this.autoStart;
    if (this.dom.closeActionSelect) this.dom.closeActionSelect.value = this.closeAction;
    if (this.dom.preventSleepToggle) this.dom.preventSleepToggle.checked = this.preventSleep;

    if (this.serverMode === 'lan') {
      if (this.dom.modeLan) this.dom.modeLan.checked = true;
      if (this.dom.stunInput) {
        this.dom.stunInput.disabled = true;
        this.dom.stunInput.style.opacity = '0.5';
      }
    } else {
      if (this.dom.modeCloud) this.dom.modeCloud.checked = true;
      if (this.dom.stunInput) {
        this.dom.stunInput.disabled = false;
        this.dom.stunInput.style.opacity = '1';
      }
    }

    if (this.dom.signalingUrlInput) this.dom.signalingUrlInput.value = this.signalingUrl;
    if (this.dom.stunInput) this.dom.stunInput.value = this.stunServer;

    if (this.dom.proxyModeSelect) this.dom.proxyModeSelect.value = this.proxyMode;
    if (this.dom.proxyServerInput) this.dom.proxyServerInput.value = this.proxyServer;
    if (this.dom.proxyBypassInput) this.dom.proxyBypassInput.value = this.proxyBypass;
    const isManual = this.proxyMode === 'manual';
    if (this.dom.manualProxyHostRow) this.dom.manualProxyHostRow.style.display = isManual ? 'flex' : 'none';
    if (this.dom.manualProxyBypassRow) this.dom.manualProxyBypassRow.style.display = isManual ? 'flex' : 'none';

    if (this.dom.targetFpsSelect) this.dom.targetFpsSelect.value = String(this.targetFps);
    if (this.dom.qualityProfileSelect) this.dom.qualityProfileSelect.value = this.qualityProfile;
    if (this.dom.hwAccelToggle) this.dom.hwAccelToggle.checked = this.hwAccel;

    if (this.dom.audioEnabledToggle) this.dom.audioEnabledToggle.checked = this.audioEnabled;
    if (this.dom.muteHostSpeakersToggle) this.dom.muteHostSpeakersToggle.checked = this.muteHostSpeakers;

    if (this.dom.unattendedToggleSettings) this.dom.unattendedToggleSettings.checked = this.unattendedEnabled;
    if (this.dom.unattendedPassRowSettings) this.dom.unattendedPassRowSettings.style.display = this.unattendedEnabled ? 'flex' : 'none';

    if (this.dom.permControlToggle) this.dom.permControlToggle.checked = this.permControl;
    if (this.dom.permClipboardToggle) this.dom.permClipboardToggle.checked = this.permClipboard;
    if (this.dom.permFileToggle) this.dom.permFileToggle.checked = this.permFile;
    if (this.dom.permPrivacyToggle) this.dom.permPrivacyToggle.checked = this.permPrivacy;
    if (this.dom.autoLockToggle) this.dom.autoLockToggle.checked = this.autoLock;

    if (this.dom.autoRecordToggle) this.dom.autoRecordToggle.checked = this.autoRecord;
    if (this.dom.recordingDirInput) this.dom.recordingDirInput.value = this.recordingDir;
    if (this.dom.auditLogToggle) this.dom.auditLogToggle.checked = this.auditLog;
  }

  bindEvents() {
    // Tab switching
    this.dom.tabSupportBtn.addEventListener('click', () => {
      this.dom.tabSupportBtn.classList.add('active');
      this.dom.tabAddressBookBtn.classList.remove('active');
      this.dom.dashboardView.style.display = 'flex';
      this.dom.addressBookView.style.display = 'none';
    });

    this.dom.tabAddressBookBtn.addEventListener('click', () => {
      this.dom.tabAddressBookBtn.classList.add('active');
      this.dom.tabSupportBtn.classList.remove('active');
      this.dom.dashboardView.style.display = 'none';
      this.dom.addressBookView.style.display = 'flex';
    });

    // Unattended access toggle
    this.dom.unattendedToggle.addEventListener('change', (e) => {
      this.unattendedEnabled = e.target.checked;
      localStorage.setItem('primedesk_unattended_enabled', this.unattendedEnabled);
      this.dom.unattendedInputBox.style.display = this.unattendedEnabled ? 'flex' : 'none';
      if (!this.unattendedEnabled) {
        this.unattendedPassHash = '';
        localStorage.removeItem('primedesk_unattended_hash');
      }
    });

    this.dom.saveUnattendedPassBtn.addEventListener('click', async () => {
      const pass = this.dom.unattendedPasswordInput.value.trim();
      if (!pass) {
        alert('Please enter an unattended master password.');
        return;
      }
      this.unattendedPassHash = await this.hashPassword(pass);
      localStorage.setItem('primedesk_unattended_hash', this.unattendedPassHash);
      alert('Unattended access password saved.');
      this.dom.unattendedPasswordInput.value = '';
      this.dom.unattendedPasswordInput.placeholder = '•••••• (Password active)';
    });

    // Copy code button
    this.dom.copyCodeBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.myCode);
      const originalText = this.dom.copyCodeBtn.innerHTML;
      this.dom.copyCodeBtn.textContent = 'Copied!';
      setTimeout(() => { this.dom.copyCodeBtn.innerHTML = originalText; }, 1500);
    });

    // Incoming Request Accept / Decline
    this.dom.acceptBtn.addEventListener('click', () => {
      this.dom.incomingModal.style.display = 'none';
      this.role = 'host';
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'accept-connection' }));
      }
      this.initiateHostStream();
    });

    this.dom.declineBtn.addEventListener('click', () => {
      this.dom.incomingModal.style.display = 'none';
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'decline-connection', reason: 'Declined by hospital operator' }));
      }
    });

    // Hospital Floating Pill Stop
    this.dom.pillStopBtn.addEventListener('click', () => this.stopHosting());

    // Connect Button
    this.dom.connectBtn.addEventListener('click', () => {
      const code = this.dom.remoteCodeInput.value.replace(/\D/g, '');
      if (code.length !== 6) {
        alert('Please enter a valid 6-digit terminal address.');
        return;
      }
      this.requestConnection(code);
    });

    // Format input as XXX-XXX
    this.dom.remoteCodeInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/\D/g, '');
      if (val.length > 3) {
        val = `${val.slice(0, 3)}-${val.slice(3, 6)}`;
      }
      e.target.value = val;
    });

    // Settings Navigation Tabs
    if (this.dom.settingsNavItems) {
      this.dom.settingsNavItems.forEach(btn => {
        btn.addEventListener('click', () => {
          this.dom.settingsNavItems.forEach(b => b.classList.remove('active'));
          this.dom.settingsSections.forEach(s => s.classList.remove('active'));
          btn.classList.add('active');
          const targetSection = document.getElementById(`sec-${btn.dataset.section}`);
          if (targetSection) targetSection.classList.add('active');
        });
      });
    }

    // Server Mode Radio toggles
    if (this.dom.modeCloud) {
      this.dom.modeCloud.addEventListener('change', () => {
        if (this.dom.stunInput) {
          this.dom.stunInput.disabled = false;
          this.dom.stunInput.style.opacity = '1';
        }
        if (this.dom.signalingUrlInput && (this.dom.signalingUrlInput.value.includes('localhost') || this.dom.signalingUrlInput.value.includes('192.168.'))) {
          this.dom.signalingUrlInput.value = DEFAULT_CLOUD_SIGNALING_URL;
        }
      });
    }

    if (this.dom.modeLan) {
      this.dom.modeLan.addEventListener('change', () => {
        if (this.dom.stunInput) {
          this.dom.stunInput.disabled = true;
          this.dom.stunInput.style.opacity = '0.5';
        }
        if (this.dom.signalingUrlInput && this.dom.signalingUrlInput.value.includes('onrender.com')) {
          this.dom.signalingUrlInput.value = 'ws://localhost:9000';
        }
      });
    }

    // Detect LAN IP Button
    if (this.dom.detectLocalIpBtn) {
      this.dom.detectLocalIpBtn.addEventListener('click', async () => {
        if (!window.primeDeskAPI || !window.primeDeskAPI.getLocalIPs) {
          alert('Local IP detection is only available in the PrimeDesk desktop environment.');
          return;
        }
        try {
          const originalText = this.dom.detectLocalIpBtn.textContent;
          this.dom.detectLocalIpBtn.textContent = 'Detecting...';
          const ifaces = await window.primeDeskAPI.getLocalIPs();
          if (ifaces && ifaces.length > 0) {
            const preferred = ifaces.find(i => /wi-fi|wlan|ethernet/i.test(i.name)) || ifaces[0];
            this.dom.signalingUrlInput.value = `ws://${preferred.address}:9000`;
            this.dom.detectLocalIpBtn.textContent = `Found: ${preferred.address}`;
            setTimeout(() => {
              this.dom.detectLocalIpBtn.textContent = originalText;
            }, 3000);
          } else {
            this.dom.detectLocalIpBtn.textContent = 'No LAN adapter found';
            setTimeout(() => {
              this.dom.detectLocalIpBtn.textContent = originalText;
            }, 3000);
          }
        } catch (err) {
          console.error('Failed to detect LAN IPs:', err);
          this.dom.detectLocalIpBtn.textContent = 'Detection failed';
        }
      });
    }

    // Proxy Mode Select
    if (this.dom.proxyModeSelect) {
      this.dom.proxyModeSelect.addEventListener('change', (e) => {
        const isManual = e.target.value === 'manual';
        if (this.dom.manualProxyHostRow) this.dom.manualProxyHostRow.style.display = isManual ? 'flex' : 'none';
        if (this.dom.manualProxyBypassRow) this.dom.manualProxyBypassRow.style.display = isManual ? 'flex' : 'none';
      });
    }

    // Unattended Toggle inside Settings
    if (this.dom.unattendedToggleSettings) {
      this.dom.unattendedToggleSettings.addEventListener('change', (e) => {
        this.unattendedEnabled = e.target.checked;
        this.dom.unattendedToggle.checked = this.unattendedEnabled;
        this.dom.unattendedInputBox.style.display = this.unattendedEnabled ? 'flex' : 'none';
        if (this.dom.unattendedPassRowSettings) {
          this.dom.unattendedPassRowSettings.style.display = this.unattendedEnabled ? 'flex' : 'none';
        }
        localStorage.setItem('primedesk_unattended_enabled', this.unattendedEnabled);
        if (!this.unattendedEnabled) {
          this.unattendedPassHash = '';
          localStorage.removeItem('primedesk_unattended_hash');
        }
      });
    }

    // Set Unattended Password inside Settings
    if (this.dom.saveUnattendedPassSettingsBtn) {
      this.dom.saveUnattendedPassSettingsBtn.addEventListener('click', async () => {
        const pass = this.dom.unattendedPasswordInputSettings.value.trim();
        if (!pass) {
          alert('Please enter an unattended master password.');
          return;
        }
        this.unattendedPassHash = await this.hashPassword(pass);
        localStorage.setItem('primedesk_unattended_hash', this.unattendedPassHash);
        this.dom.saveUnattendedPassSettingsBtn.textContent = 'Saved!';
        setTimeout(() => { this.dom.saveUnattendedPassSettingsBtn.textContent = 'Set Password'; }, 2000);
        this.dom.unattendedPasswordInputSettings.value = '';
        this.dom.unattendedPasswordInputSettings.placeholder = '•••••• (Password active)';
        this.dom.unattendedPasswordInput.placeholder = '•••••• (Password active)';
      });
    }

    // Browse Recording Directory Button
    if (this.dom.browseRecordingDirBtn) {
      this.dom.browseRecordingDirBtn.addEventListener('click', async () => {
        if (window.primeDeskAPI && window.primeDeskAPI.selectDirectory) {
          const selected = await window.primeDeskAPI.selectDirectory(this.recordingDir);
          if (selected) {
            this.recordingDir = selected;
            this.dom.recordingDirInput.value = selected;
          }
        }
      });
    }

    // Settings Modal Open/Close/Save
    this.dom.settingsBtn.addEventListener('click', () => {
      this.syncSettingsToUI();
      this.dom.settingsModal.style.display = 'flex';
    });

    this.dom.closeSettingsBtn.addEventListener('click', () => {
      this.dom.settingsModal.style.display = 'none';
    });

    this.dom.cancelSettingsBtn.addEventListener('click', () => {
      this.dom.settingsModal.style.display = 'none';
    });

    this.dom.saveSettingsBtn.addEventListener('click', async () => {
      // General
      this.autoStart = this.dom.autoStartToggle ? this.dom.autoStartToggle.checked : this.autoStart;
      this.closeAction = this.dom.closeActionSelect ? this.dom.closeActionSelect.value : this.closeAction;
      this.preventSleep = this.dom.preventSleepToggle ? this.dom.preventSleepToggle.checked : this.preventSleep;

      // Network & Proxy
      const newUrl = this.dom.signalingUrlInput ? (this.dom.signalingUrlInput.value.trim() || DEFAULT_CLOUD_SIGNALING_URL) : this.signalingUrl;
      const newStun = this.dom.stunInput ? (this.dom.stunInput.value.trim() || 'stun:stun.l.google.com:19302') : this.stunServer;
      const newMode = (this.dom.modeLan && this.dom.modeLan.checked) ? 'lan' : 'cloud';
      this.proxyMode = this.dom.proxyModeSelect ? this.dom.proxyModeSelect.value : this.proxyMode;
      this.proxyServer = this.dom.proxyServerInput ? this.dom.proxyServerInput.value.trim() : this.proxyServer;
      this.proxyBypass = this.dom.proxyBypassInput ? this.dom.proxyBypassInput.value.trim() : this.proxyBypass;

      // Display & Quality
      this.targetFps = this.dom.targetFpsSelect ? (parseInt(this.dom.targetFpsSelect.value, 10) || 30) : this.targetFps;
      this.qualityProfile = this.dom.qualityProfileSelect ? this.dom.qualityProfileSelect.value : this.qualityProfile;
      this.hwAccel = this.dom.hwAccelToggle ? this.dom.hwAccelToggle.checked : this.hwAccel;

      // Audio
      this.audioEnabled = this.dom.audioEnabledToggle ? this.dom.audioEnabledToggle.checked : this.audioEnabled;
      this.muteHostSpeakers = this.dom.muteHostSpeakersToggle ? this.dom.muteHostSpeakersToggle.checked : this.muteHostSpeakers;

      // Security
      this.permControl = this.dom.permControlToggle ? this.dom.permControlToggle.checked : this.permControl;
      this.permClipboard = this.dom.permClipboardToggle ? this.dom.permClipboardToggle.checked : this.permClipboard;
      this.permFile = this.dom.permFileToggle ? this.dom.permFileToggle.checked : this.permFile;
      this.permPrivacy = this.dom.permPrivacyToggle ? this.dom.permPrivacyToggle.checked : this.permPrivacy;
      this.autoLock = this.dom.autoLockToggle ? this.dom.autoLockToggle.checked : this.autoLock;

      // Recording & Audit
      this.autoRecord = this.dom.autoRecordToggle ? this.dom.autoRecordToggle.checked : this.autoRecord;
      this.recordingDir = this.dom.recordingDirInput ? this.dom.recordingDirInput.value.trim() : this.recordingDir;
      this.auditLog = this.dom.auditLogToggle ? this.dom.auditLogToggle.checked : this.auditLog;

      const urlChanged = (this.signalingUrl !== newUrl);
      this.signalingUrl = newUrl;
      this.stunServer = newStun;
      this.serverMode = newMode;

      // Persist to localStorage
      localStorage.setItem('primedesk_auto_start', this.autoStart);
      localStorage.setItem('primedesk_close_action', this.closeAction);
      localStorage.setItem('primedesk_prevent_sleep', this.preventSleep);

      localStorage.setItem('primedesk_signaling_url', this.signalingUrl);
      localStorage.setItem('primedesk_stun_server', this.stunServer);
      localStorage.setItem('primedesk_server_mode', this.serverMode);
      localStorage.setItem('primedesk_proxy_mode', this.proxyMode);
      localStorage.setItem('primedesk_proxy_server', this.proxyServer);
      localStorage.setItem('primedesk_proxy_bypass', this.proxyBypass);

      localStorage.setItem('primedesk_target_fps', this.targetFps);
      localStorage.setItem('primedesk_quality_profile', this.qualityProfile);
      localStorage.setItem('primedesk_hw_accel', this.hwAccel);

      localStorage.setItem('primedesk_audio_enabled', this.audioEnabled);
      localStorage.setItem('primedesk_mute_host_speakers', this.muteHostSpeakers);

      localStorage.setItem('primedesk_perm_control', this.permControl);
      localStorage.setItem('primedesk_perm_clipboard', this.permClipboard);
      localStorage.setItem('primedesk_perm_file', this.permFile);
      localStorage.setItem('primedesk_perm_privacy', this.permPrivacy);
      localStorage.setItem('primedesk_auto_lock', this.autoLock);

      localStorage.setItem('primedesk_auto_record', this.autoRecord);
      localStorage.setItem('primedesk_recording_dir', this.recordingDir);
      localStorage.setItem('primedesk_audit_log', this.auditLog);

      // Apply Native Windows Systems changes
      if (window.primeDeskAPI && window.primeDeskAPI.setAutoStart) {
        await window.primeDeskAPI.setAutoStart(this.autoStart);
      }
      await this.applyProxySettings();

      this.dom.settingsModal.style.display = 'none';

      if (urlChanged) {
        this.connectSignaling();
      }
    });

    // Address Book Modal
    this.dom.addHospitalBtn.addEventListener('click', () => {
      this.dom.addHospitalModal.style.display = 'flex';
    });
    this.dom.closeAddHospitalBtn.addEventListener('click', () => {
      this.dom.addHospitalModal.style.display = 'none';
    });
    this.dom.cancelAddHospitalBtn.addEventListener('click', () => {
      this.dom.addHospitalModal.style.display = 'none';
    });
    this.dom.saveHospitalBtn.addEventListener('click', async () => {
      const name = this.dom.hospitalNameInput.value.trim();
      const code = this.dom.hospitalCodeInput.value.replace(/\D/g, '');
      const pass = this.dom.hospitalPasswordInput.value.trim();

      if (!name || code.length !== 6) {
        alert('Please specify a valid workstation name and 6-digit address.');
        return;
      }

      this.addressBook.push({
        id: Date.now(),
        name,
        code,
        password: pass ? await this.hashPassword(pass) : ''
      });

      localStorage.setItem('primedesk_address_book', JSON.stringify(this.addressBook));
      this.renderAddressBook();

      this.dom.hospitalNameInput.value = '';
      this.dom.hospitalCodeInput.value = '';
      this.dom.hospitalPasswordInput.value = '';
      this.dom.addHospitalModal.style.display = 'none';
    });

    // Unattended Password Prompt Modal
    this.dom.closePassPromptBtn.addEventListener('click', () => {
      this.dom.passwordPromptModal.style.display = 'none';
    });
    this.dom.cancelPassPromptBtn.addEventListener('click', () => {
      this.dom.passwordPromptModal.style.display = 'none';
    });
    this.dom.submitPassPromptBtn.addEventListener('click', async () => {
      const pass = this.dom.targetUnattendedPassInput.value.trim();
      if (!pass) return;
      const hash = await this.hashPassword(pass);
      this.dom.passwordPromptModal.style.display = 'none';
      this.dom.targetUnattendedPassInput.value = '';

      this.sendSignal({ type: 'auth-response', hash });
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
      this.dom.fitBtnText.textContent = isFit ? '1:1' : 'Fit';
    });

    // Special Keys Dropdown
    this.dom.specialKeysBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShown = this.dom.specialKeysMenu.style.display === 'flex';
      this.dom.specialKeysMenu.style.display = isShown ? 'none' : 'flex';
    });
    document.addEventListener('click', () => {
      this.dom.specialKeysMenu.style.display = 'none';
    });
    this.dom.keyTaskMgrBtn.addEventListener('click', () => this.sendInputCommand('SPECIAL TASKMGR'));
    this.dom.keyDesktopBtn.addEventListener('click', () => this.sendInputCommand('SPECIAL DESKTOP'));
    this.dom.keyLockBtn.addEventListener('click', () => this.sendInputCommand('SPECIAL LOCK'));

    // Privacy Mode Toggle
    this.dom.privacyToggleBtn.addEventListener('click', () => {
      this.privacyModeActive = !this.privacyModeActive;
      this.dom.privacyBtnText.textContent = this.privacyModeActive ? 'Privacy: ON' : 'Privacy: OFF';
      this.dom.privacyToggleBtn.style.color = this.privacyModeActive ? '#10b981' : '#f1f5f9';
      this.sendInputCommand(`PRIVACY ${this.privacyModeActive ? '1' : '0'}`);
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

    this.setupRemoteInputCapture();
  }

  renderAddressBook() {
    this.dom.addressBookCount.textContent = this.addressBook.length;
    this.dom.hospitalCardsGrid.innerHTML = '';

    if (this.addressBook.length === 0) {
      this.dom.emptyAddressBook.style.display = 'block';
      return;
    }

    this.dom.emptyAddressBook.style.display = 'none';
    this.addressBook.forEach(h => {
      const card = document.createElement('div');
      card.className = 'hospital-card';
      card.innerHTML = `
        <div class="hospital-card-top">
          <div>
            <div class="hospital-card-title">${h.name}</div>
            <div class="hospital-card-code">${this.formatCode(h.code)}</div>
          </div>
          <span class="hospital-card-badge">${h.password ? 'Unattended' : 'Interactive'}</span>
        </div>
        <div class="hospital-card-actions">
          <button class="btn btn-connect connect-hospital-btn" data-code="${h.code}" data-pass="${h.password}">
            Connect
          </button>
          <button class="btn-delete-hospital delete-hospital-btn" data-id="${h.id}" title="Remove Workstation">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      `;
      this.dom.hospitalCardsGrid.appendChild(card);
    });

    document.querySelectorAll('.connect-hospital-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        const savedPass = e.currentTarget.getAttribute('data-pass');
        this.requestConnection(code, savedPass);
      });
    });

    document.querySelectorAll('.delete-hospital-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'));
        this.addressBook = this.addressBook.filter(item => item.id !== id);
        localStorage.setItem('primedesk_address_book', JSON.stringify(this.addressBook));
        this.renderAddressBook();
      });
    });
  }

  connectSignaling() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }

    const isCloud = this.signalingUrl.includes('onrender.com') || this.serverMode === 'cloud';
    this.updateServerStatus(false, isCloud ? 'Connecting to Cloud...' : 'Connecting to LAN...');

    try {
      this.ws = new WebSocket(this.signalingUrl);

      this.ws.onopen = () => {
        this.updateServerStatus(true, isCloud ? 'Cloud Online' : 'Signaling: Online');
        // Automatically register terminal address immediately upon opening app!
        this.registerHostOnServer();
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
        this.updateServerStatus(false, isCloud ? 'Connecting to Cloud...' : 'Signaling: Offline');
        setTimeout(() => this.connectSignaling(), 4000);
      };

      this.ws.onerror = () => {
        this.updateServerStatus(false, isCloud ? 'Connecting to Cloud...' : 'Signaling: Error');
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

  registerHostOnServer() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'register-host', code: this.myCode }));
    }
  }

  handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        console.log(`[Terminal] Registered address: ${msg.code}`);
        break;

      case 'incoming-connection':
        console.log('[Host] Incoming connection request received');
        if (this.unattendedEnabled && this.unattendedPassHash) {
          // If unattended access active, check password or request auth
          this.sendSignal({ type: 'auth-required' });
        } else {
          // Show the AnyDesk-style incoming accept/decline prompt!
          this.dom.incomingCallerText.textContent = `${msg.clientName || 'EHR Support Technician'} is requesting remote control.`;
          this.dom.incomingModal.style.display = 'flex';
        }
        break;

      case 'connection-accepted':
        console.log('[Viewer] Hospital accepted connection. Initializing peer...');
        this.startViewerPeer();
        break;

      case 'connection-declined':
        alert(`Session rejected: ${msg.reason || 'Declined by remote hospital'}`);
        this.endSession();
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

  // HOST STREAM IMPLEMENTATION
  async initiateHostStream() {
    try {
      if (window.primeDeskAPI) {
        await window.primeDeskAPI.startInputWorker();
        await window.primeDeskAPI.setPillMode();
      }
      this.dom.appHeader.style.display = 'none';
      this.dom.dashboardView.style.display = 'none';
      this.dom.addressBookView.style.display = 'none';
      this.dom.floatingPillView.style.display = 'flex';

      const sources = await window.primeDeskAPI.getSources();
      const primarySource = sources[0];

      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: this.audioEnabled ? {
          mandatory: {
            chromeMediaSource: 'desktop'
          }
        } : false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: primarySource.id,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080,
            maxFrameRate: this.targetFps || 30
          }
        }
      });

      if (this.autoRecord) {
        this.startSessionRecording(this.localStream);
      }
      this.appendAuditLog('session-started-host');

      this.peerConnection = new RTCPeerConnection(this.getIceServers());

      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      this.inputChannel = this.peerConnection.createDataChannel('input', { ordered: true });
      this.setupHostInputChannel(this.inputChannel);

      this.chatChannel = this.peerConnection.createDataChannel('chat');
      this.setupChatChannel(this.chatChannel);

      this.fileChannel = this.peerConnection.createDataChannel('file');
      this.setupFileChannel(this.fileChannel);

      this.clipboardChannel = this.peerConnection.createDataChannel('clipboard');
      this.setupClipboardChannel(this.clipboardChannel);

      this.peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
          this.sendSignal({ candidate: e.candidate });
        }
      };

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      const screenSize = await window.primeDeskAPI.getScreenSize();
      this.sendSignal({ sdp: this.peerConnection.localDescription, screenSize });

      this.startClipboardPolling();

    } catch (err) {
      console.error('[Host] Failed to initialize stream:', err);
      alert('Could not start screen capture: ' + err.message);
      this.stopHosting();
    }
  }

  setupHostInputChannel(dc) {
    dc.onopen = () => console.log('[Host] Input DataChannel Open');
    dc.onmessage = (event) => {
      if (window.primeDeskAPI && event.data) {
        if (event.data === 'PING') {
          dc.send('PONG');
          return;
        }
        if (event.data.startsWith('PRIVACY')) {
          if (!this.permPrivacy) {
            console.warn('[Host] Privacy mode rejected: Permission disabled in settings');
            return;
          }
          const enabled = event.data.split(' ')[1] === '1';
          window.primeDeskAPI.setPrivacyMode(enabled);
          return;
        }
        if (!this.permControl) {
          // Mouse & keyboard control disallowed in host preferences
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
      if (!this.permFile) {
        if (typeof event.data === 'string') {
          console.warn('[File] File transfer blocked: Permission disabled in settings');
        }
        return;
      }
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

  setupClipboardChannel(dc) {
    dc.onopen = () => console.log('[Clipboard] Sync Channel Open');
    dc.onmessage = async (event) => {
      if (!this.permClipboard) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'clip' && data.text) {
          this.lastCopiedText = data.text;
          if (window.primeDeskAPI) {
            await window.primeDeskAPI.writeClipboard(data.text);
          }
        }
      } catch (e) {}
    };
  }

  startClipboardPolling() {
    this.clipboardPollInterval = setInterval(async () => {
      if (!this.permClipboard) return;
      if (window.primeDeskAPI && this.clipboardChannel && this.clipboardChannel.readyState === 'open') {
        const currentText = await window.primeDeskAPI.readClipboard();
        if (currentText && currentText !== this.lastCopiedText) {
          this.lastCopiedText = currentText;
          this.clipboardChannel.send(JSON.stringify({ type: 'clip', text: currentText }));
        }
      }
    }, 1200);
  }

  stopHosting() {
    this.role = null;
    this.stopSessionRecording();
    this.appendAuditLog('session-ended-host');

    if (this.autoLock && window.primeDeskAPI) {
      console.log('[Security] Auto-locking Windows host workstation...');
      window.primeDeskAPI.sendInput('SPECIAL LOCK');
    }

    if (this.clipboardPollInterval) {
      clearInterval(this.clipboardPollInterval);
      this.clipboardPollInterval = null;
    }

    if (window.primeDeskAPI) {
      window.primeDeskAPI.restoreNormalMode();
      window.primeDeskAPI.setPrivacyMode(false);
      window.primeDeskAPI.stopInputWorker();
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

    // Re-register terminal code to stay ready
    this.registerHostOnServer();
  }

  // VIEWER INITIATION
  requestConnection(code, savedPass = null) {
    this.role = 'viewer';
    this.pendingConnectCode = code;
    this.savedPass = savedPass;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'request-connect',
        code,
        clientName: 'EHR Support Technician'
      }));
    } else {
      alert('Signaling server is not connected!');
    }
  }

  startViewerPeer() {
    this.peerConnection = new RTCPeerConnection(this.getIceServers());

    this.peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal({ candidate: e.candidate });
      }
    };

    this.peerConnection.ontrack = (event) => {
      console.log('[Viewer] Remote video track received');
      this.dom.remoteVideo.srcObject = event.streams[0];
      this.dom.dashboardView.style.display = 'none';
      this.dom.addressBookView.style.display = 'none';
      this.dom.remoteViewport.style.display = 'flex';
      this.dom.remoteSessionTitle.textContent = `Connected: ${this.formatCode(this.pendingConnectCode)}`;

      if (this.autoRecord) {
        this.startSessionRecording(event.streams[0]);
      }
      this.appendAuditLog('session-connected-viewer');

      this.startPingMonitor();
      this.startClipboardPolling();
    };

    this.peerConnection.ondatachannel = (e) => {
      if (e.channel.label === 'input') {
        this.inputChannel = e.channel;
        this.inputChannel.onopen = () => console.log('[Viewer] Input Channel Open');
      } else if (e.channel.label === 'chat') {
        this.chatChannel = e.channel;
        this.setupChatChannel(this.chatChannel);
      } else if (e.channel.label === 'file') {
        this.fileChannel = e.channel;
        this.setupFileChannel(this.fileChannel);
      } else if (e.channel.label === 'clipboard') {
        this.clipboardChannel = e.channel;
        this.setupClipboardChannel(this.clipboardChannel);
      }
    };
  }

  startPingMonitor() {
    let lastPing = performance.now();
    if (this.inputChannel) {
      this.inputChannel.onmessage = (e) => {
        if (e.data === 'PONG') {
          const rtt = Math.round(performance.now() - lastPing);
          this.dom.remoteStats.textContent = `${rtt} ms | ${this.targetFps || 30} FPS`;
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
    if (data.type === 'auth-required') {
      if (this.savedPass) {
        this.sendSignal({ type: 'auth-response', hash: this.savedPass });
      } else {
        this.dom.passwordPromptModal.style.display = 'flex';
      }
      return;
    }

    if (data.type === 'auth-response') {
      if (data.hash === this.unattendedPassHash) {
        console.log('[Host] Unattended access authorized. Starting stream...');
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'accept-connection' }));
        }
        this.initiateHostStream();
      } else {
        alert('Invalid unattended access password.');
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'decline-connection', reason: 'Invalid unattended password' }));
        }
      }
      return;
    }

    if (data.screenSize) {
      this.remoteHostResolution = data.screenSize;
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

  async sendFile(file) {
    if (!this.fileChannel || this.fileChannel.readyState !== 'open') {
      alert('File channel is not open. Connect to hospital first.');
      return;
    }

    this.showTransferToast(`Sending: ${file.name}`, 0);

    this.fileChannel.send(JSON.stringify({
      type: 'file-start',
      name: file.name,
      size: file.size
    }));

    const buffer = await file.arrayBuffer();
    let offset = 0;

    const sendChunk = () => {
      while (offset < buffer.byteLength) {
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
    this.stopSessionRecording();
    this.appendAuditLog('session-ended-viewer');

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.clipboardPollInterval) {
      clearInterval(this.clipboardPollInterval);
      this.clipboardPollInterval = null;
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
