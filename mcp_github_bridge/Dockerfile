FROM ghcr.io/github/github-mcp-server:latest AS github_mcp

FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

COPY . .

# Provide the github-mcp-server binary from upstream image
COPY --from=github_mcp /server/github-mcp-server /usr/local/bin/github-mcp-server

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
