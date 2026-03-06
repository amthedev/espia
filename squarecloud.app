MAIN=server/app.py
DISPLAY_NAME=Passageiro Stream
DESCRIPTION=Servidor de sinalizacao WebRTC para app Kivy e site de visualizacao com gravacao local.
MEMORY=512
VERSION=recommended
START=pip install -r requirements.txt && python -m uvicorn server.app:app --host 0.0.0.0 --port $PORT
AUTORESTART=true
