# Base Image
FROM oven/bun:latest

# Set Working Directory
WORKDIR /app

# Copy Project Files
COPY package*.json ./
COPY . .

# Install System Dependencies
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl

# Install Dependencies
RUN bun install
RUN bun prisma generate

# Install Python Dependencies
RUN pip3 install spleeter
RUN pip3 install -r requirements.txt

# Expose WebSocket Port
EXPOSE 3001

# Health Check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Application Start Command
CMD ["sh", "-c", "bun dev & bun worker & bun websocket"]

# Traefik Labels for WebSocket
LABEL traefik.enable=true \
    traefik.http.routers.websocket-router.entryPoints=websecure \
    traefik.http.routers.websocket-router.rule=Host(`api.sayitai.com`) \
    traefik.http.routers.websocket-router.tls=true \
    traefik.http.routers.websocket-router.tls.certresolver=letsencrypt \
    traefik.http.services.websocket-service.loadbalancer.server.port=3001
