const params = new URLSearchParams(window.location.search);
const room = params.get("room") || "sala1";
const localVideo = document.getElementById("localVideo");

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

let ws = null;
let localStream = null;
const peers = new Map();
let serverRecorder = null;
let recordSessionId = null;

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws/${encodeURIComponent(room)}/broadcaster`;
}

function sendSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

async function startServerRecording(stream) {
  const startRes = await fetch(`/api/record/start/${encodeURIComponent(room)}`, { method: "POST" });
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
}

function connectSocket() {
  ws = new WebSocket(wsUrl());

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "viewer_joined") {
      await createPeer(msg.viewerId);
      return;
    }

    if (msg.type === "viewer_left") {
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
    }
  };
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

async function boot() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    await startServerRecording(localStream);
    connectSocket();
  } catch (error) {
    console.error("Falha ao iniciar transmissao:", error);
  }
}

window.addEventListener("beforeunload", async () => {
  if (serverRecorder && serverRecorder.state !== "inactive") {
    serverRecorder.stop();
  }
  if (recordSessionId) {
    try {
      await fetch(`/api/record/stop/${encodeURIComponent(room)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: recordSessionId }),
      });
    } catch {
      // Ignora erro no fechamento.
    }
  }
});

boot();
