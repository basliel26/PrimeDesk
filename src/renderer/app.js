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

const CHUNK_SIZE = 64 * 1024; // 64KB streamed disk chunk
const FILE_CLIP_AUTO_MAX_BYTES = 50 * 1024 * 1024; // 50MB auto-clipboard stage limit
const DEFAULT_CLOUD_SIGNALING_URL = 'wss://primedesk-signal.onrender.com';

class PrimeDeskApp {
  constructor() {
    this.ws = null;
    this.peerConnection = null;
    this.inputChannel = null;
    this.chatChannel = null;
    this.fileChannel = null;
    this.fileOpsChannel = null;
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
    this.pingInterval = null;
    this.clipboardPollInterval = null;
    this.lastCopiedText = '';
    this.lastCopiedFilesKey = '';
    this.privacyModeActive = false;

    // File Manager & Streaming Transfer State
    this.pendingFileOps = new Map();
    this.nextFileOpId = 1;
    this.activeSendTransfer = null;
    this.activeReceiveTransfer = null;
    this.transferQueue = [];
    this.isSendingTransfer = false;
    this.pendingRemoteClipTimer = null;
    this.pendingRemoteClipData = null;
    this.fmState = {
      local: { path: '', parent: null, entries: [], selected: new Set(), roots: null },
      remote: { path: '', parent: null, entries: [], selected: new Set(), roots: null }
    };

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
      pillStopBtn: document.getElementById('pillStopBtn'),
      pillChatBtn: document.getElementById('pillChatBtn'),
      pillChatBadge: document.getElementById('pillChatBadge'),

      // Pending Connection Overlay
      connectingOverlay: document.getElementById('connectingOverlay'),
      connectingCodeLabel: document.getElementById('connectingCodeLabel'),
      connectingTitle: document.getElementById('connectingTitle'),
      connectingSubtitle: document.getElementById('connectingSubtitle'),
      cancelConnectBtn: document.getElementById('cancelConnectBtn'),

      // Remote Viewport
      remoteViewport: document.getElementById('remoteViewport'),
      remoteVideo: document.getElementById('remoteVideo'),
      remoteSessionTitle: document.getElementById('remoteSessionTitle'),
      fitScreenBtn: document.getElementById('fitScreenBtn'),
      fitBtnText: document.getElementById('fitBtnText'),
      fileManagerBtn: document.getElementById('fileManagerBtn'),
      filePicker: document.getElementById('filePicker'),
      remoteClipBanner: document.getElementById('remoteClipBanner'),
      remoteClipBannerText: document.getElementById('remoteClipBannerText'),
      pullRemoteClipBtn: document.getElementById('pullRemoteClipBtn'),
      dismissRemoteClipBtn: document.getElementById('dismissRemoteClipBtn'),
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

      // Dual-Pane File Manager
      fileManagerModal: document.getElementById('fileManagerModal'),
      closeFileManagerBtn: document.getElementById('closeFileManagerBtn'),
      giveFilesBtn: document.getElementById('giveFilesBtn'),
      takeFilesBtn: document.getElementById('takeFilesBtn'),
      fmTransferStatus: document.getElementById('fmTransferStatus'),
      fmTransferPercent: document.getElementById('fmTransferPercent'),
      fmTransferProgressBar: document.getElementById('fmTransferProgressBar'),
      fmCancelTransferBtn: document.getElementById('fmCancelTransferBtn'),

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

    // Floating Pill & Native Pill IPC Actions
    if (this.dom.pillStopBtn) {
      this.dom.pillStopBtn.addEventListener('click', () => this.stopHosting());
    }
    if (window.primeDeskAPI && window.primeDeskAPI.onPillChatOutgoing) {
      window.primeDeskAPI.onPillChatOutgoing((text) => {
        if (!text) return;
        this.sendChatMessage(text);
        this.appendChatMessage(text, 'sent');
      });
    }
    if (window.primeDeskAPI && window.primeDeskAPI.onPillTerminateSession) {
      window.primeDeskAPI.onPillTerminateSession(() => {
        if (this.role === 'host') {
          this.stopHosting();
        }
      });
    }

    // Cancel Pending Connection Overlay
    if (this.dom.cancelConnectBtn) {
      this.dom.cancelConnectBtn.addEventListener('click', () => {
        this.hideConnectingOverlay();
        this.role = null;
        this.pendingConnectCode = null;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'leave' }));
        }
        if (this.peerConnection) {
          try { this.peerConnection.close(); } catch (e) {}
          this.peerConnection = null;
        }
      });
    }

    // Remote Copied Large File Prompt Banner
    if (this.dom.pullRemoteClipBtn) {
      this.dom.pullRemoteClipBtn.addEventListener('click', () => {
        if (this.dom.remoteClipBanner) this.dom.remoteClipBanner.style.display = 'none';
        if (this.pendingRemoteClipData) {
          this.pullRemoteClipboardFiles(this.pendingRemoteClipData);
          this.pendingRemoteClipData = null;
        }
      });
    }
    if (this.dom.dismissRemoteClipBtn) {
      this.dom.dismissRemoteClipBtn.addEventListener('click', () => {
        if (this.dom.remoteClipBanner) this.dom.remoteClipBanner.style.display = 'none';
        this.pendingRemoteClipData = null;
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

    // Support-Giver Dual-Pane File Manager
    if (this.dom.fileManagerBtn) {
      this.dom.fileManagerBtn.addEventListener('click', () => this.openFileManager());
    }
    this.initFileManagerEvents();

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
        this.showConnectingOverlay(this.pendingConnectCode, 'Connection Approved', 'Establishing encrypted display & control channels...');
        this.startViewerPeer();
        break;

      case 'connection-declined':
        this.hideConnectingOverlay();
        this.showCustomAlert('Connection Rejected', `Session declined: ${msg.reason || 'Declined by remote user'}`, 'warning');
        this.endSession();
        break;

      case 'signal':
        this.handlePeerSignal(msg.data);
        break;

      case 'session-ended':
        this.hideConnectingOverlay();
        if (this.dom.fileManagerModal) this.dom.fileManagerModal.style.display = 'none';
        this.showCustomAlert('Session Concluded', `Remote session ended: ${msg.reason || 'Disconnected'}`, 'info');
        this.endSession();
        break;

      case 'error':
        this.hideConnectingOverlay();
        if (this.role === 'viewer' && this.dom.remoteViewport.style.display === 'none') {
          this.role = null;
          this.pendingConnectCode = null;
        }
        this.showCustomAlert('Signaling Notice', msg.message, 'warning');
        break;
    }
  }

  showConnectingOverlay(code, title = 'Connecting to Remote PC...', subtitle = 'Waiting for remote host approval...') {
    if (!this.dom.connectingOverlay) return;
    if (this.dom.connectingCodeLabel) this.dom.connectingCodeLabel.textContent = this.formatCode(code || '');
    if (this.dom.connectingTitle) this.dom.connectingTitle.textContent = title;
    if (this.dom.connectingSubtitle) this.dom.connectingSubtitle.textContent = subtitle;
    this.dom.connectingOverlay.style.display = 'flex';
  }

  hideConnectingOverlay() {
    if (this.dom.connectingOverlay) {
      this.dom.connectingOverlay.style.display = 'none';
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

      this.fileOpsChannel = this.peerConnection.createDataChannel('file-ops');
      this.setupFileOpsChannel(this.fileOpsChannel);

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
      if (this.role === 'host' && window.primeDeskAPI && window.primeDeskAPI.pillNotifyIncoming) {
        window.primeDeskAPI.pillNotifyIncoming({ text: event.data });
      }
      if (this.dom.chatDrawer.style.display !== 'flex') {
        this.unreadChatCount++;
        this.updateChatBadge();
      }
    };
  }

  setupFileChannel(dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => console.log('[File] Streaming Channel Ready');

    // Serialize all file control + binary chunk messages strictly in arrival order
    let rxChain = Promise.resolve();
    dc.onmessage = (event) => {
      const payload = event.data;
      rxChain = rxChain.then(async () => {
        if (typeof payload === 'string') {
          try {
            const msg = JSON.parse(payload);
            await this.handleFileChannelControl(msg);
          } catch (e) {
            console.error('[File] Control error:', e);
          }
        } else if (payload instanceof ArrayBuffer) {
          await this.handleFileChannelChunk(payload);
        }
      }).catch((err) => {
        console.error('[File] RX queue error:', err);
      });
    };
  }

  setupFileOpsChannel(dc) {
    dc.onopen = () => console.log('[FileOps] RPC Channel Ready');
    dc.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleFileOpsMessage(dc, msg);
      } catch (e) {
        console.error('[FileOps] RPC parse error:', e);
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
          if (!window.primeDeskAPI) return;
          if (this.permFile && window.primeDeskAPI.clipGetFiles) {
            const clipFiles = await window.primeDeskAPI.clipGetFiles();
            if (clipFiles && clipFiles.length > 0) {
              const collected = await window.primeDeskAPI.fsCollectItems(clipFiles);
              if (collected && collected.rootItems && collected.rootItems.length > 0) {
                dc.send(JSON.stringify({
                  type: 'clip-files-ready',
                  paths: clipFiles,
                  rootItems: collected.rootItems,
                  totalSize: collected.totalSize
                }));
                return;
              }
            }
          }
          const currentText = await window.primeDeskAPI.readClipboard();
          if (currentText) {
            this.lastCopiedText = currentText;
            dc.send(JSON.stringify({ type: 'clip', text: currentText }));
          }
        } else if (data.type === 'clip-files-ready') {
          if (!this.permFile) return;
          this.handleRemoteClipboardFilesReady(data);
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
    this.cleanupFileTransfers();
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
    if (this.dom.floatingPillView) this.dom.floatingPillView.style.display = 'none';
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
      this.showConnectingOverlay(code, 'Connecting to Remote PC...', 'Sending connection request. Waiting for remote approval...');
      this.ws.send(JSON.stringify({
        type: 'request-connect',
        code,
        clientName: 'Support Technician'
      }));
    } else {
      this.role = null;
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
      this.hideConnectingOverlay();
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
      } else if (e.channel.label === 'file-ops') {
        this.fileOpsChannel = e.channel;
        this.setupFileOpsChannel(this.fileOpsChannel);
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
      const fmOpen = this.dom.fileManagerModal && this.dom.fileManagerModal.style.display !== 'none';
      if (this.dom.remoteViewport.style.display !== 'none' && !fmOpen && document.activeElement !== this.dom.chatInput) {
        // Intercept Ctrl+V (Paste local text OR CF_HDROP files into remote host)
        if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V' || e.keyCode === 86)) {
          e.preventDefault();

          // If user copied on remote and immediately pastes inside remote, cancel auto-pull!
          if (this.pendingRemoteClipTimer) {
            clearTimeout(this.pendingRemoteClipTimer);
            this.pendingRemoteClipTimer = null;
          }
          if (this.dom.remoteClipBanner) {
            this.dom.remoteClipBanner.style.display = 'none';
          }
          this.pendingRemoteClipData = null;

          if (this.permFile && window.primeDeskAPI && window.primeDeskAPI.clipGetFiles) {
            try {
              const clipFiles = await window.primeDeskAPI.clipGetFiles();
              if (clipFiles && clipFiles.length > 0) {
                const manifest = await window.primeDeskAPI.fsCollectItems(clipFiles);
                if (manifest && manifest.rootItems && manifest.rootItems.length > 0) {
                  this.enqueueOutgoingTransfer({
                    targetDir: null,
                    purpose: 'clipboard-paste',
                    manifest
                  });
                  return;
                }
              }
            } catch (err) {
              console.warn('[Clipboard] File drop inspect error:', err);
            }
          }

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

        // Intercept Ctrl+C (Copy text OR files from remote host)
        if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C' || e.keyCode === 67)) {
          this.sendInputCommand('COPY');
          setTimeout(() => {
            if (this.clipboardChannel && this.clipboardChannel.readyState === 'open') {
              this.clipboardChannel.send(JSON.stringify({ type: 'request-clip' }));
            }
          }, 220);
          return;
        }

        this.sendInputCommand(`KD ${e.keyCode}`);
        if (['Tab', 'F5', 'Alt'].includes(e.key)) e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      const fmOpen = this.dom.fileManagerModal && this.dom.fileManagerModal.style.display !== 'none';
      if (this.dom.remoteViewport.style.display !== 'none' && !fmOpen && document.activeElement !== this.dom.chatInput) {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V' || e.key === 'c' || e.key === 'C')) {
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
    const textNode = document.createTextNode(text);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = timeStr;
    bubble.appendChild(textNode);
    bubble.appendChild(timeSpan);
    this.dom.chatMessages.appendChild(bubble);
    this.dom.chatMessages.scrollTop = this.dom.chatMessages.scrollHeight;
  }

  updateChatBadge() {
    const text = this.unreadChatCount > 0 ? this.unreadChatCount : '';
    const display = this.unreadChatCount > 0 ? 'inline-block' : 'none';

    if (this.dom.chatBadge) {
      this.dom.chatBadge.textContent = text;
      this.dom.chatBadge.style.display = display;
    }
    if (this.dom.pillChatBadge) {
      this.dom.pillChatBadge.textContent = text;
      this.dom.pillChatBadge.style.display = display;
    }
  }

  // ==================== STREAMING DISK FILE TRANSFER ENGINE ====================

  formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, i);
    return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
  }

  notifyPillStatus(statusText) {
    if (this.role === 'host' && window.primeDeskAPI && window.primeDeskAPI.pillNotifyIncoming) {
      window.primeDeskAPI.pillNotifyIncoming({ statusText });
    }
  }

  updateTransferUI(label, pct, showCancel = false) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
    if (this.dom.toastFileName) this.dom.toastFileName.textContent = label;
    if (this.dom.toastPercent) this.dom.toastPercent.textContent = `${clamped}%`;
    if (this.dom.toastProgressBar) this.dom.toastProgressBar.style.width = `${clamped}%`;
    if (this.dom.transferToast) this.dom.transferToast.style.display = 'block';

    if (this.dom.fmTransferStatus) this.dom.fmTransferStatus.textContent = label;
    if (this.dom.fmTransferPercent) this.dom.fmTransferPercent.textContent = `${clamped}%`;
    if (this.dom.fmTransferProgressBar) this.dom.fmTransferProgressBar.style.width = `${clamped}%`;
    if (this.dom.fmCancelTransferBtn) {
      this.dom.fmCancelTransferBtn.style.display = showCancel ? 'inline-block' : 'none';
    }
    this.notifyPillStatus(`${label} (${clamped}%)`);
  }

  hideTransferToast() {
    if (this.dom.transferToast) this.dom.transferToast.style.display = 'none';
    if (this.dom.fmCancelTransferBtn) this.dom.fmCancelTransferBtn.style.display = 'none';
    this.notifyPillStatus('Remote Control Active');
  }

  async cleanupFileTransfers() {
    this.transferQueue = [];
    if (this.activeSendTransfer) {
      this.activeSendTransfer.aborted = true;
      if (this.activeSendTransfer.readId && window.primeDeskAPI) {
        try { await window.primeDeskAPI.fsCloseRead(this.activeSendTransfer.readId); } catch (e) {}
      }
      this.activeSendTransfer = null;
    }
    this.isSendingTransfer = false;

    if (this.activeReceiveTransfer) {
      if (this.activeReceiveTransfer.writeId && window.primeDeskAPI) {
        try { await window.primeDeskAPI.fsAbortWrite(this.activeReceiveTransfer.writeId); } catch (e) {}
      }
      this.activeReceiveTransfer = null;
    }

    if (this.pendingRemoteClipTimer) {
      clearTimeout(this.pendingRemoteClipTimer);
      this.pendingRemoteClipTimer = null;
    }
    this.pendingRemoteClipData = null;

    for (const [, entry] of this.pendingFileOps.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Session closed'));
    }
    this.pendingFileOps.clear();
  }

  waitForFileBufferDrain(dc) {
    return new Promise((resolve) => {
      if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= 1024 * 1024) {
        return resolve();
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        dc.removeEventListener('bufferedamountlow', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 100);
      dc.addEventListener('bufferedamountlow', done);
    });
  }

  enqueueOutgoingTransfer(job) {
    if (!this.fileChannel || this.fileChannel.readyState !== 'open') {
      this.showCustomAlert('Channel Closed', 'File channel is not open. Wait for connection to stabilize.', 'warning');
      return;
    }
    this.transferQueue.push(job);
    if (!this.isSendingTransfer) {
      this.processTransferQueue();
    }
  }

  async processTransferQueue() {
    if (this.isSendingTransfer) return;
    this.isSendingTransfer = true;

    while (this.transferQueue.length > 0) {
      const job = this.transferQueue.shift();
      await this.executeOutgoingTransfer(job);
    }

    this.isSendingTransfer = false;
  }

  async executeOutgoingTransfer({ targetDir, purpose, manifest }) {
    const dc = this.fileChannel;
    if (!dc || dc.readyState !== 'open' || !window.primeDeskAPI) return;

    const transferId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const files = manifest.files || [];
    const emptyDirs = manifest.emptyDirs || [];
    const rootNames = (manifest.rootItems || []).map(r => r.name);
    const totalSize = manifest.totalSize || 0;

    const tx = { transferId, aborted: false, readId: null };
    this.activeSendTransfer = tx;

    const labelPrefix = purpose === 'clipboard-paste' ? 'Pasting' : 'Sending';
    const summaryName = rootNames.length === 1 ? rootNames[0] : `${rootNames.length} items`;
    this.updateTransferUI(`${labelPrefix}: ${summaryName}`, 0, true);

    dc.send(JSON.stringify({
      type: 'batch-start',
      transferId,
      purpose,
      targetDir,
      totalSize,
      totalFiles: files.length,
      rootNames,
      emptyDirs
    }));

    let sentBytes = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        if (tx.aborted || dc.readyState !== 'open') break;
        const f = files[i];

        dc.send(JSON.stringify({
          type: 'file-start',
          transferId,
          relPath: f.relPath,
          name: f.relPath.split('/').pop(),
          size: f.size
        }));

        if (f.size > 0) {
          const opened = await window.primeDeskAPI.fsOpenRead(f.fullPath);
          tx.readId = opened.readId;
          let offset = 0;

          while (offset < f.size && !tx.aborted && dc.readyState === 'open') {
            if (dc.bufferedAmount > 1024 * 1024) {
              await this.waitForFileBufferDrain(dc);
              if (tx.aborted || dc.readyState !== 'open') break;
            }
            const toRead = Math.min(CHUNK_SIZE, f.size - offset);
            const chunk = await window.primeDeskAPI.fsReadChunk(tx.readId, offset, toRead);
            if (!chunk || chunk.byteLength === 0) break;

            dc.send(chunk);
            offset += chunk.byteLength;
            sentBytes += chunk.byteLength;

            const pct = totalSize > 0 ? Math.round((sentBytes / totalSize) * 100) : 100;
            this.updateTransferUI(`${labelPrefix} (${i + 1}/${files.length}): ${f.relPath.split('/').pop()}`, pct, true);
          }

          await window.primeDeskAPI.fsCloseRead(tx.readId);
          tx.readId = null;
        }

        if (tx.aborted || dc.readyState !== 'open') break;
        dc.send(JSON.stringify({ type: 'file-end', transferId, relPath: f.relPath }));
      }

      if (tx.aborted) {
        if (dc.readyState === 'open') {
          dc.send(JSON.stringify({ type: 'batch-abort', transferId, reason: 'Cancelled by user' }));
        }
        this.updateTransferUI('Transfer cancelled', 0, false);
      } else if (dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'batch-end', transferId, purpose }));
        this.updateTransferUI(`Completed: ${summaryName}`, 100, false);
        if (this.role === 'viewer' && purpose === 'manager' && this.dom.fileManagerModal.style.display === 'flex') {
          await this.loadFmDir('remote', this.fmState.remote.path);
        }
      }
    } catch (err) {
      console.error('[File] Outgoing stream error:', err);
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'batch-abort', transferId, reason: err.message }));
      }
      this.updateTransferUI(`Failed: ${err.message}`, 0, false);
    } finally {
      if (tx.readId && window.primeDeskAPI) {
        try { await window.primeDeskAPI.fsCloseRead(tx.readId); } catch (e) {}
      }
      this.activeSendTransfer = null;
      setTimeout(() => {
        if (!this.activeSendTransfer && !this.activeReceiveTransfer) {
          this.hideTransferToast();
        }
      }, 3000);
    }
  }

  async cancelCurrentTransfer() {
    if (this.activeSendTransfer) {
      this.activeSendTransfer.aborted = true;
      this.transferQueue = [];
    }
    if (this.activeReceiveTransfer && this.fileOpsChannel && this.fileOpsChannel.readyState === 'open') {
      this.fileOpsChannel.send(JSON.stringify({
        type: 'fs-pull-cancel',
        transferId: this.activeReceiveTransfer.transferId
      }));
    }
  }

  async handleFileChannelControl(msg) {
    if (!this.permFile) {
      if (msg.type === 'batch-start') {
        console.warn('[File] Transfer rejected: Allow File Transfer disabled in settings');
        if (this.fileOpsChannel && this.fileOpsChannel.readyState === 'open') {
          this.fileOpsChannel.send(JSON.stringify({
            type: 'transfer-error',
            message: 'File transfer blocked: Remote host disabled file transfer permission in Security settings.'
          }));
        }
      }
      return;
    }

    if (msg.type === 'batch-start') {
      let baseDir = msg.targetDir;
      if (msg.purpose === 'clipboard-paste' || msg.purpose === 'clipboard') {
        baseDir = await window.primeDeskAPI.clipCreateStageDir();
      } else if (!baseDir) {
        baseDir = await window.primeDeskAPI.getDownloadsDir();
      }

      if (Array.isArray(msg.emptyDirs)) {
        for (const rel of msg.emptyDirs) {
          try {
            await window.primeDeskAPI.fsCreateEmptyDir(baseDir, rel);
          } catch (e) {}
        }
      }

      this.activeReceiveTransfer = {
        transferId: msg.transferId,
        purpose: msg.purpose,
        baseDir,
        totalSize: msg.totalSize || 0,
        totalFiles: msg.totalFiles || 0,
        receivedTotal: 0,
        rootNames: msg.rootNames || [],
        writeId: null,
        currentFileSize: 0,
        currentFileReceived: 0,
        filesDone: 0
      };
      const label = msg.rootNames && msg.rootNames.length === 1 ? msg.rootNames[0] : `${msg.totalFiles} files`;
      this.updateTransferUI(`Receiving: ${label}`, 0, true);
      return;
    }

    const rx = this.activeReceiveTransfer;
    if (!rx || rx.transferId !== msg.transferId) return;

    if (msg.type === 'file-start') {
      const opened = await window.primeDeskAPI.fsBeginWrite(rx.baseDir, msg.relPath);
      rx.writeId = opened.writeId;
      rx.currentFileSize = msg.size || 0;
      rx.currentFileReceived = 0;
      const pct = rx.totalSize > 0 ? Math.round((rx.receivedTotal / rx.totalSize) * 100) : 100;
      this.updateTransferUI(`Receiving (${rx.filesDone + 1}/${rx.totalFiles}): ${msg.name}`, pct, true);
    } else if (msg.type === 'file-end') {
      if (rx.writeId) {
        await window.primeDeskAPI.fsEndWrite(rx.writeId);
        rx.writeId = null;
      }
      rx.filesDone++;
    } else if (msg.type === 'batch-abort') {
      if (rx.writeId) {
        await window.primeDeskAPI.fsAbortWrite(rx.writeId);
        rx.writeId = null;
      }
      this.activeReceiveTransfer = null;
      this.updateTransferUI(`Cancelled: ${msg.reason || 'Aborted'}`, 0, false);
      setTimeout(() => this.hideTransferToast(), 3000);
    } else if (msg.type === 'batch-end') {
      if (rx.writeId) {
        await window.primeDeskAPI.fsEndWrite(rx.writeId);
        rx.writeId = null;
      }
      const completed = rx;
      this.activeReceiveTransfer = null;

      if (completed.purpose === 'clipboard-paste') {
        const rootPaths = [];
        for (const r of completed.rootNames) {
          rootPaths.push(await window.primeDeskAPI.fsResolveSafeTarget(completed.baseDir, r));
        }
        await window.primeDeskAPI.clipSetFiles(rootPaths);
        if (this.permControl) {
          await window.primeDeskAPI.sendInput('PASTE');
        }
        this.updateTransferUI(`Pasted: ${completed.rootNames.join(', ')}`, 100, false);
      } else if (completed.purpose === 'clipboard') {
        const rootPaths = [];
        for (const r of completed.rootNames) {
          rootPaths.push(await window.primeDeskAPI.fsResolveSafeTarget(completed.baseDir, r));
        }
        await window.primeDeskAPI.clipSetFiles(rootPaths);
        this.updateTransferUI('Copied files ready — Press Ctrl+V on your PC', 100, false);
      } else {
        this.updateTransferUI('Download complete', 100, false);
        if (this.role === 'viewer' && this.dom.fileManagerModal.style.display === 'flex') {
          await this.loadFmDir('local', this.fmState.local.path);
        }
      }
      setTimeout(() => {
        if (!this.activeSendTransfer && !this.activeReceiveTransfer) {
          this.hideTransferToast();
        }
      }, 3500);
    }
  }

  async handleFileChannelChunk(arrayBuffer) {
    const rx = this.activeReceiveTransfer;
    if (!rx || !rx.writeId) return;
    await window.primeDeskAPI.fsWriteChunk(rx.writeId, new Uint8Array(arrayBuffer));
    rx.currentFileReceived += arrayBuffer.byteLength;
    rx.receivedTotal += arrayBuffer.byteLength;
    const pct = rx.totalSize > 0 ? Math.round((rx.receivedTotal / rx.totalSize) * 100) : 100;
    if (this.dom.toastPercent) this.dom.toastPercent.textContent = `${pct}%`;
    if (this.dom.toastProgressBar) this.dom.toastProgressBar.style.width = `${pct}%`;
    if (this.dom.fmTransferPercent) this.dom.fmTransferPercent.textContent = `${pct}%`;
    if (this.dom.fmTransferProgressBar) this.dom.fmTransferProgressBar.style.width = `${pct}%`;
  }

  // ==================== FILE-OPS RPC & CLIPBOARD PULL ====================

  callRemoteFs(action, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.fileOpsChannel || this.fileOpsChannel.readyState !== 'open') {
        return reject(new Error('File control channel is not connected'));
      }
      const reqId = this.nextFileOpId++;
      const timer = setTimeout(() => {
        this.pendingFileOps.delete(reqId);
        reject(new Error('Remote file request timed out'));
      }, 15000);
      this.pendingFileOps.set(reqId, { resolve, reject, timer });
      this.fileOpsChannel.send(JSON.stringify({ type: 'fs-req', reqId, action, payload }));
    });
  }

  async handleFileOpsMessage(dc, msg) {
    if (msg.type === 'fs-req') {
      if (!this.permFile) {
        dc.send(JSON.stringify({
          type: 'fs-res',
          reqId: msg.reqId,
          ok: false,
          error: 'Remote host disabled file transfers in Security Settings.'
        }));
        return;
      }
      try {
        let data = null;
        if (msg.action === 'list-roots') data = await window.primeDeskAPI.fsListRoots();
        else if (msg.action === 'list-dir') data = await window.primeDeskAPI.fsListDir(msg.payload.path);
        else if (msg.action === 'mkdir') data = await window.primeDeskAPI.fsMakeDir(msg.payload.path);
        else if (msg.action === 'trash') data = await window.primeDeskAPI.fsTrash(msg.payload.paths);
        dc.send(JSON.stringify({ type: 'fs-res', reqId: msg.reqId, ok: true, data }));
      } catch (err) {
        dc.send(JSON.stringify({ type: 'fs-res', reqId: msg.reqId, ok: false, error: err.message }));
      }
    } else if (msg.type === 'fs-res') {
      const entry = this.pendingFileOps.get(msg.reqId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pendingFileOps.delete(msg.reqId);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(new Error(msg.error || 'Remote error'));
      }
    } else if (msg.type === 'fs-pull-req') {
      if (!this.permFile) {
        dc.send(JSON.stringify({
          type: 'transfer-error',
          message: 'Remote host disabled file transfer permission.'
        }));
        return;
      }
      const manifest = await window.primeDeskAPI.fsCollectItems(msg.sourcePaths);
      if (manifest && manifest.rootItems && manifest.rootItems.length > 0) {
        this.enqueueOutgoingTransfer({
          targetDir: msg.targetDir || null,
          purpose: msg.purpose || 'manager',
          manifest
        });
      }
    } else if (msg.type === 'fs-pull-cancel') {
      if (this.activeSendTransfer && (!msg.transferId || this.activeSendTransfer.transferId === msg.transferId)) {
        this.activeSendTransfer.aborted = true;
        this.transferQueue = [];
      }
    } else if (msg.type === 'transfer-error') {
      this.hideTransferToast();
      await this.showCustomAlert('File Transfer Blocked', msg.message || 'Transfer rejected.', 'warning');
    }
  }

  handleRemoteClipboardFilesReady(data) {
    if (this.pendingRemoteClipTimer) {
      clearTimeout(this.pendingRemoteClipTimer);
      this.pendingRemoteClipTimer = null;
    }
    if (!data || !data.paths || data.paths.length === 0) return;

    // Wait 900ms so Ctrl+C -> Ctrl+V purely inside the remote screen does not download unnecessarily
    this.pendingRemoteClipTimer = setTimeout(() => {
      this.pendingRemoteClipTimer = null;
      if ((data.totalSize || 0) <= FILE_CLIP_AUTO_MAX_BYTES) {
        this.pullRemoteClipboardFiles(data);
      } else {
        this.pendingRemoteClipData = data;
        if (this.dom.remoteClipBanner && this.dom.remoteClipBannerText) {
          const count = (data.rootItems || data.paths).length;
          const label = count === 1 && data.rootItems && data.rootItems[0]
            ? data.rootItems[0].name
            : `${count} items`;
          this.dom.remoteClipBannerText.textContent = `Remote copied ${label} (${this.formatBytes(data.totalSize)})`;
          this.dom.remoteClipBanner.style.display = 'flex';
        }
      }
    }, 900);
  }

  pullRemoteClipboardFiles(data) {
    if (!this.fileOpsChannel || this.fileOpsChannel.readyState !== 'open') return;
    this.fileOpsChannel.send(JSON.stringify({
      type: 'fs-pull-req',
      sourcePaths: data.paths,
      targetDir: null,
      purpose: 'clipboard'
    }));
  }

  // ==================== DUAL-PANE SUPPORT-GIVER FILE MANAGER ====================

  fmDom(side) {
    return {
      driveSelect: document.getElementById(`${side}DriveSelect`),
      upBtn: document.getElementById(`${side}UpBtn`),
      pathInput: document.getElementById(`${side}PathInput`),
      newFolderBtn: document.getElementById(`${side}NewFolderBtn`),
      refreshBtn: document.getElementById(`${side}RefreshBtn`),
      deleteBtn: document.getElementById(`${side}DeleteBtn`),
      newFolderRow: document.getElementById(`${side}NewFolderRow`),
      newFolderInput: document.getElementById(`${side}NewFolderInput`),
      createFolderConfirmBtn: document.getElementById(`${side}CreateFolderConfirmBtn`),
      createFolderCancelBtn: document.getElementById(`${side}CreateFolderCancelBtn`),
      selectAll: document.getElementById(`${side}SelectAll`),
      fileList: document.getElementById(`${side}FileList`),
      selCount: document.getElementById(`${side}SelCount`)
    };
  }

  fmBackend(side) {
    if (side === 'local') {
      return {
        listRoots: () => window.primeDeskAPI.fsListRoots(),
        listDir: (p) => window.primeDeskAPI.fsListDir(p),
        mkdir: (p) => window.primeDeskAPI.fsMakeDir(p),
        trash: (paths) => window.primeDeskAPI.fsTrash(paths)
      };
    }
    return {
      listRoots: () => this.callRemoteFs('list-roots'),
      listDir: (p) => this.callRemoteFs('list-dir', { path: p }),
      mkdir: (p) => this.callRemoteFs('mkdir', { path: p }),
      trash: (paths) => this.callRemoteFs('trash', { paths })
    };
  }

  initFileManagerEvents() {
    if (this.dom.closeFileManagerBtn) {
      this.dom.closeFileManagerBtn.addEventListener('click', () => {
        this.dom.fileManagerModal.style.display = 'none';
      });
    }
    if (this.dom.fmCancelTransferBtn) {
      this.dom.fmCancelTransferBtn.addEventListener('click', () => this.cancelCurrentTransfer());
    }
    if (this.dom.giveFilesBtn) {
      this.dom.giveFilesBtn.addEventListener('click', () => this.handleGiveFiles());
    }
    if (this.dom.takeFilesBtn) {
      this.dom.takeFilesBtn.addEventListener('click', () => this.handleTakeFiles());
    }

    document.querySelectorAll('[data-fm-shortcut]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [side, key] = btn.getAttribute('data-fm-shortcut').split(':');
        const roots = this.fmState[side] && this.fmState[side].roots;
        if (roots && roots.specialDirs && roots.specialDirs[key]) {
          this.loadFmDir(side, roots.specialDirs[key]);
        }
      });
    });

    for (const side of ['local', 'remote']) {
      const els = this.fmDom(side);
      if (!els.driveSelect) continue;

      els.driveSelect.addEventListener('change', (e) => this.loadFmDir(side, e.target.value));
      els.upBtn.addEventListener('click', () => {
        if (this.fmState[side].parent) {
          this.loadFmDir(side, this.fmState[side].parent);
        }
      });
      els.refreshBtn.addEventListener('click', () => this.loadFmDir(side, this.fmState[side].path));

      els.newFolderBtn.addEventListener('click', () => {
        els.newFolderRow.style.display = 'flex';
        els.newFolderInput.value = '';
        els.newFolderInput.focus();
      });
      els.createFolderCancelBtn.addEventListener('click', () => {
        els.newFolderRow.style.display = 'none';
      });
      const submitFolder = async () => {
        const folderName = els.newFolderInput.value.trim();
        if (!folderName || !this.fmState[side].path) return;
        const sep = this.fmState[side].path.endsWith('\\') || this.fmState[side].path.endsWith('/') ? '' : '\\';
        const res = await this.fmBackend(side).mkdir(`${this.fmState[side].path}${sep}${folderName}`);
        els.newFolderRow.style.display = 'none';
        if (res && res.ok) {
          await this.loadFmDir(side, this.fmState[side].path);
        } else {
          await this.showCustomAlert('Folder Error', (res && res.error) || 'Could not create folder.', 'error');
        }
      };
      els.createFolderConfirmBtn.addEventListener('click', submitFolder);
      els.newFolderInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitFolder();
        if (e.key === 'Escape') els.newFolderRow.style.display = 'none';
      });

      els.deleteBtn.addEventListener('click', async () => {
        const selected = [...this.fmState[side].selected];
        if (selected.length === 0) return;
        const ok = await this.showCustomConfirm(
          'Move to Recycle Bin',
          `Move ${selected.length} selected item(s) on ${side === 'local' ? 'Local PC' : 'Remote PC'} to Recycle Bin?`,
          'warning'
        );
        if (!ok) return;
        const res = await this.fmBackend(side).trash(selected);
        if (res && res.ok) {
          await this.loadFmDir(side, this.fmState[side].path);
        } else {
          await this.showCustomAlert('Delete Error', (res && res.error) || 'Could not remove selected items.', 'error');
        }
      });

      els.selectAll.addEventListener('change', (e) => {
        const state = this.fmState[side];
        state.selected.clear();
        if (e.target.checked) {
          state.entries.forEach(entry => state.selected.add(entry.path));
        }
        this.renderFmList(side);
      });
    }
  }

  async openFileManager() {
    if (!this.fileChannel || this.fileChannel.readyState !== 'open' || !this.fileOpsChannel || this.fileOpsChannel.readyState !== 'open') {
      await this.showCustomAlert('Not Connected', 'File manager requires an active remote session.', 'warning');
      return;
    }
    this.dom.fileManagerModal.style.display = 'flex';
    if (this.dom.fmTransferStatus && !this.activeSendTransfer && !this.activeReceiveTransfer) {
      this.dom.fmTransferStatus.textContent = 'Ready — Select files/folders to Give or Take';
      this.dom.fmTransferPercent.textContent = '0%';
      this.dom.fmTransferProgressBar.style.width = '0%';
    }

    await Promise.all([this.initFmPane('local'), this.initFmPane('remote')]);
  }

  async initFmPane(side) {
    try {
      const roots = await this.fmBackend(side).listRoots();
      this.fmState[side].roots = roots;
      const els = this.fmDom(side);
      els.driveSelect.innerHTML = '';
      (roots.drives || []).forEach((drv) => {
        const opt = document.createElement('option');
        opt.value = drv;
        opt.textContent = drv;
        els.driveSelect.appendChild(opt);
      });
      const startPath = this.fmState[side].path || (roots.specialDirs && roots.specialDirs.desktop) || (roots.drives && roots.drives[0]);
      await this.loadFmDir(side, startPath);
    } catch (err) {
      await this.showCustomAlert(
        `${side === 'local' ? 'Local' : 'Remote'} File Browser Error`,
        err.message,
        'warning'
      );
    }
  }

  async loadFmDir(side, dirPath) {
    try {
      const res = await this.fmBackend(side).listDir(dirPath);
      if (!res || !res.ok) {
        await this.showCustomAlert('Folder Access Error', (res && res.error) || 'Unable to open folder.', 'warning');
        return;
      }
      const state = this.fmState[side];
      state.path = res.path;
      state.parent = res.parent;
      state.entries = res.entries || [];
      state.selected.clear();

      const els = this.fmDom(side);
      els.pathInput.value = res.path;
      els.selectAll.checked = false;
      const driveRoot = res.path.slice(0, 3).toUpperCase();
      for (const opt of els.driveSelect.options) {
        if (opt.value.toUpperCase() === driveRoot) {
          els.driveSelect.value = opt.value;
          break;
        }
      }
      this.renderFmList(side);
    } catch (err) {
      await this.showCustomAlert('Directory Error', err.message, 'warning');
    }
  }

  renderFmList(side) {
    const state = this.fmState[side];
    const els = this.fmDom(side);
    els.fileList.innerHTML = '';
    els.selCount.textContent = `${state.selected.size} selected`;

    if (state.entries.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3;
      td.style.color = '#64748b';
      td.style.textAlign = 'center';
      td.style.padding = '24px';
      td.textContent = 'Folder is empty';
      tr.appendChild(td);
      els.fileList.appendChild(tr);
      return;
    }

    for (const entry of state.entries) {
      const tr = document.createElement('tr');
      const isSelected = state.selected.has(entry.path);
      tr.className = `fm-row${isSelected ? ' selected' : ''}`;

      const tdCheck = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isSelected;
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cb.checked) state.selected.add(entry.path);
        else state.selected.delete(entry.path);
        tr.classList.toggle('selected', cb.checked);
        els.selCount.textContent = `${state.selected.size} selected`;
      });
      tdCheck.appendChild(cb);

      const tdName = document.createElement('td');
      const nameWrap = document.createElement('div');
      nameWrap.className = 'fm-name-cell';
      const iconSpan = document.createElement('span');
      iconSpan.textContent = entry.isDir ? '📁' : '📄';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = entry.name;
      nameWrap.appendChild(iconSpan);
      nameWrap.appendChild(labelSpan);
      tdName.appendChild(nameWrap);

      const tdSize = document.createElement('td');
      tdSize.textContent = entry.isDir ? 'Folder' : this.formatBytes(entry.size);

      tr.addEventListener('click', () => {
        const next = !state.selected.has(entry.path);
        if (next) state.selected.add(entry.path);
        else state.selected.delete(entry.path);
        cb.checked = next;
        tr.classList.toggle('selected', next);
        els.selCount.textContent = `${state.selected.size} selected`;
      });

      tr.addEventListener('dblclick', () => {
        if (entry.isDir) {
          this.loadFmDir(side, entry.path);
        }
      });

      tr.appendChild(tdCheck);
      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      els.fileList.appendChild(tr);
    }
  }

  async handleGiveFiles() {
    const selected = [...this.fmState.local.selected];
    const targetDir = this.fmState.remote.path;
    if (selected.length === 0) {
      await this.showCustomAlert('Select Files', 'Select one or more local files or folders to Give (send to Remote PC).', 'info');
      return;
    }
    if (!targetDir) {
      await this.showCustomAlert('Remote Folder Missing', 'Open a destination folder on the Remote PC pane first.', 'warning');
      return;
    }
    const manifest = await window.primeDeskAPI.fsCollectItems(selected);
    if (!manifest || !manifest.rootItems || manifest.rootItems.length === 0) {
      await this.showCustomAlert('Nothing to Send', 'Selected items could not be read.', 'warning');
      return;
    }
    this.enqueueOutgoingTransfer({ targetDir, purpose: 'manager', manifest });
  }

  async handleTakeFiles() {
    const selected = [...this.fmState.remote.selected];
    const targetDir = this.fmState.local.path || await window.primeDeskAPI.getDownloadsDir();
    if (selected.length === 0) {
      await this.showCustomAlert('Select Files', 'Select one or more remote files or folders to Take (download to your PC).', 'info');
      return;
    }
    this.fileOpsChannel.send(JSON.stringify({
      type: 'fs-pull-req',
      sourcePaths: selected,
      targetDir,
      purpose: 'manager'
    }));
  }

  endSession() {
    this.hideConnectingOverlay();
    this.cleanupFileTransfers();
    if (this.dom.fileManagerModal) this.dom.fileManagerModal.style.display = 'none';
    if (this.dom.remoteClipBanner) this.dom.remoteClipBanner.style.display = 'none';
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
      this.role = null;
      this.pendingConnectCode = null;
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
