# Use Node.js as base image
FROM node:18-bullseye

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

# Install system dependencies and Python 3.10
RUN apt-get update && \
    apt-get install -y build-essential zlib1g-dev libncurses5-dev libgdbm-dev libnss3-dev \
    libssl-dev libreadline-dev libffi-dev curl wget python3-pip python3-venv \
    nasm yasm pkg-config libtool libc6 libc6-dev unzip libsoxr-dev && \
    # Compile and install FFmpeg 6.0 from source
    mkdir -p /tmp/ffmpeg_sources && \
    cd /tmp/ffmpeg_sources && \
    wget -O ffmpeg-6.0.tar.bz2 https://ffmpeg.org/releases/ffmpeg-6.0.tar.bz2 && \
    tar xjf ffmpeg-6.0.tar.bz2 && \
    cd ffmpeg-6.0 && \
    ./configure --prefix=/usr/local --enable-shared --enable-libsoxr && \
    make -j$(nproc) && \
    make install && \
    ldconfig && \
    cd /tmp && \
    rm -rf /tmp/ffmpeg_sources && \
    # Install Python 3.10
    wget https://www.python.org/ftp/python/3.10.0/Python-3.10.0.tgz && \
    tar -xf Python-3.10.0.tgz && \
    cd Python-3.10.0 && \
    ./configure --enable-optimizations && \
    make -j $(nproc) && \
    make altinstall && \
    cd .. && \
    rm -rf Python-3.10.0 Python-3.10.0.tgz && \
    ln -s /usr/local/bin/python3.10 /usr/local/bin/python3 && \
    ln -s /usr/local/bin/pip3.10 /usr/local/bin/pip3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*