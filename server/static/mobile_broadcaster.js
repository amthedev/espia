const params = new URLSearchParams(window.location.search);
const room = params.get("room") || "sala1";
const localVideo = document.getElementById("localVideo");
const mobileBadge = document.getElementById("mobileBadge");

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

let ws = null;
let localStream = null;
const peers = new Map();
let serverRecorder = null;
let recordSessionId = null;
let shutdownStarted = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

function setBadge(text) {
  if (!mobileBadge) return;
  mobileBadge.textContent = text;
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws/${encodeURIComponent(room)}/broadcaster`;
}

function sendSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

async function startServerRecording(stream) {
  let currentSession = null;
  try {
    const startRes = await fetch(`/api/record/start/${encodeURIComponent(room)}`, { method: "POST" });
    const startData = await startRes.json();
    if (!startRes.ok || !startData.sessionId) {
      throw new Error("Falha ao iniciar gravacao no servidor.");
    }

    currentSession = startData.sessionId;
    recordSessionId = currentSession;

    try {
      serverRecorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus" });
    } catch {
      serverRecorder = new MediaRecorder(stream);
    }

    serverRecorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size === 0 || !recordSessionId) return;
      try {
        await fetch(`/api/record/chunk/${encodeURIComponent(room)}?session=${encodeURIComponent(recordSessionId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: event.data,
        });
      } catch (error) {
        console.error("Falha ao enviar chunk:", error);
      }
    };

    serverRecorder.start(2000);
    return true;
  } catch (error) {
    console.error("Falha ao iniciar gravacao no servidor:", error);
    serverRecorder = null;
    recordSessionId = null;

    if (currentSession) {
      try {
        await fetch(`/api/record/stop/${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: currentSession }),
        });
      } catch {
        // Ignora erro no cleanup da sessao.
      }
    }

    return false;
  }
}

async function stopServerRecording() {
  const currentSession = recordSessionId;
  recordSessionId = null;

  if (serverRecorder && serverRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      serverRecorder.onstop = resolve;
      serverRecorder.stop();
    });
  }
  serverRecorder = null;

  if (!currentSession) return;
  try {
    await fetch(`/api/record/stop/${encodeURIComponent(room)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSession }),
      keepalive: true,
    });
  } catch {
    // Ignora erro no fechamento.
  }
}

function stopLocalStream() {
  if (!localStream) return;
  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;
}

async function shutdownTransmitter() {
  if (shutdownStarted) return;
  shutdownStarted = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  peers.forEach((pc) => pc.close());
  peers.clear();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  ws = null;

  await stopServerRecording();
  stopLocalStream();
}

function scheduleReconnect() {
  if (shutdownStarted) return;
  if (reconnectTimer) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  reconnectAttempts += 1;
  const delayMs = Math.min(1000 * reconnectAttempts, 5000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, delayMs);
}

function connectSocket() {
  console.info("[mobile_broadcaster] conectando websocket...");
  setBadge("Conectando ao servidor...");
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    console.info("[mobile_broadcaster] websocket conectado.");
    reconnectAttempts = 0;
    setBadge(`Transmitindo em ${room}`);
  };

  ws.onclose = () => {
    console.warn("[mobile_broadcaster] websocket fechado; tentando reconectar.");
    if (!shutdownStarted) {
      setBadge("Reconectando transmissao...");
      ws = null;
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    console.error("[mobile_broadcaster] erro no websocket.");
    setBadge("Erro ao conectar no servidor");
    if (!shutdownStarted) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "viewer_joined") {
      console.info(`[mobile_broadcaster] viewer conectado: ${msg.viewerId}`);
      await createPeer(msg.viewerId);
      return;
    }

    if (msg.type === "viewer_left") {
      console.info(`[mobile_broadcaster] viewer saiu: ${msg.viewerId}`);
      const pc = peers.get(msg.viewerId);
      if (pc) {
        pc.close();
        peers.delete(msg.viewerId);
      }
      return;
    }

    if (msg.type === "answer") {
      const pc = peers.get(msg.from);
      if (!pc || !msg.sdp) return;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      return;
    }

    if (msg.type === "ice") {
      const pc = peers.get(msg.from);
      if (!pc || !msg.candidate) return;
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      return;
    }

    if (msg.type === "error") {
      console.error("Erro de sinalizacao:", msg.message || "erro desconhecido");
      scheduleReconnect();
    }
  };
}

async function createPeer(viewerId) {
  if (!localStream || peers.has(viewerId)) return;
  console.info(`[mobile_broadcaster] criando peer para viewer ${viewerId}`);
  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(viewerId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendSignal({ type: "ice", target: viewerId, candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      pc.close();
      peers.delete(viewerId);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: "offer", target: viewerId, sdp: pc.localDescription });
}

async function getLocalMediaWithRetry(maxAttempts = 4) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Navegador/WebView sem suporte a getUserMedia.");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.info(`[mobile_broadcaster] solicitando camera/microfone (tentativa ${attempt}/${maxAttempts})`);
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (error) {
      lastError = error;
      console.error(`Falha ao acessar camera/microfone (tentativa ${attempt}/${maxAttempts}):`, error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }

  throw lastError || new Error("Falha desconhecida ao iniciar camera/microfone.");
}

async function boot() {
  try {
    console.info("[mobile_broadcaster] inicializando transmissor...");
    setBadge("Solicitando camera...");
    localStream = await getLocalMediaWithRetry();
    console.info("[mobile_broadcaster] camera/microfone ativos.");
    setBadge("Camera ativa, conectando...");
    localVideo.srcObject = localStream;
    connectSocket();

    const recordingStarted = await startServerRecording(localStream);
    if (!recordingStarted) {
      console.warn("Transmissao ao vivo iniciada sem gravacao no servidor.");
    }
  } catch (error) {
    console.error("Falha ao iniciar transmissao:", error);
    setBadge("Falha ao iniciar transmissao");
    await shutdownTransmitter();
  }
}

window.addEventListener("beforeunload", () => {
  void shutdownTransmitter();
});

window.addEventListener("pagehide", () => {
  void shutdownTransmitter();
});

boot();
