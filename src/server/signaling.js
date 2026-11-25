const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 9000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', service: 'PrimeDesk Signaling Server', timestamp: Date.now() }));
});

const wss = new WebSocket.Server({ server });
const rooms = new Map(); // code -> { hostWs, hostToken, viewerWs, code, connectTimes }
const CODE_REGEX = /^\d{9}$/;

function isRoomHostAlive(room) {
  return Boolean(room && room.hostWs && room.hostWs.readyState === WebSocket.OPEN);
}

wss.on('connection', (ws, req) => {
  let userCode = null;
  let userRole = null;

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

  const registerHost = (rawCode, token = '') => {
    if (!CODE_REGEX.test(rawCode || '')) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid 9-digit terminal code.' }));
      return;
    }
    const existing = rooms.get(rawCode);
    if (isRoomHostAlive(existing) && existing.hostWs !== ws) {
      if (existing.hostToken && token && existing.hostToken !== token) {
        ws.send(JSON.stringify({ type: 'code-taken', code: rawCode }));
        return;
      }
      // Same host reconnecting — supersede stale socket cleanly
      try { existing.hostWs.close(1000, 'Superseded'); } catch (e) {}
    }

    userCode = rawCode;
    userRole = 'host';
    rooms.set(rawCode, {
      hostWs: ws,
      hostToken: token || '',
      viewerWs: null,
      code: rawCode,
      connectTimes: (existing && existing.connectTimes) || []
    });
    ws.send(JSON.stringify({ type: 'registered', code: rawCode }));
    console.log(`[Signaling] Terminal registered: ${rawCode}`);
  };

  // Optional query-param registration (?role=host|viewer&code=XXXXXXXXX&token=...) for Cloudflare parity
  try {
    const reqUrl = new URL(req.url || '/', 'http://localhost');
    const qRole = reqUrl.searchParams.get('role');
    const qCode = reqUrl.searchParams.get('code');
    const qToken = reqUrl.searchParams.get('token') || '';
    if (qRole === 'host' && qCode) {
      registerHost(qCode, qToken);
    }
  } catch (e) {}

  ws.on('message', (messageStr) => {
    try {
      const msg = JSON.parse(messageStr);

      switch (msg.type) {
        case 'register-host': {
          registerHost(msg.code, msg.token || '');
          break;
        }

        case 'request-connect': {
          const targetCode = msg.code;
          if (!CODE_REGEX.test(targetCode || '')) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid 9-digit terminal address.' }));
            return;
          }
          const room = rooms.get(targetCode);

          if (!isRoomHostAlive(room)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Remote device not found or offline.' }));
            return;
          }

          const now = Date.now();
          room.connectTimes = (room.connectTimes || []).filter(t => now - t < 30000);
          if (room.connectTimes.length >= 8) {
            ws.send(JSON.stringify({ type: 'error', message: 'Too many connection attempts. Please wait a few seconds.' }));
            return;
          }
          room.connectTimes.push(now);

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
