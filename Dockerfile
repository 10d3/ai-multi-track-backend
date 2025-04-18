FROM oven/bun:latest
WORKDIR /app

# 1. Install system packages (including venv support & ffmpeg)
RUN apt-get update \
    && apt-get install -y python3 python3-venv ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# 2. Create and activate a virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# 3. Copy node and python dependency manifests
COPY package*.json ./
COPY requirements.txt ./

# 4. Install Node.js dependencies
RUN bun add @prisma/client prisma \
    && bun install \
    && bun --bunx prisma generate

# 5. Install Python dependencies inside the venv
RUN pip install --upgrade pip \
    && pip install spleeter \
    && pip install -r requirements.txt

# 6. Copy the rest of your application
COPY . /app/

# 7. Expose, healthcheck, and run
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
