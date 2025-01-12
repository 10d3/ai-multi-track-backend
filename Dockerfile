# Stage 1: Build
FROM oven/bun:latest AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and bun.lockb (if exists) for dependency installation
COPY package*.json ./

# Install Node.js dependencies
RUN bun install

# Copy the rest of the application code
COPY . .

# Generate Prisma client
RUN bun --bunx prisma generate

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Copy the requirements.txt file
COPY requirements.txt .

# Install Python dependencies
RUN pip3 install -r requirements.txt

# Stage 2: Production
FROM oven/bun:latest

# Set the working directory
WORKDIR /app

# Copy the built application from the builder stage
COPY --from=builder /app ./

# Expose the port for the application
EXPOSE 8090

# Start the application
CMD ["sh", "-c", "bun dev & bun worker & bun websocket"]