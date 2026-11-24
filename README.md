# PrimeDesk 🏥🖥️

> **High-Performance WebRTC Remote Desktop Support Tool for Hospital EHR Systems**

**PrimeDesk** is a lightweight, zero-subscription, peer-to-peer remote desktop application engineered to replace commercial tools like AnyDesk. Designed specifically for software vendors supporting hospital Electronic Health Record (EHR) installations, it delivers fast, encrypted, low-latency remote access without monthly fees or commercial limits.

---

## ⚡ Highlights

- **Direct P2P Streaming:** Streams 60 FPS video directly between the vendor and the hospital via **WebRTC**, bypassing intermediate video relay bottlenecks.
- **Ultra-Simple Hospital UX:** Non-technical hospital staff simply click *"Start Sharing"* and read a 6-digit code (e.g. `582 914`) to technical support.
- **Native Windows Input Injection:** Zero-overhead C# input worker leveraging Windows `user32.dll` (`SendInput`, `SetCursorPos`, `mouse_event`) with sub-millisecond execution latency.
- **Privacy & Security First:** DTLS-SRTP end-to-end encrypted video and data channels ensure patient health records (EHR) remain strictly confidential.
- **Zero Recurring Costs:** Operates using standard free Google STUN servers and a lightweight WebSocket handshake server with no paid cloud infrastructure required.

---

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph Hospital ["Hospital Terminal (Host)"]
        H_UI["PrimeDesk UI"]
        H_Cap["Electron Desktop Capturer (DXGI)"]
        H_Input["Native PrimeInput.exe (SendInput)"]
    end

    subgraph Signaling ["Handshake Layer"]
        Sig["PrimeDesk WebSocket Signaling Server (:9000)"]
    end

    subgraph Vendor ["EHR Vendor (Support Client)"]
        V_UI["PrimeDesk Remote Viewer"]
        V_Input["Mouse & Keyboard Event Capture"]
    end

    H_UI <-->|Register 6-Digit Code| Sig
    V_UI <-->|Connect with Code| Sig
    H_Cap ===|WebRTC Encrypted Video Stream (P2P)| V_UI
    V_Input ===|RTCDataChannel Mouse/Key Events| H_Input
```

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- Windows 10/11 or Windows Server

### 1. Start the Signaling Server
```bash
npm run server
```
*The signaling server starts on `ws://localhost:9000` (or set `PORT` in environment).*

### 2. Launch the PrimeDesk App
```bash
npm start
```

---

## 📂 Project Structure

```text
PrimeDesk/
├── assets/                  # High-res icons (.ico, .png, logos)
├── src/
│   ├── main/
│   │   ├── main.js          # Electron main process & IPC handlers
│   │   ├── preload.js       # Secure context bridge API
│   │   └── inputHandler.js  # Stdio bridge to native Windows input worker
│   ├── renderer/
│   │   ├── index.html       # Clean medical dark-theme dashboard
│   │   ├── app.css          # Modern styling and viewport layout
│   │   └── app.js           # WebRTC peer connection, signaling & input tracking
│   ├── native/
│   │   ├── PrimeInput.cs    # Native Windows C# input worker
│   │   └── PrimeInput.exe   # Compiled sub-millisecond input engine
│   └── server/
│       └── signaling.js     # WebSocket rendezvous and room manager
├── package.json
└── README.md
```

---

## 🛡️ Security & EHR Compliance
- No remote video or patient data is ever recorded or stored on any intermediate server.
- The hospital operator has immediate visibility over remote control and can terminate the session instantly with a single click.

---

## 👤 Author
**Basliel Getu**  
- GitHub: [@basliel26](https://github.com/basliel26)
