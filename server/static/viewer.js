const params = new URLSearchParams(window.location.search);
const room = params.get("room") || "sala1";
const roomLabel = document.getElementById("roomLabel");
const statusEl = document.getElementById("status");
const remoteVideo = document.getElementById("remoteVideo");
const startRecordBtn = document.getElementById("startRecordBtn");
const stopRecordBtn = document.getElementById("stopRecordBtn");
const refreshRecordingsBtn = document.getElementById("refreshRecordingsBtn");
const recordingsStatus = document.getElementById("recordingsStatus");
const recordingsList = document.getElementById("recordingsList");

roomLabel.textContent = `Sala: ${room}`;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

let ws = null;
let pc = null;
let mediaRecorder = null;
let chunks = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function setRecordingsStatus(text) {
  recordingsStatus.textContent = text;
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws/${encodeURIComponent(room)}/viewer`;
}

function sendSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function ensurePeerConnection() {
  if (pc) return pc;
  pc = new RTCPeerConnection(rtcConfig);

  pc.ontrack = (event) => {
    if (!event.streams || !event.streams[0]) return;
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }

    const playPromise = remoteVideo.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise
        .then(() => setStatus("Recebendo transmissao ao vivo."))
        .catch(() => {
          setStatus("Transmissao recebida. Toque no botao Play do video para iniciar ao vivo.");
        });
      return;
    }

    setStatus("Recebendo transmissao ao vivo.");
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendSignal({ type: "ice", candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc && ["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      setStatus("Conexao com transmissor encerrada.");
    }
  };

  return pc;
}

function connectSocket() {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => setStatus("Conectado. Aguardando transmissor...");

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "broadcaster_ready") {
      setStatus("Transmissor online. Aguardando oferta...");
      return;
    }

    if (msg.type === "offer") {
      const peer = ensurePeerConnection();
      await peer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendSignal({ type: "answer", sdp: peer.localDescription });
      setStatus("Conectado ao transmissor.");
      return;
    }

    if (msg.type === "ice") {
      const peer = ensurePeerConnection();
      if (msg.candidate) {
        await peer.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
      return;
    }

    if (msg.type === "broadcaster_left") {
      setStatus("Transmissor saiu da sala.");
      remoteVideo.srcObject = null;
      if (pc) {
        pc.close();
        pc = null;
      }
    }
  };

  ws.onclose = () => setStatus("Conexao com servidor encerrada.");
  ws.onerror = () => setStatus("Erro de conexao.");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadServerRecordings() {
  setRecordingsStatus("Atualizando lista...");
  recordingsList.innerHTML = "";
  try {
    const response = await fetch(`/api/recordings/${encodeURIComponent(room)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Falha ao carregar.");

    if (!data.items || data.items.length === 0) {
      setRecordingsStatus("Nenhuma gravacao encontrada no servidor.");
      return;
    }

    data.items.forEach((item) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = item.downloadUrl;
      a.textContent = `${item.fileName} (${formatSize(item.sizeBytes)})`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.appendChild(a);
      recordingsList.appendChild(li);
    });
    setRecordingsStatus(`Total no servidor: ${data.count}`);
  } catch (error) {
    console.error(error);
    setRecordingsStatus("Erro ao carregar gravacoes do servidor.");
  }
}

function startRecording() {
  const stream = remoteVideo.srcObject;
  if (!stream) {
    setStatus("Nao ha video para gravar ainda.");
    return;
  }

  chunks = [];
  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus" });
  } catch {
    mediaRecorder = new MediaRecorder(stream);
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(chunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gravacao-${room}-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Gravacao salva localmente no dispositivo.");
  };

  mediaRecorder.start();
  startRecordBtn.disabled = true;
  stopRecordBtn.disabled = false;
  setStatus("Gravando localmente...");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  startRecordBtn.disabled = false;
  stopRecordBtn.disabled = true;
}

startRecordBtn.addEventListener("click", startRecording);
stopRecordBtn.addEventListener("click", stopRecording);
refreshRecordingsBtn.addEventListener("click", loadServerRecordings);

connectSocket();
loadServerRecordings();
