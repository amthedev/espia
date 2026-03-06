import json
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


@dataclass
class RoomState:
    broadcaster_id: str | None = None
    broadcaster_ws: WebSocket | None = None
    viewers: dict[str, WebSocket] = field(default_factory=dict)


app = FastAPI(title="Passageiro Streaming Server")
app.mount("/static", StaticFiles(directory="server/static"), name="static")

rooms: dict[str, RoomState] = {}
recordings_dir = Path("server/recordings")
recordings_dir.mkdir(parents=True, exist_ok=True)
active_recordings: dict[str, Path] = {}


def sanitize_room_id(room_id: str) -> str:
    normalized = (room_id or "").strip().lower()
    if not normalized:
        return "sala1"
    safe = re.sub(r"[^a-z0-9_-]", "", normalized)
    return safe or "sala1"


def get_or_create_room(room_id: str) -> RoomState:
    room_id = sanitize_room_id(room_id)
    if room_id not in rooms:
        rooms[room_id] = RoomState()
    return rooms[room_id]


async def send_json(ws: WebSocket, payload: dict) -> None:
    await ws.send_text(json.dumps(payload))


@app.get("/")
async def home() -> RedirectResponse:
    return RedirectResponse(url="/static/index.html")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.post("/api/record/start/{room_id}")
async def start_recording(room_id: str) -> JSONResponse:
    safe_room = sanitize_room_id(room_id)
    session_id = uuid.uuid4().hex
    file_path = recordings_dir / f"{safe_room}-{session_id}.webm"
    file_path.touch()
    active_recordings[session_id] = file_path
    return JSONResponse(
        {
            "ok": True,
            "sessionId": session_id,
            "fileName": file_path.name,
            "downloadUrl": f"/api/recordings/download/{file_path.name}",
        }
    )


@app.post("/api/record/chunk/{room_id}")
async def append_recording_chunk(room_id: str, request: Request) -> JSONResponse:
    _ = sanitize_room_id(room_id)
    session_id = (request.query_params.get("session") or "").strip()
    file_path = active_recordings.get(session_id)
    if not session_id or file_path is None:
        raise HTTPException(status_code=404, detail="Sessao de gravacao nao encontrada.")

    data = await request.body()
    if not data:
        return JSONResponse({"ok": False, "message": "Chunk vazio."}, status_code=400)

    with file_path.open("ab") as f:
        f.write(data)
    return JSONResponse({"ok": True, "bytes": len(data)})


@app.post("/api/record/stop/{room_id}")
async def stop_recording(room_id: str, request: Request) -> JSONResponse:
    _ = sanitize_room_id(room_id)
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        payload = {}
    session_id = str(payload.get("sessionId", "")).strip()
    file_path = active_recordings.pop(session_id, None)
    if not session_id or file_path is None:
        raise HTTPException(status_code=404, detail="Sessao de gravacao nao encontrada.")
    return JSONResponse(
        {
            "ok": True,
            "fileName": file_path.name,
            "downloadUrl": f"/api/recordings/download/{file_path.name}",
        }
    )


@app.get("/api/recordings/{room_id}")
async def list_recordings(room_id: str) -> JSONResponse:
    safe_room = sanitize_room_id(room_id)
    files = sorted(recordings_dir.glob(f"{safe_room}-*.webm"), reverse=True)
    return JSONResponse(
        {
            "room": safe_room,
            "count": len(files),
            "items": [
                {
                    "fileName": file.name,
                    "downloadUrl": f"/api/recordings/download/{file.name}",
                    "sizeBytes": file.stat().st_size,
                }
                for file in files
            ],
        }
    )


@app.get("/api/recordings/download/{file_name}")
async def download_recording(file_name: str) -> FileResponse:
    safe_name = Path(file_name).name
    file_path = recordings_dir / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo nao encontrado.")
    return FileResponse(path=file_path, filename=safe_name, media_type="video/webm")


@app.websocket("/ws/{room_id}/{role}")
async def websocket_signaling(ws: WebSocket, room_id: str, role: str) -> None:
    role = role.strip().lower()
    if role not in {"broadcaster", "viewer"}:
        await ws.close(code=1008)
        return

    await ws.accept()
    room = get_or_create_room(room_id)
    client_id = uuid.uuid4().hex[:10]

    if role == "broadcaster":
        if room.broadcaster_ws is not None:
            try:
                await send_json(room.broadcaster_ws, {"type": "error", "message": "Novo transmissor conectado."})
                await room.broadcaster_ws.close(code=1000)
            except RuntimeError:
                pass
        room.broadcaster_ws = ws
        room.broadcaster_id = client_id
    else:
        room.viewers[client_id] = ws

    await send_json(ws, {"type": "welcome", "id": client_id, "role": role})

    if role == "viewer" and room.broadcaster_ws is not None:
        await send_json(ws, {"type": "broadcaster_ready"})
        await send_json(
            room.broadcaster_ws,
            {"type": "viewer_joined", "viewerId": client_id},
        )
    elif role == "broadcaster":
        for viewer_ws in room.viewers.values():
            await send_json(viewer_ws, {"type": "broadcaster_ready"})

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            msg_type = msg.get("type")

            if role == "broadcaster":
                target_id = msg.get("target")
                target_ws = room.viewers.get(target_id)
                if target_ws is None:
                    continue
                if msg_type == "offer":
                    await send_json(
                        target_ws,
                        {"type": "offer", "from": client_id, "sdp": msg.get("sdp")},
                    )
                elif msg_type == "ice":
                    await send_json(
                        target_ws,
                        {
                            "type": "ice",
                            "from": client_id,
                            "candidate": msg.get("candidate"),
                        },
                    )
            else:
                if room.broadcaster_ws is None:
                    continue
                if msg_type == "answer":
                    await send_json(
                        room.broadcaster_ws,
                        {
                            "type": "answer",
                            "from": client_id,
                            "sdp": msg.get("sdp"),
                        },
                    )
                elif msg_type == "ice":
                    await send_json(
                        room.broadcaster_ws,
                        {
                            "type": "ice",
                            "from": client_id,
                            "candidate": msg.get("candidate"),
                        },
                    )
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if role == "broadcaster":
            room.broadcaster_ws = None
            room.broadcaster_id = None
            for viewer_ws in room.viewers.values():
                try:
                    await send_json(viewer_ws, {"type": "broadcaster_left"})
                except RuntimeError:
                    continue
        else:
            room.viewers.pop(client_id, None)
            if room.broadcaster_ws is not None:
                try:
                    await send_json(
                        room.broadcaster_ws,
                        {"type": "viewer_left", "viewerId": client_id},
                    )
                except RuntimeError:
                    pass

        if room.broadcaster_ws is None and not room.viewers:
            rooms.pop(sanitize_room_id(room_id), None)
