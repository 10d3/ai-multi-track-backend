# Utiliser l'image de base oven/bun:latest
FROM oven/bun:latest

# Définir le répertoire de travail
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Installer les dépendances Node.js avec bun
RUN bun add @prisma/client prisma
RUN bun install

# Copy requirements.txt for Python dependencies
COPY requirements.txt .

# Installer Python, pip, et les outils nécessaires
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv ffmpeg curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Créer et activer un environnement virtuel Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Installer les dépendances Python dans l'environnement virtuel
RUN pip3 install --upgrade pip && \
    pip3 install --no-cache-dir spleeter && \
    pip3 install --no-cache-dir -r requirements.txt

# Copier les fichiers du projet
COPY . /app/

# Generate Prisma client
RUN bun --bunx prisma generate

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