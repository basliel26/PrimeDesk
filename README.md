# PrimeDesk 

> **Enterprise-Grade WebRTC Remote Desktop Support Suite**  
> *100% Free Forever • Zero Subscriptions • Zero Commercial Paywalls or Time Limits*

[![Build Windows Binaries](https://github.com/basliel26/PrimeDesk/actions/workflows/build.yml/badge.svg)](https://github.com/basliel26/PrimeDesk/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/basliel26/PrimeDesk?color=0284c7&label=Release)](https://github.com/basliel26/PrimeDesk/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)

---

## ⚡ Overview

**PrimeDesk** is an open-source, peer-to-peer remote desktop application engineered to replace commercial tools like AnyDesk and TeamViewer. Designed for technical support teams and remote workstations, it provides instant, low-latency remote control without monthly licensing fees, foreign exchange constraints, or countdown nag screens.

---

## 🚀 Download Standalone Binaries (Windows 10 / 11 / Server)

Pre-compiled standalone Windows executables are automatically generated and published directly on GitHub Releases:

📦 **[Download Latest PrimeDesk Release (v1.0.2)](https://github.com/basliel26/PrimeDesk/releases/latest)**

- **`PrimeDesk-Setup.exe`**: Full Windows installer with desktop shortcut, start menu entry, and auto-start integration.
- **`PrimeDesk-Portable.exe`**: Zero-installation single executable. Runs instantly from a USB flash drive or any folder.

---

## 🌟 Key Features

| Category | Capability | Details |
| :--- | :--- | :--- |
| **Workflow** | **AnyDesk Connection Workflow** | Terminals stay auto-ready on launch. Technicians dial the 6-digit address, and remote users get an instant **Accept / Decline** prompt with safety checklist. |
| **Access** | **Unattended Server Mode** | Cryptographically salted SHA-256 password authentication allows after-hours server maintenance without local staff interaction. |
| **Directory** | **Device Directory** | Save client workstations and servers with custom labels and credentials for instant one-click connection. |
| **Input** | **Sub-Millisecond Native Input** | Ultra-fast native C# worker (`PrimeInput.exe`) utilizing Windows `user32.dll` (`SendInput`, `mouse_event`, `SetCursorPos`, `LockWorkStation`). |
| **Privacy** | **Privacy Mode** | Technician can toggle a full-screen blackout overlay on the physical remote monitor to protect confidential data during maintenance. |
| **Shortcuts** | **Windows System Actions** | One-click triggers for `Ctrl+Shift+Esc` (Task Manager), `Win+D` (Show Desktop), and `Win+L` (Lock Workstation). |
| **Data Sync** | **Bidirectional Clipboard & Files** | Real-time clipboard synchronization and direct WebRTC chunked file transfers (updates, software patches, logs). |
| **Communication** | **Built-in Support Chat** | Slide-out support drawer with unread message badges and sound notifications. |
| **Networking** | **Offline LAN & Proxy Engine** | Operates across isolated local Wi-Fi or Ethernet networks with **zero internet**. Supports institutional HTTP/SOCKS5 proxies (Squid). |
| **Compliance** | **Session Recording & Auto-Lock** | Automatically records sessions to `.webm` video for security auditing and auto-locks Windows when sessions disconnect. |

---

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph Host ["Remote Workstation (Host)"]
        H_UI["PrimeDesk UI"]
        H_Cap["Electron Desktop Capturer (DXGI Duplication)"]
        H_Input["Native C# Worker (PrimeInput.exe)"]
        H_Priv["Privacy Mode Blackout Window"]
    end

    subgraph Signaling ["Handshake Layer"]
        Sig["PrimeDesk WebSocket Server (:9000 / Cloud)"]
    end

    subgraph Vendor ["Support Technician (Viewer)"]
        V_UI["PrimeDesk Remote Viewport"]
        V_Input["Input Tracking & Resolution Scaling"]
        V_Rec["MediaRecorder Audit Capture"]
    end

    H_UI <-->|Auto-Register 6-Digit Address| Sig
    V_UI <-->|Request Connection| Sig
    H_Cap ===|WebRTC DTLS/SRTP Video & Audio (P2P)| V_UI
    V_Input ===|RTCDataChannel Input Events| H_Input
    H_UI -.->|Blackout Screen| H_Priv
```

---

## ⚙️ Enterprise Settings Suite

PrimeDesk features a Windows 11 Fluent preferences interface organized into 7 domains:

1. **General & System**: Startup with Windows registry hook, minimize to notification tray, system sleep prevention.
2. **Network & Proxy**: Cloud Internet vs Offline mode, automatic endpoint resolution, institutional HTTP/SOCKS5 proxy configuration (Squid).
3. **Display & Streaming**: Target framerate (`60 FPS`, `30 FPS`, `15 FPS`), latency vs sharpness profiles, DirectX DXGI hardware capture.
4. **Audio & Media**: Remote audio capture, physical host speaker muting.
5. **Security & Access**: Unattended master password, operator permission checklist, Auto-Lock on Disconnect.
6. **Session Recording & Audit**: Automatic WebM video recording, native Windows folder selector, connection audit logs.
7. **About & Diagnostics**: Architecture specifications, WebRTC encryption verification, MIT license.

---

## ☁️ Free Cloud Signaling Deployment

For remote support across different cities over the public internet, deploy the included signaling server to [Render.com](https://render.com) (or Railway/Koyeb) for free:

### 1-Click Render.com Deployment:
1. Log in to [render.com](https://render.com) and click **New +** ➔ **Web Service**.
2. Connect your GitHub repository: `basliel26/PrimeDesk`.
3. Settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install --omit=dev`
   - **Start Command**: `npm run server`
   - **Instance Type**: `Free`
4. Copy the generated WebSocket URL (e.g. `wss://primedesk-signal.onrender.com`) and paste it into PrimeDesk **Preferences ➔ Network & Proxy**.

---

## 💻 Local Development & Build

### Prerequisites
- [Node.js](https://nodejs.org/) (v20 recommended)
- Windows 10/11 or Windows Server

### Run Locally:
```bash
# Clone the repository
git clone https://github.com/basliel26/PrimeDesk.git
cd PrimeDesk

# Install dependencies
npm install

# Start local signaling server
npm run server

# In a separate terminal, launch PrimeDesk
npm start
```

### Build Windows Binaries Locally:
```bash
npm run dist
```
*Compiled installer (`PrimeDesk-Setup-1.0.0.exe`) and portable standalone (`PrimeDesk-Portable-1.0.0.exe`) will be generated inside the `dist/` directory.*

---

## 🛡️ Security & Privacy

- **End-to-End Encryption**: Video, audio, input, and data channels are encrypted using WebRTC DTLS 1.2 / SRTP / Ed25519.
- **Direct P2P**: Video frames travel directly between computers without traversing intermediate cloud storage.
- **Operator Confidentiality**: Privacy Mode prevents on-site bystanders from viewing sensitive data while remote maintenance is active.

---

## 👤 Author & Maintainer

**Basliel Getu**  
- GitHub: [@basliel26](https://github.com/basliel26)  
- Project Repository: [github.com/basliel26/PrimeDesk](https://github.com/basliel26/PrimeDesk)

---

## 📄 License

Distributed under the **MIT Open Source License**. Free for commercial and private use.
