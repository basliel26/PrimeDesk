const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 9000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', service: 'PrimeDesk Signaling Server', timestamp: Date.now() }));
});

const wss = new WebSocket.Server({ server });
const rooms = new Map(); // code -> { hostWs, viewerWs }

wss.on('connection', (ws) => {
  let userCode = null;
  let userRole = null;

  ws.on('message', (messageStr) => {
    try {
      const msg = JSON.parse(messageStr);

      switch (msg.type) {
        case 'register-host': {
          userCode = msg.code;
          userRole = 'host';
          rooms.set(userCode, { hostWs: ws, viewerWs: null });
          ws.send(JSON.stringify({ type: 'registered', code: userCode }));
          console.log(`[Signaling] Host registered with code: ${userCode}`);
          break;
        }

        case 'join-session': {
          userCode = msg.code;
          userRole = 'viewer';
          const room = rooms.get(userCode);
          if (!room || !room.hostWs) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session code not found or host is offline.' }));
            return;
          }

          room.viewerWs = ws;
          ws.send(JSON.stringify({ type: 'joined', code: userCode }));
          // Notify host that viewer joined, so host can prepare or initiate
          room.hostWs.send(JSON.stringify({ type: 'viewer-joined' }));
          console.log(`[Signaling] Viewer joined room: ${userCode}`);
          break;
        }

        case 'signal': {
          const room = rooms.get(userCode);
          if (!room) return;

          const target = userRole === 'host' ? room.viewerWs : room.hostWs;
          if (target && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({ type: 'signal', data: msg.data }));
          }
          break;
        }

        case 'leave': {
          cleanup();
          break;
        }
      }
    } catch (e) {
      console.error('[Signaling] Parse error:', e);
    }
  });

  const cleanup = () => {
    if (userCode && rooms.has(userCode)) {
      const room = rooms.get(userCode);
      if (userRole === 'host') {
        if (room.viewerWs && room.viewerWs.readyState === WebSocket.OPEN) {
          room.viewerWs.send(JSON.stringify({ type: 'session-ended', reason: 'Host disconnected' }));
        }
        rooms.delete(userCode);
        console.log(`[Signaling] Room destroyed: ${userCode}`);
      } else if (userRole === 'viewer') {
        if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
          room.hostWs.send(JSON.stringify({ type: 'session-ended', reason: 'Viewer disconnected' }));
        }
        room.viewerWs = null;
        console.log(`[Signaling] Viewer left room: ${userCode}`);
      }
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`[PrimeDesk] Signaling Server running on port ${PORT}`);
});
