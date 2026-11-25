import { DurableObject } from "cloudflare:workers";

const CODE_REGEX = /^\d{9}$/;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function sendJson(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (e) {}
}

export class SignalingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.recentViewerConnects = [];
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
  }

  pruneConnectWindow(now) {
    const cutoff = now - 30000;
    while (this.recentViewerConnects.length > 0 && this.recentViewerConnects[0] < cutoff) {
      this.recentViewerConnects.shift();
    }
  }

  closePeerSockets(tag, notifyPayload, reasonText, excludeWs = null) {
    for (const peer of this.ctx.getWebSockets(tag)) {
      if (peer === excludeWs) continue;
      const meta = peer.deserializeAttachment() || {};
      if (!meta.ended) {
        peer.serializeAttachment({ ...meta, ended: true });
        if (notifyPayload) sendJson(peer, notifyPayload);
      }
      try { peer.close(1000, reasonText || "Session ended"); } catch (e) {}
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ status: "online", service: "PrimeDesk Edge Signaling" });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const code = url.searchParams.get("code");
    const token = url.searchParams.get("token") || "";

    if ((role !== "host" && role !== "viewer") || !CODE_REGEX.test(code || "")) {
      return jsonResponse({ error: "Invalid signaling role or 9-digit code" }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === "host") {
      const existingHosts = this.ctx.getWebSockets("host");
      for (const oldHost of existingHosts) {
        const meta = oldHost.deserializeAttachment() || {};
        if (meta.token && token && meta.token !== token) {
          this.ctx.acceptWebSocket(server, ["ephemeral"]);
          server.serializeAttachment({ ended: true });
          sendJson(server, { type: "code-taken", code });
          try { server.close(4001, "Address already in use"); } catch (e) {}
          return new Response(null, { status: 101, webSocket: client });
        }
        // Same host reconnecting after network blip — supersede cleanly
        oldHost.serializeAttachment({ ...meta, ended: true });
        try { oldHost.close(1000, "Superseded"); } catch (e) {}
      }

      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ role: "host", code, token, ended: false });
      sendJson(server, { type: "registered", code });
      return new Response(null, { status: 101, webSocket: client });
    }

    // Viewer connection into target terminal room
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.serializeAttachment({ role: "viewer", code, ended: false });

    const now = Date.now();
    this.pruneConnectWindow(now);
    if (this.recentViewerConnects.length >= 8) {
      server.serializeAttachment({ role: "viewer", code, ended: true });
      sendJson(server, { type: "error", message: "Too many connection attempts. Please wait a few seconds." });
      try { server.close(4008, "Rate limited"); } catch (e) {}
      return new Response(null, { status: 101, webSocket: client });
    }
    this.recentViewerConnects.push(now);

    const hosts = this.ctx.getWebSockets("host");
    if (hosts.length === 0) {
      server.serializeAttachment({ role: "viewer", code, ended: true });
      sendJson(server, { type: "error", message: "Remote device not found or offline." });
      try { server.close(4004, "Host offline"); } catch (e) {}
      return new Response(null, { status: 101, webSocket: client });
    }

    const activeViewers = this.ctx.getWebSockets("viewer").filter((v) => {
      if (v === server) return false;
      const vMeta = v.deserializeAttachment() || {};
      return !vMeta.ended;
    });
    if (activeViewers.length > 0) {
      server.serializeAttachment({ role: "viewer", code, ended: true });
      sendJson(server, { type: "error", message: "Terminal is currently in another active session." });
      try { server.close(4009, "Room busy"); } catch (e) {}
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch (e) {
      return;
    }

    if (msg.type === "ping") {
      sendJson(ws, { type: "pong" });
      return;
    }

    const tags = this.ctx.getTags(ws);
    const isHost = tags.includes("host");
    const isViewer = tags.includes("viewer");
    const meta = ws.deserializeAttachment() || {};
    if (meta.ended) return;

    if (isHost) {
      const viewers = this.ctx.getWebSockets("viewer");
      switch (msg.type) {
        case "register-host":
          sendJson(ws, { type: "registered", code: meta.code });
          break;
        case "accept-connection":
          for (const v of viewers) sendJson(v, { type: "connection-accepted" });
          break;
        case "decline-connection":
          this.closePeerSockets("viewer", { type: "connection-declined", reason: msg.reason || "Declined by remote user" }, "Declined");
          break;
        case "signal":
          for (const v of viewers) sendJson(v, { type: "signal", data: msg.data });
          break;
        case "leave":
          this.closePeerSockets("viewer", { type: "session-ended", reason: "Remote device disconnected" }, "Host left");
          break;
      }
      return;
    }

    if (isViewer) {
      const hosts = this.ctx.getWebSockets("host");
      if (hosts.length === 0) {
        ws.serializeAttachment({ ...meta, ended: true });
        sendJson(ws, { type: "error", message: "Remote device not found or offline." });
        try { ws.close(4004, "Host offline"); } catch (e) {}
        return;
      }

      switch (msg.type) {
        case "request-connect":
          for (const h of hosts) {
            sendJson(h, {
              type: "incoming-connection",
              clientName: msg.clientName || "Support Technician",
              unattendedPass: msg.unattendedPass || null
            });
          }
          break;
        case "signal":
          for (const h of hosts) sendJson(h, { type: "signal", data: msg.data });
          break;
        case "leave":
          ws.serializeAttachment({ ...meta, ended: true });
          for (const h of hosts) {
            sendJson(h, { type: "session-ended", reason: "Support technician disconnected" });
          }
          try { ws.close(1000, "Viewer left"); } catch (e) {}
          break;
      }
    }
  }

  handleDisconnect(ws) {
    const tags = this.ctx.getTags(ws);
    const meta = ws.deserializeAttachment() || {};
    if (meta.ended) return;
    ws.serializeAttachment({ ...meta, ended: true });

    if (tags.includes("host")) {
      this.closePeerSockets("viewer", { type: "session-ended", reason: "Remote device disconnected" }, "Host disconnected");
    } else if (tags.includes("viewer")) {
      for (const h of this.ctx.getWebSockets("host")) {
        sendJson(h, { type: "session-ended", reason: "Support technician disconnected" });
      }
    }
  }

  async webSocketClose(ws, code) {
    this.handleDisconnect(ws);
    try { ws.close(code || 1000, "Closed"); } catch (e) {}
  }

  async webSocketError(ws) {
    this.handleDisconnect(ws);
    try { ws.close(1011, "WebSocket error"); } catch (e) {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({
        status: "online",
        service: "PrimeDesk Edge Signaling",
        protocol: "9-digit",
        timestamp: Date.now()
      });
    }

    const code = url.searchParams.get("code") || "";
    const role = url.searchParams.get("role") || "";
    if (!CODE_REGEX.test(code) || (role !== "host" && role !== "viewer")) {
      return jsonResponse({ error: "Expected ?role=host|viewer&code=<9-digits>" }, 400);
    }

    const id = env.ROOMS.idFromName(code);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  }
};
