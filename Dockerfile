# Use Node.js as base image
FROM node:18-alpine

# Install required dependencies for Bun and Python
RUN apk add --no-cache curl bash python3 py3-pip ffmpeg build-base

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Copy requirements.txt for Python dependencies
COPY requirements.txt ./

# Set Python encoding environment variable to fix compilation issues
ENV PYTHONIOENCODING=utf-8

# Create and activate Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies in virtual environment
RUN pip3 install --upgrade pip && \
    pip3 install --no-cache-dir spleeter && \
    pip3 install --no-cache-dir -r requirements.txt

# Install Node.js dependencies with Bun
RUN bun install

# Copy the rest of the application
COPY . /app/

# Generate Prisma client
RUN bun --bunx prisma generate

# Expose port for the application
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:8090/health || exit 1

# Define command to start the application
CMD ["sh", "-c", "bun dev & bun worker & bun websocket"]

LABEL traefik.enable=true\
    traefik.http.middlewares.gzip.compress=true\
    traefik.http.routers.wss-router.entryPoints=wss\
    traefik.http.routers.wss-router.rule=Host(`api.sayitai.com`)\
    traefik.http.routers.wss-router.service=wss-service\
    traefik.http.routers.wss-router.tls=true \
    traefik.http.services.wss-service.loadbalancer.server.port=3001