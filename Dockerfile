FROM oven/bun:latest

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
COPY requirements.txt ./

# Install system dependencies in a single RUN to reduce layers
RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies
RUN bun add @prisma/client prisma && \
    bun install && \
    bun --bunx prisma generate

# Install Python dependencies
RUN pip3 install spleeter && \
    pip install -r requirements.txt

# Copy application code
COPY . /app/

# Expose port internally (for documentation, doesn't actually expose to host)
EXPOSE 8090

# Use a healthcheck to ensure the service is running properly
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8090/health || exit 1

# Start the services using a proper init process
CMD ["sh", "-c", "bun dev & bun worker & bun websocket & wait"]