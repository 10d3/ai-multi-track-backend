# Utiliser l'image de base oven/bun:latest
FROM oven/bun:latest

# Définir le répertoire de travail
WORKDIR /app

COPY package*.json ./
# Copier les fichiers du projet
COPY . /app/

# Installer Python et pip
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl

# Installer les dépendances Node.js avec bun
# RUN bun add @prisma/client prisma
RUN bun install
RUN bun --bunx prisma generate

# Copier le fichier requirements.txt
COPY requirements.txt .

# Installer les dépendances Python
# RUN pip install ffmpeg-python
RUN pip3 install spleeter
RUN pip install -r requirements.txt

# Exposer le port pour l'application
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8090/health || exit 1

# Définir la commande pour démarrer l'application
# CMD ["bun", "dev", "worker"]
CMD ["sh", "-c", "bun dev & bun worker & bun websocket"]

LABEL traefik.enable=true\
    traefik.http.middlewares.gzip.compress=true\
    traefik.http.routers.wss-router.entryPoints=wss\
    traefik.http.routers.wss-router.rule=Host(`api.sayitai.com`)\
    traefik.http.routers.wss-router.service=wss-service\
    traefik.http.routers.wss-router.tls=true \
    traefik.http.services.wss-service.loadbalancer.server.port=3001