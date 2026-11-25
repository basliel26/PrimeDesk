const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 9000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', service: 'PrimeDesk Signaling Server', timestamp: Date.now() }));
});

const wss = new WebSocket.Server({ server });
const rooms = new Map(); // code -> { hostWs, viewerWs, code }

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
          rooms.set(userCode, { hostWs: ws, viewerWs: null, code: userCode });
          ws.send(JSON.stringify({ type: 'registered', code: userCode }));
          console.log(`[Signaling] Terminal registered: ${userCode}`);
          break;
        }

        case 'request-connect': {
          const targetCode = msg.code;
          const room = rooms.get(targetCode);

          if (!room || !room.hostWs || room.hostWs.readyState !== WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Remote device not found or offline.' }));
            return;
          }

          if (room.viewerWs && room.viewerWs.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Terminal is currently in another active session.' }));
            return;
          }

          userCode = targetCode;
          userRole = 'viewer';
          room.viewerWs = ws;

          // Forward connection request to host
          room.hostWs.send(JSON.stringify({
            type: 'incoming-connection',
            clientName: msg.clientName || 'Support Technician',
            unattendedPass: msg.unattendedPass || null
          }));
          console.log(`[Signaling] Connection request sent to terminal: ${targetCode}`);
          break;
        }

        case 'accept-connection': {
          const room = rooms.get(userCode);
          if (room && room.viewerWs && room.viewerWs.readyState === WebSocket.OPEN) {
            room.viewerWs.send(JSON.stringify({ type: 'connection-accepted' }));
          }
          break;
        }

        case 'decline-connection': {
          const room = rooms.get(userCode);
          if (room && room.viewerWs && room.viewerWs.readyState === WebSocket.OPEN) {
            room.viewerWs.send(JSON.stringify({ type: 'connection-declined', reason: msg.reason || 'Declined by remote user' }));
            room.viewerWs = null;
          }
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

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
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
        if (room.hostWs === ws) {
          if (room.viewerWs && room.viewerWs.readyState === WebSocket.OPEN) {
            room.viewerWs.send(JSON.stringify({ type: 'session-ended', reason: 'Remote device disconnected' }));
          }
          rooms.delete(userCode);
          console.log(`[Signaling] Terminal offline: ${userCode}`);
        }
      } else if (userRole === 'viewer') {
        if (room.viewerWs === ws) {
          if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
            room.hostWs.send(JSON.stringify({ type: 'session-ended', reason: 'Support technician disconnected' }));
          }
          room.viewerWs = null;
          console.log(`[Signaling] Support technician disconnected from: ${userCode}`);
        }
      }
    }
    userCode = null;
    userRole = null;
  };

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

const keepaliveInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(keepaliveInterval));

server.listen(PORT, () => {
  console.log(`[PrimeDesk] Enterprise Signaling Server active on port ${PORT}`);
});
