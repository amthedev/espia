const params = new URLSearchParams(window.location.search);
const room = params.get("room") || "sala1";
const autoStart = params.get("autostart") === "1";
const roomLabel = document.getElementById("roomLabel");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const localVideo = document.getElementById("localVideo");

roomLabel.textContent = `Sala: ${room}`;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

let ws = null;
let localStream = null;
const peers = new Map();
let serverRecorder = null;
let recordSessionId = null;

function setStatus(text) {
  statusEl.textContent = text;
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
  try {
    const startRes = await fetch(`/api/record/start/${encodeURIComponent(room)}`, {
      method: "POST",
    });
    const startData = await startRes.json();
    if (!startRes.ok || !startData.sessionId) {
      throw new Error("Falha ao iniciar gravacao no servidor.");
    }
    recordSessionId = startData.sessionId;

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
  } catch (error) {
    console.error(error);
    setStatus("Transmitindo, mas sem gravacao no servidor.");
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
    });
  } catch (error) {
    console.error("Falha ao finalizar gravacao no servidor:", error);
  }
}

async function createPeer(viewerId) {
  if (!localStream || peers.has(viewerId)) return;

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

function connectSocket() {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => setStatus("Conectado ao servidor. Aguardando visualizadores...");

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "viewer_joined") {
      await createPeer(msg.viewerId);
      setStatus(`Viewer conectado: ${msg.viewerId}`);
      return;
    }

    if (msg.type === "viewer_left") {
      const pc = peers.get(msg.viewerId);
      if (pc) {
        pc.close();
        peers.delete(msg.viewerId);
      }
      setStatus(`Viewer saiu: ${msg.viewerId}`);
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
      setStatus(msg.message || "Erro no servidor.");
    }
  };

  ws.onclose = () => setStatus("Conexao encerrada.");
  ws.onerror = () => setStatus("Falha de conexao com o servidor.");
}

async function startBroadcast() {
  startBtn.disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    await startServerRecording(localStream);
    connectSocket();
    stopBtn.disabled = false;
    setStatus("Transmissao iniciada. Gravacao enviada para o servidor.");
  } catch (error) {
    console.error(error);
    setStatus("Permissao negada ou erro ao acessar camera/microfone.");
    startBtn.disabled = false;
  }
}

async function stopBroadcast() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  await stopServerRecording();

  peers.forEach((pc) => pc.close());
  peers.clear();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  localVideo.srcObject = null;
  stopBtn.disabled = true;
  startBtn.disabled = false;
  setStatus("Transmissao parada.");
}

startBtn.addEventListener("click", startBroadcast);
stopBtn.addEventListener("click", () => {
  stopBroadcast();
});

if (autoStart) {
  startBroadcast();
}
