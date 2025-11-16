FROM mcr.microsoft.com/devcontainers/javascript-node:20

# Install Python and dependencies for STT service build, plus docker CLI
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv docker.io \
    && rm -rf /var/lib/apt/lists/*

# Set workspace
WORKDIR /workspace

USER node
