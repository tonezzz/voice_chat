FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @modelcontextprotocol/server-memory@0.6.2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8020

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8020"]
