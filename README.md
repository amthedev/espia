# Passageiro Streaming (Kivy + WebRTC + Square Cloud)

Projeto com:
- App Android em **Kivy** (Python) para pedir permissao de camera/microfone e transmitir.
- Servidor Python (**FastAPI**) para sinalizacao WebRTC.
- Site (HTML/CSS/JS) para assistir o stream, gravar local e baixar gravacoes salvas no servidor.

## 1) Rodar servidor localmente

No diretorio raiz:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn server.app:app --host 0.0.0.0 --port 8000
```

Abra no navegador:
- `http://localhost:8000/static/index.html`

Paginas:
- Visualizador: `http://localhost:8000/static/viewer.html?room=sala1`

## 2) Deploy no Square Cloud

Este projeto ja inclui `squarecloud.app`.

Arquivos importantes para upload:
- `server/`
- `requirements.txt`
- `squarecloud.app`

Neste projeto, a URL configurada para uso e:
- `https://pedropnc.squareweb.app`

Essa ja e a URL padrao no app Kivy.

## 3) App Android Kivy

Arquivo principal:
- `kivy_app/main.py`

Ele:
1. Pede permissao de camera/microfone.
2. Usa URL e sala fixas no proprio codigo (sem campos na interface).
3. Abre um transmissor interno em WebView (sem navegador externo).
4. Inicia captura camera/microfone automaticamente.
5. Envia stream ao vivo para os viewers e grava no servidor.

### Teste rapido desktop (sem APK)

```powershell
pip install kivy
python kivy_app/main.py
```

### Build APK (Linux/WSL recomendado)

No diretorio `kivy_app/`:

```bash
buildozer android debug
```

O APK ficara em `kivy_app/bin/`.

### Comando unico para gerar APK e copiar para Downloads

No PowerShell do Windows:

```powershell
wsl bash -lc "export PIP_BREAK_SYSTEM_PACKAGES=1 && cd /mnt/c/Users/Allan/Downloads/passageiro/kivy_app && buildozer android debug && cp bin/*.apk /mnt/c/Users/Allan/Downloads/"
```

Saida final esperada:
- `C:\Users\Allan\Downloads\*.apk`

## 4) Gravacao local no site

No `viewer.html`:
- Botao **Iniciar gravacao local**
- Botao **Parar gravacao**
- Ao parar, baixa arquivo `.webm` no dispositivo do visualizador

## 5) Gravacao no servidor (Square Cloud)

- O transmissor envia chunks de video para o backend durante a live.
- Arquivos ficam em `server/recordings/`.
- API para listar por sala: `/api/recordings/{room}`
- Download: `/api/recordings/download/{file_name}`

## 6) Estrutura

- `server/app.py`: backend FastAPI + WebSocket para sinalizacao WebRTC
- `server/static/mobile_broadcaster.html`: transmissor interno usado pelo app
- `server/static/mobile_broadcaster.js`: captura e envio para stream + servidor
- `server/static/viewer.html`: pagina de visualizacao e gravacao
- `server/static/broadcaster.js`: logica de transmissao WebRTC
- `server/static/viewer.js`: logica de recepcao WebRTC + MediaRecorder
- `kivy_app/main.py`: app Kivy para Android
- `kivy_app/buildozer.spec`: config de build Android

## Observacoes de seguranca

- Este fluxo sempre mostra prompt de permissao do navegador/dispositivo.
- Recomendado usar HTTPS em producao (Square Cloud ja fornece).
- Para uso real com muitos usuarios, considere SFU (Janus/mediasoup) em vez de P2P.
- Captura em segundo plano no Android continua limitada no modelo WebView; para segundo plano total, e necessario Foreground Service nativo.
