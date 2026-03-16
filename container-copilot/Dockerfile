# NanoClaw Copilot Agent Container
# Parallel to container/ — uses GitHub Copilot API instead of Claude Agent SDK.
# Credentials are injected by the host credential proxy on ANTHROPIC_BASE_URL
# (same port as the Claude proxy, so src/container-runner.ts needs no changes).

FROM node:22-slim

# Install system dependencies for Chromium (browser automation skill)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser skill
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Default Copilot model — override with docker build --build-arg COPILOT_MODEL=...
ARG COPILOT_MODEL=gpt-4o
ENV COPILOT_MODEL=${COPILOT_MODEL}

# Install agent-browser globally (browser automation skill)
RUN npm install -g agent-browser

# Create app directory
WORKDIR /app

# Copy package files first for better layer caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Entry point: read ContainerInput JSON from stdin, output ContainerOutput JSON to stdout.
# Credentials are injected by the host credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nnode /app/dist/index.js\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user
USER node

# Working directory is the group workspace (bind-mounted by the host)
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
