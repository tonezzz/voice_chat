FROM node:22-bookworm

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y \
      python3 \
      rsync \
      curl \
      ca-certificates \
      jq \
      procps \
      openssh-client \
      sshpass \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
