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
    if (this.serverMode === 'cloud' || !savedUrl || savedUrl === 'ws://localhost:9000' || !savedUrl.startsWith('ws')) {
      this.signalingUrl = DEFAULT_CLOUD_SIGNALING_URL;
      localStorage.setItem('primedesk_signaling_url', this.signalingUrl);
    } else {
      this.signalingUrl = savedUrl;
    }
    this.stunServer = localStorage.getItem('primedesk_stun_server') || 'stun:stun.l.google.com:19302';

    let savedProxyMode = localStorage.getItem('primedesk_proxy_mode');
    if (!savedProxyMode) {
      savedProxyMode = 'system';
      localStorage.setItem('primedesk_proxy_mode', 'system');
    } else if (savedProxyMode === 'direct' && !localStorage.getItem('primedesk_proxy_migrated_v1')) {
      savedProxyMode = 'system';
      localStorage.setItem('primedesk_proxy_mode', 'system');
    }
    localStorage.setItem('primedesk_proxy_migrated_v1', 'true');
    this.proxyMode = savedProxyMode;
    this.proxyServer = localStorage.getItem('primedesk_proxy_server') || '';
    this.proxyBypass = localStorage.getItem('primedesk_proxy_bypass') || '<local>;127.0.0.1;localhost';

    this.wsReconnectTimer = null;
    this.wsConnectTimeoutTimer = null;
    this.wsKeepaliveTimer = null;
    this.isConnectingSignaling = false;
    this.lastConnectionDiagnostic = null;

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

    this.init();
  }

  async init() {
    this.initDOMElements();
    this.bindEvents();
    this.renderAddressBook();
    await this.applyProxySettings();
    await this.initSystemSettings();
    this.connectSignaling();
  }

  async applyProxySettings() {
    try {
      if (!window.primeDeskAPI || !window.primeDeskAPI.setNetworkProxy) return;
      let rules = null;
      if (this.proxyMode === 'manual' && this.proxyServer.trim()) {
        const raw = this.proxyServer.trim();
        rules = (raw.includes('=') || /^socks/i.test(raw))
          ? raw
          : raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      }
      await window.primeDeskAPI.setNetworkProxy({
        mode: this.proxyMode,
        rules,
        bypass: this.proxyBypass
      });
    } catch (err) {
      console.warn('[Network] Proxy configuration warning:', err);
    }
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

  getDialogIconSvg(type) {
    switch (type) {
      case 'warning':
        return '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>';
      case 'error':
        return '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>';
      case 'success':
        return '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>';
      case 'info':
      default:
        return '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>';
    }
  }

  showCustomAlert(title, message, type = 'info') {
    return new Promise((resolve) => {
      if (!this.dom || !this.dom.appDialogModal) {
        alert(`${title}\n\n${message}`);
        resolve(true);
        return;
      }
      this.dom.dialogTitle.textContent = title;
      this.dom.dialogMessage.textContent = message;
      this.dom.dialogIconRing.className = `dialog-icon-ring ${type}`;
      this.dom.dialogIcon.innerHTML = this.getDialogIconSvg(type);
      this.dom.dialogCancelBtn.style.display = 'none';
      this.dom.dialogConfirmBtn.textContent = 'OK';
      this.dom.dialogConfirmBtn.className = 'btn btn-primary';
      this.dom.appDialogModal.style.display = 'flex';

      const cleanup = () => {
        this.dom.dialogConfirmBtn.removeEventListener('click', onConfirm);
        this.dom.appDialogModal.style.display = 'none';
      };

      const onConfirm = () => {
        cleanup();
        resolve(true);
      };

      this.dom.dialogConfirmBtn.addEventListener('click', onConfirm);
    });
  }

  showCustomConfirm(title, message, type = 'warning') {
    return new Promise((resolve) => {
      if (!this.dom || !this.dom.appDialogModal) {
        const res = confirm(`${title}\n\n${message}`);
        resolve(res);
        return;
      }
      this.dom.dialogTitle.textContent = title;
      this.dom.dialogMessage.textContent = message;
      this.dom.dialogIconRing.className = `dialog-icon-ring ${type}`;
      this.dom.dialogIcon.innerHTML = this.getDialogIconSvg(type);
      this.dom.dialogCancelBtn.style.display = 'inline-block';
      this.dom.dialogConfirmBtn.textContent = 'Confirm';
      this.dom.dialogConfirmBtn.className = (type === 'error' || type === 'warning') ? 'btn btn-danger' : 'btn btn-primary';
      this.dom.appDialogModal.style.display = 'flex';

      const cleanup = () => {
        this.dom.dialogConfirmBtn.removeEventListener('click', onConfirm);
        this.dom.dialogCancelBtn.removeEventListener('click', onCancel);
        this.dom.appDialogModal.style.display = 'none';
      };

      const onConfirm = () => {
        cleanup();
        resolve(true);
      };

      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      this.dom.dialogConfirmBtn.addEventListener('click', onConfirm);
      this.dom.dialogCancelBtn.addEventListener('click', onCancel);
    });
  }

  initDOMElements() {
    this.dom = {
      appContainer: document.getElementById('appContainer'),
      appHeader: document.getElementById('appHeader'),
      serverStatusBadge: document.getElementById('serverStatusBadge'),
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

      // Custom Application Dialog
      appDialogModal: document.getElementById('appDialogModal'),
      dialogIconRing: document.getElementById('dialogIconRing'),
      dialogIcon: document.getElementById('dialogIcon'),
      dialogTitle: document.getElementById('dialogTitle'),
      dialogMessage: document.getElementById('dialogMessage'),
      dialogConfirmBtn: document.getElementById('dialogConfirmBtn'),
      dialogCancelBtn: document.getElementById('dialogCancelBtn'),

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
      addWorkstationBtn: document.getElementById('addWorkstationBtn'),
      workstationCardsGrid: document.getElementById('workstationCardsGrid'),
      emptyAddressBook: document.getElementById('emptyAddressBook'),
      addWorkstationModal: document.getElementById('addWorkstationModal'),
      closeAddWorkstationBtn: document.getElementById('closeAddWorkstationBtn'),
      cancelAddWorkstationBtn: document.getElementById('cancelAddWorkstationBtn'),
      saveWorkstationBtn: document.getElementById('saveWorkstationBtn'),
      workstationNameInput: document.getElementById('workstationNameInput'),
      workstationCodeInput: document.getElementById('workstationCodeInput'),
      workstationPasswordInput: document.getElementById('workstationPasswordInput'),

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
      pillSendFileBtn: document.getElementById('pillSendFileBtn'),
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
        await this.showCustomAlert('Input Required', 'Please enter an unattended master password.', 'warning');
        return;
      }
      this.unattendedPassHash = await this.hashPassword(pass);
      localStorage.setItem('primedesk_unattended_hash', this.unattendedPassHash);
      await this.showCustomAlert('Password Saved', 'Unattended access master password has been securely saved.', 'success');
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
        this.ws.send(JSON.stringify({ type: 'decline-connection', reason: 'Declined by remote operator' }));
      }
    });

    // Floating Pill Actions
    this.dom.pillStopBtn.addEventListener('click', () => this.stopHosting());
    if (this.dom.pillSendFileBtn) {
      this.dom.pillSendFileBtn.addEventListener('click', () => {
        this.dom.filePicker.click();
      });
    }

    // Window Focus Clipboard Synchronization
    window.addEventListener('focus', async () => {
      if (this.permClipboard && window.primeDeskAPI && this.clipboardChannel && this.clipboardChannel.readyState === 'open') {
        try {
          const currentText = await window.primeDeskAPI.readClipboard();
          if (currentText && currentText !== this.lastCopiedText) {
            this.lastCopiedText = currentText;
            this.clipboardChannel.send(JSON.stringify({ type: 'clip', text: currentText }));
          }
        } catch (e) {}
      }
    });

    // Connect Button
    this.dom.connectBtn.addEventListener('click', async () => {
      const code = this.dom.remoteCodeInput.value.replace(/\D/g, '');
      if (code.length !== 6) {
        await this.showCustomAlert('Invalid Address', 'Please enter a valid 6-digit terminal address (e.g. 582-914).', 'warning');
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
      });
    }

    if (this.dom.modeLan) {
      this.dom.modeLan.addEventListener('change', () => {
        if (this.dom.stunInput) {
          this.dom.stunInput.disabled = true;
          this.dom.stunInput.style.opacity = '0.5';
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
          await this.showCustomAlert('Input Required', 'Please enter an unattended master password.', 'warning');
          return;
        }
        this.unattendedPassHash = await this.hashPassword(pass);
        localStorage.setItem('primedesk_unattended_hash', this.unattendedPassHash);
        this.dom.saveUnattendedPassSettingsBtn.textContent = 'Saved!';
        setTimeout(() => { this.dom.saveUnattendedPassSettingsBtn.textContent = 'Set Password'; }, 2000);
        this.dom.unattendedPasswordInputSettings.value = '';
        this.dom.unattendedPasswordInputSettings.placeholder = '•••••• (Password active)';
        this.dom.unattendedPasswordInput.placeholder = '•••••• (Password active)';
        await this.showCustomAlert('Password Saved', 'Unattended access master password has been securely saved.', 'success');
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

    // Server Status Badge Diagnostics
    if (this.dom.serverStatusBadge) {
      this.dom.serverStatusBadge.addEventListener('click', () => {
        this.showConnectionDiagnostics();
      });
    }

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

      // Network & Proxy (Auto-configured based on mode)
      const oldProxyMode = this.proxyMode;
      const oldProxyServer = this.proxyServer;
      const oldProxyBypass = this.proxyBypass;

      const newMode = (this.dom.modeLan && this.dom.modeLan.checked) ? 'lan' : 'cloud';
      const newUrl = (newMode === 'cloud') ? DEFAULT_CLOUD_SIGNALING_URL : 'ws://localhost:9000';
      const newStun = this.dom.stunInput ? (this.dom.stunInput.value.trim() || 'stun:stun.l.google.com:19302') : this.stunServer;
      this.proxyMode = this.dom.proxyModeSelect ? this.dom.proxyModeSelect.value : this.proxyMode;
      this.proxyServer = this.dom.proxyServerInput ? this.dom.proxyServerInput.value.trim() : this.proxyServer;
      this.proxyBypass = this.dom.proxyBypassInput ? this.dom.proxyBypassInput.value.trim() : this.proxyBypass;
      const proxyChanged = (this.proxyMode !== oldProxyMode || this.proxyServer !== oldProxyServer || this.proxyBypass !== oldProxyBypass);

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

      const urlChanged = (this.signalingUrl !== newUrl || this.serverMode !== newMode);
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
      localStorage.setItem('primedesk_proxy_migrated_v1', 'true');
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

      if (urlChanged || proxyChanged || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connectSignaling();
      }
    });

    // Address Book Modal
    this.dom.addWorkstationBtn.addEventListener('click', () => {
      this.dom.addWorkstationModal.style.display = 'flex';
    });
    this.dom.closeAddWorkstationBtn.addEventListener('click', () => {
      this.dom.addWorkstationModal.style.display = 'none';
    });
    this.dom.cancelAddWorkstationBtn.addEventListener('click', () => {
      this.dom.addWorkstationModal.style.display = 'none';
    });
    this.dom.saveWorkstationBtn.addEventListener('click', async () => {
      const name = this.dom.workstationNameInput.value.trim();
      const code = this.dom.workstationCodeInput.value.replace(/\D/g, '');
      const pass = this.dom.workstationPasswordInput.value.trim();

      if (!name || code.length !== 6) {
        await this.showCustomAlert('Validation Error', 'Please specify a valid workstation name and 6-digit terminal address.', 'warning');
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

      this.dom.workstationNameInput.value = '';
      this.dom.workstationCodeInput.value = '';
      this.dom.workstationPasswordInput.value = '';
      this.dom.addWorkstationModal.style.display = 'none';
      await this.showCustomAlert('Workstation Added', `Workstation "${name}" has been registered in your directory.`, 'success');
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
    this.dom.workstationCardsGrid.innerHTML = '';

    if (this.addressBook.length === 0) {
      this.dom.emptyAddressBook.style.display = 'block';
      return;
    }

    this.dom.emptyAddressBook.style.display = 'none';
    this.addressBook.forEach(h => {
      const card = document.createElement('div');
      card.className = 'workstation-card';
      card.innerHTML = `
        <div class="workstation-card-top">
          <div>
            <div class="workstation-card-title">${h.name}</div>
            <div class="workstation-card-code">${this.formatCode(h.code)}</div>
          </div>
          <span class="workstation-card-badge">${h.password ? 'Unattended' : 'Interactive'}</span>
        </div>
        <div class="workstation-card-actions">
          <button class="btn btn-connect connect-workstation-btn" data-code="${h.code}" data-pass="${h.password}">
            Connect
          </button>
          <button class="btn-delete-workstation delete-workstation-btn" data-id="${h.id}" title="Remove Workstation">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      `;
      this.dom.workstationCardsGrid.appendChild(card);
    });

    document.querySelectorAll('.connect-workstation-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        const savedPass = e.currentTarget.getAttribute('data-pass');
        this.requestConnection(code, savedPass);
      });
    });

    document.querySelectorAll('.delete-workstation-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.getAttribute('data-id'));
        const target = this.addressBook.find(item => item.id === id);
        const name = target ? target.name : 'this workstation';
        const ok = await this.showCustomConfirm(
          'Delete Workstation',
          `Are you sure you want to remove "${name}" from your directory?`,
          'warning'
        );
        if (ok) {
          this.addressBook = this.addressBook.filter(item => item.id !== id);
          localStorage.setItem('primedesk_address_book', JSON.stringify(this.addressBook));
          this.renderAddressBook();
        }
      });
    });
  }

  clearSignalingTimers() {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.wsConnectTimeoutTimer) {
      clearTimeout(this.wsConnectTimeoutTimer);
      this.wsConnectTimeoutTimer = null;
    }
    if (this.wsKeepaliveTimer) {
      clearInterval(this.wsKeepaliveTimer);
      this.wsKeepaliveTimer = null;
    }
  }

  scheduleSignalingReconnect(attemptId, delayMs = 4000) {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
    }
    this.wsReconnectTimer = setTimeout(() => {
      if (attemptId === this.signalingAttemptId) {
        this.connectSignaling();
      }
    }, delayMs);
  }

  async connectSignaling() {
    this.signalingAttemptId = (this.signalingAttemptId || 0) + 1;
    const attemptId = this.signalingAttemptId;

    this.clearSignalingTimers();
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onclose = null;
      oldWs.onerror = null;
      try { oldWs.close(); } catch (e) {}
    }

    const isCloud = this.signalingUrl.includes('onrender.com') || this.serverMode === 'cloud';
    this.updateServerStatus('connecting', isCloud ? 'Connecting to Cloud...' : 'Connecting to LAN...');

    let probeNote = null;
    let httpReachable = false;

    if (isCloud && window.primeDeskAPI && window.primeDeskAPI.probeAndRecoverCloud) {
      try {
        const probe = await window.primeDeskAPI.probeAndRecoverCloud({
          signalingUrl: this.signalingUrl,
          proxyMode: this.proxyMode,
          proxyServer: this.proxyServer,
          proxyBypass: this.proxyBypass
        });

        if (attemptId !== this.signalingAttemptId) return;

        if (!probe.ok) {
          this.lastConnectionDiagnostic = probe;
          const dotState = probe.reason === 'server-waking' ? 'connecting' : 'disconnected';
          this.updateServerStatus(dotState, probe.summary || 'Cloud Unreachable');
          this.scheduleSignalingReconnect(attemptId, probe.reason === 'server-waking' ? 3500 : 6000);
          return;
        }

        httpReachable = true;
        if (probe.recovered && probe.note) {
          probeNote = probe.note;
          console.log('[Network]', probe.note);
        }
      } catch (err) {
        console.warn('[Network] Cloud probe warning:', err);
      }
    }

    if (attemptId !== this.signalingAttemptId) return;

    try {
      const ws = new WebSocket(this.signalingUrl);
      this.ws = ws;

      this.wsConnectTimeoutTimer = setTimeout(() => {
        if (attemptId !== this.signalingAttemptId || this.ws !== ws) return;
        if (ws.readyState === WebSocket.CONNECTING) {
          console.warn('[Signaling] WebSocket handshake timed out');
          ws.onopen = null;
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          try { ws.close(); } catch (e) {}
          this.ws = null;
          this.lastConnectionDiagnostic = {
            reason: 'ws-timeout',
            summary: isCloud ? 'Cloud Timeout' : 'Signaling Timeout',
            errorCode: 'WS_HANDSHAKE_TIMEOUT',
            details: httpReachable
              ? 'Cloud server responded via HTTPS, but the WebSocket handshake timed out. Check if a firewall or proxy is blocking WebSocket tunnels.'
              : 'Timed out opening signaling connection.'
          };
          this.updateServerStatus('disconnected', this.lastConnectionDiagnostic.summary);
          this.scheduleSignalingReconnect(attemptId, 4000);
        }
      }, 12000);

      ws.onopen = () => {
        if (attemptId !== this.signalingAttemptId || this.ws !== ws) return;
        this.clearSignalingTimers();
        this.lastConnectionDiagnostic = probeNote ? { note: probeNote } : null;
        this.updateServerStatus('connected', isCloud ? 'Cloud Online' : 'Signaling: Online');
        this.registerHostOnServer();

        // Keep WebSocket tunnel alive through proxies and Cloudflare/Render idle timeouts
        this.wsKeepaliveTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        if (attemptId !== this.signalingAttemptId || this.ws !== ws) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return;
          this.handleSignalingMessage(msg);
        } catch (e) {
          console.error('[Signaling] Message error:', e);
        }
      };

      ws.onclose = () => {
        if (attemptId !== this.signalingAttemptId || this.ws !== ws) return;
        this.clearSignalingTimers();
        this.ws = null;
        if (isCloud && httpReachable && !this.lastConnectionDiagnostic) {
          this.lastConnectionDiagnostic = {
            reason: 'ws-blocked',
            summary: 'WebSocket Blocked',
            errorCode: 'WS_CLOSE_1006',
            details: 'HTTPS reached the cloud server, but the WebSocket tunnel closed unexpectedly. A firewall or proxy on this network may be blocking WebSocket upgrades.'
          };
        }
        const label = (this.lastConnectionDiagnostic && this.lastConnectionDiagnostic.summary)
          || (isCloud ? 'Connecting to Cloud...' : 'Signaling: Offline');
        this.updateServerStatus('disconnected', label);
        this.scheduleSignalingReconnect(attemptId, 4500);
      };

      ws.onerror = () => {
        if (attemptId !== this.signalingAttemptId || this.ws !== ws) return;
        console.warn('[Signaling] WebSocket error event');
      };
    } catch (e) {
      this.clearSignalingTimers();
      this.updateServerStatus('disconnected', 'Signaling: Failed');
      this.scheduleSignalingReconnect(attemptId, 5000);
    }
  }

  updateServerStatus(state, text) {
    let dotClass = 'status-dot disconnected';
    if (state === true || state === 'connected') {
      dotClass = 'status-dot connected';
    } else if (state === 'connecting') {
      dotClass = 'status-dot connecting';
    }
    this.dom.serverDot.className = dotClass;
    this.dom.serverStatusText.textContent = text;
  }

  async showConnectionDiagnostics() {
    const isConnected = this.ws && this.ws.readyState === WebSocket.OPEN;
    const isCloud = this.serverMode === 'cloud';

    if (isConnected) {
      const note = (this.lastConnectionDiagnostic && this.lastConnectionDiagnostic.note)
        ? `\n\nNetwork Note: ${this.lastConnectionDiagnostic.note}`
        : '';
      await this.showCustomAlert(
        isCloud ? 'Cloud Signaling Online' : 'Offline Mode Online',
        `Connected to ${isCloud ? 'PrimeDesk Cloud Cluster' : 'Local Signaling Service'} (${this.signalingUrl}).\nActive Proxy Setting: ${this.proxyMode}${note}`,
        'success'
      );
      return;
    }

    const diag = this.lastConnectionDiagnostic;
    const msg = diag && diag.details
      ? `${diag.details}\n\nProxy Mode: ${this.proxyMode}${diag.resolvedProxy ? ` (Resolved: ${diag.resolvedProxy})` : ''}${diag.errorCode ? `\nCode: ${diag.errorCode}` : ''}\n\nClick Confirm to open Network & Proxy Settings.`
      : `Currently attempting to reach ${isCloud ? 'PrimeDesk Cloud Server' : 'Local Signaling Service'} using proxy mode "${this.proxyMode}".\n\nIf this PC uses a network proxy or needs Direct Connection, click Confirm to open Network & Proxy Settings.`;

    const openSettings = await this.showCustomConfirm(
      'Connection Diagnostics',
      msg,
      'warning'
    );

    if (openSettings && this.dom.settingsModal) {
      this.syncSettingsToUI();
      this.dom.settingsModal.style.display = 'flex';
      if (this.dom.settingsNavItems && this.dom.settingsSections) {
        this.dom.settingsNavItems.forEach(b => {
          b.classList.toggle('active', b.dataset.section === 'network');
        });
        this.dom.settingsSections.forEach(s => {
          s.classList.toggle('active', s.id === 'sec-network');
        });
      }
    }
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
          this.dom.incomingCallerText.textContent = `${msg.clientName || 'Support Technician'} is requesting remote control.`;
          this.dom.incomingModal.style.display = 'flex';
        }
        break;

      case 'connection-accepted':
        console.log('[Viewer] Remote device accepted connection. Initializing peer...');
        this.startViewerPeer();
        break;

      case 'connection-declined':
        this.showCustomAlert('Connection Rejected', `Session declined: ${msg.reason || 'Declined by remote user'}`, 'warning');
        this.endSession();
        break;

      case 'signal':
        this.handlePeerSignal(msg.data);
        break;

      case 'session-ended':
        this.showCustomAlert('Session Concluded', `Remote session ended: ${msg.reason || 'Disconnected'}`, 'info');
        this.endSession();
        break;

      case 'error':
        this.showCustomAlert('Signaling Notice', msg.message, 'warning');
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
      await this.showCustomAlert('Screen Capture Error', 'Could not start screen capture: ' + err.message, 'error');
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
    dc.onmessage = async (event) => {
      if (!this.permFile) {
        if (typeof event.data === 'string') {
          console.warn('[File] File transfer blocked: Permission disabled in settings');
        }
        return;
      }
      if (typeof event.data === 'string') {
        try {
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
        } catch (e) {}
      } else if (event.data instanceof ArrayBuffer && this.incomingFile) {
        this.incomingFile.chunks.push(event.data);
        this.incomingFile.receivedSize += event.data.byteLength;
        const pct = Math.round((this.incomingFile.receivedSize / this.incomingFile.size) * 100);
        this.updateTransferProgress(pct);

        if (this.incomingFile.receivedSize >= this.incomingFile.size) {
          const blob = new Blob(this.incomingFile.chunks);
          const fileName = this.incomingFile.name;

          if (window.primeDeskAPI && window.primeDeskAPI.saveReceivedFile) {
            try {
              const arrayBuffer = await blob.arrayBuffer();
              await window.primeDeskAPI.saveReceivedFile({ filename: fileName, buffer: arrayBuffer });
            } catch (err) {
              console.error('[File] Error saving file to Downloads:', err);
            }
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }

          this.showTransferToast(`Saved to Downloads: ${fileName}`, 100);
          setTimeout(() => this.hideTransferToast(), 3500);
          this.incomingFile = null;
        }
      }
    };
  }

  setupClipboardChannel(dc) {
    dc.onopen = () => {
      console.log('[Clipboard] Sync Channel Open');
      this.startClipboardPolling();
    };
    dc.onmessage = async (event) => {
      if (!this.permClipboard) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'clip' && data.text) {
          this.lastCopiedText = data.text;
          if (window.primeDeskAPI) {
            await window.primeDeskAPI.writeClipboard(data.text);
          }
        } else if (data.type === 'request-clip') {
          if (window.primeDeskAPI) {
            const currentText = await window.primeDeskAPI.readClipboard();
            if (currentText) {
              this.lastCopiedText = currentText;
              dc.send(JSON.stringify({ type: 'clip', text: currentText }));
            }
          }
        }
      } catch (e) {}
    };
  }

  startClipboardPolling() {
    if (this.clipboardPollInterval) {
      clearInterval(this.clipboardPollInterval);
    }
    this.clipboardPollInterval = setInterval(async () => {
      if (!this.permClipboard) return;
      if (window.primeDeskAPI && this.clipboardChannel && this.clipboardChannel.readyState === 'open') {
        try {
          const currentText = await window.primeDeskAPI.readClipboard();
          if (currentText && currentText !== this.lastCopiedText) {
            this.lastCopiedText = currentText;
            this.clipboardChannel.send(JSON.stringify({ type: 'clip', text: currentText }));
          }
        } catch (e) {}
      }
    }, 350);
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
  async requestConnection(code, savedPass = null) {
    this.role = 'viewer';
    this.pendingConnectCode = code;
    this.savedPass = savedPass;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'request-connect',
        code,
        clientName: 'Support Technician'
      }));
    } else {
      const isCloud = this.signalingUrl.includes('onrender.com') || this.serverMode === 'cloud';
      const diag = this.lastConnectionDiagnostic;
      this.connectSignaling();
      if (isCloud && diag && diag.details) {
        await this.showCustomAlert(
          diag.summary || 'Cloud Connection Issue',
          `${diag.details}\n\nTip: Click the status pill at the top-right to open Network & Proxy Settings.`,
          'warning'
        );
      } else {
        await this.showCustomAlert(
          isCloud ? 'Connecting to Cloud Server' : 'Connecting to Offline Service',
          isCloud
            ? 'Connecting to the secure cloud signaling cluster. Please wait a few seconds for the status indicator to show "Cloud Online" and try again.'
            : 'Connecting to local offline signaling service. Please ensure the local signaling service is running and try again.',
          'warning'
        );
      }
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
        await this.showCustomAlert('Authentication Denied', 'Invalid unattended access password. Connection rejected.', 'error');
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

    // Window-level mouseup prevents stuck mouse drags if mouse is released outside viewport
    window.addEventListener('mouseup', (e) => {
      if (this.dom.remoteViewport && this.dom.remoteViewport.style.display !== 'none') {
        const btn = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
        this.sendInputCommand(`U ${btn}`);
      }
    });

    video.addEventListener('mouseleave', (e) => {
      if (e.buttons === 0) {
        this.sendInputCommand('RELEASE_MOUSE');
      }
    });

    window.addEventListener('blur', () => {
      if (this.dom.remoteViewport && this.dom.remoteViewport.style.display !== 'none') {
        this.sendInputCommand('RELEASE_MOUSE');
        this.sendInputCommand('U left');
        this.sendInputCommand('U right');
        this.sendInputCommand('U middle');
      }
    });

    video.addEventListener('contextmenu', (e) => e.preventDefault());

    video.addEventListener('wheel', (e) => {
      const delta = Math.round(-e.deltaY);
      this.sendInputCommand(`W ${delta}`);
    });

    window.addEventListener('keydown', async (e) => {
      if (this.dom.remoteViewport.style.display !== 'none' && document.activeElement !== this.dom.chatInput) {
        // Intercept Ctrl+V (Paste local clipboard into remote host)
        if (e.ctrlKey && (e.key === 'v' || e.key === 'V' || e.keyCode === 86)) {
          e.preventDefault();
          if (this.permClipboard && window.primeDeskAPI) {
            try {
              const text = await window.primeDeskAPI.readClipboard();
              if (text) {
                this.lastCopiedText = text;
                if (this.clipboardChannel && this.clipboardChannel.readyState === 'open') {
                  this.clipboardChannel.send(JSON.stringify({ type: 'clip', text }));
                }
              }
            } catch (err) {}
          }
          setTimeout(() => {
            this.sendInputCommand('PASTE');
          }, 60);
          return;
        }

        // Intercept Ctrl+C (Copy from remote host to local clipboard)
        if (e.ctrlKey && (e.key === 'c' || e.key === 'C' || e.keyCode === 67)) {
          this.sendInputCommand('COPY');
          setTimeout(() => {
            if (this.clipboardChannel && this.clipboardChannel.readyState === 'open') {
              this.clipboardChannel.send(JSON.stringify({ type: 'request-clip' }));
            }
          }, 180);
          return;
        }

        this.sendInputCommand(`KD ${e.keyCode}`);
        if (['Tab', 'F5', 'Alt'].includes(e.key)) e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (this.dom.remoteViewport.style.display !== 'none' && document.activeElement !== this.dom.chatInput) {
        if (e.ctrlKey && (e.key === 'v' || e.key === 'V' || e.key === 'c' || e.key === 'C')) {
          return;
        }
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
      await this.showCustomAlert('Channel Closed', 'File channel is not open. Connect to a remote device first.', 'warning');
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
    if (this.dom.toastFileName) this.dom.toastFileName.textContent = name;
    if (this.dom.toastPercent) this.dom.toastPercent.textContent = `${pct}%`;
    if (this.dom.toastProgressBar) this.dom.toastProgressBar.style.width = `${pct}%`;
    if (this.dom.transferToast) this.dom.transferToast.style.display = 'block';

    const pillDesc = document.querySelector('.pill-desc');
    if (pillDesc && this.role === 'host') {
      pillDesc.textContent = `${name} (${pct}%)`;
    }
  }

  updateTransferProgress(pct) {
    if (this.dom.toastPercent) this.dom.toastPercent.textContent = `${pct}%`;
    if (this.dom.toastProgressBar) this.dom.toastProgressBar.style.width = `${pct}%`;

    const pillDesc = document.querySelector('.pill-desc');
    if (pillDesc && this.role === 'host') {
      pillDesc.textContent = `Transferring... ${pct}%`;
    }
  }

  hideTransferToast() {
    if (this.dom.transferToast) this.dom.transferToast.style.display = 'none';

    const pillDesc = document.querySelector('.pill-desc');
    if (pillDesc && this.role === 'host') {
      pillDesc.textContent = 'Remote Support Connected';
    }
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
