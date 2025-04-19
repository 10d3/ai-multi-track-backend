# Utiliser l'image de base oven/bun:latest
FROM oven/bun:latest

# Définir le répertoire de travail
WORKDIR /app

COPY package*.json ./

# Installer Python et les dépendances nécessaires
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-full \
    ffmpeg \
    curl

# Créer et activer un environnement virtuel
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Copier les fichiers du projet
COPY . /app/

# Installer les dépendances Node.js avec bun
RUN bun install
RUN bun --bunx prisma generate

# Mettre à jour pip dans l'environnement virtuel
RUN python3 -m pip install --upgrade pip

# Installer les dépendances Python dans l'environnement virtuel avec des versions compatibles
RUN pip3 install \
    numpy==1.23.5 \
    tensorflow==2.9.3 \
    spleeter==2.4.0 \
    ffmpeg-python==0.2.0 \
    pandas==1.5.3 \
    scipy==1.10.1 \
    protobuf==3.19.6 \
    keras==2.9.0 \
    h5py==3.8.0 \
    requests==2.31.0 \
    urllib3==2.0.7 \
    tensorboard==2.9.1 \
    tensorflow-estimator==2.9.0 \
    tensorflow-io-gcs-filesystem==0.31.0 \
    google-auth==2.22.0 \
    google-auth-oauthlib==0.4.6 \
    Werkzeug==2.2.3 \
    Markdown==3.4.3 \
    grpcio==1.54.3 \
    typing-extensions==4.5.0 \
    absl-py==1.4.0 \
    astunparse==1.6.3 \
    flatbuffers==23.5.26 \
    gast==0.4.0 \
    google-pasta==0.2.0 \
    opt-einsum==3.3.0 \
    packaging==23.1 \
    setuptools==67.8.0 \
    six==1.16.0 \
    termcolor==2.3.0 \
    wrapt==1.15.0

# Exposer le port pour l'application
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8090/health || exit 1

# Définir la commande pour démarrer l'application
CMD ["sh", "-c", "bun dev & bun worker & bun websocket"]

LABEL traefik.enable=true\
    traefik.http.middlewares.gzip.compress=true\
    traefik.http.routers.wss-router.entryPoints=wss\
    traefik.http.routers.wss-router.rule=Host(`api.sayitai.com`)\
    traefik.http.routers.wss-router.service=wss-service\
    traefik.http.routers.wss-router.tls=true \
    traefik.http.services.wss-service.loadbalancer.server.port=3001