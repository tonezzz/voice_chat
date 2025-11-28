FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        dnsutils \
        git \
        httpie \
        iproute2 \
        iputils-ping \
        jq \
        less \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libdrm2 \
        libgbm1 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxi6 \
        net-tools \
        sshpass \
        netcat-openbsd \
        nodejs \
        npm \
        openssh-client \
        openssh-server \
        openssl \
        procps \
        python3-pil \
        socat \
        sqlite3 \
        unzip \
        vim-tiny \
        wget \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g wscat \
    && npx --yes playwright@1.49.1 install chromium \
    && npm install --prefix /opt/mcp-browser --omit=dev playwright@1.49.1 \
    && adduser --disabled-password --gecos '' debug \
    && mkdir -p /run/sshd

ENV NODE_PATH=/opt/mcp-browser/node_modules

ARG TTYD_VERSION=1.7.7
RUN curl -L "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

COPY bin/ /usr/local/bin/
RUN chmod +x /usr/local/bin/mcp-*

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/mcp-debug-idle"]
