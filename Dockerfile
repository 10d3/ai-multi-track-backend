FROM oven/bun:latest
WORKDIR /app

# 1. Install system deps
RUN apt-get update \
    && apt-get install -y python3 python3-venv ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# 2. Create & activate venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# 3. Copy only what’s needed for Prisma generate
COPY package*.json ./
COPY prisma ./prisma
COPY requirements.txt ./

# 4. Install Node deps & generate Prisma client
RUN bun add @prisma/client prisma \
    && bun install \
    && bun --bunx prisma generate

# 5. Install Python deps
RUN pip install --upgrade pip \
    && pip install spleeter \
    && pip install -r requirements.txt

# 6. Copy the rest of your app
COPY . /app/

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8090/health || exit 1

CMD ["sh", "-c", "bun dev & bun worker & bun websocket"]

LABEL traefik.enable=true\
    traefik.http.middlewares.gzip.compress=true\
    traefik.http.routers.wss-router.entryPoints=wss\
    traefik.http.routers.wss-router.rule=Host(`api.sayitai.com`)\  
    traefik.http.routers.wss-router.service=wss-service\  
    traefik.http.routers.wss-router.tls=true \  
    traefik.http.services.wss-service.loadbalancer.server.port=3001
